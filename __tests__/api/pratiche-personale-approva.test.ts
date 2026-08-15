import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// «APPROVA»: il gesto che trasforma una pratica ANONIMA nell'anagrafica vera di una
// dipendente — e, se non ce l'ha ancora, le apre un accesso.
//
// Qui `ensureStaffIdentity` gira DAVVERO (non è mockata): è metà dell'oggetto della
// prova, e mockarla lascerebbe verde proprio ciò che si vuole provare — che l'INSERT
// non tocchi le colonne generate, che la sede scritta sia quella della PRATICA e che
// un'email già nota riusi l'account invece di crearne un secondo.
//
// Le cose che questo file tiene ferme, e perché ciascuna:
//
//  1. EMAIL GIÀ NOTA ⇒ l'account si RIUSA, e `utenti.ruolo`/`scuola_id` restano
//     quelli che erano. È la difesa che impedisce a un modulo pubblico e ANONIMO di
//     promuovere qualcuno o di spostarlo di plesso: chiunque abbia il link potrebbe
//     dichiararsi «admin» di Giugliano, e senza questa prova nessuno se ne
//     accorgerebbe finché non succede.
//  2. EMAIL SCONOSCIUTA ⇒ l'utenza nasce con ruolo `educator` CABLATO, e la Direzione
//     lo viene a sapere. Un accesso all'anagrafica dei bambini nato da una porta
//     anonima è l'unico fatto di questa route che meriti di svegliare qualcuno.
//  3. LA NOTIFICA NON SUONA SULLE ALTRE APPROVAZIONI. Un allarme che parte a ogni
//     gesto viene spento, e allora il giorno in cui conta non lo legge nessuno.
//  4. IL CLAIM ATOMICO: due «Approva» concorrenti danno un 200 e un 409, e nasce UN
//     account solo.
//  5. IL FASCICOLO PORTA `origine_pratica_id` e la pratica RILASCIA i due percorsi
//     (fronte e retro): un oggetto, un proprietario. Senza il primo,
//     `retention-personale` a dieci anni lascerebbe in tabella una pratica orfana con
//     dentro un codice fiscale; senza il secondo, la copia del documento d'identità
//     resterebbe legata a una riga che se la porta per dieci anni, mentre /privacy ne
//     promette dodici mesi.
//  5bis. …E IL RILASCIO È PER FACCIA. Dal 12/08/2026 le scansioni sono DUE, e il
//     travaso degrada una colonna alla volta: su un database a cui manchi solo
//     `documento_retro_path` il fronte passa e il retro no. Azzerarli insieme
//     cancellerebbe dalla pratica l'unico riferimento a un file che nessun'altra riga
//     nomina, e quell'oggetto resterebbe nel bucket per sempre — invisibile alla
//     conservazione e non cancellabile nemmeno su richiesta dell'interessata. È il caso
//     che questo file tiene fermo per primo, perché è quello che nessuno guarderebbe.
//  6. IL FASCICOLO NON SCRITTO NON DIVENTA UN'APPROVAZIONE: la pratica torna
//     `pending`, perché una pratica `approvata` che nessuna anagrafica cita è lo stato
//     che la conservazione dichiara di non saper trattare.
//  7. LE FASCE D'ETÀ DI UN ACCOUNT CHE ESISTE GIÀ NON SI TOCCANO — né riempiendole né
//     svuotandole. `utenti.gradi` NON è una preferenza d'interfaccia: è uno scope di
//     autorizzazione letto lato server, e `api/primaria/classi/route.ts:34` nega
//     l'accesso alle classi su `!ctx.gradi.includes('primaria')`. Fino al 2026-08-12
//     l'approvazione lo riscriveva col valore di una casella di spunta di un modulo
//     PUBBLICO e ANONIMO: misurato `["infanzia"]` → `["primaria"]`, HTTP 200, e l'unico
//     avviso mostrato diceva «RUOLO e SEDE sono rimasti quelli che aveva» senza
//     nominare le fasce. Bastava una spunta sbagliata sul telefono perché una maestra
//     d'infanzia si ritrovasse l'elenco delle classi di primaria — cioè dei bambini.
//  8. UN UPDATE SU `utenti` FALLITO NON SI TRAVESTE DA RIUSCITO. `aggiornaUtente`
//     distingueva «zero righe toccate» ma non «l'istruzione non è passata»: il
//     chiamante riceveva la stessa forma del successo, nessun avviso arrivava a schermo
//     e l'audit dichiarava scritte tre colonne che in tabella erano rimaste com'erano.
//     Un registro che AFFERMA una modifica mai avvenuta è peggio di un registro vuoto.
// =============================================================================

const SEGRETERIA = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_ID = 'dddddddd-0000-4000-8000-00000000000a'
const EMAIL = 'maestra.prova@example.test'
/** Le DUE facce del documento d'identità: due oggetti distinti, due righe di registro. */
const DOC_FRONTE = 'documenti/aaaa/bbbb.jpg'
const DOC_RETRO = 'documenti/aaaa/cccc.jpg'

const h = vi.hoisted(() => ({
  state: {
    tabelle: {} as Record<string, Record<string, unknown>[]>,
    inserimenti: [] as { table: string; row: Record<string, unknown> }[],
    aggiornamenti: [] as { table: string; patch: Record<string, unknown>; filtri: { col: string; vals: unknown[] }[] }[],
    upserts: [] as { table: string; row: Record<string, unknown>; onConflict: string | null }[],
    authUsers: [] as { id: string; email: string }[],
    creazioniAuth: [] as { email: string; password?: string }[],
    cancellazioniAuth: [] as string[],
    erroriTabella: {} as Record<string, { code?: string; message: string }>,
    erroriAggiornamento: {} as Record<string, { code?: string; message: string }>,
    /** Il guasto della SOLA chiusura: vedi la testata di `StatoFinto`. */
    erroreAggiornamentoSuPatch: null as null | {
      table: string
      colonna: string
      valore: unknown
      error: { code?: string; message: string }
    },
    colonneAssenti: {} as Record<string, string[]>,
    erroreStorage: null as null | { message: string },
    urlFirmate: [] as { path: string; secondi: number }[],
    erroreCreazioneAuth: null as null | { message: string; status?: number },
  },
  scuole: [] as string[],
  utente: null as null | { id: string; role: string; scuola_id: string },
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
  notificaEvento: vi.fn(),
  staffScuola: vi.fn(),
  /**
   * L'invio dell'email delle credenziali: qui si controlla se parte, e con che testo.
   * Il parametro è TIPIZZATO anche se il corpo non lo usa: senza, `mock.calls[0][0]`
   * è una tupla vuota e i casi non possono leggere ciò che è stato spedito.
   */
  sendEmail: vi.fn(
    async (messaggio: { to: string; subject: string; text: string; html: string }) =>
      ({ ok: true, inviatoA: messaggio.to } as { ok: boolean; error?: string; inviatoA?: string }),
  ),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: h.staffScuola }))
// Solo `sendEmailDetailed` è finta: il GENERATORE del messaggio resta VERO, ed è
// così che si prova che nel testo finisce davvero la sede della pratica — invece
// di fidarsi di un parametro passato a una funzione mockata.
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: h.sendEmail }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => costruisciClient(h.state as unknown as StatoFinto),
  createClient: async () => costruisciClient(h.state as unknown as StatoFinto),
}))

import { PATCH } from '@/app/api/admin/pratiche-personale/route'

const URL_ROUTE = 'http://localhost/api/admin/pratiche-personale'
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const approva = () => PATCH(patch({ id: PRATICA_ID, action: 'approva' }))

const rigaUtenti = () => h.state.inserimenti.find((i) => i.table === 'utenti')?.row
const fascicolo = () => h.state.upserts.find((u) => u.table === 'anagrafica_personale')
const praticaInTabella = () => h.state.tabelle.pratiche_personale[0]

/**
 * GLI AVVISI SONO CODICI, non frasi — e i test lo asseriscono sui CODICI.
 *
 * Dal 2026-08-12 la route manda `{ codice, parametri }` e la frase la sceglie il
 * catalogo del client: asserire sulla prosa italiana avrebbe legato queste prove
 * all'interfaccia in una lingua sola, cioè al difetto che quel cambio è servito a
 * chiudere. `codici()` è quello che si guarda; `parametri()` serve dove il valore
 * dentro l'avviso È il fatto (il NOME della fascia, il NOME della colonna caduta).
 */
type AvvisoServer = { codice: string; parametri?: Record<string, string | number> }
const avvisi = (body: unknown): AvvisoServer[] =>
  ((body as { warnings?: unknown }).warnings as AvvisoServer[] | undefined) ?? []
const codici = (body: unknown) => avvisi(body).map((a) => a.codice)
const parametri = (body: unknown) =>
  JSON.stringify(avvisi(body).map((a) => a.parametri ?? {}))

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = SEGRETERIA
  h.scuole = [SEDE_A, SEDE_B]
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], authUsers: [], creazioniAuth: [],
    cancellazioniAuth: [], erroriTabella: {}, erroriAggiornamento: {}, colonneAssenti: {},
    erroreAggiornamentoSuPatch: null,
    erroreStorage: null, urlFirmate: [], erroreCreazioneAuth: null,
  })
  h.state.tabelle = {
    pratiche_personale: [
      {
        id: PRATICA_ID,
        // La pratica è di SEDE_B: l'operatore ha SEDE_A come sede primaria e gestisce
        // entrambe. La sede scritta deve essere quella della PRATICA.
        scuola_id: SEDE_B,
        stato: 'pending',
        nome: 'Prova',
        cognome: 'Cognome',
        email: EMAIL,
        telefono: '+39 000 0000000',
        gender: 'F',
        birth_date: '1990-01-01',
        fiscal_code: 'RSSMRA90A41H501U',
        citizenship: 'Italiana',
        address: 'Via Esempio',
        residence_city: 'Comune',
        residence_province: 'NA',
        zip_code: '80014',
        document_type: 'CI',
        document_number: 'AB1234567',
        document_expiry: '2030-01-01',
        documento_fronte_path: DOC_FRONTE,
        documento_retro_path: DOC_RETRO,
        titolo_studio: 'laurea_magistrale',
        gradi: ['nido', 'infanzia'],
        emergenza_nome: 'Persona Terza',
        creata_il: '2026-08-11T08:00:00.000Z',
      },
    ],
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti: [],
    parents: [],
    anagrafica_personale: [],
    // `anagrafica_utente_id` c'è ed è NULL, come in tabella dalla migrazione
    // `20260812194501`: `collegaCaricamenti` filtra su quella colonna — «un oggetto, un
    // proprietario» — e una riga che non la porta affatto non è la riga che il registro
    // vero contiene.
    caricamenti_personale: [
      { percorso: DOC_FRONTE, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
      { percorso: DOC_RETRO, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
    ],
  }
  h.staffScuola.mockResolvedValue(['direzione-1'])
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.utente
    if (!u) return { response: NextResponse.json({ error: 'x' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: u }
  })
})

describe('pratiche personale · approvazione', () => {
  it('email SCONOSCIUTA: nasce l’utenza con ruolo `educator` e la sede della PRATICA', async () => {
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.stato).toBe('approvata')
    expect(body.accountCreato).toBe(true)

    expect(h.state.creazioniAuth).toHaveLength(1)
    expect(h.state.creazioniAuth[0].email).toBe(EMAIL)

    const u = rigaUtenti()
    expect(u, 'nessuna riga `utenti` creata').toBeTruthy()
    // Il ruolo è CABLATO: non è un campo del modulo e non è una scelta di chi approva.
    expect(u!.ruolo).toBe('educator')
    // La sede è quella della PRATICA, non `auth.user.scuola_id`.
    expect(u!.scuola_id).toBe(SEDE_B)
    expect(u!.gradi).toEqual(['nido', 'infanzia'])

    // Le colonne GENERATE non si scrivono mai: l'INSERT fallirebbe, e in silenzio.
    for (const generata of ['role', 'first_name', 'last_name']) {
      expect(generata in u!, `scritta la colonna generata «${generata}»`).toBe(false)
    }

    // La password torna UNA volta sola, nella risposta.
    expect(body.credentials.email).toBe(EMAIL)
    expect(typeof body.credentials.password).toBe('string')
    expect((body.credentials.password as string).length).toBeGreaterThan(10)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // LE CREDENZIALI PARTONO DA QUI, E DA NESSUN ALTRO POSTO.
  //
  // Fino al 2026-08-15 era il contrario: l'approvazione di una CANDIDATURA
  // spediva la password, e questa — che è l'approvazione fatta guardando il
  // documento d'identità della persona — la mostrava soltanto a schermo, in un
  // riquadro che chiudendosi se la portava via. Decisione del titolare: la
  // selezione non consegna accessi, l'anagrafica sì.
  // ══════════════════════════════════════════════════════════════════════════

  it('accesso NUOVO: l’email delle credenziali parte, e nomina la sede della PRATICA', async () => {
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const inviata = h.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string }
    expect(inviata.to).toBe(EMAIL)
    // Il generatore è VERO: la sede nel testo è quella della pratica (SEDE_B), non
    // quella dell'operatore. Con tre plessi «Kidville» da solo non dice a nessuno
    // dove è stata assunta.
    expect(inviata.text).toContain(NOME_SEDE_B)
    expect(inviata.text).not.toContain(NOME_SEDE_A)
    // La password nel corpo è QUELLA tornata a schermo: due copie diverse
    // manderebbero la persona a sbattere contro un login che non si apre.
    expect(inviata.text).toContain(body.credentials.password)

    // E la risposta lo DICE: chi guarda la password a schermo non ha nessun altro
    // modo di sapere se la persona l'ha ricevuta.
    expect(body.credentialsEmailSent).toBe(true)
  })

  it('accesso NUOVO: l’invio riuscito lascia un battito INTERROGABILE, non solo un log di passaggio', async () => {
    await approva()
    // Su `personale`, che è fra gli EVENTI_PERSISTITI: un `info` su `credenziali`
    // vivrebbe qualche giorno sui Runtime Logs e poi sparirebbe, cioè non
    // risponderebbe in SQL alla domanda «le credenziali di quella maestra sono
    // partite davvero?» — l'ambiguità con cui il guasto delle email restò
    // invisibile per mesi.
    const battiti = h.logEvento.mock.calls.filter(
      ([evento, , dati]) => evento === 'personale' && (dati as { esito?: string })?.esito === 'credenziali-inviate',
    )
    expect(battiti).toHaveLength(1)
    const dati = battiti[0][2] as Record<string, unknown>
    expect(dati.canale).toBe('email')
    expect(dati.sede_id).toBe(SEDE_B)
    // E il battito dell'approvazione porta il fatto, così una query sola risponde
    // a «quante approvazioni hanno consegnato un accesso davvero?».
    const approvata = h.logEvento.mock.calls.find(
      ([, , dati]) => (dati as { esito?: string })?.esito === 'pratica-approvata',
    )
    expect((approvata![2] as Record<string, unknown>).credenziali_email_inviata).toBe(true)
  })

  it('email NON partita: 200, l’accesso ESISTE, e l’avviso dice che la password a schermo è l’unica copia', async () => {
    h.sendEmail.mockResolvedValueOnce({ ok: false, error: 'dominio non verificato' })
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    // L'account è nato lo stesso: tacere qui significherebbe far credere che non
    // sia successo niente, e la persona resterebbe senza accesso senza che nessuno
    // lo sappia.
    expect(body.accountCreato).toBe(true)
    expect(body.credentialsEmailSent).toBe(false)
    expect(typeof body.credentials.password).toBe('string')
    expect((body.warnings as { codice: string }[]).map((w) => w.codice)).toContain('credenzialiEmailNonInviata')

    // Il fallimento va a `error` su `credenziali`, che è persistito PER LIVELLO.
    const errori = h.logEvento.mock.calls.filter(
      ([evento, livello]) => evento === 'credenziali' && livello === 'error',
    )
    expect(errori).toHaveLength(1)
    expect((errori[0][2] as Record<string, unknown>).esito).toBe('credenziali-non-inviate')
    // Il motivo tecnico resta nel log e NON esce nell'avviso, che è un codice.
    expect(JSON.stringify(body.warnings)).not.toContain('dominio non verificato')
  })

  it('account PREESISTENTE: nessuna password generata, quindi NESSUNA email', async () => {
    // È il caso normale di questo modulo — la maestra lavora qui da anni — ed è il
    // caso in cui un invio sarebbe un danno: un'email di credenziali senza
    // credenziali, a chi entra col suo accesso di sempre.
    h.state.authUsers = [{ id: 'auth-preesistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-preesistente', email: EMAIL, ruolo: 'admin', scuola_id: SEDE_A, gradi: ['primaria'] },
    ]
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(body.credentials).toBeNull()
    expect(body.credentialsEmailSent).toBe(false)
  })

  it('email SCONOSCIUTA: la DIREZIONE viene avvisata, e l’avviso non porta nomi', async () => {
    await approva()
    expect(h.staffScuola).toHaveBeenCalledTimes(1)
    // I destinatari si cercano nella sede della PRATICA, e sono la Direzione.
    expect(h.staffScuola.mock.calls[0][1]).toBe(SEDE_B)
    expect(h.staffScuola.mock.calls[0][2]).toEqual(['admin', 'coordinator'])

    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const avviso = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
    expect(avviso.tipo).toBe('personale_account_creato')
    expect(avviso.scuolaId).toBe(SEDE_B)
    expect(avviso.utenteIds).toEqual(['direzione-1'])
    // Il nome della SEDE sì (con tre plessi «Kidville» da solo non dice dove), il nome
    // della PERSONA no: una notifica finisce in una push, cioè fuori dall'app e fuori
    // dai permessi di chi la riceve.
    const testo = `${String(avviso.titolo)} ${String(avviso.corpo)}`
    expect(testo).toContain(NOME_SEDE_B)
    expect(testo).not.toMatch(/Prova|Cognome|RSSMRA90A41H501U/)
    expect(testo).not.toContain(EMAIL)
  })

  it('email GIÀ NOTA: 200, account RIUSATO, e `ruolo`/`scuola_id` INVARIATI', async () => {
    // È il caso NORMALE di questo modulo: la maestra lavora qui da anni. Ed è anche il
    // punto in cui un modulo anonimo potrebbe promuovere qualcuno: la pratica dichiara
    // fasce e sede, e `utenti` non deve muoversi di un millimetro.
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      {
        id: 'auth-esistente',
        email: EMAIL,
        ruolo: 'segreteria',
        scuola_id: SEDE_A,
        nome: 'Vecchio',
        cognome: 'Nome',
        cellulare: null,
        gradi: ['primaria'],
        attivo: true,
      },
    ]

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.accountCreato).toBe(false)
    expect(body.credentials).toBeNull()

    // Nessun secondo account, in nessuna delle due tabelle.
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti.filter((i) => i.table === 'utenti')).toEqual([])
    expect(h.state.tabelle.utenti).toHaveLength(1)

    const u = h.state.tabelle.utenti[0]
    expect(u.ruolo, 'la pratica ha promosso/declassato la persona').toBe('segreteria')
    expect(u.scuola_id, 'la pratica ha spostato la persona di plesso').toBe(SEDE_A)
    expect(u.email, 'la pratica ha cambiato l’email di accesso').toBe(EMAIL)
    expect(u.attivo, 'la pratica ha toccato `attivo`').toBe(true)
    // Ciò che invece SI aggiorna: nome, cognome, cellulare.
    expect(u.nome).toBe('Prova')
    expect(u.cognome).toBe('Cognome')
    expect(u.cellulare).toBe('+39 000 0000000')
    // …e ciò che NON si aggiorna, insieme a ruolo e sede: le FASCE. La pratica ne
    // dichiara due (`nido`, `infanzia`), l'account ne ha una diversa, e resta la sua.
    expect(u.gradi, 'un modulo anonimo ha riscritto lo scope delle fasce').toEqual(['primaria'])

    // Nessuna notifica alla Direzione: non è nato nessun accesso, e un allarme che
    // suona a ogni approvazione viene spento.
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('ALTO: la pratica dichiara «primaria», l’account ha «infanzia» — e resta «infanzia»', async () => {
    // IL CASO MISURATO, quello per cui il rilievo esisteva. `utenti.gradi` non è una
    // preferenza d'interfaccia: `loadGradoContext` lo legge lato server e
    // `api/primaria/classi/route.ts:34` risponde 403 su
    // `!ctx.gradi.includes('primaria')`. Le fasce decidono a quali BAMBINI si arriva.
    //
    // Il valore, però, arriva da una casella di spunta di un modulo PUBBLICO e ANONIMO
    // (`personale-template.ts:230`). Non serve malafede: basta una spunta sbagliata sul
    // telefono e una segretaria che quella riga non l'ha guardata — che è lo stesso
    // errore umano che `sposta-sede` tratta come normale.
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      {
        id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B,
        nome: 'X', cognome: 'Y', gradi: ['infanzia'],
      },
    ]
    h.state.tabelle.pratiche_personale[0].gradi = ['primaria']

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // LA MISURA: in tabella le fasce sono ancora quelle dell'account.
    expect(
      h.state.tabelle.utenti[0].gradi,
      'un modulo anonimo ha allargato lo scope delle fasce a `primaria`',
    ).toEqual(['infanzia'])
    // …e non è successo per omissione: `gradi` non compare in NESSUNA istruzione di
    // scrittura su `utenti`. Se un domani rientrasse nell'elenco degli ammessi, questa
    // riga diventa rossa prima che ci arrivi un bambino.
    for (const s of h.state.aggiornamenti.filter((a) => a.table === 'utenti')) {
      expect('gradi' in s.patch, 'l’UPDATE su `utenti` porta di nuovo `gradi`').toBe(false)
    }

    // E LO SI DICE, coi nomi. Prima l'unico avviso era «RUOLO e SEDE sono rimasti
    // quelli che aveva»: enumerava ciò che non era cambiato in modo da far credere che
    // non fosse cambiato nient'altro, mentre le fasce erano appena state riscritte.
    expect(codici(body)).toContain('fasceNonApplicate')
    expect(parametri(body), 'l’avviso non NOMINA la fascia dichiarata').toContain('Primaria (6-11)')
  })

  it('l’UPDATE su `utenti` porta la sede NELL’ISTRUZIONE, e tocca solo TRE colonne', async () => {
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B, nome: 'X', cognome: 'Y', gradi: ['nido'] },
    ]
    await approva()

    const scritture = h.state.aggiornamenti.filter((a) => a.table === 'utenti')
    expect(scritture).toHaveLength(1)
    // La clausola di sede sta nella STESSA istruzione: un gate «da qualche parte
    // nell'handler» si può spostare, duplicare o dimenticare in un ramo.
    const perSede = scritture[0].filtri.find((f) => f.col === 'scuola_id')
    expect(perSede, 'l’UPDATE su `utenti` non porta la clausola di sede').toBeTruthy()
    expect(perSede!.vals).toEqual([SEDE_A, SEDE_B])
    // E le colonne scritte sono SOLO quelle ammesse: mai `ruolo`, mai `scuola_id`, mai
    // `email`, mai `attivo`, mai `gradi` — sono i CINQUE modi in cui un modulo anonimo
    // potrebbe promuovere qualcuno, spostarlo di plesso, dirottargli l'accesso,
    // riattivarlo o allargargli le fasce. Le tre rimaste sono anagrafica: come ti
    // chiami, che numero hai. Nessuna di loro dà accesso a niente.
    expect(Object.keys(scritture[0].patch).sort()).toEqual(['cellulare', 'cognome', 'nome'])
  })

  it('ALTO: la persona sta in un plesso NON gestito — 403, e il FASCICOLO non si scrive', async () => {
    // ⚠️ QUESTA PROVA HA CAMBIATO VERSO IL 2026-08-12, ed è la parte che vale la pena
    // leggere. Prima diceva «200, e il fascicolo si scrive lo stesso: è l'anagrafica di
    // quella persona» — cioè metteva nero su bianco proprio il buco.
    //
    // LA MISURA che l'ha ribaltata: pratica in SEDE_A, account con la stessa email in
    // un plesso FUORI scope, cockpit ristretto ⇒ HTTP 200 e `upsert` su
    // `anagrafica_personale` ESEGUITO — `fiscal_code` e `document_number` del fascicolo
    // di quella persona sovrascritti con quelli di un modulo PUBBLICO e ANONIMO —
    // mentre l'UPDATE su `utenti` veniva correttamente rifiutato dalla sua clausola di
    // sede. Cioè: il presidio c'era sulla tabella meno sensibile e mancava sulla più
    // sensibile, che è quella con codice fiscale, nascita, residenza, domicilio,
    // estremi del documento e il percorso della scansione.
    //
    // `/anagrafica-personale` è pubblico: bastava inviare una pratica con l'email di
    // una collega di un altro plesso. Adesso il gate sta PRIMA del fascicolo, con lo
    // STESSO array di sedi dell'istruzione che scrive.
    const ALTRO_PLESSO = 'cccccccc-0000-4000-8000-0000000000ff'
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      {
        id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: ALTRO_PLESSO,
        nome: 'X', cognome: 'Y', cellulare: '+39 999',
      },
    ]
    h.state.tabelle.anagrafica_personale = [
      { utente_id: 'auth-esistente', fiscal_code: 'VERAAA90A41H501U', document_number: 'AA0000001' },
    ]

    const res = await approva()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.codice).toBe('PRATICA_ACCOUNT_ALTRA_SEDE')

    // LA MISURA CHE CONTA: il fascicolo di quella persona è INTATTO.
    expect(fascicolo(), 'il fascicolo di un altro plesso è stato scritto lo stesso').toBeUndefined()
    expect(h.state.tabelle.anagrafica_personale[0].fiscal_code).toBe('VERAAA90A41H501U')
    expect(h.state.tabelle.anagrafica_personale[0].document_number).toBe('AA0000001')
    // …e nemmeno `utenti`: nome, cognome e cellulare sono quelli di prima.
    expect(h.state.tabelle.utenti[0].nome).toBe('X')
    expect(h.state.tabelle.utenti[0].cellulare).toBe('+39 999')
    // La pratica torna in attesa: il gesto resta ripetibile da chi quel plesso lo
    // gestisce, invece di restare appesa in `in_approvazione` per sempre.
    expect(praticaInTabella().stato).toBe('pending')
  })

  it('la lettura del plesso della persona FALLISCE: 503 fail-closed, fascicolo non scritto', async () => {
    // Una lettura fallita non vale «è nel plesso giusto»: PostgREST non lancia, e
    // trattare l'errore come un permesso è il modo in cui un gate diventa decorativo.
    // Il guasto arriva DOPO che l'identità è stata risolta, quindi si arma solo qui.
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B, nome: 'X', cognome: 'Y' },
    ]
    //
    // ⚠️ IL GUASTO ARRIVA ALLA TERZA LETTURA DI `utenti`, e le prime due non sono un
    // dettaglio: 1) la risoluzione pre-claim dell'account, 2) la stessa domanda dentro
    // `ensureStaffIdentity`. Guastando prima, questa prova diventerebbe VERDE per la
    // ragione sbagliata — 503, pratica `pending`, nessun fascicolo — uscendo però dal
    // fail-closed pre-claim invece che da questo gate. È il motivo per cui sotto si
    // asserisce l'ESITO nel log e non solo lo stato HTTP.
    let letture = 0
    const guasto = { code: '08006', message: 'connection failure' }
    h.state.erroriTabella = new Proxy({} as Record<string, { code?: string; message: string }>, {
      get: (_t, prop) => {
        if (prop !== 'utenti') return undefined
        letture += 1
        return letture >= 3 ? guasto : undefined
      },
    })

    const res = await approva()
    h.state.erroriTabella = {}
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    // È USCITO DA QUESTO GATE, non da un altro.
    const dalGate = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'scope-account-non-risolto',
    )
    expect(dalGate, 'il 503 non viene dal gate di plesso').toHaveLength(1)
    expect(fascicolo(), 'fascicolo scritto su una sede non verificata').toBeUndefined()
    expect(praticaInTabella().stato).toBe('pending')
  })

  it('la persona sta in un ALTRO plesso, ma DENTRO lo scope: si approva, e la sede si NOMINA', async () => {
    // L'unico admin reale gestisce tre plessi: una maestra di Aversa che compila la
    // card di Cesa è un fatto normale, e negarla renderebbe il modulo inutilizzabile
    // proprio per chi lo amministra. Ma il fascicolo atterra sulla PERSONA — cioè su
    // Aversa — mentre l'audit ha per sede quella della pratica: senza dirlo, il
    // registro non risponderebbe a «dove è finito il dato?».
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_A, nome: 'X', cognome: 'Y' },
    ]
    // La pratica è di SEDE_B (vedi il seme), l'account di SEDE_A: due sedi diverse,
    // entrambe gestite da questa postazione.
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(codici(body)).toContain('accountAltraSede')
    // La sede si NOMINA: senza il nome, l'avviso direbbe che qualcosa non torna senza
    // dire dove guardare.
    expect(parametri(body)).toContain(NOME_SEDE_A)
    expect(fascicolo(), 'il fascicolo non è stato scritto').toBeTruthy()
    // E l'audit lo registra: `scuolaId` resta quella della pratica (l'entità è la
    // pratica), `sede_account` dice dove il dato è atterrato.
    const dopo = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(dopo.scuolaId).toBe(SEDE_B)
    expect((dopo.valoreDopo as Record<string, unknown>).sede_account).toBe(SEDE_A)
  })

  it('CLAIM ATOMICO: la seconda approvazione prende 409 e non nasce un secondo account', async () => {
    expect((await approva()).status).toBe(200)
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRATICA_GIA_EVASA')
    expect(h.state.creazioniAuth, 'due account per la stessa pratica').toHaveLength(1)
    expect(h.state.upserts.filter((u) => u.table === 'anagrafica_personale')).toHaveLength(1)
  })

  it('il FASCICOLO nasce con `origine_pratica_id`, e la pratica RILASCIA le DUE scansioni', async () => {
    const res = await approva()
    const body = await res.json()
    const f = fascicolo()
    expect(f, 'nessun upsert su `anagrafica_personale`').toBeTruthy()
    // `onConflict` sulla chiave primaria: chi ricompila il modulo l'anno dopo aggiorna
    // la sua scheda, non prende un `23505`.
    expect(f!.onConflict).toBe('utente_id')
    expect(f!.row.utente_id).toBe('auth-1')
    expect(f!.row.origine_pratica_id).toBe(PRATICA_ID)
    // I file NON si copiano: il fascicolo punta agli STESSI due oggetti…
    //
    // ⚠️ QUESTE DUE RIGHE SONO ANCHE IL LOCK DELLA PREMESSA del terzo guard del
    // rilascio (`colonna in fascicolo`, vedi il commento al punto 9 della route): il
    // giorno in cui `COLONNE_ANAGRAFICA` smettesse di nominare una colonna del
    // documento, il fascicolo non la riceverebbe e queste asserzioni sarebbero le prime
    // a cadere. Misurato allargando `CAMPI_DI_UTENTI` a `documento_retro_path`: 8 test
    // di questo file diventano rossi.
    expect(f!.row.documento_fronte_path).toBe(DOC_FRONTE)
    expect(f!.row.documento_retro_path).toBe(DOC_RETRO)
    // …e la pratica li rilascia tutti e due.
    expect(praticaInTabella().documento_fronte_path).toBeNull()
    expect(praticaInTabella().documento_retro_path).toBeNull()
    // Ed è ciò che la risposta dichiara, faccia per faccia: il pannello smette di
    // offrire ENTRAMBI i pulsanti, che da adesso rispondono 403.
    expect(body.documentiRilasciati).toEqual({ fronte: true, retro: true })
    expect(praticaInTabella().utente_id).toBe('auth-1')
    expect(praticaInTabella().evasa_da).toBe(SEGRETERIA.id)

    // Nel fascicolo NON finiscono i campi che vivono in `utenti`: due verità sulla
    // stessa persona divergono al primo aggiornamento.
    for (const doppione of ['nome', 'cognome', 'email', 'telefono', 'gradi', 'scuola_id', 'ruolo']) {
      expect(doppione in f!.row, `il fascicolo duplica «${doppione}», che vive in utenti`).toBe(false)
    }
  })

  it('nessuna scansione si rilascia se il fascicolo non le ha prese (colonne assenti)', async () => {
    // Se il degrado toglie i percorsi dall'upsert, azzerarli sulla pratica lascerebbe
    // nel bucket due oggetti che nessuna riga nomina: invisibili alla conservazione e
    // non cancellabili nemmeno su richiesta dell'interessata.
    h.state.colonneAssenti = {
      anagrafica_personale: ['documento_fronte_path', 'documento_retro_path'],
    }
    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(codici(body)).toContain('fascicoloParziale')
    expect(parametri(body)).toContain('documento_fronte_path')
    expect(parametri(body)).toContain('documento_retro_path')
    expect(praticaInTabella().documento_fronte_path, 'il fronte è rimasto senza proprietario').toBe(DOC_FRONTE)
    expect(praticaInTabella().documento_retro_path, 'il retro è rimasto senza proprietario').toBe(DOC_RETRO)
    expect(body.documentiRilasciati).toEqual({ fronte: false, retro: false })
    expect(praticaInTabella().stato).toBe('approvata')
  })

  it('🔴 manca SOLO `documento_retro_path`: il fronte si rilascia, il retro NO', async () => {
    /**
     * IL CASO CHE IL BOOLEANO SOLO NON SAPEVA DIRE, ed è quello che costa un documento.
     *
     * Fino al 12/08/2026 il rilascio era una variabile sola (`documentoPassato`) perché
     * la scansione era una sola. Con due facce e un travaso che degrada UNA COLONNA
     * ALLA VOLTA, lo stato normale di un database non ancora migrato è misto: il
     * fascicolo prende il fronte e non il retro. Con un booleano solo le strade erano
     * due, ed erano sbagliate tutte e due:
     *
     *  · in AND («rilascia solo se sono passate entrambe») la pratica si terrebbe anche
     *    il fronte, che il fascicolo ha davvero preso: due righe nominerebbero lo stesso
     *    oggetto, e la conservazione della pratica lo cancellerebbe da sotto
     *    l'anagrafica — a dieci anni contro dodici mesi;
     *  · in OR («ne è passata almeno una») la pratica azzererebbe anche il retro, che
     *    NESSUNO ha preso: quell'oggetto resterebbe nel bucket senza nessuna riga che lo
     *    nomini, quindi invisibile alla conservazione e non cancellabile nemmeno se
     *    l'interessata lo chiedesse. È il difetto peggiore dei due, ed è quello silenzioso.
     *
     * Qui la colonna manca SOLO su `anagrafica_personale`: `pratiche_personale` ce l'ha
     * (è la riga che porta il percorso), ed è esattamente lo stato di un ambiente in cui
     * la migrazione è stata applicata a metà.
     */
    h.state.colonneAssenti = { anagrafica_personale: ['documento_retro_path'] }

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Il fascicolo ha preso il fronte, e SOLO il fronte.
    const f = fascicolo()
    expect(f!.row.documento_fronte_path).toBe(DOC_FRONTE)
    expect('documento_retro_path' in f!.row).toBe(false)

    // La pratica ha rilasciato il fronte…
    expect(praticaInTabella().documento_fronte_path).toBeNull()
    // …e si è TENUTA il retro: è l'unica riga che ancora lo nomini.
    expect(
      praticaInTabella().documento_retro_path,
      'il retro è stato azzerato: quel file non è più nominato da nessuna riga',
    ).toBe(DOC_RETRO)

    // E l'istruzione di chiusura non ha nemmeno NOMINATO la colonna del retro: non è
    // «l'ha scritta col valore giusto», è «non gliel'ha proprio chiesto».
    const chiusura = h.state.aggiornamenti
      .filter((a) => a.table === 'pratiche_personale')
      .at(-1)!
    expect(chiusura.patch.documento_fronte_path).toBeNull()
    expect('documento_retro_path' in chiusura.patch).toBe(false)

    // La risposta lo dice al pannello faccia per faccia: il pulsante del fronte sparisce
    // (da adesso risponde 403), quello del retro RESTA — è l'unica strada verso l'unica
    // copia raggiungibile di quel file.
    expect(body.documentiRilasciati).toEqual({ fronte: true, retro: false })

    // E chi ha premuto lo vede a schermo: il fascicolo è parziale, e si dice quale
    // colonna è caduta.
    expect(codici(body)).toContain('fascicoloParziale')
    expect(parametri(body)).toContain('documento_retro_path')
    expect(parametri(body), 'il fronte non è caduto: dirlo manderebbe a cercare un guasto che non c’è')
      .not.toContain('documento_fronte_path')
    expect(praticaInTabella().stato).toBe('approvata')
  })

  it('la pratica VECCHIA senza retro: si rilascia il fronte, e non si grida per il resto', async () => {
    // Le pratiche arrivate PRIMA del 12/08/2026 hanno il solo fronte (la migrazione ha
    // rinominato `documento_path`). Un retro che non c'è non è un guasto, e non deve
    // produrre né un avviso né una riga di allarme nel registro dei caricamenti.
    delete h.state.tabelle.pratiche_personale[0].documento_retro_path
    h.state.tabelle.caricamenti_personale = [
      { percorso: DOC_FRONTE, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
    ]

    const res = await approva()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.documentiRilasciati).toEqual({ fronte: true, retro: false })
    expect(praticaInTabella().documento_fronte_path).toBeNull()
    expect(codici(body)).toEqual([])
    const allarmi = h.logEvento.mock.calls.filter(
      (c) => c[1] === 'error' || (c[2] as { esito?: string })?.esito === 'caricamento-non-registrato',
    )
    expect(allarmi, 'un retro che non è mai esistito ha fatto suonare un allarme').toEqual([])
  })

  it('il REGISTRO dei caricamenti si guarda UNA volta sola, e non grida sul caso normale', async () => {
    // «Prima si guarda, poi si agisce»: le due righe sono già collegate dalla porta
    // pubblica, quindi non c'è niente da scrivere. Un `error` a ogni approvazione è
    // l'allarme che si impara a ignorare — ed è così che il guasto vero, quando arriva,
    // non lo vede nessuno.
    await approva()
    const scritture = h.state.aggiornamenti.filter((a) => a.table === 'caricamenti_personale')
    expect(scritture, 'il registro è stato riscritto senza motivo').toEqual([])
    const rumore = h.logEvento.mock.calls.filter((c) =>
      ['caricamento-non-registrato', 'caricamento-di-altra-pratica', 'caricamento-non-collegato']
        .includes(String((c[2] as { esito?: string })?.esito)),
    )
    expect(rumore).toEqual([])
  })

  it('la riga del RETRO è rimasta in sospeso: si collega, e senza nominare il percorso', async () => {
    // Il collegamento della porta pubblica è best-effort: se è saltato su una faccia,
    // quell'oggetto risulta «in sospeso» e la spazzata degli orfani lo toglie dal bucket
    // entro poche ore — cioè la Segreteria approverebbe una scheda il cui retro sta per
    // sparire, mentre l'anagrafica lo nomina.
    h.state.tabelle.caricamenti_personale = [
      { percorso: DOC_FRONTE, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
      { percorso: DOC_RETRO, pratica_id: null, anagrafica_utente_id: null },
    ]

    await approva()

    const collegata = h.state.tabelle.caricamenti_personale.find((r) => r.percorso === DOC_RETRO)
    expect(collegata!.pratica_id, 'il retro è rimasto in sospeso: la spazzata lo toglierà').toBe(PRATICA_ID)
    // …e una sola riga è stata toccata: il fronte era già a posto.
    const scritture = h.state.aggiornamenti.filter((a) => a.table === 'caricamenti_personale')
    expect(scritture).toHaveLength(1)
    // MAI il percorso nei log: è la chiave con cui si firma la fotografia di un
    // documento d'identità, e `app_log` è interrogabile in SQL per 30 giorni.
    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain(DOC_FRONTE)
    expect(log).not.toContain(DOC_RETRO)
  })

  it('🔴 la riga è già di un’ANAGRAFICA: non si tenta di collegarla, e il fatto si NOMINA', async () => {
    /**
     * IL FALSO ALLARME CHE QUESTA FUNZIONE DICHIARA DI VOLER EVITARE.
     *
     * La migrazione `20260812194501` ha dato a `caricamenti_personale` un SECONDO
     * proprietario — `anagrafica_utente_id`, per gli oggetti che la Segreteria carica
     * dalla scheda della persona — con `check (num_nonnulls(pratica_id,
     * anagrafica_utente_id) <= 1)`: se c'è quello, `pratica_id` è NULL per costruzione.
     *
     * `assicuraCaricamentiCollegati` leggeva la sola `pratica_id`, quindi classificava
     * quell'oggetto come «in sospeso» e chiamava `collegaCaricamenti`, che filtra
     * `.is('anagrafica_utente_id', null)`: zero righe aggiornate e una riga di livello
     * `error` in `app_log` a ogni approvazione, su uno stato perfettamente sano. È
     * «l'allarme che si impara a ignorare, ed è il modo in cui il guasto vero, quando
     * arriva, non lo vede nessuno» — la frase che sta nel doc-block di questa stessa
     * funzione, e che il codice contraddiceva.
     *
     * Quello che invece va detto: due righe nominano lo stesso file, la conservazione
     * della PRATICA (90 giorni) porterebbe via ciò che il FASCICOLO (dieci anni) usa. È
     * un fatto proprio, con un esito proprio — non «di un'altra pratica», che manderebbe
     * a cercare una pratica che non esiste.
     */
    h.state.tabelle.caricamenti_personale = [
      { percorso: DOC_FRONTE, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
      { percorso: DOC_RETRO, pratica_id: null, anagrafica_utente_id: 'auth-di-un-altra' },
    ]

    await approva()

    // NON si è tentato nessun collegamento: l'oggetto un proprietario ce l'ha.
    expect(
      h.state.aggiornamenti.filter((a) => a.table === 'caricamenti_personale'),
      'si è provato a collegare una riga che è già di un’anagrafica',
    ).toEqual([])
    const esiti = h.logEvento.mock.calls.map((c) => String((c[2] as { esito?: string })?.esito))
    expect(esiti, 'il falso allarme è ancora lì').not.toContain('caricamento-non-collegato')
    expect(esiti).not.toContain('caricamento-non-registrato')

    // …ma il fatto si registra, e con l'aritmetica: quante facce attese, quante già di
    // un'anagrafica. Mai il percorso.
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'caricamento-di-unanagrafica',
    )
    expect(riga, 'due righe nominano lo stesso file e nessuno lo dice').toBeTruthy()
    expect(riga![1]).toBe('error')
    const dati = riga![2] as Record<string, unknown>
    expect(dati.n_attesi).toBe(2)
    expect(dati.n_di_unanagrafica).toBe(1)
    expect(dati.entita_id).toBe(PRATICA_ID)
    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain(DOC_RETRO)
    expect(log).not.toContain('auth-di-un-altra')
  })

  it('🔴 la CHIUSURA non passa: NESSUNA scansione si dichiara rilasciata', async () => {
    /**
     * IL RILASCIO NON È IL TRAVASO, e questa è la prova che li separa.
     *
     * `frontePassato`/`retroPassato` rispondono a «il fascicolo l'ha presa»; il rilascio
     * è l'altra metà, e vive nell'UPDATE di chiusura. Qui il fascicolo prende ENTRAMBE
     * le facce e poi la chiusura non passa — un `CHECK`, un trigger, un permesso sulla
     * singola istruzione, dopo un claim riuscito pochi millisecondi prima.
     *
     * Se la risposta dicesse `documentiRilasciati.fronte = true`, il pannello azzererebbe
     * il percorso in locale e NASCONDEREBBE il pulsante, mentre la pratica quel file lo
     * nomina ancora: la Segreteria perderebbe l'unica strada raggiungibile verso una
     * carta d'identità, e l'audit registrerebbe un rilascio che non è avvenuto. È lo
     * stesso difetto già chiuso per `campi_aggiornati` — «un registro che dichiara una
     * scrittura mai avvenuta manda a cercare, fra un anno, la causa di una modifica che
     * nessuno ha fatto».
     */
    h.state.erroreAggiornamentoSuPatch = {
      table: 'pratiche_personale',
      // Solo la CHIUSURA scrive questo valore: il claim scrive `in_approvazione` e il
      // ripristino `pending`, quindi passano.
      colonna: 'stato',
      valore: 'approvata',
      error: { code: '23514', message: 'violates check constraint' },
    }

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Il fascicolo le ha prese tutte e due…
    const f = fascicolo()
    expect(f!.row.documento_fronte_path).toBe(DOC_FRONTE)
    expect(f!.row.documento_retro_path).toBe(DOC_RETRO)
    // …ma la pratica non ha rilasciato niente, perché l'istruzione non è passata.
    expect(praticaInTabella().stato, 'la chiusura è fallita e la pratica risulta approvata').toBe('in_approvazione')
    expect(praticaInTabella().documento_fronte_path).toBe(DOC_FRONTE)
    expect(praticaInTabella().documento_retro_path).toBe(DOC_RETRO)

    // ED È QUELLO CHE LA RISPOSTA DEVE DIRE: entrambi i pulsanti restano.
    expect(body.documentiRilasciati).toEqual({ fronte: false, retro: false })
    expect(body.stato).toBe('in_approvazione')
    expect(codici(body)).toContain('approvazioneNonMarcata')

    // L'audit non dichiara scritture mai avvenute, e il battito esce a `warn`.
    const dopo = (h.logScrittura.mock.calls[0][1] as Record<string, unknown>).valoreDopo as Record<string, unknown>
    expect(dopo.chiusura_riuscita).toBe(false)
    expect(dopo.documento_fronte_rilasciato).toBe(false)
    expect(dopo.documento_retro_rilasciato).toBe(false)
    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'pratica-approvata-non-marcata',
    )
    expect(battito, 'una chiusura fallita non lascia il suo battito').toBeTruthy()
    expect(battito![1]).toBe('warn')
    const dati = battito![2] as Record<string, unknown>
    expect(dati.documento_fronte_rilasciato).toBe(false)
    expect(dati.documento_retro_rilasciato).toBe(false)
    // Nessuna faccia è passata: «a metà» sarebbe una risposta sbagliata a una domanda
    // giusta, e manderebbe a cercare un oggetto rimasto senza righe che non c'è.
    expect(dati.documento_rilasciato_a_meta).toBe(false)
    // E la riga `pratica-approvata` — il conteggio delle approvazioni VERE — non esiste.
    expect(
      h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === 'pratica-approvata'),
      'una chiusura fallita ha gonfiato il conteggio delle approvazioni riuscite',
    ).toEqual([])
  })

  it('🔴 la CHIUSURA degrada sul FRONTE: si rilascia il retro, e il fronte NON si dichiara', async () => {
    /**
     * LA SECONDA METÀ DELLO STESSO PRESIDIO, e l'unica che distingue le due facce.
     *
     * Qui `pratiche_personale` non ha `documento_fronte_path` — lo stato di un ambiente
     * migrato a metà — quindi `cambiaStato` degrada, TOGLIE quella colonna dal patch e
     * riprova: la chiusura riesce, ma il fronte non è stato azzerato. Il fascicolo però
     * l'ha preso (su `anagrafica_personale` la colonna c'è).
     *
     * Il rilascio va dichiarato PER FACCIA: `retro` sì, `fronte` no. Un booleano solo, o
     * un `rilasciata` che guardasse il solo travaso, direbbe «fronte rilasciato» e il
     * pannello nasconderebbe il pulsante dell'unica copia che la pratica nomina ancora.
     */
    h.state.colonneAssenti = { pratiche_personale: ['documento_fronte_path'] }

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()

    // La chiusura è passata, dopo aver lasciato per strada la colonna del fronte.
    expect(praticaInTabella().stato).toBe('approvata')
    expect(praticaInTabella().documento_fronte_path, 'il fronte risulta azzerato: l’UPDATE non lo ha nemmeno chiesto').toBe(DOC_FRONTE)
    expect(praticaInTabella().documento_retro_path).toBeNull()

    // UNA FACCIA SÌ E UNA NO: è l'unica risposta che permette al pannello di nascondere
    // il pulsante giusto e tenere l'altro.
    expect(body.documentiRilasciati).toEqual({ fronte: false, retro: true })
    expect(codici(body)).toContain('chiusuraParziale')
    expect(parametri(body)).toContain('documento_fronte_path')

    const dopo = (h.logScrittura.mock.calls[0][1] as Record<string, unknown>).valoreDopo as Record<string, unknown>
    expect(dopo.chiusura_riuscita).toBe(true)
    expect(dopo.documento_fronte_rilasciato).toBe(false)
    expect(dopo.documento_retro_rilasciato).toBe(true)

    // ED È ESATTAMENTE LA QUERY PER CUI `documento_rilasciato_a_meta` esiste: «quante
    // pratiche hanno travasato una faccia sola», cioè lo stato in cui un oggetto rischia
    // di restare senza nessuna riga che lo nomini. Se il campo sparisse dal battito,
    // quella domanda non avrebbe più risposta e nessuno se ne accorgerebbe fino al
    // giorno in cui serve.
    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'pratica-approvata',
    )
    expect(battito).toBeTruthy()
    const dati = battito![2] as Record<string, unknown>
    expect(dati.documento_fronte_rilasciato).toBe(false)
    expect(dati.documento_retro_rilasciato).toBe(true)
    expect(dati.documento_rilasciato_a_meta).toBe(true)

    // E il registro dei caricamenti si guarda SOLO sulle facce davvero rilasciate…
    // niente: quella del fronte è ancora della pratica, e non c'è niente da riparare.
    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain(DOC_FRONTE)
    expect(log).not.toContain(DOC_RETRO)
  })

  it('il FASCICOLO non scritto NON diventa un’approvazione: la pratica torna `pending`', async () => {
    h.state.erroriTabella = { anagrafica_personale: { code: '42501', message: 'permission denied' } }
    const res = await approva()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    expect(praticaInTabella().stato, 'pratica bloccata in `in_approvazione`').toBe('pending')
    // L'accesso è nato lo stesso, e va detto: ripremendo «Approva» verrà riusato.
    expect(codici(body)).toEqual(['accountCreatoLoStesso'])
    // La prosa di PostgREST non esce dal server.
    expect(String(body.error)).not.toMatch(/permission denied|schema cache/i)
  })

  it('lettura di `utenti` FALLITA: 503 fail-closed, e la pratica NON è stata toccata', async () => {
    // PostgREST non lancia: senza questo controllo una lettura fallita si
    // travestirebbe da «email libera» e creerebbe il secondo account di chi ce l'ha già.
    h.state.erroriTabella = { utenti: { code: '08006', message: 'connection failure' } }
    const res = await approva()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    expect(h.state.creazioniAuth).toEqual([])
    expect(praticaInTabella().stato).toBe('pending')
    // Nessun claim da disfare: la fase è PRIMA della scrittura.
    expect(h.state.aggiornamenti.filter((a) => a.table === 'pratiche_personale')).toEqual([])
  })

  it('email già di un GENITORE: 409 con codice proprio, e la pratica torna `pending`', async () => {
    h.state.authUsers = [{ id: 'auth-genitore', email: EMAIL }]
    h.state.tabelle.parents = [{ id: 'parent-1', auth_user_id: 'auth-genitore' }]
    const res = await approva()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRATICA_EMAIL_GIA_GENITORE')
    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.upserts).toEqual([])
    expect(praticaInTabella().stato).toBe('pending')
  })

  it('`gradi` VUOTO non cancella le fasce di chi è in servizio, e lo si DICE', async () => {
    // L'altra metà dello stesso presidio: la pratica non porta nessuna fascia valida —
    // una maestra ricompila il modulo per aggiornare il documento e non le rispunta, o
    // le rispunta con un valore fuori enum, che qui viene scartato. Scrivere `{}` sopra
    // le sue fasce le toglierebbe l'accesso alle proprie sezioni, senza nessun errore
    // da nessuna parte: il guasto sarebbe una schermata più povera, e basta.
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      { id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B, nome: 'X', cognome: 'Y', gradi: ['primaria'] },
    ]
    h.state.tabelle.pratiche_personale[0].gradi = ['sezione_primavera']

    const res = await approva()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(codici(body)).toContain('fasceAssentiEsistente')
    expect(h.state.tabelle.utenti[0].gradi, 'le fasce sono state cancellate').toEqual(['primaria'])
    const scritture = h.state.aggiornamenti.filter((a) => a.table === 'utenti')
    for (const s of scritture) expect('gradi' in s.patch).toBe(false)
  })

  it('l’AUDIT dice CHE COSA è stato fatto, e non ne conserva i valori', async () => {
    await approva()
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const voce = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(voce.entitaTipo).toBe('pratica_personale')
    expect(voce.entitaId).toBe(PRATICA_ID)
    expect(voce.scuolaId).toBe(SEDE_B)
    const dopo = voce.valoreDopo as Record<string, unknown>
    expect(dopo.stato).toBe('approvata')
    expect(dopo.account_creato).toBe(true)
    // UNA VOCE PER FACCIA: un solo `documento_rilasciato` messo in AND direbbe «no» su
    // un'approvazione in cui il fronte è passato, e non direbbe MAI quale delle due è
    // rimasta indietro — che è l'unica cosa da sapere per rimediare.
    expect(dopo.documento_fronte_rilasciato).toBe(true)
    expect(dopo.documento_retro_rilasciato).toBe(true)
    // I NOMI delle colonne toccate, mai i valori. `gradi` non c'è più: non è più una
    // colonna che questa route scriva.
    expect(dopo.campi_aggiornati).toEqual(['nome', 'cognome', 'cellulare'])
    expect(dopo.account_non_aggiornato).toBe(false)
    const serializzato = JSON.stringify(dopo)
    expect(serializzato).not.toContain(EMAIL)
    expect(serializzato).not.toContain('RSSMRA90A41H501U')
    expect(serializzato).not.toContain(DOC_FRONTE)
    expect(serializzato).not.toContain(DOC_RETRO)
  })

  it('l’UPDATE su `utenti` FALLISCE: lo si DICE, e l’audit non dichiara scritture mai avvenute', async () => {
    // IL SECONDO RILIEVO MISURATO. `aggiornaUtente` distingueva «zero righe toccate»
    // (→ `fuoriScope`, con avviso a schermo) ma NON «l'istruzione non è passata»: su un
    // errore che non fosse di colonna assente loggava e tornava la STESSA forma del
    // successo. Il chiamante non aveva modo di accorgersene, quindi nessun avviso
    // arrivava a chi aveva premuto, e l'audit registrava tre colonne scritte mentre in
    // tabella non era cambiato niente.
    //
    // Perché conta: il commento della route dice che `campi_aggiornati` è «l'unica
    // informazione con cui, fra un anno, si può rispondere a "chi ha cambiato il
    // cellulare di questa maestra?"». Una risposta FALSA a quella domanda è peggio di
    // nessuna risposta — manda a cercare la causa di una modifica che non esiste.
    h.state.authUsers = [{ id: 'auth-esistente', email: EMAIL }]
    h.state.tabelle.utenti = [
      {
        id: 'auth-esistente', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B,
        nome: 'X', cognome: 'Y', cellulare: '+39 111', gradi: ['infanzia'],
      },
    ]
    // Guasto della SOLA scrittura: le letture su `utenti` riescono, quindi la route
    // arriva davvero fin qui invece di uscire prima a 503.
    h.state.erroriAggiornamento = { utenti: { code: '23514', message: 'violates check constraint' } }

    const res = await approva()
    // 200: l'anagrafica È stata registrata e la pratica va chiusa — ripartire da capo
    // su una persona che il fascicolo ce l'ha già sarebbe peggio.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // In tabella non è cambiato NIENTE: è il fatto che tutto il resto deve rispecchiare.
    expect(h.state.tabelle.utenti[0].cellulare).toBe('+39 111')
    expect(h.state.tabelle.utenti[0].nome).toBe('X')

    // 1. CHI HA PREMUTO LO VIENE A SAPERE. Prima leggeva soltanto la nota generica
    //    «Questa persona aveva già un profilo…» e andava avanti convinto che il
    //    cellulare nuovo fosse in tabella.
    expect(codici(body)).toContain('accountNonAggiornato')

    // 2. L'AUDIT NON DICHIARA NIENTE DI FALSO.
    const dopo = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    const valori = dopo.valoreDopo as Record<string, unknown>
    expect(valori.campi_aggiornati, 'l’audit dichiara scritte colonne rimaste com’erano').toEqual([])
    expect(valori.account_non_aggiornato).toBe(true)

    // 3. E resta a livello `error` nei log applicativi, dove si conta.
    const errori = h.logEvento.mock.calls.filter(
      (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'account-non-aggiornato',
    )
    expect(errori).toHaveLength(1)
  })
})
