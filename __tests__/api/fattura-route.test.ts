import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  emetti: vi.fn(),
  pag: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  fattureList: [] as Record<string, unknown>[],
  storageFile: null as unknown,
  storageError: null as unknown,
  /**
  * Gli oggetti che il bucket `fatture` elenca: `list()` NON lancia, ritorna
  * `{ data, error }`.
  *
  * ⚠️ QUI IL BUCKET RISPONDE SEMPRE BENE, ed è voluto: `list()` in errore è un
  * caso a sé, con la sua riga di log e il suo degrado a «tutte false», e vive in
  * `__tests__/api/fattura-list-verifica-bucket.test.ts`. Una leva d'errore
  * dichiarata qui e mai spinta sarebbe impalcatura morta: sembra copertura e non
  * misura niente.
  */
  bucketNomi: [] as { name: string }[],
  updates: [] as { table: string; row: unknown }[],
}))

// Scope di sede concessivo: qui si verificano numerazione, causali e gestione
// degli errori PostgREST, non l'isolamento fra sedi (che sta in
// `__tests__/api/contabilita-scope-sede.test.ts`).
vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
  assertAlunnoInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['sc-1']),
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: 'sc-1' })),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? h.pag : table === 'legame_genitori_alunni' ? h.legame : null,
        error: null,
      })
      b.update = (row: unknown) => ({ eq: async () => { h.updates.push({ table, row }); return { error: null } } })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'fatture_emesse' ? h.fattureList : [], error: null })
      return b
    },
    // ⚠️ `supabase-storage-js` NON LANCIA: `download` e `list` RISOLVONO con
    // `{ data, error }`. Il finto di prima ritornava il solo `data`, cioè un
    // oggetto in cui `error` è `undefined` sempre — e con quello nessuna prova
    // poteva vedere il ramo di guasto, che è esattamente il ramo per cui la
    // rotta non serve più un documento di ripiego.
    storage: {
      from: () => ({
        download: async () => ({ data: h.storageFile, error: h.storageError }),
        list: async () => ({ data: h.bucketNomi, error: null }),
      }),
    },
  }),
}))
vi.mock('@/lib/aruba/emissione', () => ({ emettiFatturaPagamento: h.emetti }))

import { POST, GET } from '@/app/api/pagamenti/fattura/route'
import { GET as LIST } from '@/app/api/pagamenti/fattura/list/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const FID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
function post(body: unknown) {
  return new Request('http://localhost/api/pagamenti/fattura', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/pagamenti/fattura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('blocca i non-staff (gate requireStaff)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(403)
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('400 senza pagamento_id', async () => {
    expect((await POST(post({}))).status).toBe(400)
  })

  it('mappa esito non_configurato → 503', async () => {
    h.emetti.mockResolvedValue({ ok: false, motivo: 'non_configurato', messaggio: 'Aruba non configurata', httpStatus: 503 })
    expect((await POST(post({ pagamento_id: PID }))).status).toBe(503)
  })

  it('esito ok → 200 con numero e id', async () => {
    h.emetti.mockResolvedValue({ ok: true, fatturaStato: 'in_attesa', uploadFileName: 'ITxx_a.xml.p7m', numero: 7 })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.numero).toBe(7)
  })

  /**
   * ─── IL RIFIUTO DI TRASPORTO PORTA UN CODICE SUO ───────────────────────────
   *
   * `motivo: 'errore'` con `httpStatus: 502` è l'unico esito in cui il numero di
   * fattura È STATO CONSUMATO e nessuno sa se il documento sia partito. Fino a
   * oggi usciva dal ramo generico, cioè senza `codice`: chi ha l'interfaccia in
   * inglese leggeva la prosa italiana del server, e — cosa peggiore — nessun
   * chiamante poteva distinguerlo da un rifiuto qualunque per decidere di
   * FERMARSI invece di riprovare. Con un lotto in corso quella distinzione vale
   * undici numeri di fattura.
   *
   * Il codice sta anche in `CODICI_CON_DETTAGLIO` perché la prosa del server
   * porta il NUMERO della fattura, che il catalogo non può conoscere ed è l'unica
   * cosa che dice quale documento andare a cercare sul pannello Aruba.
   */
  it('rifiuto di TRASPORTO (motivo errore + 502) → codice FATTURA_TRASPORTO_IGNOTO', async () => {
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'errore',
      httpStatus: 502,
      messaggio: 'Aruba non ha concluso l’invio della fattura FPR 1949/2026 (429) …',
    })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.codice).toBe('FATTURA_TRASPORTO_IGNOTO')
    // La prosa resta: è lei a portare il numero del documento.
    expect(json.error).toContain('FPR 1949/2026')
  })

  it('un `errore` che NON è di trasporto (500) resta senza quel codice', async () => {
    // L'XML che non si è saputo comporre è un guasto nostro, e ripremere è la
    // risposta giusta: dargli lo stesso codice direbbe «non ripremere» a chi
    // invece deve farlo.
    h.emetti.mockResolvedValue({ ok: false, motivo: 'errore', httpStatus: 500, messaggio: 'XML non composto' })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBeUndefined()
  })

  it('uno SCARTO di Aruba (502 ma motivo `scartata`) non è un trasporto ignoto', async () => {
    // Stesso status, significato opposto: qui Aruba ha guardato il documento e
    // l'ha respinto nel merito. Il rimedio è correggere e riemettere, non
    // «verifica sul pannello prima di ripremere».
    h.emetti.mockResolvedValue({ ok: false, motivo: 'scartata', httpStatus: 502, messaggio: 'scartata da Aruba' })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(502)
    expect((await res.json()).codice).toBeUndefined()
  })
})

describe('GET /api/pagamenti/fattura?fattura_id=', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pag = { id: PID, alunno_id: 'al-1', descrizione: 'Retta', importo: 150, fattura_stato: 'emessa', fattura_pdf_path: null, fattura_aruba_id: 'X', fattura_emessa_il: '2026-01-01', fattura_causale: null, alunni: { nome: 'Mario', cognome: 'Rossi' } }
    // La riga di registro si legge dall'elenco (`.eq('pagamento_id')`), non da un
    // `maybeSingle`: la rotta legge TUTTE le righe del pagamento per accorgersi
    // delle quote multiple. `pdf_path: null` = nessun oggetto nel bucket.
    h.fattureList = [{ id: FID, numero: 7, anno: 2026, pdf_path: null, sdi_stato: 7 }]
    h.storageFile = null
    h.storageError = null
  })

  /**
   * ─── IL RIPIEGO CHE CONSEGNAVA UN ALTRO DOCUMENTO ─────────────────────────
   *
   * Questo caso si chiamava «serve l'anteprima della singola quota (200 pdf)» e
   * pretendeva `200 application/pdf` con `pdf_path` NULLO — cioè con nessun file
   * nel bucket. Quel PDF la rotta se lo disegnava al volo: intestazione, numero,
   * causale, importo, servito come `application/pdf`. Chi premeva «Scarica
   * fattura» si ritrovava in mano un foglio che *sembra* la fattura elettronica
   * e non lo è, senza nessun modo di accorgersene — né il genitore che se lo
   * salva, né il commercialista che se lo vede allegare al 730.
   *
   * Il test non è stato cancellato perché il PERCORSO resta lo stesso: quello che
   * cambia è la risposta. Senza byte nel bucket si dice che il documento non c'è,
   * con un `codice` che il chiamante può leggere.
   */
  it('senza `pdf_path` NON si fabbrica niente: 404 con codice, e mai `application/pdf`', async () => {
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toContain('application/pdf')
    expect((await res.json()).codice).toBe('FATTURA_PDF_NON_DISPONIBILE')
  })

  it('col PDF nel bucket → 200 e i byte del bucket', async () => {
    h.fattureList = [{ id: FID, numero: 7, anno: 2026, pdf_path: 'fatture/7.pdf', sdi_stato: 7 }]
    h.storageFile = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])])
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('404 se la fattura indicata non esiste', async () => {
    h.fattureList = []
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
  })

  it('403 genitore non proprietario del bambino', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
    h.legame = null
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(403)
  })
})

describe('GET /api/pagamenti/fattura/list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pag = { id: PID, alunno_id: 'al-1' }
    h.fattureList = [
      { id: 'f1', numero: 10, anno: 2026, quota_label: 'Mamma', quota_adult_id: 'u-mamma', intestatario: { nome: 'Giulia', cognome: 'Farina' }, pdf_path: 'p.pdf', sdi_stato: 7, sdi_stato_label: 'Consegnata' },
      { id: 'f2', numero: 11, anno: 2026, quota_label: 'Papà', quota_adult_id: 'u-papa', intestatario: { nome: 'Marco', cognome: 'Rossi' }, pdf_path: null, sdi_stato: 1, sdi_stato_label: 'Presa in carico' },
    ]
    // `pdf_disponibile` non si fida più della colonna: il bucket deve elencare
    // l'oggetto. Qui c'è, e infatti la prima riga resta `true`.
    h.bucketNomi = [{ name: 'p.pdf' }]
  })

  it('401 senza sessione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))).status).toBe(401)
  })

  it('400 senza pagamento_id', async () => {
    expect((await LIST(new Request('http://localhost/api/pagamenti/fattura/list'))).status).toBe(400)
  })

  it('403 genitore non proprietario', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
    h.legame = null
    expect((await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))).status).toBe(403)
  })

  it('200 elenca le fatture (una per quota, con intestatario e pdf_disponibile)', async () => {
    const res = await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(2)
    expect(j.data[0]).toMatchObject({ numero: 10, intestatario: 'Giulia Farina', pdf_disponibile: true })
    expect(j.data[1]).toMatchObject({ numero: 11, intestatario: 'Marco Rossi', pdf_disponibile: false })
  })
})
