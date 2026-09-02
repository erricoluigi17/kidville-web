import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AuthResult } from '@/lib/auth/require-staff'
import { agisceComeGenitore, eFamiglia } from '@/lib/auth/predicati-ruolo'
import { verificaLegameGenitore } from '@/lib/anagrafiche/legami'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * Un uuid, per distinguere «id sbagliato» da «guasto di lettura». Sette delle
 * venti route che passano di qui validano `studentId` come stringa non vuota
 * (non `zUuid`): senza questa distinzione PostgREST risponderebbe `22P02` alla
 * verifica di scope, `assertAlunnoInScope` lo tratterebbe da guasto (500 +
 * `error` `scope-alunno-non-risolto`) e un contatore nato per segnalare un DB
 * rotto si riempirebbe di errori di battitura.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ────────────────────────────────────────────────────────────────────────────
 * I DUE PREDICATI DEI RUOLI SONO IMPORTATI — e per un po' non lo erano.
 *
 * Fino al 2026-09-01 questo file RI-DICHIARAVA `eFamiglia` e `agisceComeGenitore`
 * in casa propria, e la ragione era vera: importarli da `@/lib/auth/require-staff`
 * faceva diventare rossi **46 test su 7 file**, 40 con lo stesso identico errore —
 *   `[vitest] No "eFamiglia" export is defined on the "@/lib/auth/require-staff" mock`
 * — e quattro di quei sette file non c'entravano niente con questo gate
 * (`diary-students-genitori-unione`, `diary-students-id-gate`,
 * `parent-mensa-allergie`, `parent-onboarding`).
 *
 * LA CAUSA NON ERA IL MOCK, ERA IL MODULO: `require-staff.ts` teneva insieme l'I/O
 * (`requireUser`, `resolveIdentity`, `loadAppUser`) e i predicati PURI, e 296 file
 * lo sostituiscono per intero per iniettare un'identità. Il rimedio strutturale è
 * stato applicato: i predicati vivono in `@/lib/auth/predicati-ruolo`, che nessuno
 * mocka perché non fa I/O, e `require-staff.ts` li ri-esporta per non muovere un
 * solo call site. Da qui si importano da lì, e la duplicazione è sparita.
 *
 * La cautela di allora resta scritta perché la lezione vale ancora: se un domani
 * un import da `@/lib/auth/require-staff` facesse esplodere test che non parlano di
 * autorizzazione, il difetto è il MODULO che mescola I/O e regole, non il test.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Gate per le route che leggono o scrivono i dati di UN alunno indicato dal
 * client — venti, di cui cinque in scrittura e una con valore legale (la firma
 * FES della giustifica).
 *
 * Chiude tre buchi, non uno:
 *  1. Auth-bypass (`?userId=` arbitrario): usa `requireUser` → `resolveIdentity`,
 *     che lega l'identità alla SESSIONE reale (con `ALLOW_HEADER_IDENTITY=false`
 *     l'header/query non è più accettato). 401 se non autenticato.
 *  2. IDOR sulla FAMIGLIA: chi è genitore NEL DATABASE deve avere il legame con
 *     l'alunno (`verificaLegameGenitore`, unione robusta `legame_genitori_alunni`
 *     + `student_parents` via ponte `parents.auth_user_id`). 403 altrimenti.
 *  3. IDOR fra SEDI e fra CLASSI: chi non ha (o non usa) un legame di famiglia
 *     deve avere l'alunno nel proprio plesso e — se `educator` — nella propria
 *     sezione (`assertAlunnoInScope`).
 *
 * ⚠️ LA BIFORCAZIONE È SUL LEGAME, NON SULLA VESTE, e fino al 2026-09-01 non lo
 * era: la condizione leggeva `auth.user.role === 'genitore'`, cioè il ruolo
 * ATTIVO (cookie). Quattro persone in produzione hanno insieme `utenti.ruolo =
 * 'educator'` e il ponte `parents.auth_user_id`: sei dei loro legami
 * figlio↔genitore cadono fuori dalle sezioni che insegnano e uno è in un'altra
 * sede, e aprendo il diario del PROPRIO figlio prendevano `403 «Alunno non nella
 * tua classe»`. I due rami NON si escludono: chi è famiglia prova prima il
 * legame e, se quel bambino non è suo figlio, ricade sullo scope di lavoro —
 * così un docente-genitore resta un docente su tutti gli altri bambini.
 *
 * ⚠️ IL PUNTO 3 NON C'ERA, e fino al 2026-07-31 questa testata dichiarava il
 * contrario: «staff/educator passano: il loro scope è applicato altrove nelle
 * rispettive query». Contati uno per uno, i venti call site stavano così:
 * **diciotto non avevano nulla**; `gallery:GET` aveva il solo controllo di
 * PLESSO (non di sezione), aggiunto il giorno prima come tampone locale; e
 * `diary/students:GET` era l'unico con il gate completo, scritto a mano. Il
 * client è `createAdminClient()` (service-role), che scavalca la RLS: dove
 * l'altrove non c'era, non c'era nessuna difesa.
 *
 * Misurato in produzione, non dedotto: `GET /api/diary/entries?alunno_id=<minore
 * di Giugliano>` con la sessione di un educator di AVERSA rispondeva **200** con
 * il diario completo (bagno, pranzo, attività); `GET
 * /api/parent/primaria/assenze` restituiva le assenze col `giustificazione_testo`,
 * che è testo libero di natura sanitaria. Ripetuto su cinque minori e sette
 * attori — docenti e segreterie di altre sedi, e perfino la CUOCA: 200 per
 * tutti. L'unico 403 arrivava all'altro genitore. In `app_log` nemmeno un warn:
 * senza gate non esiste neppure il segnale che qualcuno ci ha provato.
 *
 * Il perimetro NON si stringe sui percorsi legittimi: l'educator continua a
 * vedere i bambini delle proprie sezioni, la segreteria tutte le classi del
 * proprio plesso, la Direzione tutti i plessi che ha in `utenti_scuole`. E al
 * genitore la sede non si applica affatto — due fratelli possono essere iscritti
 * in due plessi diversi, il suo scope è la famiglia.
 *
 * Uso (dopo aver risolto `studentId`, es. da `parseQuery`):
 * ```ts
 * const auth = await requireParentOfStudent(request, studentId)
 * if (auth.response) return auth.response
 * const userId = auth.user.id
 * ```
 */
export async function requireParentOfStudent(
  request: Request,
  studentId: string
): Promise<AuthResult> {
  const auth = await requireUser(request)
  if (auth.response) return auth

  const supabase = await createAdminClient()

  // ── LA GUARDIA UUID VALE PER TUTTI, GENITORI COMPRESI (rilievo T16) ───────
  //
  // Stava DOPO il `return` del ramo `genitore`, cioè copriva quattro ruoli su
  // cinque. Per un genitore il valore grezzo arrivava fino a
  // `.eq('alunno_id','abc')` e PostgREST rispondeva `22P02`: una riga di livello
  // `error` in `app_log` per un errore di BATTITURA del client, che alimenta la
  // soglia `tasso-errore` di /api/health (5 impronte distinte in 15 minuti, e
  // l'impronta include l'utente: bastano cinque genitori con un id sbagliato per
  // far dichiarare `degraded` un'applicazione sana).
  //
  // La risposta onesta è 404 — la stessa che queste rotte danno già quando il
  // lookup non trova niente — e NON il `warn` di IDOR: un id malformato non è un
  // tentativo di leggere il figlio di un altro, è un client che sbaglia.
  //
  // Il `codice` c'è, e non è un dettaglio di forma: le schermate della famiglia
  // mostrano SOLO frasi di catalogo, e senza codice questo 404 usciva come prosa
  // italiana anche con l'app in inglese. `ALUNNO_NON_TROVATO` è già dichiarato e
  // tradotto, e dice esattamente questo.
  if (!UUID.test(studentId ?? '')) {
    return {
      response: NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_NON_TROVATO' },
        { status: 404 },
      ),
    }
  }

  // ── LA FAMIGLIA VINCE, E PRIMA DEL RUOLO ─────────────────────────────────
  //
  // Questa riga diceva `auth.user.role === 'genitore'`, e biforcava sulla VESTE
  // invece che sul LEGAME. Misurato in produzione: quattro persone hanno insieme
  // una riga `utenti` con ruolo `educator` e il ponte `parents.auth_user_id` sullo
  // stesso `auth.uid()` — sono insegnanti che sono anche genitori di un bambino
  // della scuola. SEI dei loro legami figlio↔genitore cadono fuori dalle sezioni
  // che insegnano e UNO è in un'altra sede: aprendo il diario del PROPRIO figlio
  // finivano su `assertAlunnoInScope`, che confronta `utenti_sezioni` —  cioè le
  // classi che INSEGNANO, che col figlio non c'entrano niente — e si prendevano
  // `403 «Alunno non nella tua classe»` sul registro del figlio.
  //
  // `eFamiglia` guarda i ruoli REALI (database), non il cookie: è AUTORIZZAZIONE.
  // È anche il PONTE già letto insieme all'identità (`resolveIdentity` legge
  // `utenti` e `parents` in parallelo), quindi qui costa zero query in più — ed è
  // il motivo per cui la condizione sta PRIMA della lettura dei legami e non
  // dopo: 61 educator su 61 non hanno il ponte, non entrano qui, e non pagano le
  // letture di `verificaLegameGenitore` (fast-path a una query, più il fallback
  // anagrafico a tre). Un gate che tassa 61 persone per servirne 4 è un gate che
  // qualcuno finirà per togliere.
  if (eFamiglia(auth.user)) {
    const esito = await verificaLegameGenitore(supabase, auth.user.id, studentId)

    // ── «NON L'HO POTUTO LEGGERE» NON È «NON È TUO FIGLIO» (rilievo T13) ────
    //
    // PostgREST non lancia (AGENTS.md, regola 7). Finché il legame era un
    // `boolean`, una lettura fallita usciva da QUESTA porta: 403 «Accesso
    // negato» al genitore titolare, più una riga nel contatore degli IDOR a suo
    // nome. Misurato in sessione: `legame_genitori_alunni` ha davvero risposto
    // 403 con una pagina HTML di Cloudflare, e il rifiuto è arrivato al
    // genitore come se avesse tentato di leggere il figlio di un altro.
    //
    // 500 e non 403, e `logErrore` e non `warn`: è un guasto del server, e va
    // contato fra i guasti del server. Il contatore di sicurezza qui sotto deve
    // restare quello dei soli tentativi VERI, altrimenti non serve a niente.
    if (esito === 'non-deciso') {
      logErrore({
        operazione: 'requireParentOfStudent',
        stato: 500,
        evento: 'auth',
      }, new Error('legame-genitore-non-deciso: lettura dei legami non riuscita'))
      // Nessun `codice` proprio, ed è una scelta con un prezzo dichiarato: questo
      // gate serve VENTI rotte (galleria, chat, mensa, diario, moduli, presenze),
      // e nessuno dei codici dichiarati in `CODICI_ERRORE` descrive tutte e venti
      // — `PRESENZE_NON_LETTE` racconterebbe di presenze a chi stava aprendo una
      // chat. Senza codice la famiglia legge la frase generica del catalogo
      // (`soloCatalogoDaCorpo`), che è tradotta e dice la cosa giusta:
      // «riprova». Il debito congelato da `errori-con-codice` non cresce perché
      // il 404 qui sopra, che prima era nudo, ora il suo codice ce l'ha.
      return { response: NextResponse.json({ error: 'Errore interno' }, { status: 500 }) }
    }

    if (esito === 'si') {
      // ─── IL SEGNALE CHE DICE SE LA CORREZIONE È VIVA ─────────────────────
      //
      // Una riga `info` (Vercel, non persistita: `vaPersistito` tiene in tabella
      // solo `warn` ed `error`) emessa SOLO quando il legame ha aperto una porta
      // che il ruolo attivo, da solo, non avrebbe aperto. È l'unico modo di
      // rispondere alla domanda «i quattro profili doppi la stanno davvero
      // usando?» senza andare a leggere i diari di quei bambini.
      //
      // CONDIZIONATA, e non «sempre, tanto è info»: chi agisce già da genitore
      // passa di qui a ogni schermata dell'app di famiglia — sono le richieste
      // più frequenti del sistema — e una riga costante non distingue niente da
      // niente. Il segnale è la DIFFERENZA fra la veste e il legame.
      //
      // SOLO UUID ED ENUMERATI: `tipo`, `azione` e `ruolo` sono in lista bianca
      // di `redact`, `utente` passa per FORMA (uuid). Nessun `alunno_id`: qui non
      // è stato negato niente, e il bambino di cui si apre il diario non ha
      // motivo di comparire in una riga che serve a contare le PERSONE.
      if (!agisceComeGenitore(auth.user)) {
        logEvento('auth', 'info', {
          tipo: 'accesso-per-legame-famiglia',
          azione: 'requireParentOfStudent',
          utente: auth.user.id,
          ruolo: auth.user.role,
        })
      }
      return { user: auth.user }
    }

    // ─── ESITO `no`: E QUI LE DUE VESTI SI SEPARANO ────────────────────────
    //
    // Chi AGISCE da genitore ha chiesto un bambino che non è suo figlio, dentro
    // una vista che mostra solo i figli: è il tentativo che il contatore qui
    // sotto esiste per contare, e il 403 è definitivo — non gli si offre una
    // seconda strada che nella vista di famiglia non ha senso.
    //
    // Chi NON agisce da genitore (il docente-genitore in veste di lavoro) ha
    // semplicemente aperto il registro di un bambino che non è suo figlio: è il
    // suo mestiere. Non è un tentativo di IDOR e non va contato come tale —
    // cade sullo scope di plesso/sezione qui sotto, esattamente come i 61
    // educator senza ponte, e lì sarà ammesso o negato per i motivi di sempre.
    if (agisceComeGenitore(auth.user)) {
      // ─── IL TENTATIVO CHE PIÙ DI OGNI ALTRO SI VUOLE POTER CONTARE ───────
      //
      // Fino al 2026-08-07 questo `return` era nudo, e il rifiuto non lasciava
      // NIENTE: `withRoute` classifica i 403 a livello `info`, e `vaPersistito`
      // manda in tabella solo `warn` ed `error`. Il collaudo ha provato dodici
      // volte di fila a scrivere sul registro di un bambino altrui — dodici 403
      // corretti — e in `app_log` non c'era una sola riga a dirlo. È la stessa
      // forma del difetto che ha aperto questo ciclo: una funzione vissuta un
      // mese in silenzio perfetto perché i suoi 403 erano `info`.
      //
      // ─── PERCHÉ QUI E NON NELLE ROUTE ────────────────────────────────────
      //
      // Perché il rifiuto lo decide QUESTA funzione, e le route che ci passano
      // sono venti: scriverlo in una coprirebbe una su venti, e le altre
      // diciannove resterebbero mute esattamente come oggi — è la stessa
      // divergenza che il ramo qui sotto ha già pagato (il `warn` c'era, ma solo
      // per metà dei rami). E il gemello per i NON-genitori sta 27 righe più
      // sotto, nello stesso file: una difesa sola, un posto solo.
      //
      // SOLO UUID ED ENUMERATI. `tipo`, `azione` e `ruolo` sono in lista bianca
      // di `redact`; `utente` e `alunno_id` passano per FORMA (uuid). Nessun
      // nome, nessuna email, nessun testo libero: sono dati di minori, e un
      // contatore di tentativi non ha bisogno di sapere di chi.
      //
      // ─── PERCHÉ `distingui`, E PERCHÉ NON BASTAVA METTERLO NEI CAMPI ──────
      //
      // `app_log` deduplica per `(fingerprint, giorno)` e l'impronta NON contiene
      // il contesto: mettere `alunno_id` nei campi «per poter contare» — che è
      // ciò che questa riga faceva — non contava niente. Misurato: due tentativi
      // su due bambini diversi lasciavano UNA riga con `occorrenze: 2` e
      // `contesto.campi.alunno_id` del PRIMO; i due bambini appena colpiti non
      // comparivano da nessuna parte. Enumerare venti figli altrui e insistere
      // venti volte sullo stesso producevano la stessa identica riga — cioè il
      // segnale che più di ogni altro si voleva poter distinguere.
      //
      // `stato: 403` non è ornamento: `logEvento` popola la COLONNA `stato_http`
      // solo se `stato` è un numero, e senza, «dammi tutti i 403 di ieri» non
      // trovava questi rifiuti — si potevano cercare solo per messaggio.
      logEvento('auth', 'warn', {
        tipo: 'alunno-non-della-famiglia',
        azione: 'requireParentOfStudent',
        utente: auth.user.id,
        ruolo: auth.user.role,
        alunno_id: studentId,
        stato: 403,
      }, undefined, { distingui: ['alunno_id'] })
      return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    }
    // Esito `no` senza veste di genitore: si prosegue, non si esce.
  }

  // ── Tutti gli altri ruoli: plesso + sezione assegnata ────────────────────
  // (La guardia uuid sta ORA sopra la biforcazione dei ruoli: era qui, e
  // amnistiava proprio il ramo `genitore`.)
  const fuoriScope = await assertAlunnoInScope(supabase, auth.user, studentId)
  if (!fuoriScope) return { user: auth.user }

  // Il `warn` (persistito: `vaPersistito` manda in tabella warn ed error) va
  // SOLO sul 403. `assertAlunnoInScope` risponde anche 404 «alunno non trovato»
  // e 500 «verifica di scope non riuscita»: il primo è il banale id sbagliato, e
  // contarlo qui dentro renderebbe il segnale indistinguibile dal rumore — è la
  // stessa lezione già scritta in `assertParentInScope`. Il secondo si logga da
  // sé, a livello `error`.
  //
  // Un solo `tipo` per due dinieghi diversi (fuori plesso / fuori dalle proprie
  // sezioni): distinguerli qui vorrebbe dire leggere il corpo della risposta o
  // duplicare la logica dello scope. Restano distinguibili dal `ruolo`, che è
  // sulla riga: solo `educator` può essere negato per la sezione.
  //
  // L'ALUNNO C'È ANCHE QUI, e fino al terzo collaudo no: le due difese scritte
  // nello stesso file a trenta righe di distanza raccontavano il rifiuto in due
  // modi diversi, e su questo ramo l'alunno finiva solo dentro
  // `payload.query.studentId` — cioè dove `withRoute` lo mette per caso, non dove
  // il gate lo dichiara. Stesso `distingui` e stesso `stato` del ramo gemello:
  // una difesa sola, un posto solo, e due righe che si leggono con la stessa query.
  if (fuoriScope.status === 403) {
    logEvento('auth', 'warn', {
      tipo: 'alunno-fuori-sede',
      azione: 'requireParentOfStudent',
      utente: auth.user.id,
      ruolo: auth.user.role,
      alunno_id: studentId,
      stato: 403,
    }, undefined, { distingui: ['alunno_id'] })
  }
  return { response: fuoriScope }
}
