import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'

/**
 * `tipo: 'altro'` — GLI ALTRI DUE DOCUMENTI, non solo la fattura.
 *
 * ─── PERCHÉ SONO IN QUESTO LOTTO ────────────────────────────────────────────
 * Chi paga la retta di un bambino riceve fino a tre documenti nell'arco di un
 * anno: la fattura elettronica, l'attestazione per il 730 e la riga nella
 * comunicazione all'Agenzia delle Entrate. Se il selettore dell'intestatario
 * valesse solo per la prima, la stessa famiglia riceverebbe tre documenti con
 * DUE intestatari diversi — e sui due che finiscono al fisco (attestazione e
 * comunicazione AdE) l'intestatario decide chi ottiene la detrazione.
 *
 * Fino al 2026-09-04 entrambi leggevano `intestatario_fatture.adult_id`, un
 * campo che sul ramo `'altro'` non esiste: ripiegavano su «Famiglia ⟨cognome⟩»
 * (e l'export escludeva la riga per «codice fiscale del pagatore mancante»)
 * senza che nulla lo dicesse.
 *
 * Il quarto documento era la ricevuta contabile per singolo pagamento, con lo
 * stesso difetto e la stessa correzione: è stata rimossa il 2026-09-10 insieme
 * alla sua rotta. La ricevuta DI FAMIGLIA che resta si intesta al pagante e
 * NON legge `intestatario_fatture` (ricevute.ts), quindi la premessa di questo
 * file non la riguarda.
 *
 * Nomi e codici fiscali SINTETICI: il repository è pubblico.
 */

const DATI_ALTRO = {
  nome: 'Carlo',
  cognome: 'Perlini',
  cf: 'PRLCRL80A01H501Z',
  indirizzo: 'Via delle Prove',
  cap: '81030',
  comune: 'Cesa',
}

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'

/* ═══════════════════════ 1 · L'ATTESTAZIONE 730 ════════════════════════════ */

const att = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  buildPdf: vi.fn((...args: unknown[]) => Buffer.from(`%PDF-1.4 finto ${args.length}`)),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: att.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-1'],
  assertPagamentoInScope: async () => null,
}))
vi.mock('@/lib/pagamenti/pdf', async (originale) => {
  const actual = await originale<typeof import('@/lib/pagamenti/pdf')>()
  return { ...actual, buildAttestazionePdf: att.buildPdf }
})

const exp = vi.hoisted(() => ({
  alunni: [] as Record<string, unknown>[],
  incassi: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? att.alunno : table === 'admin_settings' ? {} : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            table === 'alunni'
              ? exp.alunni
              : table === 'incassi'
                ? exp.incassi
                : table === 'pagamenti'
                  ? [{ id: 'p1', descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta' } }]
                  : [],
          error: null,
        })
      return b
    },
  }),
}))

const { GET: ATTESTAZIONE } = await import('@/app/api/pagamenti/attestazione/route')
const { GET: EXPORT } = await import('@/app/api/pagamenti/export/route')

describe('attestazione 730 — l’intestatario digitato arriva sul PDF', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    att.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    exp.incassi = [{ pagamento_id: 'p1', importo: 150, metodo: 'bonifico', data_incasso: '2026-01-10' }]
  })

  it('`tipo: \'altro\'` → nome e codice fiscale digitati, non «Famiglia Fabbri»', async () => {
    att.alunno = {
      id: ALUNNO,
      nome: 'Mario',
      cognome: 'Fabbri',
      scuola_id: 'sc-1',
      intestatario_fatture: { tipo: 'altro', dati: DATI_ALTRO },
    }
    const res = await ATTESTAZIONE(new Request(`http://x/api/pagamenti/attestazione?alunno_id=${ALUNNO}&anno=2026`))
    expect(res.status).toBe(200)
    expect(att.buildPdf).toHaveBeenCalledTimes(1)
    const arg = att.buildPdf.mock.calls[0][0] as unknown as {
      intestatario: { nome: string; codice_fiscale?: string | null }
    }
    expect(arg.intestatario).toEqual({ nome: 'Carlo Perlini', codice_fiscale: 'PRLCRL80A01H501Z' })
  })

  it('senza intestatario resta «Famiglia ⟨cognome⟩»', async () => {
    att.alunno = { id: ALUNNO, nome: 'Mario', cognome: 'Fabbri', scuola_id: 'sc-1', intestatario_fatture: null }
    await ATTESTAZIONE(new Request(`http://x/api/pagamenti/attestazione?alunno_id=${ALUNNO}&anno=2026`))
    const arg = att.buildPdf.mock.calls[0][0] as unknown as { intestatario: { nome: string } }
    expect(arg.intestatario).toEqual({ nome: 'Famiglia Fabbri' })
  })
})

/* ═══════════════════════ 2 · LA COMUNICAZIONE ALL'AdE ══════════════════════ */

function foglio(buf: ArrayBuffer, nome: string): Record<string, unknown>[] {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
  return XLSX.utils.sheet_to_json(wb.Sheets[nome]) as Record<string, unknown>[]
}

describe('comunicazione AdE — la riga non si perde per «CF del pagatore mancante»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    att.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    exp.incassi = [
      {
        importo: 150,
        metodo: 'bonifico',
        data_incasso: '2026-01-10',
        pagamenti: { alunno_id: ALUNNO, descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta' } },
      },
    ]
  })

  it('`tipo: \'altro\'` → riga «Da comunicare» col CF digitato', async () => {
    exp.alunni = [
      {
        id: ALUNNO,
        nome: 'Mario',
        cognome: 'Fabbri',
        codice_fiscale: 'FBBMRA20A01F839X',
        opposizione_ade: false,
        scuola_id: 'sc-1',
        intestatario_fatture: { tipo: 'altro', dati: DATI_ALTRO },
      },
    ]
    const res = await EXPORT(new Request('http://x/api/pagamenti/export?tipo=ade&anno=2026') as never)
    const buf = await res.arrayBuffer()
    const daComunicare = foglio(buf, 'Da comunicare')
    expect(daComunicare).toHaveLength(1)
    expect(daComunicare[0]['CF pagatore']).toBe('PRLCRL80A01H501Z')
    expect(daComunicare[0].Pagatore).toBe('Carlo Perlini')
    expect(foglio(buf, 'Escluse')).toHaveLength(0)
  })

  it('l’OPPOSIZIONE della famiglia vince comunque: la riga resta esclusa', async () => {
    // La regola dell'opposizione è di merito e sta PRIMA dell'intestatario: se
    // l'intestatario digitato la scavalcasse, si comunicherebbe all'Agenzia delle
    // Entrate una spesa che la famiglia ha chiesto di non comunicare.
    exp.alunni = [
      {
        id: ALUNNO,
        nome: 'Mario',
        cognome: 'Fabbri',
        codice_fiscale: 'FBBMRA20A01F839X',
        opposizione_ade: true,
        scuola_id: 'sc-1',
        intestatario_fatture: { tipo: 'altro', dati: DATI_ALTRO },
      },
    ]
    const res = await EXPORT(new Request('http://x/api/pagamenti/export?tipo=ade&anno=2026') as never)
    const buf = await res.arrayBuffer()
    expect(foglio(buf, 'Da comunicare')).toHaveLength(0)
    const escluse = foglio(buf, 'Escluse')
    expect(escluse).toHaveLength(1)
    expect(String(escluse[0].Motivo)).toContain('opposizione')
  })

  it('`altro` INCOMPLETO (senza codice fiscale) → esclusa e MOTIVATA, non comunicata a vuoto', async () => {
    exp.alunni = [
      {
        id: ALUNNO,
        nome: 'Mario',
        cognome: 'Fabbri',
        codice_fiscale: 'FBBMRA20A01F839X',
        opposizione_ade: false,
        scuola_id: 'sc-1',
        intestatario_fatture: { tipo: 'altro', dati: { nome: 'Carlo', cognome: 'Perlini' } },
      },
    ]
    const res = await EXPORT(new Request('http://x/api/pagamenti/export?tipo=ade&anno=2026') as never)
    const buf = await res.arrayBuffer()
    expect(foglio(buf, 'Da comunicare')).toHaveLength(0)
    expect(String(foglio(buf, 'Escluse')[0].Motivo)).toContain('codice fiscale')
  })
})
