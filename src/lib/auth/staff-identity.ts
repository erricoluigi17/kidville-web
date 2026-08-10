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

export type EnsureStaffIdentityResult =
  | {
      ok: true
      authUserId: string
      /** Account `auth.users` creato ORA (password temporanea in `password`). */
      createdAuth: boolean
      /** Password temporanea SOLO quando `createdAuth`: altrimenti non la conosce nessuno. */
      password: string | null
      /** `false` quando la colonna `gradi` non esiste (DB della CI non migrato). */
      gradiScritti: boolean
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
 * Completa l'identità di accesso di un membro dello staff: account `auth.users`
 * (riusato se esiste già per quell'email) e riga `utenti` col ruolo dichiarato.
 *
 * @returns `ok:true` con la password SOLO se l'account è nato adesso.
 */
export async function ensureStaffIdentity(
  admin: SupabaseClient,
  input: StaffIdentityInput,
): Promise<EnsureStaffIdentityResult> {
  try {
    const email = (input.email ?? '').trim()
    if (!email) {
      return { ok: false, reason: 'error', message: 'Candidatura senza email: impossibile creare l\'account.' }
    }

    // ── 1. L'email è già di un account del PERSONALE? ────────────────────────
    // Confronto per valore ESATTO su due forme (com'è scritta e minuscola) e non
    // con `ilike`: PostgREST traduce `*` in `%` dentro i pattern, quindi un
    // carattere jolly arrivato dal modulo pubblico allargherebbe la ricerca
    // invece di stringerla. `.in()` è uguaglianza pura.
    //
    // ⚠️ QUESTE DUE FORME COPRONO UNA DIREZIONE SOLA, e va detto invece che
    // promesso al contrario: se in `utenti` l'indirizzo è archiviato
    // `Mario.Rossi@x.it` e la candidata scrive `mario.rossi@x.it`, qui non esce
    // niente. `utenti_email_key` è UNIQUE **sensibile alle maiuscole**, quindi
    // nemmeno il database chiude il buco.
    //
    // CHI LO CHIUDE, ESATTAMENTE — e fin dove arriva, che è la parte che questo
    // commento prima taceva:
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
    // La chiusura vera è un indice su `lower(email)`; quel giorno il filtro giusto
    // è quello e questi due valori diventano superflui.
    const forme = [...new Set([email, email.toLowerCase()])]
    const { data: staff, error: errStaff } = await admin
      .from('utenti')
      .select('id, ruolo, email')
      .in('email', forme)
      .limit(1)
      .maybeSingle()
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
      const ruoloEsistente = String((staff as { ruolo?: unknown }).ruolo ?? '')
      logEvento('anagrafica', 'warn', {
        operazione: OPERAZIONE,
        esito: 'email-gia-staff',
        entita_tipo: 'utenti',
        entita_id: String((staff as { id?: unknown }).id ?? ''),
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
          ruoloEsistente: 'genitore',
          message:
            'Questa email è già quella di un genitore: serve una decisione della segreteria per ' +
            'aggiungere il ruolo di insegnante senza togliere l\'accesso alle schede dei figli.',
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
        .select('id, ruolo')
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
