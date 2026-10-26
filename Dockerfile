# ---------------------------------------------------------------------------
# Model Intelligence Lab — production image
#
# Two stages: the builder compiles the client, the runtime carries only what is
# needed to serve it.
#
# The app is a single Node process that owns a SQLite file, so it needs a
# persistent volume mounted at /app/data and exactly one replica. It is not
# stateless and must not be scaled horizontally.
# ---------------------------------------------------------------------------

# --- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install with the lockfile only, so editing source does not bust this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY server ./server
COPY shared ./shared
COPY src ./src
COPY scripts ./scripts
COPY public ./public

RUN npm run build

# tsx is a runtime dependency (the server executes TypeScript directly), so
# pruning dev packages still leaves a working image — and a smaller one.
RUN npm prune --omit=dev

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` reaps zombies and forwards SIGTERM, which matters because the evaluation
# worker runs background work: an immediate kill would leave runs marked
# in-progress. `curl` is there for the healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    MODEL_LAB_DB_PATH=/app/data/model-lab.db

WORKDIR /app

# tsx is a runtime dependency because the server executes TypeScript directly.
# Everything else in node_modules at this point is a production dependency too.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
