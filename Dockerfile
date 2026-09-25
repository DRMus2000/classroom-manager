# 构建阶段安装全部依赖（含 TypeScript），运行阶段只保留生产依赖。
FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY cli ./cli

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache wget postgresql16-client su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/migrations ./migrations

RUN mkdir -p /app/backups /app/anon-ledger /backups \
    && addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001 \
    && chown -R nodejs:nodejs /app /backups

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --spider -q http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
