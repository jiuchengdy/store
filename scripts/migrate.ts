// Applies numbered SQL files from prisma/migrations in filename order and records
// each one in the schema_version ledger, so "change the schema" becomes a
// repeatable, verifiable action instead of hand-run SQL.
//
// Ordering is the filename: `0002_something.sql` runs after `0001_baseline.sql`.
// One file = one transaction: a failure leaves the database at the previous
// version with no partially applied objects and an unchanged ledger.
//
// There is deliberately no down migration. Rollback of data is restoring the
// pg_dump taken before the migration (docs/database.md); a hand-written down
// script would only provide false confidence.
//
// Exit codes (registered in docs/ops/exit-codes.md before use):
//   0 = every migration applied or already applied (idempotent re-run)
//   1 = execution or integrity failure: SQL error, checksum mismatch,
//       applied SQL edited after the fact, ledger write failed
//   2 = unusable environment or input: no DATABASE_URL, unreadable directory,
//       bad schema name, malformed filename, duplicated version number
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { Pool, type PoolClient } from 'pg'

const MIGRATIONS_DIR = new URL('../prisma/migrations/', import.meta.url)
// Number first so a plain lexicographic sort is the execution order.
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/

type MigrationFile = {
  version: number
  name: string
  sql: string
  checksum: string
}

type AppliedRow = {
  version: number
  checksum: string
  applied_at: Date
  applied_by: string
}

function abort(code: 1 | 2, message: string): never {
  console.error(message)
  process.exit(code)
}

function databaseSchema(connectionString: string): string {
  const schema = new URL(connectionString).searchParams.get('schema') ?? 'public'
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) abort(2, `Invalid database schema: ${schema}`)
  return schema
}

// Records where this migration ran from. A production image has no .git and no
// image digest at migrate time (the image is rolled out after the migration), so
// MIGRATE_APPLIED_BY is the way to pass a digest in. Every fallback still yields
// a non-empty value: an empty applied_by would make the audit trail useless.
function appliedBy(): string {
  const explicit = process.env.MIGRATE_APPLIED_BY?.trim()
  if (explicit) return explicit
  const host = hostname()
  try {
    const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (revision) return `git:${revision}@${host}`
  } catch {
    // No git in the image: fall through instead of failing the migration.
  }
  return `unknown@${host}`
}

async function loadMigrations(): Promise<MigrationFile[]> {
  let names: string[]
  try {
    names = await readdir(MIGRATIONS_DIR)
  } catch {
    abort(2, `Cannot read migrations directory: ${MIGRATIONS_DIR.pathname}`)
  }
  const sqlFiles = names.filter((name) => name.endsWith('.sql')).sort()
  const migrations: MigrationFile[] = []
  const seen = new Map<number, string>()
  for (const name of sqlFiles) {
    const match = FILE_PATTERN.exec(name)
    if (!match) {
      abort(2, `Migration filename must look like 0002_add_column.sql: ${name}`)
    }
    const version = Number(match[1])
    const duplicate = seen.get(version)
    if (duplicate) {
      abort(2, `Two migrations share version ${version}: ${duplicate} and ${name}`)
    }
    seen.set(version, name)
    const sql = await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')
    migrations.push({
      version,
      name,
      sql,
      // Hash of the file bytes as committed. Hashing happens in memory: the
      // production root filesystem is read-only apart from /tmp.
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    })
  }
  return migrations
}

async function applyMigration(
  client: PoolClient,
  schema: string,
  migration: MigrationFile,
  appliedByValue: string,
  applied: Map<number, AppliedRow>,
): Promise<void> {
  const previous = applied.size === 0 ? 0 : Math.max(...applied.keys())
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('search_path', $1, true)", [schema])
    await client.query(migration.sql)
    await client.query(
      'INSERT INTO schema_version (version, checksum, applied_by) VALUES ($1, $2, $3)',
      [migration.version, migration.checksum, appliedByValue],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    const message = error instanceof Error ? error.message : String(error)
    abort(
      1,
      `Migration ${migration.name} failed and was rolled back. ` +
        `Database stayed at version ${previous}; schema_version was not advanced.\n` +
        `Cause: ${message}`,
    )
  }
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) abort(2, 'DATABASE_URL is required')

const schema = databaseSchema(connectionString)
const migrations = await loadMigrations()
const url = new URL(connectionString)
url.searchParams.delete('schema')
const actor = appliedBy()
const pool = new Pool({ connectionString: url.toString(), max: 1 })

try {
  const client = await pool.connect()
  try {
    // search_path matters for both the ledger lookup and the migration SQL: the
    // same rules as db:init, so ?schema= connections behave identically.
    await client.query("SELECT set_config('search_path', $1, false)", [schema])
    const { rows: present } = await client.query<{ present: string | null }>(
      "SELECT to_regclass('schema_version')::text AS present",
    )
    const applied = new Map<number, AppliedRow>()
    if (present[0].present) {
      const { rows } = await client.query<AppliedRow>(
        'SELECT version, checksum, applied_at, applied_by FROM schema_version ORDER BY version',
      )
      for (const row of rows) applied.set(row.version, row)
    }
    let appliedCount = 0
    let skipped = 0
    for (const migration of migrations) {
      const record = applied.get(migration.version)
      if (record) {
        if (record.checksum !== migration.checksum) {
          abort(
            1,
            `Checksum mismatch for ${migration.name} (version ${migration.version}).\n` +
              `  applied at : ${record.applied_at.toISOString()}\n` +
              `  applied by : ${record.applied_by}\n` +
              `  recorded   : ${record.checksum}\n` +
              `  on disk    : ${migration.checksum}\n` +
              `An already applied migration was edited. Never edit an applied file: ` +
              `add the next numbered migration instead.`,
          )
        }
        skipped += 1
        continue
      }
      await applyMigration(client, schema, migration, actor, applied)
      applied.set(migration.version, {
        version: migration.version,
        checksum: migration.checksum,
        applied_at: new Date(),
        applied_by: actor,
      })
      appliedCount += 1
      console.log(`Applied ${migration.name} (version ${migration.version}).`)
    }
    const current = applied.size === 0 ? 0 : Math.max(...applied.keys())
    console.log(
      `Schema version ${current}: ${appliedCount} applied, ${skipped} already applied, 0 pending.`,
    )
  } finally {
    client.release()
  }
} finally {
  await pool.end()
}
