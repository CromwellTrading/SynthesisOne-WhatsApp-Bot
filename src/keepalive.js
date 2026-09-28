require('dotenv').config()

async function pingOnce() {
  const target = String(process.env.KEEPALIVE_TARGET_URL || process.env.RENDER_EXTERNAL_URL || '').trim()
  const token = String(process.env.KEEPALIVE_TOKEN || '').trim()
  const path = String(process.env.KEEPALIVE_PATH || '/wake').trim() || '/wake'
  if (!target || !token) throw new Error('Faltan KEEPALIVE_TARGET_URL/RENDER_EXTERNAL_URL o KEEPALIVE_TOKEN')
  const url = new URL(path, target)
  url.searchParams.set('token', token)
  const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) })
  const body = await response.text()
  console.log(`🟢 Wakeup: HTTP ${response.status} ${body.slice(0, 160)}`)
  if (response.status < 200 || response.status >= 400) throw new Error(`Wakeup HTTP ${response.status}`)
}

if (require.main === module) pingOnce().catch((error) => { console.error('🔴 Wakeup falló:', error.message); process.exitCode = 1 })
module.exports = { pingOnce }
