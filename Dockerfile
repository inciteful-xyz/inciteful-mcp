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
# npm, npx, yarn and corepack aren't used at runtime; removing them drops most scanner findings.
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER 10001:10001
EXPOSE 8080
# node is PID 1 directly (no entrypoint shell). That is safe: the server handles SIGTERM and SIGINT
# itself and drains before exiting.
# node:sqlite prints an ExperimentalWarning at startup on Node 22; it is noise in the pod logs.
ENTRYPOINT ["node"]
CMD ["--disable-warning=ExperimentalWarning","dist/index.js"]
