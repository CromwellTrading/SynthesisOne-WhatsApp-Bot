const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')

class WhatsAppManager {
  constructor(config) {
    this.config = config
    this.client = null
    this.state = {
      status: 'STOPPED',
      ready: false,
      authenticated: false,
      phone: null,
      pushname: null,
      qrDataUrl: null,
      pairingCode: null,
      lastError: null,
      lastDisconnect: null,
      restartCount: 0,
      updatedAt: new Date().toISOString(),
    }
    this.starting = false
    this.restartTimer = null
    this.backoffMs = 5000
  }

  update(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() }
  }

  getState() {
    const { qrDataUrl, pairingCode, ...safe } = this.state
    return { ...safe, hasQr: Boolean(qrDataUrl), hasPairingCode: Boolean(pairingCode) }
  }

  getQrDataUrl() {
    return this.state.qrDataUrl
  }

  getPairingCode() {
    return this.state.pairingCode
  }

  createClient() {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.config.clientId,
        dataPath: this.config.authDir,
      }),
      puppeteer: {
        headless: true,
        executablePath: this.config.chromiumPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
      restartOnAuthFail: true,
    })

    client.on('qr', async (qr) => {
      this.update({ status: 'QR_REQUIRED', ready: false, authenticated: false, pairingCode: null, qrDataUrl: await qrcode.toDataURL(qr), lastError: null })
      console.log('📲 QR disponible en el panel /admin')
    })

    client.on('code', (code) => {
      this.update({ pairingCode: code, status: 'PAIRING_CODE_READY', qrDataUrl: null, lastError: null })
      console.log(`🔢 Código de vinculación generado: ${code}`)
    })

    client.on('authenticated', () => {
      this.update({ status: 'AUTHENTICATED', authenticated: true, lastError: null, pairingCode: null, qrDataUrl: null })
      console.log('🔐 WhatsApp autenticado')
    })

    client.on('ready', () => {
      const info = client.info
      this.update({
        status: 'READY',
        ready: true,
        authenticated: true,
        phone: info?.wid?.user || null,
        pushname: info?.pushname || null,
        lastError: null,
        restartCount: 0,
      })
      this.backoffMs = 5000
      console.log(`✅ WhatsApp listo${info?.wid?.user ? ` | +${info.wid.user}` : ''}`)
    })

    client.on('auth_failure', (message) => {
      this.update({ status: 'AUTH_FAILURE', ready: false, authenticated: false, lastError: String(message || 'Auth failure') })
      console.error('❌ WhatsApp auth_failure:', message)
      this.scheduleRestart()
    })

    client.on('disconnected', (reason) => {
      this.update({ status: 'DISCONNECTED', ready: false, authenticated: false, lastDisconnect: String(reason || ''), lastError: null })
      console.error('⚠️ WhatsApp desconectado:', reason)
      this.scheduleRestart()
    })

    client.on('change_state', (state) => {
      console.log(`ℹ️ WhatsApp state: ${state}`)
    })

    client.on('remote_session_saved', () => console.log('💾 remote_session_saved emitido'))
    return client
  }

  async initialize() {
    if (this.starting || this.state.ready) return
    this.starting = true
    clearTimeout(this.restartTimer)
    this.update({ status: 'INITIALIZING', lastError: null })
    try {
      this.client = this.createClient()
      await this.client.initialize()
    } catch (error) {
      this.update({ status: 'ERROR', ready: false, authenticated: false, lastError: error.message || String(error) })
      console.error('❌ Error inicializando WhatsApp:', error)
      this.scheduleRestart()
    } finally {
      this.starting = false
    }
  }

  scheduleRestart() {
    if (this.restartTimer) return
    const delay = Math.min(this.backoffMs, 120000)
    this.backoffMs = Math.min(this.backoffMs * 2, 120000)
    this.update({ restartCount: this.state.restartCount + 1 })
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      await this.safeDestroy()
      await this.initialize()
    }, delay)
  }

  async safeDestroy() {
    const client = this.client
    this.client = null
    if (!client) return
    try { await client.destroy() } catch { /* noop */ }
  }

  async requestPairingCode(phoneNumber) {
    if (!this.client) throw new Error('Cliente WhatsApp todavía no está inicializado')
    const digits = String(phoneNumber || '').replace(/\D/g, '')
    if (!digits) throw new Error('Número de teléfono inválido')
    if (this.state.ready || this.state.authenticated) throw new Error('WhatsApp ya está autenticado')
    this.update({ status: 'PAIRING_CODE_REQUESTED', pairingCode: null, lastError: null })
    const code = await this.client.requestPairingCode(digits)
    this.update({ pairingCode: code, status: 'PAIRING_CODE_READY' })
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
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    await this.safeDestroy()
    this.update({ status: 'STOPPED', ready: false, authenticated: false })
  }
}

module.exports = { WhatsAppManager }
