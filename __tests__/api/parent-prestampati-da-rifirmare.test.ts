import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../fixtures/finto-supabase'
import type { RigaFiglio } from '@/lib/anagrafiche/legami'

/**
 * GET /api/parent/prestampati/da-rifirmare (compito 4.4.9).
 *
 * Il client è il finto che APPLICA i filtri: un mock piatto sarebbe verde anche senza `.in('student_id', …)`
 * e senza il filtro sul cestino. `getFigliAttiviDiGenitore` è finta di proposito: la sua firma è il contratto,
 * e i suoi interni li riscrive il compito 4.4.6. Nessun dato reale: uuid e date sono inventati.
 */

const SEDE_A = '22222222-2222-4222-8222-222222222221'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const SEDE_C = '22222222-2222-4222-8222-222222222223'
const FIGLIO_1 = '11111111-1111-4111-8111-111111111111'
const FIGLIO_2 = '11111111-1111-4111-8111-111111111112'
const ALTRUI = '11111111-1111-4111-8111-111111111119'
const GENITORE = '99999999-9999-4999-8999-999999999991'
const OP = 'parent/prestampati/da-rifirmare:GET'

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  figli: {
    righe: [] as RigaFiglio[],
    totaleLegami: 0,
    nascosti: {},
    completo: true,
    errore: null as null | { code?: string },
  },
  /** I figli per cui si è passati dalla porta del fascicolo. */
  portate: [] as string[],
  rifiuto: null as null | Response,
  supabase: null as unknown,
  log: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: async () =>
    h.user
      ? { user: h.user, response: null }
      : { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) },
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: async (_request: Request, alunnoId: string) => {
    h.portate.push(alunnoId)
    return h.rifiuto ? { user: null, response: h.rifiuto } : { user: h.user, response: null }
  },
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliAttiviDiGenitore: async () => h.figli }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.supabase }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => void h.log.push(a),
  logErrore: (...a: unknown[]) => void h.log.push(a),
  logOk: (...a: unknown[]) => void h.log.push(a),
}))

import { GET } from '@/app/api/parent/prestampati/da-rifirmare/route'

const annoId = (annoInizio: number) => `a${annoInizio}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`

/** Una riga di `anni_sede` di una sede, con le date predefinite. */
function annoDiSede(scuola: string, annoInizio: number, stato: string) {
  return {
    id: `${scuola.slice(-1)}${annoInizio}bbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    scuola_id: scuola,
    anno_id: annoId(annoInizio),
    inizio: `${annoInizio}-09-01`,
    fine: `${annoInizio + 1}-08-31`,
    ultimo_giorno_aperto: `${annoInizio + 1}-07-31`,
    prepara_successivo_dal: `${annoInizio}-09-01`,
    stato,
    domande_aperte: false,
  }
}

const figlio = (id: string, scuola_id: string | null = SEDE_A): RigaFiglio => ({
  id,
  nome: 'Finto',
  cognome: 'Bambino',
  classe_sezione: 'A',
  scuola_id,
  section_id: null,
})

const frequenza = (alunno_id: string, annoInizio: number) => ({ alunno_id, anno_id: annoId(annoInizio) })
const documento = (student_id: string, document_type: string, created_at: string, eliminato_il: string | null = null) => ({
  id: `${student_id.slice(-1)}${created_at.slice(0, 10)}`,
  student_id,
  document_type,
  created_at,
  eliminato_il,
})

/** Com'è ogni sede oggi. */
const ANNI_OGGI = [SEDE_A, SEDE_B, SEDE_C].flatMap((s) => [
  annoDiSede(s, 2025, 'chiuso'),
  annoDiSede(s, 2026, 'corrente'),
  annoDiSede(s, 2027, 'in_preparazione'),
])
/** Dopo il primo passaggio. */
const ANNI_DOPO = [SEDE_A, SEDE_B].flatMap((s) => [
  annoDiSede(s, 2026, 'chiuso'),
  annoDiSede(s, 2027, 'corrente'),
  annoDiSede(s, 2028, 'in_preparazione'),
])

let tabelleLette: string[] = []

function preparaDb(db: Partial<DBFinto>, errori: Record<string, ErrorePostgrest> = {}, maxRighe?: number): DBFinto {
  const pieno: DBFinto = {
    frequenze: [],
    anni_sede: [],
    anni_scolastici: [2025, 2026, 2027, 2028].map((a) => ({ id: annoId(a), anno_inizio: a })),
    student_documents: [],
    fascicolo_accessi_audit: [],
    ...db,
  }
  tabelleLette = []
  h.supabase = creaFintoSupabase(pieno, tabelleLette, { errori, maxRighe })
  return pieno
}

const chiedi = async () => {
  const res = await GET(new Request('http://localhost/api/parent/prestampati/da-rifirmare') as never)
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> }
}

const righeDiLog = (livello: string) => h.log.filter((a) => a[1] === livello).map((a) => a[2] as Record<string, unknown>)

beforeEach(() => {
  h.user = { id: GENITORE, role: 'genitore' }
  h.figli = { righe: [figlio(FIGLIO_1)], totaleLegami: 1, nascosti: {}, completo: true, errore: null }
  h.portate = []
  h.rifiuto = null
  h.log = []
  preparaDb({})
})

describe('il gate', () => {
  it('senza sessione risponde 401 e non legge niente', async () => {
    h.user = null
    const { status } = await chiedi()
    expect(status).toBe(401)
    expect(tabelleLette).toEqual([])
  })

  it('chi non agisce da genitore riceve 403 e non legge niente', async () => {
    h.user = { id: 'u-segreteria', role: 'segreteria' }
    const { status } = await chiedi()
    expect(status).toBe(403)
    expect(tabelleLette).toEqual([])
  })
})

describe('oggi', () => {
  it('nessuna famiglia ha moduli da rifirmare, con tutte le frequenze del 2026/27 e firme di ogni giorno', async () => {
    h.figli.righe = [figlio(FIGLIO_1, SEDE_A), figlio(FIGLIO_2, SEDE_B)]
    h.figli.totaleLegami = 2
    const firme = ['2026-08-15', '2026-08-31', '2026-09-01', '2026-11-08'].flatMap((g) =>
      ['delega_ritiro', 'permesso_orario', 'autorizzazione_uscita', 'scheda_sanitaria'].flatMap((slug) => [
        documento(FIGLIO_1, slug, `${g}T10:00:00Z`),
        documento(FIGLIO_2, slug, `${g}T10:00:00Z`),
      ]),
    )
    const db = preparaDb({
      anni_sede: ANNI_OGGI,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_2, 2026)],
      student_documents: firme,
    })

    const { status, corpo } = await chiedi()

    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
    // Nessuno ha un anno prima dell'attivo: il fascicolo non si apre e l'audit resta vuoto.
    expect(h.portate).toEqual([])
    expect(tabelleLette).not.toContain('student_documents')
    expect(db.fascicolo_accessi_audit).toEqual([])
  })

  it('un genitore con zero figli attivi riceve una lista vuota, non un errore', async () => {
    h.figli = { righe: [], totaleLegami: 2, nascosti: {}, completo: true, errore: null }
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
    expect(tabelleLette).toEqual([])
  })

  it('il successo si logga, col conteggio', async () => {
    preparaDb({ anni_sede: ANNI_OGGI, frequenze: [frequenza(FIGLIO_1, 2026)] })
    await chiedi()
    expect(righeDiLog('info')).toContainEqual(
      expect.objectContaining({ operazione: OP, esito: 'da-rifirmare-calcolato', n: 0 }),
    )
  })
})

describe('dopo il primo passaggio', () => {
  it('risponde per il figlio che continua e non per il fratello appena arrivato', async () => {
    h.figli.righe = [figlio(FIGLIO_1), figlio(FIGLIO_2)]
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027), frequenza(FIGLIO_2, 2027)],
      student_documents: [
        documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z'),
        documento(FIGLIO_2, 'delega_ritiro', '2027-06-20T08:00:00Z'),
      ],
    })

    const { status, corpo } = await chiedi()

    expect(status).toBe(200)
    expect(corpo.data).toEqual([
      {
        alunno_id: FIGLIO_1,
        moduli: [{ slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-10-10' }],
      },
    ])
  })

  it('la lettura del fascicolo finisce nel registro degli accessi, solo per chi è stato letto', async () => {
    h.figli.righe = [figlio(FIGLIO_1), figlio(FIGLIO_2)]
    const db = preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027), frequenza(FIGLIO_2, 2027)],
    })
    await chiedi()
    expect(db.fascicolo_accessi_audit).toHaveLength(1)
    expect(db.fascicolo_accessi_audit[0]).toMatchObject({ alunno_id: FIGLIO_1, utente_id: GENITORE, azione: 'list' })
  })

  it('dalla porta della famiglia passa ogni figlio di cui si apre il fascicolo, e nessun altro', async () => {
    h.figli.righe = [figlio(FIGLIO_1), figlio(FIGLIO_2)]
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027), frequenza(FIGLIO_2, 2027)],
    })
    await chiedi()
    expect(h.portate).toEqual([FIGLIO_1])
  })

  it('se la porta dice no, il fascicolo resta chiuso e la risposta è la sua', async () => {
    h.rifiuto = new Response(JSON.stringify({ error: 'no' }), { status: 403 })
    const db = preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)],
      student_documents: [documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z')],
    })
    const { status } = await chiedi()
    expect(status).toBe(403)
    expect(tabelleLette).not.toContain('student_documents')
    expect(db.fascicolo_accessi_audit).toEqual([])
  })

  it('un documento nel cestino non vale come firma', async () => {
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)],
      student_documents: [
        documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z'),
        documento(FIGLIO_1, 'delega_ritiro', '2027-09-10T08:00:00Z', '2027-09-11T08:00:00Z'),
      ],
    })
    const { corpo } = await chiedi()
    expect(corpo.data).toEqual([
      {
        alunno_id: FIGLIO_1,
        moduli: [{ slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-10-10' }],
      },
    ])
  })

  it('la firma del figlio di un altro non copre il mio', async () => {
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027), frequenza(ALTRUI, 2026), frequenza(ALTRUI, 2027)],
      student_documents: [
        documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z'),
        documento(ALTRUI, 'delega_ritiro', '2027-09-10T08:00:00Z'),
      ],
    })
    const { corpo } = await chiedi()
    expect((corpo.data as Array<{ alunno_id: string }>).map((d) => d.alunno_id)).toEqual([FIGLIO_1])
  })

  it('il fascicolo si legge solo per i candidati: quello degli altri non consuma il tetto di righe del server', async () => {
    // Il tetto è quello vero di PostgREST (`max_rows`). Senza il filtro la lettura si fermerebbe sui due
    // documenti altrui, e la firma di FIGLIO_1 non arriverebbe mai.
    preparaDb(
      {
        anni_sede: [annoDiSede(SEDE_A, 2026, 'chiuso'), annoDiSede(SEDE_A, 2027, 'corrente')],
        frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)],
        student_documents: [
          documento(ALTRUI, 'delega_ritiro', '2026-09-10T08:00:00Z'),
          documento(ALTRUI, 'dieta_speciale', '2026-09-11T08:00:00Z'),
          documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z'),
        ],
      },
      {},
      2,
    )
    const { corpo } = await chiedi()
    expect((corpo.data as Array<{ alunno_id: string }>).map((d) => d.alunno_id)).toEqual([FIGLIO_1])
  })

  it('un trasferito: la frequenza dell’altra sede conta, e vale il calendario della sede di oggi', async () => {
    h.figli.righe = [figlio(FIGLIO_1, SEDE_B)]
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)],
      student_documents: [documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z')],
    })
    const { corpo } = await chiedi()
    expect((corpo.data as unknown[]).length).toBe(1)
  })

  it('il successo porta il conteggio dei moduli, mai una data o uno slug', async () => {
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)],
      student_documents: [documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z')],
    })
    await chiedi()
    expect(righeDiLog('info')).toContainEqual(
      expect.objectContaining({ operazione: OP, esito: 'da-rifirmare-calcolato', n: 1 }),
    )
  })
})

describe('il database della CI, che non ha lo schema dell’anno', () => {
  it.each(['PGRST205', '42P01', '42703'])('`frequenze` assente (%s): lista vuota, un log info, nessun errore', async (code) => {
    preparaDb({ anni_sede: ANNI_DOPO }, { frequenze: { code } })
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
    expect(righeDiLog('error')).toEqual([])
    expect(righeDiLog('info')).toContainEqual(expect.objectContaining({ tipo: 'frequenze-non-disponibili' }))
  })

  it('`anni_sede` assente: quella sede non ha anni, e non è un guasto', async () => {
    preparaDb(
      { frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)] },
      { anni_sede: { code: 'PGRST205' } },
    )
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
    expect(righeDiLog('error')).toEqual([])
  })
})

describe('un guasto non diventa «niente da rifirmare»', () => {
  const guasto = { status: 500, codice: 'LETTURA_FALLITA' }
  const esito = ({ status, corpo }: { status: number; corpo: Record<string, unknown> }) => ({ status, codice: corpo.codice })

  it('i figli non letti: 500', async () => {
    h.figli = { righe: [], totaleLegami: 1, nascosti: {}, completo: false, errore: { code: '57014' } }
    expect(esito(await chiedi())).toEqual(guasto)
  })

  it('l’elenco dei legami incompleto: 500, perché potrebbe mancare proprio il figlio da rifirmare', async () => {
    h.figli = { righe: [figlio(FIGLIO_1)], totaleLegami: 1, nascosti: {}, completo: false, errore: null }
    expect(esito(await chiedi())).toEqual(guasto)
  })

  it('le frequenze non lette: 500 con il suo log d’errore', async () => {
    preparaDb({ anni_sede: ANNI_DOPO }, { frequenze: { code: '57014' } })
    expect(esito(await chiedi())).toEqual(guasto)
    expect(righeDiLog('error')).toContainEqual(
      expect.objectContaining({ operazione: OP, esito: 'frequenze-non-lette', error_code: '57014' }),
    )
  })

  it('il calendario non letto: 500', async () => {
    preparaDb({ frequenze: [frequenza(FIGLIO_1, 2026)] }, { anni_sede: { code: '57014' } })
    expect(esito(await chiedi())).toEqual(guasto)
  })

  it('il fascicolo non letto: 500 con il suo log d’errore', async () => {
    preparaDb(
      { anni_sede: ANNI_DOPO, frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)] },
      { student_documents: { code: '57014' } },
    )
    expect(esito(await chiedi())).toEqual(guasto)
    expect(righeDiLog('error')).toContainEqual(
      expect.objectContaining({ operazione: OP, esito: 'fascicolo-non-letto', error_code: '57014' }),
    )
  })
})

describe('i casi di bordo', () => {
  it('un figlio senza sede si ignora, e l’altro risponde', async () => {
    h.figli.righe = [figlio(FIGLIO_2, null), figlio(FIGLIO_1)]
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027), frequenza(FIGLIO_2, 2026)],
      student_documents: [
        documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z'),
        documento(FIGLIO_2, 'delega_ritiro', '2026-10-10T08:00:00Z'),
      ],
    })
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect((corpo.data as Array<{ alunno_id: string }>).map((d) => d.alunno_id)).toEqual([FIGLIO_1])
  })
})

describe('lo spostamento dell’anno attivo (compito 4.8.6)', () => {
  const FIRME = [documento(FIGLIO_1, 'delega_ritiro', '2026-10-10T08:00:00Z')]
  const FREQUENZE = [frequenza(FIGLIO_1, 2026), frequenza(FIGLIO_1, 2027)]

  it('un modulo annuale firmato nell’anno vecchio compare dopo lo spostamento dell’anno attivo, e prima no', async () => {
    preparaDb({ anni_sede: ANNI_OGGI, frequenze: FREQUENZE, student_documents: FIRME })
    const prima = await chiedi()
    expect(prima.corpo).toEqual({ success: true, data: [], totale: 0 })

    preparaDb({ anni_sede: ANNI_DOPO, frequenze: FREQUENZE, student_documents: FIRME })
    const dopo = await chiedi()
    expect(dopo.corpo).toEqual({
      success: true,
      totale: 1,
      data: [
        {
          alunno_id: FIGLIO_1,
          moduli: [{ slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-10-10' }],
        },
      ],
    })
  })

  it('un sanitario non compare: vale fino a revoca, anche se è l’unica firma dell’anno vecchio', async () => {
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: FREQUENZE,
      student_documents: [
        documento(FIGLIO_1, 'scheda_sanitaria', '2026-10-10T08:00:00Z'),
        documento(FIGLIO_1, 'autorizzazione_farmaci', '2026-10-10T08:00:00Z'),
        documento(FIGLIO_1, 'dieta_speciale', '2026-10-10T08:00:00Z'),
      ],
    })
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
  })

  it('oltre il tetto: i primi 20 (i più vecchi) più il totale vero', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `11111111-1111-4111-8111-1111111111${String(i).padStart(2, '0')}`)
    h.figli.righe = ids.map((id) => figlio(id))
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: ids.flatMap((id) => [frequenza(id, 2026), frequenza(id, 2027)]),
      // il figlio i firma il giorno 30 - i: chi sta in fondo all'elenco è il più vecchio
      student_documents: ids.map((id, i) => documento(id, 'delega_ritiro', `2026-10-${String(30 - i).padStart(2, '0')}T08:00:00Z`)),
    })
    const { status, corpo } = await chiedi()
    const data = corpo.data as Array<{ alunno_id: string; moduli: unknown[] }>
    expect(status).toBe(200)
    expect(corpo.totale).toBe(25)
    expect(data.flatMap((d) => d.moduli)).toHaveLength(20)
    expect(data[0].alunno_id).toBe(ids[24])
    expect(data.map((d) => d.alunno_id)).not.toContain(ids[0])
    expect(righeDiLog('info')).toContainEqual(expect.objectContaining({ esito: 'da-rifirmare-calcolato', n: 25 }))
  })

  it('schema indietro: nessun modulo e nessun totale, senza errori', async () => {
    preparaDb({ anni_sede: ANNI_DOPO }, { frequenze: { code: 'PGRST205' } })
    const { status, corpo } = await chiedi()
    expect(status).toBe(200)
    expect(corpo).toEqual({ success: true, data: [], totale: 0 })
    expect(righeDiLog('error')).toEqual([])
  })

  it('un genitore vede solo i propri figli: le firme di un bambino altrui non entrano mai', async () => {
    h.figli.righe = [figlio(FIGLIO_1)]
    preparaDb({
      anni_sede: ANNI_DOPO,
      frequenze: [...FREQUENZE, frequenza(ALTRUI, 2026), frequenza(ALTRUI, 2027)],
      student_documents: [...FIRME, documento(ALTRUI, 'delega_ritiro', '2026-09-02T08:00:00Z')],
    })
    const { corpo } = await chiedi()
    expect((corpo.data as Array<{ alunno_id: string }>).map((d) => d.alunno_id)).toEqual([FIGLIO_1])
    expect(corpo.totale).toBe(1)
    expect(h.portate).toEqual([FIGLIO_1])
  })
})
