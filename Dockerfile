FROM node:22-slim

ENV NODE_ENV=production TZ=Asia/Tokyo
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 記録（SQLite）はここに保存する。ボリュームをつないで消えないようにする
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
