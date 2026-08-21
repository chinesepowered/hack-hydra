# Blast Radius — one container: HydraDB graph-node + the console app.
# Sized for Render's free tier (512MB RAM, ephemeral disk): the graph seeds
# itself from the committed dataset on every cold start (~3s).

# --- stage 1: node runtime + app deps (Debian, glibc-compatible with the
#     Ubuntu 24.04 base of the HydraDB image)
FROM node:22-slim AS nodedeps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# --- stage 2: HydraDB image is the base; add node + the app
FROM ghcr.io/hydra-db/hydradb:latest

USER root
COPY --from=nodedeps /usr/local/bin/node /usr/local/bin/node
COPY --from=nodedeps /app/node_modules /app/node_modules

COPY server /app/server
COPY public /app/public
COPY data /app/data
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh && mkdir -p /data && chown -R 10001:10001 /data /app

USER 10001:10001
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/app/start.sh"]
