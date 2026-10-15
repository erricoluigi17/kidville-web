import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { enqueueNotifiche } from '@/lib/push/enqueue'

describe('enqueueNotifiche', () => {
  const ordinaria = { giornoCompetenza: '2026-10-15', giornoOperazioneRoma: '2026-10-15', sopprimiGenitori: false }
  it.each(['PGRST204', '42703'])('schema precedente %s: la notifica ordinaria è accodata senza i soli metadati nuovi', async code => {
    const insert = vi.fn()
      .mockResolvedValueOnce({ error: { code, message: "Could not find the 'giorno_competenza' column" } })
      .mockResolvedValueOnce({ error: { code, message: "Could not find the 'politica_operazione' column" } })
      .mockResolvedValueOnce({ error: null })
    const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'adesione_ammessa', titolo: 'Conferma', destinatario: 'genitore', operazione: ordinaria })).toBe(true)
    expect(insert).toHaveBeenCalledTimes(3)
    const iniziale = insert.mock.calls[0][0][0]
    const intermedia = insert.mock.calls[1][0][0]
    const finale = insert.mock.calls[2][0][0]
    expect(iniziale).toMatchObject({ giorno_competenza: '2026-10-15', politica_operazione: ordinaria })
    expect(intermedia).toHaveProperty('politica_operazione', ordinaria)
    expect(intermedia).not.toHaveProperty('giorno_competenza')
    const senzaMetadati = { ...iniziale }
    delete senzaMetadati.giorno_competenza
    delete senzaMetadati.politica_operazione
    expect(finale).toEqual(senzaMetadati)
  })
  it.each([
    ['giorno_competenza', 'politica_operazione'],
    ['politica_operazione', 'giorno_competenza'],
  ])('schema parziale: toglie soltanto %s e conserva %s', async (assente, presente) => {
    const insert = vi.fn().mockResolvedValueOnce({ error: { code: 'PGRST204', message: `Could not find the '${assente}' column` } }).mockResolvedValueOnce({ error: null })
    const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'diario', titolo: 't', operazione: ordinaria })).toBe(true)
    expect(insert).toHaveBeenCalledTimes(2)
    const iniziale = insert.mock.calls[0][0][0], finale = insert.mock.calls[1][0][0]
    expect(finale).not.toHaveProperty(assente)
    expect(finale[presente]).toEqual(iniziale[presente])
    expect(finale.invio_programmato_il).toBe(iniziale.invio_programmato_il)
    expect(finale.utente_id).toBe('u1')
  })
  it('schema precedente: una rettifica silenziosa non tenta mai l’inserimento per il genitore', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: 'PGRST204' } })
    const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'diario', titolo: 't', destinatario: 'genitore', operazione: { ...ordinaria, giornoCompetenza: '2025-01-01', sopprimiGenitori: true } })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })
  it('non usa il fallback per errori reali o quando non ha aggiunto metadati', async () => {
    for (const [code, operazione] of [['23503', ordinaria], ['PGRST204', undefined]] as const) {
      const insert = vi.fn().mockResolvedValue({ error: { code } })
      const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
      expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'diario', titolo: 't', operazione })).toBe(false)
      expect(insert).toHaveBeenCalledTimes(1)
    }
  })
  it('un altro errore dopo la rimozione dei metadati resta un inserimento fallito', async () => {
    const insert = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST204', message: "Could not find the 'giorno_competenza' column" } })
      .mockResolvedValueOnce({ error: { code: 'PGRST204', message: "Could not find the 'titolo' column" } })
    const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'diario', titolo: 't', operazione: ordinaria })).toBe(false)
    expect(insert).toHaveBeenCalledTimes(2)
  })
  it('inserisce una riga notifiche per utente con buffer', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    const accodata = await enqueueNotifiche(supabase, {
      utenteIds: ['u1', 'u2'],
      tipo: 'valutazione',
      titolo: 'Nuova valutazione',
      corpo: 'di Matematica',
      link: '/parent',
      entitaTipo: 'valutazione',
      entitaId: 'v-1',
      bufferMin: 10,
    })

    expect(accodata).toBe(true)
    expect(from).toHaveBeenCalledWith('notifiche')
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      utente_id: 'u1',
      tipo: 'valutazione',
      titolo: 'Nuova valutazione',
      corpo: 'di Matematica',
      link: '/parent',
      entita_tipo: 'valutazione',
      entita_id: 'v-1',
    })
    const t = new Date(rows[0].invio_programmato_il as string).getTime()
    expect(t).toBeGreaterThan(Date.now() + 9 * 60_000)
  })

  it('bufferMin 0 → invio immediato', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'x', titolo: 't', bufferMin: 0 })
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    const t = new Date(rows[0].invio_programmato_il as string).getTime()
    expect(t).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('utenteIds vuoto → nessun insert', async () => {
    const insert = vi.fn()
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    expect(await enqueueNotifiche(supabase, { utenteIds: [], tipo: 'x', titolo: 't' })).toBe(false)
    expect(from).not.toHaveBeenCalled()
  })

  it('deduplica gli utenteIds ripetuti', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, { utenteIds: ['u1', 'u1', 'u2'], tipo: 'x', titolo: 't' })
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
  })
  it('toggle disattivato restituisce false senza scrivere in coda', async () => {
    const db = { admin_settings: [{ scuola_id: 'sede-disattivata-core', notifiche_config: { toggles: { diario: false } } }], notifiche: [] }
    expect(await enqueueNotifiche(creaFintoSupabase(db), { utenteIds: ['u1'], tipo: 'diario', titolo: 't', scuolaId: 'sede-disattivata-core' })).toBe(false)
    expect(db.notifiche).toHaveLength(0)
  })

  it.each([
    ['errore PostgREST', () => Promise.resolve({ error: { code: '23503', message: 'vincolo fittizio' } })],
    ['guasto trasporto', () => Promise.reject(new Error('trasporto fittizio'))],
  ])('%s restituisce false: il chiamante non dichiara una notifica accodata', async (_caso, risultato) => {
    const insert = vi.fn(risultato)
    const supabase = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'diario', titolo: 't' })).toBe(false)
  })

})
