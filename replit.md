# EzBot_IA — Bot Autônomo de Minecraft

Bot autônomo que joga Minecraft sozinho com o objetivo de matar o Ender Dragon, usando um sistema de IA rotativa com 9 provedores.

## Run & Operate

- `pnpm --filter @workspace/scripts run minecraft-bot` — iniciar o bot
- Bot roda via workflow "Minecraft Bot" no Replit

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: `mineflayer` + `mineflayer-pathfinder`
- IA: `openai` (compatível com Cerebras/Groq/Mistral/etc.) + `@google/generative-ai` (Gemini)

## Onde as coisas ficam

- `scripts/src/minecraft-bot.ts` — código principal do bot (ÚNICO arquivo)
- `cerebro/CONHECIMENTO.md` — base de conhecimento: HP de mobs, níveis de minério, receitas, estratégias
- `cerebro/LINKS.md` — todos os links de referência
- `bot-log.txt` — log completo de tudo que o bot fez (gerado em runtime, no .gitignore)
- `.env.example` — template de variáveis de ambiente (sem valores reais)

## Arquitetura

- **Sistema de IA rotativa**: 9 provedores em ordem de prioridade. Quando um retorna 429 (quota esgotada), troca automaticamente para o próximo. Gemini é sempre o último.
  - Ordem: Cerebras → Groq → Mistral → OpenRouter → DeepSeek → xAI → OpenAI → Anthropic → Gemini
- **Missões progressivas**: Madeira → Pedra → Ferro → Diamante → Ender Dragon
- **Combate inteligente**: tabela de HP/dano de todos os mobs, foge quando HP < 8 ou mob é perigoso demais
- **Auto-eat**: come automaticamente quando fome cai abaixo de 16
- **Auto-armadura**: equipa automaticamente a melhor armadura disponível

## Variáveis de Ambiente Necessárias

- `MINECRAFT_HOST` — endereço do servidor (padrão: Ezbotttt.aternos.me)
- `MINECRAFT_PORT` — porta do servidor (padrão: 21779)
- `BOT_NAME` — nick do bot (padrão: EzBot_IA)
- `GOOGLE_AI_API_KEY` — Google Gemini (obrigatório como fallback)
- `OPENAI_API_KEY` — OpenAI (opcional)
- `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY` — opcionais

## Comandos no Chat do Minecraft

| Comando | Função |
|---|---|
| `!status` | Tempo online, missão, HP, posição, IA ativa |
| `!missao` | Missão atual |
| `!inv` | Inventário completo |
| `!pos` | Coordenadas XYZ |
| `!ia` | IA ativa e status de todas |
| `!hp [mob]` | HP e dano de um mob específico |
| `!seguir [nick]` | Seguir um jogador |
| `!vir` | Vir até quem digitou |
| `!base` | Ir para a base (ou salvar base atual) |
| `!salvarbase` | Salvar posição atual como nova base |
| `!parar` | Parar movimento |
| `!dormir` | Dormir na cama mais próxima |
| `!craft` | Craftar itens essenciais |
| `!minerar [bloco]` | Minerar bloco específico |
| `!falar <texto>` | Conversar com IA |
| `!ajuda` | Lista todos os comandos |

## GitHub — O que é privado

O seguinte NUNCA sobe para o GitHub (está no .gitignore):
- `.env` e variáveis de ambiente (API keys, endereço do servidor, nick)
- `bot-log.txt` e arquivos `.log` (podem conter coordenadas e info privada)
- `node_modules/`

O que é público (código fonte sem dados sensíveis):
- Todo o código do bot (usa variáveis de ambiente, não hardcoded)
- `cerebro/` (conhecimento público do Minecraft)
- `.env.example` (template sem valores reais)

## YouTube Live

O bot não consegue fazer streaming de vídeo pois roda sem interface gráfica (headless) — não tem tela de Minecraft renderizada. Para fazer live, seria necessário um cliente Minecraft real rodando com captura de tela, o que é uma arquitetura completamente diferente.

## Logs e Gravação

Tudo que o bot faz é gravado em `bot-log.txt` com timestamp. O bot também posta relatórios automáticos a cada 5 minutos no chat do servidor com stats completos.

## User Preferences

- Servidor: 1.21.8 com Fabric (offline/pirate mode)
- Idioma do bot: Português do Brasil
- Info privada: endereço do servidor, nick do dono, nick do bot (ficam em .env)
- Gemini é sempre o último fallback de IA

## Gotchas

- `tryBasicCraft` tenta craftar após coletar madeira — requer `bot.mcData` disponível
- `GoalNear` em vez de `GoalBlock` para pathfinder não tentar entrar dentro do bloco
- Timeout de 30s em cada ação para nunca travar
- `mineflayer-auto-eat` não usado — auto-eat implementado manualmente para mais controle
