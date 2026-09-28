class SupabaseEventStore {
  constructor(supabase) { this.supabase = supabase }

  async get(eventId) {
    const { data, error } = await this.supabase
      .from('whatsapp_webhook_events')
      .select('*')
      .eq('event_id', eventId)
      .maybeSingle()
    if (error) throw error
    return data || null
  }

  async begin(eventId, metadata) {
    const existing = await this.get(eventId)
    const now = new Date().toISOString()
    if (existing) {
      const updatedMs = new Date(existing.updated_at || existing.created_at || 0).getTime()
      const stale = !Number.isFinite(updatedMs) || Date.now() - updatedMs > 10 * 60 * 1000
      if (existing.status === 'SENT' || (existing.status === 'PROCESSING' && !stale)) return { duplicate: true, record: existing }

      const { data, error } = await this.supabase
        .from('whatsapp_webhook_events')
        .update({ ...metadata, status: 'PROCESSING', attempts: Number(existing.attempts || 0) + 1, error: null, updated_at: now })
        .eq('event_id', eventId)
        .select('*')
        .maybeSingle()
      if (error) throw error
      return { duplicate: false, record: data || existing }
    }

    const { data, error } = await this.supabase
      .from('whatsapp_webhook_events')
      .insert({ event_id: eventId, ...metadata, status: 'PROCESSING', attempts: 1, created_at: now, updated_at: now })
      .select('*')
      .maybeSingle()
    if (error) {
      if (error.code === '23505') return { duplicate: true, record: await this.get(eventId) }
      throw error
    }
    return { duplicate: false, record: data }
  }

  async markSent(eventId, details = {}) {
    const { error } = await this.supabase.from('whatsapp_webhook_events').update({
      status: 'SENT', sent_at: new Date().toISOString(), message_id: details.message_id || null,
      recipient: details.recipient || null, error: null, updated_at: new Date().toISOString(),
    }).eq('event_id', eventId)
    if (error) throw error
  }

  async markFailed(eventId, message) {
    const { error } = await this.supabase.from('whatsapp_webhook_events').update({
      status: 'FAILED', error: String(message || 'Error'), updated_at: new Date().toISOString(),
    }).eq('event_id', eventId)
    if (error) throw error
  }

  async recent(limit = 100) {
    const { data, error } = await this.supabase
      .from('whatsapp_webhook_events')
      .select('event_id, received_at, transaction_id, amount, currency, direction, recipient, status, attempts, error, message_id, sent_at, created_at, updated_at')
      .order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200))
    if (error) throw error
    return data || []
  }
}

module.exports = { SupabaseEventStore }
