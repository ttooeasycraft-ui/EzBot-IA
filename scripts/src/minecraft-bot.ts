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
const HOST     = process.env.MINECRAFT_HOST    || 'Ezbotttt.aternos.me'
const PORT     = parseInt(process.env.MINECRAFT_PORT || '21779')
const BOT_NAME = process.env.BOT_NAME          || 'EzBot_IA'
const VERSION  = '1.21.8'
const LOG_FILE = path.join(process.cwd(), 'bot-log.txt')

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
    if (status === 429 || e?.message?.includes('429') || e?.message?.toLowerCase().includes('quota')) {
      markProviderExhausted(provider)
      return askAI(prompt)
    }
    log(`[IA] Erro ${provider.name}: ${e?.message}`)
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
    move.liquidCost = 100
    bot.pathfinder.setMovements(move)

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

  bot.on('kicked', (r: string) => { log(`[Kick] ${r}`); botRef = null; scheduleReconnect() })
  bot.on('error', (e: Error) => log(`[Erro] ${e.message}`))
  bot.on('end', () => { log('[Desconectado]'); botRef = null; scheduleReconnect() })

  return bot
}

function scheduleReconnect() {
  log(`[Reconectar] em ${reconnectDelay / 1000}s...`)
  setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 30000); createBot() }, reconnectDelay)
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
  if (!bot?.entity) return '(bot offline)'
  const pos = bot.entity.position.floored()
  const radius = 8
  let map = ''
  for (let z = pos.z - radius; z <= pos.z + radius; z += 2) {
    let row = ''
    for (let x = pos.x - radius; x <= pos.x + radius; x += 2) {
      if (x === pos.x && z === pos.z) { row += '🤖'; continue }
      const block = bot.blockAt({ x, y: pos.y, z } as any)
      const below = bot.blockAt({ x, y: pos.y - 1, z } as any)
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
    }
    map += row + '\n'
  }
  return map
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
