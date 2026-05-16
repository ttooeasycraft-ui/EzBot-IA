import mineflayer from 'mineflayer'
import { GoogleGenerativeAI } from '@google/generative-ai'
// @ts-ignore
import pathfinderPkg from 'mineflayer-pathfinder'
import fs from 'fs'
import path from 'path'

const { pathfinder, Movements, goals: pfGoals } = pathfinderPkg

const HOST    = 'Ezbotttt.aternos.me'
const PORT    = 21779
const BOT_NAME = 'EzBot_IA'
const VERSION = '1.21.8'
const LOG_FILE = path.join(process.cwd(), 'bot-log.txt')

const genAI  = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || '')
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

let reconnectDelay = 5000
let botRef: mineflayer.Bot | null = null
let sessionStart = new Date()

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg: string) {
  const ts = new Date().toLocaleString('pt-BR')
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch (_e) {}
}

function initLogFile() {
  sessionStart = new Date()
  const header = `\n${'='.repeat(60)}\nSessao iniciada: ${sessionStart.toLocaleString('pt-BR')}\nServidor: ${HOST}:${PORT}\n${'='.repeat(60)}\n`
  try { fs.appendFileSync(LOG_FILE, header) } catch (_e) {}
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

function countItem(bot: mineflayer.Bot, kw: string) {
  return bot.inventory.items().filter((i: any) => i.name.includes(kw)).reduce((s: number, i: any) => s + i.count, 0)
}
function hasItem(bot: mineflayer.Bot, kw: string) {
  return bot.inventory.items().some((i: any) => i.name.includes(kw))
}
function isInWater(bot: mineflayer.Bot) {
  const b = bot.blockAt(bot.entity.position)
  return !!(b && (b.name === 'water' || b.name === 'flowing_water'))
}
function isHostile(name: string | null | undefined) {
  if (!name) return false
  return ['zombie','skeleton','creeper','spider','enderman','witch','slime','phantom',
          'drowned','husk','stray','blaze','ghast','wither_skeleton','piglin_brute']
    .some(h => name.toLowerCase().includes(h))
}
function getNearestHostile(bot: mineflayer.Bot, maxDist: number) {
  if (!bot.entity) return null
  return Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' && e.isValid &&
    e.position.distanceTo(bot.entity.position) < maxDist &&
    isHostile(e.name)
  ).sort((a: any, b: any) =>
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0] || null
}

// withTimeout: runs a promise, resolves null if it exceeds ms
function withTimeout<T>(fn: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => { log(`[Timeout] ${label} (${ms/1000}s)`); resolve(null) }, ms)
    fn.then(v => { clearTimeout(t); resolve(v) }).catch(() => { clearTimeout(t); resolve(null) })
  })
}

// ── Pathfinding helpers ────────────────────────────────────────────────────────
async function goNear(bot: mineflayer.Bot, pos: { x: number; y: number; z: number }, range = 2) {
  await bot.pathfinder.goto(new pfGoals.GoalNear(pos.x, pos.y, pos.z, range))
}

async function randomWalk(bot: mineflayer.Bot) {
  const p = bot.entity.position
  const x = Math.floor(p.x + (Math.random() - 0.5) * 40)
  const z = Math.floor(p.z + (Math.random() - 0.5) * 40)
  try {
    await bot.pathfinder.goto(new pfGoals.GoalXZ(x, z))
    log(`[Walk] -> ${x} ${z}`)
  } catch (_e) {}
}

// ── Water escape ───────────────────────────────────────────────────────────────
async function escapeWater(bot: mineflayer.Bot) {
  bot.pathfinder.stop()
  bot.setControlState('jump', true)
  for (const dir of ['forward','back','left','right'] as const) {
    if (!isInWater(bot)) break
    bot.setControlState(dir, true)
    await sleep(1500)
    bot.setControlState(dir, false)
  }
  bot.setControlState('jump', false)
}

// ── Crafting ───────────────────────────────────────────────────────────────────
async function tryBasicCraft(bot: mineflayer.Bot) {
  const mcData = (bot as any).mcData
  if (!mcData) return
  const logs = countItem(bot, 'log')
  if (logs < 1) return

  // Craft planks from logs (2x2, no table needed)
  const logItem = bot.inventory.items().find((i: any) => i.name.includes('log'))
  if (logItem) {
    const plankId = mcData.itemsByName['oak_planks']?.id
    if (plankId !== undefined) {
      const recipes = bot.recipesAll(plankId, null, false)
      if (recipes.length > 0) {
        try { await bot.craft(recipes[0], 4, undefined); log('[Craft] Planks') } catch (_e) {}
      }
    }
  }

  // Craft sticks
  const planks = countItem(bot, 'planks')
  if (planks >= 2) {
    const stickId = mcData.itemsByName['stick']?.id
    if (stickId !== undefined) {
      const recipes = bot.recipesAll(stickId, null, false)
      if (recipes.length > 0) {
        try { await bot.craft(recipes[0], 4, undefined); log('[Craft] Sticks') } catch (_e) {}
      }
    }
  }

  // Try to craft wooden pickaxe (needs crafting table)
  if (!hasItem(bot, 'wooden_pickaxe') && countItem(bot, 'planks') >= 3 && countItem(bot, 'stick') >= 2) {
    const pickId = mcData.itemsByName['wooden_pickaxe']?.id
    if (pickId !== undefined) {
      // Find or place a crafting table
      let table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 })
      if (!table) {
        const tableItem = bot.inventory.items().find((i: any) => i.name === 'crafting_table')
        if (tableItem) {
          const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0))
          if (ref) {
            try { await bot.placeBlock(ref, { x: 0, y: 1, z: 0 } as any); log('[Place] Crafting table') } catch (_e) {}
            table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 4 })
          }
        } else if (countItem(bot, 'planks') >= 4) {
          const tableId = mcData.itemsByName['crafting_table']?.id
          if (tableId !== undefined) {
            const tr = bot.recipesAll(tableId, null, false)
            if (tr.length > 0) { try { await bot.craft(tr[0], 1, undefined); log('[Craft] Crafting table') } catch (_e) {} }
            const tableItem2 = bot.inventory.items().find((i: any) => i.name === 'crafting_table')
            if (tableItem2) {
              const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0))
              if (ref) { try { await bot.placeBlock(ref, { x: 0, y: 1, z: 0 } as any) } catch (_e) {} }
              table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 4 })
            }
          }
        }
      }
      if (table) {
        try {
          await goNear(bot, table.position, 2)
          const recipes = bot.recipesAll(pickId, null, table)
          if (recipes.length > 0) { await bot.craft(recipes[0], 1, table); log('[Craft] Wooden Pickaxe!') }
        } catch (_e) {}
      }
    }
  }

  // Equip best pickaxe
  const pickTypes = ['diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe']
  for (const p of pickTypes) {
    const item = bot.inventory.items().find((i: any) => i.name === p)
    if (item) { try { await bot.equip(item, 'hand'); log(`[Equip] ${p}`) } catch (_e) {} ; break }
  }
}

// ── Mission: gather wood ───────────────────────────────────────────────────────
async function gatherWood(bot: mineflayer.Bot) {
  const block = bot.findBlock({
    matching: (b: any) => b && (b.name.includes('log') || b.name.includes('wood')),
    maxDistance: 48,
  })
  if (!block) { await randomWalk(bot); return }
  try {
    await goNear(bot, block.position, 2)
    await bot.dig(block)
    stats.woodCollected++
    log(`[Coletou] Madeira x${stats.woodCollected}`)
    // Also try the block above (trunk continues upward)
    const above = bot.blockAt(block.position.offset(0, 1, 0))
    if (above && (above.name.includes('log') || above.name.includes('wood'))) {
      try { await goNear(bot, above.position, 2); await bot.dig(above); stats.woodCollected++ } catch (_e) {}
    }
    await tryBasicCraft(bot)
  } catch (e: any) {
    const msg = e?.message || ''
    if (!msg.includes('aborted') && !msg.includes('Aborted')) log(`[Wood] ${msg}`)
  }
}

// ── Mission: mine blocks ───────────────────────────────────────────────────────
async function mineNearbyBlock(bot: mineflayer.Bot, names: string[], label: string, maxDist = 32) {
  const block = bot.findBlock({
    matching: (b: any) => b && names.some(n => b.name === n),
    maxDistance: maxDist,
  })
  if (!block) {
    if (label === 'stone') {
      // Dig below feet — stone is always underground
      const pos = bot.entity.position.floored()
      const below = bot.blockAt(pos.offset(0, -1, 0))
      if (below && below.name !== 'air' && below.name !== 'void_air') {
        try { await bot.dig(below); stats.stoneCollected++; log(`[Cava] y=${pos.y}`) } catch (_e) {}
      } else { await randomWalk(bot) }
    } else { await randomWalk(bot) }
    return
  }
  try {
    await goNear(bot, block.position, 2)
    await bot.dig(block)
    if (label === 'stone')  { stats.stoneCollected++; log(`[Coletou] Pedra x${stats.stoneCollected}`) }
    else if (label === 'iron') { stats.ironCollected++; log(`[Coletou] Ferro x${stats.ironCollected}`) }
    else { log(`[Coletou] ${label}`) }
  } catch (e: any) {
    const msg = e?.message || ''
    if (!msg.includes('aborted') && !msg.includes('Aborted')) log(`[Mine] ${msg}`)
  }
}

// ── Mission: gather food / hunt ────────────────────────────────────────────────
async function gatherFood(bot: mineflayer.Bot) {
  const food = bot.inventory.items().find((i: any) => i.foodPoints && i.foodPoints > 0)
  if (food) {
    try { await bot.equip(food, 'hand'); await bot.consume(); log('[Comeu] comida') } catch (_e) {}
    return
  }
  const animal = Object.values(bot.entities).find((e: any) =>
    e.type === 'mob' && e.isValid && e.position.distanceTo(bot.entity.position) < 20 &&
    ['cow','chicken','pig','sheep','rabbit'].some(n => e.name?.includes(n))
  ) as any
  if (animal) {
    try {
      await goNear(bot, animal.position, 2)
      bot.attack(animal)
      log(`[Caca] ${animal.name}`)
    } catch (_e) { await randomWalk(bot) }
  } else { await randomWalk(bot) }
}

// ── Mission: fight mobs ────────────────────────────────────────────────────────
async function fightMobs(bot: mineflayer.Bot) {
  const target = getNearestHostile(bot, 20) as any
  if (!target) return
  try {
    await goNear(bot, target.position, 2)
    bot.lookAt(target.position.offset(0, target.height / 2, 0))
    bot.attack(target)
    log(`[Mata] ${target.name}`)
  } catch (_e) {}
}

// ── Mission state ──────────────────────────────────────────────────────────────
type Mission = 'COLETAR_MADEIRA'|'MINERAR_PEDRA'|'MINERAR_FERRO'|'MINERAR_DIAMANTE'|'COLETAR_COMIDA'|'MATAR_MOBS'|'EXPLORAR'|'MATAR_DRAGAO'

const MISSION_DESC: Record<Mission, string> = {
  COLETAR_MADEIRA: 'Coletando madeira',
  MINERAR_PEDRA:   'Minerando pedra',
  MINERAR_FERRO:   'Minerando ferro',
  MINERAR_DIAMANTE:'Minerando diamante',
  COLETAR_COMIDA:  'Cacando comida',
  MATAR_MOBS:      'Matando mobs',
  EXPLORAR:        'Explorando',
  MATAR_DRAGAO:    'Indo matar o Ender Dragon!',
}

let currentMission: Mission = 'EXPLORAR'
let lastAnnounce = 0
let stats = { woodCollected: 0, stoneCollected: 0, ironCollected: 0, mobsKilled: 0, deaths: 0 }

function decideMission(bot: mineflayer.Bot): Mission {
  if (getNearestHostile(bot, 6)) return 'MATAR_MOBS'
  const hasAnyFood = hasItem(bot,'cooked')||hasItem(bot,'bread')||hasItem(bot,'apple')||
                     hasItem(bot,'beef')||hasItem(bot,'pork')||hasItem(bot,'chicken')||hasItem(bot,'mutton')
  if (bot.food < 6 && !hasAnyFood) return 'COLETAR_COMIDA'
  if (countItem(bot,'log') + countItem(bot,'planks') < 32) return 'COLETAR_MADEIRA'
  if (countItem(bot,'cobblestone') + countItem(bot,'stone') < 48) return 'MINERAR_PEDRA'
  if (countItem(bot,'iron_ingot') + countItem(bot,'raw_iron') < 24) return 'MINERAR_FERRO'
  if (countItem(bot,'diamond') < 6) return 'MINERAR_DIAMANTE'
  return 'MATAR_DRAGAO'
}

async function runMission(bot: mineflayer.Bot, m: Mission) {
  switch (m) {
    case 'COLETAR_MADEIRA':  return gatherWood(bot)
    case 'MINERAR_PEDRA':    return mineNearbyBlock(bot, ['stone','cobblestone','deepslate'], 'stone')
    case 'MINERAR_FERRO':    return mineNearbyBlock(bot, ['iron_ore','deepslate_iron_ore'], 'iron')
    case 'MINERAR_DIAMANTE': return mineNearbyBlock(bot, ['diamond_ore','deepslate_diamond_ore'], 'diamond', 64)
    case 'COLETAR_COMIDA':   return gatherFood(bot)
    case 'MATAR_MOBS':       return fightMobs(bot)
    default:                 return randomWalk(bot)
  }
}

// ── Main action loop ───────────────────────────────────────────────────────────
async function actionLoop(bot: mineflayer.Bot) {
  log('[Loop] Iniciando!')
  const TICK = 30000 // max 30s per action

  while (bot.entity) {
    try {
      // Eat passively when food low
      if (bot.food < 18) {
        const f = bot.inventory.items().find((i: any) => i.foodPoints && i.foodPoints > 0)
        if (f) { try { await bot.equip(f, 'hand'); await bot.consume() } catch (_e) {} }
      }

      // Escape water
      if (isInWater(bot)) {
        log('[Loop] Agua, escapando')
        await withTimeout(escapeWater(bot), 12000, 'escapeWater')
        await sleep(500)
        continue
      }

      // Immediate fight if hit
      const hostile = getNearestHostile(bot, 3)
      if (hostile) {
        bot.lookAt((hostile as any).position.offset(0, (hostile as any).height/2, 0))
        bot.attack(hostile)
        await sleep(400)
        continue
      }

      // Decide mission
      const m = decideMission(bot)
      if (m !== currentMission || Date.now() - lastAnnounce > 90000) {
        currentMission = m
        lastAnnounce = Date.now()
        log(`[Missao] ${MISSION_DESC[m]}`)
        bot.chat(`>> Missao: ${MISSION_DESC[m]}`)
      }

      await withTimeout(runMission(bot, m), TICK, m)
      await sleep(200)

    } catch (e: any) {
      log(`[Erro] ${e?.message || String(e)}`)
      await sleep(1500)
    }
  }
  log('[Loop] Fim.')
}

// ── AI background loop ─────────────────────────────────────────────────────────
async function bgAILoop() {
  await sleep(30000) // wait for bot to settle
  while (true) {
    await sleep(25000)
    const bot = botRef
    if (!bot?.entity) continue
    try {
      const inv = bot.inventory.items().reduce((a: any, i: any) => { a[i.name] = (a[i.name] || 0) + i.count; return a }, {})
      const p = bot.entity.position
      const prompt = `Você é EzBot_IA, bot autônomo de Minecraft com objetivo de matar o Ender Dragon. Missao atual: "${MISSION_DESC[currentMission]}". Inventario: ${JSON.stringify(inv)}. Saude: ${Math.floor(bot.health)}. Posicao: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}. Escreva uma frase curta (max 130 chars) engraçada em português do Brasil sobre o que está fazendo:`
      const r = await gemini.generateContent(prompt)
      const txt = r.response.text().trim().substring(0, 130)
      if (txt && bot) { bot.chat(txt); log(`[AI] ${txt}`) }
    } catch (e: any) {
      if (e?.status === 429) { log('[AI] Quota excedida, esperando 60s'); await sleep(60000) }
    }
  }
}

// ── Status reporter ────────────────────────────────────────────────────────────
async function statusReporter(bot: mineflayer.Bot) {
  while (bot.entity) {
    await sleep(5 * 60 * 1000)
    if (!bot.entity) break
    const elapsed = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
    const p = bot.entity.position
    const rpt = [
      `--- Relatorio ${new Date().toLocaleString('pt-BR')} ---`,
      `Tempo online: ${elapsed} min | Missao: ${MISSION_DESC[currentMission]}`,
      `Pos: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} | HP:${Math.floor(bot.health)} Fome:${bot.food}`,
      `Madeira:${stats.woodCollected} Pedra:${stats.stoneCollected} Ferro:${stats.ironCollected} Mobs:${stats.mobsKilled} Mortes:${stats.deaths}`,
    ].join('\n')
    log(rpt)
    bot.chat(`[${elapsed}min] ${MISSION_DESC[currentMission]} | HP:${Math.floor(bot.health)} Madeira:${stats.woodCollected} Pedra:${stats.stoneCollected} Ferro:${stats.ironCollected}`)
  }
}

// ── Bot lifecycle ──────────────────────────────────────────────────────────────
function createBot() {
  log(`[Bot] Conectando ${HOST}:${PORT}...`)
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_NAME, version: VERSION, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  botRef = null

  bot.once('spawn', async () => {
    log('[Bot] Conectado!')
    reconnectDelay = 5000
    botRef = bot

    const move = new Movements(bot)
    move.allowSprinting = true
    move.canDig = true
    move.allowParkour = true
    move.liquidCost = 100
    bot.pathfinder.setMovements(move)

    bot.chat('EzBot_IA v3 online! Objetivo: matar o Ender Dragon!')
    await sleep(2000)

    actionLoop(bot)
    statusReporter(bot)
  })

  bot.on('chat', async (username: string, msg: string) => {
    if (username === bot.username) return
    log(`[Chat] ${username}: ${msg}`)

    if (msg === '!status') {
      const elapsed = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
      const p = bot.entity.position
      bot.chat(`[${elapsed}min] ${MISSION_DESC[currentMission]} | HP:${Math.floor(bot.health)} | Pos:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} | Madeira:${stats.woodCollected} Pedra:${stats.stoneCollected}`)
    }
    if (msg === '!missao') bot.chat(`Missao: ${MISSION_DESC[currentMission]}`)
    if (msg === '!inv') {
      const items = bot.inventory.items().map((i: any) => `${i.name}x${i.count}`).join(', ') || 'vazio'
      bot.chat(`Inv: ${items.substring(0, 200)}`)
    }
    if (msg === '!pos') {
      const p = bot.entity.position
      bot.chat(`Pos: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
    }
    if (msg.startsWith('!falar ')) {
      try {
        const r = await gemini.generateContent(`Você é EzBot_IA, bot de Minecraft. Responda em max 130 chars: ${msg.slice(7)}`)
        const reply = r.response.text().trim().substring(0, 130)
        bot.chat(reply)
      } catch (_e) { bot.chat('Nao consigo pensar agora!') }
    }
    if (msg === '!log') bot.chat(`Log salvo em: ${LOG_FILE}`)
    if (msg === '!parar') { bot.pathfinder.stop(); bot.chat('Parado!') }
    if (msg === '!andar') bot.chat('Ok, continuando missao!')
  })

  bot.on('health', () => {
    if (bot.health > 0 && bot.health < 5) {
      const f = bot.inventory.items().find((i: any) => i.foodPoints && i.foodPoints > 0)
      if (f) bot.equip(f, 'hand').then(() => bot.consume()).catch(() => {})
    }
  })

  bot.on('entityDead', (e: any) => {
    if (isHostile(e.name)) { stats.mobsKilled++; log(`[Kill] ${e.name} (total: ${stats.mobsKilled})`) }
  })

  bot.on('death', () => {
    stats.deaths++
    log(`[Morte #${stats.deaths}] Morreu!`)
  })

  bot.on('kicked', (r: string) => { log(`[Kick] ${r}`); scheduleReconnect() })
  bot.on('error', (e: Error) => log(`[Erro] ${e.message}`))
  bot.on('end', () => { log('[Desconectado]'); botRef = null; scheduleReconnect() })

  return bot
}

function scheduleReconnect() {
  log(`[Reconectar] em ${reconnectDelay / 1000}s...`)
  setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 30000); createBot() }, reconnectDelay)
}

// ── Entry point ────────────────────────────────────────────────────────────────
initLogFile()
log('[Sistema] EzBot_IA v3.0 iniciando...')
createBot()
bgAILoop()
