import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

// La sede dichiarata nel body è la STESSA che lo scope restituisce: dal 31/07 la
// route la valida (`sedeDichiarataFuoriScope`) invece di ripiegare in silenzio su
// un'altra, quindi un uuid scollegato dal mock darebbe 403 e questi casi — che
// parlano di shallow-merge JSONB, non di sedi — fallirebbero per il motivo sbagliato.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
  /** Le colonne chieste a ogni SELECT, in ordine: è la prova che il ritento sia avvenuto. */
  selects: [] as string[],
  /**
   * Errore da restituire alla SELECT n-esima (indice = ordine di chiamata).
   * `undefined` = quella select riesce. Serve a simulare il DB E2E della CI, che
   * risponde `42703` quando si legge una colonna nata dopo il suo baseline.
   */
  erroriSelect: [] as (({ code: string; message: string }) | undefined)[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async () => {
  const { SEDE_A: SEDE } = await import('../fixtures/sedi')
  return {
    resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
    resolveScuoleAttive: async () => [SEDE],
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      // Le colonne chieste contano: PostgREST restituisce SOLO quelle, e un ritento
      // ridotto non deve poter "vedere" una colonna che non ha chiesto — altrimenti
      // il test proverebbe qualcosa che il database non fa.
      let colonne = '*'
      b.select = (cols?: string) => { if (typeof cols === 'string') colonne = cols; return b }
      b.eq = () => b
      b.maybeSingle = async () => {
        const errore = h.erroriSelect[h.selects.length]
        h.selects.push(colonne)
        if (errore) return { data: null, error: errore }
        if (!h.existing) return { data: null, error: null }
        if (colonne === '*') return { data: h.existing, error: null }
        const chieste = colonne.split(',').map((c) => c.trim()).filter(Boolean)
        const riga = h.existing as Record<string, unknown>
        return {
          data: Object.fromEntries(chieste.filter((c) => c in riga).map((c) => [c, riga[c]])),
          error: null,
        }
      }
      b.upsert = (row: Record<string, unknown>) => {
        h.upserted = row
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

describe('PATCH /api/admin/settings — fiscale_config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.upserted = null
    h.existing = null
    h.selects = []
    h.erroriSelect = []
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('accetta fiscale_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { fiscale_config: { denominazione: 'Kidville Giugliano' } }
    const res = await PATCH(req({ scuola_id: SEDE_A, fiscale_config: { piva: '01234567890' } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.fiscale_config).toEqual({ denominazione: 'Kidville Giugliano', piva: '01234567890' })
  })

  it('accetta solleciti_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { solleciti_config: { enabled: false } }
    const res = await PATCH(req({ scuola_id: SEDE_A, solleciti_config: { cadenza_min_giorni: 10 } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.solleciti_config).toEqual({ enabled: false, cadenza_min_giorni: 10 })
  })

  it('accetta causali_config e lo salva in shallow-merge, preservando le altre chiavi/categorie', async () => {
    // JSONB flat per-slug: { default, <slug> }. Salvare una categoria NON deve
    // sovrascrivere il predefinito né le altre categorie già impostate.
    h.existing = { causali_config: { default: '{descrizione} - {sede}', gita: 'Quota {descrizione}' } }
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      causali_config: { mensa: 'Mensa {mese} {anno}' },
    }))
    expect(res.status).toBe(200)
    expect(h.upserted?.causali_config).toEqual({
      default: '{descrizione} - {sede}',
      gita: 'Quota {descrizione}',
      mensa: 'Mensa {mese} {anno}',
    })
  })

  it('causali_config: una stringa VUOTA rimuove la chiave (reset al predefinito) e i valori non-stringa sono scartati', async () => {
    h.existing = { causali_config: { default: '{descrizione} - {sede}', retta: 'Retta {mese}', mensa: 'Mensa' } }
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      // retta svuotata (reset), mensa aggiornata, un valore non-stringa da scartare
      causali_config: { retta: '', mensa: 'Mensa {anno}', divisa: 123 },
    }))
    expect(res.status).toBe(200)
    expect(h.upserted?.causali_config).toEqual({
      default: '{descrizione} - {sede}',
      mensa: 'Mensa {anno}',
    })
  })

  it('NON accetta più fattura_causale_template: il campo unico per tutta la scuola non si scrive più', async () => {
    // Era il difetto: la route lo accettava e lo scriveva in colonna, l'emissione non
    // lo leggeva mai. Chi lo compilava riceveva la conferma di salvataggio e otteneva
    // una fattura con la causale di fabbrica. Ora la causale della fattura vive in
    // `fattura_causali_config` (per tipologia di pagamento) e questo campo viene
    // ignorato da zod, che è meglio di «scritto e poi scartato».
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      fattura_causale_template: 'Retta {periodo} - {alunno}',
      retta_default_importo: 160,
    }))
    expect(res.status).toBe(200)
    expect(h.upserted).not.toHaveProperty('fattura_causale_template')
    // …e il resto della stessa PATCH passa comunque.
    expect(h.upserted?.retta_default_importo).toBe(160)
  })
})

/**
 * La SELECT che legge il pregresso per lo shallow-merge: PostgREST NON LANCIA, quindi
 * l'unico modo di accorgersi che è fallita è guardare `{ error }`. Se non lo si guarda,
 * `existing` resta `null`, il merge riparte da `{}` per TUTTE le chiavi della stessa
 * PATCH e la configurazione già salvata sparisce senza un errore e senza un log.
 */
describe('PATCH /api/admin/settings — la lettura del pregresso non si ignora', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.upserted = null
    h.existing = null
    h.selects = []
    h.erroriSelect = []
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('una SELECT fallita per un motivo NON degradabile ferma la PATCH con 500, invece di riscrivere da zero', async () => {
    h.existing = { causali_config: { default: 'D', gita: 'G' } }
    h.erroriSelect = [{ code: '08006', message: 'connessione interrotta' }]
    const res = await PATCH(req({ scuola_id: SEDE_A, causali_config: { mensa: 'M' } }))
    expect(res.status).toBe(500)
    // La prova che conta: NIENTE è stato scritto. Un 200 con `{ mensa: 'M' }` avrebbe
    // cancellato `default` e `gita` senza che nessuno se ne accorgesse.
    expect(h.upserted).toBeNull()
    // …e il rifiuto è traducibile: il codice, non la prosa italiana del server.
    expect(await res.json()).toMatchObject({ codice: 'CONFIG_PREGRESSO_NON_LETTO' })
  })

  it('42703 su una PATCH con DUE colonne: si rilegge una colonna per volta e il pregresso di quella ESISTENTE si conserva', async () => {
    // Il DB E2E della CI non è migrato: `fattura_causali_config` non c'è. PostgREST fa
    // fallire l'INTERA select — anche per `causali_config`, che invece esiste — e non
    // dice quale colonna manchi. Senza il sondaggio per colonna, `gita` sparirebbe.
    h.existing = { causali_config: { default: 'D', gita: 'G' } }
    h.erroriSelect = [
      { code: '42703', message: 'column admin_settings.fattura_causali_config does not exist' },
      undefined, // sonda su `causali_config`: esiste
      { code: '42703', message: 'column admin_settings.fattura_causali_config does not exist' },
    ]
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      causali_config: { mensa: 'M' },
      fattura_causali_config: { mensa: 'F' },
    }))
    expect(res.status).toBe(200)
    expect(h.selects).toEqual(['causali_config,fattura_causali_config', 'causali_config', 'fattura_causali_config'])
    expect(h.upserted?.causali_config).toEqual({ default: 'D', gita: 'G', mensa: 'M' })
    // La colonna che sul DB non esiste parte davvero da zero: è la verità, non una perdita.
    expect(h.upserted?.fattura_causali_config).toEqual({ mensa: 'F' })
  })

  it('42703 su una PATCH con UNA colonna sola: nessun sondaggio, si riparte da vuoto senza rompere', async () => {
    h.erroriSelect = [{ code: '42703', message: 'column admin_settings.rette_config does not exist' }]
    const res = await PATCH(req({ scuola_id: SEDE_A, rette_config: { sconto_fratelli: { enabled: true } } }))
    expect(res.status).toBe(200)
    expect(h.selects).toEqual(['rette_config'])
  })

  it('un errore non degradabile DURANTE il sondaggio per colonna ferma comunque la PATCH', async () => {
    h.existing = { causali_config: { default: 'D' } }
    h.erroriSelect = [
      { code: '42703', message: 'column does not exist' },
      { code: '57014', message: 'statement timeout' }, // sonda su `causali_config`
    ]
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      causali_config: { mensa: 'M' },
      fattura_causali_config: { mensa: 'F' },
    }))
    expect(res.status).toBe(500)
    expect(h.upserted).toBeNull()
  })
})
