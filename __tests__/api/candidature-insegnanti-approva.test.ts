import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
// Le posizioni si LEGGONO dall'unico elenco che le dichiara, invece di fidarsi di
// quattro stringhe scritte qui: `candidature_insegnanti.posizioni` ha un `CHECK` di
// appartenenza (migrazione `20260814225302_candidature_posizioni_cv`), quindi un
// valore fuori elenco è una riga che in tabella non può esistere — e un ramo
// collaudato su una riga impossibile non è collaudato.
import { POSIZIONI_AMMESSE } from '@/lib/forms/insegnanti-template'

// =============================================================================
// «APPROVA»: il gesto che PUÒ creare un ACCOUNT DOCENTE e mandare le credenziali.
//
// Qui `ensureStaffIdentity` gira DAVVERO (non è mockata): è metà dell'oggetto del
// test, e mockarla lascerebbe verde proprio ciò che si vuole provare — che l'INSERT
// non tocchi le colonne generate, che la sede scritta sia quella della candidatura e
// che nessuna email già in uso produca un secondo account.
//
// Le sette cose che questo file tiene ferme:
//  1. account `auth.users` + riga `utenti` con RUOLO, SEDE e GRADI giusti;
//  2. MAI `role`/`first_name`/`last_name`: sono colonne GENERATE, scriverle fa fallire
//     l'INSERT (e il fallimento sarebbe silenzioso per chi guarda la UI);
//  3. la SEDE nell'email è quella della CANDIDATURA, non quella dell'operatore —
//     l'unico admin reale ha Giugliano come sede primaria e gestisce tre plessi;
//  4. il CLAIM ATOMICO: la seconda PATCH prende 409, e non nascono due account;
//  5. email già di uno STAFF o già legata a un GENITORE: 409 e ZERO scritture;
//  6. `gradi` respinta dal DB della CI e email non partita: l'account nasce comunque,
//     e l'operatore lo viene a sapere dai `warnings` — mai in silenzio.
//  7. ⚠️ dal 2026-08-15 le strade sono DUE, e a sceglierle sono le `posizioni` della
//     candidatura: con almeno una `insegnante_*` si passa di qui e l'account nasce
//     (`esitoAccount: 'creato' | 'riusato'`); con `cuoca`, `collaboratrice`,
//     `segreteria` o `altro` la candidatura si chiude `approvata` e non nasce
//     NIENTE — nessun `createUser`, nessuna riga `utenti`, nessuna email
//     (`esitoAccount: 'nessuno'`). Su una riga SENZA `posizioni` — la colonna che
//     il DB della CI non ha — la risposta è «nessun account»: un profilo
//     `educator` legge l'anagrafica dei bambini, e «non so per quale posizione si
//     è candidata» non è un permesso.
//
// Il fixture porta due posizioni DOCENTI (`insegnante_nido`, `insegnante_infanzia`),
// coerenti con i suoi `gradi`: senza, ogni caso di questo file finirebbe nel ramo
// «nessun account» e proverebbe un'altra cosa da quella che dichiara.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

/** L'operatore è di SEDE_A ma gestisce anche SEDE_B: la candidatura è di SEDE_B. */
const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const CANDIDATURA_ID = 'dddddddd-0000-4000-8000-00000000000a'
const EMAIL = 'prova.candidata@example.test'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    inserimenti: [] as { table: string; row: Riga }[],
    aggiornamenti: [] as { table: string; patch: Riga; filtri: { col: string; vals: unknown[] }[] }[],
    authUsers: [] as { id: string; email: string }[],
    creazioniAuth: [] as { email: string; password?: string }[],
    cancellazioniAuth: [] as string[],
    /** `deleteUser` che non riesce: è ciò che lascia l'account ORFANO. */
    erroreCancellazioneAuth: null as null | { message: string; status?: number },
    /** `createUser` che non riesce: il provider risponde, e risponde in inglese. */
    erroreCreazioneAuth: null as null | { message: string; status?: number },
    /** Colonne che il DB (finto) dichiara assenti sull'INSERT in `utenti`. */
    colonneAssenti: [] as string[],
    /**
     * Colonne che il DB (finto) dichiara assenti sull'UPDATE — knob SEPARATO da
     * `colonneAssenti`, e non è pignoleria: quello di sopra parla della tabella
     * `utenti`, questo di `candidature_insegnanti`, e `gradi` esiste in ENTRAMBE.
     * Con una lista sola, `colonneAssenti = ['gradi']` avrebbe fatto cadere anche
     * la colonna della candidatura e il test avrebbe provato due cose insieme.
     */
    colonneAssentiUpdate: [] as string[],
    /**
     * Colonne che il DB (finto) dichiara assenti sulla LETTURA — il terzo knob, e
     * il primo che serve a una SELECT.
     *
     * La lettura pre-PATCH non chiede più una stringa fissa: passa da
     * `conResilienza` con `COLONNE_DECISIONE`, cioè `COLONNE_LAVORO` più
     * `posizioni`. Su un database che quella colonna non ce l'ha, PostgREST
     * risponde `42703 column <tabella>.<colonna> does not exist` e la route toglie
     * la colonna e RIPROVA. Senza questo knob quel ciclo non sarebbe misurabile da
     * qui, e con esso si misura anche il verso in cui degrada: senza `posizioni`,
     * nessun account.
     */
    colonneAssentiSelect: [] as string[],
    /**
     * Ogni LETTURA tentata, con le colonne chieste. Serve a due domande che le
     * altre spie non sanno rispondere: «la proiezione chiede davvero `posizioni`?»
     * (toglierla renderebbe ogni approvazione «senza account», in silenzio) e
     * «`ensureStaffIdentity` è partita?» — la sua prima istruzione è una SELECT su
     * `utenti`, quindi zero letture di `utenti` vuol dire che non è mai stata
     * chiamata.
     */
    letture: [] as { table: string; cols: string }[],
    /** Quante volte GoTrue è stato interrogato: `ensureStaffIdentity` ci passa sempre. */
    chiamateListUsers: 0,
    /** `listUsers` che non riesce: `findAuthUserIdByEmail` LANCIA, e lancia in inglese. */
    erroreListUsers: null as null | { message: string; status?: number },
    /** Un'eccezione VERA dentro il corpo di `ensureStaffIdentity` (non un `{ error }`). */
    eccezioneCreazioneAuth: null as null | string,
    /** Errore PER TABELLA: è così che si prova un fail-closed su una LETTURA. */
    erroriTabella: {} as Record<string, { code?: string; message: string }>,
    /** L'UPDATE di CHIUSURA (`→ approvata`) che non riesce: l'account però esiste già. */
    erroreChiusura: null as null | { code?: string; message: string },
  }
  return { state, requireStaff: vi.fn(), logScrittura: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn(), sendEmail: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.state.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
// `credentialsEmailBody` resta VERO: è così che si prova che nel testo dell'email
// finisce il nome della sede giusta, invece di fidarsi di un parametro passato.
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: h.sendEmail }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const esegui = () => {
        // La LETTURA si registra prima di qualunque guasto: la domanda a cui
        // risponde è «questa query è stata fatta?», non «com'è andata».
        const lettura = !patch && !inserimento
        if (lettura) h.state.letture.push({ table, cols })
        const guasto = h.state.erroriTabella[table]
        if (guasto) return { data: [] as Riga[], error: guasto, count: null as number | null }
        if (lettura) {
          const assente = h.state.colonneAssentiSelect.find((c) =>
            cols.split(',').map((s) => s.trim()).includes(c),
          )
          // La forma dell'errore è quella VERA di PostgREST su una proiezione
          // esplicita («column candidature_insegnanti.posizioni does not exist»,
          // codice `42703`): è la prima delle tre alternative del `colonnaMancante`
          // della route, e con un'altra formulazione il ciclo di degrado non
          // riconoscerebbe la colonna e questo test proverebbe un'altra cosa.
          if (assente) {
            return {
              data: [] as Riga[],
              error: { code: '42703', message: `column ${table}.${assente} does not exist` },
              count: null as number | null,
            }
          }
        }
        if (patch && (patch as Riga).stato === 'approvata' && h.state.erroreChiusura) {
          return { data: [] as Riga[], error: h.state.erroreChiusura, count: null as number | null }
        }
        if (patch) {
          const assente = h.state.colonneAssentiUpdate.find((c) => c in (patch as Riga))
          if (assente) {
            return {
              data: [] as Riga[],
              error: { code: 'PGRST204', message: `Could not find the '${assente}' column of '${table}' in the schema cache` },
              count: null as number | null,
            }
          }
        }
        if (inserimento) {
          const mancante = h.state.colonneAssenti.find((c) => c in (inserimento as Riga))
          if (mancante) {
            return {
              data: [] as Riga[],
              error: { code: 'PGRST204', message: `Could not find the '${mancante}' column of '${table}' in the schema cache` },
              count: null as number | null,
            }
          }
          const riga = { ...inserimento }
          righeDi(table).push(riga)
          h.state.inserimenti.push({ table, row: riga })
          return { data: [riga], error: null, count: null }
        }
        const trovate = righeDi(table).filter(corrisponde)
        if (patch) {
          for (const r of trovate) Object.assign(r, patch)
          // I FILTRI dell'UPDATE si registrano, non solo il `patch`: la sede
          // nell'istruzione che scrive è metà del presidio, e senza guardarla
          // toglierla resterebbe verde.
          h.state.aggiornamenti.push({ table, patch: { ...patch }, filtri: filtri.map((f) => ({ ...f })) })
          return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
        }
        return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.range = () => b
      b.limit = () => b
      b.update = (v: Riga) => { patch = v; return b }
      b.insert = (v: Riga) => { inserimento = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x' }, error: null }) }) },
    auth: {
      admin: {
        listUsers: async () => {
          h.state.chiamateListUsers++
          if (h.state.erroreListUsers) return { data: null, error: h.state.erroreListUsers }
          return { data: { users: h.state.authUsers }, error: null }
        },
        createUser: async ({ email, password }: { email: string; password?: string }) => {
          // Un'eccezione, non un `{ error }`: è l'unico modo di arrivare al `catch`
          // finale di `ensureStaffIdentity`, che è un ramo di codice come un altro.
          if (h.state.eccezioneCreazioneAuth) throw new Error(h.state.eccezioneCreazioneAuth)
          if (h.state.erroreCreazioneAuth) {
            return { data: null, error: h.state.erroreCreazioneAuth }
          }
          h.state.creazioniAuth.push({ email, password })
          const u = { id: `auth-${h.state.creazioniAuth.length}`, email }
          h.state.authUsers.push(u)
          return { data: { user: u }, error: null }
        },
        deleteUser: async (id: string) => {
          if (h.state.erroreCancellazioneAuth) {
            return { data: null, error: h.state.erroreCancellazioneAuth }
          }
          h.state.cancellazioniAuth.push(id)
          h.state.authUsers = h.state.authUsers.filter((u) => u.id !== id)
          return { data: null, error: null }
        },
      },
    },
  }
}

import { PATCH } from '@/app/api/admin/candidature-insegnanti/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti'
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const approva = () => PATCH(patch({ id: CANDIDATURA_ID, action: 'approva' }))

const rigaUtenti = () => h.state.inserimenti.find((i) => i.table === 'utenti')?.row

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A, SEDE_B]
  h.state.inserimenti = []
  h.state.aggiornamenti = []
  h.state.authUsers = []
  h.state.creazioniAuth = []
  h.state.cancellazioniAuth = []
  h.state.erroreCancellazioneAuth = null
  h.state.erroreCreazioneAuth = null
  h.state.colonneAssenti = []
  h.state.colonneAssentiUpdate = []
  h.state.colonneAssentiSelect = []
  h.state.letture = []
  h.state.chiamateListUsers = 0
  h.state.erroreListUsers = null
  h.state.eccezioneCreazioneAuth = null
  h.state.erroriTabella = {}
  h.state.erroreChiusura = null
  h.state.tabelle = {
    candidature_insegnanti: [
      {
        id: CANDIDATURA_ID,
        scuola_id: SEDE_B,
        stato: 'pending',
        nome: 'Prova',
        cognome: 'Cognome',
        email: EMAIL,
        telefono: '+39 000 0000000',
        // Due posizioni DOCENTI, e i `gradi` che ne discendono: è la coppia che
        // `gradiDallePosizioni` produce alla ricezione del modulo, quindi una riga
        // di questa forma è una riga che esiste davvero in tabella. Sono anche ciò
        // che manda la PATCH nel ramo con account: senza, ogni caso qui sotto
        // finirebbe in `approvaSenzaAccount`.
        posizioni: ['insegnante_nido', 'insegnante_infanzia'],
        gradi: ['nido', 'infanzia'],
        cv_path: 'candidature/cv.pdf',
        creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [
      { id: SEDE_A, nome: 'Kidville Sede Operatore' },
      { id: SEDE_B, nome: 'Kidville Sede Candidatura' },
    ],
    utenti: [],
    parents: [],
  }
  h.sendEmail.mockResolvedValue({ ok: true, error: null })
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'x' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: u }
  })
})

describe('candidature insegnanti · approvazione', () => {
  it('crea l’account e la riga `utenti` con ruolo, SEDE e gradi della candidatura', async () => {
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    expect(h.state.creazioniAuth).toHaveLength(1)
    expect(h.state.creazioniAuth[0].email).toBe(EMAIL)

    const u = rigaUtenti()
    expect(u, 'nessuna riga `utenti` creata').toBeTruthy()
    expect(u!.id).toBe('auth-1')
    expect(u!.ruolo).toBe('educator')
    // La sede è quella della CANDIDATURA, non `auth.user.scuola_id`.
    expect(u!.scuola_id).toBe(SEDE_B)
    expect(u!.gradi).toEqual(['nido', 'infanzia'])
    expect(u!.attivo).toBe(true)
    expect(u!.email).toBe(EMAIL)

    // La candidatura risulta approvata e legata all'account.
    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('approvata')
    expect(cand.utente_id).toBe('auth-1')
    expect(cand.evasa_da).toBe(ADMIN.id)
    expect(cand.evasa_il).toBeTruthy()

    // La password torna UNA volta sola, nella risposta.
    expect(body.credentials.email).toBe(EMAIL)
    expect(typeof body.credentials.password).toBe('string')
    expect((body.credentials.password as string).length).toBeGreaterThan(10)
    expect(body.credentialsEmailSent).toBe(true)
  })

  it('non scrive MAI le colonne generate (`role`, `first_name`, `last_name`)', async () => {
    await approva()
    const u = rigaUtenti()!
    for (const generata of ['role', 'first_name', 'last_name']) {
      expect(generata in u, `scritta la colonna generata «${generata}»: l’INSERT fallirebbe`).toBe(false)
    }
    expect(u.nome).toBe('Prova')
    expect(u.cognome).toBe('Cognome')
  })

  it('l’email delle credenziali nomina la sede della CANDIDATURA', async () => {
    await approva()
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const invio = h.sendEmail.mock.calls[0][0] as { to: string; text: string }
    expect(invio.to).toBe(EMAIL)
    expect(invio.text).toContain('Kidville Sede Candidatura')
    expect(invio.text).not.toContain('Kidville Sede Operatore')

    // Il SUCCESSO dell'invio lascia una riga su un canale PERSISTITO: senza,
    // «nessun log» non distingue «tutte partite» da «non ne parte più nessuna».
    const battito = h.logEvento.mock.calls.find(
      (c) => c[1] === 'info' && (c[2] as { esito?: string })?.esito === 'credenziali-inviate',
    )
    expect(battito, 'nessun log di SUCCESSO per le credenziali inviate').toBeTruthy()
    expect(battito![0]).toBe('candidatura')
    expect((battito![2] as { canale?: string }).canale).toBe('email')
    expect((battito![2] as { tipo?: string }).tipo).toBe('staff')
  })

  it('CLAIM ATOMICO: la seconda approvazione prende 409 e non nasce un secondo account', async () => {
    expect((await approva()).status).toBe(200)
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    expect(h.state.creazioniAuth, 'due account per la stessa candidatura').toHaveLength(1)
    expect(h.state.inserimenti.filter((i) => i.table === 'utenti')).toHaveLength(1)
  })

  it('email già di uno STAFF: 409, ZERO scritture e la candidatura resta `pending`', async () => {
    h.state.tabelle.utenti = [
      { id: 'utente-esistente', email: EMAIL, ruolo: 'segreteria', nome: 'Altra', cognome: 'Persona', scuola_id: SEDE_A },
    ]
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_EMAIL_GIA_STAFF')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.utenti).toHaveLength(1)
    // Uscita anticipata ⇒ lo stato torna `pending`: mai bloccata in `in_approvazione`.
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('email già di un GENITORE: 409 con codice proprio, e nessun account toccato', async () => {
    h.state.authUsers = [{ id: 'auth-genitore', email: EMAIL }]
    h.state.tabelle.parents = [{ id: 'parent-1', auth_user_id: 'auth-genitore' }]
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_EMAIL_GIA_GENITORE')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('colonna `gradi` assente (DB della CI): l’account nasce, e l’avviso lo NOMINA', async () => {
    h.state.colonneAssenti = ['gradi']
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    const u = rigaUtenti()!
    expect('gradi' in u).toBe(false)
    expect(u.ruolo).toBe('educator')
    expect(body.warnings.join(' ')).toMatch(/gradi|fasce/i)
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')
  })

  it('email NON partita: 200, account creato, e l’operatore lo legge nei `warnings`', async () => {
    h.sendEmail.mockResolvedValue({ ok: false, error: 'the domain is not verified' })
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.credentialsEmailSent).toBe(false)
    expect(body.credentials.password).toBeTruthy()
    expect(body.warnings.join(' ')).toMatch(/email/i)
    // L'esito dell'invio va anche nel log, e a livello `error`: un account creato
    // le cui credenziali non sono partite è un incidente, non una nota.
    const righe = h.logEvento.mock.calls.filter((c) => c[0] === 'credenziali')
    expect(righe.length).toBeGreaterThan(0)
    expect(righe.some((c) => c[1] === 'error')).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // I RAMI IN CUI QUALCOSA È GIÀ STATO SCRITTO
  //
  // Fino a oggi nessuno di questi era misurato, e sono esattamente quelli in cui
  // la risposta HTTP può MENTIRE: un 503 con dietro un account creato, un 200 con
  // dentro uno stato che in tabella non c'è.
  // ───────────────────────────────────────────────────────────────────────────

  it('INSERT `utenti` fallito: l’account appena creato viene ANNULLATO, non lasciato orfano', async () => {
    // `scuola_id` non è fra le colonne rimovibili — e non deve esserlo: un profilo
    // senza sede è una riga inutilizzabile spacciata per riuscita. Quindi l'INSERT
    // fallisce davvero, e l'account nato un istante prima non deve sopravvivergli.
    h.state.colonneAssenti = ['scuola_id']
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')

    // LA PROSA DI POSTGREST NON ESCE DAL SERVER. Lo stesso file lo dichiara già
    // sul guasto dello storage («il messaggio grezzo NON torna al client»): qui
    // vale identico, perché `Could not find the 'scuola_id' column … schema cache`
    // è inglese, nomina colonne e vincoli, e la legge la segreteria.
    expect(
      body.error,
      'il messaggio grezzo di PostgREST è finito nella risposta HTTP',
    ).not.toMatch(/schema cache|Could not find|column/i)

    expect(h.state.creazioniAuth, 'l’account non è mai stato creato: il test non prova niente').toHaveLength(1)
    expect(h.state.cancellazioniAuth, 'account `auth.users` ORFANO: creato e mai annullato').toEqual(['auth-1'])
    expect(h.state.authUsers).toEqual([])
    expect(h.state.inserimenti.filter((i) => i.table === 'utenti')).toEqual([])
    // La candidatura torna approvabile: non resta bloccata in `in_approvazione`.
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('INSERT `utenti` fallito E annullamento fallito: il 503 DICE che un account è rimasto', async () => {
    h.state.colonneAssenti = ['scuola_id']
    h.state.erroreCancellazioneAuth = { message: 'admin api unreachable', status: 500 }
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()

    // La risposta nomina l'unica via d'uscita: «Rigenera credenziali».
    const testo = [body.error, ...(body.warnings ?? [])].join(' ')
    expect(testo, 'un 503 con un account rimasto dietro, e non lo dice').toMatch(/Rigenera credenziali/i)
    expect(testo).toMatch(/È RIMASTO|È STATO CREATO/)
    // …ma senza la prosa del database dentro: l'azione per l'operatore resta,
    // il nome della colonna caduta vive nel log.
    expect(testo, 'la prosa di PostgREST è finita nella risposta HTTP').not.toMatch(
      /schema cache|Could not find/i,
    )

    // …e il log lo dichiara, con l'uid: è l'unico appiglio per ripararlo a mano.
    const orfano = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'account-orfano-lasciato',
    )
    expect(orfano, 'nessun log dell’account orfano').toBeTruthy()
    expect(orfano![1]).toBe('error')
    expect(h.state.authUsers.map((u) => u.id)).toEqual(['auth-1'])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('INSERT `utenti` fallito su un account PREESISTENTE: 503, e niente da annullare', async () => {
    // Il terzo ramo del fallimento d'INSERT, e l'unico che non passa dal rollback:
    // l'account c'era già, quindi NON è nato niente in questa chiamata e non c'è
    // nulla da cancellare — cancellarlo sarebbe anzi il disastro, perché è
    // l'accesso di qualcuno. Resta l'obbligo che vale per tutti e tre: la prosa
    // del database non torna al client.
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    h.state.colonneAssenti = ['scuola_id']
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(
      body.error,
      'il messaggio grezzo di PostgREST è finito nella risposta HTTP',
    ).not.toMatch(/schema cache|Could not find|column/i)

    expect(h.state.creazioniAuth, 'un account nuovo su un’email che ne aveva già uno').toEqual([])
    expect(
      h.state.cancellazioniAuth,
      'annullato un account PREESISTENTE: è l’accesso di qualcuno, non un residuo',
    ).toEqual([])
    expect(h.state.authUsers.map((u) => u.id)).toEqual(['auth-preesistente'])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')

    // Il nome della colonna caduta vive nel LOG, che è dove va.
    const guasto = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'profilo-staff-non-creato',
    )
    expect(guasto, 'nessun log del profilo non creato').toBeTruthy()
    expect(guasto![1]).toBe('error')
    expect((guasto![2] as { error_code?: string }).error_code).toBe('PGRST204')
  })

  it('`createUser` fallito: 503, e la prosa del provider resta nel log', async () => {
    // Stessa dottrina dell'INSERT: il corpo dell'errore del provider NON si butta
    // via (AGENTS.md §3) — ma va nel LOG, non nella risposta che legge la
    // segreteria. «A user with this email address has already been registered» è
    // inglese, e i tre casi in cui è vero li ha già intercettati il codice sopra.
    h.state.erroreCreazioneAuth = {
      message: 'A user with this email address has already been registered',
      status: 422,
    }
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(
      body.error,
      'la prosa del provider di autenticazione è finita nella risposta HTTP',
    ).not.toMatch(/already been registered|A user with/i)

    const guasto = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'creazione-account-non-riuscita',
    )
    expect(guasto, 'nessun log della creazione account fallita').toBeTruthy()
    expect(guasto![0]).toBe('auth')
    expect(guasto![1]).toBe('error')
    expect((guasto![2] as { stato?: number }).stato).toBe(422)
    // Il TESTO del provider è l'ultimo argomento: è lì che deve vivere.
    expect(String((guasto![3] as { message?: string })?.message)).toMatch(/already been registered/)

    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('`listUsers` fallita: 503, e la prosa di GoTrue NON esce dalla risposta', async () => {
    // Il terzo canale da cui la prosa di terze parti può uscire, e per due cicli
    // è rimasto aperto mentre il resto veniva chiuso: `findAuthUserIdByEmail`
    // (parent-identity.ts) non ritorna un `{ error }` — LANCIA, con dentro il
    // corpo grezzo di GoTrue e il numero di pagina della scansione. Quel testo
    // finiva in `message`, e `message` è ciò che la route serve come `body.error`.
    h.state.erroreListUsers = {
      message: 'A user with this email address has already been registered',
      status: 500,
    }
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(
      body.error,
      'la prosa del provider di autenticazione è finita nella risposta HTTP',
    ).not.toMatch(/listUsers|pagina|already been registered|A user with/i)

    // Il dettaglio vive dove è giusto che viva: nel log, ultimo argomento.
    const guasto = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'ricerca-account-non-riuscita',
    )
    expect(guasto, 'nessun log della ricerca account fallita').toBeTruthy()
    expect(guasto![0]).toBe('auth')
    expect(guasto![1]).toBe('error')
    expect(String((guasto![3] as { message?: string })?.message)).toMatch(/listUsers/)

    // Fail-closed: non sapere se l'account esiste NON autorizza a crearne uno.
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('ECCEZIONE dentro `ensureStaffIdentity`: 503 stabile, mai il testo del throw', async () => {
    // Il `catch` finale prende QUALUNQUE eccezione — un guasto di rete, un bug,
    // un errore di una libreria — e il suo `message` non è scritto da noi: può
    // contenere una query, un header, un indirizzo. Nessuna di queste cose si
    // mostra a chi ha premuto «Approva».
    h.state.eccezioneCreazioneAuth =
      'connect ECONNREFUSED 10.0.0.7:5432 — supabase_admin@db.interno password=segreta'
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(
      body.error,
      'il testo grezzo dell’eccezione è finito nella risposta HTTP',
    ).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|password|supabase_admin/i)

    const guasto = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'identita-staff-non-completata',
    )
    expect(guasto, 'un `catch` che non logga è un bug').toBeTruthy()
    expect(guasto![0]).toBe('auth')
    expect(guasto![1]).toBe('error')
    expect(String((guasto![3] as { message?: string })?.message)).toMatch(/ECONNREFUSED/)

    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('colonna `utente_id` assente sulla CHIUSURA: l’audit NON dichiara un legame che non c’è', async () => {
    // Il degrado su colonna assente vale anche per l'UPDATE, e lì è più insidioso
    // che sull'INSERT: togliere `utente_id` dal patch lascia passare l'istruzione
    // (`stato` c'è ancora), l'UPDATE ritorna una riga, e `chiusura_riuscita`
    // resta `true`. La riga risulta «approvata» e NON è legata a nessun account,
    // mentre l'audit — il registro immutabile — dichiara `utente_id: <uid>`.
    // È la stessa «audit che mente» già tolta dal ramo della chiusura fallita,
    // spostata di un ramo.
    h.state.colonneAssentiUpdate = ['utente_id']
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Ciò che è successo DAVVERO: lo stato è passato, il legame no.
    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('approvata')
    expect(cand.utente_id, 'la colonna non esiste: non può esserci finita niente').toBeUndefined()

    // L'operatore lo legge, e il messaggio NOMINA la colonna caduta.
    expect(body.warnings.join(' ')).toMatch(/utente_id/)

    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo.stato).toBe('approvata')
    expect(
      audit.valoreDopo.utente_id,
      'l’audit dichiara legata all’account una riga in cui `utente_id` non è stato scritto',
    ).toBeNull()
    // …ma l'uid dell'account NON si perde: l'account esiste, le credenziali sono
    // partite, e questo è l'unico registro DUREVOLE (`app_log` dura 30 giorni).
    expect(audit.valoreDopo.account_uid).toBe('auth-1')

    // Il battito distingue le due cose, invece di confonderle in una sola.
    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'candidatura-approvata',
    )
    expect(battito, 'lo stato È passato: il battito del successo ci va').toBeTruthy()
    expect((battito![2] as { chiusura_riuscita?: boolean }).chiusura_riuscita).toBe(true)
    expect((battito![2] as { utente_id_scritto?: boolean }).utente_id_scritto).toBe(false)

    // E la colonna caduta si legge per nome nel log, come già per `gradi`.
    const caduta = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'colonna-assente-rimossa',
    )
    expect(caduta, 'nessun log della colonna caduta sull’UPDATE').toBeTruthy()
    expect((caduta![2] as { msg?: string }).msg).toMatch(/utente_id/)
  })

  it('lettura di `utenti` FALLITA: 503, zero account e zero righe — mai «email libera»', async () => {
    // PostgREST non lancia: senza il controllo su `{ error }` una lettura fallita
    // si travestirebbe da «nessuno ha questa email» e creerebbe il SECONDO account
    // su un indirizzo che è già di qualcuno dello staff. L'email arriva da un
    // modulo pubblico anonimo: un errore transitorio basta.
    h.state.erroriTabella.utenti = { code: '08006', message: 'connection failure' }
    const res = await approva()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('lettura di `parents` FALLITA: 503, e nessun profilo docente sull’uid di un genitore', async () => {
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    h.state.erroriTabella.parents = { code: '08006', message: 'connection failure' }
    const res = await approva()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('email già in `utenti` con MAIUSCOLE diverse: 409, non un 503 grezzo di PostgREST', async () => {
    // Il confronto per email copre le forme esatte; `utenti_email_key` è UNIQUE
    // SENSIBILE alle maiuscole, quindi non chiude il buco al posto del codice.
    // Chi lo chiude è il confronto per UID — dove le maiuscole non esistono.
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      {
        id: 'auth-preesistente',
        email: 'Prova.Candidata@Example.test',
        ruolo: 'segreteria',
        nome: 'Altra',
        cognome: 'Persona',
        scuola_id: SEDE_A,
      },
    ]
    const res = await approva()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURA_EMAIL_GIA_STAFF')
    expect(body.ruoloEsistente).toBe('segreteria')
    expect(h.state.inserimenti, 'un secondo profilo sullo stesso uid').toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('CHIUSURA fallita: 200 che dichiara `in_approvazione`, mai «approvata» a vuoto', async () => {
    h.state.erroreChiusura = { code: '08006', message: 'connection failure' }
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    // Lo stato RESTITUITO è quello VERO: in tabella la riga è ferma, e dirla
    // «approvata» sarebbe una risposta bugiarda con un account già creato dietro.
    expect(body.stato).toBe('in_approvazione')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('in_approvazione')
    expect(body.warnings.join(' ')).toMatch(/NON ripremere/)

    const marcata = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'approvazione-non-marcata',
    )
    expect(marcata, 'la chiusura fallita non ha loggato').toBeTruthy()
    expect(marcata![1]).toBe('error')

    // ── E ORA LA METÀ CHE MANCAVA ───────────────────────────────────────────
    // La risposta HTTP dice la verità, ma l'AUDIT è il registro IMMUTABILE delle
    // scritture su dati di minori: se lì dentro c'è scritto «approvata» mentre in
    // tabella la riga è ferma su `in_approvazione` e `utente_id` è NULL, la bugia
    // non è stata tolta — è stata spostata dove nessuno la rilegge più.
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(
      audit.valoreDopo.stato,
      'l’audit dichiara «approvata» una riga rimasta in `in_approvazione`',
    ).not.toBe('approvata')
    expect(audit.valoreDopo.stato).toBe('in_approvazione')
    expect(
      audit.valoreDopo.chiusura_riuscita,
      'l’audit non dichiara che la chiusura NON è riuscita: la riga non è più rileggibile',
    ).toBe(false)

    // Il BATTITO dell'approvazione RIUSCITA non deve uscire: è il conteggio con cui
    // si distingue «non si approva nessuno» da «l'approvazione non parte più», e un
    // `candidatura-approvata` emesso qui lo falserebbe di uno a ogni guasto.
    const falsoBattito = h.logEvento.mock.calls.find(
      (c) =>
        c[0] === 'candidatura' &&
        c[1] === 'info' &&
        (c[2] as { esito?: string })?.esito === 'candidatura-approvata',
    )
    expect(
      falsoBattito,
      'battito `candidatura-approvata` a `info` su una chiusura FALLITA: il conteggio mente',
    ).toBeFalsy()

    // …ma il gesto si chiude lo stesso a registro, con un esito che lo qualifica.
    const battitoNonMarcato = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'candidatura-approvata-non-marcata',
    )
    expect(battitoNonMarcato, 'nessun battito che chiuda il gesto non marcato').toBeTruthy()
    expect(battitoNonMarcato![0]).toBe('candidatura')
    expect(battitoNonMarcato![1]).toBe('warn')
    expect((battitoNonMarcato![2] as { chiusura_riuscita?: boolean }).chiusura_riuscita).toBe(false)
  })

  it('account PREESISTENTE riusato: nessuna password, NESSUNA email, e l’avviso lo dice', async () => {
    // C'è un accesso con quell'email, ma non è né staff né genitore: l'account si
    // riusa. Non nasce nessuna password, quindi non c'è niente da spedire — e
    // mandare l'email delle credenziali con una password vuota a una persona vera
    // sarebbe il peggiore degli esiti.
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.credentials, 'una password per un account che non è nato adesso').toBeNull()
    expect(body.credentialsEmailSent).toBe(false)
    expect(h.sendEmail, 'email delle credenziali partita senza password').not.toHaveBeenCalled()
    expect(h.state.creazioniAuth).toEqual([])
    expect(body.warnings.join(' ')).toMatch(/riusato|già un accesso/i)

    // …e la candidatura si chiude comunque, legata all'account esistente.
    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('approvata')
    expect(cand.utente_id).toBe('auth-preesistente')
    expect(rigaUtenti()!.id).toBe('auth-preesistente')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Le affermazioni che il file DICHIARA e che nessuno teneva ferme
  // ───────────────────────────────────────────────────────────────────────────

  it('l’email delle credenziali è quella dello STAFF, non il testo del genitore', async () => {
    await approva()
    const invio = h.sendEmail.mock.calls[0][0] as { text: string }
    // Il corpo del genitore dice «la tua iscrizione a <sede> è stata registrata»
    // e manda «all'area genitori»: sarebbe partito, con la password dentro, a una
    // persona che si è candidata per lavorare.
    expect(invio.text, 'parte il corpo del GENITORE').not.toMatch(/iscrizione/i)
    expect(invio.text).not.toMatch(/area genitori/i)
    expect(invio.text).not.toMatch(/Gentile genitore/i)
    // …e resta un'email di credenziali vera.
    expect(invio.text).toContain('Password temporanea:')
    expect(invio.text).toContain(EMAIL)
  })

  it('l’AUDIT del gesto c’è, con il tipo e la SEDE della candidatura', async () => {
    await approva()
    expect(h.logScrittura, 'il gesto che crea un account docente non è nell’audit').toHaveBeenCalledTimes(1)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.entitaTipo).toBe('candidatura')
    expect(arg.entitaId).toBe(CANDIDATURA_ID)
    expect(arg.azione).toBe('update')
    expect(arg.scuolaId, 'l’audit archivia il gesto nella sede sbagliata').toBe(SEDE_B)
    // Il CONTENUTO, non solo l'intestazione: senza queste due righe `valoreDopo`
    // può dire qualunque cosa (`stato: 'boh'`) e restare verde.
    const dopo = arg.valoreDopo as Record<string, unknown>
    expect(dopo.stato).toBe('approvata')
    expect(dopo.chiusura_riuscita).toBe(true)
    expect(dopo.utente_id).toBe('auth-1')
    expect(dopo.account_creato).toBe(true)
  })

  it('il BATTITO dell’approvazione riuscita esiste (senza, «nessun log» non dice niente)', async () => {
    await approva()
    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'candidatura-approvata',
    )
    expect(battito, 'nessun log del SUCCESSO dell’approvazione').toBeTruthy()
    expect(battito![0]).toBe('candidatura')
    expect(battito![1]).toBe('info')
    expect((battito![2] as { sede_id?: string }).sede_id).toBe(SEDE_B)
    expect((battito![2] as { chiusura_riuscita?: boolean }).chiusura_riuscita).toBe(true)
  })

  it('l’email del profilo `utenti` si archivia MINUSCOLA, com’è in `auth.users`', async () => {
    // `utenti_email_key` è UNIQUE **sensibile alle maiuscole**, e il confronto del
    // punto 1 di `ensureStaffIdentity` cerca solo la forma digitata e la sua
    // minuscola. Finché questa riga scriveva l'email COM'È STATA DIGITATA, il file
    // produceva da sé le varianti di caso che poi non sapeva più riconoscere: un
    // secondo profilo per la stessa persona, cioè il registro diviso in due.
    // GoTrue archivia l'indirizzo in minuscolo: scriverlo qui in un'altra forma
    // significa anche due verità sulla stessa persona in due tabelle.
    h.state.tabelle.candidature_insegnanti[0].email = 'Prova.Candidata@Example.test'
    const res = await approva()
    expect(res.status).toBe(200)
    expect(rigaUtenti()!.email).toBe('prova.candidata@example.test')
  })

  it('le fasce FUORI enum vengono scartate: un valore inventato non arriva all’INSERT', async () => {
    h.state.tabelle.candidature_insegnanti[0].gradi = ['nido', 'marziano', 'infanzia', 'nido']
    await approva()
    // Un valore fuori dall'enum `school_type_enum` prende `22P02` all'INSERT, e il
    // duplicato è solo rumore.
    expect(rigaUtenti()!.gradi).toEqual(['nido', 'infanzia'])
  })

  it('ogni UPDATE della candidatura porta il filtro di SEDE nella stessa istruzione', async () => {
    await approva()
    const suCandidature = h.state.aggiornamenti.filter((a) => a.table === 'candidature_insegnanti')
    expect(suCandidature.length, 'nessun UPDATE registrato').toBeGreaterThan(0)
    for (const agg of suCandidature) {
      expect(
        agg.filtri.some((f) => f.col === 'scuola_id'),
        `un UPDATE (${JSON.stringify(agg.patch.stato)}) scrive senza filtro di sede`,
      ).toBe(true)
    }
  })

  it('candidatura di un’altra sede: 404 identico all’inesistente, e nessuna scrittura', async () => {
    h.state.scuole = [SEDE_A]
    const res = await approva()
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CANDIDATURA_NON_TROVATA')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // LE CANDIDATURE CHE NON FANNO NASCERE NESSUN ACCOUNT
  //
  // Dal 2026-08-15 `/lavora-con-noi` non raccoglie più soltanto insegnanti:
  // l'elenco delle posizioni ne porta sette, e quattro (`collaboratrice`, `cuoca`,
  // `segreteria`, `altro`) non insegnano. L'unico account che questa rotta sa
  // creare è `ruolo: 'educator'`, che legge l'anagrafica dei bambini — nomi,
  // allergie, note mediche — quindi per quelle quattro non se ne crea nessuno.
  //
  // Ciò che segue misura le due metà di quella frase: che il ramo faccia ciò che
  // dice (una sola scrittura di stato, niente account, niente email) e che il
  // DUBBIO cada dalla parte giusta — una riga di cui non si conoscono le posizioni
  // non autorizza un accesso all'anagrafica dei minori.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Le posizioni della candidatura di lavoro, per il caso in esame. */
  const conPosizioni = (...posizioni: string[]) => {
    h.state.tabelle.candidature_insegnanti[0].posizioni = posizioni
  }
  /** Le scritture di stato sulla candidatura: quante sono, e con quale `WHERE`. */
  const scrittureStato = () => h.state.aggiornamenti.filter((a) => a.table === 'candidature_insegnanti')
  /** `ensureStaffIdentity` comincia SEMPRE con una SELECT su `utenti`: zero letture = mai chiamata. */
  const lettureUtenti = () => h.state.letture.filter((l) => l.table === 'utenti')

  it('le posizioni usate da questi test esistono nell’elenco del modulo (e quindi in tabella)', () => {
    for (const posizione of ['insegnante_nido', 'insegnante_infanzia', 'cuoca', 'collaboratrice']) {
      expect(
        POSIZIONI_AMMESSE,
        `«${posizione}» non è fra le posizioni ammesse: il CHECK della colonna rifiuterebbe questa riga`,
      ).toContain(posizione)
    }
  })

  it('posizione NON docente (`cuoca`): approvata, e non nasce NIENTE', async () => {
    conPosizioni('cuoca')
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.stato).toBe('approvata')
    // La terza storia si LEGGE, non si deduce: `credentials === null` da solo
    // manderebbe la segreteria a cercare l'accesso preesistente del ramo «riusato».
    expect(body.esitoAccount).toBe('nessuno')
    expect(body.credentials).toBeNull()
    expect(body.credentialsEmailSent).toBe(false)

    // In tabella la riga è approvata per davvero.
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')

    // …e non è nato nessun accesso all'anagrafica dei bambini, in nessuna delle
    // tre forme in cui potrebbe nascere.
    expect(h.state.creazioniAuth, 'creato un account per una candidatura non docente').toEqual([])
    expect(h.state.authUsers).toEqual([])
    expect(h.state.inserimenti, 'scritta una riga `utenti` per una candidatura non docente').toEqual([])
    // `ensureStaffIdentity` non è stata nemmeno chiamata: le sue due prime
    // istruzioni sono una SELECT su `utenti` e una `listUsers`.
    expect(lettureUtenti(), '`ensureStaffIdentity` è partita: ha letto `utenti`').toEqual([])
    expect(h.state.chiamateListUsers).toBe(0)
    // Nessuna password generata ⇒ niente da spedire. Un'email di credenziali con
    // dentro una password vuota partirebbe verso una persona vera.
    expect(h.sendEmail, 'email delle credenziali partita senza account e senza password').not.toHaveBeenCalled()
  })

  it('posizioni MISTE (`cuoca` + `insegnante_nido`): una sola posizione docente basta, e l’account nasce', async () => {
    // Chi cerca lavoro in una scuola dell'infanzia si propone spesso per più cose
    // insieme. La domanda del ramo non è «è SOLO un'insegnante?» ma «insegna anche?»:
    // rispondere «no» qui vorrebbe dire approvare una maestra senza darle l'accesso
    // che le serve per lavorare, e nessun avviso lo direbbe.
    conPosizioni('cuoca', 'insegnante_nido')
    h.state.tabelle.candidature_insegnanti[0].gradi = ['nido']
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.esitoAccount).toBe('creato')
    expect(h.state.creazioniAuth).toHaveLength(1)
    expect(rigaUtenti()!.ruolo).toBe('educator')
    expect(rigaUtenti()!.gradi).toEqual(['nido'])
    expect(body.credentials.password).toBeTruthy()
  })

  it('senza account: UNA sola scrittura di stato, `pending → approvata`, mai `in_approvazione`', async () => {
    // Il claim in due tempi esiste per chiudere la corsa fra due clic MENTRE si
    // crea un account e si spedisce una password. Qui non si crea e non si
    // spedisce niente: quel doppio passo non proteggerebbe nulla e costerebbe una
    // riga bloccata in `in_approvazione` — stato che l'interfaccia racconta come
    // «l'account docente È STATO CREATO» e che spegne per sempre i due pulsanti,
    // perché il claim pretende `pending`.
    conPosizioni('collaboratrice')
    expect((await approva()).status).toBe(200)

    const scritture = scrittureStato()
    expect(scritture, 'più di una scrittura di stato: il ramo passa ancora dal claim').toHaveLength(1)
    expect(scritture[0].patch.stato).toBe('approvata')
    // L'atomicità sta nel `WHERE`, non in un lock: lo stato di partenza è nella
    // stessa istruzione che scrive.
    expect(scritture[0].filtri.find((f) => f.col === 'stato')?.vals).toEqual(['pending'])
    // …e la sede pure: un UPDATE senza filtro di sede scrive nel plesso sbagliato.
    expect(
      scritture[0].filtri.some((f) => f.col === 'scuola_id'),
      'la scrittura senza account non porta il filtro di sede',
    ).toBe(true)
    // `utente_id` non è nemmeno NOMINATA nel patch: nominarla la esporrebbe al
    // ciclo di degrado, che la conterebbe fra le colonne cadute e produrrebbe un
    // avviso all'operatore su una colonna che non si voleva scrivere.
    expect('utente_id' in scritture[0].patch, '`utente_id` nel patch del ramo senza account').toBe(false)
    expect(h.state.tabelle.candidature_insegnanti[0].utente_id).toBeUndefined()
  })

  it('senza account, seconda «Approva»: zero righe ⇒ 409, e la prima resta l’unica', async () => {
    conPosizioni('cuoca')
    expect((await approva()).status).toBe(200)
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    // La seconda istruzione parte (è il `WHERE` a non trovare niente, ed è così
    // che si chiude la corsa) ma non riscrive `evasa_da`/`evasa_il` di nessuno.
    expect(h.state.tabelle.candidature_insegnanti[0].evasa_da).toBe(ADMIN.id)
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
  })

  it('senza account: l’AUDIT dice `utente_id: null`, `account_uid: null`, `account_creato: false`', async () => {
    conPosizioni('segreteria')
    await approva()
    expect(h.logScrittura, 'il gesto non è nell’audit').toHaveBeenCalledTimes(1)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.entitaTipo).toBe('candidatura')
    expect(arg.entitaId).toBe(CANDIDATURA_ID)
    expect(arg.scuolaId, 'l’audit archivia il gesto nella sede sbagliata').toBe(SEDE_B)

    const dopo = arg.valoreDopo as Record<string, unknown>
    expect(dopo.stato).toBe('approvata')
    expect(dopo.chiusura_riuscita).toBe(true)
    expect(dopo.account_creato).toBe(false)
    // ESPLICITI, non omessi: la domanda che qualcuno farà a questo registro fra
    // mesi è «a quale account è legata questa candidatura?», e «la chiave non
    // c'era» si legge diverso da «la chiave valeva null». La risposta vera è «a
    // nessuno, e apposta».
    expect(dopo).toHaveProperty('utente_id', null)
    expect(dopo).toHaveProperty('account_uid', null)
  })

  it('senza account: il battito è `candidatura-approvata-senza-account`, e non gonfia le assunzioni', async () => {
    conPosizioni('cuoca', 'altro')
    await approva()

    // `candidatura-approvata` è il conteggio delle assunzioni VERE («quante
    // insegnanti sono state assunte questo mese?»): una riga emessa qui lo
    // gonfierebbe con approvazioni che non hanno prodotto nessun account.
    const assunzione = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'candidatura-approvata',
    )
    expect(assunzione, 'battito `candidatura-approvata` su un’approvazione SENZA account').toBeFalsy()

    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'candidatura-approvata-senza-account',
    )
    expect(battito, 'nessun battito del ramo senza account: «nessun log» non direbbe niente').toBeTruthy()
    expect(battito![0]).toBe('candidatura')
    expect(battito![1]).toBe('info')
    const payload = battito![2] as Record<string, unknown>
    expect(payload.sede_id).toBe(SEDE_B)
    expect(payload.account_creato).toBe(false)
    // QUANTE posizioni, mai QUALI: a chi interroga `app_log` serve sapere che il
    // ramo è stato preso, non che lavoro cercava quella persona.
    expect(payload.n_posizioni).toBe(2)
    expect(
      JSON.stringify(payload),
      'nel battito finisce il MESTIERE per cui una persona si è candidata',
    ).not.toMatch(/cuoca|altro|insegnante_/)
  })

  it('ramo docente: `esitoAccount: \'creato\'`, e la lettura pre-PATCH chiede davvero `posizioni`', async () => {
    const body = await (await approva()).json()
    expect(body.esitoAccount).toBe('creato')

    // La colonna su cui si DECIDE deve stare nella proiezione: toglierla da
    // `COLONNE_DECISIONE` non farebbe rossa nessuna query — farebbe rispondere
    // «nessun account» a OGNI approvazione, in silenzio e per tutte.
    const preLettura = h.state.letture.find((l) => l.table === 'candidature_insegnanti')
    expect(preLettura, 'nessuna lettura della candidatura prima della PATCH').toBeTruthy()
    expect(preLettura!.cols.split(',').map((c) => c.trim())).toContain('posizioni')
  })

  it('ramo docente: `esitoAccount: \'riusato\'` quando quell’email aveva già un accesso', async () => {
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    const body = await (await approva()).json()
    expect(body.esitoAccount).toBe('riusato')
    // …che è una storia diversa da «nessuno», e le due si distinguono proprio qui:
    // `credentials: null` vale per entrambe.
    expect(body.credentials).toBeNull()
    expect(h.state.creazioniAuth).toEqual([])
    expect(rigaUtenti()!.id).toBe('auth-preesistente')
  })

  it('riga SENZA `posizioni`: nessun account — il dubbio cade dalla parte dei bambini', async () => {
    // È la riga che arriva da un database in cui quella colonna non esiste, e la
    // domanda a cui si risponde è «va creato un account che legge l'anagrafica dei
    // minori?». Su quella domanda «non lo so» vale «no».
    delete h.state.tabelle.candidature_insegnanti[0].posizioni
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stato).toBe('approvata')
    expect(body.esitoAccount, 'account docente creato su una riga di cui non si conosce la posizione').toBe('nessuno')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])
    expect(lettureUtenti()).toEqual([])
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('colonna `posizioni` assente sul database: la proiezione degrada, e degrada verso «nessun account»', async () => {
    // Il DB E2E della CI non è migrato: una proiezione esplicita che chiede
    // `posizioni` prende `42703`. `conResilienza` toglie la colonna e riprova —
    // quindi la PATCH non muore — ma ciò che rilegge è una riga senza posizioni, e
    // da lì l'account non nasce. Il degrado è silenzioso sull'esito HTTP e RUMOROSO
    // nel log: è l'unico posto in cui il nome della colonna caduta si legge.
    h.state.colonneAssentiSelect = ['posizioni']
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.esitoAccount).toBe('nessuno')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti).toEqual([])

    // Il secondo tentativo è partito senza la colonna: senza questa riga il test
    // non distinguerebbe «degradato» da «mai chiesta».
    const lettureCandidatura = h.state.letture.filter((l) => l.table === 'candidature_insegnanti')
    expect(lettureCandidatura.length, 'la lettura non è stata ritentata').toBeGreaterThan(1)
    expect(lettureCandidatura[0].cols).toMatch(/posizioni/)
    expect(lettureCandidatura[lettureCandidatura.length - 1].cols).not.toMatch(/posizioni/)

    const caduta = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'colonna-assente-rimossa',
    )
    expect(caduta, 'la colonna caduta non è stata loggata: il degrado sarebbe invisibile').toBeTruthy()
    expect(caduta![0]).toBe('candidatura')
    expect(caduta![1]).toBe('warn')
    expect((caduta![2] as { msg?: string }).msg).toMatch(/proiezione: posizioni/)
    expect((caduta![2] as { error_code?: string }).error_code).toBe('42703')
  })
})
