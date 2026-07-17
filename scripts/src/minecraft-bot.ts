/**
 * EzBot_IA v4.0 — Bot autônomo de Minecraft
 * Objetivo: matar o Ender Dragon com sistema de IA rotativa e combate inteligente
 */
import mineflayer from 'mineflayer'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
// @ts-ignore
import pathfinderPkg from 'mineflayer-pathfinder'
// @ts-ignore
import nodemailer from 'nodemailer'
import fs from 'fs'
import path from 'path'

const { pathfinder, Movements, goals: PF } = pathfinderPkg

// ── Config (privado — vem de variáveis de ambiente) ───────────────────────────
const HOST          = process.env.MINECRAFT_HOST    || 'factionsmatrix.com'
const PORT          = parseInt(process.env.MINECRAFT_PORT || '25565')
const BOT_NAME      = process.env.BOT_NAME          || 'FactWiki'
const VERSION       = process.env.MINECRAFT_VERSION || '1.21.11'
const LOG_FILE      = path.join(process.cwd(), 'bot-log.txt')
const EXPLORE_MODE  = process.env.EXPLORE_MODE === 'true'
const NERDZONE_MODE = HOST.includes('nerdzone')

// ── Sistema de IA Rotativa ────────────────────────────────────────────────────
interface AIProvider {
  name: string
  type: 'openai-compat' | 'anthropic' | 'gemini'
  key: string | undefined
  baseURL?: string
  model: string
  exhaustedUntil: number  // timestamp — 0 = disponível
}

const AI_PROVIDERS: AIProvider[] = [
  { name: 'Cerebras',    type: 'openai-compat', key: process.env.CEREBRAS_API_KEY,    baseURL: 'https://api.cerebras.ai/v1',         model: 'llama-3.3-70b',                         exhaustedUntil: 0 },
  { name: 'Groq',        type: 'openai-compat', key: process.env.GROQ_API_KEY,        baseURL: 'https://api.groq.com/openai/v1',     model: 'llama-3.3-70b-versatile',               exhaustedUntil: 0 },
  { name: 'Mistral',     type: 'openai-compat', key: process.env.MISTRAL_API_KEY,     baseURL: 'https://api.mistral.ai/v1',          model: 'mistral-small-latest',                  exhaustedUntil: 0 },
  { name: 'OpenRouter',  type: 'openai-compat', key: process.env.OPENROUTER_API_KEY,  baseURL: 'https://openrouter.ai/api/v1',       model: 'meta-llama/llama-3.3-70b-instruct:free', exhaustedUntil: 0 },
  { name: 'DeepSeek',    type: 'openai-compat', key: process.env.DEEPSEEK_API_KEY,    baseURL: 'https://api.deepseek.com/v1',        model: 'deepseek-chat',                         exhaustedUntil: 0 },
  { name: 'xAI Grok',   type: 'openai-compat', key: process.env.XAI_API_KEY,         baseURL: 'https://api.x.ai/v1',               model: 'grok-3-mini',                           exhaustedUntil: 0 },
  { name: 'OpenAI',      type: 'openai-compat', key: process.env.OPENAI_API_KEY,      baseURL: 'https://api.openai.com/v1',          model: 'gpt-4o-mini',                           exhaustedUntil: 0 },
  { name: 'Anthropic',   type: 'anthropic',     key: process.env.ANTHROPIC_API_KEY,   model: 'claude-haiku-3-5',                    exhaustedUntil: 0 },
  { name: 'Gemini',      type: 'gemini',        key: process.env.GOOGLE_AI_API_KEY,   model: 'gemini-2.0-flash',                    exhaustedUntil: 0 },
]

let currentAIIndex = 0

function getActiveProvider(): AIProvider | null {
  const now = Date.now()
  // Start from current, wrap around
  for (let i = 0; i < AI_PROVIDERS.length; i++) {
    const idx = (currentAIIndex + i) % AI_PROVIDERS.length
    const p = AI_PROVIDERS[idx]
    if (p.key && p.exhaustedUntil < now) {
      if (i > 0) { currentAIIndex = idx; log(`[IA] Trocou para: ${p.name}`) }
      return p
    }
  }
  return null
}

function markProviderExhausted(provider: AIProvider) {
  provider.exhaustedUntil = Date.now() + 60 * 60 * 1000 // 1 hora
  log(`[IA] ${provider.name} esgotada (429). Tentando próxima...`)
  // Advance index
  currentAIIndex = (currentAIIndex + 1) % AI_PROVIDERS.length
}

async function askAI(prompt: string): Promise<string | null> {
  const provider = getActiveProvider()
  if (!provider) { log('[IA] Nenhuma IA disponível agora.'); return null }

  try {
    if (provider.type === 'openai-compat') {
      const client = new OpenAI({ apiKey: provider.key!, baseURL: provider.baseURL })
      const resp = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 160,
      })
      return resp.choices[0]?.message?.content?.trim() ?? null
    }

    if (provider.type === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': provider.key!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: provider.model, max_tokens: 160, messages: [{ role: 'user', content: prompt }] }),
      })
      if (resp.status === 429) { markProviderExhausted(provider); return askAI(prompt) }
      const data = await resp.json() as any
      return data.content?.[0]?.text?.trim() ?? null
    }

    if (provider.type === 'gemini') {
      const genAI = new GoogleGenerativeAI(provider.key!)
      const model = genAI.getGenerativeModel({ model: provider.model })
      const result = await model.generateContent(prompt)
      return result.response.text().trim()
    }
  } catch (e: any) {
    const status = e?.status || e?.response?.status
    const msg = e?.message ?? ''
    // Rotacionar em erros permanentes (404 = recurso/modelo inexistente, 401 = auth, 403 = sem permissão)
    // e também em erros de quota (429)
    const isHardFail = status === 404 || status === 401 || status === 403 ||
      msg.includes('404') || msg.includes('401') || msg.includes('403')
    const isQuota = status === 429 || msg.includes('429') || msg.toLowerCase().includes('quota')
    if (isHardFail || isQuota) {
      const ttl = isHardFail ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000  // 6h para hard fail, 1h para quota
      provider.exhaustedUntil = Date.now() + ttl
      log(`[IA] ${provider.name} indisponível (${status ?? msg.slice(0,30)}). Rotacionando...`)
      currentAIIndex = (currentAIIndex + 1) % AI_PROVIDERS.length
      return askAI(prompt)
    }
    log(`[IA] Erro ${provider.name}: ${msg}`)
  }
  return null
}

// ── Conhecimento dos Mobs (Cerebro) ───────────────────────────────────────────
const MOB_HP: Record<string, number> = {
  zombie: 20, skeleton: 20, creeper: 20, spider: 16, cave_spider: 12,
  enderman: 40, witch: 26, blaze: 20, ghast: 10, wither_skeleton: 20,
  piglin: 16, piglin_brute: 50, zombified_piglin: 20, hoglin: 40,
  phantom: 10, drowned: 20, husk: 20, stray: 20, vindicator: 24,
  pillager: 24, ravager: 100, elder_guardian: 80, guardian: 30,
  shulker: 15, silverfish: 8, slime_big: 16, magma_cube_big: 16,
  warden: 500, ender_dragon: 200, wither: 300,
}

const MOB_DAMAGE: Record<string, number> = {
  zombie: 3.5, skeleton: 4, creeper: 49, spider: 2, cave_spider: 2,
  enderman: 7, witch: 6, blaze: 6, ghast: 17, wither_skeleton: 5,
  piglin: 5, piglin_brute: 9, hoglin: 6, phantom: 6,
  drowned: 3.5, husk: 3.5, stray: 4, vindicator: 8, pillager: 4,
  ravager: 12, elder_guardian: 8, guardian: 6, warden: 30,
}

// Mobs que o bot SEMPRE foge independente do HP
const ALWAYS_FLEE = new Set(['creeper', 'warden', 'elder_guardian', 'ravager'])
// Distância mínima de creeper
const CREEPER_SAFE_DIST = 6

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg: string) {
  const ts = new Date().toLocaleString('pt-BR')
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch (_e) {}
}

function initLogFile() {
  const header = `\n${'='.repeat(60)}\nSessao iniciada: ${new Date().toLocaleString('pt-BR')}\nServidor: ${HOST}:${PORT}\n${'='.repeat(60)}\n`
  try { fs.appendFileSync(LOG_FILE, header) } catch (_e) {}
}

// ── Estado global ─────────────────────────────────────────────────────────────
let botRef: mineflayer.Bot | null = null
let reconnectDelay = 5000
let sessionStart = new Date()
let basePos: { x: number; y: number; z: number } | null = null
let followTarget: string | null = null
let forceMission: string | null = null
let stats = { woodCollected: 0, stoneCollected: 0, ironCollected: 0, diamondCollected: 0, mobsKilled: 0, deaths: 0 }

// ── Utilitários ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

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
function isHostileName(name: string | null | undefined) {
  if (!name) return false
  return Object.keys(MOB_HP).some(h => name.toLowerCase().includes(h.replace('_', '')))
}
function getMobKey(name: string): string {
  const n = name.toLowerCase()
  return Object.keys(MOB_HP).find(k => n.includes(k.replace('_', ''))) || name
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => { log(`[Timeout] ${label}`); resolve(null) }, ms)
    p.then(v => { clearTimeout(t); resolve(v) }).catch(() => { clearTimeout(t); resolve(null) })
  })
}

// ── Pathfinding ────────────────────────────────────────────────────────────────
async function goNear(bot: mineflayer.Bot, pos: { x: number; y: number; z: number }, range = 2) {
  await bot.pathfinder.goto(new PF.GoalNear(pos.x, pos.y, pos.z, range))
}

async function randomWalk(bot: mineflayer.Bot, dist = 40) {
  const p = bot.entity.position
  const x = Math.floor(p.x + (Math.random() - 0.5) * dist * 2)
  const z = Math.floor(p.z + (Math.random() - 0.5) * dist * 2)
  log(`[Walk] -> ${x},${z} (explorando)`)
  try { await bot.pathfinder.goto(new PF.GoalXZ(x, z)) } catch (_e) {}
}

// ── Auto-Equip Armadura ────────────────────────────────────────────────────────
const ARMOR_PRIORITY = ['diamond', 'netherite', 'iron', 'golden', 'chainmail', 'leather']
const ARMOR_SLOTS: Array<{ slot: mineflayer.EquipmentDestination; names: string[] }> = [
  { slot: 'head',   names: ['helmet'] },
  { slot: 'torso',  names: ['chestplate'] },
  { slot: 'legs',   names: ['leggings'] },
  { slot: 'feet',   names: ['boots'] },
]

async function autoEquipArmor(bot: mineflayer.Bot) {
  for (const { slot, names } of ARMOR_SLOTS) {
    for (const mat of ARMOR_PRIORITY) {
      const piece = bot.inventory.items().find((i: any) => names.some(n => i.name === `${mat}_${n}`))
      if (piece) {
        const current = bot.inventory.slots[slot === 'head' ? 5 : slot === 'torso' ? 6 : slot === 'legs' ? 7 : 8]
        if (!current || ARMOR_PRIORITY.indexOf(mat) < ARMOR_PRIORITY.findIndex(m => current.name.startsWith(m))) {
          try { await bot.equip(piece, slot); log(`[Armadura] Equipou ${piece.name}`) } catch (_e) {}
        }
        break
      }
    }
  }
}

async function equipBestWeapon(bot: mineflayer.Bot) {
  const priority = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','netherite_axe','diamond_axe','iron_axe']
  for (const name of priority) {
    const item = bot.inventory.items().find((i: any) => i.name === name)
    if (item) { try { await bot.equip(item, 'hand') } catch (_e) {}; return }
  }
}

// ── Auto-Eat ──────────────────────────────────────────────────────────────────
async function tryEat(bot: mineflayer.Bot) {
  const FOOD_PRIORITY = ['cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','bread','apple','carrot','potato','cooked_rabbit']
  for (const name of FOOD_PRIORITY) {
    const food = bot.inventory.items().find((i: any) => i.name === name)
    if (food) {
      try {
        await bot.equip(food, 'hand')
        await bot.consume()
        log(`[Comeu] ${food.name}`)
        return true
      } catch (_e) {}
    }
  }
  // Fallback: any food
  const anyFood = bot.inventory.items().find((i: any) => (i as any).foodPoints && (i as any).foodPoints > 0)
  if (anyFood) {
    try { await bot.equip(anyFood, 'hand'); await bot.consume(); return true } catch (_e) {}
  }
  return false
}

// ── Sistema de Combate ────────────────────────────────────────────────────────
function getNearestHostile(bot: mineflayer.Bot, maxDist: number) {
  if (!bot.entity) return null
  return Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' && e.isValid &&
    e.position.distanceTo(bot.entity.position) < maxDist &&
    isHostileName(e.name)
  ).sort((a: any, b: any) =>
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0] || null
}

function shouldFlee(bot: mineflayer.Bot, mob: any): boolean {
  const key = getMobKey(mob.name || '')
  // Always flee from dangerous mobs
  if (ALWAYS_FLEE.has(key)) return true
  // Creeper too close
  if (key === 'creeper' && mob.position.distanceTo(bot.entity.position) < CREEPER_SAFE_DIST) return true
  // Flee if health too low
  if (bot.health < 8) return true
  // Calculate if worth fighting
  const mobDmg = MOB_DAMAGE[key] || 4
  const hitsToKillUs = Math.ceil(bot.health / mobDmg)
  return hitsToKillUs <= 2 // too risky
}

async function fleeFromMob(bot: mineflayer.Bot, mob: any) {
  bot.pathfinder.stop()
  const myPos = bot.entity.position
  const mobPos = mob.position
  // Run opposite direction
  const dx = myPos.x - mobPos.x
  const dz = myPos.z - mobPos.z
  const dist = Math.sqrt(dx*dx + dz*dz) || 1
  const targetX = Math.floor(myPos.x + (dx/dist) * 20)
  const targetZ = Math.floor(myPos.z + (dz/dist) * 20)
  try { await bot.pathfinder.goto(new PF.GoalXZ(targetX, targetZ)) } catch (_e) {}
  // Heal while fleeing
  if (bot.food < 18) await tryEat(bot)
}

async function fightMob(bot: mineflayer.Bot, mob: any) {
  const key = getMobKey(mob.name || '')
  const mobHP = MOB_HP[key] || 20
  log(`[PVP] Lutando: ${mob.name} (HP: ${mobHP})`)

  await equipBestWeapon(bot)

  // Enderman: use water or just attack carefully
  // Approach
  try {
    await goNear(bot, mob.position, 2)
    bot.lookAt(mob.position.offset(0, mob.height / 2, 0))
    bot.attack(mob)
  } catch (_e) {}
}

// ── Water Escape ──────────────────────────────────────────────────────────────
async function escapeWater(bot: mineflayer.Bot) {
  bot.pathfinder.stop()
  bot.setControlState('jump', true)
  for (const dir of ['forward', 'back', 'left', 'right'] as const) {
    if (!isInWater(bot)) break
    bot.setControlState(dir, true)
    await sleep(1500)
    bot.setControlState(dir, false)
  }
  bot.setControlState('jump', false)
}

// ── Missões ────────────────────────────────────────────────────────────────────
async function gatherWood(bot: mineflayer.Bot) {
  const block = bot.findBlock({ matching: (b: any) => b && (b.name.includes('log') || b.name.includes('wood')), maxDistance: 64 })
  if (!block) { await randomWalk(bot); return }
  try {
    await goNear(bot, block.position, 2)
    await bot.dig(block)
    stats.woodCollected++
    log(`[Coletou] Madeira #${stats.woodCollected}`)
    // Dig upward continuation
    const above = bot.blockAt(block.position.offset(0,1,0))
    if (above?.name.includes('log')) { try { await goNear(bot, above.position, 2); await bot.dig(above); stats.woodCollected++ } catch (_e) {} }
    await tryBasicCraft(bot)
  } catch (e: any) {
    if (!e?.message?.includes('abort')) log(`[Wood] ${e?.message}`)
  }
}

async function mineBlock(bot: mineflayer.Bot, names: string[], label: string, digDown = false) {
  const block = bot.findBlock({ matching: (b: any) => b && names.some(n => b.name === n), maxDistance: 32 })
  if (!block) {
    if (digDown) {
      const pos = bot.entity.position.floored()
      const below = bot.blockAt(pos.offset(0,-1,0))
      if (below && below.name !== 'air') {
        try { await bot.dig(below); if(label==='stone'){stats.stoneCollected++;log(`[Cava] y=${pos.y}`)} } catch (_e) {}
      } else { await randomWalk(bot) }
    } else { await randomWalk(bot) }
    return
  }
  try {
    await goNear(bot, block.position, 2)
    await bot.dig(block)
    if (label === 'stone')   { stats.stoneCollected++;  log(`[Coletou] Pedra #${stats.stoneCollected}`) }
    if (label === 'iron')    { stats.ironCollected++;   log(`[Coletou] Ferro #${stats.ironCollected}`) }
    if (label === 'diamond') { stats.diamondCollected++; log(`[Coletou] DIAMANTE! #${stats.diamondCollected}`) }
  } catch (e: any) {
    if (!e?.message?.includes('abort')) log(`[Mine] ${e?.message}`)
  }
}

async function mineDiamond(bot: mineflayer.Bot) {
  // Diamond best at Y=-59. If above y=-50, dig down first.
  const pos = bot.entity.position.floored()
  if (pos.y > -50) {
    // Mine down toward diamond level
    const below = bot.blockAt(pos.offset(0,-1,0))
    if (below && below.name !== 'air' && below.name !== 'void_air') {
      try { await bot.dig(below); log(`[DiaDig] y=${pos.y}`) } catch (_e) {}
    }
    return
  }
  await mineBlock(bot, ['diamond_ore','deepslate_diamond_ore'], 'diamond')
}

async function gatherFood(bot: mineflayer.Bot) {
  if (await tryEat(bot)) return
  const animal = Object.values(bot.entities).find((e: any) =>
    e.type === 'mob' && e.isValid &&
    e.position.distanceTo(bot.entity.position) < 24 &&
    ['cow','chicken','pig','sheep','rabbit'].some(n => e.name?.includes(n))
  ) as any
  if (animal) {
    try { await goNear(bot, animal.position, 2); bot.attack(animal); log(`[Caca] ${animal.name}`) }
    catch (_e) { await randomWalk(bot) }
  } else { await randomWalk(bot) }
}

// ── Crafting Básico ────────────────────────────────────────────────────────────
async function tryBasicCraft(bot: mineflayer.Bot) {
  const mcData = (bot as any).mcData
  if (!mcData) return

  const craft = async (itemName: string, count: number, table: any = undefined) => {
    const id = mcData.itemsByName[itemName]?.id
    if (id === undefined) return false
    const recipes = bot.recipesAll(id, null, table)
    if (!recipes.length) return false
    try { await bot.craft(recipes[0], count, table); log(`[Craft] ${itemName} x${count}`); return true }
    catch (_e) { return false }
  }

  // 1. Logs → planks
  if (countItem(bot,'log') > 0) await craft('oak_planks', 4)

  // 2. Planks → sticks
  if (countItem(bot,'planks') >= 2) await craft('stick', 4)

  // 3. Planks → crafting_table (if don't have one)
  let table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 })
  if (!table && !hasItem(bot,'crafting_table') && countItem(bot,'planks') >= 4) await craft('crafting_table', 1)

  // Place crafting table if needed
  if (!table && hasItem(bot,'crafting_table')) {
    const ref = bot.blockAt(bot.entity.position.offset(1,-1,0))
    if (ref) { try { await bot.placeBlock(ref, { x:0, y:1, z:0 } as any); log('[Place] Mesa') } catch (_e) {} }
    table = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 6 })
  }

  if (!table) return

  // Go to table
  try { await goNear(bot, table.position, 2) } catch (_e) { return }

  const hasTable = table

  // 4. Wooden pickaxe
  if (!hasItem(bot,'wooden_pickaxe') && countItem(bot,'planks') >= 3 && countItem(bot,'stick') >= 2)
    await craft('wooden_pickaxe', 1, hasTable)

  // 5. Wooden sword
  if (!hasItem(bot,'wooden_sword') && !hasItem(bot,'stone_sword') && !hasItem(bot,'iron_sword') && !hasItem(bot,'diamond_sword') && countItem(bot,'planks') >= 2 && countItem(bot,'stick') >= 1)
    await craft('wooden_sword', 1, hasTable)

  // 6. Stone pickaxe
  if (!hasItem(bot,'stone_pickaxe') && countItem(bot,'cobblestone') >= 3 && countItem(bot,'stick') >= 2)
    await craft('stone_pickaxe', 1, hasTable)

  // 7. Stone sword
  if (!hasItem(bot,'stone_sword') && !hasItem(bot,'iron_sword') && !hasItem(bot,'diamond_sword') && countItem(bot,'cobblestone') >= 2 && countItem(bot,'stick') >= 1)
    await craft('stone_sword', 1, hasTable)

  // 8. Iron pickaxe
  if (!hasItem(bot,'iron_pickaxe') && countItem(bot,'iron_ingot') >= 3 && countItem(bot,'stick') >= 2)
    await craft('iron_pickaxe', 1, hasTable)

  // 9. Iron sword
  if (!hasItem(bot,'iron_sword') && !hasItem(bot,'diamond_sword') && countItem(bot,'iron_ingot') >= 2 && countItem(bot,'stick') >= 1)
    await craft('iron_sword', 1, hasTable)

  // 10. Iron armor (if 24+ ingots)
  if (countItem(bot,'iron_ingot') >= 24) {
    if (!hasItem(bot,'iron_helmet'))     await craft('iron_helmet',     1, hasTable)
    if (!hasItem(bot,'iron_chestplate')) await craft('iron_chestplate', 1, hasTable)
    if (!hasItem(bot,'iron_leggings'))   await craft('iron_leggings',   1, hasTable)
    if (!hasItem(bot,'iron_boots'))      await craft('iron_boots',      1, hasTable)
  }

  // Equip after crafting
  await equipBestWeapon(bot)
  await autoEquipArmor(bot)
}

// ── Missão: Dormir ─────────────────────────────────────────────────────────────
async function trySleep(bot: mineflayer.Bot) {
  const bed = bot.findBlock({ matching: (b: any) => b?.name?.includes('bed'), maxDistance: 32 })
  if (!bed) { log('[Dormir] Sem cama perto'); bot.chat('Nao achei cama perto!'); return }
  try {
    await goNear(bot, bed.position, 2)
    await bot.sleep(bed)
    log('[Dormiu] Boa noite!')
    bot.chat('Boa noite! Dormindo...')
    await sleep(5000)
    await bot.wake()
  } catch (e: any) { log(`[Dormir] ${e?.message}`); bot.chat(`Nao consegui dormir: ${e?.message?.substring(0,50)}`) }
}

// ── Sistema de Missões ─────────────────────────────────────────────────────────
type Mission = 'COLETAR_MADEIRA'|'MINERAR_PEDRA'|'MINERAR_FERRO'|'MINERAR_DIAMANTE'|'COLETAR_COMIDA'|'SEGUIR_JOGADOR'|'IR_BASE'|'EXPLORAR'|'MATAR_DRAGAO'

const MISSION_DESC: Record<Mission, string> = {
  COLETAR_MADEIRA:  'Coletando madeira',
  MINERAR_PEDRA:    'Minerando pedra',
  MINERAR_FERRO:    'Minerando ferro',
  MINERAR_DIAMANTE: 'Minerando diamante',
  COLETAR_COMIDA:   'Cacando comida',
  SEGUIR_JOGADOR:   'Seguindo jogador',
  IR_BASE:          'Voltando para a base',
  EXPLORAR:         'Explorando',
  MATAR_DRAGAO:     'Missao final: Ender Dragon!',
}

let currentMission: Mission = 'EXPLORAR'
let lastAnnounce = 0

function decideMission(bot: mineflayer.Bot): Mission {
  if (forceMission) return forceMission as Mission
  if (followTarget) return 'SEGUIR_JOGADOR'
  const hasAnyFood = ['cooked_beef','cooked_porkchop','cooked_chicken','bread','apple','cooked_mutton','cooked_rabbit']
    .some(f => hasItem(bot, f))
  if (bot.food < 6 && !hasAnyFood) return 'COLETAR_COMIDA'
  const wood = countItem(bot,'log') + countItem(bot,'planks')
  if (wood < 32) return 'COLETAR_MADEIRA'
  const stone = countItem(bot,'cobblestone') + countItem(bot,'stone') + countItem(bot,'deepslate')
  if (stone < 48) return 'MINERAR_PEDRA'
  const iron = countItem(bot,'iron_ingot') + countItem(bot,'raw_iron')
  if (iron < 24) return 'MINERAR_FERRO'
  const diamond = countItem(bot,'diamond')
  if (diamond < 6) return 'MINERAR_DIAMANTE'
  return 'MATAR_DRAGAO'
}

async function runMission(bot: mineflayer.Bot, m: Mission) {
  switch (m) {
    case 'COLETAR_MADEIRA':  return gatherWood(bot)
    case 'MINERAR_PEDRA':    return mineBlock(bot, ['stone','cobblestone','deepslate'], 'stone', true)
    case 'MINERAR_FERRO':    return mineBlock(bot, ['iron_ore','deepslate_iron_ore'], 'iron')
    case 'MINERAR_DIAMANTE': return mineDiamond(bot)
    case 'COLETAR_COMIDA':   return gatherFood(bot)
    case 'IR_BASE':          return goToBase(bot)
    case 'SEGUIR_JOGADOR':   return followPlayer(bot)
    default:                 return randomWalk(bot)
  }
}

async function goToBase(bot: mineflayer.Bot) {
  if (!basePos) { bot.chat('Nao sei onde e a base!'); forceMission = null; return }
  try {
    await goNear(bot, basePos, 3)
    bot.chat('Cheguei na base!')
    log('[Base] Chegou na base')
    forceMission = null
  } catch (_e) { bot.chat('Nao consigo chegar na base agora.') }
}

async function followPlayer(bot: mineflayer.Bot) {
  if (!followTarget) return
  const target = Object.values(bot.entities).find((e: any) => e.type === 'player' && e.username === followTarget) as any
  if (!target) { log(`[Follow] ${followTarget} sumiu`); return }
  try { await goNear(bot, target.position, 3) } catch (_e) {}
}

// ── Modo Explorador — bússola → GUI → entra no server + testa comandos ────────
async function explorationLoop(bot: mineflayer.Bot) {
  log('[Explorar] MODO EXPLORADOR ativo — bússola → servidor → comandos')

  // Captura todo chat/system no arquivo de log
  const captured: string[] = []
  const rawCapture = (jsonMsg: any) => {
    const txt = jsonMsg.toString ? jsonMsg.toString() : JSON.stringify(jsonMsg)
    captured.push(txt)
    log(`[Explorar/Chat] ${txt}`)
  }
  bot.on('message', rawCapture)

  const cmd = async (c: string, delayMs = 2000) => {
    if (!bot.entity) return
    try { bot.chat(c) } catch (_e) {}
    await sleep(delayMs)
  }

  // ── Passo 1: aguardar login e bússola no inventário ──────────────────────────
  await sleep(3000)
  log('[Explorar] Procurando bússola no inventário...')

  // Tentar usar a bússola (activateItem) — ela fica na mão ou no inventário
  let compassUsed = false

  // Listener para GUI aberta após clicar na bússola
  const onWindow = async (window: any) => {
    if (compassUsed) return
    compassUsed = true
    await sleep(1200)
    const slots: any[] = window.slots ?? []
    log(`[Explorar] GUI aberta — ${slots.length} slots. Procurando cabeça/servidor...`)

    let clicked = false
    for (let i = 0; i < slots.length; i++) {
      const item = slots[i]
      if (!item) continue
      let display = ''
      try {
        display = typeof item.displayName === 'string'
          ? item.displayName
          : JSON.stringify(item.displayName ?? '')
      } catch (_e) { display = item.name ?? '' }
      const lore = JSON.stringify(item.customData ?? '').toLowerCase()
      const text = (display + ' ' + lore + ' ' + (item.name ?? '')).toLowerCase()

      // Procura cabeça de jogador ou qualquer item de "entrar"
      if (
        item.name?.includes('skull') || item.name?.includes('head') ||
        text.includes('entrar') || text.includes('jogar') || text.includes('play') ||
        text.includes('servidor') || text.includes('survival') || text.includes('server')
      ) {
        log(`[Explorar] Clicando slot ${i}: "${display.slice(0, 60)}" (${item.name})`)
        try {
          await bot.clickWindow(i, 0, 0)
          log('[Explorar] ✅ Clicou na cabeça/servidor! Aguardando teleporte...')
          clicked = true
        } catch (e: any) { log(`[Explorar] Erro ao clicar: ${e?.message}`) }
        break
      }
    }

    if (!clicked) {
      // Fallback: loga todos os slots para debug e clica no primeiro não-nulo
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i]
        if (!item) continue
        let display = ''
        try { display = typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName ?? '') } catch (_e) { display = item.name ?? '' }
        log(`[Explorar] Slot ${i}: ${item.name} — "${display.slice(0, 50)}"`)
      }
      // Clica no primeiro slot não-nulo
      const first = slots.findIndex(s => s != null)
      if (first >= 0) {
        log(`[Explorar] Fallback: clicando primeiro slot não-nulo (${first})`)
        try { await bot.clickWindow(first, 0, 0) } catch (_e) {}
      }
    }
  }
  bot.once('windowOpen', onWindow)

  // Tentar equipar e usar a bússola
  const compassSlot = bot.inventory.items().find((i: any) => i.name?.includes('compass'))
  if (compassSlot) {
    log(`[Explorar] Bússola encontrada no slot ${compassSlot.slot} — equipando e usando`)
    try {
      await bot.equip(compassSlot, 'hand')
      await sleep(500)
      await bot.activateItem()
      log('[Explorar] Bússola usada! Aguardando GUI...')
    } catch (e: any) {
      log(`[Explorar] Erro ao usar bússola: ${e?.message}`)
    }
  } else {
    log('[Explorar] Bússola não encontrada ainda — aguardando 3s e tentando de novo...')
    await sleep(3000)
    const compassSlot2 = bot.inventory.items().find((i: any) => i.name?.includes('compass'))
    if (compassSlot2) {
      try {
        await bot.equip(compassSlot2, 'hand')
        await sleep(500)
        await bot.activateItem()
        log('[Explorar] Bússola usada na segunda tentativa!')
      } catch (e: any) { log(`[Explorar] Bússola erro: ${e?.message}`) }
    } else {
      log('[Explorar] SEM bússola no inventário — logando todos os itens:')
      bot.inventory.items().forEach((i: any) => log(`[Explorar/Inv] ${i.name} x${i.count} slot=${i.slot}`))
      bot.removeListener('windowOpen', onWindow)
    }
  }

  // ── Passo 2: aguardar chegar no servidor (teleporte demora alguns segundos) ───
  await sleep(8000)
  log('[Explorar] --- Iniciando sequência de comandos no servidor ---')

  const comandos = [
    '/list', '/online', '/who',
    '/help', '/ajuda', '/menu',
    '/spawn', '/hub', '/lobby',
    '/warp', '/warps',
    '/rank', '/ranks', '/vip', '/loja',
    '/stats', '/perfil', '/profile',
    '/kit', '/kits',
    '/jobs', '/job',
    '/clan', '/guild', '/faccao',
    '/sethome', '/home',
    '/tp', '/tpa',
    '/discord',
    '/regras', '/rules',
    '/pvp', '/arena',
    '/mina', '/mine',
    '/eventos', '/event',
    '/missao', '/quest',
    '/economia', '/eco', '/balance', '/bal',
    '/leilao', '/auction',
    '/troca', '/trade',
    '/report',
  ]

  for (const c of comandos) {
    if (!bot.entity) break
    await cmd(c, 1600)
  }

  // Escuta passiva por mais 2 minutos
  log('[Explorar] Escuta passiva por 120s...')
  await sleep(120000)

  // Salva relatório
  const report = {
    server: HOST,
    version: VERSION,
    timestamp: new Date().toISOString(),
    chatLines: captured.length,
    messages: captured,
  }
  try { fs.writeFileSync('/tmp/exploration-report.json', JSON.stringify(report, null, 2)) } catch (_e) {}
  log(`[Explorar] Relatório salvo: ${captured.length} linhas capturadas`)
  log('[Explorar] --- FIM DA EXPLORAÇÃO ---')
}

// ── Nerdzone.gg — navegar com bússola para o Rankup ──────────────────────────
async function nerdzoneNavigate(bot: mineflayer.Bot): Promise<void> {
  log('[Nerdzone] Aguardando 4s antes de usar a bússola (warmup anti-kick)...')
  await sleep(4000)   // aguardar inventário e estado da sessão estabilizarem
  log('[Nerdzone] Usando bússola para entrar no Rankup...')
  let done = false

  const onWindow = async (window: any) => {
    if (done) return
    done = true
    await sleep(1200)
    const slots: any[] = window.slots ?? []
    log(`[Nerdzone] GUI bússola — ${slots.length} slots`)
    let clicked = false
    for (let i = 0; i < slots.length; i++) {
      const item = slots[i]
      if (!item) continue
      let display = ''
      try { display = typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName ?? '') } catch (_e) { display = item.name ?? '' }
      const lore = JSON.stringify(item.customData ?? '').toLowerCase()
      const text = (display + ' ' + lore + ' ' + (item.name ?? '')).toLowerCase()
      if (item.name?.includes('skull') || item.name?.includes('head') ||
          text.includes('entrar') || text.includes('jogar') || text.includes('rankup') ||
          text.includes('servidor') || text.includes('survival') || text.includes('play')) {
        log(`[Nerdzone] Clicando slot ${i}: "${display.slice(0, 60)}" (${item.name})`)
        try { await bot.clickWindow(i, 0, 0); clicked = true } catch (e: any) { log(`[Nerdzone] Erro: ${e?.message}`) }
        break
      }
    }
    if (!clicked) {
      slots.forEach((item, i) => { if (item) { let d=''; try { d = typeof item.displayName==='string'?item.displayName:JSON.stringify(item.displayName??'') } catch(_e){d=item.name??''} log(`[Nerdzone] Slot ${i}: ${item.name} — "${d.slice(0,50)}"`) } })
      const first = slots.findIndex(s => s != null)
      if (first >= 0) { try { await bot.clickWindow(first, 0, 0) } catch (_e) {} }
    }
    // NÃO re-ativar física aqui — só após confirmação do server switch (em nerdzoneLoop)
    done = true
  }
  bot.once('windowOpen', onWindow)

  // Tentar usar a bússola
  for (let attempt = 0; attempt < 3; attempt++) {
    const comp = bot.inventory.items().find((i: any) => i.name?.includes('compass'))
    if (comp) {
      try {
        await bot.equip(comp, 'hand')
        await sleep(400)
        await bot.activateItem()
        log('[Nerdzone] Bússola usada!')
        await sleep(5000)
        return
      } catch (e: any) { log(`[Nerdzone] Bússola erro: ${e?.message}`) }
    }
    await sleep(2500)
  }
  bot.removeListener('windowOpen', onWindow)
  log('[Nerdzone] Sem bússola — continuando sem navegar')
}

// ── Nerdzone.gg — loop de mineração na mina privada (sem pathfinder) ─────────
// Não usa goNear/pathfinder — pathfinder envia pacotes de movimento que causam
// BadPacketException no BungeeCord do nerdzone.gg após o server switch.
// Em vez disso: teleporta com /mina go, olha para blocos próximos, cava direto.
async function nerdzoneMineCycle(bot: mineflayer.Bot): Promise<void> {
  log('[Nerdzone/Mina] Indo para a mina com /mina go ...')
  try { bot.chat('/mina go') } catch (_e) {}
  await sleep(8000)   // aguardar teleport + chunk load
  if (!bot.entity) return

  const mineableNames = new Set([
    'stone','cobblestone','gravel','sand','dirt','coal_ore','iron_ore','gold_ore',
    'diamond_ore','emerald_ore','redstone_ore','lapis_ore','copper_ore','deepslate',
    'netherrack','basalt','blackstone','nether_gold_ore','quartz_ore','glowstone',
    'obsidian','end_stone','purpur_block','magma_block','terracotta',
    'deepslate_coal_ore','deepslate_iron_ore','deepslate_gold_ore','deepslate_diamond_ore',
    'deepslate_emerald_ore','deepslate_redstone_ore','deepslate_lapis_ore','deepslate_copper_ore',
  ])

  let blocksMinedThisCycle = 0
  const spawnPos = bot.entity.position.floored()
  log(`[Nerdzone/Mina] Pos pós-teleport: ${spawnPos.x},${spawnPos.y},${spawnPos.z}`)

  // Debug ampliado: checar TODOS os blocos em raio 20, incluindo abaixo (dy=-20)
  const nearbyBlocks = new Map<string, number>()
  for (let dx = -20; dx <= 20; dx++) {
    for (let dy = -20; dy <= 5; dy++) {
      for (let dz = -20; dz <= 20; dz++) {
        try {
          const b = bot.blockAt(new (require('vec3'))(spawnPos.x+dx, spawnPos.y+dy, spawnPos.z+dz) as any)
          if (b && b.name !== 'air') nearbyBlocks.set(b.name, (nearbyBlocks.get(b.name) ?? 0) + 1)
        } catch (_e) {}
      }
    }
  }
  const topBlocks = [...nearbyBlocks.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([n,c])=>`${n}x${c}`).join(', ')
  log(`[Nerdzone/Mina] Blocos detectados (raio 20, dy-20..+5): ${topBlocks || 'nenhum'}`)

  // Usar findBlock para buscar o bloco minerável mais próximo (sem limite de dy)
  // Raio 20 em esfera — muito mais eficiente que loop manual
  const mineableFilter = (block: any) => block && (
    mineableNames.has(block.name) ||
    block.name.includes('ore') || block.name.includes('stone') ||
    block.name.includes('dirt') || block.name.includes('sand') ||
    block.name.includes('gravel') || block.name.includes('deepslate') ||
    block.name.includes('terracotta') || block.name.includes('netherrack')
  )

  // Cavar até 200 blocos por ciclo ou até não encontrar mais
  for (let i = 0; i < 200; i++) {
    if (!bot.entity) return
    const block = bot.findBlock({ matching: mineableFilter, maxDistance: 5 })
    if (!block) {
      log(`[Nerdzone/Mina] Sem blocos no raio 5 após ${blocksMinedThisCycle} minerados`)
      break
    }
    try {
      try { await withTimeout(bot.lookAt(block.position.offset(0.5, 0.5, 0.5)), 800, 'lookAt') } catch (_e) {}
      if (!bot.entity) return
      await withTimeout(bot.dig(block), 5000, 'digBlock')
      blocksMinedThisCycle++
    } catch (_e) {}
  }

  log(`[Nerdzone/Mina] Ciclo concluído — ${blocksMinedThisCycle} blocos minerados`)

  // Aguardar antes de resetar
  if (bot.entity) {
    const waitMs = blocksMinedThisCycle < 3 ? 12000 : 5000
    await sleep(waitMs)
    if (bot.entity) {
      log('[Nerdzone/Mina] Resetando mina...')
      try { bot.chat('/resetar') } catch (_e) {}
      await sleep(10000)   // aguardar regeneração da mina
    }
  }
}

// ── Nerdzone.gg — loop autônomo principal ─────────────────────────────────────
let nerdzoneMsgIndex = 0
const NERDZONE_CHAT_OPENERS = [
  'alguem pode me explicar como rankear mais rapido aqui?',
  'qual o melhor item pra comprar no leilao agora?',
  'quanto vale um key de ouro hoje?',
  'alguem tem picareta boa pra alugar? to começando',
  'essa economia do servidor ta boa, muita gente online',
  'como funciona o sistema de clan aqui?',
  'qual vip vale mais a pena comprar?',
  'to na mina agora, alguem sabe o que da mais tokens?',
  'o /explorar vale a pena ir?',
  'boa tarde galera, novo aqui kkk',
  'quanto vc ganha por ciclo de mina?',
  'evento de brainrots ainda ativo?',
  'tem alguma guild recrutando?',
  'alguem me ensina a usar o /leilao?',
]

async function nerdzoneLoop(bot: mineflayer.Bot) {
  log('[Nerdzone] ★ Modo autônomo Rankup iniciado!')

  // 1) Tentar trocar de servidor via comando direto (mais estável que GUI)
  //    Se não funcionar, usa a bússola como fallback
  log('[Nerdzone] Tentando trocar de servidor via comando...')
  let switchedViaCommand = false
  const switchCmds = ['/servidor rankup', '/server rankup', '/ir rankup', '/rankup', '/play rankup', '/join rankup']
  for (const cmd of switchCmds) {
    if (!bot.entity) break
    try { bot.chat(cmd) } catch (_e) {}
    await sleep(2500)
    // Se a posição mudou (saiu do hub spawn 0,107,6), o switch funcionou
    if (bot.entity) {
      const p = bot.entity.position
      if (Math.abs(p.y - 107) > 5 || Math.abs(p.x) > 10) {
        log(`[Nerdzone] Switch via comando "${cmd}" aparenta ter funcionado (pos: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`)
        switchedViaCommand = true
        break
      }
    }
  }

  if (!switchedViaCommand) {
    // 1b) Fallback: usar bússola (GUI)
    log('[Nerdzone] Comandos não funcionaram — usando bússola...')
    await nerdzoneNavigate(bot)
  }

  // Re-ativar física AGORA (após switch, não dentro de onWindow)
  // O BadPacketException do BungeeCord só acontece durante a conexão inicial ao hub
  await sleep(3000)
  if (!bot.entity) return
  try { (bot as any).physicsEnabled = true; log('[Nerdzone] Física re-ativada pós server-switch') } catch (_e) {}
  await sleep(3000)
  if (!bot.entity) return

  // 2) Pegar picareta e plot se ainda não tem
  try { bot.chat('/picareta') } catch (_e) {}
  await sleep(2000)
  try { bot.chat('/p auto') } catch (_e) {}
  await sleep(2000)

  // 3) Anunciar entrada de forma natural
  const aiProvider = getActiveProvider()
  const intro = await askAI(`Você é ${BOT_NAME}, um jogador de Minecraft acabando de entrar no servidor Rankup do nerdzone.gg. Escreva UMA mensagem de 1 linha (max 80 chars) para o chat do servidor, em português informal brasileiro, apresentando você ou comentando sobre o servidor. Nada de emojis excessivos.`)
  if (intro && bot.entity) { bot.chat(intro.substring(0, 100)); log(`[Nerdzone/Chat] ${intro}`) }
  await sleep(3000)

  // 4) Loop principal
  let lastChatTime    = Date.now()
  let lastEconTime    = 0
  let lastRankTime    = 0
  let lastLeilaoTime  = 0
  let lastWarpsTime   = 0
  let mineCount       = 0

  while (bot.entity) {
    try {
      // Checar comandos de economia a cada 3 min
      if (Date.now() - lastEconTime > 180000) {
        lastEconTime = Date.now()
        try { bot.chat('/tokens') } catch (_e) {}
        await sleep(2000)
        try { bot.chat('/money') } catch (_e) {}
        await sleep(1500)
      }

      // Checar rank a cada 8 min
      if (Date.now() - lastRankTime > 480000) {
        lastRankTime = Date.now()
        try { bot.chat('/prestigio') } catch (_e) {}
        await sleep(2000)
        try { bot.chat('/boosters') } catch (_e) {}
        await sleep(1500)
      }

      // Ver leilão a cada 10 min
      if (Date.now() - lastLeilaoTime > 600000) {
        lastLeilaoTime = Date.now()
        try { bot.chat('/leilao') } catch (_e) {}
        await sleep(2500)
        // Fechar janela se abriu
        try { await bot.closeWindow((bot as any).currentWindow) } catch (_e) {}
      }

      // Ver warps a cada 15 min
      if (Date.now() - lastWarpsTime > 900000) {
        lastWarpsTime = Date.now()
        try { bot.chat('/warps') } catch (_e) {}
        await sleep(2000)
        try { await bot.closeWindow((bot as any).currentWindow) } catch (_e) {}
        try { bot.chat('/duvidas') } catch (_e) {}
        await sleep(2000)
        try { await bot.closeWindow((bot as any).currentWindow) } catch (_e) {}
      }

      // Chat social com IA a cada 2-5 minutos
      const chatInterval = 120000 + Math.random() * 180000
      if (Date.now() - lastChatTime > chatInterval) {
        lastChatTime = Date.now()
        const p = bot.entity.position
        const inv = bot.inventory.items().slice(0, 6).map((i: any) => `${i.name}x${i.count}`).join(', ')
        const opener = NERDZONE_CHAT_OPENERS[nerdzoneMsgIndex % NERDZONE_CHAT_OPENERS.length]
        nerdzoneMsgIndex++
        const aiMsg = await askAI(
          `Você é ${BOT_NAME}, jogador de Minecraft no servidor Rankup nerdzone.gg. ` +
          `Inv: ${inv || 'vazio'}. Pos: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}. ` +
          `Ciclos de mina feitos: ${mineCount}. Prompt de inspiração: "${opener}". ` +
          `Escreva UMA mensagem curta (max 100 chars) para o chat global do servidor em português brasileiro informal. ` +
          `Pode ser uma pergunta, comentário sobre economia, piada, ou interação social. Sem emojis excessivos.`
        )
        if (aiMsg && bot.entity) {
          bot.chat(aiMsg.substring(0, 100))
          log(`[Nerdzone/Chat] ${aiMsg}`)
        }
        await sleep(1000)
      }

      // Ciclo principal: ir à mina e minerar
      await nerdzoneMineCycle(bot)
      mineCount++

      // Auto-comer
      if (bot.food < 16 && bot.entity) await tryEat(bot)

    } catch (e: any) {
      log(`[Nerdzone/Erro] ${e?.message || String(e)}`)
      await sleep(3000)
    }
  }
  log('[Nerdzone] Loop encerrado — bot desconectado')
}

// ── Loop Principal ─────────────────────────────────────────────────────────────
async function actionLoop(bot: mineflayer.Bot) {
  log('[Loop] Iniciando!')
  let combatCooldown = 0

  while (bot.entity) {
    try {
      // 1. Auto-comer quando fome baixa
      if (bot.food < 16) await tryEat(bot)

      // 2. Auto-equipar armadura periodicamente
      if (Date.now() % 10000 < 500) await autoEquipArmor(bot)

      // 3. Escapar da água
      if (isInWater(bot)) {
        log('[Loop] Agua!')
        await withTimeout(escapeWater(bot), 12000, 'escapeWater')
        await sleep(300)
        continue
      }

      // 4. Combate inteligente
      const hostile = getNearestHostile(bot, 8) as any
      if (hostile) {
        if (shouldFlee(bot, hostile)) {
          log(`[PVP] Fugindo de ${hostile.name} (HP:${Math.floor(bot.health)})`)
          await withTimeout(fleeFromMob(bot, hostile), 8000, 'flee')
          combatCooldown = Date.now() + 5000
        } else if (Date.now() > combatCooldown) {
          await withTimeout(fightMob(bot, hostile), 5000, 'fight')
        }
        await sleep(400)
        continue
      }

      // 5. Heal after combat
      if (bot.health < 18 && bot.food >= 18) await tryEat(bot)

      // 6. Decidir e executar missão
      const m = decideMission(bot)
      if (m !== currentMission || Date.now() - lastAnnounce > 90000) {
        currentMission = m
        lastAnnounce = Date.now()
        log(`[Missao] ${MISSION_DESC[m]}`)
        bot.chat(`>> Missao: ${MISSION_DESC[m]}`)
        // Craft when transitioning missions
        if (m !== 'COLETAR_MADEIRA') await withTimeout(tryBasicCraft(bot), 15000, 'craft')
      }

      await withTimeout(runMission(bot, m), 30000, m)
      await sleep(200)

    } catch (e: any) {
      log(`[Erro] ${e?.message || String(e)}`)
      await sleep(1500)
    }
  }
  log('[Loop] Fim.')
}

// ── Chat de IA em Background ──────────────────────────────────────────────────
async function bgAILoop() {
  // Nerdzone tem seu próprio chat loop integrado no nerdzoneLoop
  if (NERDZONE_MODE) return
  await sleep(35000)
  while (true) {
    await sleep(30000)
    const bot = botRef
    if (!bot?.entity) continue
    const p = bot.entity.position
    const inv = bot.inventory.items().slice(0,8).map((i: any) => `${i.name}x${i.count}`).join(', ')
    const aiProvider = getActiveProvider()
    const providerName = aiProvider?.name || 'nenhuma'
    const prompt = `Você é EzBot_IA, bot autônomo de Minecraft. IA ativa: ${providerName}. Missao: "${MISSION_DESC[currentMission]}". HP: ${Math.floor(bot.health)}/20. Fome: ${bot.food}/20. Pos: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}. Inv: ${inv}. Escreva UMA frase curta (max 120 chars) engraçada em português sobre o que está fazendo agora:`
    const reply = await askAI(prompt)
    if (reply && bot) { bot.chat(reply.substring(0, 120)); log(`[AI-Chat] ${reply}`) }
  }
}

// ── Relatório a cada 5 minutos ─────────────────────────────────────────────────
async function statusReporter(bot: mineflayer.Bot) {
  while (bot.entity) {
    await sleep(5 * 60 * 1000)
    if (!bot.entity) break
    const elapsed = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
    const p = bot.entity.position
    const aiProvider = getActiveProvider()
    const rpt = [
      `━━━ Relatorio ${new Date().toLocaleString('pt-BR')} ━━━`,
      `Tempo online: ${elapsed} min | IA ativa: ${aiProvider?.name || 'nenhuma'}`,
      `Missao: ${MISSION_DESC[currentMission]}`,
      `Pos: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} | HP: ${Math.floor(bot.health)} | Fome: ${bot.food}`,
      `Madeira:${stats.woodCollected} Pedra:${stats.stoneCollected} Ferro:${stats.ironCollected} Diamante:${stats.diamondCollected}`,
      `Mobs mortos:${stats.mobsKilled} | Mortes:${stats.deaths}`,
    ].join('\n')
    log(rpt)
    bot.chat(`[${elapsed}min] ${MISSION_DESC[currentMission]} | HP:${Math.floor(bot.health)} | Madeira:${stats.woodCollected} Pedra:${stats.stoneCollected} Ferro:${stats.ironCollected} Diamante:${stats.diamondCollected}`)
  }
}

// ── Comandos de Chat ──────────────────────────────────────────────────────────
async function handleCommand(bot: mineflayer.Bot, username: string, msg: string) {
  const cmd = msg.trim().toLowerCase()
  const args = msg.trim().split(' ')

  // !ajuda
  if (cmd === '!ajuda' || cmd === '!help') {
    bot.chat('Comandos: !status !missao !inv !pos !seguir !vir !base !parar !dormir !craft !minerar !falar <texto> !ia !ajuda')
    return
  }

  // !status
  if (cmd === '!status') {
    const elapsed = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
    const p = bot.entity.position
    const ai = getActiveProvider()
    bot.chat(`[${elapsed}min] ${MISSION_DESC[currentMission]} | HP:${Math.floor(bot.health)} Fome:${bot.food} | Pos:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} | IA:${ai?.name||'N/A'}`)
    return
  }

  // !missao
  if (cmd === '!missao') { bot.chat(`Missao: ${MISSION_DESC[currentMission]}`); return }

  // !inv
  if (cmd === '!inv') {
    const items = bot.inventory.items().map((i: any) => `${i.name}x${i.count}`).join(', ') || 'vazio'
    bot.chat(`Inv: ${items.substring(0, 220)}`)
    return
  }

  // !pos
  if (cmd === '!pos') {
    const p = bot.entity.position
    bot.chat(`Pos: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
    return
  }

  // !ia — mostra qual IA está ativa
  if (cmd === '!ia') {
    const ai = getActiveProvider()
    const status = AI_PROVIDERS.map(p => `${p.name}:${p.key ? (p.exhaustedUntil > Date.now() ? 'esgotada' : 'ok') : 'sem chave'}`).join(' ')
    bot.chat(`IA ativa: ${ai?.name || 'nenhuma'} | ${status}`)
    return
  }

  // !parar
  if (cmd === '!parar') {
    followTarget = null; forceMission = null
    bot.pathfinder.stop()
    bot.chat('Parei! Aguardando...')
    return
  }

  // !seguir [player]
  if (args[0] === '!seguir') {
    const target = args[1] || username
    followTarget = target
    forceMission = 'SEGUIR_JOGADOR'
    bot.chat(`Ok! Seguindo ${target}`)
    log(`[Cmd] Seguir: ${target}`)
    return
  }

  // !vir — vir até quem digitou
  if (cmd === '!vir') {
    const player = Object.values(bot.entities).find((e: any) => e.type === 'player' && e.username === username) as any
    if (!player) { bot.chat(`Nao te vejo, ${username}!`); return }
    bot.chat(`Indo ate voce, ${username}!`)
    withTimeout(goNear(bot, player.position, 3), 20000, 'vir').then(() => bot.chat('Cheguei!')).catch(() => {})
    return
  }

  // !base — salvar posição atual como base ou ir para base
  if (cmd === '!base') {
    if (!basePos) {
      basePos = bot.entity.position.floored()
      bot.chat(`Base salva em ${basePos.x} ${basePos.y} ${basePos.z}!`)
      log(`[Base] Salva: ${JSON.stringify(basePos)}`)
    } else {
      forceMission = 'IR_BASE'
      bot.chat(`Indo para a base em ${basePos.x} ${basePos.y} ${basePos.z}!`)
    }
    return
  }

  // !salvarbase — força salvar posição atual como base
  if (cmd === '!salvarbase') {
    basePos = bot.entity.position.floored()
    bot.chat(`Nova base salva: ${basePos.x} ${basePos.y} ${basePos.z}`)
    return
  }

  // !dormir
  if (cmd === '!dormir') { await trySleep(bot); return }

  // !craft
  if (cmd === '!craft') {
    bot.chat('Tentando craftar itens essenciais...')
    await tryBasicCraft(bot)
    bot.chat('Feito!')
    return
  }

  // !minerar [bloco]
  if (args[0] === '!minerar') {
    const target = args[1] || 'diamond_ore'
    const block = bot.findBlock({ matching: (b: any) => b?.name?.includes(target), maxDistance: 64 })
    if (!block) { bot.chat(`Nao achei ${target} perto!`); return }
    bot.chat(`Indo minerar ${target}...`)
    withTimeout((async () => {
      await goNear(bot, block.position, 2)
      await bot.dig(block)
      bot.chat(`Minerou ${target}!`)
    })(), 25000, 'minerar').catch(() => {})
    return
  }

  // !falar <texto>
  if (args[0] === '!falar') {
    const question = args.slice(1).join(' ')
    bot.chat('Pensando...')
    const reply = await askAI(`Você é EzBot_IA, bot de Minecraft. Responda em max 120 chars em português: ${question}`)
    bot.chat(reply?.substring(0, 120) || 'Nao consigo responder agora!')
    return
  }

  // !hp [mob] — consultar HP de um mob
  if (args[0] === '!hp') {
    const mobName = args[1]?.toLowerCase()
    if (!mobName) {
      bot.chat(`Meu HP: ${Math.floor(bot.health)}/20 | Fome: ${bot.food}/20`)
      return
    }
    const key = Object.keys(MOB_HP).find(k => k.includes(mobName) || mobName.includes(k))
    if (key) bot.chat(`${key}: ${MOB_HP[key]} HP | Dano: ${MOB_DAMAGE[key] || '?'}/hit`)
    else bot.chat(`Nao sei o HP de ${mobName}`)
    return
  }
}

// ── Inicialização do Bot ───────────────────────────────────────────────────────
function createBot() {
  log(`[Bot] Conectando ${HOST}:${PORT}...`)
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_NAME, version: VERSION, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  botRef = null

  bot.once('spawn', async () => {
    log('[Bot] Conectado!')
    reconnectDelay = 5000
    botRef = bot
    sessionStart = new Date()

    // Salvar spawn como base inicial
    basePos = bot.entity.position.floored()
    log(`[Spawn] Base inicial: ${basePos.x} ${basePos.y} ${basePos.z}`)

    const move = new Movements(bot)
    move.allowSprinting = true
    move.canDig = true
    move.allowParkour = true
    bot.pathfinder.setMovements(move)

    if (EXPLORE_MODE) {
      log('[Explorar] Modo explorador ativo — ignorando actionLoop')
      explorationLoop(bot)
      return
    }

    if (NERDZONE_MODE) {
      // Desabilitar física imediatamente — pacotes de posição causam BadPacketException
      // no BungeeCord do nerdzone.gg logo após spawn
      try { (bot as any).physicsEnabled = false } catch (_e) {}
      log('[Nerdzone] Física desativada para evitar BadPacketException no BungeeCord')
      log('[Nerdzone] Servidor nerdzone.gg detectado — iniciando modo Rankup autônomo!')
      nerdzoneLoop(bot)
      return
    }

    const aiProvider = getActiveProvider()
    bot.chat(`EzBot_IA v4 online! IA: ${aiProvider?.name || 'Sem IA'}. Objetivo: matar o Ender Dragon!`)
    await sleep(2000)

    await autoEquipArmor(bot)
    actionLoop(bot)
    statusReporter(bot)
  })

  bot.on('chat', async (username: string, msg: string) => {
    if (username === bot.username) return
    log(`[Chat] ${username}: ${msg}`)
    if (msg.startsWith('!')) await handleCommand(bot, username, msg)
  })

  bot.on('health', async () => {
    // Auto-eat on critical health
    if (bot.health > 0 && bot.health < 6) {
      bot.pathfinder.stop()
      await tryEat(bot)
    }
  })

  bot.on('entityDead', (e: any) => {
    if (isHostileName(e.name)) { stats.mobsKilled++; log(`[Kill] ${e.name} (total: ${stats.mobsKilled})`) }
  })

  bot.on('death', () => {
    stats.deaths++
    log(`[Morte #${stats.deaths}] Morreu!`)
    followTarget = null; forceMission = null
  })

  // ── Resource Pack Auto-Accept ────────────────────────────────────────────────
  // Essencial para servidores com resource pack obrigatório (ex: factionsmatrix.com)
  // Sem isso o servidor pode dar kick antes do bot agir
  // @ts-ignore — resource_pack_send não está nos tipos mas existe em mineflayer
  bot.on('resource_pack_send', async (url: string) => {
    log(`[ResourcePack] Pack detectado: ${url.substring(0, 80)}`)
    log('[ResourcePack] Aceitando automaticamente para evitar kick...')
    bot.chat('Baixando resource pack, aguarde...')
    bot.acceptResourcePack()
    await sleep(3000)
    log('[ResourcePack] Resource pack aceito! Continuando...')
  })

  // ── Sistema Anti-Queda ───────────────────────────────────────────────────────
  // Monitora velocidade vertical; para pathfinder se queda causar dano fatal
  let lastSafeY = 64
  let fallStartY = -1
  bot.on('physicsTick', () => {
    if (!bot.entity) return
    const pos = bot.entity.position
    const vy  = (bot.entity as any).velocity?.y ?? 0
    if (bot.entity.onGround) {
      lastSafeY  = pos.y
      fallStartY = -1
      return
    }
    // Detectar início de queda
    if (vy < -0.2 && fallStartY < 0) fallStartY = pos.y
    // Se caiu mais de 22 blocos (dano de queda começa em 23+), parar ação
    if (fallStartY > 0 && (fallStartY - pos.y) > 22) {
      bot.pathfinder.stop()
      log(`[AntiFall] Queda crítica detectada de Y:${Math.floor(fallStartY)} → Y:${Math.floor(pos.y)}. Pathfinder parado!`)
      fallStartY = -1
    }
    // Teleportar de volta à base se travar caindo no void
    if (pos.y < -60) {
      log('[AntiFall] Void detectado! Tentando voltar à superfície...')
      bot.chat('Caí no void! Procurando saída...')
      if (basePos) {
        try { bot.pathfinder.setGoal(new PF.GoalBlock(basePos.x, basePos.y, basePos.z)) } catch (_e) {}
      }
    }
  })

  // ── State File — escreve estado para API do radar ────────────────────────────
  const stateInterval = setInterval(() => {
    if (!botRef?.entity) return
    const pos = botRef.entity.position
    // Scan 21x21 block grid ao redor do bot para o mini-mapa (bloco abaixo dos pés)
    const mapBlocks: Record<string, string> = {}
    try {
      const bp = botRef.entity.position.floored()
      for (let dx = -10; dx <= 10; dx++) {
        for (let dz = -10; dz <= 10; dz++) {
          const b = botRef.blockAt({ x: bp.x + dx, y: bp.y - 1, z: bp.z + dz } as any)
          if (b && b.name !== 'air') mapBlocks[`${dx},${dz}`] = b.name
        }
      }
    } catch (_e) {}

    const state = {
      online: true,
      name: BOT_NAME,
      health: Math.round(botRef.health * 10) / 10,
      food: botRef.food,
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      posStr: `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`,
      mission: currentMission,
      missionDesc: MISSION_DESC[currentMission],
      stats: { ...stats },
      aiProvider: getActiveProvider()?.name || null,
      inventory: botRef.inventory.items().map((i: any) => ({ name: i.name, count: i.count })),
      mapBlocks,
      timestamp: Date.now(),
    }
    try { fs.writeFileSync('/tmp/bot-state.json', JSON.stringify(state)) } catch (_e) {}
  }, 3000)

  let didReconnect = false  // evita double-reconnect (kicked + end disparam juntos)
  bot.on('kicked', (r: any) => {
    const msg = typeof r === 'string' ? r : JSON.stringify(r)
    log(`[Kick] ${msg}`)
    clearInterval(stateInterval)
    writeOfflineState()
    botRef = null
    if (!didReconnect) { didReconnect = true; scheduleReconnect() }
  })
  bot.on('error', (e: Error) => log(`[Erro] ${e.message}`))
  bot.on('end', () => {
    log('[Desconectado]')
    clearInterval(stateInterval)
    writeOfflineState()
    botRef = null
    if (!didReconnect) { didReconnect = true; scheduleReconnect() }
  })

  // ════════════════════════════════════════════════════════════════════════════
  // RADAR DE EXTRAÇÃO — módulo isolado, não altera nenhuma funcionalidade acima
  // Fluxo: AuthMe login → bloco verde → /mina → ouvir coords no chat
  // ════════════════════════════════════════════════════════════════════════════

  const RADAR_FILE    = '/tmp/radar-coords.json'
  const BOT_PASS      = process.env.BOT_PASSWORD || 'EzBot2025!'
  let radarAuthed     = false   // true após login AuthMe confirmado
  let radarMinaDone   = false   // true após entrar no mundo de extração

  /** Adiciona coordenadas ao arquivo compartilhado com a API (RAM: /tmp) */
  function writeRadarCoord(player: string, x: number, y: number, z: number) {
    let data: { players: any[] } = { players: [] }
    try { data = JSON.parse(fs.readFileSync(RADAR_FILE, 'utf8')) } catch (_e) {}
    // Atualiza entrada existente ou insere nova (deduplicado por nick)
    data.players = [
      { player, x, y, z, timestamp: Date.now() },
      ...data.players.filter((p: any) => p.player !== player),
    ].slice(0, 100)
    try { fs.writeFileSync(RADAR_FILE, JSON.stringify(data)) } catch (_e) {}
    log(`[Radar] 📍 ${player} @ ${x},${y},${z}`)
  }

  /** Depois do login: tenta clicar no bloco verde e executar /mina */
  async function radarEntrySequence() {
    if (radarMinaDone) return
    log('[Radar/Entry] Aguardando lobby carregar...')
    await sleep(3500)

    // Tenta clicar no bloco verde de entrada (slime, emerald, lime*)
    const GREEN = ['emerald_block', 'slime_block', 'lime_concrete', 'lime_wool', 'lime_terracotta', 'lime_stained_glass']
    const entryBlock = bot.findBlock({ matching: (b: any) => GREEN.includes(b?.name), maxDistance: 30 })
    if (entryBlock) {
      try {
        await goNear(bot, entryBlock.position, 3)
        await bot.activateBlock(entryBlock)
        log('[Radar/Entry] ✅ Bloco de entrada clicado!')
        await sleep(2500)
      } catch (e: any) { log(`[Radar/Entry] Bloco: ${e?.message}`) }
    } else {
      log('[Radar/Entry] Bloco verde não encontrado na área — indo direto para /mina')
    }

    bot.chat('/mina')
    log('[Radar] /mina executado — aguardando GUI do mundo...')
  }

  /** Listener de TODAS as mensagens do servidor (system, broadcast, AuthMe, etc.) */
  bot.on('message', async (jsonMsg: any) => {
    const plain = jsonMsg.toString().replace(/§[0-9a-fklmnor]/gi, '').trim()

    // ── [Conta original?] Detectar botão [Não] clicável no chat ──────────────
    try {
      const extras: any[] = (jsonMsg.json?.extra ?? []).concat(jsonMsg.json?.with ?? [])
      for (const part of extras) {
        if (!part?.text) continue
        if (/n[aã]o/i.test(String(part.text)) && part?.clickEvent?.action === 'run_command') {
          log(`[Radar/Conta] Clicando [Não] pirata → ${part.clickEvent.value}`)
          setTimeout(() => bot.chat(part.clickEvent.value), 800)
          return
        }
      }
    } catch (_e) {}

    // ── AuthMe: pedido de registro ────────────────────────────────────────────
    if (!radarAuthed && (plain.includes('/registrar') || /registre/i.test(plain))) {
      log('[Radar/Auth] Detectado pedido de REGISTRO — /registrar em 2.5s...')
      setTimeout(() => bot.chat(`/registrar ${BOT_PASS} ${BOT_PASS}`), 2500)
      return
    }

    // ── AuthMe: pedido de login ────────────────────────────────────────────────
    if (!radarAuthed && (plain.includes('/logar') || (plain.toLowerCase().includes('login') && plain.toLowerCase().includes('comando')))) {
      log('[Radar/Auth] Detectado pedido de LOGIN — /logar em 2.5s...')
      setTimeout(() => bot.chat(`/logar ${BOT_PASS}`), 2500)
      return
    }

    // ── Login confirmado (AuthMe envia "autenticado" ou "bem-vindo") ──────────
    if (!radarAuthed && (/autenticado|logado|bem.vindo/i.test(plain))) {
      radarAuthed = true
      log('[Radar/Auth] ✅ Login confirmado! Iniciando entrada no mundo...')
      radarEntrySequence().catch((e: any) => log(`[Radar/Entry] ${e?.message}`))
      return
    }

    // ── Coordenadas de extração ───────────────────────────────────────────────
    // Padrão: [Extração] PlayerNome foi marcado no mundo de extração! (+499, 52, 678)
    const cm = plain.match(/\[Extra[çc][ãa]o\][^\w]*([A-Za-z0-9_]{2,16})[^\d([]+[\(\[]?([+-]?\d+)[,\s]+\d+[,\s]+([+-]?\d+)/i)
    if (cm) {
      const [, player, x, z] = cm
      // Tenta capturar Y também
      const full = plain.match(/([+-]?\d+)[,\s]+(\d+)[,\s]+([+-]?\d+)/)
      const y = full ? parseInt(full[2]) : 64
      writeRadarCoord(player, parseInt(x), y, parseInt(z))
    }
  })

  /** Selecionar mundo "Dia" (sem PvP) no menu do /mina — apenas factionsmatrix */
  bot.on('windowOpen', async (window: any) => {
    if (NERDZONE_MODE || radarMinaDone || !window) return
    await sleep(1400)
    const slots: any[] = window.slots ?? []
    log(`[Radar/Mina] GUI detectada — ${slots.length} slots`)

    for (let i = 0; i < slots.length; i++) {
      const item = slots[i]
      if (!item) continue
      // Tenta ler displayName (pode ser objeto JSON ou string)
      let display = ''
      try {
        display = typeof item.displayName === 'string'
          ? item.displayName
          : JSON.stringify(item.displayName ?? '')
      } catch (_e) { display = item.name ?? '' }
      const lore = JSON.stringify(item.customData ?? '').toLowerCase()
      const text  = (display + ' ' + lore).toLowerCase()

      if (text.includes('dia') || text.includes('pvp') || text.includes('extra')) {
        log(`[Radar/Mina] Selecionando slot ${i}: "${display.slice(0, 50)}"`)
        try {
          await bot.clickWindow(i, 0, 0)
          radarMinaDone = true
          log('[Radar/Mina] ✅ Mundo de extração selecionado! Radar ativo.')
        } catch (e: any) { log(`[Radar/Mina] Erro no clique: ${e?.message}`) }
        return
      }
    }

    // Fallback: tentar slot 0 ou 4
    const fallback = slots[0] ? 0 : (slots[4] ? 4 : -1)
    if (fallback >= 0) {
      log(`[Radar/Mina] Fallback: clicando slot ${fallback}`)
      try { await bot.clickWindow(fallback, 0, 0); radarMinaDone = true } catch (_e) {}
    }
  })

  // ════════════════════════════════════════════════════════════════════════════

  return bot
}

function writeOfflineState() {
  try {
    fs.writeFileSync('/tmp/bot-state.json', JSON.stringify({
      online: false, name: BOT_NAME, reason: 'Desconectado', timestamp: Date.now()
    }))
  } catch (_e) {}
}

// ── Reconexão Progressiva ─────────────────────────────────────────────────────
// Padrão: Imediato → 3 min → 7 horas → 24 horas (evitar ban por flood de conexão)
const RECONNECT_SEQUENCE = [0, 3 * 60 * 1000, 7 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]
let reconnectAttempt = 0

function scheduleReconnect() {
  const delay = RECONNECT_SEQUENCE[Math.min(reconnectAttempt, RECONNECT_SEQUENCE.length - 1)]
  reconnectAttempt++
  if (delay === 0) {
    log(`[Reconectar] Tentativa ${reconnectAttempt} — imediata`)
    createBot()
  } else {
    const label = delay < 3600000 ? `${delay / 60000}min` : `${delay / 3600000}h`
    log(`[Reconectar] Tentativa ${reconnectAttempt} — em ${label}`)
    setTimeout(createBot, delay)
  }
}

// ── Sistema de Email ──────────────────────────────────────────────────────────
const EMAIL_TO   = 'ttooeasycraft@gmail.com'
const EMAIL_FROM = 'ttooeasycraft@gmail.com'
const SMTP_PASS  = process.env.EMAIL_SMTP_PASS

// Lê as últimas N linhas do log
function readLastLogLines(n: number): string {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.trim().split('\n')
    return lines.slice(-n).join('\n')
  } catch (_e) { return '(sem logs disponíveis)' }
}

// Gera mini-mapa ASCII dos blocos ao redor do bot
function generateMiniMap(bot: mineflayer.Bot): string {
  try {
    if (!bot?.entity) return '(bot offline)'
    const pos = bot.entity.position.floored()
    const radius = 8
    let map = ''
    for (let z = pos.z - radius; z <= pos.z + radius; z += 2) {
      let row = ''
      for (let x = pos.x - radius; x <= pos.x + radius; x += 2) {
        if (x === pos.x && z === pos.z) { row += '🤖'; continue }
        try {
          const block = bot.blockAt(new (require('vec3'))(x, pos.y, z))
          const below = bot.blockAt(new (require('vec3'))(x, pos.y - 1, z))
          if (!block || block.name === 'air') {
            if (below && below.name !== 'air') row += '🟩'
            else row += '⬛'
          } else {
            const n = block.name
            if (n.includes('water')) row += '🟦'
            else if (n.includes('log') || n.includes('wood')) row += '🌲'
            else if (n.includes('stone') || n.includes('cobble')) row += '🔲'
            else if (n.includes('ore')) row += '💎'
            else row += '🟫'
          }
        } catch (_e) { row += '❓' }
      }
      map += row + '\n'
    }
    return map
  } catch (_e) { return '(minimap indisponível)' }
}

async function sendDailyEmail(bot: mineflayer.Bot | null) {
  if (!SMTP_PASS) { log('[Email] Sem senha SMTP configurada'); return }

  const now = new Date()
  const elapsed = Math.floor((now.getTime() - sessionStart.getTime()) / 60000)
  const pos = bot?.entity?.position
  const posStr = pos ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : 'desconhecido'
  const aiProvider = getActiveProvider()
  const inv = bot ? bot.inventory.items().map((i: any) => `<tr><td>${i.name}</td><td>${i.count}</td></tr>`).join('') : ''
  const miniMap = bot?.entity ? generateMiniMap(bot) : '(offline)'
  const lastLogs = readLastLogLines(50)
  const missionPct = Math.min(100, Math.round(
    (stats.woodCollected / 32) * 20 +
    (stats.stoneCollected / 48) * 20 +
    (stats.ironCollected / 24) * 20 +
    (stats.diamondCollected / 6) * 20 +
    20 // base
  ))

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; margin: 0; padding: 20px; }
  .card { background: #16213e; border-radius: 12px; padding: 20px; margin: 12px 0; border: 1px solid #0f3460; }
  h1 { color: #00d4ff; margin: 0 0 4px; font-size: 24px; }
  h2 { color: #00d4ff; font-size: 16px; margin: 0 0 12px; border-bottom: 1px solid #0f3460; padding-bottom: 8px; }
  .badge { display: inline-block; background: #0f3460; padding: 4px 10px; border-radius: 20px; font-size: 12px; margin: 3px; }
  .badge.green { background: #1a4731; color: #4ade80; }
  .badge.red { background: #4a1a1a; color: #f87171; }
  .badge.blue { background: #1a2a4a; color: #60a5fa; }
  .stat { display: inline-block; text-align: center; margin: 8px 12px; }
  .stat .num { font-size: 32px; font-weight: bold; color: #00d4ff; }
  .stat .lbl { font-size: 11px; color: #888; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 10px; text-align: left; border-bottom: 1px solid #0f3460; font-size: 13px; }
  th { color: #00d4ff; font-size: 12px; }
  .progress { background: #0f3460; border-radius: 10px; height: 18px; overflow: hidden; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, #00d4ff, #7c3aed); border-radius: 10px; transition: width 0.3s; }
  pre { background: #0f3460; padding: 12px; border-radius: 8px; font-size: 11px; overflow-x: auto; color: #a0a0b0; white-space: pre-wrap; }
  .map { font-size: 18px; line-height: 1.2; letter-spacing: 2px; }
  .footer { text-align: center; color: #444; font-size: 11px; margin-top: 20px; }
</style></head>
<body>
<div class="card">
  <h1>🤖 EzBot_IA — Relatório Diário</h1>
  <p style="color:#888;margin:0">${now.toLocaleString('pt-BR')} | Sessão de ${elapsed} minutos</p>
  <div style="margin-top:12px">
    <span class="badge ${bot?.entity ? 'green' : 'red'}">${bot?.entity ? '🟢 Online' : '🔴 Offline'}</span>
    <span class="badge blue">🤖 IA: ${aiProvider?.name || 'nenhuma'}</span>
    <span class="badge">📍 ${posStr}</span>
    <span class="badge">❤️ HP: ${bot ? Math.floor(bot.health) : '?'}/20</span>
    <span class="badge">🍖 Fome: ${bot?.food || '?'}/20</span>
  </div>
</div>

<div class="card">
  <h2>🎯 Missão Atual</h2>
  <p style="font-size:18px;font-weight:bold;color:#fff;margin:0 0 12px">${MISSION_DESC[currentMission]}</p>
  <p style="font-size:12px;color:#888;margin:0 0 8px">Progresso até o Ender Dragon: ${missionPct}%</p>
  <div class="progress"><div class="progress-bar" style="width:${missionPct}%"></div></div>
</div>

<div class="card">
  <h2>📊 Estatísticas da Sessão</h2>
  <div style="text-align:center">
    <div class="stat"><div class="num">🪵 ${stats.woodCollected}</div><div class="lbl">Madeira</div></div>
    <div class="stat"><div class="num">🪨 ${stats.stoneCollected}</div><div class="lbl">Pedra</div></div>
    <div class="stat"><div class="num">⛏️ ${stats.ironCollected}</div><div class="lbl">Ferro</div></div>
    <div class="stat"><div class="num">💎 ${stats.diamondCollected}</div><div class="lbl">Diamante</div></div>
    <div class="stat"><div class="num">⚔️ ${stats.mobsKilled}</div><div class="lbl">Mobs mortos</div></div>
    <div class="stat"><div class="num">💀 ${stats.deaths}</div><div class="lbl">Mortes</div></div>
  </div>
</div>

<div class="card">
  <h2>🗺️ Mini-Mapa (área ao redor)</h2>
  <div class="map">${miniMap}</div>
  <p style="font-size:11px;color:#555;margin-top:8px">🤖=Bot 🌲=Arvore 🔲=Pedra 🟩=Chao 🟦=Agua 💎=Minerio ⬛=Vazio</p>
</div>

${inv ? `<div class="card">
  <h2>🎒 Inventário Atual</h2>
  <table>
    <tr><th>Item</th><th>Quantidade</th></tr>
    ${inv}
  </table>
</div>` : ''}

<div class="card">
  <h2>📝 Últimas Ações (log)</h2>
  <pre>${lastLogs}</pre>
</div>

<div class="footer">EzBot_IA v4.0 | Servidor Minecraft 1.21.8 | Objetivo: matar o Ender Dragon 🐉</div>
</body></html>`

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: EMAIL_FROM, pass: SMTP_PASS },
    })

    await transporter.sendMail({
      from: `"EzBot_IA 🤖" <${EMAIL_FROM}>`,
      to: EMAIL_TO,
      subject: `EzBot_IA — ${now.toLocaleDateString('pt-BR')} | ${MISSION_DESC[currentMission]} | HP:${bot ? Math.floor(bot.health) : '?'}`,
      html,
    })

    log(`[Email] Relatório enviado para ${EMAIL_TO}`)
    if (bot) bot.chat(`Email enviado para ${EMAIL_TO}!`)
  } catch (e: any) {
    log(`[Email] Erro ao enviar: ${e?.message}`)
  }
}

async function dailyEmailLoop() {
  // Envia o primeiro email 2 minutos após iniciar (para testar)
  await sleep(2 * 60 * 1000)
  log('[Email] Enviando primeiro relatório de teste...')
  await sendDailyEmail(botRef)

  // Depois envia a cada 24 horas
  while (true) {
    await sleep(24 * 60 * 60 * 1000)
    log('[Email] Enviando relatório diário...')
    await sendDailyEmail(botRef)
  }
}

// ── Início ─────────────────────────────────────────────────────────────────────
log(`[Sistema] EzBot_IA v4.0 — ${new Date().toLocaleString('pt-BR')}`)
log(`[Sistema] Servidor: ${HOST}:${PORT} | Bot: ${BOT_NAME}`)
log(`[Sistema] IAs configuradas: ${AI_PROVIDERS.filter(p => p.key).map(p => p.name).join(', ') || 'nenhuma'}`)
log(`[Sistema] Email diário: ${SMTP_PASS ? `Ativado → ${EMAIL_TO}` : 'Sem senha SMTP'}`)
initLogFile()
createBot()
bgAILoop()
dailyEmailLoop()
