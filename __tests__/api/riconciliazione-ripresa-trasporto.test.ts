import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─── LA RIPRESA DEL LOTTO NON HA UNA TABELLA SUA: HA QUESTA LETTURA ─────────
 *
 * Un lotto di fatture che si ferma a metà — e si ferma, per progetto, al primo
 * esito di trasporto ignoto — deve poter essere ripreso. La domanda che decide
 * tutto è: **una fattura partita ma mai confermata da Aruba torna fra le «da
 * fatturare»?** Se tornasse, il lotto successivo la riemetterebbe: una SECONDA
 * fattura vera per la stessa retta, che si corregge solo con una nota di
 * variazione.
 *
 * La riga che `emissione.ts` scrive in quel caso è
 * `{ sdi_stato: null, sdi_stato_label: 'Trasporto fallito' }` — non `sdi_stato: 2`,
 * che significa «Aruba ha guardato il documento e l'ha respinto» ed è falso di
 * fronte a un `429`, a un `401` o a un timeout. Questo file misura che quella riga
 * esca dal GET del registro come **`{ stato: 'emessa' }`**, quindi `fatturaGiaFatta`
 * vera, quindi FUORI dal bidone «Da fatturare».
 *
 * ⚠️ `sdi_stato_label` sta nella fixture ma NON nella `select` della rotta
 * (`FATTURE_SELECT`), e il finto client qui sotto PROIETTA sulle sole colonne
 * chieste — come fa PostgREST. È voluto: a decidere è `sdi_stato` da solo, e
 * l'etichetta è ciò che legge la segreteria in tabella. Se un giorno la decisione
 * cominciasse a dipendere dall'etichetta, questo test lo direbbe (uscirebbe `null`).
 *
 * ⚠️ IL FINTO CLIENT NON È PIATTO: ogni tabella ha il suo elenco, e una risposta
 * uguale per tutte renderebbe il caso verde anche senza la lettura di
 * `fatture_emesse`.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  eventi: [] as { evento: string; livello: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string) => { h.eventi.push({ evento, livello }) },
  }
})

vi.mock('@/lib/supabase/server-client', () => {
  type Filtro = { op: 'eq' | 'in' | 'gte' | 'lte'; col: string; val: unknown }

  const proietta = (riga: Record<string, unknown>, cols: string) => {
    const chiavi = cols.split(',').map((c) => c.trim()).filter(Boolean)
    if (chiavi.length === 0) return { ...riga }
    return Object.fromEntries(chiavi.map((k) => [k, k in riga ? riga[k] : null]))
  }
  const passa = (riga: Record<string, unknown>, filtri: Filtro[]) =>
    filtri.every((f) => {
      const v = riga[f.col]
      if (f.op === 'eq') return v === f.val
      if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v)
      if (f.op === 'gte') return String(v) >= String(f.val)
      return String(v) <= String(f.val)
    })

  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        const filtri: Filtro[] = []
        let cols = ''
        let limite: number | null = null
        const b: Record<string, unknown> = {}
        b.select = (c?: string) => { cols = c ?? ''; return b }
        b.eq = (col: string, val: unknown) => { filtri.push({ op: 'eq', col, val }); return b }
        b.in = (col: string, val: unknown) => { filtri.push({ op: 'in', col, val }); return b }
        b.gte = (col: string, val: unknown) => { filtri.push({ op: 'gte', col, val }); return b }
        b.lte = (col: string, val: unknown) => { filtri.push({ op: 'lte', col, val }); return b }
        b.order = () => b
        b.limit = (n: number) => { limite = n; return b }
        b.range = () => b
        b.then = (resolve: (v: unknown) => unknown) => {
          const righe = (h.db[table] ?? []).filter((r) => passa(r, filtri))
          const finestra = limite == null ? righe : righe.slice(0, limite)
          return resolve({ data: finestra.map((r) => proietta(r, cols)), error: null })
        }
        return b
      },
    }),
  }
})

import { GET } from '@/app/api/pagamenti/riconciliazione/route'
// Il predicato del MOTORE, non una seconda copia scritta qui: è lo stesso che
// legge il chip della lista e lo stesso che il lotto userà per decidere quali
// righe si possono selezionare.
import { fatturaGiaFatta, fatturaDaFare } from '@/lib/pagamenti/fatturazione-riga'

const MID = 'dddddddd-dddd-4ddd-8ddd-000000000001'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione${qs}`) as never)

const movimento = {
  id: MID,
  import_id: null,
  scuola_id: 'sc-1',
  data_operazione: '2026-09-05',
  importo: 150,
  causale: 'BONIFICO RETTA',
  controparte: 'ORDINANTE',
  stato: 'confermato',
  suggerimenti: null,
  pagamento_id: PID,
  confermato_il: '2026-09-05T10:00:00Z',
}

/**
 * La riga a registro di una fattura il cui INVIO non ha avuto esito noto: il
 * numero è stato consumato, il documento potrebbe essere allo SdI, e nessuno lo
 * sa. È ciò che scrive `emettiFatturaPagamento` nei due rami del trasporto.
 */
const rigaTrasportoFallito = {
  pagamento_id: PID,
  numero: 1949,
  anno: 2026,
  sezionale: 'FPR',
  sdi_stato: null,
  sdi_stato_label: 'Trasporto fallito',
  quota_adult_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {}
  h.eventi = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('GET /api/pagamenti/riconciliazione — una fattura dall’esito di trasporto IGNOTO', () => {
  it('esce come `{ stato: "emessa" }`, col numero: il documento è partito, la conferma no', async () => {
    h.db.riconciliazione_movimenti = [movimento]
    // Il RIASSUNTO sul pagamento dice `in_attesa`: è il caso normale dopo un
    // trasporto ignoto con la riga a registro scritta.
    h.db.pagamenti = [{ id: PID, scuola_id: 'sc-1', stato: 'pagato', fattura_stato: 'in_attesa' }]
    h.db.fatture_emesse = [rigaTrasportoFallito]

    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 1949/26'] })
  })

  it('il MOTORE la considera già fatta: fuori dal bidone «da fatturare»', async () => {
    h.db.riconciliazione_movimenti = [movimento]
    h.db.pagamenti = [{ id: PID, scuola_id: 'sc-1', stato: 'pagato', fattura_stato: 'in_attesa' }]
    h.db.fatture_emesse = [rigaTrasportoFallito]

    const riga = (await (await get()).json()).data[0]
    expect(fatturaGiaFatta(riga), 'una fattura partita non si rifà').toBe(true)
    expect(fatturaDaFare(riga), 'ripescarla significherebbe emetterne una SECONDA').toBe(false)
  })

  it('anche col RIASSUNTO fermo a `non_richiesta`: vincono i DOCUMENTI', async () => {
    // Il caso in cui l'aggiornamento di `pagamenti.fattura_stato` non è andato a
    // buon fine dopo l'invio: se a decidere fosse il riassunto, questa riga
    // tornerebbe fra le «da fatturare» con un numero già consumato.
    h.db.riconciliazione_movimenti = [movimento]
    h.db.pagamenti = [{ id: PID, scuola_id: 'sc-1', stato: 'pagato', fattura_stato: 'non_richiesta' }]
    h.db.fatture_emesse = [rigaTrasportoFallito]

    const riga = (await (await get()).json()).data[0]
    expect(riga.fattura.stato).toBe('emessa')
    expect(fatturaDaFare(riga)).toBe(false)
  })

  it('`?fattura=da_fatturare` non la restituisce, `?fattura=fatturate` sì', async () => {
    h.db.riconciliazione_movimenti = [movimento]
    h.db.pagamenti = [{ id: PID, scuola_id: 'sc-1', stato: 'pagato', fattura_stato: 'in_attesa' }]
    h.db.fatture_emesse = [rigaTrasportoFallito]

    expect((await (await get('?fattura=da_fatturare')).json()).data).toEqual([])
    const fatturate = (await (await get('?fattura=fatturate')).json()).data
    expect(fatturate.map((r: { id: string }) => r.id)).toEqual([MID])
  })

  it('CONTROLLO NEGATIVO: uno SCARTO vero (`sdi_stato: 2`) resta da rifare', async () => {
    // Senza questo caso, il test qui sopra sarebbe verde anche su una rotta che
    // dichiara «emessa» qualunque riga esista in `fatture_emesse` — cioè su una
    // che non distingue più il trasporto ignoto dal rifiuto di merito.
    h.db.riconciliazione_movimenti = [movimento]
    h.db.pagamenti = [{ id: PID, scuola_id: 'sc-1', stato: 'pagato', fattura_stato: 'scartata' }]
    h.db.fatture_emesse = [{ ...rigaTrasportoFallito, sdi_stato: 2, sdi_stato_label: 'Errore upload' }]

    const riga = (await (await get()).json()).data[0]
    expect(riga.fattura).toEqual({ stato: 'scartata', numeri: [] })
    expect(fatturaDaFare(riga)).toBe(true)
    expect(fatturaGiaFatta(riga)).toBe(false)
  })
})
