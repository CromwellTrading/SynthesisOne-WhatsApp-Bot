const express = require('express')
const helmet = require('helmet')
const path = require('path')
const { verifyWebhook, secretMatches } = require('./security')
const { jidFor, chooseRecipient, formatMessage } = require('./format')

function buildServer({ config, whatsapp, eventStore, sessionStore }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.json({
    limit: `${Math.ceil(config.maxWebhookBodyBytes / 1024)}kb`,
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') },
  }))
  app.use(express.static(path.join(__dirname, '..', 'public')))

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'SynthesisOne WhatsApp Bot', whatsapp: whatsapp.getState().status }))

  app.get(config.keepalivePath, (req, res) => {
    if (!secretMatches(req.query.token, config.keepaliveToken)) return res.status(401).json({ ok: false, error: 'No autorizado' })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, wake: true, at: new Date().toISOString() })
  })

  function requireAdmin(req, res, next) {
    if (!secretMatches(req.headers['x-admin-secret'] || req.query.key, config.adminSecret)) return res.status(401).json({ error: 'No autorizado' })
    next()
  }

  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')))

  app.get('/api/admin/status', requireAdmin, async (_req, res) => {
    try {
      const [remoteSession, events] = await Promise.all([
        sessionStore.status(`RemoteAuth-${config.clientId}`),
        eventStore.recent(20),
      ])
      res.json({ ok: true, whatsapp: whatsapp.getState(), remoteSession, recentEvents: events })
    } catch (error) { res.status(500).json({ error: error.message }) }
  })

  app.get('/api/admin/qr', requireAdmin, (_req, res) => {
    const qr = whatsapp.getQrDataUrl()
    if (!qr) return res.status(404).json({ error: 'No hay QR disponible' })
    res.json({ ok: true, dataUrl: qr })
  })

  app.post('/api/admin/pairing-code', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, code: await whatsapp.requestPairingCode(req.body?.phone_number) }) }
    catch (error) { res.status(400).json({ error: error.message || 'No se pudo generar el código' }) }
  })

  app.post('/api/admin/restart', requireAdmin, async (_req, res) => {
    try { await whatsapp.manualRestart(); res.json({ ok: true, whatsapp: whatsapp.getState() }) }
    catch (error) { res.status(500).json({ error: error.message || 'No se pudo reiniciar' }) }
  })

  app.post('/api/admin/send-test', requireAdmin, async (req, res) => {
    try {
      const jid = jidFor(req.body?.phone_number, config.countryCode)
      const message = String(req.body?.message || '').trim()
      if (!jid || !message) return res.status(400).json({ error: 'phone_number y message son obligatorios' })
      if (!(await whatsapp.isRegisteredUser(jid))) return res.status(400).json({ error: 'El número no aparece como usuario de WhatsApp' })
      const sent = await whatsapp.sendMessage(jid, message)
      res.json({ ok: true, message_id: sent?.id?._serialized || sent?.id || null })
    } catch (error) { res.status(400).json({ error: error.message || 'No se pudo enviar' }) }
  })

  app.get('/api/admin/events', requireAdmin, async (_req, res) => {
    try { res.json({ ok: true, events: await eventStore.recent(100) }) }
    catch (error) { res.status(500).json({ error: error.message }) }
  })

  app.post('/webhook/synthesisone', async (req, res) => {
    try {
      const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {})
      const verified = verifyWebhook({ body: rawBody, headers: req.headers, secret: config.webhookSecret, toleranceSec: config.webhookTimestampToleranceSec })
      if (!verified.ok) return res.status(401).json({ error: verified.error })

      const payload = req.body || {}
      const eventId = String(req.headers['x-webhook-event-id'] || payload.event_id || '').trim()
      if (!eventId) return res.status(400).json({ error: 'event_id requerido' })
      if (!payload.client?.id || payload.transaction?.amount == null) return res.status(400).json({ error: 'Payload incompleto' })

      const recipient = chooseRecipient(payload, config)
      const message = formatMessage(payload, config)
      const begun = await eventStore.begin(eventId, {
        received_at: new Date().toISOString(),
        transaction_id: payload.transaction?.transaction_id || null,
        amount: Number(payload.transaction?.amount),
        currency: payload.transaction?.currency || null,
        direction: payload.transaction?.direction || null,
        recipient: recipient.number,
      })
      if (begun.duplicate) return res.status(200).json({ ok: true, duplicate: true, event_id: eventId, status: begun.record?.status || 'PROCESSING' })

      if (!recipient.jid) {
        await eventStore.markFailed(eventId, recipient.reason)
        return res.status(202).json({ ok: true, event_id: eventId, sent: false, reason: recipient.reason })
      }

      try {
        if (!(await whatsapp.isRegisteredUser(recipient.jid))) {
          await eventStore.markFailed(eventId, 'WHATSAPP_USER_NOT_FOUND')
          return res.status(202).json({ ok: true, event_id: eventId, sent: false, reason: 'WHATSAPP_USER_NOT_FOUND' })
        }
        const sent = await whatsapp.sendMessage(recipient.jid, message)
        const messageId = sent?.id?._serialized || sent?.id || null
        await eventStore.markSent(eventId, { message_id: messageId, recipient: recipient.number })
        return res.status(200).json({ ok: true, event_id: eventId, sent: true, recipient: recipient.number, message_id: messageId })
      } catch (error) {
        await eventStore.markFailed(eventId, error.message || 'Error enviando WhatsApp')
        throw error
      }
    } catch (error) {
      console.error('❌ Webhook SynthesisOne:', error)
      res.status(500).json({ error: 'Error interno procesando webhook' })
    }
  })

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
  return app
}

module.exports = { buildServer }
