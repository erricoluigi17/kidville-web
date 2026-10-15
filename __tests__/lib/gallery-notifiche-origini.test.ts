import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { politicaNotificaOperazione } from '@/lib/storici/retroattivita'

const h = vi.hoisted(() => ({ genitori: vi.fn(), toggle: vi.fn(), evento: vi.fn(), log: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: h.genitori, genitoriDiClassi: h.genitori, genitoriDiScuola: h.genitori }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: h.toggle }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.evento }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log }))

import { notificaGenitoriGalleria } from '@/lib/gallery/notifica-genitori'
import { ritiraNotificheMediaStorico } from '@/lib/gallery/notifiche-pending'

const staff = { id: 'segreteria', role: 'segreteria' } as const
const storico = politicaNotificaOperazione({ attore: staff, giornoCompetenza: '2026-10-14', ora: new Date('2026-10-14T22:06:00Z') })
const input = { scuolaId: 'sede-a', uploadedBy: 'autore', mediaId: 'foto-nuova', tagAlunni: ['figlio'], classi: [], operazione: 'gallery:POST' }
const media = { id: 'foto', uploaded_by: 'autore', scuola_id: 'sede-a', giorno_competenza: '2026-10-14' }
const pending = (id: string, extra: Riga = {}): Riga => ({ id, tipo: 'galleria', entita_id: 'autore', utente_id: 'genitore', giorno_competenza: null, politica_operazione: null, creato_il: '2026-10-14T21:55:00Z', invio_programmato_il: '2026-10-14T22:05:00Z', push_inviata_il: null, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.genitori.mockResolvedValue(['genitore', 'genitore'])
  h.toggle.mockResolvedValue(true)
  h.evento.mockResolvedValue(undefined)
})

describe('galleria — provenienza esplicita e RPC atomica', () => {
  it('un NUOVO inserimento storico conserva tutti i batch di altre foto e sedi, senza lookup o RPC', async () => {
    const db = { notifiche: [pending('altre-foto'), pending('altra-sede')] }
    const rpc = vi.fn()
    const client = creaFintoSupabase(db)
    client.rpc = rpc as unknown as typeof client.rpc
    expect(await notificaGenitoriGalleria(client, { ...input, politica: storico })).toBe(0)
    expect(db.notifiche.map(n => n.id)).toEqual(['altre-foto', 'altra-sede'])
    expect(h.genitori).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(h.evento).not.toHaveBeenCalled()
  })

  it('accoda tramite RPC con sede, id media e decisione originale, deduplicando soltanto i destinatari', async () => {
    const politica = { ...storico, sopprimiGenitori: false }
    const rpc = vi.fn(async () => ({ data: 1, error: null }))
    const client = creaFintoSupabase({ notifiche: [] })
    client.rpc = rpc as unknown as typeof client.rpc
    expect(await notificaGenitoriGalleria(client, { ...input, politica })).toBe(1)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('notifiche_galleria_accoda', {
      p_scuola_id: 'sede-a', p_uploaded_by: 'autore', p_media_id: 'foto-nuova', p_utente_ids: ['genitore'], p_politica_operazione: politica, p_buffer_min: 30,
    })
    expect(h.evento).not.toHaveBeenCalled()
  })

  it('toggle spento non chiama la RPC, neppure con destinatari esistenti', async () => {
    h.toggle.mockResolvedValue(false)
    const client = creaFintoSupabase({ notifiche: [] })
    const rpc = vi.fn()
    client.rpc = rpc as unknown as typeof client.rpc
    expect(await notificaGenitoriGalleria(client, input)).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
    expect(h.evento).not.toHaveBeenCalled()
  })

  it('RPC assente in CI: avviso odierno senza debounce che possa cancellare batch di altre sedi', async () => {
    const db = { notifiche: [pending('altra-sede')] }
    const client = creaFintoSupabase(db, [], { rpc: { notifiche_galleria_accoda: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find public.notifiche_galleria_accoda in schema cache' } }) } })
    expect(await notificaGenitoriGalleria(client, input)).toBe(2)
    expect(h.evento).toHaveBeenCalledWith(client, expect.objectContaining({ scuolaId: 'sede-a', debounce: false, destinatario: 'genitore', utenteIds: ['genitore', 'genitore'] }))
    expect(db.notifiche.map(n => n.id)).toEqual(['altra-sede'])
    expect(h.log).toHaveBeenCalledWith('notifica', 'warn', expect.objectContaining({ esito: 'galleria-coda-legacy-senza-aggregazione' }), expect.anything())
  })

  it.each(['42501', '23503', '42703'])('errore reale %s non viene travestito da schema precedente', async code => {
    const errore = { code, message: 'notifiche_galleria_accoda failed' }
    const client = creaFintoSupabase({}, [], { rpc: { notifiche_galleria_accoda: () => ({ data: null, error: errore }) } })
    expect(await notificaGenitoriGalleria(client, input)).toBeNull()
    expect(h.evento).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'galleria-accodamento-fallito' }), errore)
  })

  it('rettifica/eliminazione: passa esclusivamente fonte, sede e giorno ORIGINALI alla RPC; legacy ambiguo conservato e misurato', async () => {
    const db: DBFinto = { notifiche: [pending('legacy'), pending('inviata', { push_inviata_il: '2026-10-14T22:06:00Z' }), pending('altro-autore', { entita_id: 'altro' })] }
    const rpc = vi.fn(async () => ({ data: 1, error: null }))
    const client = creaFintoSupabase(db)
    client.rpc = rpc as unknown as typeof client.rpc
    expect(await ritiraNotificheMediaStorico(client, { attore: staff, media, operazione: 'gallery:PATCH' })).toBe(true)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('notifiche_galleria_ritira', { p_scuola_id: 'sede-a', p_uploaded_by: 'autore', p_media_id: 'foto', p_giorno: '2026-10-14' })
    expect(db.notifiche.map(n => n.id)).toEqual(['legacy', 'inviata', 'altro-autore'])
    expect(h.log).toHaveBeenCalledWith('notifica', 'warn', expect.objectContaining({ esito: 'galleria-legacy-origini-ambigue', n: 1 }))
  })

  it('metadati originali prevalgono sulla creazione: nessun ritiro di giornate inventate dal timestamp', async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }))
    const client = creaFintoSupabase({ notifiche: [] })
    client.rpc = rpc as unknown as typeof client.rpc
    expect(await ritiraNotificheMediaStorico(client, { attore: staff, media: { ...media, giorno_competenza: null, politica_operazione: storico, created_at: '2026-10-13T10:00:00Z' }, operazione: 'gallery:DELETE' })).toBe(true)
    expect(rpc).toHaveBeenCalledWith('notifiche_galleria_ritira', expect.objectContaining({ p_giorno: '2026-10-14' }))
  })

  it('ritiro RPC fallito non tenta mai una delete generica per caricatore', async () => {
    const db = { notifiche: [pending('legacy')] }
    const client = creaFintoSupabase(db, [], { rpc: { notifiche_galleria_ritira: () => ({ data: null, error: { code: 'PGRST202', message: 'notifiche_galleria_ritira missing' } }) } })
    expect(await ritiraNotificheMediaStorico(client, { attore: staff, media, operazione: 'gallery:DELETE' })).toBe(false)
    expect(db.notifiche.map(n => n.id)).toEqual(['legacy'])
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'galleria-ritiro-origine-fallito' }), expect.anything())
  })
})
