import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `?download=` — DOVE FINISCE IL FILE, E COME SI CHIAMA.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La stessa rotta serve due gesti diversi: «Apri» (il PDF si legge a schermo:
 * `inline`) e «Scarica» (il browser lo salva: `attachment`). A distinguerli è un
 * solo parametro, e la sua forma non è indifferente.
 *
 * ─── PERCHÉ UN ENUMERATO E NON UN BOOLEANO ─────────────────────────────────
 *
 * In una query string il valore arriva SEMPRE come stringa, e
 * `z.coerce.boolean()` considera vera qualunque stringa non vuota: con quello,
 * `?download=0` diventerebbe «sì». `z.enum(['0','1'])` chiude la classe intera —
 * e rifiuta con 400 tutto il resto, invece di indovinare.
 *
 * ─── PERCHÉ IL NOME È LO STESSO NEI DUE CASI ───────────────────────────────
 *
 * Cambia dove finisce il file, non come si chiama. Un nome che cambia col
 * pulsante premuto è il modo più sicuro di ritrovarsi due copie della stessa
 * fattura con due nomi diversi nella cartella Download.
 *
 * ─── E PERCHÉ IL NOME È FATTO DI SOLE CIFRE ────────────────────────────────
 *
 * Quel nome finisce nel foglio di condivisione di un telefono, nella cartella
 * Download, negli allegati di una mail inoltrata al commercialista. Lì non ci va
 * mai il nome di un bambino, né un frammento di uuid che qualcuno possa
 * incollare in un indirizzo. Numero e anno di una fattura sono pubblici per
 * definizione: stanno stampati sul documento.
 */

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

const PID = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const FID = 'bbbbbbbb-0000-4000-8000-0000000000b1'

const h = vi.hoisted(() => ({
  righe: [] as Record<string, unknown>[],
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
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti'
          ? { id: PID, alunno_id: 'al-1', fattura_stato: 'emessa', fattura_pdf_path: null }
          : null,
        error: null,
      })
      b.then = (ok: (v: unknown) => unknown) =>
        ok({ data: table === 'fatture_emesse' ? h.righe : [], error: null })
      return b
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/fattura/route'

const chiedi = (query: string) =>
  GET(new Request(`http://test/api/pagamenti/fattura?pagamento_id=${PID}${query}`))

const disposizione = (r: Response) => r.headers.get('content-disposition') ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = [{ id: FID, numero: 1948, anno: 2026, pdf_path: 'fatture/1948.pdf', sdi_stato: 7 }]
})

// ═════════════════════════════════════════════════════════════════════════════
describe('dove finisce il file', () => {
  it('`download=1` → `attachment`, col nome parlante', async () => {
    const res = await chiedi('&download=1')
    expect(res.status).toBe(200)
    expect(disposizione(res)).toBe('attachment; filename="fattura-1948-2026.pdf"')
  })

  it('parametro ASSENTE → `inline`, e lo STESSO nome', async () => {
    const res = await chiedi('')
    expect(res.status).toBe(200)
    expect(disposizione(res)).toBe('inline; filename="fattura-1948-2026.pdf"')
  })

  it('`download=0` → `inline`: lo zero è uno zero, non «una stringa non vuota»', async () => {
    // È il caso che un `z.coerce.boolean()` sbaglierebbe: `'0'` è vera, per lui.
    const res = await chiedi('&download=0')
    expect(res.status).toBe(200)
    expect(disposizione(res)).toContain('inline;')
  })

  it('i due gesti differiscono SOLO nella disposizione: nome identico, byte per byte', async () => {
    const apri = disposizione(await chiedi(''))
    const salva = disposizione(await chiedi('&download=1'))
    expect(apri.replace('inline', 'attachment')).toBe(salva)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('un valore che non è né 0 né 1 si RIFIUTA, non si indovina', () => {
  it('`download=2` → 400', async () => {
    const res = await chiedi('&download=2')
    expect(res.status).toBe(400)
  })

  it('`download=si` e `download=true` → 400 anche loro', async () => {
    expect((await chiedi('&download=si')).status).toBe(400)
    expect((await chiedi('&download=true')).status).toBe(400)
  })

  it('un 400 NON consegna niente: nessun PDF esce dal ramo del rifiuto', async () => {
    const res = await chiedi('&download=2')
    expect(res.headers.get('content-type') ?? '').not.toContain('application/pdf')
    expect(disposizione(res)).toBe('')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('il nome del file non porta fuori niente di personale', () => {
  it('solo cifre: un numero sporco («FPR 1948/A») esce come 1948', async () => {
    h.righe = [{ id: FID, numero: 'FPR 1948/A', anno: '2026', pdf_path: 'fatture/x.pdf', sdi_stato: 7 }]
    expect(disposizione(await chiedi('&download=1'))).toBe('attachment; filename="fattura-1948-2026.pdf"')
  })

  it('numero e anno assenti → `fattura-0-0.pdf`, che si legge (non `fattura--.pdf`)', async () => {
    h.righe = [{ id: FID, numero: null, anno: null, pdf_path: 'fatture/x.pdf', sdi_stato: 7 }]
    expect(disposizione(await chiedi(''))).toBe('inline; filename="fattura-0-0.pdf"')
  })

  it('mai l’uuid del pagamento, mai l’intestatario, mai il nome del bambino', async () => {
    h.righe = [{
      id: FID, numero: 1948, anno: 2026, pdf_path: 'fatture/1948.pdf', sdi_stato: 7,
      // Dati SINTETICI: il repository è pubblico. Sono qui solo per verificare
      // che NON escano — se un giorno qualcuno mettesse `intestatario` nel nome
      // «perché è più comodo», questa riga diventa rossa.
      intestatario: { nome: 'Giulia', cognome: 'Farina' },
      quota_label: 'Mamma',
    }]
    const d = disposizione(await chiedi('&download=1'))
    expect(d).not.toContain(PID)
    expect(d).not.toContain(FID)
    expect(d).not.toMatch(/Giulia|Farina|Mamma/i)
    // La forma completa, per non lasciare spazio a interpretazioni.
    expect(d).toMatch(/^attachment; filename="fattura-\d+-\d+\.pdf"$/)
  })
})
