const { createClient } = require('@supabase/supabase-js')

function createSupabase(config) {
  const url = config.supabaseUrl
  console.log(`☁️ Supabase Project URL detectada: ${url}`)
  const client = createClient(url, config.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'synthesisone-whatsapp-bot/2.3.0' } },
  })
  return client
}

module.exports = { createSupabase }
