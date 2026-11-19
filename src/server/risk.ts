import { db, transaction, type DbClient } from './db'
import { incrementRateLimit } from './database-sql'
import { id, secretHash } from './crypto'
import { ApiError, appUrl, demo } from './config'
import {
  decideRisk,
  riskLimits,
  riskVersion,
  type RiskDecision,
  type RiskFacts,
  type RiskScene,
  type RiskSubjects,
  type RiskLimit,
} from './risk-policy'
import { turnstilePublic, verifyTurnstileResult, type VerificationScene } from './turnstile'
import { integration } from './integrations/config'

export function riskDigest(dimension: string, value: string) {
  return secretHash(`risk:${dimension}\0${value}`)
}

export function payoutFingerprint(method: string, network: string | null, account: string) {
  let normalized = account.trim()
  // EVM hex addresses are case-insensitive; TRON/Base58 addresses are not.
  if (method === 'USDT' && network !== 'TRC20') normalized = normalized.toLowerCase()
  return riskDigest('payout', JSON.stringify([method, network, normalized]))
}

function privateSubjects(subjects: RiskSubjects) {
  return Object.fromEntries(
    Object.entries(subjects)
      .filter(([, value]) => Boolean(value))
      .map(([dimension, value]) => [dimension, riskDigest(dimension, value!)]),
  )
}

// Payment anomalies found while confirming a provider receipt. Kept separate from
// recordRisk (which takes a decision produced by the rules engine): these are
// fixed verdicts, and without them a "callback says paid, gateway disagrees"
// event would leave no trace outside a console line.
export async function recordPaymentAnomaly(
  kind: string,
  facts: object,
  orderId?: string,
  client: DbClient = db,
) {
  await client.riskEvent.create({
    data: {
      id: id('risk_'),
      scene: 'payment',
      action: 'review',
      effectiveAction: 'review',
      mode: 'enforce',
      ruleVersion: riskVersion,
      reasonCodes: [kind],
      subjects: {},
      facts: JSON.parse(JSON.stringify(facts)),
      referenceId: orderId,
    },
  })
}

export async function recordRisk(
  scene: string,
  decision: RiskDecision,
  facts: object,
  subjects: RiskSubjects = {},
  referenceId?: string,
  client: DbClient = db,
) {
  await client.riskEvent.create({
    data: {
      id: id('risk_'),
      scene,
      action: decision.action,
      effectiveAction: decision.mode === 'observe' ? 'allow' : decision.action,
      mode: decision.mode,
      ruleVersion: riskVersion,
      reasonCodes: decision.reason ? [decision.reason] : [],
      subjects: privateSubjects(subjects),
      facts: JSON.parse(JSON.stringify(facts)),
      referenceId,
    },
  })
}

function counterKey(rule: RiskLimit, value: string) {
  return `risk:${rule.prefix}:${rule.dimension}:${riskDigest(rule.dimension, value)}`
}

export async function checkRiskRate(scene: RiskScene, subjects: RiskSubjects) {
  const rules = await riskLimits(scene, demo)
  const checks = rules.flatMap((rule) => {
    const value = rule.dimension === 'global' ? 'global' : subjects[rule.dimension]
    if (!value) {
      if (rule.required) throw new ApiError(503, '安全检查缺少必要信息，请重试')
      return []
    }
    return [{ rule, key: counterKey(rule, value) }]
  })
  // Commit counters even for rejected requests. All dimensions use the same DB clock,
  // deterministic lock order and one transaction, including multi-process callers.
  const counts = await transaction(async (client) => {
    const collected = []
    for (const check of checks.sort((a, b) => a.key.localeCompare(b.key))) {
      collected.push({
        rule: check.rule,
        count: await incrementRateLimit(check.key, check.rule.seconds, client),
      })
    }
    return collected
  })
  let denied = false
  for (const { rule, count } of counts) {
    const decision = await decideRisk({ kind: 'rate', count, ...rule })
    if (decision.action === 'allow') continue
    await recordRisk(
      scene,
      decision,
      {
        dimension: rule.dimension,
        count,
        limit: rule.limit,
        seconds: rule.seconds,
      },
      subjects,
    )
    denied ||= decision.mode === 'enforce' && decision.action === 'deny'
  }
  if (denied) throw new ApiError(429, '操作太频繁，请稍后再试')
}

export async function checkRiskChallenge(scene: VerificationScene, token: unknown) {
  const config = await turnstilePublic()
  const facts = { kind: 'challenge' as const, required: config[scene], verified: false }
  const decision = await decideRisk(facts)
  if (decision.action === 'allow') return
  try {
    const privateConfig = await integration('turnstile')
    await verifyTurnstileResult(privateConfig.secret, token, scene, new URL(appUrl).hostname)
  } catch (error) {
    await recordRisk(`challenge:${scene}`, decision, facts)
    throw error
  }
}

// Called inside the business transaction so facts, decision and state changes agree.
export async function assessRisk(
  scene: string,
  facts: RiskFacts,
  subjects: RiskSubjects,
  referenceId: string,
  client: DbClient,
) {
  const decision = await decideRisk(facts)
  await recordRisk(scene, decision, facts, subjects, referenceId, client)
  return decision
}

// A rejection after upstream preflight must roll back inventory/quote changes.
// Persist its evidence only after that rollback completes.
export class RiskRejection extends ApiError {
  constructor(
    public scene: string,
    public decision: RiskDecision,
    public facts: RiskFacts,
    public subjects: RiskSubjects,
    public referenceId: string,
  ) {
    super(403, '未支付订单过多，请先完成或取消已有订单；如需帮助请联系支持')
  }
}

export async function recordRiskRejection(error: unknown): Promise<never> {
  if (error instanceof RiskRejection)
    await recordRisk(error.scene, error.decision, error.facts, error.subjects, error.referenceId)
  throw error
}
