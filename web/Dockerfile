# Build from the repo root: docker build -f web/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/sdk/package.json packages/sdk/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY packages/types packages/types
COPY web web
RUN npm run build -w @context-trace/types && npm run build -w context-trace-web

FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
