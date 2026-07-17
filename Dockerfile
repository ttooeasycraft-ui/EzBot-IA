FROM node:22-alpine

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY scripts/package.json ./scripts/
COPY tsconfig.base.json tsconfig.json ./

RUN pnpm install --no-frozen-lockfile

COPY scripts/ ./scripts/
COPY cerebro/ ./cerebro/

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@workspace/scripts", "run", "minecraft-bot"]
