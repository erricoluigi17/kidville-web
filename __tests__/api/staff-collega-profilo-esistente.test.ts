import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import { costruisciClient, statoVuoto, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// «AGGIUNGI IL RUOLO DI INSEGNANTE A QUESTO ACCOUNT» — il presidio umano che
// mancava dall'altra parte di un messaggio scritto mesi fa.
//
// ── IL FATTO CHE QUESTO FILE TIENE FERMO, PRIMA DI TUTTI GLI ALTRI ───────────
//
// `staff-identity.ts` risponde da sempre «serve una decisione della segreteria per
// aggiungere il ruolo di insegnante SENZA TOGLIERE L'ACCESSO ALLE SCHEDE DEI FIGLI»,
// e finora non esisteva nessun posto in cui prenderla. Questa route è quel posto, e
// la promessa che deve mantenere è letterale: dopo l'operazione la persona deve
// ANCORA vedere i propri figli.
//
// La prova non è un'asserzione su un campo: è `getProfiliForAuthUid` — il codice VERO
// che decide quali aree si aprono a un uid — chiamato sul database finto DOPO la
// scrittura. Se torna due profili (personale + genitore), il ponte è vivo. Se ne
// torna uno, la funzionalità ha fatto esattamente il danno che diceva di evitare.
//
// ── PERCHÉ È UN UPDATE E NON UN INSERT (misurato, non dedotto) ───────────────
//
// In produzione, 2026-09-01: 563 righe `parents` con `auth_user_id`, e **563 su 563**
// hanno GIÀ una riga `utenti` (558 con `ruolo = 'genitore'`, 5 con `educator` — il
// doppio profilo esiste già). Un genitore che ha un accesso ha per forza la sua riga
// `utenti`: la scrive `ensureParentIdentity`, ed è l'unica tabella letta da
// `loadAppUser`. `utenti.id` è PRIMARY KEY, quindi «creare la riga sull'uid esistente»
// prenderebbe un `23505` in 563 casi su 563. Il doppio profilo, in questo schema, È
// `utenti.ruolo` staff + il ponte `parents.auth_user_id` intatto — sta scritto in
// `src/lib/auth/profili.ts` e lo conferma `conPonteGenitore` in `require-staff.ts`.
//
// ── LE ALTRE COSE CHE RESTANO FERME ──────────────────────────────────────────
//
//  1. È DIRIGENZA, non segreteria: `requireStaff(['admin','coordinator'])`. La
//     segreteria apre il cockpit delle pratiche, ma questa non è una pratica da
//     archiviare — è l'assegnazione di un ruolo sui dati di minori altrui.
//  2. `conferma: true` NON è decorazione: senza, o con `false`, non si scrive niente.
//  3. LA SEDE SI DICHIARA. `utenti.scuola_id` è NOT NULL ed è una colonna sola: dopo
//     l'operazione è la sede in cui quella persona LAVORA. Un body che non la nomina
//     è un 400, e una sede altrui è un 403 — mai un plesso indovinato.
//  4. L'ACCOUNT DEVE STARE IN UN PLESSO CHE QUESTA POSTAZIONE GESTISCE, e la
//     clausola sta NELL'ISTRUZIONE che scrive: senza, la Direzione di un plesso
//     riassegnerebbe il genitore di un altro.
//  5. `utenti.role`, `first_name`, `last_name` sono colonne GENERATE: scriverle fa
//     fallire l'UPDATE. Qui non compaiono mai, e il test lo guarda.
//  6. IL SECONDO CLIC NON RIFÀ NIENTE: la clausola `ruolo = <valore letto>` rende
//     l'UPDATE atomico, e la seconda richiesta trova un profilo che non è più di un
//     genitore.
// =============================================================================

const UID_GENITORE = '11111111-0000-4000-8000-00000000000a'
const UID_ALTRO = '22222222-0000-4000-8000-00000000000b'
const EMAIL = 'mamma.maestra@example.test'

const ADMIN = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const COORDINATOR = { id: 'ffffffff-1111-4000-8000-000000000002', role: 'coordinator', scuola_id: SEDE_A }
const SEGRETERIA = { id: 'ffffffff-1111-4000-8000-000000000003', role: 'segreteria', scuola_id: SEDE_A }

const h = vi.hoisted(() => ({
  state: null as null | Record<string, unknown>,
  /** Le sedi «attive» (SedeSelector): è lo scope con cui si giudica l'account. */
  scuole: [] as string[],
  utente: null as null | { id: string; role: string; scuola_id: string },
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-staff')>()),
  requireStaff: h.requireStaff,
}))
// `resolveScuolaScrittura` resta VERA: è il presidio che risponde 403 su una sede
// altrui, e un finto che dicesse sempre di sì non proverebbe nessun diniego.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => h.scuole,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => costruisciClient(h.state as unknown as StatoFinto),
  createClient: async () => costruisciClient(h.state as unknown as StatoFinto),
}))

import { GET, POST } from '@/app/api/admin/staff/collega-profilo-esistente/route'
// Il codice VERO che decide quali aree si aprono a un uid: è la prova del ponte.
import { getProfiliForAuthUid } from '@/lib/auth/profili'

const URL_ROUTE = 'http://localhost/api/admin/staff/collega-profilo-esistente'

const post = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const get = (qs: string) => new NextRequest(`${URL_ROUTE}?${qs}`, { method: 'GET' })

/** Lo stato di partenza: una mamma che è anche maestra, con l'accesso da genitore. */
function seminaGenitore(opts: { sedeAccount?: string } = {}) {
  const stato = statoVuoto()
  stato.tabelle.utenti = [
    {
      id: UID_GENITORE,
      email: EMAIL,
      nome: 'Anna',
      cognome: 'Bianchi',
      ruolo: 'genitore',
      scuola_id: opts.sedeAccount ?? SEDE_A,
    },
  ]
  stato.tabelle.parents = [
    { id: 'aaaa1111-0000-4000-8000-00000000000f', auth_user_id: UID_GENITORE },
  ]
  stato.tabelle.utenti_scuole = []
  return stato
}

const corpo = async (res: Response) => (await res.json()) as Record<string, unknown>
const rigaUtenti = () =>
  ((h.state as unknown as StatoFinto).tabelle.utenti ?? []).find((r) => r.id === UID_GENITORE)
const scrittureSu = (tabella: string) =>
  (h.state as unknown as StatoFinto).aggiornamenti.filter((a) => a.table === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.state = seminaGenitore() as unknown as Record<string, unknown>
  h.scuole = [SEDE_A]
  h.utente = COORDINATOR
  h.requireStaff.mockImplementation(async (_request: Request, allowed: string[]) => {
    if (!h.utente) return { response: NextResponse.json({ error: 'non autenticato' }, { status: 401 }) }
    if (!allowed.includes(h.utente.role)) {
      return { response: NextResponse.json({ error: 'accesso negato' }, { status: 403 }) }
    }
    return { user: h.utente }
  })
})

const bodyValido = (extra: Record<string, unknown> = {}) => ({
  authUserId: UID_GENITORE,
  ruolo: 'educator',
  scuolaId: SEDE_A,
  conferma: true,
  ...extra,
})

describe('POST /api/admin/staff/collega-profilo-esistente — il gate', () => {
  it('la SEGRETERIA non passa: è dirigenza, non sportello', async () => {
    h.utente = SEGRETERIA
    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(403)
    // E soprattutto: non è stato scritto niente.
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('un anonimo prende 401 e non tocca niente', async () => {
    h.utente = null
    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(401)
    expect(rigaUtenti()?.ruolo).toBe('genitore')
  })

  it('la Direzione (admin) e il coordinamento passano il gate', async () => {
    for (const chi of [ADMIN, COORDINATOR]) {
      h.state = seminaGenitore() as unknown as Record<string, unknown>
      h.utente = chi
      // L'admin è multi-plesso via `utenti_scuole`: qui ne ha una sola, dichiarata.
      ;(h.state as unknown as StatoFinto).tabelle.utenti_scuole = [
        { utente_id: chi.id, scuola_id: SEDE_A },
      ]
      const res = await POST(post(bodyValido()))
      expect(res.status, `${chi.role} non è passato`).toBe(200)
    }
  })
})

describe('POST … — la conferma esplicita', () => {
  it('`conferma` ASSENTE ⇒ 400 e nessuna riga scritta', async () => {
    const body = bodyValido() as Record<string, unknown>
    delete body.conferma
    const res = await POST(post(body))
    expect(res.status).toBe(400)
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('`conferma: false` ⇒ 400 e nessuna riga scritta', async () => {
    const res = await POST(post(bodyValido({ conferma: false })))
    expect(res.status).toBe(400)
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })
})

describe('POST … — la sede si DICHIARA, non si indovina', () => {
  it('sede assente dal corpo ⇒ 400, anche con una sola sede accessibile', async () => {
    const body = bodyValido() as Record<string, unknown>
    delete body.scuolaId
    const res = await POST(post(body))
    expect(res.status).toBe(400)
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('sede NON accessibile ⇒ 403 con codice, e niente scritto', async () => {
    const res = await POST(post(bodyValido({ scuolaId: SEDE_B })))
    expect(res.status).toBe(403)
    expect((await corpo(res)).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('la sede scritta è QUELLA DICHIARATA, anche quando l’account ne ha un’altra', async () => {
    // Admin di tre plessi: senza una sede dichiarata non ci sarebbe modo di sapere
    // dove va registrata la persona, ed è esattamente il caso in cui una route che
    // «indovina» archivia nel plesso sbagliato in silenzio.
    h.utente = ADMIN
    h.scuole = [SEDE_A, SEDE_B, SEDE_C]
    const stato = seminaGenitore({ sedeAccount: SEDE_A })
    stato.tabelle.utenti_scuole = [
      { utente_id: ADMIN.id, scuola_id: SEDE_A },
      { utente_id: ADMIN.id, scuola_id: SEDE_B },
      { utente_id: ADMIN.id, scuola_id: SEDE_C },
    ]
    h.state = stato as unknown as Record<string, unknown>

    const res = await POST(post(bodyValido({ scuolaId: SEDE_C })))
    expect(res.status).toBe(200)
    expect(rigaUtenti()?.scuola_id).toBe(SEDE_C)
  })
})

describe('POST … — le porte che restano chiuse', () => {
  it('uid inesistente ⇒ 404 con codice', async () => {
    const res = await POST(post(bodyValido({ authUserId: UID_ALTRO })))
    expect(res.status).toBe(404)
    expect((await corpo(res)).codice).toBe('PROFILO_DOPPIO_ACCOUNT_NON_TROVATO')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('profilo GIÀ del personale ⇒ 409, non si duplica e non si sovrascrive', async () => {
    const stato = seminaGenitore()
    ;(stato.tabelle.utenti[0] as Record<string, unknown>).ruolo = 'segreteria'
    h.state = stato as unknown as Record<string, unknown>

    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(409)
    expect((await corpo(res)).codice).toBe('PROFILO_DOPPIO_GIA_PERSONALE')
    // Il ruolo che aveva NON è stato toccato: un declassamento silenzioso sarebbe
    // un accesso perso.
    expect(rigaUtenti()?.ruolo).toBe('segreteria')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('nessun ponte `parents` ⇒ 409: qui non c’è nessun accesso ai figli da salvare', async () => {
    const stato = seminaGenitore()
    stato.tabelle.parents = []
    h.state = stato as unknown as Record<string, unknown>

    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(409)
    expect((await corpo(res)).codice).toBe('PROFILO_DOPPIO_SENZA_PONTE')
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('account registrato in un plesso che questa postazione non gestisce ⇒ 403', async () => {
    h.state = seminaGenitore({ sedeAccount: SEDE_B }) as unknown as Record<string, unknown>
    h.scuole = [SEDE_A]

    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(403)
    expect((await corpo(res)).codice).toBe('PROFILO_DOPPIO_ALTRA_SEDE')
    expect(rigaUtenti()?.ruolo).toBe('genitore')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('un ruolo fuori da quelli assegnabili (`genitore`) ⇒ 400', async () => {
    const res = await POST(post(bodyValido({ ruolo: 'genitore' })))
    expect(res.status).toBe(400)
    expect(scrittureSu('utenti')).toHaveLength(0)
  })
})

describe('POST … — il gesto riuscito', () => {
  it('scrive il ruolo, DICHIARA la sede e non tocca nient’altro', async () => {
    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(200)

    const body = await corpo(res)
    expect(body.ok).toBe(true)
    expect(body.ruoloPrecedente).toBe('genitore')

    const riga = rigaUtenti()
    expect(riga?.ruolo).toBe('educator')
    expect(riga?.scuola_id).toBe(SEDE_A)

    // UNA sola istruzione di scrittura, e solo su `utenti`.
    const scritture = (h.state as unknown as StatoFinto).aggiornamenti
    expect(scritture).toHaveLength(1)
    expect(scritture[0].table).toBe('utenti')

    // Le colonne GENERATE non si scrivono MAI: l’UPDATE fallirebbe.
    for (const generata of ['role', 'first_name', 'last_name']) {
      expect(Object.keys(scritture[0].patch)).not.toContain(generata)
    }
    // E nemmeno l’email o il nome: qui si aggiunge un ruolo, non si riscrive una persona.
    expect(Object.keys(scritture[0].patch).sort()).toEqual(['ruolo', 'scuola_id'])

    // La clausola di sede sta NELL’ISTRUZIONE che scrive.
    const colonne = scritture[0].filtri.map((f) => f.col)
    expect(colonne).toContain('id')
    expect(colonne).toContain('ruolo')
    expect(colonne).toContain('scuola_id')
  })

  it('IL PONTE `parents` SOPRAVVIVE: la persona vede ancora i propri figli', async () => {
    // Seminata anche l'anagrafica del legame: è la tabella da cui dipende DAVVERO la
    // visibilità dei figli (vedi il commento in coda a questo caso).
    ;(h.state as unknown as StatoFinto).tabelle.student_parents = [
      { student_id: 'bbbb2222-0000-4000-8000-00000000000e', parent_id: 'aaaa1111-0000-4000-8000-00000000000f' },
    ]

    const prima = await getProfiliForAuthUid(UID_GENITORE)
    expect(prima.map((p) => p.ruolo)).toEqual(['genitore'])

    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(200)

    // La riga `parents` non è stata né toccata né cancellata.
    expect((h.state as unknown as StatoFinto).tabelle.parents).toHaveLength(1)
    expect((h.state as unknown as StatoFinto).tabelle.parents[0].auth_user_id).toBe(UID_GENITORE)
    expect(scrittureSu('parents')).toHaveLength(0)
    expect((h.state as unknown as StatoFinto).inserimenti).toHaveLength(0)

    /**
     * ⚠️ LE TRE GAMBE SU CUI STA IN PIEDI LA PROMESSA, e vanno guardate tutte e tre
     * perché il ponte da solo non basta a far vedere un bambino.
     *
     * MISURATO in produzione il 2026-09-02, leggendo la definizione della funzione:
     *
     *   CREATE FUNCTION current_parent_student_ids() … SECURITY DEFINER AS $$
     *     SELECT sp.student_id FROM student_parents sp
     *     JOIN parents p ON p.id = sp.parent_id
     *     WHERE p.auth_user_id = auth.uid()
     *   $$
     *
     * È la funzione su cui poggia ogni policy «(parents space)», e NON NOMINA `utenti`
     * — quindi non guarda il ruolo. Da qui:
     *  1. `utenti.ruolo` può cambiare senza togliere niente: la RLS di famiglia non
     *     passa di lì. È il motivo per cui questa operazione è sicura.
     *  2. il ponte `parents.auth_user_id` deve restare — ed è il primo `expect` qui
     *     sopra;
     *  3. il legame `student_parents` deve restare — ed è l'`expect` qui sotto.
     * Se questa route toccasse una qualunque delle due tabelle, la promessa
     * («senza togliere l'accesso alle schede dei figli») diventerebbe falsa in
     * silenzio: la persona entrerebbe nell'area famiglie e la troverebbe VUOTA, che è
     * peggio di un errore perché si legge come «non c'è niente».
     */
    expect(scrittureSu('student_parents'), 'il legame col figlio è stato toccato').toHaveLength(0)
    expect(scrittureSu('legame_genitori_alunni')).toHaveLength(0)
    expect((h.state as unknown as StatoFinto).tabelle.student_parents).toHaveLength(1)

    // E la prova vera: il codice che decide quali aree si aprono ne vede DUE.
    const dopo = await getProfiliForAuthUid(UID_GENITORE)
    expect(dopo.map((p) => p.ruolo).sort()).toEqual(['educator', 'genitore'])
    expect(dopo.map((p) => p.area).sort()).toEqual(['parent', 'teacher'])
  })

  it('non crea e non cancella nessun account, e non genera nessuna password', async () => {
    await POST(post(bodyValido()))
    const stato = h.state as unknown as StatoFinto
    expect(stato.creazioniAuth).toHaveLength(0)
    expect(stato.cancellazioniAuth).toHaveLength(0)
    const body = await corpo(await POST(post(bodyValido({ authUserId: UID_GENITORE }))))
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('credentials')
  })

  it('scrive l’audit e il log di CHI HA DECISO', async () => {
    await POST(post(bodyValido()))

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(audit.entitaTipo).toBe('utenti')
    expect(audit.entitaId).toBe(UID_GENITORE)
    expect(audit.azione).toBe('update')
    expect(audit.scuolaId).toBe(SEDE_A)
    expect(audit.valorePrima).toMatchObject({ ruolo: 'genitore' })
    expect(audit.valoreDopo).toMatchObject({ ruolo: 'educator' })
    // Chi ha deciso: l'attore è l'utente del gate, non l'interessata.
    expect((audit.attore as { id: string }).id).toBe(COORDINATOR.id)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { tipo?: string } | undefined)?.tipo === 'profilo-doppio-creato',
    )
    expect(riga, 'manca il log `profilo-doppio-creato`').toBeTruthy()
    expect(riga?.[0]).toBe('anagrafica')
    // `warn` e non `info`: deve finire in tabella, è la traccia di una decisione.
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ utente: UID_GENITORE, ruolo: 'educator' })
  })

  it('il SECONDO clic non rifà niente: 409, e una sola scrittura in tutto', async () => {
    expect((await POST(post(bodyValido()))).status).toBe(200)
    const secondo = await POST(post(bodyValido()))
    expect(secondo.status).toBe(409)
    expect((await corpo(secondo)).codice).toBe('PROFILO_DOPPIO_GIA_PERSONALE')
    expect((h.state as unknown as StatoFinto).aggiornamenti).toHaveLength(1)
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })

  it('la lettura del profilo che non riesce vale 503, non «non esiste»', async () => {
    ;(h.state as unknown as StatoFinto).erroriTabella.utenti = {
      code: '57014', message: 'canceling statement due to statement timeout',
    }
    const res = await POST(post(bodyValido()))
    expect(res.status).toBe(503)
    expect((await corpo(res)).codice).toBe('PROFILO_DOPPIO_NON_RIUSCITO')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})

describe('GET … — il risolutore che dà l’uid a chi può decidere', () => {
  it('la segreteria non lo può interrogare', async () => {
    h.utente = SEGRETERIA
    expect((await GET(get(`email=${encodeURIComponent(EMAIL)}`))).status).toBe(403)
  })

  it('restituisce l’uid SOLO quando la porta è davvero quella del genitore', async () => {
    const res = await GET(get(`email=${encodeURIComponent(EMAIL)}`))
    expect(res.status).toBe(200)
    const body = await corpo(res)
    expect(body).toMatchObject({
      trovato: true,
      authUserId: UID_GENITORE,
      ruolo: 'genitore',
      ponteGenitore: true,
      sedeGestita: true,
    })
  })

  it('un account del PERSONALE non fa uscire nessun uid', async () => {
    const stato = seminaGenitore()
    ;(stato.tabelle.utenti[0] as Record<string, unknown>).ruolo = 'educator'
    h.state = stato as unknown as Record<string, unknown>

    const body = await corpo(await GET(get(`email=${encodeURIComponent(EMAIL)}`)))
    expect(body).toMatchObject({ trovato: true, authUserId: null, ruolo: 'educator' })
  })

  it('email sconosciuta ⇒ `trovato: false`, senza uid', async () => {
    const body = await corpo(await GET(get('email=nessuno%40example.test')))
    expect(body).toMatchObject({ trovato: false, authUserId: null })
  })

  it('email non indicata ⇒ 400', async () => {
    expect((await GET(get('email='))).status).toBe(400)
  })
})
