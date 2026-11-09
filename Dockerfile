FROM node:22-alpine AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg：mkv/avi 等格式在线转码播放
RUN apk add --no-cache ffmpeg
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY --from=web-build /build/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "src/server.js"]
