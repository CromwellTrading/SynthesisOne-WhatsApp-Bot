const crypto = require('crypto')

function truncate(value, max = 1200) {
  const text = String(value == null ? '' : value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sanitize(value, depth = 0) {
  if (depth > 3) return '[max-depth]'
  if (value == null) return value
  if (typeof value === 'string') return truncate(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: truncate(value.message), stack: truncate(value.stack, 2400) }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    const sensitive = /(secret|token|password|authorization|cookie|session[_-]?key|webhook[_-]?secret|encryption[_-]?key)/i
    for (const [key, val] of Object.entries(value).slice(0, 80)) {
      if (sensitive.test(key)) out[key] = '[redacted]'
      else out[key] = sanitize(val, depth + 1)
    }
    return out
  }
  return truncate(value)
}

class DiagnosticLogger {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries
    this.entries = []
    this.seq = 0
  }

  log(level, event, message = '', data = undefined) {
    const now = new Date().toISOString()
    const entry = {
      id: `${Date.now()}-${++this.seq}-${crypto.randomBytes(3).toString('hex')}`,
      at: now,
      level: String(level || 'INFO').toUpperCase(),
      event: String(event || 'log'),
      message: truncate(message, 2000),
    }
    if (data !== undefined) entry.data = sanitize(data)
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)

    const printable = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`
    const line = `[WA:${entry.level}] ${entry.event}${entry.message ? ` | ${entry.message}` : ''}${printable}`
    if (entry.level === 'ERROR') console.error(line)
    else if (entry.level === 'WARN') console.warn(line)
    else console.log(line)
    return entry
  }

  info(event, message = '', data) { return this.log('INFO', event, message, data) }
  warn(event, message = '', data) { return this.log('WARN', event, message, data) }
  error(event, message = '', data) { return this.log('ERROR', event, message, data) }

  recent(limit = 500) {
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), this.maxEntries)
    return this.entries.slice(-safeLimit)
  }

  clear() { this.entries = [] }
}

module.exports = { DiagnosticLogger, sanitize }
