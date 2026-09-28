const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

function safeSessionName(session) {
  const value = String(session || '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Nombre de sesión inválido')
  return value
}

function objectPath(session) {
  return `sessions/${safeSessionName(session)}.bin`
}

function metadataPath(session) {
  return `metadata/${safeSessionName(session)}.json`
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from('S1WA2', 'ascii'), iv, tag, ciphertext])
}

function decryptBuffer(buffer, key) {
  if (buffer.length < 33) throw new Error('Archivo de sesión remoto demasiado corto')
  if (buffer.subarray(0, 5).toString('ascii') !== 'S1WA2') throw new Error('Formato de sesión remoto no reconocido')
  const iv = buffer.subarray(5, 17)
  const tag = buffer.subarray(17, 33)
  const ciphertext = buffer.subarray(33)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

class SupabaseRemoteStore {
  constructor({ supabase, bucket, encryptionKey }) {
    this.supabase = supabase
    this.bucket = bucket
    this.encryptionKey = encryptionKey
    this.dataPath = null
    this.lastSaved = null
    this.lastExtracted = null
    this.lastError = null
  }

  bindDataPath(dataPath) { this.dataPath = dataPath }

  async ensureBucket() {
    const existing = await this.supabase.storage.getBucket(this.bucket)
    if (!existing.error && existing.data) return
    const created = await this.supabase.storage.createBucket(this.bucket, { public: false, fileSizeLimit: '50MB' })
    if (created.error && !/already exists|duplicate/i.test(created.error.message || '')) throw created.error
  }

  async sessionExists({ session }) {
    const name = path.basename(objectPath(session))
    const { data, error } = await this.supabase.storage.from(this.bucket).list('sessions', { limit: 20, search: name })
    if (error) throw error
    return (data || []).some((entry) => entry.name === name)
  }

  async save({ session }) {
    if (!this.dataPath) throw new Error('RemoteAuth dataPath no configurado')
    const archive = path.join(this.dataPath, `${safeSessionName(session)}.zip`)
    const plain = await fs.readFile(archive)
    const encrypted = encryptBuffer(plain, this.encryptionKey)

    const upload = await this.supabase.storage.from(this.bucket).upload(objectPath(session), encrypted, {
      upsert: true,
      contentType: 'application/octet-stream',
      cacheControl: '31536000',
    })
    if (upload.error) { this.lastError = upload.error.message; throw upload.error }

    const metadata = {
      schema_version: 2,
      session: safeSessionName(session),
      saved_at: new Date().toISOString(),
      plain_bytes: plain.length,
      encrypted_bytes: encrypted.length,
      sha256: crypto.createHash('sha256').update(plain).digest('hex'),
    }
    const meta = await this.supabase.storage.from(this.bucket).upload(
      metadataPath(session),
      Buffer.from(JSON.stringify(metadata), 'utf8'),
      { upsert: true, contentType: 'application/json', cacheControl: '3600' },
    )
    if (meta.error) { this.lastError = meta.error.message; throw meta.error }

    this.lastSaved = metadata
    this.lastError = null
  }

  async extract({ session, path: archivePath }) {
    const result = await this.supabase.storage.from(this.bucket).download(objectPath(session))
    if (result.error) { this.lastError = result.error.message; throw result.error }
    const encrypted = Buffer.from(await result.data.arrayBuffer())
    const plain = decryptBuffer(encrypted, this.encryptionKey)
    await fs.mkdir(path.dirname(archivePath), { recursive: true })
    await fs.writeFile(archivePath, plain, { mode: 0o600 })
    this.lastExtracted = { session: safeSessionName(session), extracted_at: new Date().toISOString(), plain_bytes: plain.length }
    this.lastError = null
  }

  async delete({ session }) {
    const { error } = await this.supabase.storage.from(this.bucket).remove([objectPath(session), metadataPath(session)])
    if (error) throw error
  }

  async getMetadata(session) {
    const result = await this.supabase.storage.from(this.bucket).download(metadataPath(session))
    if (result.error) return null
    try { return JSON.parse(Buffer.from(await result.data.arrayBuffer()).toString('utf8')) } catch { return null }
  }

  async status(session) {
    const exists = await this.sessionExists({ session })
    return {
      exists,
      metadata: exists ? await this.getMetadata(session) : null,
      lastSaved: this.lastSaved,
      lastExtracted: this.lastExtracted,
      lastError: this.lastError,
    }
  }
}

module.exports = { SupabaseRemoteStore }
