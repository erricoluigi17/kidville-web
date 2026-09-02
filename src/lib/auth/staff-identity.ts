import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { dettaglioErroreAuth, findAuthUserIdByEmail, randomPassword } from './parent-identity'
import type { AppRole } from './require-staff'

// =============================================================================
// Identità di accesso di un membro dello STAFF — gemello di `parent-identity.ts`.
//
// Un docente funzionante è fatto di DUE record, non di quattro (il genitore ha in
// più il ponte `parents.auth_user_id` e il legame col figlio):
//   1. `auth.users`              — account email+password (login);
//   2. `utenti` ruolo 'educator' — profilo con `id == auth.uid()`; è l'unica
//      tabella letta da `loadAppUser`, quindi senza questa riga il login riesce e
//      ogni route risponde 403 «Utente non trovato».
//
// PERCHÉ NON SI RIUSA `ensureParentIdentity`: quella parte da un `parents.id` e
// scrive `ruolo: 'genitore'`. Qui non c'è nessuna anagrafica da collegare — c'è
// una CANDIDATURA, che è un'altra tabella e un altro spazio-id.
//
// LE DUE PORTE CHIUSE, e sono la ragione per cui questa funzione ritorna un
// esito invece di scrivere e basta:
//  · email già in `utenti`  → NON si tocca niente. Un upsert sovrascriverebbe
//    ruolo e sede di una persona GIÀ dentro il sistema (il rischio è scritto per
//    esteso in `admin/iscrizioni/route.ts:956-961`, dove è già costato un
//    `PGRST204` silenzioso): due account per la stessa insegnante significano un
//    registro diviso in due, e un ruolo sovrascritto significa un accesso perso;
//  · uid già legato a `parents` → NON si tocca niente. La stessa persona può
//    essere insegnante *e* genitore di un bambino della Scuola: creare il profilo
//    docente su quell'uid le darebbe l'area docente e, con essa, l'anagrafica di
//    tutti i bambini — oppure le toglierebbe l'accesso ai propri figli. È una
//    decisione che prende una persona, non una route.
//
// LA PRIMA DELLE DUE SI APRE A RICHIESTA (`seEsisteRiusa`, dal 2026-08-11), e la
// seconda NO. Il motivo è che le due porte chiudono su due domande diverse: la
// prima su «esiste già un profilo del personale con questa identità?», la seconda
// su «questo uid è l'accesso di un genitore?». Per l'approvazione di una PRATICA
// DI ANAGRAFICA (`/anagrafica-personale`) la risposta «sì» alla prima è il caso
// NORMALE — la maestra lavora qui da anni, l'account ce l'ha — mentre un «sì»
// alla seconda resta la stessa decisione umana di sempre. Il riuso è opt-in e
// spento di default proprio perché per le CANDIDATURE il significato è opposto:
// chi è già staff non si sta candidando, e lì il `409` è la risposta giusta.
//
// E ANCHE APERTA, LA PRIMA PORTA È UN ELENCO DI AMMESSI: si riusa il profilo di
// chi ha uno dei ruoli del PERSONALE (`RIUSABILE_PER_RUOLO`), e qualunque altro
// valore — compresi quelli che nessuno ha previsto — non passa. `utenti.ruolo` è
// un `varchar` senza `CHECK`: un elenco di esclusi avrebbe concesso a tutto il
// resto, che è il verso sbagliato in cui sbagliare.
//
// Non lancia MAI: ogni esito è un valore. Chi chiama deve poter rimettere la
// candidatura in `pending` e rispondere con un codice, non gestire un throw.
// =============================================================================

/** Le fasce d'età di `utenti.gradi` (enum `school_type_enum` a database). */
export type Grado = 'nido' | 'infanzia' | 'primaria'

export interface StaffIdentityInput {
  email: string
  nome: string
  cognome: string
  cellulare?: string | null
  /** Oggi sempre `educator`: il parametro esiste perché la colonna scritta è `ruolo`. */
  ruolo: AppRole
  /** `utenti.scuola_id` è NOT NULL: la sede si DICHIARA, non si indovina. */
  scuolaId: string
  gradi: Grado[]
}

/**
 * Le opzioni di `ensureStaffIdentity`. Tutte spente di default: chi chiama senza
 * il terzo argomento ottiene esattamente ciò che otteneva prima che esistessero.
 */
export interface OpzioniStaffIdentity {
  /**
   * `true` = «se un profilo del personale con questa identità c'è già, RIUSALO e
   * dimmelo», invece di rispondere `email_gia_staff`.
   *
   * PERCHÉ È UN'OPZIONE E NON IL COMPORTAMENTO. Le due strade che passano di qui
   * si fanno la stessa domanda e chiamano «giusta» la risposta opposta:
   *  · una CANDIDATURA di chi è già dentro è un errore — nessuno si candida al
   *    posto in cui lavora — e la risposta è il `409` che dice alla segreteria di
   *    collegare l'account esistente;
   *  · una PRATICA DI ANAGRAFICA di chi è già dentro è il caso normale, anzi è
   *    l'unico previsto: il modulo `/anagrafica-personale` è per le insegnanti
   *    GIÀ DIPENDENTI, e pretendere che non abbiano un account renderebbe la
   *    funzione inutilizzabile proprio per il suo scopo.
   *
   * NON apre la porta del genitore, e nemmeno quella di un ruolo che non sia del
   * personale: vedi `riusaIdentitaEsistente` e `RIUSABILE_PER_RUOLO`.
   */
  seEsisteRiusa?: boolean
}

export type EnsureStaffIdentityResult =
  // ── L'identità è stata CREATA (o completata) in questa chiamata ────────────
  // `input.ruolo` e `input.scuolaId` sono finiti in tabella: non c'è niente da
  // confrontare, ed è per questo che i tre campi del riuso qui sono `undefined`.
  // Dichiararli comunque, invece di ometterli, serve a una cosa sola: rende
  // `identita.scuolaIdEsistente` LEGGIBILE su tutta l'unione `ok:true` senza
  // restringere — chi non restringe legge `string | null | undefined`, cioè la
  // verità, invece di prendere un errore di compilazione che invoglia a un cast.
  | {
      ok: true
      authUserId: string
      /** Account `auth.users` creato ORA (password temporanea in `password`). */
      createdAuth: boolean
      /** Password temporanea SOLO quando `createdAuth`: altrimenti non la conosce nessuno. */
      password: string | null
      /** `false` quando la colonna `gradi` non esiste (DB della CI non migrato). */
      gradiScritti: boolean
      riusato?: undefined
      ruoloEsistente?: undefined
      scuolaIdEsistente?: undefined
    }
  // ── L'identità ESISTEVA e `seEsisteRiusa` ha detto di riusarla ─────────────
  | {
      ok: true
      authUserId: string
      /** Sempre `false`: un riuso non crea niente, in nessuna delle due tabelle. */
      createdAuth: false
      /** Sempre `null`: non è nato nessun account, quindi non esiste una password. */
      password: null
      /** Sempre `false`: la riga `utenti` c'era già e i `gradi` di `input` non sono stati scritti. */
      gradiScritti: false
      /**
       * `true` SOLO quando un profilo `utenti` ESISTEVA GIÀ e `seEsisteRiusa` ha
       * detto di riusarlo: niente è stato scritto, in nessuna delle due tabelle.
       *
       * PERCHÉ NON BASTAVA `createdAuth === false`. Quel campo risponde a
       * «l'account di login è nato adesso?», questo a «il profilo del personale
       * è nato adesso?», e le due domande hanno risposte diverse nel caso che
       * capita di più: account `auth.users` preesistente (quindi
       * `createdAuth: false`) e riga `utenti` creata in questa chiamata. Chi
       * deducesse il riuso dal primo campo tratterebbe quel caso come «c'era già
       * tutto» e non scriverebbe l'anagrafica di una persona appena creata.
       *
       * ⚠️ DICE «il profilo c'era», NON «quella persona riesce ad accedere»: la
       * lettura è su `utenti`, e una riga `utenti` senza il suo `auth.users` è
       * uno stato che questo file descrive già (account cancellato a mano, o lo
       * spazio in cui opera il rollback del punto 5).
       *
       * È tipizzato `true` e non `boolean` di proposito: assente significa «non
       * è un riuso», e con `?: boolean` un `if (identita.riusato === false)`
       * compilerebbe restando SEMPRE falso. Così quel confronto non compila e
       * l'unica forma corretta — `if (identita.riusato)` — è l'unica scrivibile.
       * Restringere su di essa dà anche i due campi qui sotto NON opzionali.
       */
      riusato: true
      /**
       * Il ruolo che quella persona ha GIÀ, normalizzato — NON `input.ruolo`.
       *
       * Sul riuso `input.ruolo` viene scartato, ed è giusto: nessuna pratica di
       * anagrafica declassa una segretaria a `educator` perché il modulo dice
       * così. Ma «scartato in silenzio» sarebbe un'altra cosa, e finché questo
       * campo non esisteva era esattamente ciò che accadeva.
       */
      ruoloEsistente: string
      /**
       * LA SEDE CHE QUELLA PERSONA HA GIÀ (`utenti.scuola_id`) — e `null` solo se
       * la colonna non è stata letta.
       *
       * PERCHÉ IL CHIAMANTE DEVE AVERLA. `anagrafica_personale` NON ha una
       * `scuola_id`, per scelta dichiarata nel DDL («quelli vivono in `utenti` e
       * restano lì»): quindi la sede del personale È questa, mentre
       * `pratiche_personale.scuola_id` è la sede della PRATICA ed è NOT NULL. Le
       * due possono divergere — misurato l'11/08/2026: 20 persone su 4 sedi — e
       * una segreteria che approva una pratica del proprio plesso otterrebbe
       * `ok:true` con la persona ancora agganciata a un altro, senza appiglio per
       * accorgersene. È alla lettera ciò che AGENTS.md vieta: «una route che
       * "indovina" la sede archivia i dati nel plesso sbagliato in silenzio».
       *
       * QUI NON SI DECIDE, si DICHIARA: uno spostamento di sede è legittimo (una
       * maestra trasferita) e va scritto da chi ha il gate e lo scope, non da una
       * funzione che sa solo creare identità. La divergenza è comunque loggata a
       * `warn`, così resta contabile anche se la route se ne dimentica.
       */
      scuolaIdEsistente: string | null
    }
  | {
      ok: false
      reason: 'email_gia_staff' | 'email_gia_genitore' | 'error'
      /** Il ruolo dell'account che occupa già quell'email: dice a chi opera cosa fare. */
      ruoloEsistente?: string
      /**
       * `true` SOLO quando un account `auth.users` è nato in questa chiamata, la
       * riga `utenti` non è riuscita E l'annullamento dell'account è fallito:
       * qualcosa È RIMASTO SCRITTO dietro una risposta d'errore. Chi chiama deve
       * dirlo a chi ha premuto il bottone, perché la seconda «Approva» riuserà
       * quell'account e non genererà nessuna password.
       */
      accountOrfano?: boolean
      /** L'uid dell'account rimasto orfano: è ciò che serve per ripararlo a mano. */
      authUserIdOrfano?: string
      message: string
    }

const OPERAZIONE = 'auth/staff-identity:ensureStaffIdentity'

/**
 * Le colonne di `utenti` che si possono TOGLIERE dall'INSERT quando il database
 * non le ha (progetto E2E della CI, non migrato): l'account nasce lo stesso e chi
 * ha premuto il bottone lo viene a sapere.
 *
 * `ruolo`, `scuola_id`, `email`, `nome`, `cognome` NON sono qui: senza una di
 * quelle l'account non è un account, e un degrado che le togliesse creerebbe una
 * riga inutilizzabile spacciandola per riuscita.
 */
const COLONNE_RIMOVIBILI = new Set(['gradi', 'cellulare', 'attivo'])

/** Codici con cui PostgREST/Postgres dicono «questa COLONNA qui non c'è». */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * Il `utenti.ruolo` dell'area famiglie — l'unico su cui il riuso si nega.
 *
 * Tipizzato `AppRole` e non `string`: se un domani quel ruolo cambiasse nome,
 * questa riga diventa rossa a compilazione invece di restare un letterale che non
 * corrisponde più a niente e che quindi non nega più niente.
 *
 * ESPORTATO dal 2026-09-02, e non per comodità: `admin/staff/collega-profilo-esistente`
 * è la porta che apre a mano ciò che questo file nega d'ufficio, e le due decisioni
 * si prendono sullo STESSO valore. Ribattuto là come letterale, il giorno in cui
 * cambia nome una delle due smette di riconoscerlo — e a smettere sarebbe quella che
 * CONCEDE, cioè il verso sbagliato in cui sbagliare.
 */
export const RUOLO_GENITORE: AppRole = 'genitore'

/**
 * IL RUOLO, NELLA FORMA SU CUI SI DECIDE — `.trim()` + minuscolo.
 *
 * `utenti.ruolo` è `character varying` senza `CHECK` né enum (la misura sta in
 * `RIUSABILE_PER_RUOLO`), quindi `'Genitore'` e `'genitore '` sono valori che il
 * database accetta e che per chiunque legga sono la stessa persona. Devono esserlo
 * anche per chi decide: qui, nel cockpit delle pratiche (`esitoPrevisto`) e nella
 * route che aggiunge un ruolo a un account esistente.
 *
 * Sta in un posto solo perché la regola è una sola: tre normalizzazioni ribattute
 * divergono alla prima modifica, e a divergere sarebbe il confronto che tiene chiusa
 * la porta del genitore.
 */
export function normalizzaRuolo(grezzo: unknown): string {
  return typeof grezzo === 'string' ? grezzo.trim().toLowerCase() : ''
}

/**
 * LE DUE FORME DELL'EMAIL su cui si cerca un profilo in `utenti`.
 *
 * Confronto per valore ESATTO su due forme (com'è scritta e minuscola) e MAI con
 * `ilike`: PostgREST traduce `*` in `%` dentro i pattern, quindi un carattere jolly
 * arrivato da un modulo pubblico ALLARGHEREBBE la ricerca invece di stringerla.
 * `.in()` è uguaglianza pura.
 *
 * ⚠️ COPRE UNA DIREZIONE SOLA, e va detto invece che promesso al contrario: se in
 * `utenti` l'indirizzo è archiviato `Mario.Rossi@x.it` e chi cerca scrive
 * `mario.rossi@x.it`, qui non esce niente — `utenti_email_key` è UNIQUE **sensibile
 * alle maiuscole**, quindi nemmeno il database chiude il buco. La chiusura vera è un
 * indice su `lower(email)`; quel giorno il filtro giusto è quello e queste due forme
 * diventano superflue.
 */
export function formeEmail(email: string): string[] {
  const pulita = (email ?? '').trim()
  return [...new Set([pulita, pulita.toLowerCase()])]
}

/** La riga di `utenti` che risponde alla domanda «questa email ha già un profilo?». */
export interface ProfiloUtentiNoto {
  id: string
  /** Il valore GREZZO della colonna: normalizzarlo è compito di chi decide. */
  ruolo: string
  scuolaId: string | null
}

/**
 * IL PROFILO `utenti` DI UN'EMAIL — la lettura, in un posto solo.
 *
 * La fanno in due, e devono dare la stessa risposta: il punto 1 di
 * `ensureStaffIdentity` (che da lì decide se riusare o negare) e il risolutore di
 * `admin/staff/collega-profilo-esistente` (che da lì tira fuori l'uid da mostrare a
 * chi deve decidere a mano). Scritta due volte diverge alla prima modifica, e allora
 * la schermata direbbe che quella porta si può aprire mentre il server la tiene
 * chiusa — o il contrario.
 *
 * ⚠️ NIENTE FILTRO DI SEDE, di proposito: la domanda è «esiste un profilo con questa
 * email in QUALUNQUE plesso?». Ristretta alle sedi attive, la risposta «no» sarebbe
 * falsa per una maestra trasferita, e chi chiama creerebbe il suo secondo account.
 * Lo scope lo applica il chiamante, DOPO, su ciò che ha trovato.
 *
 * ⚠️ PostgREST non lancia: l'errore torna come valore, e chi chiama deve trattarlo
 * come «non lo so» e fermarsi. Una lettura fallita scambiata per «email libera» è il
 * modo esatto in cui nasce il secondo account di una persona che ce l'ha già.
 */
export async function cercaProfiloPerEmail(
  admin: SupabaseClient,
  email: string,
): Promise<{ profilo: ProfiloUtentiNoto | null; error: { code?: string; message: string } | null }> {
  // `scuola_id` si legge anche quando non la si scrive: è l'unica sede che una
  // persona del personale abbia, e senza di lei il chiamante non può nemmeno
  // accorgersi che diverge da quella dichiarata.
  const { data, error } = await admin
    .from('utenti')
    .select('id, ruolo, email, scuola_id')
    .in('email', formeEmail(email))
    .limit(1)
    .maybeSingle()
  if (error) return { profilo: null, error: error as { code?: string; message: string } }
  const riga = data as { id?: unknown; ruolo?: unknown; scuola_id?: unknown } | null
  const id = typeof riga?.id === 'string' && riga.id !== '' ? riga.id : null
  if (!id) return { profilo: null, error: null }
  return {
    profilo: {
      id,
      ruolo: String(riga?.ruolo ?? ''),
      scuolaId: typeof riga?.scuola_id === 'string' && riga.scuola_id !== '' ? riga.scuola_id : null,
    },
    error: null,
  }
}

/**
 * CHI SI RIUSA — un elenco di AMMESSI, non di esclusi, e la differenza sta tutta
 * nella direzione in cui si sbaglia.
 *
 * LA MISURA (produzione, 2026-08-11, sole SELECT). `utenti.ruolo` è
 * `character varying NOT NULL` e nient'altro: gli unici vincoli della tabella
 * sono `PRIMARY KEY (id)`, `UNIQUE (email)` e le due chiavi esterne
 * (`auth.users`, `schools`). NESSUN `CHECK`, nessun enum. I sei valori vivi
 * (genitore 38 · educator 12 · segreteria 3 · admin 3 · cuoca 1 · coordinator 1)
 * sono oggi tutti canonici, ma è una constatazione, non una garanzia: il
 * database accetta qualunque stringa.
 *
 * PERCHÉ NON BASTAVA `ruolo === 'genitore'`. Scritto come diniego, il confronto
 * CONCEDE a tutto ciò che non è quel letterale esatto: `'Genitore'`, `'genitore '`
 * e ogni ruolo che nascesse domani aprirebbero la porta. Rovesciato, un valore che
 * nessuno ha previsto NON passa — che è poi la regola che questo stesso file si dà
 * al punto 3-bis: «non sapere è motivo per fermarsi».
 *
 * PERCHÉ UN `Record` E NON UN ELENCO. `Record<AppRole, boolean>` è esaustivo: un
 * settimo ruolo aggiunto a `AppRole` rende ROSSO questo oggetto finché qualcuno
 * non decide se quel personale entra nell'anagrafica del personale. Un elenco lo
 * avrebbe lasciato fuori in silenzio — negare è il verso giusto, ma senza che
 * nessuno se ne accorgesse.
 */
const RIUSABILE_PER_RUOLO: Record<AppRole, boolean> = {
  admin: true,
  coordinator: true,
  educator: true,
  segreteria: true,
  cuoca: true,
  // L'area famiglie. Il perché sta per esteso in `riusaIdentitaEsistente`.
  genitore: false,
}

/**
 * L'elenco di sopra ridotto a un insieme, ed è per il RUNTIME che serve.
 *
 * Il valore da confrontare arriva dal DATABASE, quindi è una stringa qualunque, e
 * su un oggetto letterale l'interrogazione per chiave non è chiusa: verificato in
 * `node`, `({educator:true})['toString']` non è `undefined` — è la funzione
 * ereditata dal prototipo, cioè un valore VERO, e un ruolo scritto `toString`
 * avrebbe superato il controllo. Un `Set` non ha catena di prototipi da
 * interrogare: `new Set(['educator']).has('toString')` è `false`.
 */
const RUOLI_RIUSABILI: ReadonlySet<string> = new Set(
  Object.entries(RIUSABILE_PER_RUOLO).filter(([, ammesso]) => ammesso).map(([ruolo]) => ruolo),
)

/**
 * La frase del ramo «è già un genitore», scritta una volta sola perché la dicono
 * due rami — il punto 3 (uid legato a `parents`) e il diniego del riuso — e sono
 * la stessa risposta allo stesso fatto. Due copie diventano due spiegazioni
 * diverse alla prima riscrittura, e a leggerle è la stessa segreteria.
 */
const MESSAGGIO_GIA_GENITORE =
  'Questa email è già quella di un genitore: serve una decisione della segreteria per ' +
  'aggiungere il ruolo di insegnante senza togliere l\'accesso alle schede dei figli.'

/** Il nome della colonna dentro un errore di colonna assente, se dichiarato. */
function colonnaMancante(messaggio: string): string | null {
  const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(messaggio)
  return m?.[1] ?? m?.[2] ?? null
}

/**
 * ANNULLA l'account `auth.users` nato un istante fa, quando la riga `utenti` non
 * è riuscita.
 *
 * PERCHÉ ESISTE. L'account si crea al punto 4 e il profilo al punto 5: se il
 * secondo fallisce e il primo resta, la route risponde 503 «non è riuscito» —
 * e l'operatore legge «riprova» — mentre **un account con una password generata
 * e buttata via È RIMASTO**. Alla seconda «Approva» `findAuthUserIdByEmail` lo
 * ritrova, `createdAuth` diventa `false`, nessuna password torna e nessuna email
 * parte: l'insegnante risulta approvata e non potrà mai entrare. È l'immagine
 * speculare del 201 che mente — un 503 restituito mentre qualcosa è stato scritto.
 *
 * Si annulla, quindi, e l'esito si DICHIARA in ogni caso: se anche la
 * cancellazione fallisce, l'orfano resta e va detto con l'uid, perché quello è
 * l'unico appiglio per ripararlo a mano.
 *
 * @returns `true` se l'account non c'è più.
 */
async function annullaAccountAppenaCreato(admin: SupabaseClient, authUserId: string): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.deleteUser(authUserId)
    if (error) {
      logEvento('auth', 'error', {
        operazione: OPERAZIONE,
        esito: 'account-orfano-lasciato',
        utente: authUserId,
        stato: typeof (error as { status?: number }).status === 'number'
          ? (error as { status?: number }).status
          : undefined,
      }, error)
      return false
    }
    // Anche il RIUSCITO si logga: senza, «nessun log» non distingue «non è mai
    // successo» da «l'annullamento non parte più».
    logEvento('auth', 'warn', {
      operazione: OPERAZIONE,
      esito: 'account-annullato-dopo-profilo-non-creato',
      utente: authUserId,
    })
    return true
  } catch (e) {
    logEvento('auth', 'error', {
      operazione: OPERAZIONE,
      esito: 'account-orfano-lasciato',
      utente: authUserId,
    }, e)
    return false
  }
}

/**
 * IL RIUSO DI UN'IDENTITÀ CHE ESISTE GIÀ — la decisione, in un posto solo.
 *
 * I rami che la prendono sono due: il punto 1, che trova il profilo per EMAIL, e
 * il punto 3-bis, che lo trova per UID. Fanno la stessa domanda e devono dare la
 * stessa risposta; scritta due volte, la seconda modifica ne tocca una sola e la
 * divergenza si vedrebbe come una pratica accettata da una porta e respinta
 * dall'altra a seconda di come è scritta l'email — cioè per un motivo che nessuno
 * potrebbe indovinare guardando la pratica.
 *
 * @param input ciò che la pratica DICHIARA. Sul riuso non viene scritto niente,
 *   quindi serve solo per confrontarlo con ciò che c'è già e dire se divergono.
 * @param porta quale delle due l'ha trovata. Finisce nel log perché le due cose
 *   non sono la stessa: «per email» dice che in `utenti` l'indirizzo è archiviato
 *   nella forma digitata, «per uid» che è archiviato in un'ALTRA forma e che a
 *   riconoscerlo è stato solo il confronto per uuid.
 * @returns `null` quando NON si riusa: il chiamante prosegue con la porta chiusa
 *   che aveva già, cioè il comportamento di sempre.
 */
function riusaIdentitaEsistente(
  opzioni: OpzioniStaffIdentity,
  profilo: { id: string; ruolo: string; scuolaId: string | null },
  input: StaffIdentityInput,
  porta: 'email' | 'uid',
): EnsureStaffIdentityResult | null {
  if (!opzioni.seEsisteRiusa) return null

  // UN PROFILO SENZA `id` NON SI RIUSA. `utenti.id` è l'uid, ed è il valore che il
  // chiamante userà come chiave: `anagrafica_personale.utente_id` è PK e FK su
  // `utenti(id)`. Tornare `ok:true` con la stringa vuota sarebbe un «sì» che non
  // indica nessuno. Non capita — le due SELECT chiedono `id` — ma negarlo costa
  // una riga, e concederlo costa un'anagrafica attaccata al nulla.
  if (!profilo.id) return null

  // IL RUOLO SI NORMALIZZA PRIMA DI DECIDERCI SOPRA. Arriva da una colonna che il
  // database non vincola (vedi `RIUSABILE_PER_RUOLO`): `'Genitore'` e `'genitore '`
  // sono la stessa persona per chiunque legga, e devono esserlo anche per la porta.
  // La forma sta in `normalizzaRuolo`, che è la stessa usata dalla route che quella
  // porta la apre a mano: due normalizzazioni diverse sarebbero due porte diverse.
  const ruolo = normalizzaRuolo(profilo.ruolo)

  if (ruolo === RUOLO_GENITORE) {
    // LA PORTA DEL GENITORE RESTA CHIUSA ANCHE COL RIUSO ACCESO — ed è QUESTA riga
    // a tenerla chiusa, non il punto 3.
    //
    // Il punto 3 legge `parents` e vive dentro `if (authUserId)`, ma soprattutto
    // gira DOPO il punto 1: una madre una riga `utenti` ce l'ha già, con
    // `ruolo: 'genitore'`, scritta da `ensureParentIdentity`. Quindi per lei il
    // punto 1 esce per primo e il controllo su `parents` non viene MAI raggiunto.
    // Senza questa riga, `seEsisteRiusa` non avrebbe aperto una porta: ne avrebbe
    // scavalcata un'altra — e l'anagrafica del PERSONALE sarebbe finita sull'uid
    // di un genitore, in una tabella che dichiara «personale in servizio».
    //
    // Chi decide che una madre è anche una dipendente è una persona, non una route.
    logEvento('anagrafica', 'warn', {
      operazione: OPERAZIONE,
      esito: 'riuso-negato-profilo-genitore',
      entita_tipo: 'utenti',
      utente: profilo.id,
      // Il ruolo NORMALIZZATO: è il valore su cui la decisione è stata presa, e in
      // un log serve quello. Il grezzo — `'Genitore'`, `'genitore '` — direbbe
      // com'è archiviato, ma è una domanda che si fa in SQL, non qui.
      ruolo,
      tipo: porta,
    })
    return {
      ok: false,
      reason: 'email_gia_genitore',
      ruoloEsistente: RUOLO_GENITORE,
      message: MESSAGGIO_GIA_GENITORE,
    }
  }

  // ── UN RUOLO CHE NON È DEL PERSONALE, E NEMMENO QUELLO DEI GENITORI ────────
  // Cioè: un valore che nessuno ha previsto. `utenti.ruolo` non ha `CHECK` né
  // enum (misura in `RIUSABILE_PER_RUOLO`), quindi lo scenario non è teorico —
  // ed è aggravato dall'ambiente: `CLAUDE.md` dichiara che su questo database
  // `execute_sql` gira SENZA conferma umana, per cui un `ruolo` scritto a mano in
  // una forma non canonica è una cosa che questo repo si è già concesso.
  //
  // Si torna `null`, non un errore: questa funzione non ha niente da dire su un
  // valore che non riconosce, e `null` la riporta esattamente alla porta chiusa
  // che c'era prima che l'opzione esistesse — `email_gia_staff`, col ruolo vero
  // dentro, che dice a chi opera di collegare l'account a mano. È la STESSA
  // risposta che ottiene il percorso delle candidature, cioè il verso sicuro.
  //
  // `warn` e non `info`: qui, al contrario del riuso, un'anomalia c'è davvero —
  // in `utenti` esiste una riga con un ruolo fuori dai sei noti — e `warn` è il
  // livello che la fa arrivare in `app_log`, dove si può contare.
  if (!RUOLI_RIUSABILI.has(ruolo)) {
    logEvento('anagrafica', 'warn', {
      operazione: OPERAZIONE,
      esito: 'riuso-negato-ruolo-non-riconosciuto',
      entita_tipo: 'utenti',
      utente: profilo.id,
      ruolo: ruolo || null,
      tipo: porta,
    })
    return null
  }

  // ── LA SEDE DICHIARATA E QUELLA CHE LA PERSONA HA GIÀ ──────────────────────
  // Non si decide niente — vedi `scuolaIdEsistente` nel tipo di ritorno: uno
  // spostamento di plesso è legittimo e lo scrive chi ha il gate. Ma «in
  // silenzio» no: `anagrafica_personale` non ha una `scuola_id`, quindi la sede
  // del personale resta questa, e una divergenza che nessuno registra è
  // precisamente il modo in cui i dati finiscono nel plesso sbagliato senza che
  // se ne accorga nessuno (AGENTS.md, «ogni scrittura dichiara la sua sede»).
  //
  // `warn` perché va in tabella: è l'unico modo di rispondere, a mesi di
  // distanza, alla domanda «quante approvazioni hanno lasciato la persona in un
  // altro plesso?». La condizione richiede ENTRAMBI i valori: con uno dei due
  // assente non c'è divergenza, c'è una lettura incompleta, e chiamarla
  // «divergenza» riempirebbe la tabella di allarmi su un ambiente non migrato.
  if (profilo.scuolaId && input.scuolaId && profilo.scuolaId !== input.scuolaId) {
    logEvento('anagrafica', 'warn', {
      operazione: OPERAZIONE,
      esito: 'riuso-con-sede-diversa',
      entita_tipo: 'utenti',
      utente: profilo.id,
      // Due uuid: passano in chiaro per FORMA, non per chiave (`redact.ts`), e
      // senza entrambi la riga direbbe «divergono» senza dire fra cosa.
      sede_id: profilo.scuolaId,
      sede_dichiarata: input.scuolaId,
      tipo: porta,
    })
  }

  // Il riuso si logga a `info` e non a `warn`: col riuso acceso non è un'anomalia,
  // è il caso previsto, e alzarlo a `warn` renderebbe illeggibile il conteggio
  // delle porte VERE chiuse (`email-gia-staff`/`uid-gia-staff`), che è la query
  // con cui si vede se qualcuno sta creando account doppi.
  //
  // ⚠️ Un `info` su `anagrafica` NON arriva in `app_log`: quel canale sta fra le
  // deroghe di `DEROGHE_INFO_NON_PERSISTITI` (eventi-log.test.ts), quindi resta
  // sulla riga di Vercel. È voluto — qui non nasce niente, e il battito DUREVOLE
  // dell'approvazione lo scrive la route che chiama, che è l'unica a sapere quale
  // pratica ha chiuso e in quale sede.
  logEvento('anagrafica', 'info', {
    operazione: OPERAZIONE,
    esito: 'identita-staff-riusata',
    entita_tipo: 'utenti',
    utente: profilo.id,
    ruolo: ruolo || null,
    // La sede che quella persona HA, non quella che la pratica dichiara: è il
    // dato che rende leggibile la riga accanto a un eventuale
    // `riuso-con-sede-diversa`.
    sede_id: profilo.scuolaId,
    tipo: porta,
  })
  return {
    ok: true,
    authUserId: profilo.id,
    createdAuth: false,
    password: null,
    // Le fasce d'età di `input` NON sono state scritte: la riga `utenti` c'era già
    // e non la si tocca. Dire `true` prometterebbe che sono finite da qualche
    // parte, e il chiamante non avviserebbe che vanno assegnate a mano.
    gradiScritti: false,
    riusato: true,
    // Gli altri due pezzi di `input` scartati dal riuso, restituiti come FATTI:
    // `gradiScritti: false` era l'unico dei tre a essere dichiarato, e da solo
    // lasciava credere che ruolo e sede fossero invece stati applicati.
    ruoloEsistente: ruolo,
    scuolaIdEsistente: profilo.scuolaId,
  }
}

/**
 * Completa l'identità di accesso di un membro dello staff: account `auth.users`
 * (riusato se esiste già per quell'email) e riga `utenti` col ruolo dichiarato.
 *
 * @param opzioni spente di default: senza terzo argomento il comportamento è
 *   quello di sempre, ed è ciò su cui conta l'approvazione delle CANDIDATURE.
 * @returns `ok:true` con la password SOLO se l'account è nato adesso.
 */
export async function ensureStaffIdentity(
  admin: SupabaseClient,
  input: StaffIdentityInput,
  opzioni: OpzioniStaffIdentity = {},
): Promise<EnsureStaffIdentityResult> {
  try {
    const email = (input.email ?? '').trim()
    if (!email) {
      return { ok: false, reason: 'error', message: 'Candidatura senza email: impossibile creare l\'account.' }
    }

    // ── 1. L'email è già di un account del PERSONALE? ────────────────────────
    // La lettura sta in `cercaProfiloPerEmail` (in cima a questo file), perché la
    // fa anche il risolutore di `admin/staff/collega-profilo-esistente` e le due
    // devono dare la stessa risposta. Lì stanno anche i due ⚠️ che la riguardano:
    // il confronto per valore esatto su due forme (mai `ilike`) e il limite di
    // quella copertura.
    //
    // CHI CHIUDE IL BUCO DELLE MAIUSCOLE, ESATTAMENTE — e fin dove arriva:
    //  · il punto 3-bis confronta per UID, dove le maiuscole non esistono, ma vive
    //    dentro `if (authUserId)`: chiude il caso SOLO quando in `auth.users`
    //    l'account esiste già;
    //  · resta scoperta la riga `utenti` SENZA account corrispondente (riga
    //    orfana, account cancellato a mano, e lo spazio in cui opera il rollback
    //    del punto 5): lì `findAuthUserIdByEmail` torna null, il 3-bis non gira e
    //    si arriva all'INSERT, che passa perché la chiave è sensibile al caso —
    //    due profili per la stessa persona.
    // Per non allargare da soli quel buco, il punto 5 archivia l'email
    // MINUSCOLA: il repo smette di produrre le varianti che poi non riconosce.
    const { profilo: staff, error: errStaff } = await cercaProfiloPerEmail(admin, email)
    if (errStaff) {
      // PostgREST non lancia: senza questo controllo una lettura fallita si
      // travestirebbe da «email libera» e creerebbe il secondo account.
      logEvento('anagrafica', 'error', {
        operazione: OPERAZIONE,
        esito: 'verifica-email-staff-non-riuscita',
        entita_tipo: 'utenti',
        error_code: (errStaff as { code?: string }).code ?? null,
      }, errStaff)
      return {
        ok: false,
        reason: 'error',
        message: 'Verifica dell\'email sugli account del personale non riuscita: riprovare fra poco.',
      }
    }
    if (staff) {
      const ruoloEsistente = staff.ruolo
      const idEsistente = staff.id
      const sedeEsistente = staff.scuolaId
      // Prima di dichiararla chiusa: col riuso acceso questa non è una porta, è la
      // risposta attesa. `null` = non si riusa, e allora vale tutto ciò che segue.
      const riuso = riusaIdentitaEsistente(
        opzioni,
        { id: idEsistente, ruolo: ruoloEsistente, scuolaId: sedeEsistente },
        input,
        'email',
      )
      if (riuso) return riuso
      logEvento('anagrafica', 'warn', {
        operazione: OPERAZIONE,
        esito: 'email-gia-staff',
        entita_tipo: 'utenti',
        entita_id: idEsistente,
        ruolo: ruoloEsistente || null,
      })
      return {
        ok: false,
        reason: 'email_gia_staff',
        ruoloEsistente: ruoloEsistente || undefined,
        message:
          'Questa email appartiene già a un account del personale: collegare la candidatura ' +
          'all\'account esistente invece di crearne un secondo.',
      }
    }

    // ── 2. L'account esiste già in `auth.users`? ─────────────────────────────
    let authUserId: string | null = null
    try {
      authUserId = await findAuthUserIdByEmail(admin, email)
    } catch (e) {
      // `findAuthUserIdByEmail` è l'unica delle tre porte che LANCIA invece di
      // ritornare un `{ error }`, e ciò che lancia è
      // `auth.admin.listUsers (pagina N): <corpo grezzo di GoTrue>`. Interpolarlo
      // qui significava servirlo come `body.error` alla segreteria: stessa prosa
      // inglese di terze parti che il ramo `createUser` e quello dell'INSERT
      // tengono già fuori. Il dettaglio viaggia con l'errore, ultimo argomento.
      logEvento('auth', 'error', { operazione: OPERAZIONE, esito: 'ricerca-account-non-riuscita' }, e)
      return {
        ok: false,
        reason: 'error',
        message: 'Verifica dell\'account non riuscita: riprovare fra poco.',
      }
    }

    // ── 3. Quell'uid è già l'accesso di un GENITORE? ─────────────────────────
    if (authUserId) {
      const { data: genitore, error: errGenitore } = await admin
        .from('parents')
        .select('id')
        .eq('auth_user_id', authUserId)
        .maybeSingle()
      if (errGenitore) {
        logEvento('anagrafica', 'error', {
          operazione: OPERAZIONE,
          esito: 'verifica-email-genitore-non-riuscita',
          entita_tipo: 'parents',
          error_code: (errGenitore as { code?: string }).code ?? null,
        }, errGenitore)
        return {
          ok: false,
          reason: 'error',
          message: 'Verifica dell\'email sulle anagrafiche dei genitori non riuscita: riprovare fra poco.',
        }
      }
      if (genitore) {
        logEvento('anagrafica', 'warn', {
          operazione: OPERAZIONE,
          esito: 'email-gia-genitore',
          entita_tipo: 'parents',
          utente: authUserId,
        })
        return {
          ok: false,
          reason: 'email_gia_genitore',
          ruoloEsistente: RUOLO_GENITORE,
          message: MESSAGGIO_GIA_GENITORE,
        }
      }
    }

    // ── 3-bis. Quell'uid ha GIÀ una riga `utenti`? ───────────────────────────
    // La porta chiusa del punto 1, ma per UID invece che per email: `utenti.id`
    // È l'uid di `auth.users`, e un uuid non ha maiuscole. È l'unica lettura che
    // regge quando in tabella l'indirizzo è scritto con una capitalizzazione
    // diversa da quella digitata nella candidatura — caso in cui, senza questo
    // controllo, si arriverebbe all'INSERT e si prenderebbe un `23505` sulla
    // chiave primaria: cioè un 503 con dentro la prosa grezza di PostgREST,
    // invece del 409 che dice alla segreteria di collegare l'account esistente.
    if (authUserId) {
      const { data: giaUtente, error: errUtente } = await admin
        .from('utenti')
        .select('id, ruolo, scuola_id')
        .eq('id', authUserId)
        .maybeSingle()
      if (errUtente) {
        // Fail-closed come il punto 1: non sapere è motivo per fermarsi.
        logEvento('anagrafica', 'error', {
          operazione: OPERAZIONE,
          esito: 'verifica-uid-staff-non-riuscita',
          entita_tipo: 'utenti',
          error_code: (errUtente as { code?: string }).code ?? null,
        }, errUtente)
        return {
          ok: false,
          reason: 'error',
          message: 'Verifica dell\'account del personale non riuscita: riprovare fra poco.',
        }
      }
      if (giaUtente) {
        const ruoloEsistente = String((giaUtente as { ruolo?: unknown }).ruolo ?? '')
        const sedeEsistente = String((giaUtente as { scuola_id?: unknown }).scuola_id ?? '') || null
        // Stessa decisione del punto 1, presa dalla stessa funzione: qui l'uid è
        // già in mano (siamo dentro `if (authUserId)`), quindi non c'è nemmeno da
        // rileggerlo dalla riga.
        const riuso = riusaIdentitaEsistente(
          opzioni,
          { id: authUserId, ruolo: ruoloEsistente, scuolaId: sedeEsistente },
          input,
          'uid',
        )
        if (riuso) return riuso
        logEvento('anagrafica', 'warn', {
          operazione: OPERAZIONE,
          esito: 'uid-gia-staff',
          entita_tipo: 'utenti',
          utente: authUserId,
          ruolo: ruoloEsistente || null,
        })
        return {
          ok: false,
          reason: 'email_gia_staff',
          ruoloEsistente: ruoloEsistente || undefined,
          message:
            'Questa email appartiene già a un account del personale: collegare la candidatura ' +
            'all\'account esistente invece di crearne un secondo.',
        }
      }
    }

    // ── 4. L'account, se non c'è ─────────────────────────────────────────────
    let password: string | null = null
    let createdAuth = false
    if (!authUserId) {
      password = randomPassword()
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        password,
      })
      if (error || !data?.user) {
        // Il corpo dell'errore del provider non si butta via (AGENTS.md §3):
        // «status 500» non dice niente, «email address already registered» dice
        // tutto. Ma dice tutto A CHI LEGGE I LOG: è inglese, ed è la stessa prosa
        // di terze parti che il ramo dell'INSERT qui sotto tiene fuori dalla
        // risposta HTTP. Quindi `dettaglio` viaggia con l'errore — quando `error`
        // è null è l'unico posto in cui «nessun utente restituito» sopravvive — e
        // alla segreteria torna la frase stabile con il suo `codice`.
        const dettaglio = error ? dettaglioErroreAuth(error) : 'nessun utente restituito'
        logEvento('auth', 'error', {
          operazione: OPERAZIONE,
          esito: 'creazione-account-non-riuscita',
          stato: typeof (error as { status?: number } | null)?.status === 'number'
            ? (error as { status?: number }).status
            : undefined,
        }, error ?? new Error(`createUser: ${dettaglio}`))
        return {
          ok: false,
          reason: 'error',
          message: 'Creazione dell\'account di accesso non riuscita: riprovare fra poco.',
        }
      }
      authUserId = data.user.id
      createdAuth = true
    }

    // ── 5. La riga `utenti` ──────────────────────────────────────────────────
    // MAI `role`/`first_name`/`last_name`: sono colonne GENERATE da
    // `ruolo`/`nome`/`cognome`, e scriverle fa fallire l'INSERT.
    //
    // L'EMAIL SI ARCHIVIA MINUSCOLA. GoTrue normalizza già l'indirizzo in
    // `auth.users`: scriverlo qui com'è stato digitato nella candidatura
    // significava due verità sulla stessa persona in due tabelle, e soprattutto
    // significava che questo file PRODUCEVA le varianti di caso che il punto 1
    // non sa più riconoscere (vedi il ⚠️ lassù). Non chiude il buco delle righe
    // già archiviate con le maiuscole — quello lo chiude un indice su
    // `lower(email)` — ma smette di allargarlo.
    const record: Record<string, unknown> = {
      id: authUserId,
      email: email.toLowerCase(),
      nome: (input.nome ?? '').trim() || email.split('@')[0],
      cognome: (input.cognome ?? '').trim(),
      cellulare: input.cellulare ?? null,
      ruolo: input.ruolo,
      scuola_id: input.scuolaId,
      gradi: input.gradi,
      attivo: true,
    }
    let gradiScritti = true
    let esito = await admin.from('utenti').insert(record).select('id').single()
    let tentativi = 0
    while (
      esito.error &&
      COLONNA_ASSENTE.has((esito.error as { code?: string }).code ?? '') &&
      tentativi < COLONNE_RIMOVIBILI.size
    ) {
      const col = colonnaMancante(esito.error.message ?? '')
      if (!col || !(col in record) || !COLONNE_RIMOVIBILI.has(col)) break
      // `msg` finisce in chiaro nella colonna `app_log.messaggio` (`redact` è a
      // lista bianca per CHIAVE, e `campo` non ci sta): è l'unico posto in cui il
      // NOME della colonna caduta si legge davvero.
      logEvento('anagrafica', 'warn', {
        operazione: OPERAZIONE,
        esito: 'colonna-assente-rimossa',
        entita_tipo: 'utenti',
        error_code: (esito.error as { code?: string }).code ?? null,
        msg: `colonna assente su utenti, rimossa dall'INSERT: ${col}`,
      })
      delete record[col]
      if (col === 'gradi') gradiScritti = false
      esito = await admin.from('utenti').insert(record).select('id').single()
      tentativi++
    }
    if (esito.error) {
      logEvento('anagrafica', 'error', {
        operazione: OPERAZIONE,
        esito: 'profilo-staff-non-creato',
        entita_tipo: 'utenti',
        error_code: (esito.error as { code?: string }).code ?? null,
        // `account_creato` è il campo che rende leggibile la riga a mesi di
        // distanza: dice se dietro questo errore c'è, o non c'è, un account.
        account_creato: createdAuth,
      }, esito.error)
      // IL MESSAGGIO GREZZO DEL DATABASE NON ESCE DA QUI, e non è una sfumatura:
      // `message` finisce TALE E QUALE nella risposta HTTP che legge la segreteria
      // (`admin/candidature-insegnanti/route.ts`, ramo 503), e `esito.error.message`
      // è prosa inglese di PostgREST con dentro nomi di colonne, di vincoli e —
      // su un `23505` — il VALORE che ha violato la chiave, cioè l'email di una
      // persona vera. Lo stesso file chiamante lo dichiara già sul guasto dello
      // storage: «il messaggio grezzo NON torna al client». Qui vale identico.
      // Il testo esatto vive dov'era già: nel `logEvento('anagrafica','error',
      // { esito:'profilo-staff-non-creato', error_code }, esito.error)` di sopra.
      //
      // Quel che resta nel messaggio è AZIONE PER CHI OPERA, non diagnosi.
      if (createdAuth && authUserId) {
        const annullato = await annullaAccountAppenaCreato(admin, authUserId)
        if (!annullato) {
          return {
            ok: false,
            reason: 'error',
            accountOrfano: true,
            authUserIdOrfano: authUserId,
            message:
              'Profilo del personale (utenti) non creato. ' +
              'ATTENZIONE: l\'account di accesso È STATO CREATO e non è stato possibile annullarlo. ' +
              'Ripremere «Approva» non genererà nessuna password: le credenziali si ottengono ' +
              'solo con «Rigenera credenziali» dal pannello Personale.',
          }
        }
        return {
          ok: false,
          reason: 'error',
          message:
            'Profilo del personale (utenti) non creato: l\'account appena creato è stato ' +
            'annullato, si può riprovare fra poco.',
        }
      }
      return {
        ok: false,
        reason: 'error',
        message: 'Profilo del personale (utenti) non creato: riprovare fra poco.',
      }
    }

    return { ok: true, authUserId, createdAuth, password: createdAuth ? password : null, gradiScritti }
  } catch (e) {
    // Un `catch` che non logga è un bug: qui dentro passa la creazione di un
    // account con accesso all'anagrafica dei bambini.
    //
    // E il testo dell'eccezione resta QUI. Questo `catch` prende qualunque cosa
    // — un guasto di rete, un bug, una libreria — e nessuno di quei messaggi è
    // scritto da noi: possono contenere una query, un host interno, un header.
    // `message` esce tale e quale come `body.error` (route ramo 503), quindi la
    // frase è stabile e il testo vero vive nel log qui sopra.
    logEvento('auth', 'error', { operazione: OPERAZIONE, esito: 'identita-staff-non-completata' }, e)
    return { ok: false, reason: 'error', message: 'Operazione non riuscita: riprovare fra poco.' }
  }
}
