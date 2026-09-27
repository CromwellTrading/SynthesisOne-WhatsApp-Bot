const crypto = require('crypto')

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a || '').trim().toLowerCase(), 'utf8')
  const right = Buffer.from(String(b || '').trim().toLowerCase(), 'utf8')
  if (!left.length || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function hmacHex(body, secret) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

function verifyWebhookRequest({ rawBody, headers, secret, toleranceSec }) {
  const signatureV2 = String(headers['x-webhook-signature-v2'] || '').trim()
  const signatureLegacy = String(headers['x-webhook-signature'] || '').trim()
  const timestampRaw = String(headers['x-webhook-timestamp'] || '').trim()

  if (signatureV2) {
    const timestamp = Number(timestampRaw)
    if (!Number.isInteger(timestamp) || timestamp <= 0) {
      return { ok: false, error: 'Timestamp de webhook inválido' }
    }
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
    if (ageSec > toleranceSec) {
      return { ok: false, error: 'Webhook fuera de ventana de tiempo' }
    }
    const expected = hmacHex(`${timestamp}.${rawBody}`, secret)
    return timingSafeHexEqual(signatureV2, expected)
      ? { ok: true, version: 'v2', timestamp }
      : { ok: false, error: 'Firma de webhook inválida' }
  }

  if (signatureLegacy) {
    const expected = hmacHex(rawBody, secret)
    return timingSafeHexEqual(signatureLegacy, expected)
      ? { ok: true, version: 'legacy' }
      : { ok: false, error: 'Firma de webhook inválida' }
  }

  return { ok: false, error: 'Firma de webhook requerida' }
}

function adminSecretMatches(provided, expected) {
  return timingSafeHexEqual(
    crypto.createHash('sha256').update(String(provided || ''), 'utf8').digest('hex'),
    crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest('hex'),
  )
}

module.exports = { hmacHex, verifyWebhookRequest, adminSecretMatches }
