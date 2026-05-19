FROM node:20-slim
RUN npm install -g pnpm ts-node typescript
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile --shamefully-hoist
RUN cd scripts && pnpm install --no-frozen-lockfile
CMD ["ts-node", "scripts/src/minecraft-bot.ts"]
