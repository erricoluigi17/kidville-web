import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * PR 4.5 · COMPITO 4.5.8 · l'import massivo (`eseguiDomanda` / `alunnoDiRiferimento`) con una domanda per l'ANNO PROSSIMO usa lo
 * stesso ramo della route: il bambino nuovo nasce `in_arrivo` senza classe né retta, uno che esiste non cambia classe né
 * retta (solo se torna da fuori diventa `in_arrivo`), e la classe scelta e la retta stanno nella frequenza dell'anno aperto.
 * Il client finto REGISTRA le scritture; le funzioni SQL dell'anno sono finte che registrano gli argomenti.
 */

const DOMANDA = 'd1d1d1d1-0000-4000-8000-000000000001'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const CF = 'XQQYKV19C07Z999T'
const ANNO_OGGI = '11110000-0000-4000-8000-000000000001'
const ANNO_2027 = '22220000-0000-4000-8000-000000000002'
const ANNO_SEDE_OGGI = '5555aaaa-0000-4000-8000-000000000001'
const ANNO_SEDE_2027 = '5555bbbb-0000-4000-8000-000000000002'
const SEZ_OGGI = '77770000-0000-4000-8000-000000000001'
const SEZ_2027 = '77770000-0000-4000-8000-000000000002'
const COLONNE_DI_OGGI = ['classe_sezione', 'section_id', 'importo_retta_mensile', 'giorno_scadenza_pagamenti', 'intestatario_fatture']

const h = vi.hoisted(() => ({
  invitaGenitore: vi.fn(),
  agganciaDaImport: vi.fn(),
  rpc: [] as { nome: string; args: Record<string, unknown> }[],
}))

vi.mock('@/lib/crm/aggancio-alunno', () => ({ agganciaDaImport: (...a: unknown[]) => h.agganciaDaImport(...a) }))
vi.mock('@/lib/iscrizioni/import/inviti', async (orig) => {
  const m = await orig<typeof import('@/lib/iscrizioni/import/inviti')>()
  return { ...m, invitaGenitore: (...a: unknown[]) => h.invitaGenitore(...a) }
})
vi.mock('@/lib/auth/parent-identity', () => ({ findAuthUserIdByEmail: async () => null }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: vi.fn(async () => undefined) }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: vi.fn(async () => undefined) }))

import { eseguiDomanda } from '@/lib/iscrizioni/import/esegui'
import type { AssegnazioneBambino, Domanda } from '@/lib/iscrizioni/import/analisi'

const domanda: Domanda = { id: DOMANDA, scuolaId: SEDE_A, creataIl: '2026-10-01T09:00:00Z', bambini: [], adulti: [] }
const figlio = (nome: string, over: Record<string, unknown> = {}) => ({ nome, cognome: 'Prova', data_nascita: '2024-03-05', ...over })
const datiCon = (children: unknown[]) => ({
  children,
  adults: [{ first_name: 'Genitore', last_name: 'Prova', email: 'genitore@example.test', ruolo: 'madre' }],
})
const assegna = (indice: number, nome: string, over: Partial<AssegnazioneBambino> = {}): AssegnazioneBambino => ({
  indice, nome, cognome: 'Prova', classe: '4 ANNI A', retta: 150, aCaricoDi: null, ...over,
})

let db: DBFinto
let scritture: Scrittura[]
let rpcRegistra: ((args: Record<string, unknown>) => { data: unknown; error: unknown }) | null

function client(opts: { annoDomanda?: string | null; alunni?: Riga[]; anni?: Riga[]; errori?: Record<string, { code: string; message?: string }> } = {}) {
  scritture = []
  db = {
    sections: [
      { id: SEZ_OGGI, scuola_id: SEDE_A, name: '4 ANNI A', anno_id: ANNO_OGGI },
      { id: SEZ_2027, scuola_id: SEDE_A, name: '4 ANNI A', anno_id: ANNO_2027 },
    ],
    anni_sede: opts.anni ?? [
      { id: ANNO_SEDE_OGGI, scuola_id: SEDE_A, anno_id: ANNO_OGGI, stato: 'corrente', domande_aperte: false },
      { id: ANNO_SEDE_2027, scuola_id: SEDE_A, anno_id: ANNO_2027, stato: 'iscrizioni_aperte', domande_aperte: true },
    ],
    alunni: opts.alunni ?? [],
    parents: [],
    student_parents: [],
    legame_genitori_alunni: [],
    frequenze: [],
    enrollment_submissions: [{ id: DOMANDA, scuola_id: SEDE_A, consents_log: null, anno_id: opts.annoDomanda === undefined ? ANNO_2027 : opts.annoDomanda }],
  }
  const ok = async () => ({ data: null, error: null })
  return creaFintoSupabase(db, [], {
    scritture,
    errori: opts.errori,
    rpc: {
      iscrizioni_segna_creato: ok, iscrizioni_chiudi: ok, iscrizioni_annulla: ok, iscrizioni_rinvia: ok,
      anno_attivo: () => ({ data: ANNO_SEDE_OGGI, error: null }),
      anno_registra_frequenza: (args) => {
        h.rpc.push({ nome: 'anno_registra_frequenza', args })
        if (rpcRegistra) return rpcRegistra(args)
        return { data: { frequenza_id: `freq-${h.rpc.length}`, creata: true, quota: 'creata', pagamento_id: null, posti_oltre: false }, error: null }
      },
    },
  })
}

const registrazioni = () => h.rpc.filter((r) => r.nome === 'anno_registra_frequenza').map((r) => r.args)
const sulleTabelle = (tabella: string, operazione?: string) =>
  scritture.filter((s) => s.tabella === tabella && (!operazione || s.operazione === operazione))
const scrittureDiOggiSuAlunni = () =>
  sulleTabelle('alunni')
    .filter((s) => s.operazione === 'insert' || s.operazione === 'update')
    .flatMap((s) => s.valori)
    .filter((v) => COLONNE_DI_OGGI.some((c) => v[c] !== undefined && v[c] !== null))

beforeEach(() => {
  vi.clearAllMocks()
  h.rpc = []
  rpcRegistra = null
  h.invitaGenitore.mockResolvedValue({ tipo: 'inviata', authUserId: 'auth-1', messageId: 'm-1' })
  h.agganciaDaImport.mockResolvedValue({ esito: 'fatto', agganciati: 1 })
})

describe('eseguiDomanda · domanda per l’anno PROSSIMO', () => {
  it('bambino nuovo: in_arrivo, nessuna classe né retta di oggi; la frequenza ha la sezione dell’anno aperto e la retta', async () => {
    const esito = await eseguiDomanda(client(), domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    const [creato] = db.alunni as Riga[]
    expect(creato.stato).toBe('in_arrivo')
    expect(scrittureDiOggiSuAlunni()).toEqual([])
    expect(sulleTabelle('alunni', 'update')).toEqual([])
    expect(sulleTabelle('frequenze')).toEqual([])
    expect(registrazioni()).toEqual([{
      p_alunno: creato.id,
      p_anno_sede: ANNO_SEDE_2027,
      p_tipo: 'nuova',
      p_origine: 'domanda',
      p_domanda: DOMANDA,
      p_section: SEZ_2027,
      p_data_ingresso: null,
      p_campi: { retta_mensile: 150 },
    }])
  })

  it('«la paga il fratello»: il collegamento sta nella frequenza, nessun UPDATE di alunni', async () => {
    const dati = datiCon([figlio('Bimbo'), figlio('Bimba', { data_nascita: '2023-01-02' })])
    await eseguiDomanda(client(), domanda, dati, [assegna(0, 'Bimbo'), assegna(1, 'Bimba', { retta: 0, aCaricoDi: 'Prova Bimbo' })], SEDE_A)
    const [bimbo, bimba] = db.alunni as Riga[]
    const [r0, r1] = registrazioni()
    expect(r0.p_alunno).toBe(bimbo.id)
    expect(r1.p_alunno).toBe(bimba.id)
    expect(r1.p_campi).toEqual({ retta_mensile: null, retta_a_carico_di: bimbo.id })
    expect(sulleTabelle('alunni', 'update')).toEqual([])
  })

  it('bambino vivo oggi: nessuna scrittura su alunni, solo la frequenza dell’anno dopo', async () => {
    const esistente = { id: ESISTENTE, scuola_id: SEDE_A, codice_fiscale: CF, stato: 'iscritto', archiviato_il: null, classe_sezione: '3 ANNI', section_id: 'sez-oggi', importo_retta_mensile: 250, allergies: null, note_mediche: null }
    const dati = datiCon([figlio('Bimbo', { codice_fiscale: CF })])
    const esito = await eseguiDomanda(client({ alunni: [esistente] }), domanda, dati, [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    expect(sulleTabelle('alunni')).toEqual([])
    expect(db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '3 ANNI', importo_retta_mensile: 250 })
    expect(registrazioni()).toHaveLength(1)
    expect(registrazioni()[0]).toMatchObject({ p_alunno: ESISTENTE, p_anno_sede: ANNO_SEDE_2027, p_section: SEZ_2027 })
  })

  it('bambino ritirato che torna: in_arrivo, non archiviato, senza sezione né classe (la retta di oggi resta)', async () => {
    const esistente = { id: ESISTENTE, scuola_id: SEDE_A, codice_fiscale: CF, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z', classe_sezione: '3 ANNI', section_id: 'sez-oggi', importo_retta_mensile: 250, allergies: null, note_mediche: null }
    const dati = datiCon([figlio('Bimbo', { codice_fiscale: CF })])
    await eseguiDomanda(client({ alunni: [esistente] }), domanda, dati, [assegna(0, 'Bimbo')], SEDE_A)
    expect(db.alunni[0]).toMatchObject({ stato: 'in_arrivo', archiviato_il: null, section_id: null, classe_sezione: null, importo_retta_mensile: 250 })
    expect(registrazioni()).toHaveLength(1)
  })

  it('anno non aperto: nessuna scrittura, la domanda è annullata', async () => {
    const anni = [
      { id: ANNO_SEDE_OGGI, scuola_id: SEDE_A, anno_id: ANNO_OGGI, stato: 'corrente', domande_aperte: false },
      { id: ANNO_SEDE_2027, scuola_id: SEDE_A, anno_id: ANNO_2027, stato: 'in_preparazione', domande_aperte: false },
    ]
    const esito = await eseguiDomanda(client({ anni }), domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('errore')
    expect(scritture.filter((s) => s.tabella !== 'enrollment_submissions')).toEqual([])
    expect(registrazioni()).toEqual([])
    expect(h.invitaGenitore).not.toHaveBeenCalled()
  })

  it('la funzione che registra fallisce con un codice dell’anno: la domanda è annullata e non parte l’invito', async () => {
    rpcRegistra = () => ({ data: null, error: { code: 'P0001', message: 'ANNO_NON_APERTO' } })
    const esito = await eseguiDomanda(client(), domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('errore')
    expect(h.invitaGenitore).not.toHaveBeenCalled()
  })
})

describe('eseguiDomanda · il percorso di oggi non cambia', () => {
  it('anno della domanda = anno attivo: classe e retta di oggi, nessuna frequenza dell’anno dopo', async () => {
    const esito = await eseguiDomanda(client({ annoDomanda: ANNO_OGGI }), domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    expect(db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '4 ANNI A', importo_retta_mensile: 150 })
    expect(registrazioni()).toEqual([])
  })

  it('anno_id assente: il percorso di oggi', async () => {
    const esito = await eseguiDomanda(client({ annoDomanda: null }), domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    expect(db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '4 ANNI A', importo_retta_mensile: 150 })
    expect(registrazioni()).toEqual([])
  })
})

describe('eseguiDomanda · la lettura di anno_id cade (revisione, giro 1)', () => {
  const senzaScritture = () => {
    expect(scritture.filter((s) => s.tabella !== 'enrollment_submissions')).toEqual([])
    expect(sulleTabelle('alunni')).toEqual([])
    expect(registrazioni()).toEqual([])
    expect(h.invitaGenitore).not.toHaveBeenCalled()
  }

  it('errore NON di schema (timeout, permessi): la domanda 2027 fallisce, zero scritture su alunni', async () => {
    const c = client({ errori: { enrollment_submissions: { code: '57014', message: 'timeout' } } })
    const esito = await eseguiDomanda(c, domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('errore')
    senzaScritture()
  })

  it('eccezione durante la lettura: è un guasto, non un ripiego — zero scritture su alunni', async () => {
    const c = client()
    const vero = c.from.bind(c)
    ;(c as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'enrollment_submissions') throw new Error('rete caduta')
      return vero(t)
    }
    const esito = await eseguiDomanda(c, domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('errore')
    senzaScritture()
  })

  it('colonna anno_id assente (schema indietro, PGRST204): il percorso di oggi resta com\'è', async () => {
    const c = client({ errori: { enrollment_submissions: { code: 'PGRST204', message: 'colonna assente' } } })
    const esito = await eseguiDomanda(c, domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    expect(db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '4 ANNI A', importo_retta_mensile: 150 })
    expect(registrazioni()).toEqual([])
  })

  it('domanda inesistente (data nulla): il percorso di oggi', async () => {
    const c = client()
    db.enrollment_submissions = []
    const esito = await eseguiDomanda(c, domanda, datiCon([figlio('Bimbo')]), [assegna(0, 'Bimbo')], SEDE_A)
    expect(esito.esito).toBe('inviata')
    expect(registrazioni()).toEqual([])
  })
})
