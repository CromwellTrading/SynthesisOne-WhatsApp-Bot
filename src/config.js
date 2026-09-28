const path = require('path')

function requiredAny(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim()
    if (value) return value
  }
  throw new Error(`Falta una variable de entorno: ${names.join(' o ')}`)
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeSupabaseUrl(raw) {
  const input = String(raw || '').trim()
  if (!input) throw new Error('Falta SUPABASE_URL')

  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('SUPABASE_URL inválida. Debe ser la Project URL, por ejemplo: https://TU-PROYECTO.supabase.co')
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('SUPABASE_URL inválida. Debe comenzar con https://')
  }

  const pathValue = url.pathname.replace(/\/+$/, '')
  const removableSuffixes = ['/rest/v1', '/storage/v1', '/auth/v1']
  for (const suffix of removableSuffixes) {
    if (pathValue === suffix) {
      url.pathname = '/'
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    }
  }

  if (pathValue !== '') {
    throw new Error('SUPABASE_URL contiene una ruta adicional. Usa solamente la Project URL de Supabase, sin /rest/v1, /storage/v1, /auth/v1 ni /dashboard/...')
  }

  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function loadConfig() {
  const encryptionHex = requiredAny('WHATSAPP_SESSION_ENCRYPTION_KEY').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(encryptionHex)) {
    throw new Error('WHATSAPP_SESSION_ENCRYPTION_KEY debe tener exactamente 64 caracteres hexadecimales')
  }

  const port = Number(process.env.PORT || 10000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido')

  const target = String(process.env.KEEPALIVE_TARGET_URL || process.env.RENDER_EXTERNAL_URL || '').trim()
  if (process.env.KEEPALIVE_TARGET_URL !== undefined && !target) throw new Error('KEEPALIVE_TARGET_URL vacío')

  return {
    port,
    adminSecret: requiredAny('ADMIN_SECRET'),
    webhookSecret: requiredAny('SYNTHESISONE_WEBHOOK_SECRET'),
    supabaseUrl: normalizeSupabaseUrl(requiredAny('SUPABASE_URL')),
    supabaseKey: requiredAny('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    storageBucket: String(process.env.SUPABASE_STORAGE_BUCKET || 'whatsapp-sessions').trim(),
    sessionEncryptionKey: Buffer.from(encryptionHex, 'hex'),
    countryCode: String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '53').replace(/\D/g, '') || '53',
    authDir: String(process.env.WHATSAPP_AUTH_DIR || path.join('/tmp', '.wwebjs_auth')).trim(),
    clientId: String(process.env.WHATSAPP_CLIENT_ID || 'synthesisone').trim(),
    chromiumPath: String(process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium').trim(),
    backupSyncIntervalMs: Math.max(60000, Number(process.env.WHATSAPP_BACKUP_SYNC_INTERVAL_MS || 300000)),
    webhookTimestampToleranceSec: Math.max(30, Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SEC || 300)),
    maxWebhookBodyBytes: Math.max(4096, Number(process.env.MAX_WEBHOOK_BODY_BYTES || 131072)),
    licensePriceAmount: Number(process.env.LICENSE_PRICE_AMOUNT || 0),
    licenseCurrency: String(process.env.LICENSE_CURRENCY || 'CUP').trim().toUpperCase(),
    licenseReceiverAccounts: csv(process.env.LICENSE_RECEIVER_ACCOUNTS),
    cubaOnlyRecipients: String(process.env.CUBA_ONLY_RECIPIENTS || 'false').toLowerCase() === 'true',
    keepaliveToken: requiredAny('KEEPALIVE_TOKEN'),
    keepalivePath: String(process.env.KEEPALIVE_PATH || '/wake').trim() || '/wake',
    keepaliveTargetUrl: target,
  }
}

module.exports = { loadConfig, normalizeSupabaseUrl }
