import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppRole } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { RUOLI_VALIDI } from '@/lib/auth/ruoli'
import {
  cercaProfiloPerEmail,
  normalizzaRuolo,
  RUOLO_GENITORE,
} from '@/lib/auth/staff-identity'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// «AGGIUNGI IL RUOLO DI INSEGNANTE A QUESTO ACCOUNT» — il presidio umano che stava
// dall'altra parte di un messaggio scritto mesi fa e mai raggiungibile.
//
// ── DA DOVE VIENE ────────────────────────────────────────────────────────────
//
// `src/lib/auth/staff-identity.ts` risponde da sempre, e in due punti diversi:
//   «Questa email è già quella di un genitore: serve una decisione della segreteria
//    per aggiungere il ruolo di insegnante senza togliere l'accesso alle schede dei
//    figli.»
// e chiude la porta — giustamente: *chi decide che una madre è anche una dipendente
// è una persona, non una route*. Ma la decisione non aveva nessun posto in cui essere
// presa. Chi operava leggeva «serve una decisione della segreteria», e poi restava con
// un 409 e nessun comando. Questa route è quel posto.
//
// ⚠️ NON APRE IL PERCORSO AUTOMATICO. `RIUSABILE_PER_RUOLO.genitore` resta `false`:
// l'approvazione di una candidatura e quella di una pratica continuano a RIFIUTARE.
// Cambia una cosa sola, ed è quella che mancava: il rifiuto ora rimanda a una
// schermata in cui una persona può decidere, con la sua identità nell'audit.
//
// ── È DIRIGENZA, NON SPORTELLO ───────────────────────────────────────────────
//
// `requireStaff(['admin','coordinator'])`, e non i tre ruoli che aprono il cockpit
// delle pratiche. L'asimmetria coi due versi del doppio profilo è la ragione:
//  · *docente → anche genitore* è già aperto (`parent-identity.ts`) e aggiunge un
//    ponte verso i PROPRI figli, il cui perimetro lo scrive solo la Segreteria:
//    aggiunge zero potere;
//  · *genitore → anche personale* dà un ruolo, una sede, e la possibilità di finire
//    in `utenti_sezioni`: aggiunge POTERE SUI DATI DI MINORI ALTRUI.
// Le due cose si somigliano solo a guardarle da lontano.
//
// ── PERCHÉ È UN `update` E NON UN `insert` (misurato, non dedotto) ───────────
//
// MISURA in produzione, 2026-09-01 (sole SELECT): 563 righe `parents` con
// `auth_user_id`, e **563 su 563** hanno GIÀ la loro riga `utenti` — 558 con
// `ruolo = 'genitore'`, e CINQUE con `educator`, cioè il doppio profilo che in questo
// schema esiste già. Un genitore che ha un accesso ha per forza la riga `utenti`: la
// scrive `ensureParentIdentity`, ed è l'unica tabella letta da `loadAppUser` (senza,
// il login riesce e ogni route risponde 403). `utenti.id` è PRIMARY KEY: «creare la
// riga sull'uid esistente» prenderebbe un `23505` in 563 casi su 563.
//
// IL DOPPIO PROFILO, IN QUESTO SCHEMA, È: `utenti.ruolo` del PERSONALE **più** il
// ponte `parents.auth_user_id` INTATTO. Lo dice `getProfiliForAuthUid`
// (`src/lib/auth/profili.ts`) e lo conferma `conPonteGenitore` in `require-staff.ts`,
// che rimette `genitore` fra i ruoli REALI proprio a partire da quel ponte. Perciò
// qui si scrive `utenti.ruolo` e non si tocca `parents`: è quel non-toccare a
// mantenere la promessa del messaggio — *senza togliere l'accesso alle schede dei
// figli* — e questa route lo VERIFICA dopo aver scritto, invece di darlo per buono.
//
// ── CIÒ CHE NON FA, ed è metà del progetto ───────────────────────────────────
//
//  · non tocca `parents` (e lo ricontrolla);
//  · non tocca `auth.users`: nessun account nasce, nessuno viene cancellato;
//  · non rigenera nessuna password e non spedisce nessuna credenziale — l'account
//    esiste già e quella persona ci entra già. Mandarle una password nuova
//    significherebbe interrompere l'accesso che si è appena promesso di non togliere;
//  · non scrive `role`, `first_name`, `last_name`: sono colonne GENERATE da
//    `ruolo`/`nome`/`cognome`, e scriverle fa fallire l'istruzione;
//  · non riscrive nome, cognome, email: qui si aggiunge un ruolo, non si rifà una
//    persona.
// =============================================================================

/** Chi può decidere. Non la segreteria: vedi la testata. */
const DIREZIONE = ['admin', 'coordinator'] as const

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno: il client traduce il codice, e chi lavora
 * con l'interfaccia in inglese non si ritrova la prosa italiana del server.
 * Sono dichiarati in `src/lib/ui/esito-fetch.ts` e tradotti nei due cataloghi. */
const CODICE_ACCOUNT_NON_TROVATO = 'PROFILO_DOPPIO_ACCOUNT_NON_TROVATO'
const CODICE_GIA_PERSONALE = 'PROFILO_DOPPIO_GIA_PERSONALE'
const CODICE_SENZA_PONTE = 'PROFILO_DOPPIO_SENZA_PONTE'
const CODICE_ALTRA_SEDE = 'PROFILO_DOPPIO_ALTRA_SEDE'
const CODICE_NON_RIUSCITO = 'PROFILO_DOPPIO_NON_RIUSCITO'

/**
 * I NOMI DI ROTTA, per i campi `operazione` dei log.
 *
 * ⚠️ Sono RIBATTUTI come letterali dentro `withRoute(…)` qui sotto, e non è una
 * distrazione: il lock `__tests__/architecture/logging-coverage.test.ts` legge il nome
 * col testo, non col compilatore, e una costante lo renderebbe illeggibile — cioè
 * spegnerebbe in silenzio il controllo che verifica che quel nome corrisponda alla
 * posizione del file. È la stessa forma di `admin/pratiche-personale`.
 */
const OP_GET = 'admin/staff/collega-profilo-esistente:GET'
const OP_POST = 'admin/staff/collega-profilo-esistente:POST'

const getQuerySchema = z.object({
  /**
   * L'email della persona da riconoscere. È già davanti a chi opera — sta nella
   * pratica che ha aperto — e serve solo a farne uscire l'uid, che è l'unico valore
   * con cui la `POST` può indicare una riga senza ambiguità di maiuscole.
   */
  email: z.string().trim().min(3, { error: 'Indicare l\'email dell\'account' }).max(320),
})

const postBodySchema = z.object({
  /**
   * L'UID, non l'email. `utenti_email_key` è UNIQUE **sensibile alle maiuscole** e
   * questo repo ha già pagato quel difetto: un uuid non ha maiuscole, e indica una
   * riga sola. Lo si ottiene dalla `GET` qui sopra.
   */
  authUserId: zUuid,
  /**
   * Il ruolo del PERSONALE da assegnare. `RUOLI_VALIDI` (`src/lib/auth/ruoli.ts`) è
   * l'elenco degli assegnabili e **non contiene `genitore`**: da questa porta non si
   * può «assegnare» il ruolo che la persona ha già.
   */
  ruolo: z.enum(RUOLI_VALIDI as [AppRole, ...AppRole[]], { error: 'Ruolo non assegnabile' }),
  /**
   * LA SEDE SI DICHIARA. `utenti.scuola_id` è NOT NULL ed è una colonna sola: dopo
   * questa operazione è il plesso in cui quella persona LAVORA. Obbligatoria di
   * proposito — «ogni scrittura dichiara la sua sede» (AGENTS.md), e una route che la
   * indovina archivia nel plesso sbagliato in silenzio. `resolveScuolaScrittura`
   * resta la seconda cintura: nega la sede altrui (403) e rifiuta di scegliere
   * quando è ambigua (400).
   */
  scuolaId: zUuid,
  /**
   * NON È DECORAZIONE. `z.literal(true)` rende impossibile creare un profilo doppio
   * con una richiesta che non lo dica esplicitamente: assente o `false` ⇒ 400, e
   * nessuna riga toccata. È il gemello server della spunta che sta a schermo — che
   * da sola sarebbe una promessa del browser.
   */
  conferma: z.literal(true, { error: 'Serve una conferma esplicita' }),
})

/** Il guasto: 503 con un codice, e il messaggio grezzo del database resta nel log. */
function nonDisponibile(messaggio: string): NextResponse {
  return NextResponse.json({ error: messaggio, codice: CODICE_NON_RIUSCITO }, { status: 503 })
}

/** Il codice PostgREST di un errore, quando c'è: è la terna che dice cosa è successo. */
function codiceDi(error: unknown): string | null {
  return (error as { code?: string } | null)?.code ?? null
}

/**
 * IL PONTE VERSO I FIGLI ESISTE? — `parents.auth_user_id`.
 *
 * Fail-closed: PostgREST non lancia, e una lettura fallita NON vale «il ponte non
 * c'è». Qui il verso in cui si sbaglia conta più del solito: dire «non c'è» su una
 * lettura fallita farebbe rifiutare l'operazione (nessun danno), dire «c'è» su una
 * lettura fallita la farebbe riuscire dichiarando salvo un accesso che nessuno ha
 * guardato — cioè mentire proprio sulla cosa che questa route promette.
 */
async function ponteGenitore(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  authUserId: string,
): Promise<{ esito: 'presente' | 'assente' } | { esito: 'illeggibile' }> {
  const { data, error } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (error) {
    logEvento('anagrafica', 'error', {
      operazione,
      esito: 'ponte-genitore-non-letto',
      entita_tipo: 'parents',
      utente: authUserId,
      error_code: codiceDi(error),
    }, error)
    return { esito: 'illeggibile' }
  }
  return { esito: data ? 'presente' : 'assente' }
}

/**
 * L'ACCOUNT STA IN UN PLESSO CHE QUESTA POSTAZIONE GESTISCE?
 *
 * ⚠️ LA CLAUSOLA STA NELL'ISTRUZIONE CHE LEGGE, non in un `includes` di JavaScript
 * sopra un valore già in mano. Non è pedanteria: è la stessa forma che
 * `admin/pratiche-personale` ha dovuto adottare dopo aver misurato — il 2026-08-12 —
 * che un fascicolo con codice fiscale e documento d'identità finiva riscritto su una
 * persona di un altro plesso. Un confronto scritto a mano si può spostare, duplicare o
 * dimenticare in un ramo; una clausola nella query no.
 *
 * ⚠️ E LO SCOPE È QUELLO DEL SedeSelector (`resolveScuoleAttive`), non le sedi
 * «accessibili»: la prima è il sottoinsieme che l'operatore ha davvero davanti, e
 * usare la seconda sarebbe un gate più debole di quello accanto.
 *
 * Fail-closed: PostgREST non lancia, e una lettura fallita NON vale «è nel plesso
 * giusto».
 */
async function accountNelloScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { utenteId: string; scuole: string[] },
): Promise<'dentro' | 'fuori' | 'illeggibile'> {
  const { data, error } = await supabase
    .from('utenti')
    .select('id, scuola_id')
    .eq('id', args.utenteId)
    .in('scuola_id', args.scuole)
    .maybeSingle()
  if (error) {
    logEvento('anagrafica', 'error', {
      operazione,
      esito: 'scope-account-non-risolto',
      entita_tipo: 'utenti',
      utente: args.utenteId,
      error_code: codiceDi(error),
    }, error)
    return 'illeggibile'
  }
  return data ? 'dentro' : 'fuori'
}

/**
 * IL RISOLUTORE — «questa email, di chi è?», e la risposta porta l'uid SOLO quando
 * la porta è davvero quella del genitore.
 *
 * ⚠️ PERCHÉ L'UID ESCE DA QUI E NON DAL COCKPIT DELLE PRATICHE. `sguardoSullAccount`
 * (`admin/pratiche-personale:GET`) risponde alla stessa domanda ma tiene l'uid per
 * sé, e lo dichiara: *«qui non si apre una finestra sull'anagrafica del personale»*.
 * Quella risposta la legge anche la SEGRETERIA. Questa no: è dietro lo stesso gate
 * dell'azione, e restituisce l'uid solo nel caso in cui l'azione sarebbe possibile —
 * profilo `genitore` **e** ponte presente. Su qualunque altro account risponde
 * `authUserId: null`: c'è una porta, e non è questa.
 */
export const GET = withRoute('admin/staff/collega-profilo-esistente:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    const { profilo, error } = await cercaProfiloPerEmail(supabase, q.data.email)
    if (error) {
      // Fail-closed: «non lo so» non diventa «non c'è». Un `trovato: false` su una
      // lettura fallita manderebbe chi opera a creare un secondo account.
      logEvento('anagrafica', 'error', {
        operazione: OP_GET,
        esito: 'profilo-non-letto',
        entita_tipo: 'utenti',
        error_code: codiceDi(error),
      }, error)
      return nonDisponibile(
        'Non è stato possibile verificare a chi appartiene questo accesso: riprovare fra poco.',
      )
    }
    if (!profilo) {
      return NextResponse.json({
        trovato: false, authUserId: null, ruolo: null, sedeGestita: null, ponteGenitore: null,
      })
    }

    const ruolo = normalizzaRuolo(profilo.ruolo)
    const sedeGestita = profilo.scuolaId !== null && scuole.includes(profilo.scuolaId)
    // Il ponte si chiede SOLO quando serve a rispondere: su un account del personale
    // la risposta è già decisa, e leggere `parents` direbbe di una persona una cosa
    // che a chi guarda non serve per decidere.
    const ponte = ruolo === RUOLO_GENITORE && sedeGestita
      ? await ponteGenitore(supabase, OP_GET, profilo.id)
      : null
    const apribile = ponte?.esito === 'presente'

    return NextResponse.json({
      trovato: true,
      // L'uid esce SOLO se questa porta si può davvero aprire. Vedi il ⚠️ sopra.
      authUserId: apribile ? profilo.id : null,
      ruolo: ruolo || null,
      sedeGestita,
      ponteGenitore: ponte === null ? null : ponte.esito === 'presente',
    })
  } catch (e) {
    // `withRoute` non vede le eccezioni CATTURATE: senza questa riga il 503 uscirebbe
    // senza stack e senza messaggio, cioè cieco esattamente dove serve vedere.
    logErrore({ operazione: OP_GET }, e)
    return nonDisponibile('Operazione non riuscita: riprovare fra poco.')
  }
})

/**
 * IL GESTO: aggiunge il ruolo del personale a un accesso che ESISTE, senza togliere
 * l'accesso da genitore.
 *
 * L'ordine dei passi è la parte che conta: si guarda TUTTO prima di scrivere, e la
 * scrittura è una sola istruzione con dentro le sue clausole. Un'operazione che
 * fallisse a metà lascerebbe una persona con un ruolo nuovo e un'anagrafica che non
 * la nomina — o, peggio, senza più l'area famiglie.
 */
export const POST = withRoute('admin/staff/collega-profilo-esistente:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { authUserId, ruolo, conferma } = b.data
    // Dichiarata e usata: `conferma` è un `z.literal(true)`, quindi qui vale sempre
    // `true` — ma leggerla è ciò che impedisce a qualcuno di toglierla dallo schema
    // credendola inerte. Se sparisse, questa riga non compilerebbe più.
    if (conferma !== true) {
      return NextResponse.json(
        { error: 'Serve una conferma esplicita.', codice: CODICE_NON_RIUSCITO },
        { status: 400 },
      )
    }

    const supabase = await createAdminClient()

    // ── 1. LA SEDE, DICHIARATA ───────────────────────────────────────────────
    // 403 se non è una sede di chi chiama, 400 se non c'è modo di sceglierne una:
    // in nessun caso viene indovinata.
    const sede = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuolaId)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    // ── 2. L'ACCOUNT ESISTE? ─────────────────────────────────────────────────
    const { data: riga, error: errRiga } = await supabase
      .from('utenti')
      .select('id, ruolo, scuola_id')
      .eq('id', authUserId)
      .maybeSingle()
    if (errRiga) {
      // PostgREST non lancia: senza questo controllo una lettura fallita si
      // travestirebbe da «questo uid non esiste» e la risposta sarebbe un 404 su un
      // account vivo — cioè un'affermazione su un dato che non è stato letto.
      logEvento('anagrafica', 'error', {
        operazione: OP_POST,
        esito: 'profilo-non-letto',
        entita_tipo: 'utenti',
        utente: authUserId,
        error_code: codiceDi(errRiga),
      }, errRiga)
      return nonDisponibile(
        'Non è stato possibile leggere il profilo di questo accesso: riprovare fra poco. ' +
          'Niente è stato modificato.',
      )
    }
    if (!riga) {
      logEvento('anagrafica', 'warn', {
        operazione: OP_POST,
        esito: 'account-non-trovato',
        entita_tipo: 'utenti',
        utente: authUserId,
      })
      return NextResponse.json(
        {
          error: 'Questo accesso non esiste più, oppure non ha nessun profilo: ' +
            'niente è stato modificato.',
          codice: CODICE_ACCOUNT_NON_TROVATO,
        },
        { status: 404 },
      )
    }

    // Il valore GREZZO serve alla clausola dell'UPDATE (è ciò che c'è in tabella),
    // quello NORMALIZZATO alla decisione: `'Genitore'` e `'genitore '` sono la stessa
    // persona per chiunque legga, e `utenti.ruolo` non ha né `CHECK` né enum.
    const ruoloGrezzo = String((riga as { ruolo?: unknown }).ruolo ?? '')
    const ruoloAttuale = normalizzaRuolo(ruoloGrezzo)
    const sedeAttuale = (riga as { scuola_id?: unknown }).scuola_id
    const sedePrecedente = typeof sedeAttuale === 'string' && sedeAttuale !== '' ? sedeAttuale : null

    // ── 3. È DAVVERO UN ACCESSO DA GENITORE? ─────────────────────────────────
    // Non si sovrascrive il ruolo di chi è già del personale: un declassamento
    // silenzioso è un accesso perso, e il posto in cui si cambia il ruolo a un
    // dipendente è il pannello Personale (`PATCH /api/admin/staff`), dove si vede
    // che cosa si sta togliendo.
    if (ruoloAttuale !== RUOLO_GENITORE) {
      logEvento('anagrafica', 'warn', {
        operazione: OP_POST,
        esito: 'profilo-gia-personale',
        entita_tipo: 'utenti',
        utente: authUserId,
        ruolo: ruoloAttuale || null,
      })
      return NextResponse.json(
        {
          error: 'Questo accesso ha già un profilo del personale: niente è stato modificato. ' +
            'Il ruolo di una persona già in organico si cambia dal pannello Personale.',
          codice: CODICE_GIA_PERSONALE,
        },
        { status: 409 },
      )
    }

    // ── 4. IL PLESSO DELL'ACCOUNT È DI QUESTA POSTAZIONE? ────────────────────
    // Senza, la Direzione di un plesso riassegnerebbe il genitore di un altro. Lo
    // scope è quello del SedeSelector (`resolveScuoleAttive`), come ogni altra
    // scrittura del cockpit: usare le sedi «accessibili» sarebbe un gate più debole
    // di quello accanto.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)
    const dove = await accountNelloScope(supabase, OP_POST, { utenteId: authUserId, scuole })
    if (dove === 'illeggibile') {
      return nonDisponibile(
        'Non è stato possibile verificare in quale plesso è registrata questa persona: ' +
          'riprovare fra poco. Niente è stato modificato.',
      )
    }
    if (dove === 'fuori') {
      logEvento('multi_sede', 'warn', {
        operazione: OP_POST,
        esito: 'account-fuori-sede-non-collegato',
        entita_tipo: 'utenti',
        utente: authUserId,
        ruolo: auth.user.role,
        sedi_attive: scuole.length,
      })
      return NextResponse.json(
        {
          error: 'Questo accesso è registrato su un plesso che questa postazione non gestisce: ' +
            'niente è stato modificato. Va collegato dalla Direzione o da una postazione che ' +
            'gestisce quel plesso.',
          codice: CODICE_ALTRA_SEDE,
        },
        { status: 403 },
      )
    }

    // ── 5. IL PONTE VERSO I FIGLI C'È? ───────────────────────────────────────
    // È la ragione stessa di questa route: se non c'è nessun accesso ai figli da
    // salvare, non c'è niente da fare QUI — c'è da cambiare un ruolo, e quello si fa
    // dal pannello Personale, dove si vede che cosa si sta cambiando.
    const ponte = await ponteGenitore(supabase, OP_POST, authUserId)
    if (ponte.esito === 'illeggibile') {
      return nonDisponibile(
        'Non è stato possibile verificare l\'accesso di questa persona alle schede dei figli: ' +
          'riprovare fra poco. Niente è stato modificato.',
      )
    }
    if (ponte.esito === 'assente') {
      logEvento('anagrafica', 'warn', {
        operazione: OP_POST,
        esito: 'ponte-genitore-assente',
        entita_tipo: 'parents',
        utente: authUserId,
      })
      return NextResponse.json(
        {
          error: 'Questo accesso non risulta collegato a nessuna scheda di figlio: ' +
            'niente è stato modificato. Il ruolo si assegna dal pannello Personale.',
          codice: CODICE_SENZA_PONTE,
        },
        { status: 409 },
      )
    }

    // ── 6. LA SCRITTURA: una sola istruzione, con dentro le sue clausole ─────
    // `ruolo: ruoloGrezzo` la rende ATOMICA: due clic (o due schede) e la seconda
    // tocca zero righe, perché il ruolo in tabella non è più quello. `scuola_id` fra
    // i filtri è il presidio d'isolamento nella stessa istruzione che scrive: un gate
    // «da qualche parte nell'handler» si può spostare, la clausola no.
    //
    // ⚠️ MAI `role`/`first_name`/`last_name`: sono colonne GENERATE da
    // `ruolo`/`nome`/`cognome`, e scriverle fa fallire l'istruzione. E nemmeno
    // `email`, `nome`, `cognome`, `attivo`, `gradi`: qui si aggiunge un ruolo, non si
    // riscrive una persona — e `gradi` non è una preferenza d'interfaccia, è lo scope
    // con cui `api/primaria/classi` decide a quali bambini quella persona arriva.
    const { data: toccate, error: errUpdate } = await supabase
      .from('utenti')
      .update({ ruolo, scuola_id: scuolaId })
      .eq('id', authUserId)
      .eq('ruolo', ruoloGrezzo)
      .in('scuola_id', scuole)
      .select('id')
    if (errUpdate) {
      // Il messaggio grezzo del database NON esce da qui: è prosa inglese con dentro
      // nomi di colonne e di vincoli. Il testo vero vive in questo log.
      logEvento('anagrafica', 'error', {
        operazione: OP_POST,
        esito: 'profilo-doppio-non-scritto',
        entita_tipo: 'utenti',
        utente: authUserId,
        error_code: codiceDi(errUpdate),
      }, errUpdate)
      return nonDisponibile(
        'Il ruolo non è stato aggiunto: riprovare fra poco. Niente è stato modificato.',
      )
    }
    if ((toccate ?? []).length === 0) {
      // Zero righe con la lettura andata a buon fine ⇒ qualcuno è arrivato prima
      // (o il ruolo è cambiato fra la lettura e la scrittura). Non è un guasto: è la
      // corsa che la clausola esiste per chiudere.
      logEvento('anagrafica', 'warn', {
        operazione: OP_POST,
        esito: 'profilo-doppio-gia-deciso',
        entita_tipo: 'utenti',
        utente: authUserId,
      })
      return NextResponse.json(
        {
          error: 'Questo accesso ha già un profilo del personale: niente è stato modificato.',
          codice: CODICE_GIA_PERSONALE,
        },
        { status: 409 },
      )
    }

    // ── 7. IL PONTE È ANCORA LÀ? ─────────────────────────────────────────────
    // L'UPDATE non può toccare `parents`, e proprio per questo la verifica costa una
    // riga e vale tutto: la promessa del messaggio — *senza togliere l'accesso alle
    // schede dei figli* — è l'unica cosa che questa route deve mantenere, e una
    // promessa che nessuno misura è una promessa che un giorno smette di essere vera
    // senza che niente diventi rosso.
    const dopo = await ponteGenitore(supabase, OP_POST, authUserId)
    const ponteVivo = dopo.esito === 'presente'
    if (!ponteVivo) {
      logEvento('anagrafica', 'error', {
        operazione: OP_POST,
        esito: 'ponte-genitore-perso-dopo-la-scrittura',
        entita_tipo: 'parents',
        utente: authUserId,
      })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'utenti',
      entitaId: authUserId,
      azione: 'update',
      scuolaId,
      valorePrima: { ruolo: ruoloAttuale, scuola_id: sedePrecedente },
      valoreDopo: { ruolo, scuola_id: scuolaId },
    })

    // LA TRACCIA DI CHI HA DECISO. `warn` e non `info`: un `info` sul canale
    // `anagrafica` non arriva in `app_log` (deroga dichiarata in `eventi-log.test.ts`)
    // e resterebbe sulla riga di Vercel, mentre questa è esattamente la riga a cui si
    // torna fra mesi per rispondere a «chi ha dato l'area docente a un genitore, e
    // quando». Nessun nome, nessuna email: uuid, ruolo e sede.
    logEvento('anagrafica', 'warn', {
      operazione: OP_POST,
      tipo: 'profilo-doppio-creato',
      esito: 'profilo-doppio-creato',
      entita_tipo: 'utenti',
      utente: authUserId,
      ruolo,
      sede_id: scuolaId,
      // Chi ha deciso, e da dove. Il nome sta nell'audit, qui basta l'uuid.
      attore: auth.user.id,
      // La sede è cambiata? È legittimo (una mamma che insegna in un altro plesso),
      // ma `utenti.scuola_id` è una colonna sola: da qui in avanti è anche la sede
      // di ripiego delle sue schermate da genitore, e va detto.
      sede_precedente: sedePrecedente,
      ponte_genitore: ponteVivo,
    })

    return NextResponse.json({
      ok: true,
      authUserId,
      ruolo,
      scuolaId,
      ruoloPrecedente: ruoloAttuale,
      sedePrecedente,
      /** La promessa, misurata: `false` significa che va guardato subito. */
      ponteGenitore: ponteVivo,
    })
  } catch (e) {
    logErrore({ operazione: OP_POST }, e)
    return nonDisponibile('Operazione non riuscita: riprovare fra poco.')
  }
})
