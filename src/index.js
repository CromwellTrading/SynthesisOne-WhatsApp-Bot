require('dotenv').config()
const fs = require('fs')
const { loadConfig } = require('./config')
const { createSupabase } = require('./supabase')
const { SupabaseRemoteStore } = require('./remoteSessionStore')
const { SupabaseEventStore } = require('./eventStore')
const { WhatsAppManager } = require('./whatsapp')
const { buildServer } = require('./server')
const { DiagnosticLogger } = require('./diagnosticLogger')

async function main() {
  const diagnostics = new DiagnosticLogger({ maxEntries: 2500 })
  diagnostics.info('boot_start', 'Iniciando SynthesisOne WhatsApp Bot con diagnóstico detallado')

  const config = loadConfig()
  fs.mkdirSync(config.authDir, { recursive: true })
  diagnostics.info('config_loaded', 'Configuración validada', {
    port: config.port,
    supabaseUrl: config.supabaseUrl,
    storageBucket: config.storageBucket,
    clientId: config.clientId,
    authDir: config.authDir,
    chromiumPath: config.chromiumPath,
    backupSyncIntervalMs: config.backupSyncIntervalMs,
  })

  const supabase = createSupabase(config)
  const sessionStore = new SupabaseRemoteStore({ supabase, bucket: config.storageBucket, encryptionKey: config.sessionEncryptionKey, logger: diagnostics })
  sessionStore.bindDataPath(config.authDir)
  diagnostics.info('storage_init', 'Remote session store preparado', { bucket: config.storageBucket })
  try {
    await sessionStore.ensureBucket()
  } catch (error) {
    diagnostics.error('storage_init_error', error.message || String(error), { code: error.code, status: error.status, statusCode: error.statusCode })
    if (error && error.code === 'PGRST125') {
      throw new Error(`Supabase respondió PGRST125 (ruta inválida). Verifica SUPABASE_URL: debe ser solamente la Project URL, por ejemplo https://TU-PROYECTO.supabase.co. URL usada: ${config.supabaseUrl}`)
    }
    throw error
  }

  const eventStore = new SupabaseEventStore(supabase)
  const whatsapp = new WhatsAppManager(config, sessionStore, diagnostics)
  sessionStore.setLogger(diagnostics)
  const app = buildServer({ config, whatsapp, eventStore, sessionStore, diagnostics })
  const server = app.listen(config.port, '0.0.0.0', () => {
    diagnostics.info('server_listening', `Servidor HTTP escuchando en puerto ${config.port}`)
    console.log(`🚀 SynthesisOne WhatsApp Bot en puerto ${config.port}`)
    console.log('☁️ RemoteAuth + Supabase Storage activo')
    console.log('🔐 Webhook HMAC activo')
    console.log('🧪 Diagnóstico detallado activo en /admin')
  })

  await whatsapp.initialize()

  async function shutdown(signal) {
    diagnostics.warn('process_shutdown', `Recibida señal ${signal}; cerrando servicio`)
    console.log(`🛑 ${signal}`)
    server.close(async () => { await whatsapp.shutdown(); process.exit(0) })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => { console.error('❌ Error fatal:', error); process.exit(1) })
