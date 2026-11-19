import { cache } from 'react'
import { db } from './db'
import { settingsData } from './data'
import { tawkEmbedSrc } from '../tawk'

// Request-local memoization: layout and support blocks share one read.
// Only these public fields may cross the Server/Client Component boundary.
export const publicSupport = cache(async () => {
  const record = await db.setting.findUnique({ where: { id: 1 } })
  if (!record) return { supportEmail: '', sessionGuideUrl: undefined, tawkSrc: undefined, cryptoEnabled: false }
  const settings = settingsData(record.body)
  return {
    supportEmail: settings.supportEmail,
    sessionGuideUrl: settings.sessionGuideUrl,
    tawkSrc: tawkEmbedSrc(settings.tawk),
    // Same row as the rest of the support settings: no extra query. Drives the
    // crypto section on /help/payment so deployments without it stay silent.
    cryptoEnabled: settings.crypto === true,
  }
})
