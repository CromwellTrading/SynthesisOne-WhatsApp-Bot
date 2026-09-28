function normalizeWhatsAppNumber(input, countryCode = '53') {
  let digits = String(input || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith(countryCode)) return digits
  if (countryCode === '53' && digits.length === 8) return `${countryCode}${digits}`
  return digits
}

function jidFor(input, countryCode) {
  const number = normalizeWhatsAppNumber(input, countryCode)
  return number ? `${number}@c.us` : null
}

function money(amount, currency) {
  const value = Number(amount)
  return Number.isFinite(value) ? `${value.toLocaleString('es-CU', { maximumFractionDigits: 2 })} ${currency || 'CUP'}` : '—'
}

function isLicensePurchase(tx, config) {
  const amount = Number(tx?.amount)
  if (!Number.isFinite(amount) || amount !== Number(config.licensePriceAmount)) return false
  if (String(tx?.currency || '').toUpperCase() !== config.licenseCurrency) return false
  if (!config.licenseReceiverAccounts.length) return true
  return config.licenseReceiverAccounts.includes(String(tx?.receiver_account || '').trim())
}

function chooseRecipient(payload, config) {
  const tx = payload?.transaction || {}
  const candidate = tx.sender_phone || payload?.client?.phone_number
  const number = normalizeWhatsAppNumber(candidate, config.countryCode)
  if (!number) return { number: null, jid: null, reason: 'NO_RECIPIENT_PHONE' }
  if (config.cubaOnlyRecipients && !number.startsWith(config.countryCode)) return { number, jid: null, reason: 'NON_CUBA_RECIPIENT_BLOCKED' }
  return { number, jid: `${number}@c.us`, reason: null }
}

function formatMessage(payload, config) {
  const tx = payload?.transaction || {}
  const client = payload?.client || {}
  const license = isLicensePurchase(tx, config)
  const date = tx.transaction_at || payload?.occurred_at || payload?.sms?.received_at
  const lines = []

  if (license) {
    lines.push('✅ *Se ha detectado un pago asociado a este número*', '', '*Usted ha comprado la licencia de SynthesisOne.*', '')
  } else if (String(tx.direction || '').toUpperCase() === 'RECIBIDO') {
    lines.push('✅ *Se ha detectado un pago asociado a este número*', '', '*Se ha detectado una transferencia recibida.*', '')
  } else {
    lines.push('✅ *Se ha detectado una transferencia asociada a este número*', '', '*Transferencia saliente detectada.*', '')
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

module.exports = { normalizeWhatsAppNumber, jidFor, isLicensePurchase, chooseRecipient, formatMessage }
