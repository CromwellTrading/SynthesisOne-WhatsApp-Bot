const fs = require('fs/promises')
const { Client, RemoteAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')

class WhatsAppManager {
  constructor(config, sessionStore, logger) {
    this.config = config
    this.sessionStore = sessionStore
    this.logger = logger
    this.client = null
    this.sessionName = `RemoteAuth-${config.clientId}`
    this.starting = false
    this.restartTimer = null
    this.readyWatchdog = null
    this.diagnosticTimer = null
    this.pageAttached = false
    this.lastProbeSignature = null
    this.backoffMs = 5000
    this.state = {
      status: 'STOPPED', ready: false, authenticated: false,
      phone: null, pushname: null, whatsappState: null, wwebVersion: null,
      hasQr: false, hasPairingCode: false, lastError: null, lastDisconnect: null,
      lastEvent: null, lastEventAt: null, restartCount: 0,
      remoteSessionExists: false, lastRemoteSessionSavedAt: null,
      browserConnected: null, pageClosed: null, pageUrlHost: null, pageTitle: null,
      updatedAt: new Date().toISOString(),
    }
  }

  log(level, event, message = '', data) {
    if (typeof this.logger?.[level] === 'function') this.logger[level](event, message, data)
  }

  update(patch) { this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() } }

  note(event, patch = {}, message = '', data = undefined) {
    this.update({ lastEvent: event, lastEventAt: new Date().toISOString(), ...patch })
    this.log('info', event, message || `Evento WhatsApp: ${event}`, { state: patch.status || this.state.status, whatsappState: patch.whatsappState || this.state.whatsappState, ...data })
  }

  getState() { return { ...this.state } }
  getQrDataUrl() { return this._qrDataUrl || null }
  getPairingCode() { return this._pairingCode || null }
  getDiagnosticLogs(limit = 500) { return this.logger?.recent(limit) || [] }

  async refreshRemoteState({ logResult = true } = {}) {
    try {
      const status = await this.sessionStore.status(this.sessionName)
      this.update({ remoteSessionExists: Boolean(status.exists), lastRemoteSessionSavedAt: status.metadata?.saved_at || this.state.lastRemoteSessionSavedAt })
      if (logResult) this.log('info', 'remote_state_refresh', status.exists ? 'Hay sesión remota guardada' : 'No hay sesión remota guardada', { exists: Boolean(status.exists), saved_at: status.metadata?.saved_at || null, lastError: status.lastError || null })
      return status
    } catch (error) {
      this.update({ lastError: `RemoteAuth: ${error.message || String(error)}` })
      this.log('error', 'remote_state_refresh_error', error.message || String(error), { code: error.code, status: error.status, statusCode: error.statusCode })
      return null
    }
  }

  async refreshDiagnostics({ logProbe = false } = {}) {
    if (!this.client) return null
    let whatsappState = null
    let wwebVersion = null
    let browserConnected = null
    let pageClosed = null
    let pageUrlHost = null
    let pageTitle = null
    let localArchive = null
    let clientInfo = null

    try { whatsappState = await this.client.getState() } catch (error) { whatsappState = `ERROR:${error.message || String(error)}` }
    try { wwebVersion = await this.client.getWWebVersion() } catch { /* no-op */ }
    try { browserConnected = Boolean(this.client.pupBrowser?.isConnected?.()) } catch { /* no-op */ }
    try {
      const page = this.client.pupPage
      pageClosed = page ? Boolean(page.isClosed()) : null
      if (page && !page.isClosed()) {
        try {
          const url = new URL(page.url())
          pageUrlHost = url.host || null
        } catch { pageUrlHost = null }
        try { pageTitle = await page.title() } catch { /* no-op */ }
      }
    } catch { /* no-op */ }
    try {
      const archive = `${this.config.authDir}/${this.sessionName}.zip`
      const stat = await fs.stat(archive)
      localArchive = { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
    } catch { localArchive = { exists: false } }
    try {
      const info = this.client.info
      if (info) clientInfo = {
        wid: info.wid?.user || null,
        pushname: info.pushname || null,
        platform: info.platform || null,
      }
    } catch { /* no-op */ }

    this.update({ whatsappState, wwebVersion, browserConnected, pageClosed, pageUrlHost, pageTitle })
    const snapshot = { whatsappState, wwebVersion, browserConnected, pageClosed, pageUrlHost, pageTitle, localArchive, clientInfo, ready: this.state.ready, authenticated: this.state.authenticated, status: this.state.status, remoteSessionExists: this.state.remoteSessionExists }
    const signature = JSON.stringify(snapshot)
    if (logProbe && signature !== this.lastProbeSignature) {
      this.lastProbeSignature = signature
      this.log('info', 'diagnostic_probe', 'Sondeo detallado del estado de WhatsApp', snapshot)
    }
    return snapshot
  }

  async attachPageDiagnostics() {
    const page = this.client?.pupPage
    if (!page || this.pageAttached) return false
    this.pageAttached = true
    this.log('info', 'puppeteer_page_attached', 'Conectado al objeto de página de WhatsApp Web')

    page.on('pageerror', (error) => {
      this.log('error', 'pageerror', 'Error JavaScript dentro de WhatsApp Web', { name: error?.name, message: error?.message, stack: error?.stack })
    })
    page.on('console', (msg) => {
      const type = msg?.type?.() || 'log'
      if (type === 'error' || type === 'warning') this.log(type === 'error' ? 'error' : 'warn', 'web_console', `WhatsApp Web console ${type}`, { type, text: msg?.text?.() })
    })
    page.on('requestfailed', (request) => {
      const failure = request?.failure?.()
      this.log('warn', 'request_failed', 'Una solicitud de WhatsApp Web falló', { method: request?.method?.(), resourceType: request?.resourceType?.(), errorText: failure?.errorText || null })
    })
    page.on('close', () => {
      this.log('warn', 'page_closed', 'La página de WhatsApp Web se cerró inesperadamente')
      this.update({ pageClosed: true, browserConnected: Boolean(this.client?.pupBrowser?.isConnected?.()) })
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        try {
          const url = new URL(frame.url())
          this.update({ pageUrlHost: url.host || null })
          this.log('info', 'main_frame_navigated', 'Cambió la navegación principal de WhatsApp Web', { host: url.host || null })
        } catch { /* no-op */ }
      }
    })
    return true
  }

  startDiagnosticProbe() {
    clearInterval(this.diagnosticTimer)
    this.diagnosticTimer = setInterval(async () => {
      if (!this.client || this.state.ready) return
      await this.attachPageDiagnostics()
      await this.refreshDiagnostics({ logProbe: true })
      await this.refreshRemoteState({ logResult: false })
    }, 10000)
  }

  stopDiagnosticProbe() {
    clearInterval(this.diagnosticTimer)
    this.diagnosticTimer = null
  }

  startReadyWatchdog() {
    clearTimeout(this.readyWatchdog)
    this.log('info', 'ready_watchdog_started', 'Watchdog READY iniciado: 90 segundos')
    this.readyWatchdog = setTimeout(async () => {
      if (!this.client || this.state.ready) return
      await this.attachPageDiagnostics()
      const snapshot = await this.refreshDiagnostics({ logProbe: true })
      await this.refreshRemoteState({ logResult: true })
      this.log('warn', 'ready_watchdog_timeout', 'WhatsApp no llegó a READY dentro de 90 segundos', snapshot)
      console.warn(`⚠️ WhatsApp no llega a READY. Estado=${this.state.whatsappState || 'desconocido'}`)
      if (this.state.authenticated && !this.state.ready) this.scheduleRestart('AUTHENTICATED_NOT_READY')
    }, 90000)
  }

  createClient() {
    const client = new Client({
      authStrategy: new RemoteAuth({
        clientId: this.config.clientId,
        dataPath: this.config.authDir,
        store: this.sessionStore,
        backupSyncIntervalMs: this.config.backupSyncIntervalMs,
        rmMaxRetries: 6,
      }),
      puppeteer: {
        headless: true,
        executablePath: this.config.chromiumPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
      },
      restartOnAuthFail: false,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    })

    const current = () => this.client === client
    this.log('info', 'client_created', 'Cliente whatsapp-web.js creado', { clientId: this.config.clientId, authDir: this.config.authDir, chromiumPath: this.config.chromiumPath, takeoverOnConflict: true })

    client.on('qr', async (qr) => {
      if (!current()) return
      this._qrDataUrl = await qrcode.toDataURL(qr)
      this.note('qr', { status: 'QR_REQUIRED', ready: false, authenticated: false, hasQr: true, hasPairingCode: false, lastError: null }, 'QR generado; esperando vinculación')
      await this.attachPageDiagnostics()
      await this.refreshDiagnostics({ logProbe: true })
    })

    client.on('code', (code) => {
      if (!current()) return
      this._pairingCode = code
      this.note('code', { status: 'PAIRING_CODE_READY', hasQr: false, hasPairingCode: true, lastError: null }, 'Código de vinculación generado', { codeLength: String(code || '').length })
      console.log(`🔢 Código de vinculación generado: ${code}`)
    })

    client.on('loading_screen', (percent, message) => {
      if (!current()) return
      this.note('loading_screen', { status: 'AUTHENTICATING', lastError: null }, `WhatsApp Web cargando ${percent}%`, { percent, message: message || '' })
      console.log(`⏳ WhatsApp Web ${percent}% ${message || ''}`)
    })

    client.on('authenticated', async () => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('authenticated', { status: 'AUTHENTICATED', authenticated: true, hasQr: false, hasPairingCode: false, lastError: null }, 'Evento authenticated recibido')
      await this.attachPageDiagnostics()
      await this.refreshDiagnostics({ logProbe: true })
      console.log('🔐 WhatsApp autenticado')
      this.startReadyWatchdog()
    })

    client.on('ready', async () => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      await this.attachPageDiagnostics()
      const beforeSave = await this.refreshDiagnostics({ logProbe: true })
      this.log('info', 'ready_event', 'Evento READY recibido; comenzando verificación de sesión y guardado remoto', beforeSave)
      try {
        if (typeof client.authStrategy?.storeRemoteSession === 'function') {
          this.log('info', 'store_remote_session_start', 'Forzando guardado remoto tras READY')
          await client.authStrategy.storeRemoteSession({ emit: true })
          this.log('info', 'store_remote_session_done', 'Guardado remoto forzado completado')
        } else {
          this.log('warn', 'store_remote_session_unavailable', 'authStrategy.storeRemoteSession no está disponible')
        }
      } catch (error) {
        this.log('error', 'store_remote_session_error', error.message || String(error), { stack: error.stack })
        console.error('⚠️ Guardado remoto inmediato falló:', error.message)
      }
      await this.refreshRemoteState({ logResult: true })
      this._qrDataUrl = null; this._pairingCode = null
      const info = client.info
      this.note('ready', {
        status: 'READY', ready: true, authenticated: true, hasQr: false, hasPairingCode: false,
        phone: info?.wid?.user || null, pushname: info?.pushname || null, lastError: null, restartCount: 0,
      }, 'Estado READY confirmado', { phone: info?.wid?.user || null, pushname: info?.pushname || null })
      this.backoffMs = 5000
      this.stopDiagnosticProbe()
      console.log(`✅ WhatsApp READY${info?.wid?.user ? ` | +${info.wid.user}` : ''}`)
    })

    client.on('remote_session_saved', async () => {
      if (!current()) return
      const remote = await this.refreshRemoteState({ logResult: false })
      this.note('remote_session_saved_event', { lastRemoteSessionSavedAt: remote?.metadata?.saved_at || new Date().toISOString() }, 'Evento remote_session_saved recibido', { savedAt: remote?.metadata?.saved_at || null })
      console.log('💾 Sesión WhatsApp guardada en Supabase Storage')
    })

    client.on('auth_failure', (message) => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('auth_failure', { status: 'AUTH_FAILURE', ready: false, authenticated: false, lastError: String(message || 'Auth failure') }, 'WhatsApp informó fallo de autenticación')
      console.error('❌ auth_failure:', message)
      this.scheduleRestart('AUTH_FAILURE')
    })

    client.on('disconnected', (reason) => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('disconnected', { status: 'DISCONNECTED', ready: false, authenticated: false, lastDisconnect: String(reason || '') }, 'WhatsApp emitió disconnected', { reason: String(reason || '') })
      console.error('⚠️ WhatsApp desconectado:', reason)
      this.scheduleRestart(`DISCONNECTED:${String(reason || '')}`)
    })

    client.on('change_state', (state) => {
      if (!current()) return
      this.note('change_state', { whatsappState: state }, `WhatsApp cambió su estado a ${state}`, { newState: state })
      console.log(`ℹ️ WhatsApp state: ${state}`)
    })

    return client
  }

  async initialize() {
    if (this.starting || this.state.ready) return
    this.starting = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.readyWatchdog)
    this.stopDiagnosticProbe()
    this.pageAttached = false
    this.lastProbeSignature = null
    this.update({ status: 'INITIALIZING', lastError: null, lastDisconnect: null, ready: false, authenticated: false })
    this.note('initialize', {}, 'Inicio de inicialización de WhatsApp')
    const remote = await this.refreshRemoteState({ logResult: true })
    this.log('info', 'initialize_remote_session', 'Resultado de comprobación de sesión remota', { exists: Boolean(remote?.exists), saved_at: remote?.metadata?.saved_at || null })
    try {
      this._qrDataUrl = null; this._pairingCode = null
      this.client = this.createClient()
      this.log('info', 'client_initialize_start', 'Llamando a client.initialize()')
      const startedAt = Date.now()
      await this.client.initialize()
      this.log('info', 'client_initialize_resolved', 'client.initialize() resolvió sin excepción', { elapsedMs: Date.now() - startedAt })
      await this.attachPageDiagnostics()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await this.refreshDiagnostics({ logProbe: true })
      await this.refreshRemoteState({ logResult: true })
      this.startDiagnosticProbe()
    } catch (error) {
      this.update({ status: 'ERROR', ready: false, authenticated: false, lastError: error.message || String(error) })
      this.log('error', 'initialize_error', error.message || String(error), { stack: error.stack, code: error.code, status: error.status, statusCode: error.statusCode })
      console.error('❌ Error inicializando WhatsApp:', error)
      this.scheduleRestart('INITIALIZE_ERROR')
    } finally { this.starting = false }
  }

  scheduleRestart(reason) {
    if (this.restartTimer) return
    const delay = Math.min(this.backoffMs, 120000)
    this.backoffMs = Math.min(this.backoffMs * 2, 120000)
    this.update({ restartCount: this.state.restartCount + 1, lastError: `Reinicio programado: ${reason}` })
    this.log('warn', 'restart_scheduled', `Reinicio programado en ${delay} ms`, { reason, delayMs: delay, restartCount: this.state.restartCount })
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      this.log('info', 'restart_begin', 'Ejecutando reinicio automático', { reason })
      await this.safeDestroy()
      await this.initialize()
    }, delay)
  }

  async manualRestart() {
    clearTimeout(this.restartTimer); clearTimeout(this.readyWatchdog); this.restartTimer = null
    this.stopDiagnosticProbe()
    this.update({ status: 'RESTARTING', ready: false, authenticated: false, lastError: null })
    this.log('warn', 'manual_restart', 'Reinicio manual solicitado desde el panel')
    await this.safeDestroy(); this.backoffMs = 5000; await this.initialize()
  }

  async safeDestroy() {
    const client = this.client
    this.client = null
    this.pageAttached = false
    this.stopDiagnosticProbe()
    if (!client) return
    this.log('warn', 'client_destroy_start', 'Destruyendo instancia actual de WhatsApp Web')
    try { await client.destroy(); this.log('info', 'client_destroy_done', 'Instancia de WhatsApp Web destruida') } catch (error) { this.log('error', 'client_destroy_error', error.message || String(error), { stack: error.stack }) }
  }

  async requestPairingCode(phoneNumber) {
    if (!this.client) throw new Error('WhatsApp no está inicializado')
    if (this.state.ready || this.state.authenticated) throw new Error('WhatsApp ya está autenticado')
    const digits = String(phoneNumber || '').replace(/\D/g, '')
    if (!digits) throw new Error('Número inválido')
    let waState = null
    try { waState = await this.client.getState() } catch (error) { this.log('warn', 'pairing_state_error', 'No se pudo consultar el estado antes del código', { message: error.message }) }
    this.log('info', 'pairing_code_request', 'Solicitando código de vinculación', { digitsLength: digits.length, waState })
    if (!['UNPAIRED', 'UNPAIRED_IDLE'].includes(waState)) throw new Error(`WhatsApp no está en estado de vinculación: ${waState || 'desconocido'}`)
    if (typeof this.client.cancelPairingCode === 'function') { try { await this.client.cancelPairingCode(); this.log('info', 'pairing_code_cancel_previous', 'Código de vinculación previo cancelado') } catch { /* no-op */ } }
    this.note('pairing_code_requested', { status: 'PAIRING_CODE_REQUESTED', hasPairingCode: false, hasQr: false, lastError: null }, 'Solicitud manual de código de vinculación', { digitsLength: digits.length, waState })
    const startedAt = Date.now()
    const code = await this.client.requestPairingCode(digits, true, 180000)
    this._pairingCode = code
    this.note('pairing_code_ready', { status: 'PAIRING_CODE_READY', hasPairingCode: true, hasQr: false }, 'Código de vinculación listo', { elapsedMs: Date.now() - startedAt, codeLength: String(code || '').length })
    return code
  }

  async isRegisteredUser(jid) {
    if (!this.client || !this.state.ready) throw new Error('WhatsApp no está listo')
    return this.client.isRegisteredUser(jid)
  }

  async sendMessage(jid, message) {
    if (!this.client || !this.state.ready) throw new Error('WhatsApp no está listo')
    return this.client.sendMessage(jid, message)
  }

  async shutdown() {
    clearTimeout(this.restartTimer); clearTimeout(this.readyWatchdog); this.restartTimer = null
    this.stopDiagnosticProbe()
    this.log('warn', 'shutdown', 'Apagado solicitado')
    await this.safeDestroy(); this.update({ status: 'STOPPED', ready: false, authenticated: false })
  }
}

module.exports = { WhatsAppManager }
