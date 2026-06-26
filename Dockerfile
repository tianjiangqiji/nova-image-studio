# ---- 构建阶段 ----
FROM node:20-slim AS builder

WORKDIR /app

# 安装构建依赖（better-sqlite3 需要 python3 和 g++）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 复制 package 文件
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY backend/package.json backend/package-lock.json ./backend/

# 分别安装依赖
RUN cd frontend && npm ci
RUN cd backend && npm ci

# 构建前端
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ---- 生产阶段 ----
FROM node:20-slim AS production

WORKDIR /app

# 复制后端代码和依赖
COPY backend/ ./backend/
COPY --from=builder /app/backend/node_modules/ ./backend/node_modules/

# 复制前端产物
COPY --from=builder /app/frontend/out/ ./frontend/out/

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["node", "backend/server.js"]
