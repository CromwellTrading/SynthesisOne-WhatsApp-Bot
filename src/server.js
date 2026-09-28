const express = require('express')
const helmet = require('helmet')
const path = require('path')
const { verifyWebhook, secretMatches } = require('./security')
const { jidFor, chooseRecipient, formatMessage } = require('./format')

function buildServer({ config, whatsapp, eventStore, sessionStore, diagnostics }) {
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
    diagnostics?.info('keepalive', 'Wakeup recibido desde Render')
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
      res.json({ ok: true, whatsapp: whatsapp.getState(), remoteSession, recentEvents: events, diagnosticLogs: whatsapp.getDiagnosticLogs(300) })
    } catch (error) {
      diagnostics?.error('admin_status_error', error.message || String(error))
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/admin/diagnostics', requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000)
    res.json({ ok: true, generatedAt: new Date().toISOString(), logs: whatsapp.getDiagnosticLogs(limit), whatsapp: whatsapp.getState() })
  })

  app.post('/api/admin/diagnostics/clear', requireAdmin, (_req, res) => {
    diagnostics?.clear()
    diagnostics?.info('diagnostics_cleared', 'Historial del servidor borrado manualmente desde el panel')
    res.json({ ok: true })
  })

  app.get('/api/admin/qr', requireAdmin, (_req, res) => {
    const qr = whatsapp.getQrDataUrl()
    if (!qr) return res.status(404).json({ error: 'No hay QR disponible' })
    res.json({ ok: true, dataUrl: qr })
  })

  app.post('/api/admin/pairing-code', requireAdmin, async (req, res) => {
    try {
      diagnostics?.info('admin_pairing_requested', 'Solicitud de código de vinculación desde el panel', { digitsLength: String(req.body?.phone_number || '').replace(/\D/g, '').length })
      res.json({ ok: true, code: await whatsapp.requestPairingCode(req.body?.phone_number) })
    } catch (error) {
      diagnostics?.error('admin_pairing_error', error.message || String(error))
      res.status(400).json({ error: error.message || 'No se pudo generar el código' })
    }
  })

  app.post('/api/admin/restart', requireAdmin, async (_req, res) => {
    try { await whatsapp.manualRestart(); res.json({ ok: true, whatsapp: whatsapp.getState() }) }
    catch (error) { diagnostics?.error('admin_restart_error', error.message || String(error)); res.status(500).json({ error: error.message || 'No se pudo reiniciar' }) }
  })

  app.post('/api/admin/send-test', requireAdmin, async (req, res) => {
    try {
      const jid = jidFor(req.body?.phone_number, config.countryCode)
      const message = String(req.body?.message || '').trim()
      if (!jid || !message) return res.status(400).json({ error: 'phone_number y message son obligatorios' })
      diagnostics?.info('admin_send_test_start', 'Envío de mensaje de prueba solicitado', { jid, messageLength: message.length })
      if (!(await whatsapp.isRegisteredUser(jid))) return res.status(400).json({ error: 'El número no aparece como usuario de WhatsApp' })
      const sent = await whatsapp.sendMessage(jid, message)
      diagnostics?.info('admin_send_test_done', 'Mensaje de prueba enviado', { jid, messageId: sent?.id?._serialized || sent?.id || null })
      res.json({ ok: true, message_id: sent?.id?._serialized || sent?.id || null })
    } catch (error) { diagnostics?.error('admin_send_test_error', error.message || String(error)); res.status(400).json({ error: error.message || 'No se pudo enviar' }) }
  })

  app.get('/api/admin/events', requireAdmin, async (_req, res) => {
    try { res.json({ ok: true, events: await eventStore.recent(100) }) }
    catch (error) { diagnostics?.error('admin_events_error', error.message || String(error)); res.status(500).json({ error: error.message }) }
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

      diagnostics?.info('webhook_received', 'Webhook SynthesisOne recibido', { eventId, amount: payload.transaction?.amount, event: payload.event || null })
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
        diagnostics?.warn('webhook_no_recipient', 'No se pudo determinar un destinatario WhatsApp', { eventId, reason: recipient.reason })
        return res.status(202).json({ ok: true, event_id: eventId, sent: false, reason: recipient.reason })
      }

      try {
        if (!(await whatsapp.isRegisteredUser(recipient.jid))) {
          await eventStore.markFailed(eventId, 'WHATSAPP_USER_NOT_FOUND')
          diagnostics?.warn('webhook_user_not_found', 'El destinatario no figura como usuario de WhatsApp', { eventId, jid: recipient.jid })
          return res.status(202).json({ ok: true, event_id: eventId, sent: false, reason: 'WHATSAPP_USER_NOT_FOUND' })
        }
        const sent = await whatsapp.sendMessage(recipient.jid, message)
        const messageId = sent?.id?._serialized || sent?.id || null
        await eventStore.markSent(eventId, { message_id: messageId, recipient: recipient.number })
        diagnostics?.info('webhook_whatsapp_sent', 'Mensaje de webhook enviado por WhatsApp', { eventId, jid: recipient.jid, messageId })
        return res.status(200).json({ ok: true, event_id: eventId, sent: true, recipient: recipient.number, message_id: messageId })
      } catch (error) {
        await eventStore.markFailed(eventId, error.message || 'Error enviando WhatsApp')
        diagnostics?.error('webhook_whatsapp_error', error.message || 'Error enviando WhatsApp', { eventId, stack: error.stack })
        throw error
      }
    } catch (error) {
      console.error('❌ Webhook SynthesisOne:', error)
      diagnostics?.error('webhook_internal_error', error.message || 'Error interno procesando webhook', { stack: error.stack })
      res.status(500).json({ error: 'Error interno procesando webhook' })
    }
  })

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
  return app
}

module.exports = { buildServer }
