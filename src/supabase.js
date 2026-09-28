const { createClient } = require('@supabase/supabase-js')

function createSupabase(config) {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'synthesisone-whatsapp-bot/2.0.0' } },
  })
}

module.exports = { createSupabase }
