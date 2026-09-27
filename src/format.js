function normalizeWhatsAppNumber(input, countryCode = '53') {
  let digits = String(input || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith(countryCode)) return digits
  if (digits.length === 8 && countryCode === '53') return `${countryCode}${digits}`
  return digits
}

function jidFor(number, countryCode) {
  const normalized = normalizeWhatsAppNumber(number, countryCode)
  return normalized ? `${normalized}@c.us` : null
}

function money(amount, currency) {
  const numeric = Number(amount)
  if (!Number.isFinite(numeric)) return '—'
  return `${numeric.toLocaleString('es-CU', { maximumFractionDigits: 2 })} ${currency || 'CUP'}`
}

function isLicensePurchase(transaction, config) {
  const amount = Number(transaction?.amount)
  const expected = Number(config.licensePriceAmount)
  if (!expected || !Number.isFinite(amount) || amount !== expected) return false
  if (String(transaction?.currency || '').toUpperCase() !== config.licenseCurrency) return false
  const receiver = String(transaction?.receiver_account || '').trim()
  if (!config.licenseReceiverAccounts.length) return true
  return config.licenseReceiverAccounts.includes(receiver)
}

function chooseRecipient(payload, config) {
  const transaction = payload?.transaction || {}
  const candidate = transaction.sender_phone || payload?.client?.phone_number || null
  const normalized = normalizeWhatsAppNumber(candidate, config.countryCode)
  if (!normalized) return { number: null, reason: 'NO_RECIPIENT_PHONE' }
  if (config.cubaOnlyRecipients && !normalized.startsWith(config.countryCode)) {
    return { number: null, reason: 'NON_CUBA_RECIPIENT_BLOCKED' }
  }
  return { number: normalized, jid: `${normalized}@c.us` }
}

function formatMessage(payload, config) {
  const tx = payload?.transaction || {}
  const client = payload?.client || {}
  const direction = String(tx.direction || '').toUpperCase()
  const isLicense = isLicensePurchase(tx, config)
  const date = tx.transaction_at || payload?.occurred_at || payload?.sms?.received_at || null
  const lines = []

  if (isLicense) {
    lines.push('✅ *Se ha detectado un pago asociado a este número*', '')
    lines.push('*Usted ha comprado la licencia de SynthesisOne.*', '')
  } else if (direction === 'RECIBIDO') {
    lines.push('✅ *Se ha detectado un pago asociado a este número*', '')
    lines.push('*Se ha detectado una transferencia recibida.*', '')
  } else {
    lines.push('✅ *Se ha detectado una transferencia asociada a este número*', '')
    lines.push('*Transferencia saliente detectada.*', '')
  }

  lines.push(`💰 *Importe:* ${money(tx.amount, tx.currency)}`)
  if (tx.receiver_account) lines.push(`💳 *Cuenta receptora:* ${tx.receiver_account}`)
  if (tx.sender_phone) lines.push(`📱 *Número asociado:* ${tx.sender_phone}`)
  if (tx.network) lines.push(`🏦 *Método:* ${tx.network}`)
  if (tx.transaction_id) lines.push(`🧾 *N.º de operación:* ${tx.transaction_id}`)
  if (date) lines.push(`🕐 *Fecha:* ${date}`)
  if (client.name) lines.push(`👤 *Cliente SynthesisOne:* ${client.name}`)
  lines.push('', '✅ *Pago detectado correctamente.*', '', '_Mensaje automático de SynthesisOne._')
  return lines.join('\n')
}

module.exports = { normalizeWhatsAppNumber, jidFor, formatMessage, chooseRecipient, isLicensePurchase }
