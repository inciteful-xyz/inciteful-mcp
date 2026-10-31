# Production image for the hosted server at /academic/mcp.
# Runs as uid 10001 with a read-only root filesystem: it writes only to USAGE_DB_PATH (a mounted
# volume) and /tmp. Node >= 22.13 is required for node:sqlite.

FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22.23.4-alpine3.24
ENV NODE_ENV=production
# dist/index.js resolves ../package.json (version) and ../assets/ relative to itself.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER 10001:10001
EXPOSE 8080
# PID 1 is safe: the server handles SIGTERM itself and drains before exiting.
# node:sqlite prints an ExperimentalWarning at startup on Node 22; it is noise in the pod logs.
CMD ["node","--disable-warning=ExperimentalWarning","dist/index.js"]
