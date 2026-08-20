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
  const senzaEmbed = cols.replace(/[\w:]*candidature_sedi(!inner)?\s*\([^)]*\)/g, '')
  for (const c of senzaEmbed.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

/** Le righe di sede di una candidatura, dal magazzino del finto. */
function sediFinteDi(tabelle: Record<string, Riga[]>, idCandidatura: unknown): Riga[] {
  return (tabelle['candidature_sedi'] ?? []).filter((s) => s.candidatura_id === idCandidatura)
}

/**
 * IL TRIGGER `candidature_sedi_aggrega`, RIFATTO NEL FINTO.
 *
 * In produzione lo stato di `candidature_insegnanti` non lo scrive più la rotta:
 * lo ricalcola un trigger dalle righe di sede. Un finto che non lo simulasse
 * lascerebbe la candidatura a `pending` per sempre — e qualcuno, per far passare
 * i test, rimetterebbe nella rotta la scrittura diretta, reintroducendo le due
 * autorità sulla stessa colonna che la migrazione ha appena tolto.
 */
function aggregaComeIlTrigger(tabelle: Record<string, Riga[]>, idCandidatura: unknown): void {
  const sedi = sediFinteDi(tabelle, idCandidatura)
  if (sedi.length === 0) return
  const stato = sedi.some((s) => s.stato === 'pending')
    ? 'pending'
    : sedi.some((s) => s.stato === 'approvata')
      ? 'approvata'
      : 'rifiutata'
  /**
   * ⚠️ IL FINTO PROPAGA ANCHE `evasa_il` ED `evasa_da`, e prima no.
   *
   * Riprodurre il solo `stato` lasciava senza copertura la metà del trigger che
   * esiste per il GDPR: `retention-candidature` legge `candidature_insegnanti.evasa_il`
   * per far decorrere i dodici mesi dalla DECISIONE invece che dalla ricezione.
   * Un ritorno alla versione del 19/08 — quella che riportava solo lo stato —
   * sarebbe rimasto verde, e la cancellazione anticipata sarebbe tornata senza
   * che un test lo dicesse.
   *
   * Stessa regola del database: la data è la PIÙ RECENTE, e solo quando nessuna
   * sede è più in valutazione; i due campi si muovono insieme, senza `coalesce`.
   */
  const decise = sedi.filter((s) => s.stato !== 'pending')
  const nessunaInAttesa = decise.length === sedi.length
  const ultima = nessunaInAttesa
    ? decise
        .filter((s) => s.evasa_il)
        .sort((a, b) => String(b.evasa_il).localeCompare(String(a.evasa_il)))[0]
    : undefined
  const madre = (tabelle['candidature_insegnanti'] ?? []).find((c) => c.id === idCandidatura)
  if (madre) {
    madre.stato = stato
    madre.evasa_il = ultima?.evasa_il ?? null
    madre.evasa_da = ultima?.evasa_da ?? null
  }
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      const corrisponde = (r: Riga) =>
        filtri.every((f) => {
          // `candidature_sedi.scuola_id` → il filtro vive sull'EMBED di PostgREST:
          // la candidatura passa se ALMENO UNA delle sue righe di sede
          // corrisponde. Ignorare il punto significherebbe cercare una colonna
          // inesistente e non escludere NIENTE: ogni test d'isolamento
          // diventerebbe verde per costruzione.
          const punto = f.col.indexOf('.')
          if (punto > 0) {
            const tabellaEmbed = f.col.slice(0, punto)
            const colonna = f.col.slice(punto + 1)
            if (tabellaEmbed !== 'candidature_sedi') return true
            return sediFinteDi(h.state.tabelle, r.id).some((s) => f.vals.some((v) => s[colonna] === v))
          }
          return f.vals.some((v) => r[f.col] === v)
        })
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
          // Il trigger: dopo una scrittura sulle righe di sede, lo stato della
          // candidatura si ricalcola. Vedi `aggregaComeIlTrigger`.
          if (table === 'candidature_sedi') {
            for (const r of trovate) aggregaComeIlTrigger(h.state.tabelle, r.candidatura_id)
          }
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
/**
 * ⚠️ `scuola_id` NEL CORPO, dal 2026-08-19.
 *
 * Qui l'operatore ha DUE sedi attive (`h.state.scuole = [SEDE_A, SEDE_B]`) e la
 * candidatura sta su `SEDE_B`: senza dichiarare su quale plesso si sta
 * decidendo, la rotta risponde 400 invece di indovinare. È il contratto di
 * `resolveScuolaScrittura`, e il caso del rifiuto ha il suo test più sotto.
 */
const approva = (extra: Riga = {}) =>
  PATCH(patch({ id: CANDIDATURA_ID, action: 'approva', scuola_id: SEDE_B, ...extra }))

// ⚠️ Non c'è più una `rigaUtenti()`: questa route non inserisce più in `utenti`.
// I casi qui sotto guardano l'ASSENZA di quell'inserimento — che è il punto — e
// una helper che pesca «la riga creata» inviterebbe a scriverne di nuovi che se
// l'aspettano.

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
    // ⚠️ Le righe di sede si seminano SEMPRE insieme alle candidature: dal
    // 2026-08-19 sono il criterio d'accesso del cockpit ED è lì che il verdetto
    // si scrive. Senza, ogni lettura è vuota e ogni scrittura non tocca niente:
    // i test misurerebbero un magazzino vuoto credendo di misurare la rotta.
    // (Le righe vere si aggiungono in coda a questo blocco, vedi `sediPerLeCandidature`.)
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
  h.state.tabelle.candidature_sedi = (h.state.tabelle.candidature_insegnanti ?? []).map((c) => ({
    candidatura_id: c.id,
    scuola_id: c.scuola_id,
    stato: c.stato ?? 'pending',
  }))

  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'x' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: u }
  })
})

describe('candidature insegnanti · approvazione', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // APPROVARE UNA CANDIDATURA NON CREA NESSUN ACCESSO — nemmeno per un'insegnante.
  //
  // Fino al 2026-08-15 questo file conteneva trenta casi sul ramo opposto:
  // l'account docente creato, la password generata, l'email spedita, l'account
  // orfano da annullare, i due 409 sull'email già nota. Sono spariti con il ramo,
  // e non per pigrizia: una candidatura è una domanda di lavoro, e farle produrre
  // un account `educator` — che LEGGE L'ANAGRAFICA DEI BAMBINI — significava che
  // «prendo in considerazione questa persona» consegnava, nello stesso clic, le
  // chiavi del registro di 33 minori a un indirizzo arrivato da un modulo
  // pubblico.
  //
  // L'accesso nasce in un posto solo, ed è l'approvazione dell'ANAGRAFICA del
  // personale: `__tests__/api/pratiche-personale-approva.test.ts` tiene ferma
  // quella metà, email compresa. Qui si tiene ferma questa: che da qui non esca
  // niente.
  // ══════════════════════════════════════════════════════════════════════════

  it('candidatura DOCENTE approvata: nessun account, nessuna password, nessuna email', async () => {
    // La candidatura di partenza porta posizioni da insegnante: è esattamente il
    // caso che PRIMA faceva nascere l'accesso.
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.stato).toBe('approvata')
    expect(body.esitoAccount).toBe('nessuno')
    expect(body.credentials).toBeNull()
    expect(body.credentialsEmailSent).toBe(false)

    // Le tre prove che contano, e sono sul MONDO, non sulla risposta.
    expect(h.state.creazioniAuth, 'è nato un account di accesso').toHaveLength(0)
    expect(
      h.state.inserimenti.filter((i) => i.table === 'utenti'),
      'è nata una riga `utenti`',
    ).toHaveLength(0)
    expect(h.sendEmail, 'è partita un\'email').not.toHaveBeenCalled()
  })

  it('nemmeno con un’email GIÀ NOTA si tocca l’account che esiste', async () => {
    // Il vecchio ramo qui rispondeva 409 («email già di uno staff») oppure riusava
    // l'account e ne riscriveva il profilo. Adesso quell'account non viene nemmeno
    // guardato: approvare una candidatura non è un'operazione sulle identità.
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-preesistente', email: EMAIL, ruolo: 'admin', scuola_id: SEDE_A, gradi: ['primaria'] },
    ]
    const res = await approva()
    expect(res.status).toBe(200)
    expect((await res.json()).esitoAccount).toBe('nessuno')

    expect(h.state.aggiornamenti.filter((a) => a.table === 'utenti')).toHaveLength(0)
    expect(h.state.cancellazioniAuth).toHaveLength(0)
    expect(h.sendEmail).not.toHaveBeenCalled()
    // E il profilo è rimasto quello che era: ruolo, sede e fasce intatti.
    const u = h.state.tabelle.utenti[0]
    expect(u.ruolo).toBe('admin')
    expect(u.scuola_id).toBe(SEDE_A)
    expect(u.gradi).toEqual(['primaria'])
  })

  it('l’unica email che questa route può mandare è quella di ESITO, sul rifiuto', async () => {
    // Non è una prova sull'assenza: `rifiuta` la manda davvero (il suo file la
    // presidia). Qui conta che l'approvazione non abbia nessun canale verso la
    // persona — chi è stato scelto lo sente dalla scuola, non da un messaggio
    // automatico che gli consegna una password.
    await approva()
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('ogni UPDATE porta il filtro di SEDE nella stessa istruzione, e scrive sulla RIGA DI SEDE', async () => {
    // ⚠️ DAL 2026-08-19 IL VERDETTO NON STA PIÙ SULLA CANDIDATURA.
    // Ogni sede valuta per conto suo, quindi l'esito appartiene alla coppia
    // (candidatura, sede) e vive in `candidature_sedi`. Lo `stato` della
    // candidatura è l'AGGREGATO, e lo scrive il trigger.
    await approva()
    const suSedi = h.state.aggiornamenti.filter((a) => a.table === 'candidature_sedi')
    expect(suSedi.length, 'nessun UPDATE sulle righe di sede').toBeGreaterThan(0)
    for (const agg of suSedi) {
      expect(
        agg.filtri.some((f) => f.col === 'scuola_id'),
        `un UPDATE (${JSON.stringify(agg.patch.stato)}) scrive senza filtro di sede`,
      ).toBe(true)
      expect(
        agg.filtri.some((f) => f.col === 'candidatura_id'),
        'un UPDATE scrive senza dire QUALE candidatura',
      ).toBe(true)
    }
    // 🔴 E LA ROTTA NON TOCCA `candidature_insegnanti.stato`. Due autorità sulla
    // stessa colonna — questa rotta e il trigger — prima o poi dicono cose
    // diverse, e la differenza si vedrebbe solo nel caso multi-sede, cioè in
    // quello raro. Il lock è questa riga.
    expect(
      h.state.aggiornamenti.filter((a) => a.table === 'candidature_insegnanti'),
      'la rotta scrive ancora lo stato sulla candidatura: quello lo fa il trigger',
    ).toHaveLength(0)
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
  /**
   * Le scritture di stato, che dal 2026-08-19 stanno sulle RIGHE DI SEDE.
   * Su `candidature_insegnanti` non ce n'è più nessuna: quello stato lo ricalcola
   * il trigger `candidature_sedi_aggrega`.
   */
  const scrittureStato = () => h.state.aggiornamenti.filter((a) => a.table === 'candidature_sedi')
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

  it('posizioni MISTE (`cuoca` + `insegnante_nido`): l’esito è lo stesso delle altre — nessun account', async () => {
    // Questo caso esisteva per provare il CONTRARIO: che una sola posizione docente
    // bastasse a far nascere l'accesso. Dal 2026-08-15 le posizioni non decidono
    // più niente qui, e la prova serve a impedire che il vecchio ramo rientri da
    // una porta laterale — «ma se fra le posizioni c'è insegnante, allora…».
    conPosizioni('cuoca', 'insegnante_nido')
    h.state.tabelle.candidature_insegnanti[0].gradi = ['nido']
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.esitoAccount).toBe('nessuno')
    expect(h.state.creazioniAuth).toHaveLength(0)
    expect(body.credentials).toBeNull()
    expect(h.sendEmail).not.toHaveBeenCalled()
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
    //
    // ⚠️ `evasa_da` sta sulla RIGA DI SEDE, non sulla candidatura: è la sede che
    // evade, e con tre plessi «chi ha deciso» senza «per quale plesso» è
    // un'informazione a metà.
    const rigaDiSede = h.state.tabelle.candidature_sedi.find((x) => x.candidatura_id === CANDIDATURA_ID)
    expect(rigaDiSede?.evasa_da).toBe(ADMIN.id)
    expect(rigaDiSede?.stato).toBe('approvata')
    // …e la candidatura, per aggregazione, è approvata anch'essa.
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')
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

  it('`esitoAccount` è `nessuno` per TUTTE le candidature, e la risposta non ha più altre storie da raccontare', async () => {
    const body = await (await approva()).json()
    expect(body.esitoAccount).toBe('nessuno')
    // `creato` e `riusato` erano le altre due storie, e non possono più accadere:
    // se una di loro ricompare qui, è tornato un ramo che crea accessi.
    expect(['creato', 'riusato']).not.toContain(body.esitoAccount)
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

describe('candidature insegnanti · SU QUALE SEDE si sta decidendo', () => {
  /**
   * ⚠️ QUESTI DUE TEST MANCAVANO, e la revisione critica del 2026-08-20 l'ha
   * dimostrato nel modo che conta: cancellando i due controlli dalla rotta, la
   * suite intera restava VERDE. Uno dei due è il presidio anti-IDOR sull'uuid
   * che arriva dal corpo della richiesta.
   */

  it('🔴 operatore MULTI-SEDE che non dichiara la sede: 400, mai una scelta indovinata', async () => {
    // `h.state.scuole` sono due. Senza `scuola_id` la rotta non sa quale delle
    // due pratiche si stia chiudendo: indovinare vorrebbe dire chiudere il
    // plesso sbagliato, in silenzio.
    const res = await PATCH(patch({ id: CANDIDATURA_ID, action: 'approva' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.state.aggiornamenti).toHaveLength(0)
  })

  it('operatore con UNA sola sede: non deve dichiararla, il server la conosce già', async () => {
    // Obbligarlo a scrivere un uuid che il server già sa vorrebbe dire solo
    // dargli modo di scriverlo sbagliato.
    h.state.scuole = [SEDE_B]
    const res = await PATCH(patch({ id: CANDIDATURA_ID, action: 'approva' }))
    expect(res.status).toBe(200)
  })

  it('🔴 sede dichiarata FUORI dalle proprie: la pratica altrui non si chiude', async () => {
    // L'uuid nel corpo lo scrive il client, e un client può scrivere qualunque
    // cosa. Senza questo controllo chi ha Aversa dichiara Giugliano e chiude una
    // pratica che non è sua.
    const ALTRUI = 'cccccccc-0000-4000-8000-00000000000c'
    const res = await PATCH(patch({ id: CANDIDATURA_ID, action: 'approva', scuola_id: ALTRUI }))
    expect(res.status).toBe(404)
    expect(h.state.aggiornamenti, 'ha scritto su una sede che non è sua').toHaveLength(0)
  })

  it('la scrittura tocca SOLO la sede dichiarata, non tutte quelle dell’operatore', async () => {
    // `cambiaStato` riceve `[sedeDichiarata]`, non `scuole`. Con l'elenco intero
    // un operatore multi-sede chiuderebbe con un clic la pratica di ogni plesso.
    await PATCH(patch({ id: CANDIDATURA_ID, action: 'approva', scuola_id: SEDE_B }))
    const suSedi = h.state.aggiornamenti.filter((a) => a.table === 'candidature_sedi')
    expect(suSedi).toHaveLength(1)
    const filtroSede = suSedi[0].filtri.find((f) => f.col === 'scuola_id')
    expect(filtroSede?.vals).toEqual([SEDE_B])
  })
})
