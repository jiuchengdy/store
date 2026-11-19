// Regenerate prisma/database-contract.json from a live database.
//
// Why this exists: db:verify compares the live database against the contract
// EXACTLY, so any additive migration turns the gate red until the contract is
// updated. Hand-editing 335 column entries is how a "safe migration" turns into
// a 2-hour diff hunt — this makes it one command.
//
//   bun scripts/ops/gen-contract.ts                 # rewrite the contract
//   bun scripts/ops/gen-contract.ts --check         # exit 1 if it would change
//   bun scripts/ops/gen-contract.ts --out /tmp/x.json
//
// Requires DATABASE_URL. Run it against the database you just migrated, BEFORE
// deploying the new image, then commit the contract together with the SQL.
import { writeFile } from 'node:fs/promises'
import { db } from '../../src/server/db'
import { databaseContract } from '../../src/server/database-catalog'

const args = process.argv.slice(2)
const check = args.includes('--check')
const outIndex = args.indexOf('--out')
const outPath =
  outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : new URL('../../prisma/database-contract.json', import.meta.url).pathname

try {
  const contract = await databaseContract(db)
  const next = `${JSON.stringify(contract, null, 2)}\n`
  const counts = Object.fromEntries(
    Object.entries(contract).map(([key, entries]) => [key, entries.length]),
  )

  if (check) {
    const { readFile } = await import('node:fs/promises')
    const current = await readFile(outPath, 'utf8')
    if (current !== next) {
      console.error('Contract is stale; run: bun scripts/ops/gen-contract.ts')
      process.exit(1)
    }
    console.log('Contract is up to date:', counts)
  } else {
    await writeFile(outPath, next)
    console.log('Contract written to', outPath, counts)
  }
} finally {
  await db.$disconnect()
}
