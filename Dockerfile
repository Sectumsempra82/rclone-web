FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:service

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5572 QUEUE_DATA_DIR=/app/queue-data
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
RUN mkdir /app/queue-data && chown node:node /app/queue-data
USER node
EXPOSE 5572
CMD ["node", "--experimental-sqlite", "dist-server/server/main.js"]
