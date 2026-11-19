#!/bin/sh
set -eu

case "${1:-web}" in
  web)
    exec bun --bun node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port "${PORT:-3000}"
    ;;
  worker)
    exec bun src/server/worker.ts
    ;;
  db:init|init)
    exec bun scripts/init-database.ts
    ;;
  db:seed|seed)
    exec bun scripts/seed.ts
    ;;
  db:verify|verify)
    exec bun scripts/verify-database.ts
    ;;
  migrate)
    exec bun scripts/migrate.ts
    ;;
  admin:bootstrap)
    exec bun scripts/bootstrap-admin.ts
    ;;
  healthcheck)
    exec bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/robots.txt').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
    ;;
  *)
    exec "$@"
    ;;
esac
