import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { eInArrivo } from '@/lib/alunni/stato'

/**
 * PR 4.5 · COMPITO 4.5.8 · approvare una domanda per l'ANNO PROSSIMO (`PATCH /api/admin/iscrizioni`, azione `import`) e
 * spostarla di anno (`POST /api/admin/iscrizioni/sposta-anno`).
 *
 * Il client finto APPLICA le scritture e le REGISTRA (`h.scritture`), e le due funzioni SQL dell'anno (`anno_attivo`,
 * `anno_registra_frequenza`) sono finte che registrano gli argomenti con cui sono chiamate (`h.rpc`): le asserzioni guardano
 * CHE COSA è stato scritto, non che una funzione sia stata chiamata. Il codice vero di `annoDellaDomanda` e
 * `registraFrequenzaPerAnno` gira.
 *
 * Regola di fondo: una domanda 2027/28 approvata NON tocca un dato dell'anno in corso — né `classe_sezione`, né `section_id`,
 * né la retta di oggi, né il giorno di scadenza, né l'intestatario. La domanda dell'anno di oggi si comporta come ieri
 * (le suite `anno-iscrizioni-frequenze`, `iscrizioni-import-*` lo provano senza essere state toccate).
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  rpc: [] as { nome: string; args: Record<string, unknown> }[],
  /** Cosa risponde `anno_registra_frequenza`: di serie, una frequenza nuova. */
  registra: null as null | ((args: Record<string, unknown>) => { data: unknown; error: unknown }),
  /** Cosa risponde `anno_attivo`. */
  annoAttivo: null as null | { data: unknown; error: unknown },
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  inviaEmail: vi.fn(),
  scuoleDiUtente: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: h.inviaEmail,
}))
vi.mock('@/lib/email/contesto', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/email/contesto')>()
  return { ...vero, risolviContestoSede: async () => vero.contestoSenzaSede('Sede di prova') }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: h.scuoleDiUtente,
  assertAlunnoInScope: h.assertAlunnoInScope,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, [], {
      scritture: h.scritture as Scrittura[],
      errori: h.errori,
      rpc: {
        anno_attivo: (args) => {
          h.rpc.push({ nome: 'anno_attivo', args })
          return h.annoAttivo ?? { data: ANNO_SEDE_OGGI, error: null }
        },
        anno_registra_frequenza: (args) => {
          h.rpc.push({ nome: 'anno_registra_frequenza', args })
          if (h.registra) return h.registra(args)
          // di serie: la frequenza nasce (come nel database vero: dalla funzione, non da una scrittura della route)
          const f = { id: `freq-${h.rpc.length}`, alunno_id: args.p_alunno, anno_sede_id: args.p_anno_sede, stato: 'in_attesa' }
          ;(h.db.frequenze ??= []).push(f)
          return { data: { frequenza_id: f.id, creata: true, quota: 'creata', pagamento_id: 'pag-1', posti_oltre: false }, error: null }
        },
      },
    }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'
import { POST as SPOSTA } from '@/app/api/admin/iscrizioni/sposta-anno/route'

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const DOMANDA = 'f0f0f0f0-0000-4000-8000-000000000010'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const ACCOUNT = 'e5e5e5e5-0000-4000-8000-000000000006'
// gli anni: `anni_scolastici.id` (quello della domanda) e `anni_sede.id` (quello della sede)
const ANNO_OGGI = '11110000-0000-4000-8000-000000000001'
const ANNO_2027 = '22220000-0000-4000-8000-000000000002'
const ANNO_CHIUSO = '33330000-0000-4000-8000-000000000003'
const ANNO_SEDE_OGGI = '5555aaaa-0000-4000-8000-000000000001'
const ANNO_SEDE_2027 = '5555bbbb-0000-4000-8000-000000000002'
const ANNO_SEDE_CHIUSO = '5555cccc-0000-4000-8000-000000000003'
const SEZ_OGGI = '77770000-0000-4000-8000-000000000001'
const SEZ_2027 = '77770000-0000-4000-8000-000000000002'

/** Le colonne che dicono «la classe di oggi»: una domanda 2027 non ne scrive nessuna. */
const COLONNE_DI_OGGI = ['classe_sezione', 'section_id', 'importo_retta_mensile', 'giorno_scadenza_pagamenti', 'intestatario_fatture']

const bambino = (nome: string, over: Record<string, unknown> = {}) => ({
  nome, cognome: 'Prova', data_nascita: nome === 'Mario' ? '2024-03-07' : '2024-04-08', ...over,
})
const adulto = {
  first_name: 'Anna', last_name: 'Bianchi', birth_date: '1985-06-10', fiscal_code: 'XQQYKV85H50Z999J',
  email: 'anna@example.test', ruolo: 'mother',
}
const domanda = (children: unknown[], over: Record<string, unknown> = {}) => ({
  id: DOMANDA, scuola_id: SEDE, status: 'pending', consents_log: null, anno_id: ANNO_2027,
  data: { children, adults: [adulto] }, ...over,
})

const importa = (extra: Record<string, unknown>) =>
  PATCH(new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: DOMANDA, action: 'import', referenteIndex: 0, ...extra }),
  }) as never)

const sposta = (corpo: Record<string, unknown>) =>
  SPOSTA(new Request('http://localhost/api/admin/iscrizioni/sposta-anno', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }) as never)

const sulleTabelle = (tabella: string, operazione?: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && (!operazione || s.operazione === operazione))
const registrazioni = () => h.rpc.filter((r) => r.nome === 'anno_registra_frequenza').map((r) => r.args)
/** Ogni valore scritto in `alunni` (insert e update) con una delle colonne «di oggi» valorizzata. */
const scrittureDiOggiSuAlunni = () =>
  sulleTabelle('alunni')
    .filter((s) => s.operazione === 'insert' || s.operazione === 'update')
    .flatMap((s) => s.valori)
    .filter((v) => COLONNE_DI_OGGI.some((c) => v[c] !== undefined && v[c] !== null))

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.errori = {}
  h.rpc = []
  h.registra = null
  h.annoAttivo = null
  h.db = {
    enrollment_submissions: [domanda([bambino('Mario')])],
    anni_sede: [
      { id: ANNO_SEDE_OGGI, scuola_id: SEDE, anno_id: ANNO_OGGI, stato: 'corrente', domande_aperte: false },
      { id: ANNO_SEDE_2027, scuola_id: SEDE, anno_id: ANNO_2027, stato: 'iscrizioni_aperte', domande_aperte: true },
      { id: ANNO_SEDE_CHIUSO, scuola_id: SEDE, anno_id: ANNO_CHIUSO, stato: 'in_preparazione', domande_aperte: false },
    ],
    sections: [
      { id: SEZ_OGGI, scuola_id: SEDE, name: '3 ANNI', anno_id: ANNO_OGGI },
      { id: SEZ_2027, scuola_id: SEDE, name: '3 ANNI', anno_id: ANNO_2027 },
    ],
    alunni: [],
    parents: [],
    frequenze: [],
  }
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.inviaEmail.mockResolvedValue({ ok: true, error: null })
  h.ensureParentIdentity.mockImplementation(async (_s: unknown, p: { emails: string[] }) => ({
    ok: true, authUserId: ACCOUNT, email: p.emails[0], createdAuth: true, createdUtenti: true, boundNow: true, password: 'Provvisoria-1',
  }))
})

describe('domanda per l’anno PROSSIMO — bambino NUOVO', () => {
  it('nessun UPDATE o INSERT di alunni porta la classe, la sezione, la retta, il giorno o l’intestatario di oggi', async () => {
    const json = await (await importa({
      assignments: { '0': '3 ANNI' }, rette: { '0': 300 }, giorniScadenza: { '0': 5 }, intestatari: { '0': 0 },
    })).json()
    expect(json.success).toBe(true)
    expect(sulleTabelle('alunni', 'insert')).toHaveLength(1)
    expect(scrittureDiOggiSuAlunni()).toEqual([])
    expect(sulleTabelle('alunni', 'update')).toEqual([])
  })

  it('il bambino nuovo nasce in_arrivo', async () => {
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    const [creato] = h.db.alunni
    expect(creato.stato).toBe('in_arrivo')
    expect(eInArrivo(creato.stato as string)).toBe(true)
    expect(creato.classe_sezione).toBeUndefined()
  })

  it('nessuna frequenza dell’anno attivo è creata o cambiata', async () => {
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    expect(sulleTabelle('frequenze')).toEqual([])
    expect(registrazioni().every((r) => r.p_anno_sede === ANNO_SEDE_2027)).toBe(true)
    expect(h.db.frequenze.every((f) => f.anno_sede_id !== ANNO_SEDE_OGGI)).toBe(true)
  })

  it('la frequenza nuova ha la sezione scelta (dell’anno aperto), la domanda e i campi economici', async () => {
    await importa({
      assignments: { '0': '3 ANNI' }, rette: { '0': 300 }, giorniScadenza: { '0': 5 }, intestatari: { '0': 0 },
    })
    const [creato] = h.db.alunni
    const adultoId = h.db.parents[0].id
    expect(registrazioni()).toEqual([{
      p_alunno: creato.id,
      p_anno_sede: ANNO_SEDE_2027,
      p_tipo: 'nuova',
      p_origine: 'domanda',
      p_domanda: DOMANDA,
      p_section: SEZ_2027, // la «3 ANNI» del 2027/28, non quella di oggi
      p_data_ingresso: null, // la data la decide la funzione
      p_campi: {
        retta_mensile: 300,
        giorno_scadenza_pagamenti: 5,
        intestatario_fatture: { tipo: 'adult', adult_id: adultoId, nome: 'Anna Bianchi' },
      },
    }])
  })

  it('«la paga il fratello»: il collegamento passa alla frequenza, quando il fratello esiste', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario'), bambino('Luca')])]
    await importa({ assignments: { '0': '3 ANNI', '1': '3 ANNI' }, rette: { '0': 300 }, retteACarico: { '1': 0 } })
    const [primo, secondo] = h.db.alunni
    const [r0, r1] = registrazioni()
    expect(r0.p_alunno).toBe(primo.id)
    expect((r0.p_campi as Record<string, unknown>).retta_mensile).toBe(300)
    expect(r1.p_alunno).toBe(secondo.id)
    expect(r1.p_campi).toEqual({ retta_a_carico_di: primo.id })
    // e nessun UPDATE di alunni per il collegamento (è la retta di OGGI)
    expect(sulleTabelle('alunni', 'update')).toEqual([])
  })

  it('una sezione che esiste solo nell’anno di oggi è respinta, e non si scrive niente', async () => {
    h.db.sections = [{ id: SEZ_OGGI, scuola_id: SEDE, name: '3 ANNI', anno_id: ANNO_OGGI }]
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(false)
    expect(h.scritture).toEqual([])
    expect(h.rpc.filter((r) => r.nome === 'anno_registra_frequenza')).toEqual([])
  })

  it('la funzione che registra risponde con un codice dell’anno: l’import non è riuscito e la domanda resta in attesa', async () => {
    h.registra = () => ({ data: null, error: { code: 'P0001', message: 'ANNO_NON_APERTO' } })
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(false)
    expect(sulleTabelle('enrollment_submissions', 'update')).toEqual([])
  })

  it('le credenziali ai genitori partono una volta sola, come oggi', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario'), bambino('Luca')])]
    const json = await (await importa({
      assignments: { '0': '3 ANNI', '1': '3 ANNI' }, rette: { '0': 300, '1': 250 },
    })).json()
    expect(json.success).toBe(true)
    expect(h.inviaEmail).toHaveBeenCalledTimes(1)
    expect(json.credenzialiInviate).toBe(1)
  })
})

describe('domanda per l’anno PROSSIMO — bambino che ESISTE', () => {
  const scheda = (over: Record<string, unknown> = {}) => ({
    id: ESISTENTE, scuola_id: SEDE, nome: 'Mario', cognome: 'Prova', data_nascita: '2022-03-07',
    codice_fiscale: 'XQQYKV22C07Z999T', anonimizzato_il: null, stato: 'iscritto', archiviato_il: null,
    classe_sezione: '4 ANNI', section_id: 'sez-di-oggi', importo_retta_mensile: 250, allergies: null, note_mediche: null,
    ...over,
  })
  const conCodice = (over: Record<string, unknown> = {}) => {
    h.db.enrollment_submissions = [domanda([bambino('Mario', { codice_fiscale: 'XQQYKV22C07Z999T', ...over })])]
  }

  it('bambino vivo oggi: né classe né retta né stato cambiano; la domanda aggiunge solo la frequenza dell’anno dopo', async () => {
    conCodice()
    h.db.alunni = [scheda()]
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 }, giorniScadenza: { '0': 5 } })).json()
    expect(json.success).toBe(true)
    expect(scrittureDiOggiSuAlunni()).toEqual([])
    expect(sulleTabelle('alunni', 'update')).toEqual([])
    expect(h.db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '4 ANNI', section_id: 'sez-di-oggi', importo_retta_mensile: 250 })
    const [r] = registrazioni()
    expect(r).toMatchObject({ p_alunno: ESISTENTE, p_anno_sede: ANNO_SEDE_2027, p_section: SEZ_2027, p_tipo: 'nuova', p_origine: 'domanda' })
    expect(sulleTabelle('frequenze')).toEqual([])
  })

  it('i dati sanitari della domanda arrivano in scheda, ma senza classe né retta', async () => {
    conCodice({ allergies: 'allergia di prova' })
    h.db.alunni = [scheda()]
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    const aggiornamenti = sulleTabelle('alunni', 'update')
    expect(aggiornamenti).toHaveLength(1)
    const patch = aggiornamenti[0].valori[0]
    expect(patch.allergies).toBeDefined()
    expect(scrittureDiOggiSuAlunni()).toEqual([])
    expect(patch.stato).toBeUndefined()
  })

  it('bambino ritirato che torna: in_arrivo, non archiviato, senza sezione né classe; la frequenza dell’anno dopo c’è', async () => {
    conCodice()
    h.db.alunni = [scheda({ stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z' })]
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    const riga = h.db.alunni[0]
    expect(riga).toMatchObject({ stato: 'in_arrivo', archiviato_il: null, section_id: null, classe_sezione: null })
    // la retta di oggi non si tocca nemmeno per lui
    expect(riga.importo_retta_mensile).toBe(250)
    expect(registrazioni()).toHaveLength(1)
    expect(sulleTabelle('frequenze')).toEqual([])
    // l'eliminazione definitiva legge proprio questo stato e lo respinge (route `admin/students/elimina`, `eInArrivo`)
    expect(eInArrivo(riga.stato as string)).toBe(true)
  })

  it('bambino archiviato (stato ancora iscritto) che torna: lo stesso', async () => {
    conCodice()
    h.db.alunni = [scheda({ stato: 'iscritto', archiviato_il: '2026-06-30T10:00:00Z' })]
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    expect(h.db.alunni[0]).toMatchObject({ stato: 'in_arrivo', archiviato_il: null, section_id: null, classe_sezione: null })
  })

  it('bambino sospeso: resta sospeso', async () => {
    conCodice()
    h.db.alunni = [scheda({ stato: 'sospeso' })]
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    expect(h.db.alunni[0].stato).toBe('sospeso')
    expect(registrazioni()).toHaveLength(1)
  })

  it('frequenza già esistente (confermata prima): la domanda è collegata, e lo si dice', async () => {
    conCodice()
    h.db.alunni = [scheda()]
    h.registra = () => ({ data: { frequenza_id: 'freq-vecchia', creata: false, quota: 'gia_collegata', pagamento_id: 'pag-1', posti_oltre: false }, error: null })
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    expect(json.warnings.join(' ')).toContain('già confermato')
  })

  it.each([
    ['senza_listino', 'non è stata creata'],
    ['piu_voci', 'più di una voce'],
  ])('la voce della quota «%s» arriva nella risposta, con il testo per la segreteria (4.5.15, I1)', async (quota, testo) => {
    conCodice()
    h.db.alunni = [scheda()]
    h.registra = () => ({ data: { frequenza_id: 'freq-nuova', creata: true, quota, pagamento_id: null, posti_oltre: false }, error: null })
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    expect(json.warnings.join(' ')).toContain(testo)
  })

  it('con la voce creata l’approvazione non aggiunge avvisi sulla quota', async () => {
    conCodice()
    h.db.alunni = [scheda()]
    h.registra = () => ({ data: { frequenza_id: 'freq-nuova', creata: true, quota: 'creata', pagamento_id: 'pag-1', posti_oltre: false }, error: null })
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect((json.warnings ?? []).join(' ')).not.toContain('quota')
  })
})

describe('l’anno della domanda decide il percorso', () => {
  it('anno ATTIVO: il percorso di oggi (classe, stato iscritto, retta), nessuna frequenza dell’anno dopo', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: ANNO_OGGI })]
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    expect(h.db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '3 ANNI', importo_retta_mensile: 300 })
    expect(registrazioni()).toEqual([])
  })

  it('anno_id assente: il percorso di oggi, anche se la sede non ha alcun anno attivo (niente 409 su una domanda vecchia)', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: null })]
    h.db.anni_sede = []
    h.annoAttivo = { data: null, error: null }
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    expect(h.db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '3 ANNI', importo_retta_mensile: 300 })
    expect(registrazioni()).toEqual([])
  })

  it('schema indietro (la funzione dell’anno non c’è): il percorso di oggi', async () => {
    h.annoAttivo = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    expect(h.db.alunni[0]).toMatchObject({ stato: 'iscritto', classe_sezione: '3 ANNI', importo_retta_mensile: 300 })
    expect(registrazioni()).toEqual([])
  })

  it('anno NON aperto: 409 ANNO_NON_APERTO e zero scritture', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: ANNO_CHIUSO })]
    const res = await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_NON_APERTO')
    expect(h.scritture).toEqual([])
    expect(registrazioni()).toEqual([])
  })

  it('anno che la sede non ha: 409 ANNO_NON_APERTO e zero scritture', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: '99990000-0000-4000-8000-000000000009' })]
    const res = await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })
    expect(res.status).toBe(409)
    expect(h.scritture).toEqual([])
  })
})

describe('POST /api/admin/iscrizioni/sposta-anno', () => {
  beforeEach(() => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: ANNO_OGGI })]
  })

  it('sposta una domanda in attesa su un anno con le domande aperte della stessa sede', async () => {
    const res = await sposta({ domanda_id: DOMANDA, anno_id: ANNO_2027 })
    expect(res.status).toBe(200)
    const [s] = sulleTabelle('enrollment_submissions', 'update')
    expect(s.valori[0].anno_id).toBe(ANNO_2027)
    expect(h.db.enrollment_submissions[0].anno_id).toBe(ANNO_2027)
  })

  it('rifiuta una domanda già approvata (409) e non scrive niente', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario')], { anno_id: ANNO_OGGI, status: 'approved' })]
    const res = await sposta({ domanda_id: DOMANDA, anno_id: ANNO_2027 })
    expect(res.status).toBe(409)
    expect(h.scritture).toEqual([])
  })

  it('rifiuta un anno con le domande chiuse (422)', async () => {
    const res = await sposta({ domanda_id: DOMANDA, anno_id: ANNO_CHIUSO })
    expect(res.status).toBe(422)
    expect(h.scritture).toEqual([])
  })

  it('rifiuta un anno che la sede della domanda non ha (422)', async () => {
    const res = await sposta({ domanda_id: DOMANDA, anno_id: '99990000-0000-4000-8000-000000000009' })
    expect(res.status).toBe(422)
    expect(h.scritture).toEqual([])
  })

  it('una domanda di un’altra sede: 403, nessuna scrittura', async () => {
    h.scuoleDiUtente.mockResolvedValue(['b2b2b2b2-0000-4000-8000-000000000002'])
    const res = await sposta({ domanda_id: DOMANDA, anno_id: ANNO_2027 })
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('domanda inesistente: 404; corpo non valido: 400', async () => {
    h.db.enrollment_submissions = []
    expect((await sposta({ domanda_id: DOMANDA, anno_id: ANNO_2027 })).status).toBe(404)
    expect((await sposta({ domanda_id: 'non-un-uuid', anno_id: ANNO_2027 })).status).toBe(400)
  })

  it('senza il gate dello staff non si legge né si scrive niente', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response(null, { status: 401 }) })
    const res = await sposta({ domanda_id: DOMANDA, anno_id: ANNO_2027 })
    expect(res.status).toBe(401)
    expect(h.scritture).toEqual([])
  })
})
