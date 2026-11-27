# syntax=docker/dockerfile:1
# YourHires — single image: Node/Express API that also serves the built React client.

# ── 1. Build the React client ──────────────────────────────────────────────
FROM node:20-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
# npm install (not ci): the committed lockfile is generated on Windows and lacks
# the Linux-only optional native deps (@emnapi/*, rollup/oxide binaries), which
# makes `npm ci` fail the in-sync check on this platform.
RUN npm install --no-audit --no-fund
COPY client/ ./
# Injected into the bundle so the browser calls the API on this same origin.
ARG VITE_API_URL=https://hires.midwayug.com
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── 2. Build the Node server ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS server
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npx prisma generate && npm run build

# ── 3. Runtime ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# default-mysql-client provides `mysqldump` and `mysql`, which server/src/backup.ts
# spawns by name off PATH. Without it every scheduled backup died at boot with
# "spawn mysqldump ENOENT" — the app was running with NO database backups at all
# (found 2026-09-09). The dev machine has these on PATH, so this only ever failed
# in the container.
#
# On bookworm this is the MariaDB client. That is fine here specifically because
# the `yourhires` MySQL 8.0 account authenticates with mysql_native_password —
# MariaDB's client cannot speak caching_sha2_password, which is MySQL 8's
# default. If that account is ever recreated without an explicit
# `IDENTIFIED WITH mysql_native_password`, backups start failing on auth.
RUN apt-get update && apt-get install -y --no-install-recommends openssl default-mysql-client && rm -rf /var/lib/apt/lists/*
# Server: compiled JS + node_modules (incl. Prisma CLI for `migrate deploy` on boot,
# generated Prisma client + engines) + prisma schema/migrations.
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=server /app/prisma ./prisma
COPY --from=server /app/package.json ./package.json
# Built client, served statically by the server (path.join(__dirname,'..','client-dist')).
COPY --from=client /client/dist ./client-dist
EXPOSE 20090
CMD ["node", "dist/server.js"]
