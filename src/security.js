const crypto = require('crypto')

function safeEqual(a, b) {
  const left = Buffer.from(String(a || '').trim(), 'utf8')
  const right = Buffer.from(String(b || '').trim(), 'utf8')
  if (!left.length || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function hmacHex(value, secret) {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

function verifyWebhook({ body, headers, secret, toleranceSec }) {
  const sigV2 = String(headers['x-webhook-signature-v2'] || '').trim()
  const sig = String(headers['x-webhook-signature'] || '').trim()
  const timestamp = String(headers['x-webhook-timestamp'] || '').trim()

  if (sigV2) {
    const unix = Number(timestamp)
    if (!Number.isInteger(unix) || unix <= 0) return { ok: false, error: 'Timestamp inválido' }
    if (Math.abs(Math.floor(Date.now() / 1000) - unix) > toleranceSec) return { ok: false, error: 'Webhook fuera de ventana de tiempo' }
    const expected = hmacHex(`${unix}.${body}`, secret)
    return safeEqual(sigV2, expected) ? { ok: true, version: 'v2' } : { ok: false, error: 'Firma inválida' }
  }

  if (sig) {
    const expected = hmacHex(body, secret)
    return safeEqual(sig, expected) ? { ok: true, version: 'legacy' } : { ok: false, error: 'Firma inválida' }
  }

  return { ok: false, error: 'Firma requerida' }
}

function secretMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || ''), 'utf8').digest()
  const b = crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

module.exports = { hmacHex, verifyWebhook, secretMatches }
