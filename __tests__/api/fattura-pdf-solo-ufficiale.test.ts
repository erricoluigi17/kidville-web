import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * O IL DOCUMENTO VERO, O SI DICE CHE NON C'È.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO, DETTO UNA VOLTA ───────────────────────────────────────────
 *
 * Quando il PDF dello SDI non c'era — non ancora tornato, chiave sbagliata a
 * registro, oggetto sparito dal bucket — `GET /api/pagamenti/fattura` ne
 * DISEGNAVA uno al volo con `jsPDF`: intestazione, numero, causale, importo. E
 * lo serviva con `Content-Type: application/pdf` e `status: 200`.
 *
 * Chi premeva «Scarica fattura» riceveva un foglio che *sembra* una fattura, non
 * è la fattura elettronica trasmessa allo SDI, e non lo distingue nessuno: né il
 * genitore che se lo salva sul telefono, né il commercialista che se lo vede
 * allegare alla dichiarazione. Un documento fiscale sbagliato non è un errore di
 * interfaccia: è una carta che entra in una pratica.
 *
 * E il difetto era doppiamente muto: l'`error` del `download` veniva scartato
 * dalla destrutturazione, quindi nei log non restava niente. `supabase-storage-js`
 * NON LANCIA — ritorna `{ data, error }` — e il `try/catch` attorno non scattava
 * mai (AGENTS.md, regola 7).
 *
 * ─── COSA INCHIODANO QUESTE QUATTRO PROVE ──────────────────────────────────
 *
 *  a. download in errore  → 404 con `codice`, MAI `application/pdf`, e una riga
 *     `error` con l'errore INTERO (non il solo status: «404» non dice niente,
 *     «Object not found» dice quale delle due cose è successa).
 *  b. `pdf_path` nullo    → 404, e il bucket non viene nemmeno interrogato.
 *  c. download riuscito   → 200 con i BYTE DEL BUCKET, confrontati uno per uno.
 *  d. lock di forma       → il sorgente della rotta non contiene più `jsPDF`.
 *
 * La (d) esiste perché le prime tre parlano del COMPORTAMENTO di oggi, e un
 * ripiego si rimette in tre righe: basta reintrodurre il disegno su un ramo che
 * nessuna delle tre percorre. Finché nel file non c'è un generatore di PDF,
 * quella strada non si può riaprire per distrazione.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const PID = 'aaaaaaaa-0000-4000-8000-000000000001'
const FID = 'bbbbbbbb-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  pag: null as Record<string, unknown> | null,
  righe: [] as Record<string, unknown>[],
  scaricato: null as unknown,
  erroreScarico: null as unknown,
  /** Quante volte il bucket è stato davvero interrogato: la (b) si misura qui. */
  chiamateDownload: 0,
  chiaviChieste: [] as string[],
}))

vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
  assertAlunnoInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['sc-1']),
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: 'sc-1' })),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })),
  requireStaff: vi.fn(async () => ({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.eq = (col: string, val: unknown) => { filtri[col] = val; return b }
      b.maybeSingle = async () => ({ data: table === 'pagamenti' ? h.pag : null, error: null })
      b.then = (ok: (v: unknown) => unknown) =>
        ok({
          data: table === 'fatture_emesse'
            ? (filtri.id ? h.righe.filter((r) => r.id === filtri.id) : h.righe)
            : [],
          error: null,
        })
      return b
    },
    storage: {
      from: () => ({
        // `{ data, error }`, MAI un throw: è la forma vera, ed è quella che
        // rendeva morto il catch della rotta.
        download: async (chiave: string) => {
          h.chiamateDownload += 1
          h.chiaviChieste.push(chiave)
          return { data: h.scaricato, error: h.erroreScarico }
        },
        list: async () => ({ data: [], error: null }),
      }),
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/fattura/route'

const chiedi = (extra = '') =>
  GET(new Request(`http://test/api/pagamenti/fattura?pagamento_id=${PID}${extra}`))

/** Le righe `error` del canale `storage`. */
function guasti() {
  return log.logEvento.mock.calls
    .filter((c) => c[0] === 'storage' && c[1] === 'error')
    .map((c) => ({ campi: c[2] as Record<string, unknown>, err: c[3] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.pag = { id: PID, alunno_id: 'al-1', fattura_stato: 'emessa', fattura_pdf_path: null }
  h.righe = [{ id: FID, numero: 1948, anno: 2026, pdf_path: 'fatture/1948.pdf', sdi_stato: 7 }]
  h.scaricato = null
  h.erroreScarico = null
  h.chiamateDownload = 0
  h.chiaviChieste = []
})

// ═════════════════════════════════════════════════════════════════════════════
describe('a · il bucket risponde con un errore', () => {
  const ERR = { message: 'Object not found', statusCode: '404', error: 'not_found' }

  it('404 con codice, mai `application/pdf`, e l’errore INTERO a registro', async () => {
    h.scaricato = null
    h.erroreScarico = ERR

    const res = await chiedi()

    expect(h.chiamateDownload).toBe(1)          // il bucket è stato interrogato…
    expect(res.status).toBe(404)                // …e non ha dato niente.
    // NESSUN documento di ripiego: il tipo di contenuto non può essere un PDF.
    expect(res.headers.get('content-type') ?? '').not.toContain('application/pdf')
    const corpo = await res.json()
    expect(corpo.codice).toBe('FATTURA_PDF_NON_DISPONIBILE')

    // Una riga sola, di livello `error`: finché c'era il surrogato il risultato
    // era degradato (`warn`), adesso l'utente non riceve niente.
    const g = guasti()
    expect(g).toHaveLength(1)
    expect(g[0].campi).toMatchObject({
      operazione: 'pagamenti/fattura:GET',
      bucket: 'fatture',
      esito: 'pdf-non-scaricato',
    })
    // L'ERRORE INTERO, non un pezzo: è la regola 3 di AGENTS.md, quella pagata
    // con mesi di email di credenziali mai arrivate («403» invece di «403 the
    // domain is not verified»).
    expect(g[0].err).toBe(ERR)
    expect(g[0].err).toMatchObject({ message: 'Object not found', statusCode: '404' })
  })

  it('anche con `data` nullo e `error` nullo (bucket muto) non esce un PDF', async () => {
    // Il caso limite che il vecchio codice trattava come «va bene»: `data`
    // assente e nessun errore. Senza byte non c'è documento, punto.
    h.scaricato = null
    h.erroreScarico = null

    const res = await chiedi()

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('application/pdf')
    expect(guasti()).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('b · a registro non c’è nessuna chiave', () => {
  it('`pdf_path` nullo → 404, e il bucket non viene nemmeno interrogato', async () => {
    h.righe = [{ id: FID, numero: 1948, anno: 2026, pdf_path: null, sdi_stato: 7 }]

    const res = await chiedi()

    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_PDF_NON_DISPONIBILE')
    // Non è pignoleria: se qualcuno riaprisse la strada del ripiego, il modo più
    // naturale sarebbe passare comunque dal download con una chiave inventata.
    expect(h.chiamateDownload).toBe(0)
    expect(h.chiaviChieste).toEqual([])
  })

  it('`pdf_path` nullo ANCHE chiedendo una quota per id → stesso 404, stesso silenzio', async () => {
    h.righe = [{ id: FID, numero: 1948, anno: 2026, pdf_path: null, sdi_stato: 7 }]
    const res = await chiedi(`&fattura_id=${FID}`)
    expect(res.status).toBe(404)
    expect(h.chiamateDownload).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('c · il documento c’è', () => {
  it('200 con i BYTE DEL BUCKET, non con byte fabbricati qui', async () => {
    // Byte riconoscibili: se la risposta fosse un PDF disegnato al volo sarebbero
    // altri, e più di quattro.
    const veri = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    h.scaricato = new Blob([veri])

    const res = await chiedi()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // La chiave interrogata è quella scritta a registro, non una ricostruita.
    expect(h.chiaviChieste).toEqual(['fatture/1948.pdf'])
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(veri)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('d · lock di forma: nel file non c’è più un generatore di PDF', () => {
  /*
   * Le prove qui sopra guardano il comportamento su tre rami. Un ripiego si
   * rimette su un QUARTO ramo, e resterebbero tutte verdi. Questa guarda il
   * sorgente: finché non c'è niente con cui disegnare un PDF, non c'è niente da
   * consegnare al posto del documento vero.
   *
   * Si legge il file dal disco e non si importa: la tesi è su ciò che il file
   * CONTIENE, non su ciò che esporta.
   */
  const SORGENTE = readFileSync(
    join(process.cwd(), 'src/app/api/pagamenti/fattura/route.ts'),
    'utf8',
  )

  it('nessun `new jsPDF`, nessun import di `jspdf`', () => {
    expect(SORGENTE).not.toMatch(/new\s+jsPDF/)
    expect(SORGENTE).not.toMatch(/from\s+['"]jspdf['"]/)
  })

  it('nessun altro fabbricatore di documenti (pdfkit, pdf-lib, buildRicevutaPdf)', () => {
    expect(SORGENTE).not.toMatch(/from\s+['"]pdfkit['"]/)
    expect(SORGENTE).not.toMatch(/from\s+['"]pdf-lib['"]/)
    expect(SORGENTE).not.toMatch(/buildRicevutaPdf|buildFatturaPdf/)
  })

  it('CONTROPROVA della sonda: sulla stessa forma, scritta a mano, diventa rossa', () => {
    // Senza questa riga il lock sarebbe verde anche se leggesse un file vuoto,
    // o se la regexp fosse scritta male. Un test mai visto fallire non è un test.
    const finto = "import { jsPDF } from 'jspdf'\nconst doc = new jsPDF()"
    expect(finto).toMatch(/new\s+jsPDF/)
    expect(finto).toMatch(/from\s+['"]jspdf['"]/)
    // …e che il sorgente vero sia stato letto davvero, non una stringa vuota.
    expect(SORGENTE.length).toBeGreaterThan(1000)
    expect(SORGENTE).toContain('pagamenti/fattura:GET')
  })
})
