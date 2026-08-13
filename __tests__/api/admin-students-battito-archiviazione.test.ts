import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// IL BATTITO DI SUCCESSO DELLE DUE METÀ DEL MODELLO — e perché ha un file suo.
//
// ─── COSA HA MISURATO LA REVISIONE, ED ERA VERO ──────────────────────────────
// Rimuovendo l'intero blocco `logEvento('gdpr','info',{ azione:'alunno-archiviato', … })`
// da `admin/students/archivia:POST`, `admin-students-archivia.test.ts` e tutta
// `__tests__/architecture` restavano VERDI. Le route argomentano per diciannove
// righe che quel battito è ciò che distingue «non ha archiviato nessuno» da
// «l'archiviazione non parte più» — citando il guasto delle email di credenziali,
// che è la regola 5 di AGENTS.md — e nei due file di prova non c'era un solo
// riferimento a `logEvento`. Una promessa argomentata e non difesa: esattamente
// la forma di difetto che questo repo ha già pagato.
//
// ─── PERCHÉ UN FILE A PARTE, E NON DUE RIGHE NEGLI ALTRI DUE ─────────────────
// Perché il battito richiede di MOCKARE il logger, e i due file esistenti
// misurano l'effetto sul database con il logger VERO: mescolare le due cose
// vorrebbe dire far dipendere ogni asserzione sullo stato della riga da un mock
// che non c'entra. Qui il logger è finto e il database è quello vero del fixture,
// così ogni test dice una cosa sola.
//
// ─── PERCHÉ È COMPORTAMENTALE E NON UN LOCK SUL SORGENTE ────────────────────
// Un lock che cerca `logEvento('gdpr','info'` nel testo del file proverebbe che
// la RIGA è scritta, non che venga ESEGUITA: sopravviverebbe a un `return`
// anticipato, a un ramo che la salta o a un `if` che non è mai vero. Qui la route
// gira davvero e il battito si conta all'uscita — che è la domanda vera
// («l'archiviazione ha lasciato una traccia?»), non la sua ombra nel sorgente.
//
// ⚠️ `importOriginal`: si sostituisce SOLO `logEvento`. `withRoute` importa dallo
// stesso modulo (`logErrore`, `logOk`, oltre a `logEvento`), e un mock che
// rimpiazza il modulo intero lascerebbe quei tre `undefined` — la route
// esploderebbe prima di arrivare al punto, e il test sarebbe rosso per la ragione
// sbagliata.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const opzioni = () => ({ scritture: h.scritture as Scrittura[], errori: h.errori })
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
  }
})

import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { POST as RIATTIVA } from '@/app/api/admin/students/riattiva/route'

const post = (percorso: string) => (body: unknown) =>
  new NextRequest(`http://localhost/api/admin/students/${percorso}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const archivia = post('archivia')
const riattiva = post('riattiva')

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  utenti_sezioni: [],
  sections: [{ id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' }],
  alunni: [
    {
      id: ALU_A,
      nome: 'Alfa',
      cognome: 'AaaSedeA',
      scuola_id: SEDE_A,
      section_id: SEC_A,
      classe_sezione: '2 ANNI',
      gruppo_mensa_id: null,
      stato: 'iscritto',
      note_mediche: 'NOTA-MEDICA-A',
      codice_fiscale: 'CODICEFINTO00001',
      archiviato_il: null,
      archiviato_da: null,
      archiviato_motivo: null,
      archiviato_section_id: null,
      archiviato_classe_sezione: null,
      spazio_liberato_il: null,
    },
  ],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

/** Il bambino, già archiviato: è il punto di partenza del ritorno. */
const archiviaLaRiga = () => {
  const a = h.db.alunni[0]
  a.stato = 'ritirato'
  a.section_id = null
  a.classe_sezione = null
  a.archiviato_il = '2026-08-01T10:00:00.000Z'
  a.archiviato_section_id = SEC_A
  a.archiviato_classe_sezione = '2 ANNI'
}

/** Le chiamate a `logEvento` con quel canale e quel livello, già spacchettate. */
const battiti = (canale: string, livello: string): Record<string, unknown>[] =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === canale && c[1] === livello)
    .map((c) => (c[2] ?? {}) as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('admin/students/archivia:POST — il battito di successo', () => {
  it('il ramo felice LOGGA il successo: senza, «nessun log» non distingue «nessuno archiviato» da «non parte più»', async () => {
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A, motivo: 'trasferimento' }))
    expect(res.status).toBe(200)

    const battito = battiti('gdpr', 'info').find((c) => c.azione === 'alunno-archiviato')
    expect(
      battito,
      'il ramo felice di `archivia` non lascia nessuna traccia: è l\'ambiguità che ha tenuto ' +
      'nascosto per mesi il guasto delle email di credenziali (AGENTS.md, regola 5).',
    ).toBeDefined()
    expect(battito?.operazione).toBe('admin/students/archivia:POST')
    expect(battito?.esito).toBe('archiviato')
    expect(battito?.alunno).toBe(ALU_A)
  })

  it('⚠️ il canale è `gdpr`, che è PERSISTITO: su un canale in deroga il successo non arriverebbe in `app_log`', async () => {
    // La scorciatoia sarebbe stata `anagrafica`, che sta in
    // `DEROGHE_INFO_NON_PERSISTITI`: il battito esisterebbe nel codice e NON
    // sarebbe interrogabile in SQL, cioè sarebbe inutile proprio quando serve.
    const { EVENTI_PERSISTITI } = await import('@/lib/logging/logger')
    await ARCHIVIA(archivia({ alunno_id: ALU_A }))

    const canali = h.logEvento.mock.calls.filter((c) => c[1] === 'info').map((c) => c[0] as string)
    expect(canali).toContain('gdpr')
    for (const canale of canali) expect(EVENTI_PERSISTITI.has(canale), `«${canale}» non è persistito`).toBe(true)
  })

  it('nel battito non finisce NIENTE che nomini il bambino', async () => {
    await ARCHIVIA(archivia({ alunno_id: ALU_A, motivo: 'ritiro' }))

    const serializzato = JSON.stringify(h.logEvento.mock.calls)
    expect(serializzato).not.toContain('NOTA-MEDICA-A')
    expect(serializzato).not.toContain('CODICEFINTO00001')
    expect(serializzato).not.toContain('AaaSedeA')
    // `sezione` è in lista bianca (è il nome di una classe, non di una persona).
    expect(battiti('gdpr', 'info').find((c) => c.azione === 'alunno-archiviato')?.sezione).toBe('2 ANNI')
  })

  it('il RIFIUTO non conta come successo: sul 409 il battito del ramo felice non c\'è', async () => {
    // Il controllo negativo del primo test: senza, un `logEvento` messo in cima
    // alla route lo soddisfarebbe, e conterebbe come «archiviato» anche un
    // tentativo respinto — cioè un contatore che mente al rialzo.
    archiviaLaRiga()

    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A }))

    expect(res.status).toBe(409)
    expect(battiti('gdpr', 'info').find((c) => c.azione === 'alunno-archiviato')).toBeUndefined()
    expect(battiti('gdpr', 'info').map((c) => c.esito)).toContain('gia-archiviato')
  })
})

describe('admin/students/riattiva:POST — il battito di successo', () => {
  it('il ramo felice LOGGA il ritorno, sullo stesso canale: le due metà si contano con una query sola', async () => {
    archiviaLaRiga()

    const res = await RIATTIVA(riattiva({ alunno_id: ALU_A }))
    expect(res.status).toBe(200)

    const battito = battiti('gdpr', 'info').find((c) => c.azione === 'alunno-riattivato')
    expect(battito, 'il ritorno fra gli iscritti non lascia nessuna traccia').toBeDefined()
    expect(battito?.operazione).toBe('admin/students/riattiva:POST')
    expect(battito?.alunno).toBe(ALU_A)
  })

  it('⚠️ l\'`esito` del battito dice la VERITÀ sulla classe, e non «senza classe» a chi ce l\'ha', async () => {
    // Il rilievo che ha aperto questo test: il ritiro a mano dalla tendina
    // (`stato='ritirato'`, la classe ANCORA addosso) usciva con
    // `esito: 'riattivato-senza-classe'`, quindi anche la traccia in `app_log`
    // diceva il falso. Un log che mente è peggio di un log che manca: il primo
    // lo si crede.
    const a = h.db.alunni[0]
    a.stato = 'ritirato' // niente `archiviato_*`: non è mai passato dall'archiviazione

    const res = await RIATTIVA(riattiva({ alunno_id: ALU_A }))
    expect(res.status).toBe(200)

    const battito = battiti('gdpr', 'info').find((c) => c.azione === 'alunno-riattivato')
    expect(battito?.esito).toBe('riattivato-classe-conservata')
    expect(battito?.sezione).toBe('2 ANNI')
  })

  it('il RIFIUTO non conta come successo: sul 409 il battito del ramo felice non c\'è', async () => {
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_A })) // è ancora iscritto

    expect(res.status).toBe(409)
    expect(battiti('gdpr', 'info').find((c) => c.azione === 'alunno-riattivato')).toBeUndefined()
  })
})
