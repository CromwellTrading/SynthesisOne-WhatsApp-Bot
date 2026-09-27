const path = require('path')

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Falta la variable de entorno ${name}`)
  return value
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function loadConfig() {
  const dataDir = String(process.env.DATA_DIR || path.join(process.cwd(), 'data')).trim()
  const authDir = String(process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), '.wwebjs_auth')).trim()

  return {
    port: Number(process.env.PORT || 10000),
    adminSecret: required('ADMIN_SECRET'),
    webhookSecret: required('SYNTHESISONE_WEBHOOK_SECRET'),
    countryCode: String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '53').replace(/\D/g, '') || '53',
    authDir,
    dataDir,
    clientId: String(process.env.WHATSAPP_CLIENT_ID || 'synthesisone').trim() || 'synthesisone',
    chromiumPath: String(process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium').trim(),
    webhookTimestampToleranceSec: Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SEC || 300),
    maxWebhookBodyBytes: Number(process.env.MAX_WEBHOOK_BODY_BYTES || 131072),
    licensePriceAmount: Number(process.env.LICENSE_PRICE_AMOUNT || 0),
    licenseCurrency: String(process.env.LICENSE_CURRENCY || 'CUP').trim().toUpperCase(),
    licenseReceiverAccounts: csv(process.env.LICENSE_RECEIVER_ACCOUNTS),
    cubaOnlyRecipients: String(process.env.CUBA_ONLY_RECIPIENTS || 'false').toLowerCase() === 'true',
  }
}

module.exports = { loadConfig }
