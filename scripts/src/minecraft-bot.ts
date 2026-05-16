import mineflayer from 'mineflayer'
// @ts-ignore
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = 'Ezbotttt.aternos.me'
const PORT = 21779
const BOT_NAME = 'EzBot_IA'
const VERSION = '1.20.1'

let reconnectDelay = 5000

function createBot() {
  console.log(`[Bot] Conectando em ${HOST}:${PORT}...`)

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_NAME,
    version: VERSION,
    auth: 'offline',
  })

  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    console.log('[Bot] Conectado e spawnou no mundo!')
    reconnectDelay = 5000

    const defaultMove = new Movements(bot)
    defaultMove.allowSprinting = true
    defaultMove.canDig = true
    bot.pathfinder.setMovements(defaultMove)

    bot.chat('Oi! Sou um bot de IA. Vou explorar e tentar sobreviver!')

    startSurvivalLoop(bot)
  })

  bot.on('chat', (username: string, message: string) => {
    if (username === bot.username) return
    console.log(`[Chat] ${username}: ${message}`)

    if (message === '!status') {
      const pos = bot.entity.position
      const health = bot.health
      const food = bot.food
      bot.chat(`Saude: ${health.toFixed(1)} | Fome: ${food} | Pos: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`)
    }

    if (message === '!parar') {
      bot.chat('Parando atividade atual...')
      bot.pathfinder.stop()
    }
  })

  bot.on('health', () => {
    if (bot.health < 8) {
      console.log(`[Bot] Saude baixa (${bot.health})! Tentando comer...`)
      eatFood(bot)
    }
  })

  bot.on('death', () => {
    console.log('[Bot] Morri! Vou esperar respawnar...')
    bot.chat('Morri... vou tentar de novo!')
  })

  bot.on('kicked', (reason: string) => {
    console.log(`[Bot] Kickado: ${reason}`)
    scheduleReconnect()
  })

  bot.on('error', (err: Error) => {
    console.error(`[Bot] Erro: ${err.message}`)
  })

  bot.on('end', () => {
    console.log('[Bot] Desconectado. Reconectando em breve...')
    scheduleReconnect()
  })

  return bot
}

function scheduleReconnect() {
  console.log(`[Bot] Reconectando em ${reconnectDelay / 1000}s...`)
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
    createBot()
  }, reconnectDelay)
}

async function eatFood(bot: mineflayer.Bot) {
  const foodItems = bot.inventory.items().filter((item: any) => item.foodPoints && item.foodPoints > 0)
  if (foodItems.length > 0) {
    try {
      await bot.equip(foodItems[0], 'hand')
      await bot.consume()
      console.log(`[Bot] Comi ${foodItems[0].name}`)
    } catch (_e) {
      console.log('[Bot] Nao consegui comer')
    }
  }
}

type Phase = 'exploring' | 'gathering' | 'fighting' | 'building_shelter'

let currentPhase: Phase = 'exploring'
let loopRunning = false

function startSurvivalLoop(bot: mineflayer.Bot) {
  if (loopRunning) return
  loopRunning = true
  console.log('[Bot] Iniciando loop de sobrevivencia...')
  survivalTick(bot)
}

async function survivalTick(bot: mineflayer.Bot) {
  if (!bot.entity) return

  const health = bot.health
  const food = bot.food
  const inventory = bot.inventory.items()

  console.log(`[Bot] Fase: ${currentPhase} | Saude: ${health.toFixed(1)} | Fome: ${food} | Itens: ${inventory.length}`)

  if (health < 8) {
    await eatFood(bot)
    await sleep(2000)
    survivalTick(bot)
    return
  }

  if (food < 8) {
    await eatFood(bot)
  }

  try {
    switch (currentPhase) {
      case 'exploring':
        await explorePhase(bot)
        break
      case 'gathering':
        await gatheringPhase(bot)
        break
      case 'fighting':
        await fightingPhase(bot)
        break
      case 'building_shelter':
        await shelterPhase(bot)
        break
    }
  } catch (e) {
    console.log(`[Bot] Erro na fase ${currentPhase}:`, e)
  }

  await sleep(3000)
  survivalTick(bot)
}

async function explorePhase(bot: mineflayer.Bot) {
  const wood = countItem(bot, 'log')
  const planks = countItem(bot, 'planks')

  if (wood + planks < 10) {
    console.log('[Bot] Preciso de madeira! Indo coletar...')
    await gatherWood(bot)
    return
  }

  const stone = countItem(bot, 'cobblestone')
  if (stone < 20) {
    console.log('[Bot] Preciso de pedra! Mineirando...')
    currentPhase = 'gathering'
    return
  }

  const hasSword = bot.inventory.items().some((i: any) => i.name.includes('sword'))
  if (!hasSword) {
    console.log('[Bot] Vou craftar uma espada...')
    await craftSword(bot)
    return
  }

  const nearbyMobs = Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' &&
    e.position.distanceTo(bot.entity.position) < 10 &&
    isHostile(e.name)
  )

  if (nearbyMobs.length > 0) {
    console.log(`[Bot] Mobs hostis por perto! Fase: combate`)
    currentPhase = 'fighting'
    return
  }

  console.log('[Bot] Explorando o mundo...')
  await randomWalk(bot)
}

async function gatheringPhase(bot: mineflayer.Bot) {
  const stone = countItem(bot, 'cobblestone')
  if (stone >= 30) {
    console.log('[Bot] Tenho pedra suficiente! Voltando a explorar...')
    currentPhase = 'exploring'
    return
  }

  const stoneBlock = bot.findBlock({
    matching: (block: any) => block && (block.name.includes('stone') || block.name.includes('cobblestone')),
    maxDistance: 32,
  })

  if (stoneBlock) {
    try {
      const goal = new goals.GoalBlock(stoneBlock.position.x, stoneBlock.position.y, stoneBlock.position.z)
      await bot.pathfinder.goto(goal)
      await bot.dig(stoneBlock)
      console.log('[Bot] Minerou pedra!')
    } catch (_e) {
      console.log('[Bot] Nao consegui minerar aqui')
      await randomWalk(bot)
    }
  } else {
    await randomWalk(bot)
  }
}

async function fightingPhase(bot: mineflayer.Bot) {
  const hostileMobs = Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' &&
    e.position.distanceTo(bot.entity.position) < 16 &&
    isHostile(e.name)
  )

  if (hostileMobs.length === 0) {
    console.log('[Bot] Nenhum mob por perto. Voltando a explorar...')
    currentPhase = 'exploring'
    return
  }

  const target = (hostileMobs as any[]).sort((a, b) =>
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0]

  if (!target || !target.isValid) {
    currentPhase = 'exploring'
    return
  }

  console.log(`[Bot] Atacando ${target.name}!`)
  bot.lookAt(target.position.offset(0, target.height / 2, 0))
  bot.attack(target)

  await sleep(500)
}

async function shelterPhase(bot: mineflayer.Bot) {
  console.log('[Bot] Fase abrigo - voltando a explorar...')
  currentPhase = 'exploring'
}

async function gatherWood(bot: mineflayer.Bot) {
  const logBlock = bot.findBlock({
    matching: (block: any) => block && (block.name.includes('log') || block.name.includes('wood')),
    maxDistance: 32,
  })

  if (logBlock) {
    try {
      const goal = new goals.GoalBlock(logBlock.position.x, logBlock.position.y, logBlock.position.z)
      await bot.pathfinder.goto(goal)
      await bot.dig(logBlock)
      console.log('[Bot] Coletou madeira!')
    } catch (_e) {
      console.log('[Bot] Nao consegui chegar a madeira')
      await randomWalk(bot)
    }
  } else {
    console.log('[Bot] Nenhuma madeira por perto, explorando...')
    await randomWalk(bot)
  }
}

async function craftSword(bot: mineflayer.Bot) {
  try {
    const craftingTable = bot.findBlock({ matching: (b: any) => b && b.name === 'crafting_table', maxDistance: 16 })

    if (craftingTable) {
      await bot.pathfinder.goto(new goals.GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z))
    }

    const recipes = bot.recipesFor(302, null, 1, craftingTable || null)
    if (recipes.length > 0) {
      await bot.craft(recipes[0], 1, craftingTable || undefined)
      console.log('[Bot] Craftou espada de madeira!')
    }
  } catch (_e) {
    console.log('[Bot] Nao consegui craftar espada ainda')
  }
}

async function randomWalk(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  const x = pos.x + (Math.random() - 0.5) * 60
  const z = pos.z + (Math.random() - 0.5) * 60

  try {
    const goal = new goals.GoalXZ(Math.floor(x), Math.floor(z))
    await bot.pathfinder.goto(goal)
    console.log(`[Bot] Andou para ${Math.floor(x)}, ${Math.floor(z)}`)
  } catch (_e) {
    console.log('[Bot] Nao consegui caminhar ate la')
  }
}

function countItem(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items()
    .filter((i: any) => i.name.includes(name))
    .reduce((sum: number, i: any) => sum + i.count, 0)
}

function isHostile(name: string | undefined | null): boolean {
  if (!name) return false
  const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute']
  return hostiles.some(h => name.toLowerCase().includes(h))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

createBot()
