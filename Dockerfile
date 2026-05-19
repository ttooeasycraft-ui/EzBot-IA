FROM node:20-slim
RUN npm install -g pnpm typescript ts-node
WORKDIR /app
COPY . .
RUN cd scripts && pnpm install --no-frozen-lockfile
RUN cd scripts && npx tsc --skipLibCheck 2>/dev/null || true
CMD ["sh", "-c", "if [ -f scripts/dist/src/minecraft-bot.js ]; then node scripts/dist/src/minecraft-bot.js; elif [ -f scripts/dist/minecraft-bot.js ]; then node scripts/dist/minecraft-bot.js; else cd scripts && node -r ts-node/register src/minecraft-bot.ts; fi"]
