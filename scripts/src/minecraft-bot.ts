import mineflayer from 'mineflayer'
import { GoogleGenerativeAI } from '@google/generative-ai'
// @ts-ignore
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = 'Ezbotttt.aternos.me'
const PORT = 21779
const BOT_NAME = 'EzBot_IA'
const VERSION = '1.21.8'

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || '')
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

let reconnectDelay = 5000
let botRef: mineflayer.Bot | null = null

// ── MISSION SYSTEM ────────────────────────────────────────────────────────────
type Mission =
  | 'COLETAR_MADEIRA'
  | 'CRAFTAR_MESA'
  | 'CRAFTAR_PICARETA_MADEIRA'
  | 'MINERAR_PEDRA'
  | 'CRAFTAR_PICARETA_PEDRA'
  | 'MINERAR_FERRO'
  | 'FUNDIR_FERRO'
  | 'CRAFTAR_ARMADURA'
  | 'CRAFTAR_ESPADA'
  | 'COLETAR_COMIDA'
  | 'MINERAR_DIAMANTE'
  | 'ENCONTRAR_FORTALEZA'
  | 'MATAR_DRAGAO'
  | 'SOBREVIVER'

let currentMission: Mission = 'COLETAR_MADEIRA'
let missionAnnounced = false

const MISSION_NAMES: Record<Mission, string> = {
  COLETAR_MADEIRA: 'Coletar madeira',
  CRAFTAR_MESA: 'Craftar mesa de trabalho',
  CRAFTAR_PICARETA_MADEIRA: 'Craftar picareta de madeira',
  MINERAR_PEDRA: 'Minerar pedra',
  CRAFTAR_PICARETA_PEDRA: 'Craftar picareta de pedra',
  MINERAR_FERRO: 'Minerar ferro',
  FUNDIR_FERRO: 'Fundir ferro (precisa de fornalha)',
  CRAFTAR_ARMADURA: 'Craftar armadura de ferro',
  CRAFTAR_ESPADA: 'Craftar espada',
  COLETAR_COMIDA: 'Coletar comida',
  MINERAR_DIAMANTE: 'Minerar diamante',
  ENCONTRAR_FORTALEZA: 'Encontrar fortaleza do End',
  MATAR_DRAGAO: 'MATAR O ENDER DRAGON!',
  SOBREVIVER: 'Sobreviver',
}

function countItem(bot: mineflayer.Bot, keyword: string): number {
  return bot.inventory.items()
    .filter((i: any) => i.name.includes(keyword))
    .reduce((sum: number, i: any) => sum + i.count, 0)
}

function hasItem(bot: mineflayer.Bot, keyword: string): boolean {
  return bot.inventory.items().some((i: any) => i.name.includes(keyword))
}

function decideMission(bot: mineflayer.Bot): Mission {
  const wood = countItem(bot, 'log') + countItem(bot, 'planks')
  const cobble = countItem(bot, 'cobblestone')
  const iron = countItem(bot, 'iron_ingot')
  const diamond = countItem(bot, 'diamond')
  const food = bot.food

  if (food < 8) return 'COLETAR_COMIDA'
  if (wood < 12) return 'COLETAR_MADEIRA'
  if (!hasItem(bot, 'crafting_table') && !bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 })) return 'CRAFTAR_MESA'
  if (!hasItem(bot, 'wooden_pickaxe') && !hasItem(bot, 'stone_pickaxe') && !hasItem(bot, 'iron_pickaxe') && !hasItem(bot, 'diamond_pickaxe')) return 'CRAFTAR_PICARETA_MADEIRA'
  if (cobble < 16 && !hasItem(bot, 'iron_pickaxe') && !hasItem(bot, 'diamond_pickaxe')) return 'MINERAR_PEDRA'
  if (!hasItem(bot, 'stone_pickaxe') && !hasItem(bot, 'iron_pickaxe') && !hasItem(bot, 'diamond_pickaxe')) return 'CRAFTAR_PICARETA_PEDRA'
  if (!hasItem(bot, 'sword')) return 'CRAFTAR_ESPADA'
  if (iron < 12 && diamond < 3) return 'MINERAR_FERRO'
  if (iron >= 12 && !hasItem(bot, 'iron_chestplate')) return 'CRAFTAR_ARMADURA'
  if (diamond < 3) return 'MINERAR_DIAMANTE'
  return 'MATAR_DRAGAO'
}

// ── AI Background ─────────────────────────────────────────────────────────────
async function bgAILoop() {
  while (true) {
    await sleep(15000)
    if (!botRef?.entity) continue
    try {
      const situation = buildSituationReport(botRef)
      const prompt = `Você é EzBot_IA, bot de Minecraft. Missão atual: ${MISSION_NAMES[currentMission]}.
Situação: ${situation}
Comente brevemente no chat o que está fazendo (máximo 150 caracteres, em português, sem aspas).
Responda APENAS a frase, nada mais.`
      const result = await gemini.generateContent(prompt)
      const text = result.response.text().trim().substring(0, 150)
      if (text && botRef) botRef.chat(text)
    } catch (_e: any) {
      if (_e?.status === 429) await sleep(60000)
    }
  }
}

function buildSituationReport(bot: mineflayer.Bot): string {
  const pos = bot.entity.position
  return JSON.stringify({
    pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    saude: Math.floor(bot.health), fome: bot.food,
    missao: MISSION_NAMES[currentMission],
    inventario: bot.inventory.items().reduce((a: any, i: any) => { a[i.name] = (a[i.name]||0)+i.count; return a }, {}),
  })
}

// ── Main Action Loop ──────────────────────────────────────────────────────────
async function actionLoop(bot: mineflayer.Bot) {
  let ticksSinceAnnounce = 999

  console.log('[Loop] Action loop iniciado!')
  while (bot.entity) {
    try {
      // Priority 1: survive
      if (bot.health > 0 && bot.health < 8) {
        const hasFood = bot.inventory.items().some((i: any) => i.foodPoints && i.foodPoints > 0)
        if (hasFood) {
          console.log(`[Loop] Saude baixa: ${bot.health}, comendo...`)
          bot.pathfinder.stop()
          await eatFood(bot)
          await sleep(500)
        } else {
          console.log(`[Loop] Saude baixa sem comida! Cacando animais...`)
          await gatherFood(bot)
          await sleep(500)
        }
        continue
      }

      // Priority 2: escape water
      if (isInWater(bot)) {
        console.log('[Loop] Em agua, escapando...')
        await escapeWater(bot)
        await sleep(300)
        continue
      }

      // Priority 3: fight nearby hostiles
      const hostile = getNearestHostile(bot, 5)
      if (hostile) {
        if (hasItem(bot, 'sword')) {
          bot.lookAt((hostile as any).position.offset(0, (hostile as any).height/2, 0))
          bot.attack(hostile)
        } else {
          await flee(bot)
        }
        await sleep(400)
        continue
      }

      // Priority 4: mission
      const mission = decideMission(bot)
      if (mission !== currentMission || ticksSinceAnnounce > 150) {
        currentMission = mission
        ticksSinceAnnounce = 0
        console.log(`[Missao] Nova missao: ${mission}`)
        bot.chat(`Missao: ${MISSION_NAMES[mission]}`)
      }
      ticksSinceAnnounce++

      console.log(`[Loop] Executando: ${mission}`)
      await executeMission(bot, mission)
      await sleep(200)

    } catch (e: any) {
      console.log('[Loop] Erro:', e?.message || String(e))
      await sleep(1000)
    }
  }
  console.log('[Loop] Bot entity perdida, loop encerrado.')
}

async function executeMission(bot: mineflayer.Bot, mission: Mission) {
  switch (mission) {
    case 'COLETAR_MADEIRA':    await gatherWood(bot);          break
    case 'CRAFTAR_MESA':       await craftCraftingTable(bot);  break
    case 'CRAFTAR_PICARETA_MADEIRA': await craftWoodenPickaxe(bot); break
    case 'MINERAR_PEDRA':      await mineBlock(bot, ['stone', 'cobblestone']); break
    case 'CRAFTAR_PICARETA_PEDRA': await craftStonePickaxe(bot); break
    case 'CRAFTAR_ESPADA':     await craftSword(bot);          break
    case 'MINERAR_FERRO':      await mineBlock(bot, ['iron_ore', 'deepslate_iron_ore']); break
    case 'FUNDIR_FERRO':       await smeltIron(bot);           break
    case 'CRAFTAR_ARMADURA':   await craftArmor(bot);          break
    case 'COLETAR_COMIDA':     await gatherFood(bot);          break
    case 'MINERAR_DIAMANTE':   await mineDiamond(bot);         break
    case 'ENCONTRAR_FORTALEZA':
    case 'MATAR_DRAGAO':       await huntDragon(bot);          break
    default:                   await randomWalk(bot);          break
  }
}

// ── Crafting & Actions ────────────────────────────────────────────────────────
async function ensureCraftingTable(bot: mineflayer.Bot): Promise<any> {
  // Check if there's one in the world nearby
  let table = findTableBlock(bot)
  if (table) { await goToBlock(bot, table); return table }

  // Try to craft one from planks
  const plankId = itemId(bot, 'oak_planks')
  if (plankId >= 0) {
    // Make planks from logs first
    const logInInv = bot.inventory.items().find((i: any) => i.name.includes('log'))
    if (logInInv) {
      const plankRecipes = bot.recipesFor(plankId, null, 1, null)
      if (plankRecipes.length) try { await bot.craft(plankRecipes[0], 4, undefined) } catch (_e) {}
    }
    const tableId = itemId(bot, 'crafting_table')
    if (tableId >= 0) {
      const tableRecipes = bot.recipesFor(tableId, null, 1, null)
      if (tableRecipes.length) {
        try {
          await bot.craft(tableRecipes[0], 1, undefined)
          console.log('[Bot] Craftou mesa de trabalho!')
          // Place it on the ground next to the bot
          const ground = bot.blockAt(bot.entity.position.offset(1, -1, 0))
          if (ground) {
            const tableItem = bot.inventory.items().find((i: any) => i.name === 'crafting_table')
            if (tableItem) {
              await bot.equip(tableItem, 'hand')
              try { await bot.placeBlock(ground, { x:0, y:1, z:0 } as any) } catch (_e) {}
            }
          }
        } catch (_e) {}
      }
    }
  }
  return findTableBlock(bot)
}

async function craftWoodenPickaxe(bot: mineflayer.Bot) {
  const table = await ensureCraftingTable(bot)
  if (!table) { await gatherWood(bot); return }
  try {
    const id = itemId(bot, 'wooden_pickaxe')
    const recipes = id >= 0 ? bot.recipesFor(id, null, 1, table) : []
    if (recipes.length) { await bot.craft(recipes[0], 1, table); console.log('[Bot] Craftou picareta de madeira!') }
    else await gatherWood(bot)
  } catch (_e) { await gatherWood(bot) }
}

async function craftStonePickaxe(bot: mineflayer.Bot) {
  const table = await ensureCraftingTable(bot)
  if (!table) return
  try {
    const id = itemId(bot, 'stone_pickaxe')
    const recipes = id >= 0 ? bot.recipesFor(id, null, 1, table) : []
    if (recipes.length) { await bot.craft(recipes[0], 1, table); console.log('[Bot] Craftou picareta de pedra!') }
    else await mineBlock(bot, ['stone','cobblestone'])
  } catch (_e) {}
}

async function craftSword(bot: mineflayer.Bot) {
  const table = await ensureCraftingTable(bot)
  if (!table) return
  try {
    for (const name of ['iron_sword','stone_sword','wooden_sword']) {
      const id = itemId(bot, name)
      if (id < 0) continue
      const recipes = bot.recipesFor(id, null, 1, table)
      if (recipes.length) { await bot.craft(recipes[0], 1, table); console.log(`[Bot] Craftou ${name}!`); return }
    }
  } catch (_e) {}
}

async function craftCraftingTable(bot: mineflayer.Bot) {
  await ensureCraftingTable(bot)
}

async function craftArmor(bot: mineflayer.Bot) {
  const table = await ensureCraftingTable(bot)
  if (!table) return
  try {
    for (const name of ['iron_chestplate','iron_helmet','iron_leggings','iron_boots']) {
      const id = itemId(bot, name)
      if (id < 0) continue
      const recipes = bot.recipesFor(id, null, 1, table)
      if (recipes.length) { await bot.craft(recipes[0], 1, table); console.log(`[Bot] Craftou ${name}!`) }
    }
  } catch (_e) {}
}

async function smeltIron(bot: mineflayer.Bot) {
  const furnace = bot.findBlock({ matching: (b: any) => b?.name === 'furnace', maxDistance: 32 })
  if (!furnace) { await mineBlock(bot, ['stone','cobblestone']); return }
  await goToBlock(bot, furnace)
  try {
    const f = await bot.openFurnace(furnace)
    await f.putFuel(bot.inventory.items().find((i: any) => i.name.includes('log') || i.name.includes('planks') || i.name.includes('coal')) as any, 1)
    await f.putInput(bot.inventory.items().find((i: any) => i.name.includes('iron_ore')) as any, 1)
    await sleep(10000)
    await f.takeOutput()
    f.close()
  } catch (_e) {}
}

async function mineBlock(bot: mineflayer.Bot, blockNames: string[]) {
  const block = bot.findBlock({
    matching: (b: any) => b && blockNames.some(n => b.name === n || b.name.includes(n)),
    maxDistance: 32,
  })
  if (block) {
    try {
      await goToBlock(bot, block)
      if (bot.canDigBlock(block)) await bot.dig(block)
      else await randomWalk(bot)
    } catch (_e) { await randomWalk(bot) }
  } else {
    await randomWalk(bot)
  }
}

async function mineDiamond(bot: mineflayer.Bot) {
  // Diamonds at y<16 ideally
  const diamond = bot.findBlock({
    matching: (b: any) => b && (b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore'),
    maxDistance: 64,
  })
  if (diamond) {
    try { await goToBlock(bot, diamond); await bot.dig(diamond) } catch (_e) { await digDown(bot) }
  } else {
    await digDown(bot)
  }
}

async function digDown(bot: mineflayer.Bot) {
  const pos = bot.entity.position.floored()
  if (pos.y <= 12) { await randomWalk(bot); return }
  const blockBelow = bot.blockAt(pos.offset(0, -1, 0))
  if (blockBelow && bot.canDigBlock(blockBelow)) {
    try { await bot.dig(blockBelow); console.log(`[Bot] Cavando para baixo y=${pos.y}`) } catch (_e) {}
  }
}

async function gatherWood(bot: mineflayer.Bot) {
  const log = bot.findBlock({
    matching: (b: any) => b && (b.name.includes('log') || b.name.includes('wood')),
    maxDistance: 32,
  })
  if (log) {
    try { await goToBlock(bot, log); await bot.dig(log); console.log('[Bot] Coletou madeira!') }
    catch (_e) { await randomWalk(bot) }
  } else { await randomWalk(bot) }
}

async function gatherFood(bot: mineflayer.Bot) {
  // Try eating what's in inventory first
  await eatFood(bot)
  // Look for animals to kill
  const animal = Object.values(bot.entities).find((e: any) =>
    e.type === 'mob' && e.position.distanceTo(bot.entity.position) < 16 &&
    ['cow','chicken','pig','sheep','rabbit'].some(n => e.name?.includes(n))
  ) as any
  if (animal) {
    try {
      await bot.pathfinder.goto(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2))
      bot.attack(animal)
    } catch (_e) {}
  } else {
    await randomWalk(bot)
  }
}

async function huntDragon(bot: mineflayer.Bot) {
  bot.chat('Procurando fortaleza do End...')
  // For now explore and look for stronghold
  await randomWalk(bot)
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function findTableBlock(bot: mineflayer.Bot) {
  return bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 })
}

function itemId(bot: mineflayer.Bot, name: string): number {
  return (bot as any).mcData?.itemsByName?.[name]?.id ?? -1
}

async function goToBlock(bot: mineflayer.Bot, block: any) {
  try {
    await bot.pathfinder.goto(new goals.GoalBlock(block.position.x, block.position.y, block.position.z))
  } catch (_e) {}
}

async function eatFood(bot: mineflayer.Bot) {
  const food = bot.inventory.items().filter((i: any) => i.foodPoints && i.foodPoints > 0)
  if (!food.length) return
  try { await bot.equip(food[0], 'hand'); await bot.consume() } catch (_e) {}
}

function isInWater(bot: mineflayer.Bot): boolean {
  const b = bot.blockAt(bot.entity.position)
  return !!(b && (b.name === 'water' || b.name === 'flowing_water'))
}

async function escapeWater(bot: mineflayer.Bot) {
  bot.pathfinder.stop()
  const dirs: Array<'forward'|'back'|'left'|'right'> = ['forward','back','left','right']
  bot.setControlState('jump', true)
  for (const dir of dirs) {
    if (!isInWater(bot)) break
    const yaw = dir==='forward'?0:dir==='back'?Math.PI:dir==='left'?Math.PI/2:-Math.PI/2
    await bot.look(yaw, -0.3, true)
    bot.setControlState(dir, true)
    await sleep(2000)
    bot.setControlState(dir, false)
  }
  bot.setControlState('jump', false)
  for (const d of dirs) bot.setControlState(d, false)
}

function getNearestHostile(bot: mineflayer.Bot, maxDist: number) {
  return Object.values(bot.entities).filter((e: any) =>
    e.type==='mob' && e.isValid &&
    e.position.distanceTo(bot.entity.position) < maxDist && isHostile(e.name)
  ).sort((a: any, b: any) =>
    a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position)
  )[0] || null
}

async function flee(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  try {
    await bot.pathfinder.goto(new goals.GoalXZ(
      Math.floor(pos.x+(Math.random()-0.5)*40),
      Math.floor(pos.z+(Math.random()-0.5)*40)
    ))
  } catch (_e) {}
}

async function randomWalk(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  try {
    await bot.pathfinder.goto(new goals.GoalXZ(
      Math.floor(pos.x+(Math.random()-0.5)*60),
      Math.floor(pos.z+(Math.random()-0.5)*60)
    ))
  } catch (_e) {}
}

function isHostile(name: string|null|undefined): boolean {
  if (!name) return false
  return ['zombie','skeleton','creeper','spider','enderman','witch','slime','phantom',
          'drowned','husk','stray','blaze','ghast','wither_skeleton','piglin_brute']
    .some(h => name.toLowerCase().includes(h))
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

// ── Bot lifecycle ─────────────────────────────────────────────────────────────
function createBot() {
  console.log(`[Bot] Conectando em ${HOST}:${PORT}...`)
  const bot = mineflayer.createBot({ host:HOST, port:PORT, username:BOT_NAME, version:VERSION, auth:'offline' })
  bot.loadPlugin(pathfinder)
  botRef = null

  bot.once('spawn', async () => {
    console.log('[Bot] Conectado!')
    reconnectDelay = 5000
    botRef = bot
    missionAnnounced = false

    const move = new Movements(bot)
    move.allowSprinting = true
    move.canDig = true
    move.allowParkour = true
    move.liquidCost = 50
    bot.pathfinder.setMovements(move)

    bot.chat('EzBot_IA ligado! Missao: matar o Ender Dragon!')
    await sleep(1000)
    actionLoop(bot)
  })

  bot.on('chat', async (username: string, message: string) => {
    if (username === bot.username) return
    if (message === '!status') {
      const p = bot.entity.position
      bot.chat(`Missao: ${MISSION_NAMES[currentMission]} | Saude:${Math.floor(bot.health)} Fome:${bot.food} Pos:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    }
    if (message === '!missao') bot.chat(`Missao atual: ${MISSION_NAMES[currentMission]}`)
    if (message === '!parar') { bot.pathfinder.stop(); bot.chat('Ok!') }
    if (message.startsWith('!falar ')) {
      try {
        const r = await gemini.generateContent(`Você é EzBot_IA, bot de Minecraft. Responda curto (max 150 chars): ${message.slice(7)}`)
        bot.chat(r.response.text().trim().substring(0, 150))
      } catch (_e) { bot.chat('Nao consigo pensar agora!') }
    }
  })

  bot.on('health', () => { if (bot.health < 8 && bot.health > 0) { bot.pathfinder.stop(); eatFood(bot) } })
  bot.on('death', () => { bot.chat('Morri! Voltando...'); missionAnnounced = false })
  bot.on('kicked', (r:string) => { console.log(`[Bot] Kickado: ${r}`); scheduleReconnect() })
  bot.on('error', (e:Error) => console.error(`[Bot] Erro: ${e.message}`))
  bot.on('end', () => { botRef = null; scheduleReconnect() })
  return bot
}

function scheduleReconnect() {
  setTimeout(() => { reconnectDelay = Math.min(reconnectDelay*2,30000); createBot() }, reconnectDelay)
}

createBot()
bgAILoop()
