const { Client, RemoteAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')

class WhatsAppManager {
  constructor(config, sessionStore) {
    this.config = config
    this.sessionStore = sessionStore
    this.client = null
    this.sessionName = `RemoteAuth-${config.clientId}`
    this.starting = false
    this.restartTimer = null
    this.readyWatchdog = null
    this.backoffMs = 5000
    this.state = {
      status: 'STOPPED', ready: false, authenticated: false,
      phone: null, pushname: null, whatsappState: null, wwebVersion: null,
      hasQr: false, hasPairingCode: false, lastError: null, lastDisconnect: null,
      lastEvent: null, lastEventAt: null, restartCount: 0,
      remoteSessionExists: false, lastRemoteSessionSavedAt: null,
      updatedAt: new Date().toISOString(),
    }
  }

  update(patch) { this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() } }
  note(event, patch = {}) { this.update({ lastEvent: event, lastEventAt: new Date().toISOString(), ...patch }) }
  getState() { return { ...this.state } }
  getQrDataUrl() { return this._qrDataUrl || null }

  async refreshRemoteState() {
    try {
      const status = await this.sessionStore.status(this.sessionName)
      this.update({ remoteSessionExists: Boolean(status.exists), lastRemoteSessionSavedAt: status.metadata?.saved_at || this.state.lastRemoteSessionSavedAt })
      return status
    } catch (error) {
      this.update({ lastError: `RemoteAuth: ${error.message || String(error)}` })
      return null
    }
  }

  async refreshDiagnostics() {
    if (!this.client) return
    try { this.update({ whatsappState: await this.client.getState() }) } catch (error) { this.update({ whatsappState: `ERROR:${error.message || String(error)}` }) }
    try { this.update({ wwebVersion: await this.client.getWWebVersion() }) } catch { /* no-op */ }
  }

  startReadyWatchdog() {
    clearTimeout(this.readyWatchdog)
    this.readyWatchdog = setTimeout(async () => {
      if (!this.client || this.state.ready) return
      await this.refreshDiagnostics()
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

    client.on('qr', async (qr) => {
      if (!current()) return
      this._qrDataUrl = await qrcode.toDataURL(qr)
      this.note('qr', { status: 'QR_REQUIRED', ready: false, authenticated: false, hasQr: true, hasPairingCode: false, lastError: null })
      await this.refreshDiagnostics()
      console.log('📲 QR disponible en /admin')
    })
    client.on('code', (code) => {
      if (!current()) return
      this._pairingCode = code
      this.note('code', { status: 'PAIRING_CODE_READY', hasQr: false, hasPairingCode: true, lastError: null })
      console.log(`🔢 Código de vinculación generado: ${code}`)
    })
    client.on('loading_screen', (percent, message) => {
      if (!current()) return
      this.note('loading_screen', { status: 'AUTHENTICATING', lastError: null })
      console.log(`⏳ WhatsApp Web ${percent}% ${message || ''}`)
    })
    client.on('authenticated', () => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('authenticated', { status: 'AUTHENTICATED', authenticated: true, hasQr: false, hasPairingCode: false, lastError: null })
      console.log('🔐 WhatsApp autenticado')
      this.startReadyWatchdog()
    })
    client.on('ready', async () => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      await this.refreshDiagnostics()
      try {
        if (typeof client.authStrategy?.storeRemoteSession === 'function') await client.authStrategy.storeRemoteSession({ emit: true })
      } catch (error) { console.error('⚠️ Guardado remoto inmediato falló:', error.message) }
      await this.refreshRemoteState()
      this._qrDataUrl = null; this._pairingCode = null
      const info = client.info
      this.note('ready', {
        status: 'READY', ready: true, authenticated: true, hasQr: false, hasPairingCode: false,
        phone: info?.wid?.user || null, pushname: info?.pushname || null, lastError: null, restartCount: 0,
      })
      this.backoffMs = 5000
      console.log(`✅ WhatsApp READY${info?.wid?.user ? ` | +${info.wid.user}` : ''}`)
    })
    client.on('remote_session_saved', async () => {
      if (!current()) return
      const remote = await this.refreshRemoteState()
      this.note('remote_session_saved', { lastRemoteSessionSavedAt: remote?.metadata?.saved_at || new Date().toISOString() })
      console.log('💾 Sesión WhatsApp guardada en Supabase Storage')
    })
    client.on('auth_failure', (message) => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('auth_failure', { status: 'AUTH_FAILURE', ready: false, authenticated: false, lastError: String(message || 'Auth failure') })
      console.error('❌ auth_failure:', message)
      this.scheduleRestart('AUTH_FAILURE')
    })
    client.on('disconnected', (reason) => {
      if (!current()) return
      clearTimeout(this.readyWatchdog)
      this.note('disconnected', { status: 'DISCONNECTED', ready: false, authenticated: false, lastDisconnect: String(reason || '') })
      console.error('⚠️ WhatsApp desconectado:', reason)
      this.scheduleRestart(`DISCONNECTED:${String(reason || '')}`)
    })
    client.on('change_state', (state) => {
      if (!current()) return
      this.note('change_state', { whatsappState: state })
      console.log(`ℹ️ WhatsApp state: ${state}`)
    })

    return client
  }

  async initialize() {
    if (this.starting || this.state.ready) return
    this.starting = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.readyWatchdog)
    this.update({ status: 'INITIALIZING', lastError: null, lastDisconnect: null })
    this.note('initialize')
    await this.refreshRemoteState()
    try {
      this._qrDataUrl = null; this._pairingCode = null
      this.client = this.createClient()
      await this.client.initialize()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await this.refreshDiagnostics()
      await this.refreshRemoteState()
    } catch (error) {
      this.update({ status: 'ERROR', ready: false, authenticated: false, lastError: error.message || String(error) })
      console.error('❌ Error inicializando WhatsApp:', error)
      this.scheduleRestart('INITIALIZE_ERROR')
    } finally { this.starting = false }
  }

  scheduleRestart(reason) {
    if (this.restartTimer) return
    const delay = Math.min(this.backoffMs, 120000)
    this.backoffMs = Math.min(this.backoffMs * 2, 120000)
    this.update({ restartCount: this.state.restartCount + 1, lastError: `Reinicio programado: ${reason}` })
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      await this.safeDestroy()
      await this.initialize()
    }, delay)
  }

  async manualRestart() {
    clearTimeout(this.restartTimer); clearTimeout(this.readyWatchdog); this.restartTimer = null
    this.update({ status: 'RESTARTING', ready: false, authenticated: false, lastError: null })
    await this.safeDestroy(); this.backoffMs = 5000; await this.initialize()
  }

  async safeDestroy() {
    const client = this.client
    this.client = null
    if (!client) return
    try { await client.destroy() } catch { /* no-op */ }
  }

  async requestPairingCode(phoneNumber) {
    if (!this.client) throw new Error('WhatsApp no está inicializado')
    if (this.state.ready || this.state.authenticated) throw new Error('WhatsApp ya está autenticado')
    const digits = String(phoneNumber || '').replace(/\D/g, '')
    if (!digits) throw new Error('Número inválido')
    let waState = null
    try { waState = await this.client.getState() } catch { /* handled */ }
    if (!['UNPAIRED', 'UNPAIRED_IDLE'].includes(waState)) throw new Error(`WhatsApp no está en estado de vinculación: ${waState || 'desconocido'}`)
    if (typeof this.client.cancelPairingCode === 'function') { try { await this.client.cancelPairingCode() } catch { /* no-op */ } }
    this.note('pairing_code_requested', { status: 'PAIRING_CODE_REQUESTED', hasPairingCode: false, hasQr: false, lastError: null })
    const code = await this.client.requestPairingCode(digits, true, 180000)
    this._pairingCode = code
    this.note('pairing_code_ready', { status: 'PAIRING_CODE_READY', hasPairingCode: true, hasQr: false })
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
    await this.safeDestroy(); this.update({ status: 'STOPPED', ready: false, authenticated: false })
  }
}

module.exports = { WhatsAppManager }
