# ---- 构建阶段 ----
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci

# 构建前端
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ---- 生产阶段 ----
FROM node:20-alpine AS production

WORKDIR /app

# 安装生产依赖
COPY package.json package-lock.json ./
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# 复制后端代码和前端产物
COPY backend/ ./backend/
COPY --from=builder /app/frontend/out/ ./frontend/out/

# 复制配置文件
COPY backend/.env.example ./backend/.env

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["node", "backend/server.js"]
