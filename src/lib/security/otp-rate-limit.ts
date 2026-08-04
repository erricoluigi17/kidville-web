import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/security/rate-limit'

/**
 * Il limitatore di frequenza delle OTTO porte OTP del genitore: quattro che
 * SPEDISCONO il codice, quattro che lo VERIFICANO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Collaudo del 2026-07-31, sicurezza W5: `parent/forms/otp`,
 * `parent/presenze/giustifica/otp`, `parent/primaria/note/firma/otp` e
 * `parent/primaria/pagella/firma/otp` non importavano `@/lib/security/rate-limit`
 * — che `forms/send-otp` e `public/cancellazione-account` usano da mesi. Nessun
 * tetto: un ciclo di richieste riempiva la casella del genitore di codici di
 * firma, a spese della reputazione del dominio mittente. Su questo progetto non è
 * un'ipotesi di scuola: le email di credenziali sono già rimaste bloccate per mesi
 * da un `403` del provider, e nessuno se n'era accorto.
 *
 * ─── DOVE STA LA VERIFICA (e perché tre firme su quattro erano scoperte) ────
 *
 * La correzione del 31 luglio mise il tetto di VERIFICA su una rotta sola, e per
 * un motivo che vale la pena scrivere: solo `parent/forms/otp` verifica il codice
 * dentro la rotta `…/otp` (col suo PATCH). Le altre tre lo verificano nella rotta
 * SORELLA, quella che firma davvero — `parent/presenze/giustifica:POST`,
 * `parent/primaria/note/firma:POST`, `parent/primaria/pagella/firma:POST` — che
 * nel nome non ha «otp» da nessuna parte. Cercare «otp» nei percorsi trovava
 * quattro file e ne mancava tre: il tetto ne proteggeva una su quattro mentre il
 * test dichiarava di coprirle tutte. Chiuso il 2026-08-01 (S30); la copertura ora
 * è per costruzione, non per elenco: `__tests__/architecture/otp-con-tetto.test.ts`.
 *
 * ─── PERCHÉ DUE TETTI E NON UNO ─────────────────────────────────────────────
 *
 * INVIO (i quattro POST) e VERIFICA (i quattro handler che confrontano il codice)
 * difendono da due cose diverse, e mescolarli farebbe danno in entrambe le direzioni.
 *
 *  · L'invio protegge una CASELLA EMAIL. Il budget è quindi UNO SOLO per tutte e
 *    quattro le rotte: la casella del genitore è una sola, e quattro tetti
 *    indipendenti vorrebbero dire quattro volte le email verso lo stesso
 *    indirizzo — cioè il tetto che si annulla da sé.
 *
 *  · La verifica protegge una FIRMA CON VALORE LEGALE. Il codice è di sei cifre
 *    (`otp-ticket.ts:135`), il confronto HMAC che fallisce NON consuma il ticket
 *    (`consumeTicket` è chiamata solo dopo un esito positivo) e il ticket vive
 *    dieci minuti: senza tetto i tentativi erano illimitati e gratuiti.
 *
 *    Il budget è UNO SOLO per tutte e quattro le verifiche, non uno per firma:
 *    quattro budget indipendenti darebbero quaranta tentativi invece di dieci a
 *    chi si limita a cambiare rotta — un tetto che si aggira senza forzarlo.
 *
 *    Sullo stesso budget dell'invio, invece, chiedere un codice nuovo
 *    consumerebbe i tentativi di digitazione, e chi sbaglia a scrivere resterebbe
 *    fuori dalla propria firma.
 *
 * ─── QUANTO VALE DAVVERO IL TETTO (il conto, senza sconti) ──────────────────
 *
 * ⚠️ `rateLimit` conta IN MEMORIA, per istanza. Su Vercel le lambda concorrenti
 * sono più d'una, quindi i numeri qui sotto sono **per istanza**: il tetto reale è
 * N × il limite dichiarato, con N il numero di istanze calde. Chi legge «dieci
 * tentativi ogni dieci minuti» deve leggere «dieci per ogni lambda accesa».
 *
 * Il tetto regge lo stesso, e non per ottimismo: le prove NON si accumulano su un
 * codice solo. Il codice cambia a ogni ticket, e il ticket vive dieci minuti — chi
 * ha sbagliato tutti i tentativi di una finestra ricomincia da capo su un codice
 * nuovo, e il lavoro fatto non gli serve più. Con dieci prove per finestra la
 * probabilità di indovinare è 10/10⁶ per istanza per finestra; per arrivare a una
 * probabilità apprezzabile DENTRO una finestra servirebbero decine di migliaia di
 * lambda simultanee sullo stesso genitore. È il motivo per cui la scadenza breve
 * del ticket non è un fastidio per l'utente: è metà della difesa.
 *
 * Resta vero che il numero dichiarato non è garantito. Renderlo esatto vuol dire
 * spostare il contatore su uno store condiviso (Postgres/Upstash): è da fare, ed è
 * scritto anche in `rate-limit.ts`. Fino ad allora questo modulo alza il costo di
 * un abuso in modo misurabile, non lo azzera — e questa riga esiste perché nessuno
 * legga «5 codici in dieci minuti» credendo che siano cinque.
 *
 * ─── PERCHÉ LA CHIAVE È L'UTENTE E NON L'IP ─────────────────────────────────
 *
 * Tutte e otto sono dietro `requireUser`: l'attore ha un nome, e l'IP no.
 * Un intero plesso dietro lo stesso NAT condividerebbe il tetto (tre genitori in
 * portineria, e il terzo non firma più), mentre chi ha una sessione valida
 * cambierebbe IP a piacere. L'id di sessione è l'unica cosa che l'attore non può
 * cambiare senza fare di nuovo il login.
 *
 * ─── LOG ────────────────────────────────────────────────────────────────────
 *
 * Nessun `logEvento` qui dentro, ed è deliberato: `withRoute` persiste già ogni
 * 429 a livello `warn` (`with-route.ts:41,91` — i 429 sono classificati ANOMALIE,
 * non 4xx di routine). Una riga scritta a mano sarebbe un doppione che sposta
 * soltanto il punto in cui si cerca.
 */

/** Ampiezza della finestra: la stessa vita del codice OTP (`OTP_TTL_MS`). */
export const FINESTRA_OTP_MS = 10 * 60 * 1000

/**
 * Codici SPEDITI verso la casella del genitore, in dieci minuti, su tutte e
 * quattro le rotte insieme. **Per istanza** (vedi il conto qui sopra).
 */
export const LIMITE_OTP_INVIO = 5

/**
 * Tentativi di VERIFICA del codice, in dieci minuti, su tutte e quattro le firme
 * insieme. Sopra questo, si indovina. **Per istanza** (vedi il conto qui sopra).
 */
export const LIMITE_OTP_VERIFICA = 10

/**
 * La risposta al rifiuto. Porta un `codice` stabile (`TROPPE_RICHIESTE`,
 * dichiarato in `src/lib/ui/esito-fetch.ts`) perché il client la traduca nella
 * lingua dell'interfaccia: la prosa qui sotto è quella che leggerebbe un utente
 * inglese se il codice non ci fosse.
 */
function troppeRichieste(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Troppe richieste in poco tempo. Riprova fra qualche minuto.',
      codice: 'TROPPE_RICHIESTE',
    },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    },
  )
}

/**
 * Consuma una unità del budget di INVIO dell'utente.
 * Ritorna la risposta 429 da restituire, oppure `null` se si può procedere.
 *
 * Va chiamata DOPO il gate d'identità (serve l'id di sessione) e PRIMA di
 * qualunque invio: un tentativo bloccato non deve né spedire un'email né lasciare
 * traccia nel registro FEA, che è il libro delle firme, non dei tentativi.
 */
export async function limitaInvioOtp(userId: string): Promise<NextResponse | null> {
  const rl = await rateLimit(`otp-invio:${userId}`, {
    limit: LIMITE_OTP_INVIO,
    windowMs: FINESTRA_OTP_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}

/**
 * Come sopra, sul budget separato dei tentativi di VERIFICA del codice.
 *
 * Va chiamata DOPO il gate d'identità e PRIMA di `verifyTicket`: un tentativo
 * bloccato non deve essere valutato (è quello il tentativo che si sta contando) né
 * finire nel registro FEA come `verify_failed`, che altrimenti si riempirebbe di
 * righe generate proprio da chi il tetto deve fermare.
 *
 * Non chiamarla quando NON c'è nessun codice da indovinare (es. la giustifica con
 * `giustifica_richiede_firma_otp` disattivato): là conterebbe gesti legittimi e
 * non difenderebbe niente.
 */
export async function limitaVerificaOtp(userId: string): Promise<NextResponse | null> {
  const rl = await rateLimit(`otp-verifica:${userId}`, {
    limit: LIMITE_OTP_VERIFICA,
    windowMs: FINESTRA_OTP_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}

/**
 * Il tetto per le verifiche che NON hanno un utente dietro: si conta sull'OGGETTO
 * del tentativo invece che sull'attore.
 *
 * ─── PERCHÉ SERVE UNA SECONDA FORMA ─────────────────────────────────────────
 *
 * `forms/send-otp:PATCH` (il modulo «Sistema A») confronta un codice a sei cifre e
 * **non ha nessun gate d'identità**: bastano un `submissionId` e un codice. Non è
 * una dimenticanza da correggere qui — quella firma è pensata per essere completata
 * anche da chi non ha una sessione, ed è una scelta di prodotto. Ma senza tetto
 * significava tentativi illimitati e gratuiti su una firma con valore legale: un
 * milione di combinazioni, nessuna che costi niente. Chi indovina porta la domanda
 * a `completed`, con `signed_at` e la riga nel `signature_log`.
 *
 * ─── PERCHÉ LA CHIAVE È L'OGGETTO, E PERCHÉ QUI È GIUSTO ────────────────────
 *
 * Altrove la chiave è l'utente, «l'unica cosa che l'attore non può cambiare senza
 * rifare il login». Qui l'attore non esiste, e restano due candidati:
 *
 *  · l'IP — che chi attacca cambia a piacere, e che punirebbe un intero plesso
 *    dietro lo stesso NAT;
 *  · il `submissionId` — che è **il bersaglio**, e che l'attaccante NON può
 *    cambiare senza rinunciare a ciò che sta cercando di firmare.
 *
 * È il rovescio del ragionamento sull'utente e porta allo stesso posto: si conta
 * ciò che l'attore non può sostituire. Il costo dichiarato è che due persone
 * legittime che firmano la STESSA domanda condividono il budget — ma i firmatari di
 * una domanda sono al massimo due (`signature_mode: 'joint'`), e dieci tentativi
 * bastano a entrambi.
 *
 * Vale lo stesso caveat di tutti gli altri: il contatore è **per istanza** (vedi
 * «QUANTO VALE DAVVERO IL TETTO» qui sopra).
 */
export async function limitaVerificaOtpOggetto(oggettoId: string): Promise<NextResponse | null> {
  const rl = await rateLimit(`otp-verifica-oggetto:${oggettoId}`, {
    limit: LIMITE_OTP_VERIFICA,
    windowMs: FINESTRA_OTP_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}
