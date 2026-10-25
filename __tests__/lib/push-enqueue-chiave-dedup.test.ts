import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { enqueueNotifiche } from '@/lib/push/enqueue'

/**
 * LA CHIAVE DI DEDUPLICA (sessione 8 della seconda serie, D12). Chi la passa chiede «al massimo una
 * riga per chiave»: la scrittura è un upsert con `ignoreDuplicates` (ON CONFLICT DO NOTHING) e
 * l'arbitro è l'indice unico `notifiche_chiave_dedup_key`. Sul DB non migrato si ripiega
 * sull'insert di sempre, e lo si dice.
 */

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const AVVISO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const chiave = (uid: string) => `modulo_promemoria:${AVVISO}:${uid}:2026-10-21`

function finto(risposte: { upsert?: unknown[]; insert?: unknown[] }) {
  const upsert = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ error: null }))
  const insert = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ error: null }))
  for (const r of risposte.upsert ?? []) upsert.mockResolvedValueOnce(r)
  for (const r of risposte.insert ?? []) insert.mockResolvedValueOnce(r)
  return { client: { from: () => ({ upsert, insert }) } as unknown as SupabaseClient, upsert, insert }
}

describe('enqueueNotifiche — chiave di deduplica', () => {
  beforeEach(() => vi.clearAllMocks())

  it('con la chiave: upsert ON CONFLICT (chiave_dedup) DO NOTHING, una chiave per destinatario', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1, U2], tipo: 'modulo_promemoria', titolo: 't', entitaId: AVVISO, chiaveDedup: chiave,
    })).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
    const [righe, opzioni] = upsert.mock.calls[0] as [Array<{ chiave_dedup: string }>, unknown]
    expect(opzioni).toEqual({ onConflict: 'chiave_dedup', ignoreDuplicates: true })
    expect(righe.map((r) => r.chiave_dedup)).toEqual([chiave(U1), chiave(U2)])
  })

  it('senza la chiave: l’insert di sempre, senza la colonna', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, { utenteIds: [U1], tipo: 'diario', titolo: 't' })).toBe(true)
    expect(upsert).not.toHaveBeenCalled()
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
  })

  // §5 della specifica: schema nuovo non ancora installato (DB della CI, finestra del merge) = riga
  // `info` che dice perché, solo su questa chiamata. I codici: 42703/PGRST204 colonna assente
  // (`colonnaNuovaAssente`), 42P10 colonna presente ma nessun indice che faccia da arbitro.
  // I messaggi sono quelli veri: PostgREST e Postgres NOMINANO la colonna che manca; il 42P10 no.
  const MESSAGGI: Record<string, string> = {
    '42P10': 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
    PGRST204: "Could not find the 'chiave_dedup' column of 'notifiche' in the schema cache",
    '42703': 'column "chiave_dedup" of relation "notifiche" does not exist',
  }
  it.each(['42P10', 'PGRST204', '42703'])('DB senza colonna o senza arbitro (%s): ripiega sull’insert e lo dice a livello info', async (code) => {
    const { client, upsert, insert } = finto({ upsert: [{ error: { code, message: MESSAGGI[code] } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.objectContaining({ code }),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith('notifica', 'warn', expect.anything(), expect.anything())
  })

  it('un errore vero non ripiega: resta un inserimento fallito, a livello error', async () => {
    const { client, insert } = finto({ upsert: [{ error: { code: '23503', message: 'fk' } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'insert-fallito' }), expect.objectContaining({ code: '23503' }),
    )
  })

  // La colonna assente deve essere PROPRIO `chiave_dedup`: con un'altra colonna mancante buttare la
  // chiave perderebbe la deduplica, e la riga «chiave-dedup-assente» direbbe il falso.
  it.each([
    ['PGRST204', "Could not find the 'colonna_nuova' column of 'notifiche' in the schema cache"],
    ['42703', 'column "colonna_nuova" of relation "notifiche" does not exist'],
  ])('un’ALTRA colonna assente (%s) non è la chiave: nessun ripiego, inserimento fallito', async (code, message) => {
    const { client, upsert, insert } = finto({ upsert: [{ error: { code, message } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(false)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(insert).not.toHaveBeenCalled()
    expect(h.logEvento).not.toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.anything(),
    )
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'insert-fallito' }), expect.objectContaining({ code }),
    )
  })

  const OPERAZIONE = { giornoCompetenza: '2026-10-21', giornoOperazioneRoma: '2026-10-21', sopprimiGenitori: false }

  it('chiave installata, manca giorno_competenza: si toglie il metadato e la CHIAVE RESTA', async () => {
    const { client, upsert, insert } = finto({
      upsert: [{ error: { code: 'PGRST204', message: "Could not find the 'giorno_competenza' column of 'notifiche' in the schema cache" } }],
    })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', operazione: OPERAZIONE, destinatario: 'personale', chiaveDedup: chiave,
    })).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(2)
    const [riprova] = upsert.mock.calls[1] as [Array<Record<string, unknown>>]
    expect(riprova[0]).toMatchObject({ chiave_dedup: chiave(U1) })
    expect(riprova[0]).not.toHaveProperty('giorno_competenza')
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'warn', expect.objectContaining({ esito: 'metadati-storici-assenti' }), expect.anything(),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.anything(),
    )
  })

  it('manca prima il metadato e POI la chiave: i due ripieghi si compongono in qualunque ordine', async () => {
    const { client, upsert, insert } = finto({
      upsert: [
        { error: { code: 'PGRST204', message: "Could not find the 'giorno_competenza' column of 'notifiche' in the schema cache" } },
        { error: { code: 'PGRST204', message: "Could not find the 'chiave_dedup' column of 'notifiche' in the schema cache" } },
      ],
    })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', operazione: OPERAZIONE, destinatario: 'personale', chiaveDedup: chiave,
    })).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(insert).toHaveBeenCalledTimes(1)
    const [finale] = insert.mock.calls[0] as [Array<Record<string, unknown>>]
    expect(finale[0]).not.toHaveProperty('chiave_dedup')
    expect(finale[0]).not.toHaveProperty('giorno_competenza')
    expect(finale[0]).toHaveProperty('politica_operazione')
  })
})

/**
 * La stessa chiave contro una tabella `notifiche` finta CON STATO (portata dalla revisione
 * indipendente): l'upsert con `onConflict: chiave_dedup` + `ignoreDuplicates` si comporta come
 * `INSERT … ON CONFLICT (chiave_dedup) DO NOTHING`, e PostgREST risponde PGRST204 sulla prima
 * colonna che non conosce. Qui si vede il RISULTATO (quante righe restano), non solo la chiamata.
 */
class TabellaNotifiche {
  colonne = new Set([
    'utente_id', 'tipo', 'titolo', 'corpo', 'link', 'entita_tipo', 'entita_id', 'invio_programmato_il',
    'chiave_dedup', 'giorno_competenza', 'politica_operazione',
  ])
  righe: Record<string, unknown>[] = []

  private async scrivi(righe: Record<string, unknown>[], opzioni?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    await new Promise((r) => setTimeout(r, 1))
    for (const r of righe) {
      for (const k of Object.keys(r)) {
        if (!this.colonne.has(k)) {
          return { data: null, error: { code: 'PGRST204', message: `Could not find the '${k}' column of 'notifiche' in the schema cache` } }
        }
      }
    }
    const nuove: Record<string, unknown>[] = []
    for (const r of righe) {
      const k = r.chiave_dedup
      if (k != null && [...this.righe, ...nuove].some((x) => x.chiave_dedup === k)) {
        if (opzioni?.ignoreDuplicates) continue
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "notifiche_chiave_dedup_key"' } }
      }
      nuove.push(r)
    }
    this.righe.push(...nuove)
    return { data: null, error: null }
  }

  client() {
    return {
      from: () => ({
        insert: (righe: Record<string, unknown>[]) => this.scrivi(righe),
        upsert: (righe: Record<string, unknown>[], opzioni: { onConflict?: string; ignoreDuplicates?: boolean }) =>
          this.scrivi(righe, opzioni ?? {}),
      }),
    } as unknown as SupabaseClient
  }
}

describe('enqueueNotifiche — chiave di deduplica, tabella con stato', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stesso promemoria due volte: una riga per destinatario, una chiave per destinatario', async () => {
    const t = new TabellaNotifiche()
    const p = { utenteIds: [U1, U2], tipo: 'modulo_promemoria', titolo: 't', entitaId: AVVISO, chiaveDedup: chiave }
    expect(await enqueueNotifiche(t.client(), p)).toBe(true)
    expect(await enqueueNotifiche(t.client(), p)).toBe(true)
    expect(t.righe).toHaveLength(2)
    expect(new Set(t.righe.map((r) => r.chiave_dedup)).size).toBe(2)
  })

  it('due giri CONCORRENTI dello stesso promemoria: una riga per destinatario', async () => {
    const t = new TabellaNotifiche()
    const p = { utenteIds: [U1, U2], tipo: 'modulo_promemoria', titolo: 't', entitaId: AVVISO, chiaveDedup: chiave }
    await Promise.all([enqueueNotifiche(t.client(), p), enqueueNotifiche(t.client(), p)])
    expect(t.righe).toHaveLength(2)
  })

  it('chiave installata, manca giorno_competenza: due giri concorrenti lasciano UNA riga, con la chiave', async () => {
    const t = new TabellaNotifiche()
    t.colonne.delete('giorno_competenza')
    const p = {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't',
      operazione: { giornoCompetenza: '2026-10-21', giornoOperazioneRoma: '2026-10-21', sopprimiGenitori: false },
      destinatario: 'personale' as const, chiaveDedup: chiave,
    }
    await Promise.all([enqueueNotifiche(t.client(), p), enqueueNotifiche(t.client(), p)])
    expect(t.righe).toHaveLength(1)
    expect(t.righe[0]).toMatchObject({ chiave_dedup: chiave(U1) })
    expect(h.logEvento).not.toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.anything(),
    )
  })

  it('DB della CI (colonna chiave_dedup assente): la notifica si scrive lo stesso, senza chiave', async () => {
    const t = new TabellaNotifiche()
    t.colonne.delete('chiave_dedup')
    expect(await enqueueNotifiche(t.client(), { utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave })).toBe(true)
    expect(t.righe).toHaveLength(1)
    expect(t.righe[0]).not.toHaveProperty('chiave_dedup')
  })
})
