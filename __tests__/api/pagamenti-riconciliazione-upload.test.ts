// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

/**
 * L'ESTRATTO CONTO DELLA BANCA ARRIVA ALLA ROUTE COM'È — e l'ordinante finisce in colonna.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * Il lettore multi-formato (`src/lib/pagamenti/estratto-conto/**`) sapeva già leggere
 * l'`.xls` della banca. Ma la porta accettava **solo un JSON con dentro il testo**: il file
 * vero — 2,1 MB di BIFF8 — non poteva nemmeno partire dal browser, e chi provava a
 * incollarlo come CSV otteneva zero movimenti. Un lettore che funziona e non è agganciato a
 * niente è un lettore che non esiste.
 *
 * ⚠️ `// @vitest-environment node` NON è decorativo: `vitest.config.ts` mette tutto in
 * jsdom, e in jsdom il `Blob` non ha `stream()` — `request.formData()` fallirebbe, o
 * peggio consegnerebbe la stringa «[object Blob]» al posto dei byte, con lo `status`
 * ancora verde. Qui si asseriscono i BYTE (i movimenti letti), non solo il numero.
 *
 * ─── I NOMI SONO INVENTATI E CONTATI ────────────────────────────────────────
 * `FABBRI` · `BIANCHI` · `PERLINI`: zero occorrenze nei file veri della banca e zero in
 * produzione su genitori e alunni. Il repository è pubblico e in quei file ci sono
 * seicento famiglie.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** Ogni chiamata di catena osservata sul client finto: è qui che si vede COME si interroga. */
  chiamate: [] as { table: string; metodo: string; args: unknown[] }[],
  /** Gli hash già in registro, restituiti dalla SELECT paginata sulla finestra di date. */
  esistenti: [] as string[],
  aperti: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  /** Errore iniettabile sulla SELECT degli hash esistenti. */
  hashError: null as { code: string; message: string } | null,
  /**
   * Quante righe il server restituisce al MASSIMO per pagina, qualunque range gli si
   * chieda. È il `db-max-rows` di PostgREST: un valore di CONFIGURAZIONE, non una
   * costante del nostro codice. `Infinity` = nessun tetto (il caso di tutti gli altri test).
   */
  tettoPagina: Infinity as number,
  /** Le sedi che la route ha CHIESTO di risolvere: la scrittura dichiara il suo plesso. */
  sediRichieste: [] as (string | undefined)[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async (_r: unknown, _s: unknown, _u: unknown, preferita?: string) => {
    h.sediRichieste.push(preferita)
    return { scuolaId: 'sc-1' }
  },
  resolveScuoleAttive: async () => ['sc-1'],
}))

/** Blocco di paginazione atteso sulla SELECT degli hash (deve combaciare con la route). */
const BLOCCO = 1000

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const stato: { cols?: string; da?: number; a?: number } = {}
      const b: Record<string, unknown> = {}
      const traccia = (metodo: string, args: unknown[]) => h.chiamate.push({ table, metodo, args })
      b.select = (cols?: string) => { stato.cols = cols; traccia('select', [cols]); return b }
      b.eq = (...a: unknown[]) => { traccia('eq', a); return b }
      b.in = (...a: unknown[]) => { traccia('in', a); return b }
      b.gte = (...a: unknown[]) => { traccia('gte', a); return b }
      b.lte = (...a: unknown[]) => { traccia('lte', a); return b }
      b.order = (...a: unknown[]) => { traccia('order', a); return b }
      b.limit = (...a: unknown[]) => { traccia('limit', a); return b }
      b.range = (da: number, a: number) => { stato.da = da; stato.a = a; traccia('range', [da, a]); return b }
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: { id: `${table}-new` }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'riconciliazione_movimenti') {
          if (h.hashError) return resolve({ data: null, error: h.hashError })
          const da = stato.da ?? 0
          const a = stato.a ?? h.esistenti.length - 1
          // ⚠️ Il server non dà mai più di `tettoPagina` righe, per quanto ampio sia il
          // range chiesto: è ciò che fa PostgREST con `db-max-rows`, e in silenzio.
          const fine = Math.min(a + 1, da + h.tettoPagina)
          const fetta = h.esistenti.slice(da, fine).map((x) => ({ hash_movimento: x }))
          return resolve({ data: fetta, error: null })
        }
        if (table === 'pagamenti') return resolve({ data: h.aperti, error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/riconciliazione/route'
import { hashMovimento, parseCsv } from '@/lib/pagamenti/riconciliazione'
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma'

/** La forma esatta del foglio della banca: preambolo, riga vuota, intestazione su due righe. */
const RIGHE_BANCA: unknown[][] = [
  ['Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA'],
  [],
  ['Data', null, 'Descrizione', 'EUR', 'Caus.'],
  ['Operaz.', 'Valuta'],
  [46240, 46240, 'BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA SETTEMBRE TRN 1', 150, '048'],
  [46246, 46246, 'BONIFICO A VOSTRO FAVORE DA  BIANCHI LUCA PER  RETTA SETTEMBRE TRN 2', 100, '048'],
]

/** I byte del foglio, come `ArrayBuffer`: è la sola forma che `new File([...])` accetta senza contorsioni. */
function excel(righe: unknown[][], bookType: 'biff8' | 'xlsx' = 'biff8'): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(righe), 'Movimenti')
  const b = XLSX.write(wb, { type: 'buffer', bookType }) as Buffer
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/**
 * Un uuid INVENTATO. Non l'uuid di una sede vera: quello non si scrive in un file — nemmeno
 * in un test, nemmeno in un commento (lock `migrazioni-senza-sede-cablata`). Qui conta solo
 * che la forma sia un uuid, perché è la forma che lo schema pretende.
 */
const SEDE = '11111111-2222-4333-8444-555555555555'

const CSV_BANCA = [
  'Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA',
  ';;;;',
  'Data;;Descrizione;EUR;Caus.',
  'Operaz.;Valuta',
  '06/08/26;06/08/26;BONIFICO A VOSTRO FAVORE DA  PERLINI CARLO PER  RETTA TRN 9;150,00;048',
].join('\n')

/** Una richiesta multipart vera: byte veri, boundary vero, nessuna scorciatoia. */
function upload(file: File | null, campi: Record<string, string> = {}): Request {
  const fd = new FormData()
  if (file) fd.append('file', file)
  for (const [k, v] of Object.entries(campi)) fd.append(k, v)
  return new Request('http://localhost/api/pagamenti/riconciliazione', { method: 'POST', body: fd })
}

const fileXls = (byte: ArrayBuffer, nome = 'Conti.xls') =>
  new File([byte], nome, { type: 'application/vnd.ms-excel' })

const postJson = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/riconciliazione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const righeInserite = (): Record<string, unknown>[] =>
  h.inserts.filter((i) => i.table === 'riconciliazione_movimenti')
    .flatMap((i) => i.row as Record<string, unknown>[])

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.inserts = []
  h.esistenti = []
  h.hashError = null
  h.tettoPagina = Infinity
  h.sediRichieste = []
  h.aperti = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('POST multipart — il file della banca arriva com’è', () => {
  it('.xls BIFF8: importa i movimenti letti dal foglio', async () => {
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA))))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    expect(righeInserite()).toHaveLength(2)
  })

  it('.xlsx: stessa strada, stesso esito', async () => {
    const file = new File([excel(RIGHE_BANCA, 'xlsx')], 'Conti.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const res = await POST(upload(file))
    expect(res.status).toBe(200)
    expect((await res.json()).data.nuovi).toBe(2)
  })

  it('.csv: il formato di sempre continua a passare dalla stessa porta', async () => {
    const file = new File([CSV_BANCA], 'Conti.csv', { type: 'text/csv' })
    const res = await POST(upload(file))
    expect(res.status).toBe(200)
    expect((await res.json()).data.nuovi).toBe(1)
  })

  it('LA CONTROPARTE finisce in colonna e la causale resta INTERA', async () => {
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA))))
    expect(res.status).toBe(200)
    const righe = righeInserite()
    // L'ordinante non sta in una colonna della banca: si legge dalla descrizione.
    expect(righe.map((r) => r.controparte)).toEqual(['FABBRI GIULIA', 'BIANCHI LUCA'])
    // …e la causale NON viene accorciata: è dentro l'impronta anti-doppio-import.
    expect(righe[0].causale).toBe('BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA SETTEMBRE TRN 1')
  })

  it('l’hash della riga inserita è quello che il parser calcola sul movimento', async () => {
    await POST(upload(fileXls(excel(RIGHE_BANCA))))
    const righe = righeInserite()
    expect(righe[0].hash_movimento).toBe(
      hashMovimento({
        data_operazione: '2026-08-06',
        importo: 150,
        causale: 'BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA SETTEMBRE TRN 1',
        controparte: 'FABBRI GIULIA',
      }),
    )
  })

  it('il campo `mapping` (JSON in una stringa) è onorato', async () => {
    const csv = 'colA;colB\n05/09/2026;99,50\n'
    const file = new File([csv], 'x.csv', { type: 'text/csv' })
    const res = await POST(upload(file, { mapping: JSON.stringify({ data: 'colA', importo: 'colB' }) }))
    expect(res.status).toBe(200)
    expect(righeInserite()[0].importo).toBe(99.5)
  })

  it('la SEDE dichiarata nel multipart arriva a chi risolve la sede di scrittura', async () => {
    // Con tre sedi in produzione, una scrittura che «indovina» il plesso lo sbaglia in
    // silenzio. Il pannello manda `scuola_id` accanto al file: se il campo non arrivasse
    // fin qui, la route ricadrebbe sul cookie e nessun errore lo direbbe.
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA)), { scuola_id: SEDE }))
    expect(res.status).toBe(200)
    expect(h.sediRichieste).toEqual([SEDE])
  })

  it('una sede che non è un uuid viene RESPINTA, non ignorata', async () => {
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA)), { scuola_id: 'sc-1' }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('`mapping` malformato non fa cadere l’import: si degrada ai sinonimi, loggando', async () => {
    const file = new File([CSV_BANCA], 'Conti.csv', { type: 'text/csv' })
    const res = await POST(upload(file, { mapping: '{non un json' }))
    expect(res.status).toBe(200)
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'info' && (c as { esito?: string }).esito === 'mapping_non_leggibile')).toBe(true)
  })
})

describe('POST multipart — i rifiuti hanno tutti un codice', () => {
  it('senza file → 400 ESTRATTO_CONTO_ASSENTE (mai un «Dati non validi» che non dice cosa fare)', async () => {
    const res = await POST(upload(null))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ESTRATTO_CONTO_ASSENTE')
  })

  it('.pdf → 415 ESTRATTO_CONTO_TIPO_NON_AMMESSO, e nel log il MIME ma non il nome', async () => {
    const file = new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], 'estratto-privato.pdf', { type: 'application/pdf' })
    const res = await POST(upload(file))
    expect(res.status).toBe(415)
    expect((await res.json()).codice).toBe('ESTRATTO_CONTO_TIPO_NON_AMMESSO')
    const rifiuto = h.logEvento.mock.calls.find(([, , c]) => (c as { esito?: string }).esito === 'estratto-conto-tipo-non-ammesso')
    expect(rifiuto).toBeTruthy()
    expect(JSON.stringify(rifiuto![2])).toContain('application/pdf')
    expect(JSON.stringify(rifiuto![2])).not.toContain('estratto-privato')
  })

  it('oltre il tetto della piattaforma → 413 ESTRATTO_CONTO_TROPPO_GRANDE', async () => {
    const grosso = new File([new ArrayBuffer(LIMITE_UPLOAD_BYTE + 1)], 'Conti.xls', { type: 'application/vnd.ms-excel' })
    const res = await POST(upload(grosso))
    expect(res.status).toBe(413)
    expect((await res.json()).codice).toBe('ESTRATTO_CONTO_TROPPO_GRANDE')
  })

  it('byte che non si aprono come foglio → 400 ESTRATTO_CONTO_ILLEGGIBILE', async () => {
    // Firma ZIP (un `.xlsx` è uno zip) su un contenuto che zip non è: SheetJS lancia.
    const spazzatura = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])
    const res = await POST(upload(new File([spazzatura], 'Conti.xlsx', { type: 'application/vnd.ms-excel' })))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ESTRATTO_CONTO_ILLEGGIBILE')
  })

  it('un foglio senza accrediti → 400 ESTRATTO_CONTO_SENZA_ACCREDITI', async () => {
    const file = new File(['foo;bar\n1;2\n'], 'Conti.csv', { type: 'text/csv' })
    const res = await POST(upload(file))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ESTRATTO_CONTO_SENZA_ACCREDITI')
  })

  it('non staff → 403 anche con un file allegato, e il corpo non viene MAI letto', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const richiesta = upload(fileXls(excel(RIGHE_BANCA)))
    const res = await POST(richiesta)
    expect(res.status).toBe(403)
    // Il corpo è ancora intatto: nessuno l'ha consumato prima del gate.
    expect(richiesta.bodyUsed).toBe(false)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('la dedup si interroga per INTERVALLO DI DATE, non con una lista di hash', () => {
  it('nessun `.in(hash_movimento, …)`: si usa la finestra min→max, paginata', async () => {
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA))))
    expect(res.status).toBe(200)
    // ⚠️ 6.779 hash in un `.in()` fanno una URL da 450 KB: PostgREST la rifiuta.
    const perLista = h.chiamate.filter((c) => c.metodo === 'in' && c.args[0] === 'hash_movimento')
    expect(perLista).toHaveLength(0)
    const gte = h.chiamate.find((c) => c.metodo === 'gte' && c.args[0] === 'data_operazione')
    const lte = h.chiamate.find((c) => c.metodo === 'lte' && c.args[0] === 'data_operazione')
    expect(gte?.args[1]).toBe('2026-08-06')
    expect(lte?.args[1]).toBe('2026-08-12')
    expect(h.chiamate.some((c) => c.metodo === 'range')).toBe(true)
  })

  it('un `db-max-rows` PIÙ BASSO del nostro blocco non fa passare i duplicati', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO TEST È NATO PER PRENDERE.
    //
    // Il ciclo avanzava di `pagina * BLOCCO_DEDUP` e si fermava quando la pagina tornava
    // più corta del blocco. Ma «pagina corta» NON vuol dire «fine dei dati»: vuol dire
    // anche «il server tronca a un tetto suo». `db-max-rows` è una riga di
    // `supabase/config.toml` (oggi 1000, esattamente quanto il nostro blocco) — un valore
    // di configurazione che questo codice non controlla e che può cambiare senza di noi.
    //
    // Misurato con un tetto di 500: UNA sola pagina letta, 500 hash riconosciuti, e tutti
    // gli altri passati per NUOVI. In produzione l'indice UNIQUE trasformerebbe la cosa in
    // un fallimento a metà scrittura, con una riga orfana in `riconciliazione_import` e un
    // import che fallisce a ogni ritentativo — mai un log che dica perché.
    //
    // La regola giusta non è «pagina piena»: è avanzare di quante righe si sono RICEVUTE e
    // fermarsi solo su una pagina VUOTA. È la forma di `src/lib/avvisi/statistiche.ts`.
    h.tettoPagina = 500
    const movimento = parseCsv(CSV_BANCA).movimenti[0]
    h.esistenti = [
      ...Array.from({ length: 1000 }, (_, i) => `finto-${i}`),
      hashMovimento(movimento),
    ]
    const file = new File([CSV_BANCA], 'Conti.csv', { type: 'text/csv' })
    const res = await POST(upload(file))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.duplicati).toBe(1)
    expect(j.data.nuovi).toBe(0)
    // 0-999 → 500 righe · 500-1499 → 500 · 1000-1999 → 1 · 1001-2000 → vuota, si esce.
    const pagine = h.chiamate.filter((c) => c.metodo === 'range')
    expect(pagine.length).toBeGreaterThanOrEqual(3)
    expect(pagine.map((c) => c.args[0])).toEqual([0, 500, 1000, 1001])
  })

  it('la finestra si pagina finché una pagina non torna VUOTA (un troncamento farebbe passare i duplicati)', async () => {
    // Il registro ne ha più di un blocco: se ci si fermasse alla prima pagina, il duplicato
    // che sta in fondo verrebbe importato una seconda volta.
    const movimento = parseCsv(CSV_BANCA).movimenti[0]
    h.esistenti = [
      ...Array.from({ length: BLOCCO }, (_, i) => `finto-${i}`),
      hashMovimento(movimento),
    ]
    const file = new File([CSV_BANCA], 'Conti.csv', { type: 'text/csv' })
    const res = await POST(upload(file))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(0)
    expect(j.data.duplicati).toBe(1)
    const pagine = h.chiamate.filter((c) => c.metodo === 'range')
    expect(pagine.length).toBeGreaterThanOrEqual(2)
    expect(pagine[0].args).toEqual([0, BLOCCO - 1])
  })

  it('errore PostgREST sulla finestra → 500, e nessun movimento scritto', async () => {
    h.hashError = { code: 'XX', message: 'boom' }
    const res = await POST(upload(fileXls(excel(RIGHE_BANCA))))
    expect(res.status).toBe(500)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('l’estratto ANNUALE non affoga la porta', () => {
  it('1.200 movimenti: INSERT a blocchi, nessuno oltre 200 righe', async () => {
    const righe: string[] = ['Data;EUR;Descrizione']
    for (let i = 0; i < 1200; i++) {
      const giorno = String((i % 28) + 1).padStart(2, '0')
      righe.push(`${giorno}/09/2026;${(i % 90) + 10},00;BONIFICO A VOSTRO FAVORE DA  PERLINI CARLO PER  RATA ${i} TRN ${i}`)
    }
    const file = new File([righe.join('\n')], 'Annuale.csv', { type: 'text/csv' })
    const res = await POST(upload(file))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1200)
    const blocchi = h.inserts.filter((i) => i.table === 'riconciliazione_movimenti')
    expect(blocchi.length).toBeGreaterThan(1)
    for (const b of blocchi) expect((b.row as Record<string, unknown>[]).length).toBeLessThanOrEqual(200)
    expect(blocchi.reduce((s, b) => s + (b.row as Record<string, unknown>[]).length, 0)).toBe(1200)
  })
})

describe('i conteggi onesti arrivano fino al log e alla risposta', () => {
  it('uscite, troncate e senza_ordinante sono dichiarati (mai nascosti in «scartate»)', async () => {
    const csv = [
      'Data;EUR;Descrizione',
      '05/09/2026;150,00;BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA TRN 1',
      '06/09/2026;-30,00;PAGAMENTO POS',
      '07/09/2026;80,00;ACCREDITI VARI RIMBORSO',
      'non-una-data;x;riga illeggibile',
    ].join('\n')
    const res = await POST(upload(new File([csv], 'Conti.csv', { type: 'text/csv' })))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toMatchObject({ nuovi: 2, uscite: 1, scartate: 1, senza_ordinante: 1, troncate: 0 })
    const ok = h.logEvento.mock.calls.find(([, , c]) => (c as { esito?: string }).esito === 'import_ok')
    expect(ok).toBeTruthy()
    expect(ok![2]).toMatchObject({ formato: 'csv', uscite: 1, troncate: 0, senza_ordinante: 1 })
    // ⚠️ Nessun nome, nessuna causale: sono dati di famiglie.
    expect(JSON.stringify(ok![2])).not.toContain('FABBRI')
  })
})

describe('il corpo JSON storico continua a funzionare', () => {
  it('`{contenuto}` resta la via per incollare un CSV da uno script', async () => {
    const csv = ['Data;Entrate;Descrizione', '05/09/2026;150,00;BONIFICO RETTA'].join('\n')
    const res = await POST(postJson({ filename: 'estratto.csv', contenuto: csv }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.nuovi).toBe(1)
  })

  it('il base64 NON è una forma ammessa: resta un JSON senza `contenuto` → 400', async () => {
    const res = await POST(postJson({ filename: 'x.xls', base64: 'UEsDBA==' }))
    expect(res.status).toBe(400)
  })
})
