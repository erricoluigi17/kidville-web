import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// T11-F4 — `GET /api/admin/iscrizioni` restituiva TUTTE le domande, intere.
//
// MISURATO in produzione il 2026-08-04 (solo SELECT):
//
//   righe                       299
//   pg_column_size(data)        329 kB
//   proiezione dell'ELENCO      514.435 byte   ← ciò che partiva verso il browser
//   la stessa SENZA `data`       58.012 byte
//
// Due difetti distinti nello stesso punto:
//
//  1. NESSUN TETTO. Niente `.limit()`, niente `.range()`. PostgREST ne taglia
//     comunque 1000 — in silenzio — quindi il difetto non è solo il peso: è che
//     superate le 1000 domande l'elenco perde righe e nessuno lo sa. Il modulo
//     pubblico riceve ~9 invii l'ora: 1000 righe sono meno di cinque mesi.
//
//  2. IL PAYLOAD INTERO NELL'ELENCO. `data` è il jsonb della domanda: nomi e
//     codici fiscali dei minori, ALLERGIE e NOTE MEDICHE in testo libero
//     (art. 9 GDPR), documenti d'identità, recapiti degli adulti. Viaggiava al
//     browser di ogni membro dello staff a OGNI apertura della pagina, anche
//     quando nessuno apriva un dettaglio. La lista mostra il nome del primo
//     bambino e due conteggi: tutto il resto era peso e superficie.
//
// I test qui sotto sono di COMPORTAMENTO, non di forma: il finto PostgREST
// APPLICA DAVVERO `range()` (affetta l'array) e restituisce un `count` proprio,
// slegato dalla lunghezza della pagina. Se la route smette di paginare, lo stub
// restituisce tutto e il test diventa rosso; se la route deducesse il totale da
// `data.length`, il caso «1000 righe, 1400 totali» lo smaschera.
// =============================================================================

const SEDE = 'sc-1'
const ALTRA_SEDE = 'sc-2'
const NOTA_MEDICA = 'NOTA-MEDICA-SENTINELLA-DA-NON-FAR-USCIRE'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  /** Le righe "in tabella", in ordine già decrescente per created_at. */
  invii: [] as Record<string, unknown>[],
  /** `count` che il finto PostgREST dichiara: può essere > delle righe rese. */
  countDichiarato: null as number | null,
  /** Ogni `range(from,to)` osservato. Vuoto ⇒ la route non ha paginato. */
  ranges: [] as { from: number; to: number }[],
  /** Le opzioni passate a `select()`: `{count:'exact'}` o niente. */
  opzioniSelect: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: vi.fn() }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'corpo',
}))
vi.mock('@/lib/scuole/reali', () => ({ nomeSede: async () => 'Kidville Alfa' }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: async () => [SEDE],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(tabella: string) {
      // Filtri applicati DAVVERO: `eq('id')` e `in('scuola_id')` decidono cosa
      // esce, come in PostgREST. Senza, il test sul dettaglio fuori sede
      // resterebbe verde anche togliendo il gate.
      let idChiesto: string | null = null
      let sediChieste: string[] | null = null
      let from = 0
      let to = Number.POSITIVE_INFINITY
      // PostgREST restituisce `count` SOLO se lo si è chiesto: senza
      // `{count:'exact'}` l'header `Content-Range` non porta il totale. Lo stub
      // deve comportarsi così, altrimenti «togliere il count esatto» resterebbe
      // verde per una ragione che in produzione non esiste.
      let contaEsatto = false
      const b: Record<string, unknown> = {}
      b.select = (_c?: string, opts?: unknown) => {
        h.opzioniSelect.push(opts)
        if ((opts as { count?: string })?.count === 'exact') contaEsatto = true
        return b
      }
      b.eq = (col: string, val: string) => {
        if (col === 'id') idChiesto = val
        return b
      }
      b.in = (col: string, vals: string[]) => {
        if (col === 'scuola_id') sediChieste = vals
        return b
      }
      b.contains = () => b
      b.limit = () => b
      b.order = () => b
      b.range = (a: number, z: number) => {
        h.ranges.push({ from: a, to: z })
        from = a
        to = z
        return b
      }
      const filtrate = () => {
        let righe = h.invii
        if (idChiesto !== null) righe = righe.filter((r) => r.id === idChiesto)
        if (sediChieste !== null) righe = righe.filter((r) => sediChieste!.includes(r.scuola_id as string))
        return righe
      }
      const lista = () => {
        if (tabella !== 'enrollment_submissions') return { data: [], error: null, count: null }
        const righe = filtrate()
        // PostgREST taglia comunque a 1000 se nessuno chiede un range.
        const fine = Number.isFinite(to) ? to + 1 : from + 1000
        return {
          data: righe.slice(from, fine),
          error: null,
          count: contaEsatto ? (h.countDichiarato ?? righe.length) : null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => {
        const righe = filtrate()
        return { data: righe[0] ?? null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) })
      b.update = () => ({ eq: async () => ({ data: null, error: null }) })
      b.upsert = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/iscrizioni/route'
import { LIMITE_ISCRIZIONI_DEFAULT, LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'

const chiedi = (qs = '') =>
  GET(new Request(`http://localhost/api/admin/iscrizioni${qs}`) as never)

/** uuid deterministico: la route valida `?id=` con `zUuid`, come la PATCH. */
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

/** Una domanda finta col PESO di una vera: ~1,5 kB di `data`. */
function domanda(i: number, sede = SEDE): Record<string, unknown> {
  return {
    id: uuid(i),
    scuola_id: sede,
    status: i % 3 === 0 ? 'approved' : 'pending',
    assigned_classes: null,
    created_at: '2026-07-20T10:00:00Z',
    data: {
      children: [
        {
          nome: `Bimbo${i}`,
          cognome: `Rossi${i}`,
          codice_fiscale: `CF${i}`,
          data_nascita: '2022-01-01',
          note_mediche: `${NOTA_MEDICA} ${'x'.repeat(600)}`,
          allergies: 'y'.repeat(400),
        },
      ],
      adults: [
        { first_name: `Anna${i}`, last_name: 'Rossi', fiscal_code: `CFA${i}`, email: `a${i}@example.invalid`, phone: '0'.repeat(200) },
      ],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.invii = []
  h.countDichiarato = null
  h.ranges = []
  h.opzioniSelect = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
})

describe('GET /api/admin/iscrizioni — l\'elenco è paginato e dichiara il totale', () => {
  it('1200 domande in tabella ⇒ al più una pagina di righe, e `total` dice 1200', async () => {
    h.invii = Array.from({ length: 1200 }, (_, i) => domanda(i))

    const res = await chiedi()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown[]; total: number }

    // La PAGINA: non più di quanto la route dichiara di restituire.
    expect(json.data.length).toBeLessThanOrEqual(LIMITE_ISCRIZIONI_DEFAULT)
    // Il TOTALE: il client deve poter sapere quante ce ne sono davvero.
    expect(json.total).toBe(1200)
    // E la paginazione dev'essere chiesta al DATABASE, non fatta a valle:
    // affettare in JS 1200 righe già arrivate non risolverebbe niente.
    expect(h.ranges).toHaveLength(1)
    expect(h.ranges[0]).toEqual({ from: 0, to: LIMITE_ISCRIZIONI_DEFAULT - 1 })
  })

  it('esattamente 1000 righe (il tetto PostgREST) con 1400 in tabella ⇒ `total` dice 1400', async () => {
    // Il caso che rende il totale indispensabile: se la route deducesse il
    // totale dalla lunghezza della pagina, il client vedrebbe «1000» e non
    // saprebbe MAI che ce ne sono altre 400.
    h.invii = Array.from({ length: 1000 }, (_, i) => domanda(i))
    h.countDichiarato = 1400

    const res = await chiedi(`?limit=${LIMITE_ISCRIZIONI_MAX}`)
    const json = (await res.json()) as { data: unknown[]; total: number }

    expect(json.total).toBe(1400)
    expect(json.data.length).toBe(LIMITE_ISCRIZIONI_MAX)
    // Il totale viene dal `count` esatto del database, non da `data.length`.
    expect(h.opzioniSelect.some((o) => (o as { count?: string })?.count === 'exact')).toBe(true)
  })

  it('300 domande da ~1,5 kB ⇒ il corpo sta sotto i 100 kB e NON porta note mediche', async () => {
    h.invii = Array.from({ length: 300 }, (_, i) => domanda(i))

    const res = await chiedi(`?limit=${LIMITE_ISCRIZIONI_MAX}`)
    const corpo = await res.text()

    expect(corpo.length).toBeLessThan(100_000)
    // Il guadagno che conta di più non è il peso: è che allergie e note
    // mediche dei minori non partono più verso il browser in un ELENCO.
    expect(corpo).not.toContain(NOTA_MEDICA)
    expect(corpo).not.toContain('allergies')
  })

  it('la riga d\'elenco porta il RIASSUNTO che la lista mostra, non il payload', async () => {
    h.invii = [domanda(7)]
    const res = await chiedi()
    const json = (await res.json()) as { data: Record<string, unknown>[] }
    const riga = json.data[0]

    for (const chiave of ['id', 'scuola_id', 'status', 'assigned_classes', 'created_at']) {
      expect(riga).toHaveProperty(chiave)
    }
    expect(riga).not.toHaveProperty('data')
    expect(riga.riassunto).toEqual({
      bambini: 1,
      adulti: 1,
      primo_bambino: 'Bimbo7 Rossi7',
    })
  })

  it('`?limit=` è clampato ai due estremi: 5000 → il massimo, 0 → almeno una riga', async () => {
    h.invii = Array.from({ length: 1200 }, (_, i) => domanda(i))

    await chiedi('?limit=5000')
    expect(h.ranges.at(-1)).toEqual({ from: 0, to: LIMITE_ISCRIZIONI_MAX - 1 })

    await chiedi('?limit=0')
    expect(h.ranges.at(-1)).toEqual({ from: 0, to: 0 })

    await chiedi('?limit=-3&offset=-9')
    expect(h.ranges.at(-1)).toEqual({ from: 0, to: 0 })
  })

  it('`?offset=` sposta la finestra: la seconda pagina non ripete la prima', async () => {
    h.invii = Array.from({ length: 1200 }, (_, i) => domanda(i))

    const p1 = (await (await chiedi('?limit=50&offset=0')).json()) as { data: { id: string }[] }
    const p2 = (await (await chiedi('?limit=50&offset=50')).json()) as { data: { id: string }[]; total: number }

    expect(p1.data[0].id).toBe(uuid(0))
    expect(p2.data[0].id).toBe(uuid(50))
    expect(p2.total).toBe(1200)
  })
})

describe('GET /api/admin/iscrizioni?id= — il dettaglio, e solo dentro la propria sede', () => {
  it('restituisce il payload COMPLETO della singola domanda', async () => {
    h.invii = [domanda(3)]
    const res = await chiedi(`?id=${uuid(3)}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: Record<string, unknown> }
    expect(json.data.id).toBe(uuid(3))
    expect(JSON.stringify(json.data)).toContain(NOTA_MEDICA)
  })

  it('la domanda di un\'ALTRA sede non si apre (404), e il payload non esce', async () => {
    h.invii = [domanda(9, ALTRA_SEDE)]
    const res = await chiedi(`?id=${uuid(9)}`)
    const corpo = await res.text()
    expect(corpo).not.toContain(NOTA_MEDICA)
    expect(res.status).toBe(404)
  })
})
