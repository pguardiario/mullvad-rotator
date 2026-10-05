FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Named volume inherits this ownership, so the relay cache is writable as "node".
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8899/healthz || exit 1
CMD ["node", "dist/server.js"]
