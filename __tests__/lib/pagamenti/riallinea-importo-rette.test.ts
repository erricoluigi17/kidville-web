import { describe, it, expect, vi, beforeEach } from 'vitest'
import { riallineaImportoRetteFuture } from '@/lib/pagamenti/scadenze'

// =============================================================================
// LA RETTA CORRETTA IN ANAGRAFICA SCENDE SUI PAGAMENTI — e si ferma dove deve.
//
// ─── IL GUASTO, RICOSTRUITO DALL'AUDIT DI PRODUZIONE ─────────────────────────
// 2026-09-02, Kidville Aversa:
//   14:46:53  generate 98 rette del mese
//   14:53:49  la Direzione corregge in anagrafica 330 → 300
//   14:56     si prova a fatturare: il pagamento porta ancora 330
// Dodici rette su 98 erano divergenti, una per ogni correzione fatta dopo le
// 14:46. Nessun errore, nessun avviso: la correzione sembrava fatta e non lo era.
//
// La controprova che NON era la generazione a sbagliare: Giugliano, generata lo
// stesso giorno e mai corretta dopo, aveva 0 divergenze su 227.
//
// ─── COSA COLLAUDA QUESTO FILE ───────────────────────────────────────────────
// Un caso che DEVE cambiare e quattro che NON devono. I quattro contano più del
// primo: un riallineamento troppo largo riscrive importi già comunicati alle
// famiglie o già finiti su un documento fiscale, e sarebbe un danno peggiore di
// quello che ripara.
// =============================================================================

const CAT = 'cat-retta'
const ALUNNO = 'al-1'
const MESE_CORRENTE = `${new Date().toISOString().slice(0, 8)}01`

interface Riga {
  id: string
  importo: number
  importo_pagato?: number | null
  fattura_aruba_id?: string | null
  fattura_stato?: string | null
}

const h = vi.hoisted(() => ({
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

/** Registra i filtri applicati, così si può asserire su ciò che NON viene chiesto. */
let filtri: { metodo: string; col: string; val: unknown }[] = []
let updates: { id: string; row: Record<string, unknown> }[] = []

const fintoSupabase = (righe: Riga[], opts: { categoria?: boolean; erroreLettura?: unknown } = {}) => ({
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (col: string, val: unknown) => {
      if (table === 'pagamenti') filtri.push({ metodo: 'eq', col, val })
      if (table === 'pagamenti' && col === 'id') {
        return {
          then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
        }
      }
      return b
    }
    b.is = () => b
    b.gte = (col: string, val: unknown) => { filtri.push({ metodo: 'gte', col, val }); return b }
    b.in = (col: string, val: unknown) => { filtri.push({ metodo: 'in', col, val }); return b }
    b.maybeSingle = async () =>
      table === 'payment_categories'
        ? { data: opts.categoria === false ? null : { id: CAT }, error: null }
        : { data: null, error: null }
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(
        table === 'pagamenti'
          ? { data: opts.erroreLettura ? null : righe, error: opts.erroreLettura ?? null }
          : { data: [], error: null },
      ).then(res)
    b.update = (row: Record<string, unknown>) => ({
      eq: async (_col: string, id: string) => {
        updates.push({ id, row })
        return { error: null }
      },
    })
    return b
  },
})

const riallinea = (righe: Riga[], importo: number | null, opts?: { categoria?: boolean; erroreLettura?: unknown }) =>
  riallineaImportoRetteFuture(fintoSupabase(righe, opts ?? {}) as never, ALUNNO, importo)

beforeEach(() => {
  filtri = []
  updates = []
  h.eventi = []
})

describe('riallineaImportoRetteFuture — quello che cambia', () => {
  it('la retta aperta e intatta si allinea al nuovo importo', async () => {
    const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0, fattura_stato: 'non_richiesta' }], 300)
    expect(n).toBe(1)
    expect(updates).toEqual([{ id: 'p1', row: { importo: 300 } }])
  })

  it('guarda solo dal mese CORRENTE in poi: i mesi chiusi non si riaprono', async () => {
    // Un importo di un mese passato è già stato comunicato alla famiglia:
    // riscriverlo farebbe riemergere morosità o crediti che nessuno sta cercando.
    await riallinea([{ id: 'p1', importo: 330 }], 300)
    expect(filtri).toContainEqual({ metodo: 'gte', col: 'periodo_competenza', val: MESE_CORRENTE })
  })

  it('chiede solo le rette, non tutti i pagamenti dell\'alunno', async () => {
    await riallinea([{ id: 'p1', importo: 330 }], 300)
    expect(filtri).toContainEqual({ metodo: 'eq', col: 'categoria_id', val: CAT })
    expect(filtri).toContainEqual({ metodo: 'eq', col: 'alunno_id', val: ALUNNO })
  })

  it('il successo si LOGGA: senza, «nessuno da allineare» e «rotto» si somigliano', async () => {
    await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0 }], 300)
    const ev = h.eventi.find((e) => e.campi?.esito === 'importi-riallineati')
    expect(ev).toBeDefined()
    expect(ev?.livello).toBe('info')
    expect(ev?.campi.pagamenti_allineati).toBe(1)
    expect(ev?.campi.alunno_id).toBe(ALUNNO)
  })
})

describe('riallineaImportoRetteFuture — quello che NON deve cambiare', () => {
  it('un pagamento anche solo PARZIALMENTE incassato non si tocca', async () => {
    // Se dei soldi sono entrati, cambiare la cifra dovuta sposta un saldo che
    // qualcuno ha già conteggiato. È il caso del 2026-09-02 (300 su 330): resta
    // fuori di proposito, e si corregge a mano.
    const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 300 }], 300)
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('un pagamento GIÀ FATTURATO non si tocca: si corregge con una nota di credito', async () => {
    const n = await riallinea(
      [{ id: 'p1', importo: 330, importo_pagato: 0, fattura_aruba_id: 'IT…_00001.xml.p7m' }],
      300,
    )
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('una fattura IN VOLO (inviata, non ancora accettata) non si tocca', async () => {
    // `non_richiesta` e `scartata` sono i due soli stati senza un documento
    // fiscale valido. Tutto il resto è partito allo SdI.
    for (const stato of ['in_attesa', 'inviata', 'consegnata']) {
      updates = []
      const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0, fattura_stato: stato }], 300)
      expect(n, stato).toBe(0)
      expect(updates, stato).toHaveLength(0)
    }
  })

  it('una fattura SCARTATA invece sì: non esiste nessun documento valido', async () => {
    const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0, fattura_stato: 'scartata' }], 300)
    expect(n).toBe(1)
  })

  it('chiede solo gli stati APERTI: i «pagato» non entrano nemmeno nella lista', async () => {
    await riallinea([{ id: 'p1', importo: 330 }], 300)
    expect(filtri).toContainEqual({ metodo: 'in', col: 'stato', val: ['da_pagare', 'scaduto'] })
  })

  it('ZERO non si propaga: sull\'alunno vale «default di sede», sul pagamento «non deve niente»', async () => {
    // Sono due frasi diverse, e tradurre l'una nell'altra è il modo di regalare
    // una retta a una famiglia — o di addebitarne una a chi non la deve.
    const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0 }], 0)
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('null (retta svuotata in anagrafica) non si propaga', async () => {
    const n = await riallinea([{ id: 'p1', importo: 330, importo_pagato: 0 }], null)
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('un importo GIÀ uguale non produce una scrittura inutile', async () => {
    const n = await riallinea([{ id: 'p1', importo: 300, importo_pagato: 0 }], 300)
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })
})

describe('riallineaImportoRetteFuture — quando qualcosa va storto, si vede', () => {
  it('lettura fallita: zero scritture e una riga di log (PostgREST non lancia)', async () => {
    const n = await riallinea([], 300, { erroreLettura: { code: '42703', message: 'column does not exist' } })
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
    expect(h.eventi.some((e) => e.campi?.esito === 'rette-non-lette')).toBe(true)
  })

  it('categoria «retta» assente (DB E2E non migrato): degrada a zero, senza rompere il salvataggio', async () => {
    const n = await riallinea([{ id: 'p1', importo: 330 }], 300, { categoria: false })
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })
})
