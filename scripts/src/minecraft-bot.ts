import mineflayer from 'mineflayer'
import OpenAI from 'openai'
// @ts-ignore
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = 'Ezbotttt.aternos.me'
const PORT = 21779
const BOT_NAME = 'EzBot_IA'
const VERSION = '1.20.1'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

let reconnectDelay = 5000
let lastAIDecision = Date.now()
let currentAction = 'Iniciando...'
let chatHistory: { role: 'user' | 'assistant' | 'system', content: string }[] = []

async function askAI(situation: string): Promise<string> {
  try {
    chatHistory.push({ role: 'user', content: situation })
    if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10)

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Você é o cérebro de um bot de Minecraft chamado EzBot_IA. Seu objetivo é sobreviver e vencer o jogo (matar o Ender Dragon).
Responda SEMPRE com um JSON assim: {"acao": "NOME_DA_ACAO", "motivo": "motivo curto", "chat": "mensagem curta opcional para o chat do servidor"}
Ações disponíveis: EXPLORAR, COLETAR_MADEIRA, MINERAR_PEDRA, LUTAR, COMER, CRAFTAR_FERRAMENTAS, FUGIR, DORMIR, CONSTRUIR_ABRIGO
Seja direto e estratégico. Chat é opcional — só use quando for algo interessante de dizer.`,
        },
        ...chatHistory,
      ],
      max_tokens: 150,
      response_format: { type: 'json_object' },
    })

    const content = response.choices[0].message.content || '{}'
    chatHistory.push({ role: 'assistant', content })
    return content
  } catch (e) {
    console.log('[AI] Erro ao consultar GPT:', e)
    return '{"acao": "EXPLORAR", "motivo": "erro na IA, modo fallback"}'
  }
}

function buildSituationReport(bot: mineflayer.Bot): string {
  const pos = bot.entity.position
  const nearbyMobs = Object.values(bot.entities)
    .filter((e: any) => e.type === 'mob' && e.position.distanceTo(pos) < 20)
    .map((e: any) => e.name)
    .filter(Boolean)
    .slice(0, 5)

  const inventory = bot.inventory.items()
    .reduce((acc: Record<string, number>, item: any) => {
      acc[item.name] = (acc[item.name] || 0) + item.count
      return acc
    }, {})

  const isNight = bot.time.timeOfDay > 13000 && bot.time.timeOfDay < 23000

  return JSON.stringify({
    posicao: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    saude: bot.health,
    fome: bot.food,
    isNight,
    mobs_proximos: nearbyMobs,
    inventario: inventory,
    acao_atual: currentAction,
  })
}

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

  bot.once('spawn', async () => {
    console.log('[Bot] Conectado! ChatGPT no comando.')
    reconnectDelay = 5000

    const defaultMove = new Movements(bot)
    defaultMove.allowSprinting = true
    defaultMove.canDig = true
    bot.pathfinder.setMovements(defaultMove)

    bot.chat('EzBot_IA online! Deixa eu ver o que vou fazer...')

    await sleep(2000)
    startAILoop(bot)
  })

  bot.on('chat', async (username: string, message: string) => {
    if (username === bot.username) return
    console.log(`[Chat] ${username}: ${message}`)

    if (message === '!status') {
      const pos = bot.entity.position
      bot.chat(`Saude: ${bot.health.toFixed(1)} | Fome: ${bot.food} | Pos: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)} | Fazendo: ${currentAction}`)
      return
    }

    if (message === '!parar') {
      bot.chat('Ok, parando...')
      bot.pathfinder.stop()
      return
    }

    if (message.startsWith('!falar ')) {
      const pergunta = message.replace('!falar ', '')
      try {
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Você é EzBot_IA, um bot de Minecraft. Responda de forma curta e divertida, máximo 200 caracteres.' },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 60,
        })
        const reply = resp.choices[0].message.content || 'Hmm...'
        bot.chat(reply.substring(0, 200))
      } catch (_e) {
        bot.chat('Nao consegui pensar agora!')
      }
    }
  })

  bot.on('health', () => {
    if (bot.health < 6) {
      console.log(`[Bot] PERIGO! Saude critica: ${bot.health}`)
      eatFood(bot)
    }
  })

  bot.on('death', () => {
    console.log('[Bot] Morri!')
    bot.chat('Morri... voltando!')
    currentAction = 'Respawnando'
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

async function startAILoop(bot: mineflayer.Bot) {
  while (bot.entity) {
    try {
      const now = Date.now()
      if (now - lastAIDecision < 8000) {
        await sleep(1000)
        continue
      }

      lastAIDecision = now
      const situation = buildSituationReport(bot)
      console.log(`[AI] Situacao: ${situation}`)

      const decision = await askAI(`Situacao atual: ${situation}. O que devo fazer?`)
      console.log(`[AI] Decisao: ${decision}`)

      const parsed = JSON.parse(decision)
      const acao = parsed.acao as string
      const motivo = parsed.motivo as string
      const chatMsg = parsed.chat as string | undefined

      currentAction = acao
      console.log(`[Bot] Acao: ${acao} | Motivo: ${motivo}`)

      if (chatMsg && chatMsg.length > 0) {
        bot.chat(chatMsg.substring(0, 200))
      }

      await executeAction(bot, acao)
    } catch (e) {
      console.log('[AI] Erro no loop:', e)
      await sleep(3000)
    }
  }
}

async function executeAction(bot: mineflayer.Bot, acao: string) {
  switch (acao) {
    case 'COLETAR_MADEIRA':
      await gatherWood(bot)
      break
    case 'MINERAR_PEDRA':
      await mineStone(bot)
      break
    case 'LUTAR':
      await fight(bot)
      break
    case 'COMER':
      await eatFood(bot)
      break
    case 'CRAFTAR_FERRAMENTAS':
      await craftTools(bot)
      break
    case 'FUGIR':
      await flee(bot)
      break
    case 'CONSTRUIR_ABRIGO':
      await randomWalk(bot)
      break
    case 'DORMIR':
      await tryToSleep(bot)
      break
    case 'EXPLORAR':
    default:
      await randomWalk(bot)
      break
  }
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

async function gatherWood(bot: mineflayer.Bot) {
  const logBlock = bot.findBlock({
    matching: (block: any) => block && (block.name.includes('log') || block.name.includes('wood')),
    maxDistance: 32,
  })

  if (logBlock) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(logBlock.position.x, logBlock.position.y, logBlock.position.z))
      await bot.dig(logBlock)
      console.log('[Bot] Coletou madeira!')
    } catch (_e) {
      await randomWalk(bot)
    }
  } else {
    await randomWalk(bot)
  }
}

async function mineStone(bot: mineflayer.Bot) {
  const stoneBlock = bot.findBlock({
    matching: (block: any) => block && (block.name.includes('stone') || block.name === 'cobblestone'),
    maxDistance: 32,
  })

  if (stoneBlock) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(stoneBlock.position.x, stoneBlock.position.y, stoneBlock.position.z))
      await bot.dig(stoneBlock)
      console.log('[Bot] Minerou pedra!')
    } catch (_e) {
      await randomWalk(bot)
    }
  } else {
    await randomWalk(bot)
  }
}

async function fight(bot: mineflayer.Bot) {
  const mobs = Object.values(bot.entities).filter((e: any) =>
    e.type === 'mob' && e.position.distanceTo(bot.entity.position) < 16 && isHostile(e.name)
  )

  if (mobs.length === 0) return

  const target = (mobs as any[]).sort((a, b) =>
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  )[0]

  if (target && target.isValid) {
    console.log(`[Bot] Atacando ${target.name}!`)
    bot.lookAt(target.position.offset(0, target.height / 2, 0))
    bot.attack(target)
    await sleep(600)
  }
}

async function flee(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  const x = pos.x + (Math.random() - 0.5) * 40
  const z = pos.z + (Math.random() - 0.5) * 40
  try {
    await bot.pathfinder.goto(new goals.GoalXZ(Math.floor(x), Math.floor(z)))
  } catch (_e) {}
}

async function craftTools(bot: mineflayer.Bot) {
  try {
    const table = bot.findBlock({ matching: (b: any) => b && b.name === 'crafting_table', maxDistance: 16 })
    if (table) {
      await bot.pathfinder.goto(new goals.GoalBlock(table.position.x, table.position.y, table.position.z))
    }
    const recipes = bot.recipesFor(302, null, 1, table || null)
    if (recipes.length > 0) {
      await bot.craft(recipes[0], 1, table || undefined)
      console.log('[Bot] Craftou espada!')
    }
  } catch (_e) {
    console.log('[Bot] Nao consegui craftar')
  }
}

async function tryToSleep(bot: mineflayer.Bot) {
  const bed = bot.findBlock({ matching: (b: any) => b && b.name.includes('bed'), maxDistance: 32 })
  if (bed) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(bed.position.x, bed.position.y, bed.position.z))
      await bot.sleep(bed)
      console.log('[Bot] Dormindo!')
    } catch (_e) {
      console.log('[Bot] Nao consegui dormir')
    }
  }
}

async function randomWalk(bot: mineflayer.Bot) {
  const pos = bot.entity.position
  const x = pos.x + (Math.random() - 0.5) * 80
  const z = pos.z + (Math.random() - 0.5) * 80
  try {
    await bot.pathfinder.goto(new goals.GoalXZ(Math.floor(x), Math.floor(z)))
    console.log(`[Bot] Explorou para ${Math.floor(x)}, ${Math.floor(z)}`)
  } catch (_e) {
    console.log('[Bot] Nao consegui caminhar')
  }
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
