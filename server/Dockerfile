# Build from the repo root: docker build -f server/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/sdk/package.json packages/sdk/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY packages/types packages/types
COPY server server
RUN npm run build -w @context-trace/types && npm run build -w context-trace-server \
    && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production CT_PORT=4720 CT_DB=/data/context-trace.db
COPY --from=build /app /app
VOLUME /data
EXPOSE 4720
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:4720/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
