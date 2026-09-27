const express = require('express')
const helmet = require('helmet')
const crypto = require('crypto')
const path = require('path')
const { verifyWebhookRequest, adminSecretMatches } = require('./security')
const { chooseRecipient, formatMessage, jidFor } = require('./format')

function buildServer({ config, whatsapp, store }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.json({
    limit: `${Math.max(1, Math.ceil(config.maxWebhookBodyBytes / 1024))}kb`,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8')
    },
  }))
  app.use(express.static(path.join(__dirname, '..', 'public')))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'SynthesisOne WhatsApp Bot', whatsapp: whatsapp.getState().status })
  })

  app.get('/api/status', (_req, res) => {
    res.json({ ok: true, whatsapp: whatsapp.getState() })
  })

  function requireAdmin(req, res, next) {
    const provided = req.headers['x-admin-secret'] || req.query.key
    if (!adminSecretMatches(provided, config.adminSecret)) {
      return res.status(401).json({ error: 'No autorizado' })
    }
    return next()
  }

  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')))

  app.get('/api/admin/status', requireAdmin, (_req, res) => {
    res.json({ ok: true, whatsapp: whatsapp.getState(), recentEvents: store.recent(20) })
  })

  app.get('/api/admin/qr', requireAdmin, (_req, res) => {
    const qr = whatsapp.getQrDataUrl()
    if (!qr) return res.status(404).json({ error: 'No hay QR disponible' })
    res.json({ ok: true, dataUrl: qr })
  })

  app.post('/api/admin/pairing-code', requireAdmin, async (req, res) => {
    try {
      const code = await whatsapp.requestPairingCode(req.body?.phone_number)
      res.json({ ok: true, code })
    } catch (error) {
      res.status(400).json({ error: error.message || 'No se pudo generar el código' })
    }
  })

  app.post('/api/admin/send-test', requireAdmin, async (req, res) => {
    try {
      const jid = jidFor(req.body?.phone_number, config.countryCode)
      const message = String(req.body?.message || '').trim()
      if (!jid || !message) return res.status(400).json({ error: 'phone_number y message son obligatorios' })
      const registered = await whatsapp.isRegisteredUser(jid)
      if (!registered) return res.status(400).json({ error: 'Ese número no aparece como usuario de WhatsApp' })
      const result = await whatsapp.sendMessage(jid, message)
      res.json({ ok: true, message_id: result?.id?._serialized || result?.id || null })
    } catch (error) {
      res.status(400).json({ error: error.message || 'No se pudo enviar el mensaje' })
    }
  })

  app.get('/api/admin/events', requireAdmin, (_req, res) => {
    res.json({ ok: true, events: store.recent(100) })
  })

  app.post('/webhook/synthesisone', async (req, res) => {
    try {
      const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {})
      const verification = verifyWebhookRequest({
        rawBody,
        headers: req.headers,
        secret: config.webhookSecret,
        toleranceSec: config.webhookTimestampToleranceSec,
      })
      if (!verification.ok) return res.status(401).json({ error: verification.error })

      const payload = req.body || {}
      const eventId = String(req.headers['x-webhook-event-id'] || payload.event_id || '').trim()
      if (!eventId) return res.status(400).json({ error: 'event_id requerido' })
      if (!payload.client?.id || !payload.transaction?.amount) {
        return res.status(400).json({ error: 'Payload SynthesisOne incompleto' })
      }

      if (store.hasEvent(eventId)) {
        return res.status(200).json({ ok: true, duplicate: true, event_id: eventId })
      }

      const recipient = chooseRecipient(payload, config)
      const message = formatMessage(payload, config)
      const record = {
        event_id: eventId,
        received_at: new Date().toISOString(),
        transaction_id: payload.transaction?.transaction_id || null,
        amount: Number(payload.transaction?.amount),
        currency: payload.transaction?.currency || null,
        direction: payload.transaction?.direction || null,
        recipient: recipient.number,
        sent: false,
        error: null,
      }

      if (!recipient.jid) {
        record.error = recipient.reason
        store.recordEvent(eventId, record)
        return res.status(202).json({ ok: true, queued: false, event_id: eventId, reason: recipient.reason })
      }

      const registered = await whatsapp.isRegisteredUser(recipient.jid)
      if (!registered) {
        record.error = 'WHATSAPP_USER_NOT_FOUND'
        store.recordEvent(eventId, record)
        return res.status(202).json({ ok: true, queued: false, event_id: eventId, reason: record.error })
      }

      const result = await whatsapp.sendMessage(recipient.jid, message)
      record.sent = true
      record.message_id = result?.id?._serialized || result?.id || null
      store.recordEvent(eventId, record)
      return res.status(200).json({ ok: true, event_id: eventId, sent: true, recipient: recipient.number, message_id: record.message_id })
    } catch (error) {
      console.error('❌ Error webhook SynthesisOne:', error)
      return res.status(500).json({ error: 'Error interno procesando webhook' })
    }
  })

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

  return app
}

module.exports = { buildServer }
