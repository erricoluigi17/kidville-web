import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AL GENITORE LA SEDE NON SI APPLICA — e i due controlli negativi che lo
 * impediscono di diventare «al genitore non si applica niente».
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 *
 * `GET /api/pagamenti/fattura` e `GET …/fattura/list` chiamavano
 * `assertPagamentoInScope` A TUTTI, prima di qualunque controllo di famiglia.
 * Quella funzione confronta `pagamenti.scuola_id` con `scuoleDiUtente(...)`, che
 * per un non-admin ritorna la SOLA sede primaria (`utenti.scuola_id`).
 *
 * Un genitore con due figli in due plessi ha una sede primaria e basta: sulla
 * fattura del figlio iscritto nell'ALTRA sede riceveva **403 «Pagamento fuori dal
 * tuo plesso»**, sul documento fiscale della propria famiglia. Dal 2026-07-29 le
 * sedi di produzione sono tre, quindi non è un caso di scuola.
 *
 * ─── PERCHÉ QUI `@/lib/auth/scope` NON È MOCKATO ───────────────────────────
 *
 * È il punto di tutto il file. Quasi 200 test del repo sostituiscono quel modulo
 * con `assertPagamentoInScope: async () => null`, cioè con uno scope che dice
 * sempre di sì: con quel finto, il difetto multi-sede è INVISIBILE — la prova
 * resterebbe verde anche rimettendo la chiamata incondizionata. Qui gira la
 * funzione VERA sopra un database finto, così il 403 di sede può davvero uscire.
 * È l'unica forma in cui «non esce» significa qualcosa.
 *
 * ⚠️ UN TEST CHE MOSTRA SOLO IL SÌ NON È UN TEST DI PERMESSI. Le due prove
 * negative in fondo — lo stesso genitore su un bambino che non è suo, e la
 * segreteria di una sede sul pagamento di un'altra — sono la metà che impedisce
 * di «aggiustare» il difetto togliendo il gate: senza di loro, `return null`
 * secco in cima ad `assertFatturaInScope` renderebbe tutto verde.
 *
 * uuid sintetici: il repository è pubblico.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const SEDE_A = 'aaaa1111-0000-4000-8000-000000000001'
const SEDE_B = 'bbbb2222-0000-4000-8000-000000000002'

const GENITORE = 'c0c0c0c0-0000-4000-8000-000000000010'
const SEGRETERIA = 'd0d0d0d0-0000-4000-8000-000000000011'

const ALUNNO_MIO = 'e1e1e1e1-0000-4000-8000-000000000020'
const ALUNNO_ALTRUI = 'e2e2e2e2-0000-4000-8000-000000000021'

/** Il pagamento del MIO figlio, iscritto nella sede B (io sono censito in A). */
const PAG_ALTRA_SEDE = 'f1f1f1f1-0000-4000-8000-000000000030'
/** Un pagamento della MIA sede, ma di un bambino che non è mio figlio. */
const PAG_ALTRUI = 'f2f2f2f2-0000-4000-8000-000000000031'

const FATTURA = 'f3f3f3f3-0000-4000-8000-000000000032'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  /** `pagamenti` per id. */
  pagamenti: {} as Record<string, Record<string, unknown> | null>,
  /** I legami runtime genitore↔alunno che il database contiene davvero. */
  legami: [] as { genitore: string; alunno: string }[],
  /** `fatture_emesse` per `pagamento_id`. */
  fatture: {} as Record<string, Record<string, unknown>[]>,
  /** Gli oggetti che il bucket `fatture` elenca. */
  bucket: [] as { name: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: h.utente })),
  requireStaff: vi.fn(async () => ({ user: h.utente })),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.in = (col: string, val: unknown) => { filtri[col] = val; return b }
      b.eq = (col: string, val: unknown) => { filtri[col] = val; return b }
      // PostgREST NON lancia: ogni ritorno è `{ data, error }`, mai un throw.
      b.maybeSingle = async () => {
        if (table === 'pagamenti') return { data: h.pagamenti[String(filtri.id)] ?? null, error: null }
        if (table === 'legame_genitori_alunni') {
          const c = h.legami.some((l) => l.genitore === filtri.genitore_id && l.alunno === filtri.alunno_id)
          return { data: c ? { alunno_id: filtri.alunno_id } : null, error: null }
        }
        return { data: null, error: null }
      }
      b.then = (ok: (v: unknown) => unknown) => {
        if (table === 'legame_genitori_alunni') {
          return ok({
            data: h.legami.filter((l) => l.genitore === filtri.genitore_id).map((l) => ({ alunno_id: l.alunno })),
            error: null,
          })
        }
        if (table === 'fatture_emesse') {
          const righe = h.fatture[String(filtri.pagamento_id)] ?? []
          return ok({ data: filtri.id ? righe.filter((r) => r.id === filtri.id) : righe, error: null })
        }
        // `parents`, `student_parents`, `utenti_scuole`: nessuna riga.
        return ok({ data: [], error: null })
      }
      return b
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }),
        list: async () => ({ data: h.bucket, error: null }),
      }),
    },
  }),
}))

import { GET as FATTURA_GET } from '@/app/api/pagamenti/fattura/route'
import { GET as LISTA } from '@/app/api/pagamenti/fattura/list/route'

const chiediPdf = (pagamento: string) =>
  FATTURA_GET(new Request(`http://test/api/pagamenti/fattura?pagamento_id=${pagamento}`))
const chiediElenco = (pagamento: string) =>
  LISTA(new Request(`http://test/api/pagamenti/fattura/list?pagamento_id=${pagamento}`))

/** Le righe `warn` di `auth`, con il loro `tipo`: è lì che vivono i rifiuti. */
function rifiuti(): { tipo: unknown; campi: Record<string, unknown> }[] {
  return log.logEvento.mock.calls
    .filter((c) => c[0] === 'auth' && c[1] === 'warn')
    .map((c) => ({ tipo: (c[2] as Record<string, unknown>).tipo, campi: c[2] as Record<string, unknown> }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: GENITORE, role: 'genitore', scuola_id: SEDE_A }
  h.pagamenti = {
    // Il pagamento di MIO figlio, che però è iscritto nell'ALTRA sede.
    [PAG_ALTRA_SEDE]: {
      id: PAG_ALTRA_SEDE, scuola_id: SEDE_B, alunno_id: ALUNNO_MIO,
      fattura_stato: 'emessa', fattura_pdf_path: null,
    },
    // Un pagamento della MIA sede, di un bambino che non è mio: la sede non
    // c'entra, e serve proprio che non c'entri.
    [PAG_ALTRUI]: {
      id: PAG_ALTRUI, scuola_id: SEDE_A, alunno_id: ALUNNO_ALTRUI,
      fattura_stato: 'emessa', fattura_pdf_path: null,
    },
  }
  h.legami = [{ genitore: GENITORE, alunno: ALUNNO_MIO }]
  h.fatture = {
    [PAG_ALTRA_SEDE]: [{
      id: FATTURA, numero: 1948, anno: 2026, quota_label: null, quota_adult_id: null,
      intestatario: null, pdf_path: 'fattura-b.pdf', sdi_stato: 7, sdi_stato_label: 'Consegnata',
    }],
    [PAG_ALTRUI]: [{
      id: 'f9', numero: 1949, anno: 2026, quota_label: null, quota_adult_id: null,
      intestatario: null, pdf_path: 'fattura-x.pdf', sdi_stato: 7, sdi_stato_label: 'Consegnata',
    }],
  }
  h.bucket = [{ name: 'fattura-b.pdf' }, { name: 'fattura-x.pdf' }]
})

// ═════════════════════════════════════════════════════════════════════════════
describe('il genitore multi-sede riceve la fattura del figlio dell’ALTRO plesso', () => {
  it('GET /fattura — figlio in SEDE_B, genitore censito in SEDE_A → 200, non 403', async () => {
    const res = await chiediPdf(PAG_ALTRA_SEDE)

    // Il punto della prova: NON è il 403 di sede.
    expect(res.status).not.toBe(403)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    // E il contatore dei tentativi non si è acceso su un genitore titolare: era
    // il secondo danno del difetto — un rilevatore di IDOR pieno di falsi positivi
    // smette di essere un rilevatore.
    expect(rifiuti()).toEqual([])
  })

  it('GET /fattura/list — stesso genitore, stessa fattura: elenco pieno, non 403', async () => {
    const res = await chiediElenco(PAG_ALTRA_SEDE)

    expect(res.status).not.toBe(403)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({ numero: 1948, pdf_disponibile: true })
    expect(rifiuti()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CONTROLLO NEGATIVO — lo stesso genitore su un bambino che non è suo', () => {
  /*
   * La sede di questo pagamento è la SUA (SEDE_A): se passasse, non si potrebbe
   * dire «l'ha fermato lo scope di sede». L'unica cosa che lo ferma è il LEGAME.
   */
  it('GET /fattura → 403, e resta una riga `warn` con il tipo giusto', async () => {
    const res = await chiediPdf(PAG_ALTRUI)

    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('FATTURA_ACCESSO_NEGATO')

    const w = rifiuti()
    expect(w).toHaveLength(1)
    expect(w[0].tipo).toBe('fattura-non-della-famiglia')
    // SOLO uuid ed enumerati: il `tipo`, il `ruolo` e tre identificativi. Nessun
    // nome, nessun importo, nessun numero di documento — sono dati di minori.
    expect(w[0].campi).toMatchObject({
      azione: 'assertFatturaInScope',
      utente: GENITORE,
      pagamento_id: PAG_ALTRUI,
      alunno_id: ALUNNO_ALTRUI,
      stato: 403,
    })
    const valori = Object.values(w[0].campi).map((v) => String(v))
    expect(valori.join(' ')).not.toMatch(/@|[A-Z]{6}\d{2}[A-Z]\d{2}/)
  })

  it('GET /fattura/list → 403: l’elenco non conferma nemmeno che la fattura esista', async () => {
    const res = await chiediElenco(PAG_ALTRUI)
    expect(res.status).toBe(403)
    expect(rifiuti().map((r) => r.tipo)).toEqual(['fattura-non-della-famiglia'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CONTROLLO NEGATIVO — la segreteria resta chiusa nel proprio plesso', () => {
  /*
   * Per chi lavora il perimetro è il PLESSO, e non cambia di una riga: la deroga
   * riguarda la FAMIGLIA, non «le fatture». Se qualcuno un domani togliesse il
   * gate invece di spostarlo, questi due casi sono ciò che diventa rosso.
   */
  beforeEach(() => {
    h.utente = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A }
  })

  it('GET /fattura — segreteria di SEDE_A su un pagamento di SEDE_B → 403', async () => {
    const res = await chiediPdf(PAG_ALTRA_SEDE)
    expect(res.status).toBe(403)
    // Il rifiuto viene dallo scope di sede VERO, non da un finto compiacente.
    expect(rifiuti().map((r) => r.tipo)).toContain('pagamento-fuori-sede')
  })

  it('GET /fattura/list — stesso pagamento, stesso 403', async () => {
    const res = await chiediElenco(PAG_ALTRA_SEDE)
    expect(res.status).toBe(403)
  })

  it('…e nel PROPRIO plesso la stessa segreteria passa (il gate non è un muro)', async () => {
    const res = await chiediPdf(PAG_ALTRUI)
    expect(res.status).toBe(200)
    expect(rifiuti()).toEqual([])
  })
})
