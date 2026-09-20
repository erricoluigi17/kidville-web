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
  /**
   * Le colonne che il database finto NON ha: una SELECT che le nomina risponde `42703`,
   * com'è il DB E2E della CI, che non è migrato e non ha `sconto`.
   *
   * ⚠️ Si nominano solo colonne il cui nome è UNIVOCO nella stringa di SELECT: `stato`
   * comparirebbe anche come colonna del pagamento, e il finto non saprebbe di quale delle
   * due si parla. Per il gruppo dei campi d'alunno si usa `anonimizzato_il`.
   */
  colonneAssenti: [] as string[],
  /**
   * Le colonne che mancano alla sola tabella `pagamenti`, cioè al PRIMO LIVELLO della
   * SELECT — e sono una lista a parte proprio perché il loro nome compare anche dentro
   * l'embed dell'alunno.
   *
   * ⚠️ `scuola_id` esiste due volte: è la sede del PAGAMENTO e la sede dell'ALUNNO. Una
   * ricerca per sottostringa su tutta la stringa di SELECT non sa di quale delle due si
   * parla e pesca il sosia — la stessa trappola di `getByText`. Qui si guarda solo ciò che
   * precede l'embed.
   */
  colonneAssentiPrimoLivello: [] as string[],
  /** Le relazioni che il finto non ha: l'embed che le nomina risponde `PGRST200`, non `42703`. */
  relazioniAssenti: [] as string[],
  /** Un errore che NON è «colonna assente»: serve a provare che la scala non lo ingoia. */
  apertiErrore: null as { code: string; message: string } | null,
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
        if (table === 'pagamenti') {
          if (h.apertiErrore) return resolve({ data: null, error: h.apertiErrore })
          const cols = stato.cols ?? ''
          // Lo schema del finto risponde PRIMA dei dati: una colonna che non esiste non
          // restituisce una pagina vuota, restituisce un errore — ed è la differenza fra
          // «non c'è niente da leggere» e «non hai potuto leggere».
          const colonna = h.colonneAssenti.find((c) => cols.includes(c))
          if (colonna) {
            return resolve({ data: null, error: { code: '42703', message: `column pagamenti.${colonna} does not exist` } })
          }
          // Solo ciò che precede l'embed dell'alunno: `scuola_id` compare anche là dentro,
          // e confondere le due sedi farebbe rispondere `42703` a una SELECT che la colonna
          // mancante non la nomina affatto.
          const primoLivello = cols.split('alunni:alunno_id (')[0]
          const colonnaTop = h.colonneAssentiPrimoLivello.find((c) => primoLivello.includes(`, ${c}`))
          if (colonnaTop) {
            return resolve({ data: null, error: { code: '42703', message: `column pagamenti.${colonnaTop} does not exist` } })
          }
          const relazione = h.relazioniAssenti.find((r) => cols.includes(r))
          if (relazione) {
            return resolve({ data: null, error: { code: 'PGRST200', message: `Could not find a relationship with '${relazione}'` } })
          }
          const da = stato.da ?? 0
          const a = stato.a ?? h.aperti.length - 1
          // Lo stesso tetto silenzioso della finestra di dedup: la pagina torna corta e
          // niente lo dichiara. È la sola forma in cui PostgREST tronca.
          const fine = Math.min(a + 1, da + h.tettoPagina)
          return resolve({ data: h.aperti.slice(da, fine), error: null })
        }
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

/**
 * Un codice fiscale INVENTATO, nella forma esatta che `estraiCodiciFiscali` pretende
 * (6 lettere + LLDDLDDDL). Non è di nessuno — è la stessa forma già usata dai test
 * dell'oblio. Il repository è pubblico, e i CF veri qui dentro sono di minori.
 */
const CF_INVENTATO = 'AAABBB10A01H501X'

/** Un bonifico che CITA il codice fiscale: l'aggancio dominante, e si vede nei conteggi. */
const CSV_CON_CF = [
  'Data;EUR;Descrizione',
  `05/09/2026;150,00;BONIFICO A VOSTRO FAVORE DA  PERLINI CARLO PER  RETTA ${CF_INVENTATO} TRN 7`,
].join('\n')

/**
 * Una voce aperta com'è quando torna da PostgREST, embed compresi.
 *
 * `importo` 999 non è un numero a caso: NON deve coincidere con i 150 del bonifico, o il
 * bonus «importo esatto» darebbe punti a tutte le voci e i conteggi non direbbero più
 * quale riga è arrivata. Solo quella col CF deve segnare.
 */
const apertoFinto = (i: number, cf: string | null = null) => ({
  id: `pag-${String(i).padStart(3, '0')}`,
  descrizione: `Rata ${i}`,
  importo: 999,
  importo_pagato: 0,
  sconto: 0,
  scuola_id: 'sc-1',
  periodo_competenza: null,
  tipo: 'singolo',
  stato: 'da_pagare',
  alunno_id: `al-${i}`,
  alunni: {
    nome: 'Nome', cognome: `Cognome${i}`, codice_fiscale: cf, fiscal_code: null,
    stato: 'iscritto', anonimizzato_il: null, scuola_id: 'sc-1',
  },
  payment_categories: { slug: 'retta' },
})

/** Le SELECT davvero partite sui pagamenti, in ordine: è lì che si legge la scala. */
const selectAperti = (): string[] =>
  h.chiamate.filter((c) => c.table === 'pagamenti' && c.metodo === 'select').map((c) => String(c.args[0]))

const pagineAperti = () => h.chiamate.filter((c) => c.table === 'pagamenti' && c.metodo === 'range')

/** Gli `order` partiti sugli aperti: è il pilastro su cui poggia la paginazione. */
const ordiniAperti = () => h.chiamate.filter((c) => c.table === 'pagamenti' && c.metodo === 'order')

/** Dove, nella catena osservata, compare per la prima volta quel metodo sui pagamenti. */
const primaChiamata = (metodo: string) =>
  h.chiamate.findIndex((c) => c.table === 'pagamenti' && c.metodo === metodo)

/** La SELECT completa del gradino 0: tutte le colonne per decidere, nessuna sacrificata. */
const SELECT_APERTI_RICCA =
  'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, ' +
  'scuola_id, sconto, ' +
  'alunni:alunno_id ( nome, cognome, codice_fiscale, fiscal_code, stato, anonimizzato_il, scuola_id ), ' +
  'payment_categories:categoria_id ( slug )'

/**
 * Le pagine della finestra di DEDUP.
 *
 * ⚠️ Il filtro nomina la tabella, e prima non lo faceva: finché a paginare era la sola
 * dedup, «tutte le `range`» e «le `range` della dedup» erano la stessa cosa. Da quando
 * anche l'elenco degli aperti si pagina non lo sono più, e un elenco di offset che mescola
 * due letture non prova nessuna delle due.
 */
const pagineDedup = () => h.chiamate.filter((c) => c.table === 'riconciliazione_movimenti' && c.metodo === 'range')

const csv = (testo: string) => new File([testo], 'Conti.csv', { type: 'text/csv' })

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
  h.colonneAssenti = []
  h.colonneAssentiPrimoLivello = []
  h.relazioniAssenti = []
  h.apertiErrore = null
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
    expect(pagineDedup().length).toBeGreaterThan(0)
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
    const pagine = pagineDedup()
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
    const pagine = pagineDedup()
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

/**
 * ⚠️ IL RISCHIO PIÙ GRAVE DI QUESTO LAVORO, E NON SI VEDE DA FUORI.
 *
 * L'elenco delle voci aperte veniva letto senza `.range()`: PostgREST lo tronca a
 * `db-max-rows` e non lo dice. Il tetto è 1.000 e le voci aperte stanno sotto — per
 * FORTUNA, non per costruzione: quante siano è un numero che invecchia (245 il 2026-09-20,
 * contate: la stessa riga qui diceva 545, copiato dalla specifica, cioè più del doppio).
 *
 * Con l'elenco tagliato, l'insieme delle voci di una famiglia è INCOMPLETO, e la regola che
 * l'abbinamento automatico userà — «una sola combinazione di voci quadra con l'importo» —
 * diventa falsamente certa: si incassa sulla voce sbagliata di un bambino vero, col gate
 * verde e senza un rigo nei log.
 */
describe('l’elenco dei pagamenti aperti si legge TUTTO, o lo dichiara', () => {
  /** Deve combaciare con `MAX_PAGINE_APERTI` della route: è il tetto dei round-trip. */
  const MAX_PAGINE = 100

  it('si pagina avanzando di quante righe SONO ARRIVATE, e l’ultima voce porta il suo aggancio', async () => {
    // Il finto non dà più di due righe per pagina, per quanto ampio sia il range chiesto:
    // è il `db-max-rows` del server. La voce col CF sta in fondo — senza paginazione non
    // arriverebbe mai, e `con_cf` direbbe 0 su un import «riuscito».
    h.tettoPagina = 2
    h.aperti = [apertoFinto(0), apertoFinto(1), apertoFinto(2), apertoFinto(3), apertoFinto(4, CF_INVENTATO)]
    const res = await POST(upload(csv(CSV_CON_CF)))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.con_cf).toBe(1)
    expect(j.data.suggeriti).toBe(1)
    // 0-999 → 2 righe · 2-1001 → 2 · 4-1003 → 1 · 5-1004 → vuota, si esce. Il passo è
    // quante righe sono ARRIVATE: con «pagina più corta del blocco ⇒ fine» ci si fermava
    // alla prima, e le altre tre voci non esistevano.
    expect(pagineAperti().map((c) => c.args[0])).toEqual([0, 2, 4, 5])
    expect(pagineAperti()[0].args[1]).toBe(BLOCCO - 1)
    expect(righeInserite()[0].suggerimenti).toMatchObject([{ pagamento_id: 'pag-004', cf_match: true }])
    // ⚠️ E il filtro che decide CHI entra nell'elenco si legge dagli `args`, su ogni pagina.
    // Paginare bene un insieme sbagliato non serve a niente: una voce `scaduto` o `parziale`
    // che sparisce dal filtro è indistinguibile da una che non c'era mai — l'import risponde
    // 200, `aperti_troncati` resta `false` e i sei conteggi di qualità escono verdi su un
    // insieme che non è quello vero. È lo stesso guasto per cui questo lotto esiste.
    // Su OGNI pagina e non solo sulla prima: un filtro che cambia a metà elenco taglia la
    // coda esattamente come farebbe un tetto silenzioso.
    const filtriStato = h.chiamate.filter((c) => c.table === 'pagamenti' && c.metodo === 'in')
    expect(filtriStato).toHaveLength(pagineAperti().length)
    for (const f of filtriStato) expect(f.args).toEqual(['stato', ['da_pagare', 'parziale', 'scaduto']])
  })

  it('e poggia su un ORDINE TOTALE: `order(id)` su ogni pagina, e prima della prima `range`', async () => {
    // ⚠️ IL PILASTRO CHE NON AVEVA UNA RETE.
    //
    // Senza un ordine dichiarato, l'ordine delle righe è quello che decide il database, e
    // può cambiare FRA una pagina e l'altra: una riga scivola indietro e si legge due volte,
    // un'altra scivola avanti e non si legge mai. Con `.range()` addosso, paginare senza
    // ordine è PEGGIO che non paginare — e l'elenco monco non lo dichiara nessuno, perché
    // nessuna pagina è tornata vuota prima del tempo: `apertiTroncati` resta `false` e i
    // conteggi escono verdi su un insieme che non è quello vero.
    //
    // `id` è la chiave primaria: un ordine TOTALE, in cui nessuna riga è a pari merito con
    // un'altra, quindi nessuna può cambiare posto fra due letture.
    h.tettoPagina = 2
    h.aperti = [apertoFinto(0), apertoFinto(1), apertoFinto(2)]
    const res = await POST(upload(csv(CSV_BANCA)))
    expect(res.status).toBe(200)
    // Una pagina, un `order`: l'ordine non si dichiara una volta e si eredita.
    expect(ordiniAperti()).toHaveLength(pagineAperti().length)
    expect(pagineAperti().length).toBeGreaterThan(1)
    for (const o of ordiniAperti()) expect(o.args).toEqual(['id', { ascending: true }])
    // …e l'ordine è già in catena quando parte la PRIMA pagina: applicato dopo il `range`
    // ordinerebbe la fetta, non l'elenco da cui la fetta è tagliata.
    expect(primaChiamata('order')).toBeGreaterThanOrEqual(0)
    expect(primaChiamata('order')).toBeLessThan(primaChiamata('range'))
  })

  it('oltre il tetto di pagine il troncamento si DICHIARA: `error` nei log e dato nella risposta interna', async () => {
    h.tettoPagina = 1
    h.aperti = Array.from({ length: MAX_PAGINE + 20 }, (_, i) => apertoFinto(i))
    const res = await POST(upload(csv(CSV_BANCA)))
    // L'import non cade: cade la CERTEZZA. Le venti voci non lette restano fuori, e chi
    // dirà «questa combinazione è l'unica che quadra» deve saperlo.
    expect(res.status).toBe(200)
    expect(pagineAperti()).toHaveLength(MAX_PAGINE)
    const allarme = h.logEvento.mock.calls.find(([, liv, c]) =>
      liv === 'error' && (c as { esito?: string }).esito === 'aperti-finestra-troncata')
    expect(allarme).toBeTruthy()
    expect(allarme![2]).toMatchObject({ n: MAX_PAGINE })
    const ok = h.logEvento.mock.calls.find(([, , c]) => (c as { esito?: string }).esito === 'import_ok')
    expect(ok![2]).toMatchObject({ aperti_troncati: true })
  })

  it('un elenco letto per intero dichiara `aperti_troncati: false` (il segnale non è incollato)', async () => {
    h.aperti = [apertoFinto(0), apertoFinto(1)]
    const res = await POST(upload(csv(CSV_BANCA)))
    expect(res.status).toBe(200)
    const ok = h.logEvento.mock.calls.find(([, , c]) => (c as { esito?: string }).esito === 'import_ok')
    expect(ok![2]).toMatchObject({ aperti_troncati: false })
    expect(h.logEvento.mock.calls.some(([, , c]) =>
      (c as { esito?: string }).esito === 'aperti-finestra-troncata')).toBe(false)
  })

  it('un errore che NON è «colonna assente» ferma l’import: 500, e nessun movimento scritto', async () => {
    // La scala esiste per le colonne che mancano, non per nascondere i guasti: un import
    // che continuasse qui loggerebbe `import_ok` con `con_cf: 0`, cioè un successo che mente.
    h.apertiErrore = { code: 'XX', message: 'boom' }
    const res = await POST(upload(csv(CSV_BANCA)))
    expect(res.status).toBe(500)
    expect(h.inserts).toHaveLength(0)
    // ⚠️ LE DUE RIGHE QUI SOPRA SONO VERE ANCHE SENZA LA GUARDIA che distingue «degrada» da
    // «fermati»: in fondo alla scala `errAperti` resta valorizzato e la rotta risponde 500 lo
    // stesso. Quello che la guardia decide non è l'ESITO, è quanto si insiste prima di
    // arrendersi e — soprattutto — che cosa si DICHIARA mentre lo si fa. Senza, un guasto
    // transitorio (statement timeout `57014`, una RLS, `PGRST301` col JWT scaduto) fa scendere
    // tutti e cinque i gradini ed emette cinque `degradazione_*_aperti` FALSI, che danno per
    // assenti `sconto`, `categoria`, `ciclo_alunno`, `sede_pagamento` e `cf` su un database
    // che ce le ha tutte. Quei log sono l'unico posto in cui la perdita di quei campi si vede:
    // un segnale FALSO è peggio di un segnale assente, perché spegne l'osservabile invece di
    // lasciarlo muto. Quindi lo si rende visibile qui: una sola SELECT partita, nessuna
    // rinuncia dichiarata.
    expect(selectAperti()).toHaveLength(1)
    expect(h.logEvento.mock.calls.filter(([, , c]) =>
      String((c as { esito?: string }).esito ?? '').startsWith('degradazione_'))).toHaveLength(0)
  })
})

/**
 * I CAMPI CHE SERVIRANNO A DECIDERE, e il loro ramo di degradazione.
 *
 * `sconto` non è un di più: il matcher calcola il residuo come `importo − importo_pagato`,
 * mentre il resto del sistema usa `residuoEffettivo` (`importo − sconto − importo_pagato`,
 * clampato a zero — `src/lib/pagamenti/aging.ts`). Su una voce scontata i due numeri
 * divergono, e chi dirà «certo» userebbe quello sbagliato.
 *
 * Ma il database E2E della CI NON è migrato e `sconto` non ce l'ha: senza degradazione,
 * chiedere quella colonna fa cadere l'import in CI — su un campo che serve a decidere, non
 * a importare.
 */
describe('le colonne per decidere arrivano, e ognuna sa cadere da sola', () => {
  it('la prima SELECT chiede ESATTAMENTE sconto, le due sedi, il ciclo dell’alunno e lo slug', async () => {
    // ⚠️ CONFRONTO ESATTO, non cinque `toContain` — e la differenza non è di stile.
    //
    // `scuola_id` compare DUE volte in questa stringa: la sede del pagamento, al primo
    // livello, e quella dell'alunno, dentro l'embed. Un `toContain('scuola_id')` è
    // soddisfatto da una qualunque delle due: si poteva togliere dalla SELECT la sede del
    // PAGAMENTO — una delle colonne che tutto questo lotto esiste per portare — e il test
    // restava verde, pescando il sosia annidato. È la forma canonica del verde falso di
    // questo repo, la stessa di `getByText`.
    //
    // L'elenco intero come prova costa una riga da aggiornare ogni volta che la SELECT
    // cambia, e la paga volentieri: nome, ordine e ANNIDAMENTO di ogni colonna diventano
    // dichiarati, quindi una colonna che sparisce non ha più dove nascondersi.
    const res = await POST(upload(csv(CSV_BANCA)))
    expect(res.status).toBe(200)
    expect(selectAperti()[0]).toBe(SELECT_APERTI_RICCA)
  })

  it('`sconto` assente (il DB della CI): si scende di UN gradino, l’import risponde 200 e il CF resta', async () => {
    h.colonneAssenti = ['sconto']
    h.aperti = [apertoFinto(1, CF_INVENTATO)]
    const res = await POST(upload(csv(CSV_CON_CF)))
    expect(res.status).toBe(200)
    // Il codice fiscale è l'ULTIMO a cadere: perdere lo sconto non costa l'aggancio forte.
    expect((await res.json()).data.con_cf).toBe(1)
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'info' && (c as { esito?: string }).esito === 'degradazione_sconto_aperti')).toBe(true)
    const ultima = selectAperti().at(-1)!
    expect(ultima).not.toContain('sconto')
    expect(ultima).toContain('codice_fiscale')
  })

  it('un campo del ciclo dell’alunno assente: la scala scende finché passa, senza perdere il CF', async () => {
    h.colonneAssenti = ['anonimizzato_il']
    h.aperti = [apertoFinto(1, CF_INVENTATO)]
    const res = await POST(upload(csv(CSV_CON_CF)))
    expect(res.status).toBe(200)
    expect((await res.json()).data.con_cf).toBe(1)
    const degradi = h.logEvento.mock.calls
      .map(([, , c]) => (c as { esito?: string }).esito)
      .filter((e) => e?.startsWith('degradazione_'))
    // L'ordine di sacrificio è dichiarato: prima ciò che vale meno, il CF per ultimo.
    expect(degradi).toEqual(['degradazione_sconto_aperti', 'degradazione_categoria_aperti', 'degradazione_ciclo_alunno_aperti'])
    expect(selectAperti().at(-1)!).not.toContain('anonimizzato_il')
  })

  it('la sede del PAGAMENTO assente: cade il SUO gradino, con il suo nome nei log', async () => {
    // Il gradino `sede_pagamento` era l'unico della scala che nessun test faceva scattare:
    // si poteva toglierlo da `SACRIFICIO_APERTI` — o togliere `scuola_id` dalla SELECT — e
    // tutto restava verde. Un gradino che non si è mai visto cadere non è un gradino.
    //
    // ⚠️ Qui la colonna assente si dichiara col finto che guarda il SOLO primo livello:
    // `scuola_id` esiste anche dentro l'embed dell'alunno, e una colonna «assente» cercata
    // per sottostringa su tutta la SELECT farebbe fallire anche i gradini che quella
    // colonna non la chiedono più.
    h.colonneAssentiPrimoLivello = ['scuola_id']
    h.aperti = [apertoFinto(1, CF_INVENTATO)]
    const res = await POST(upload(csv(CSV_CON_CF)))
    expect(res.status).toBe(200)
    expect((await res.json()).data.con_cf).toBe(1)
    const degradi = h.logEvento.mock.calls
      .map(([, , c]) => (c as { esito?: string }).esito)
      .filter((e) => e?.startsWith('degradazione_'))
    // La caduta è CUMULATIVA: per arrivare al gradino colpevole si passa da tutti quelli
    // che lo precedono, e il log li nomina uno per uno. È il costo dichiarato nel docblock
    // di `SACRIFICIO_APERTI`, non una sorpresa.
    expect(degradi).toEqual([
      'degradazione_sconto_aperti',
      'degradazione_categoria_aperti',
      'degradazione_ciclo_alunno_aperti',
      'degradazione_sede_pagamento_aperti',
    ])
    // Il gradino che passa non ha più NESSUNA `scuola_id`: né quella del pagamento (caduta
    // qui) né quella dell'alunno (caduta col ciclo, per compagnia). Il codice fiscale sì:
    // è l'ultimo a cadere, e non è caduto.
    expect(selectAperti().at(-1)).toBe(
      'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, ' +
      'alunni:alunno_id ( nome, cognome, codice_fiscale, fiscal_code )',
    )
  })

  it('l’embed della categoria che non si risolve risponde PGRST200, non 42703: e non fa cadere l’import', async () => {
    h.relazioniAssenti = ['payment_categories']
    h.aperti = [apertoFinto(1, CF_INVENTATO)]
    const res = await POST(upload(csv(CSV_CON_CF)))
    expect(res.status).toBe(200)
    expect((await res.json()).data.con_cf).toBe(1)
    expect(h.logEvento.mock.calls.some(([, , c]) =>
      (c as { esito?: string }).esito === 'degradazione_categoria_aperti')).toBe(true)
    expect(selectAperti().at(-1)!).not.toContain('payment_categories')
  })

  it('i valori ARRIVANO fino alla mappatura: `import_ok` li conta, uno per uno', async () => {
    // ⚠️ PROVARE CHE LA SELECT LI CHIEDE NON PROVA CHE ARRIVINO.
    //
    // Fra la stringa di SELECT e la mappatura c'è un passaggio di chiavi che, in questo
    // lotto, nessuno guarda: i campi nuovi non entrano nel punteggio, non escono nella
    // risposta, non li legge un `if`. Azzerarli tutti e quattro nella mappatura lasciava la
    // suite verde — e il candidato non è teorico: PostgREST restituisce un embed come
    // OGGETTO o come ARRAY a seconda della cardinalità, e `payment_categories` è letto come
    // oggetto senza che niente lo verifichi.
    //
    // Questi sei conteggi sono l'unico occhio su quel passaggio finché i campi non avranno
    // un consumatore. Ognuna delle sei voci qui sotto è diversa dalle altre per UN campo:
    // un campo che smette di arrivare muove un solo numero, e il numero dice quale.
    const base = apertoFinto(0)
    h.aperti = [
      { ...base, id: 'pag-sconto', sconto: 25 },
      { ...base, id: 'pag-senza-categoria', payment_categories: null },
      { ...base, id: 'pag-oblio', alunni: { ...base.alunni, anonimizzato_il: '2026-01-31' } },
      { ...base, id: 'pag-senza-sede', scuola_id: null },
      { ...base, id: 'pag-ciclo-ignoto', alunni: { ...base.alunni, stato: null } },
      { ...base, id: 'pag-trasferito', alunni: { ...base.alunni, scuola_id: 'sc-2' } },
    ]
    const res = await POST(upload(csv(CSV_BANCA)))
    expect(res.status).toBe(200)
    const ok = h.logEvento.mock.calls.find(([, , c]) => (c as { esito?: string }).esito === 'import_ok')
    expect(ok![2]).toMatchObject({
      aperti_scontati: 1,
      aperti_con_categoria: 5,
      aperti_anonimizzati: 1,
      aperti_senza_sede: 1,
      aperti_ciclo_ignoto: 1,
      aperti_sede_discorde: 1,
    })
    // …e sono CONTEGGI, non righe: nessun uuid d'alunno, nessuno slug, nessuna data.
    // Sono voci di bambini veri, e un log che le elenca è un log che non si può scrivere.
    const contesto = JSON.stringify(ok![2])
    expect(contesto).not.toContain('al-0')
    expect(contesto).not.toContain('2026-01-31')
    expect(contesto).not.toContain('retta')
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
