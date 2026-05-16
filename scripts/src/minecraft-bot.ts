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
let currentAction = 'EXPLORAR'
let nextAIAction = 'EXPLORAR'
let aiReady = true
let botRef: mineflayer.Bot | null = null

// ── AI runs in background, never blocks the action loop ──────────────────────
async function bgAILoop() {
  while (true) {
    await sleep(10000)
    if (!botRef || !botRef.entity || !aiReady) continue

    aiReady = false
    try {
      const situation = buildSituationReport(botRef)
      console.log(`[AI] Consultando Gemini...`)

      const prompt = `Você é o cérebro de um bot de Minecraft chamado EzBot_IA. Objetivo: sobreviver e matar o Ender Dragon.
Situação atual: ${situation}
Responda APENAS com um JSON: {"acao":"ACAO","motivo":"motivo curto","chat":"mensagem opcional"}
Ações: EXPLORAR, COLETAR_MADEIRA, MINERAR_PEDRA, LUTAR, COMER, CRAFTAR_FERRAMENTAS, FUGIR, DORMIR`

      const result = await gemini.generateContent(prompt)
      const text = result.response.text().trim()
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        nextAIAction = parsed.acao || 'EXPLORAR'
        console.log(`[AI] Gemini decidiu: ${nextAIAction} | ${parsed.motivo}`)
        if (parsed.chat && parsed.chat.length > 0 && botRef) {
          botRef.chat(parsed.chat.substring(0, 200))
        }
      }
    } catch (e: any) {
      if (e?.status === 429) {
        console.log('[AI] Cota excedida, tentando em 60s...')
        await sleep(60000)
      } else {
        console.log('[AI] Erro Gemini:', e?.message || String(e))
      }
    } finally {
      aiReady = true
    }
  }
}

function buildSituationReport(bot: mineflayer.Bot): string {
  const pos = bot.entity.position
  const nearbyMobs = Object.values(bot.entities)
    .filter((e: any) => e.type === 'mob' && e.position.distanceTo(pos) < 20)
    .map((e: any) => e.name).filter(Boolean).slice(0, 5)

  const inventory = bot.inventory.items()
    .reduce((acc: Record<string, number>, item: any) => {
      acc[item.name] = (acc[item.name] || 0) + item.count
      return acc
    }, {})

  const isNight = bot.time.timeOfDay > 13000 && bot.time.timeOfDay < 23000

  return JSON.stringify({
    pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    saude: Math.floor(bot.health),
    fome: bot.food,
    noite: isNight,
    mobs: nearbyMobs,
    inventario: inventory,
  })
}

// ── Main action loop — always running, never waits for AI ────────────────────
async function actionLoop(bot: mineflayer.Bot) {
  while (bot.entity) {
    try {
      // Safety: eat if low health
      if (bot.health < 10) {
        bot.pathfinder.stop()
        await eatFood(bot)
        await sleep(1000)
        continue
      }

      // Escape water immediately
      if (isInWater(bot)) {
        await escapeWater(bot)
        await sleep(500)
        continue
      }

      // Attack nearby hostiles
      const hostile = getNearestHostile(bot, 6)
      if (hostile) {
        bot.lookAt(hostile.position.offset(0, (hostile as any).height / 2, 0))
        bot.attack(hostile)
        await sleep(500)
        continue
      }

      // Use AI action (updated in background)
      currentAction = nextAIAction
      await executeAction(bot, currentAction)

    } catch (_e) {
      await sleep(1000)
    }
  }
}

function getNearestHostile(bot: mineflayer.Bot, maxDist: number) {
  return Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' &&
    e.isValid &&
    e.position.distanceTo(bot.entity.position) < maxDist &&
    isHostile(e.name)
  ).sort((a: any, b: any) =>
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0] || null
}

async function executeAction(bot: mineflayer.Bot, acao: string) {
  switch (acao) {
    case 'COLETAR_MADEIRA': await gatherWood(bot); break
    case 'MINERAR_PEDRA':   await mineStone(bot);  break
    case 'LUTAR':           await fight(bot);       break
    case 'COMER':           await eatFood(bot);     break
    case 'CRAFTAR_FERRAMENTAS': await craftTools(bot); break
    case 'FUGIR':           await flee(bot);        break
    case 'DORMIR':          await tryToSleep(bot);  break
    default:                await randomWalk(bot);  break
  }
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────
function createBot() {
  console.log(`[Bot] Conectando em ${HOST}:${PORT}...`)

  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: BOT_NAME, version: VERSION, auth: 'offline',
  })

  bot.loadPlugin(pathfinder)
  botRef = null

  bot.once('spawn', async () => {
    console.log('[Bot] Conectado! Iniciando...')
    reconnectDelay = 5000
    botRef = bot

    const move = new Movements(bot)
    move.allowSprinting = true
    move.canDig = true
    move.allowParkour = true
    move.liquidCost = 50
    bot.pathfinder.setMovements(move)

    bot.chat('EzBot_IA ligado!')
    await sleep(1000)
    actionLoop(bot)
  })

  bot.on('chat', async (username: string, message: string) => {
    if (username === bot.username) return
    console.log(`[Chat] ${username}: ${message}`)

    if (message === '!status') {
      const p = bot.entity.position
      bot.chat(`Saude:${bot.health.toFixed(0)} Fome:${bot.food} Pos:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} Acao:${currentAction}`)
      return
    }
    if (message === '!parar') {
      bot.pathfinder.stop()
      nextAIAction = 'EXPLORAR'
      bot.chat('Parado!')
      return
    }
    if (message.startsWith('!falar ')) {
      const q = message.slice(7)
      try {
        const r = await gemini.generateContent(
          `Você é EzBot_IA, bot de Minecraft. Responda curto e engraçado (max 180 chars): ${q}`
        )
        bot.chat(r.response.text().trim().substring(0, 180))
      } catch (_e) { bot.chat('Nao consigo pensar agora!') }
    }
  })

  bot.on('health', () => {
    if (bot.health < 8 && bot.health > 0) {
      bot.pathfinder.stop()
      eatFood(bot)
    }
  })

  bot.on('death', () => {
    console.log('[Bot] Morri!')
    bot.chat('Morri... voltando!')
    nextAIAction = 'EXPLORAR'
  })

  bot.on('kicked', (r: string) => { console.log(`[Bot] Kickado: ${r}`); scheduleReconnect() })
  bot.on('error', (e: Error) => { console.error(`[Bot] Erro: ${e.message}`) })
  bot.on('end', () => { console.log('[Bot] Desconectado.'); botRef = null; scheduleReconnect() })

  return bot
}

function scheduleReconnect() {
  console.log(`[Bot] Reconectando em ${reconnectDelay / 1000}s...`)
  setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 30000); createBot() }, reconnectDelay)
}

// ── Actions ───────────────────────────────────────────────────────────────────
function isInWater(bot: mineflayer.Bot): boolean {
  const b = bot.blockAt(bot.entity.position)
  return !!(b && (b.name === 'water' || b.name === 'flowing_water'))
}

async function escapeWater(bot: mineflayer.Bot) {
  bot.pathfinder.stop()
  const dirs: Array<'forward' | 'back' | 'left' | 'right'> = ['forward', 'back', 'left', 'right']
  bot.setControlState('jump', true)
  for (const dir of dirs) {
    if (!isInWater(bot)) break
    const yaw = dir === 'forward' ? 0 : dir === 'back' ? Math.PI : dir === 'left' ? Math.PI / 2 : -Math.PI / 2
    await bot.look(yaw, -0.3, true)
    bot.setControlState(dir, true)
    await sleep(2000)
    bot.setControlState(dir, false)
  }
  bot.setControlState('jump', false)
  for (const d of dirs) bot.setControlState(d, false)
}

async function eatFood(bot: mineflayer.Bot) {
  const food = bot.inventory.items().filter((i: any) => i.foodPoints && i.foodPoints > 0)
  if (!food.length) return
  try {
    await bot.equip(food[0], 'hand')
    await bot.consume()
    console.log(`[Bot] Comi ${food[0].name}`)
  } catch (_e) {}
}

async function gatherWood(bot: mineflayer.Bot) {
  const log = bot.findBlock({
    matching: (b: any) => b && (b.name.includes('log') || b.name.includes('wood')),
    maxDistance: 32,
  })
  if (log) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(log.position.x, log.position.y, log.position.z))
      await bot.dig(log)
    } catch (_e) { await randomWalk(bot) }
  } else { await randomWalk(bot) }
}

async function mineStone(bot: mineflayer.Bot) {
  const stone = bot.findBlock({
    matching: (b: any) => b && (b.name === 'stone' || b.name === 'cobblestone' || b.name === 'deepslate'),
    maxDistance: 32,
  })
  if (stone) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(stone.position.x, stone.position.y, stone.position.z))
      await bot.dig(stone)
    } catch (_e) { await randomWalk(bot) }
  } else { await randomWalk(bot) }
}

async function fight(bot: mineflayer.Bot) {
  const target = getNearestHostile(bot, 20)
  if (!target) return
  try {
    await bot.pathfinder.goto(new goals.GoalNear((target as any).position.x, (target as any).position.y, (target as any).position.z, 2))
    bot.lookAt((target as any).position.offset(0, (target as any).height / 2, 0))
    bot.attack(target)
    await sleep(500)
  } catch (_e) {}
}

async function flee(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  const x = pos.x + (Math.random() - 0.5) * 50
  const z = pos.z + (Math.random() - 0.5) * 50
  try { await bot.pathfinder.goto(new goals.GoalXZ(Math.floor(x), Math.floor(z))) } catch (_e) {}
}

async function craftTools(bot: mineflayer.Bot) {
  try {
    const table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 })
    if (table) {
      await bot.pathfinder.goto(new goals.GoalBlock(table.position.x, table.position.y, table.position.z))
    }
    const recipes = bot.recipesFor(302, null, 1, table || null)
    if (recipes.length) await bot.craft(recipes[0], 1, table || undefined)
  } catch (_e) {}
}

async function tryToSleep(bot: mineflayer.Bot) {
  const bed = bot.findBlock({ matching: (b: any) => b?.name.includes('bed'), maxDistance: 32 })
  if (!bed) { await randomWalk(bot); return }
  try {
    await bot.pathfinder.goto(new goals.GoalBlock(bed.position.x, bed.position.y, bed.position.z))
    await bot.sleep(bed)
  } catch (_e) {}
}

async function randomWalk(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  const x = pos.x + (Math.random() - 0.5) * 60
  const z = pos.z + (Math.random() - 0.5) * 60
  try {
    await bot.pathfinder.goto(new goals.GoalXZ(Math.floor(x), Math.floor(z)))
    console.log(`[Bot] Explorou para ${Math.floor(x)}, ${Math.floor(z)}`)
  } catch (_e) {}
}

function isHostile(name: string | undefined | null): boolean {
  if (!name) return false
  return ['zombie','skeleton','creeper','spider','enderman','witch','slime','phantom',
          'drowned','husk','stray','blaze','ghast','wither_skeleton','piglin_brute']
    .some(h => name.toLowerCase().includes(h))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// Start everything
createBot()
bgAILoop()
