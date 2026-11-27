#!/usr/bin/env bash
# Stages the self-contained desktop payload into src-tauri/payload/ for Tauri to
# bundle as resources: the Node runtime, the compiled server + its node_modules
# (incl. Prisma engines) + prisma schema/migrations, and portable MariaDB.
#
# Run from the repo root or client/src-tauri. Override sources via env:
#   NODE_EXE   (default: `which node`)
#   MARIADB_SRC (default: C:/xampp/mysql)   -- must contain bin/ and share/
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SERVER="$REPO/server"
PAYLOAD="$HERE/payload"

NODE_EXE="${NODE_EXE:-$(which node)}"
MARIADB_SRC="${MARIADB_SRC:-C:/xampp/mysql}"

echo "==> Cleaning payload dir"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/node" "$PAYLOAD/server" "$PAYLOAD/mariadb"

echo "==> Building server (tsc)"
( cd "$SERVER" && npm run build >/dev/null )

echo "==> Copying Node runtime"
cp "$NODE_EXE" "$PAYLOAD/node/node.exe"

echo "==> Copying server (dist, prisma, node_modules)"
cp -r "$SERVER/dist" "$PAYLOAD/server/dist"
cp -r "$SERVER/prisma" "$PAYLOAD/server/prisma"
# Drop leftover Prisma engine temp files before copying node_modules.
rm -f "$SERVER"/node_modules/.prisma/client/*.tmp* "$SERVER"/node_modules/@prisma/engines/*.tmp* 2>/dev/null || true
cp -r "$SERVER/node_modules" "$PAYLOAD/server/node_modules"
# A minimal package.json (helps Node module resolution treat this as the root).
cp "$SERVER/package.json" "$PAYLOAD/server/package.json"

echo "==> Copying portable MariaDB (bin + share)"
cp -r "$MARIADB_SRC/bin" "$PAYLOAD/mariadb/bin"
cp -r "$MARIADB_SRC/share" "$PAYLOAD/mariadb/share"

echo "==> Sanity checks"
test -f "$PAYLOAD/node/node.exe"                                   && echo "  node.exe OK"
test -f "$PAYLOAD/server/dist/desktop.js"                          && echo "  desktop.js OK"
test -f "$PAYLOAD/server/node_modules/.prisma/client/query_engine-windows.dll.node" && echo "  prisma query engine OK"
test -f "$PAYLOAD/server/node_modules/@prisma/engines/schema-engine-windows.exe"    && echo "  prisma schema engine OK"
test -f "$PAYLOAD/server/node_modules/prisma/build/index.js"       && echo "  prisma CLI OK"
test -f "$PAYLOAD/mariadb/bin/mysqld.exe"                          && echo "  mysqld.exe OK"
test -f "$PAYLOAD/mariadb/bin/mysql_install_db.exe"                && echo "  mysql_install_db.exe OK"

echo "==> Payload size:"
du -sh "$PAYLOAD"
echo "==> Done."
