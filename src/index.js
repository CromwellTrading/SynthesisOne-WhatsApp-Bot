require('dotenv').config()
const fs = require('fs')
const { loadConfig } = require('./config')
const { createSupabase } = require('./supabase')
const { SupabaseRemoteStore } = require('./remoteSessionStore')
const { SupabaseEventStore } = require('./eventStore')
const { WhatsAppManager } = require('./whatsapp')
const { buildServer } = require('./server')

async function main() {
  const config = loadConfig()
  fs.mkdirSync(config.authDir, { recursive: true })

  const supabase = createSupabase(config)
  const sessionStore = new SupabaseRemoteStore({ supabase, bucket: config.storageBucket, encryptionKey: config.sessionEncryptionKey })
  sessionStore.bindDataPath(config.authDir)
  await sessionStore.ensureBucket()

  const eventStore = new SupabaseEventStore(supabase)
  const whatsapp = new WhatsAppManager(config, sessionStore)
  const app = buildServer({ config, whatsapp, eventStore, sessionStore })
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 SynthesisOne WhatsApp Bot en puerto ${config.port}`)
    console.log('☁️ RemoteAuth + Supabase Storage activo')
    console.log('🔐 Webhook HMAC activo')
  })

  await whatsapp.initialize()

  async function shutdown(signal) {
    console.log(`🛑 ${signal}`)
    server.close(async () => { await whatsapp.shutdown(); process.exit(0) })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => { console.error('❌ Error fatal:', error); process.exit(1) })
