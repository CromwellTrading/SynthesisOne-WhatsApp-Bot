require('dotenv').config()
const fs = require('fs')
const { loadConfig } = require('./config')
const { JsonStore } = require('./store')
const { WhatsAppManager } = require('./whatsapp')
const { buildServer } = require('./server')

async function main() {
  const config = loadConfig()
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.authDir, { recursive: true })

  const store = new JsonStore(config.dataDir)
  const whatsapp = new WhatsAppManager(config)
  const app = buildServer({ config, whatsapp, store })

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 SynthesisOne WhatsApp Bot escuchando en ${config.port}`)
    console.log('🔐 Webhook protegido con HMAC')
    console.log('💾 Sesión WhatsApp persistente configurada')
  })

  await whatsapp.initialize()

  const shutdown = async (signal) => {
    console.log(`\n🛑 Recibido ${signal}; cerrando...`)
    server.close(async () => {
      await whatsapp.shutdown()
      process.exit(0)
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('❌ Error fatal:', error)
  process.exit(1)
})
