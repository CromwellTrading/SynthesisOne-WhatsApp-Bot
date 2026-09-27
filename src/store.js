const fs = require('fs')
const path = require('path')

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'events.json')
    this.state = { version: 1, events: {} }
    fs.mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.events) this.state = parsed
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('⚠️ No se pudo leer la tienda local:', error.message)
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  hasEvent(eventId) {
    return Boolean(this.state.events[eventId])
  }

  recordEvent(eventId, record) {
    this.state.events[eventId] = record
    this.persist()
  }

  recent(limit = 50) {
    return Object.values(this.state.events)
      .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))
      .slice(0, limit)
  }
}

module.exports = { JsonStore }
