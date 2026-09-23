# 多阶段构建：构建阶段 + 运行阶段
FROM node:22-alpine AS builder

WORKDIR /build

# 复制依赖清单并安装（利用缓存层）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# 复制源码并构建
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY cli ./cli

RUN npm run build

# =============================================================================
# 运行阶段
FROM node:22-alpine

WORKDIR /app

# 只复制必要文件
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/migrations ./migrations
COPY --from=builder /build/package.json ./

# 创建备份与匿名化账本目录
RUN mkdir -p /app/backups /app/anon-ledger

# 非 root 用户运行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

# 健康检查端点由应用提供
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --spider -q http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server.js"]
