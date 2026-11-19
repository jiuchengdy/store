// Decryption probe for the restore drill.
//
// Row counts and db:verify both pass happily when every credential in the
// database is undecryptable: inventory codes are sealed with ENCRYPTION_KEY
// (AES-256-GCM via credential-storage.ts), so a lost or rotated key gives you
// a perfect-looking backup whose entire stock is scrap.
//
// This opens a few real records and prints only counts — never plaintext.
//
//   bun scripts/ops/verify-credentials.ts          # probe 1 row (PROBE_ROWS to change)
//
// Exit codes: 0 all probed credentials decrypted, 1 decryption failed,
//             3 nothing to probe (cannot prove anything), 4 ENCRYPTION_KEY missing.
import { db } from '../../src/server/db'
import { openCredential } from '../../src/server/credential-storage'

const rows = Number(process.env.PROBE_ROWS ?? '1')
const limit = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 1

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not set: a probe without the real key would use a throwaway one')
  console.error('pass the production key into this probe, otherwise the result is meaningless')
  process.exit(4)
}

try {
  const sample = await db.inventory.findMany({
    select: { id: true, code: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
  })

  if (sample.length === 0) {
    console.log('credential probe: SKIPPED (no inventory rows to open — nothing proven)')
    process.exit(3)
  }

  let ok = 0
  const failures: string[] = []
  for (const item of sample) {
    try {
      const value = openCredential(item.code, 'inventory', item.id)
      if (!value.trim()) throw new Error('empty plaintext')
      ok += 1
    } catch (error) {
      failures.push(`${item.id}: ${(error as Error).message}`)
    }
  }

  console.log(`credential probe: ok=${ok} fail=${failures.length} probed=${sample.length}`)
  if (failures.length) {
    for (const line of failures) console.error('  undecryptable', line)
    console.error('ENCRYPTION_KEY in this environment cannot open this backup')
    process.exit(1)
  }
} finally {
  await db.$disconnect()
}
