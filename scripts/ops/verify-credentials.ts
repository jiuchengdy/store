// Decryption probe for the restore drill.
//
// Row counts and db:verify both pass happily when every credential in the
// database is undecryptable: inventory codes are sealed with ENCRYPTION_KEY
// (AES-256-GCM via credential-storage.ts), so a lost or rotated key gives you
// a perfect-looking backup whose entire stock is scrap.
//
// It always probes TWO records, not a random sample:
//   oldest — proves historical data is still readable (a rotated key leaves old
//            ciphertext behind while new writes use the new key)
//   newest — proves the key this process holds matches the current write path
// Sampling only the newest reports PASS while every older code is unreadable,
// which is exactly the false green this probe exists to prevent.
//
// Plaintext is never printed — only ids, roles and counts.
//
//   bun scripts/ops/verify-credentials.ts
//   PROBE_ROWS=5 bun scripts/ops/verify-credentials.ts   # oldest, newest, plus 3 more
//
// Exit codes:
//   0 all probed credentials decrypted
//   1 key mismatch: ENCRYPTION_KEY cannot open ciphertext that is in this backup
//   3 nothing to probe (no inventory rows — cannot prove anything)
//   4 ENCRYPTION_KEY not provided to the probe
//   5 probe infrastructure error (database unreachable, bad query) — NOT a key problem
import { readFile } from 'node:fs/promises'
import { db } from '../../src/server/db'
import { openCredential } from '../../src/server/credential-storage'

type Probe = { role: string; id: string; code: string }

const extra = Number(process.env.PROBE_ROWS ?? '1')
const extraCount = Number.isFinite(extra) && extra > 1 ? Math.floor(extra) - 2 : 0

// A deployment may legitimately keep the key in a file instead of an env var:
// demo/dev uses .data/encryption.key (32 raw bytes), and ops can point at a
// mounted secret. Accept both, but never invent a key.
async function resolveKey(): Promise<string | null> {
  const fromEnv = process.env.ENCRYPTION_KEY?.trim()
  if (fromEnv) return fromEnv
  const file = process.env.ENCRYPTION_KEY_FILE?.trim()
  if (!file) return null
  const buf = await readFile(file)
  const text = buf.toString('utf8').trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return text
  if (buf.length === 32) return buf.toString('hex')
  throw new Error(`key file ${file} is neither 64 hex chars nor 32 raw bytes`)
}

const key = await resolveKey()
if (!key) {
  console.error('no key provided: set ENCRYPTION_KEY (64 hex) or ENCRYPTION_KEY_FILE')
  console.error('a probe without the real key would use a throwaway one, so the result would be meaningless')
  process.exit(4)
}
process.env.ENCRYPTION_KEY = key

const select = { id: true, code: true } as const

try {
  const [oldest, newest] = await Promise.all([
    db.inventory.findFirst({ select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.inventory.findFirst({ select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
  ])

  if (!oldest || !newest) {
    console.log('credential probe: SKIPPED (no inventory rows to open — nothing proven)')
    process.exit(3)
  }

  const probes: Probe[] = [
    { role: 'oldest', ...oldest },
    { role: 'newest', ...newest },
  ]

  if (extraCount > 0) {
    const middle = await db.inventory.findMany({
      select,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: extraCount + 2,
    })
    for (const item of middle) {
      if (probes.some((p) => p.id === item.id)) continue
      probes.push({ role: 'extra', ...item })
    }
  }

  let ok = 0
  const failures: string[] = []
  for (const probe of probes) {
    try {
      const value = openCredential(probe.code, 'inventory', probe.id)
      if (!value.trim()) throw new Error('empty plaintext')
      ok += 1
    } catch (error) {
      failures.push(`${probe.role} ${probe.id}: ${(error as Error).message}`)
    }
  }

  console.log(
    `credential probe: ok=${ok} fail=${failures.length} probed=${probes.length} roles=${probes.map((p) => p.role).join('+')}`,
  )
  if (failures.length) {
    for (const line of failures) console.error('  undecryptable', line)
    console.error('ENCRYPTION_KEY in this environment cannot open ciphertext stored in this backup')
    process.exit(1)
  }
} catch (error) {
  const err = error as Error
  console.error(`credential probe could not run (${err.name || 'Error'}): ${err.message || 'see log above'}`)
  process.exit(5)
} finally {
  await db.$disconnect()
}
