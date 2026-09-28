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
  constructor({ supabase, bucket, encryptionKey, logger = null }) {
    this.supabase = supabase
    this.bucket = bucket
    this.encryptionKey = encryptionKey
    this.logger = logger
    this.dataPath = null
    this.lastSaved = null
    this.lastExtracted = null
    this.lastError = null
  }

  setLogger(logger) { this.logger = logger }
  log(level, event, message = '', data) { if (this.logger?.[level]) this.logger[level](event, message, data) }

  bindDataPath(dataPath) { this.dataPath = dataPath }

  async ensureBucket() {
    this.log('info', 'storage_bucket_check', 'Comprobando bucket de sesión', { bucket: this.bucket })
    const existing = await this.supabase.storage.getBucket(this.bucket)
    if (!existing.error && existing.data) {
      this.log('info', 'storage_bucket_ready', 'Bucket encontrado', { bucket: this.bucket, public: existing.data.public })
      return
    }
    if (existing.error) this.log('warn', 'storage_bucket_get_error', existing.error.message || 'getBucket devolvió un error', { code: existing.error.code, status: existing.error.status, statusCode: existing.error.statusCode })
    const created = await this.supabase.storage.createBucket(this.bucket, { public: false, fileSizeLimit: '50MB' })
    if (created.error && !/already exists|duplicate/i.test(created.error.message || '')) {
      this.lastError = created.error.message
      this.log('error', 'storage_bucket_create_error', created.error.message || 'No se pudo crear el bucket', { code: created.error.code, status: created.error.status, statusCode: created.error.statusCode })
      throw created.error
    }
    if (created.error) this.log('info', 'storage_bucket_already_exists', 'El bucket ya existía')
    else this.log('info', 'storage_bucket_created', 'Bucket creado', { bucket: this.bucket })
  }

  async sessionExists({ session }) {
    const name = path.basename(objectPath(session))
    this.log('info', 'remote_session_exists_start', 'Comprobando existencia de sesión remota', { session: safeSessionName(session) })
    const { data, error } = await this.supabase.storage.from(this.bucket).list('sessions', { limit: 20, search: name })
    if (error) {
      this.lastError = error.message
      this.log('error', 'remote_session_exists_error', error.message || 'Error listando sesión remota', { code: error.code, status: error.status, statusCode: error.statusCode })
      throw error
    }
    const exists = (data || []).some((entry) => entry.name === name)
    this.log('info', 'remote_session_exists_result', exists ? 'Sesión remota encontrada' : 'No existe sesión remota', { session: safeSessionName(session), exists })
    return exists
  }

  async save({ session }) {
    if (!this.dataPath) throw new Error('RemoteAuth dataPath no configurado')
    const archive = path.join(this.dataPath, `${safeSessionName(session)}.zip`)
    this.log('info', 'remote_session_save_start', 'RemoteAuth solicita guardar sesión', { session: safeSessionName(session), archive })
    const plain = await fs.readFile(archive)
    const encrypted = encryptBuffer(plain, this.encryptionKey)

    const upload = await this.supabase.storage.from(this.bucket).upload(objectPath(session), encrypted, {
      upsert: true,
      contentType: 'application/octet-stream',
      cacheControl: '31536000',
    })
    if (upload.error) {
      this.lastError = upload.error.message
      this.log('error', 'remote_session_save_upload_error', upload.error.message || 'Error subiendo sesión remota', { code: upload.error.code, status: upload.error.status, statusCode: upload.error.statusCode })
      throw upload.error
    }

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
    if (meta.error) {
      this.lastError = meta.error.message
      this.log('error', 'remote_session_metadata_error', meta.error.message || 'Error subiendo metadatos', { code: meta.error.code, status: meta.error.status, statusCode: meta.error.statusCode })
      throw meta.error
    }

    this.lastSaved = metadata
    this.lastError = null
    this.log('info', 'remote_session_saved', 'Sesión guardada correctamente en Supabase Storage', { session: metadata.session, plain_bytes: plain.length, encrypted_bytes: encrypted.length, sha256: metadata.sha256.slice(0, 16) })
  }

  async extract({ session, path: archivePath }) {
    this.log('info', 'remote_session_extract_start', 'Intentando restaurar sesión remota', { session: safeSessionName(session) })
    const result = await this.supabase.storage.from(this.bucket).download(objectPath(session))
    if (result.error) {
      this.lastError = result.error.message
      this.log('error', 'remote_session_extract_download_error', result.error.message || 'Error descargando sesión remota', { code: result.error.code, status: result.error.status, statusCode: result.error.statusCode })
      throw result.error
    }
    const encrypted = Buffer.from(await result.data.arrayBuffer())
    const plain = decryptBuffer(encrypted, this.encryptionKey)
    await fs.mkdir(path.dirname(archivePath), { recursive: true })
    await fs.writeFile(archivePath, plain, { mode: 0o600 })
    this.lastExtracted = { session: safeSessionName(session), extracted_at: new Date().toISOString(), plain_bytes: plain.length }
    this.lastError = null
    this.log('info', 'remote_session_extracted', 'Sesión remota restaurada correctamente', { session: safeSessionName(session), encrypted_bytes: encrypted.length, plain_bytes: plain.length })
  }

  async delete({ session }) {
    this.log('warn', 'remote_session_delete_start', 'RemoteAuth solicita borrar sesión remota', { session: safeSessionName(session) })
    const { error } = await this.supabase.storage.from(this.bucket).remove([objectPath(session), metadataPath(session)])
    if (error) {
      this.lastError = error.message
      this.log('error', 'remote_session_delete_error', error.message || 'Error borrando sesión remota', { code: error.code, status: error.status, statusCode: error.statusCode })
      throw error
    }
    this.lastError = null
    this.log('info', 'remote_session_deleted', 'Sesión remota eliminada')
  }

  async getMetadata(session) {
    const result = await this.supabase.storage.from(this.bucket).download(metadataPath(session))
    if (result.error) return null
    try { return JSON.parse(Buffer.from(await result.data.arrayBuffer()).toString('utf8')) } catch { return null }
  }

  async status(session) {
    try {
      const exists = await this.sessionExists({ session })
      const metadata = exists ? await this.getMetadata(session) : null
      if (metadata) this.log('info', 'remote_session_metadata', 'Metadatos de sesión remota disponibles', { session: safeSessionName(session), saved_at: metadata.saved_at, plain_bytes: metadata.plain_bytes })
      return {
        exists,
        metadata,
        lastSaved: this.lastSaved,
        lastExtracted: this.lastExtracted,
        lastError: this.lastError,
      }
    } catch (error) {
      this.lastError = error.message || String(error)
      throw error
    }
  }
}

module.exports = { SupabaseRemoteStore }
