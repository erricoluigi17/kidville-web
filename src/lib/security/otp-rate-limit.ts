import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/security/rate-limit'

/**
 * Il limitatore di frequenza delle quattro rotte OTP del genitore.
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
 * ─── PERCHÉ DUE TETTI E NON UNO ─────────────────────────────────────────────
 *
 * INVIO (i quattro POST) e VERIFICA (il PATCH di `parent/forms/otp`) difendono da
 * due cose diverse, e mescolarli farebbe danno in entrambe le direzioni.
 *
 *  · L'invio protegge una CASELLA EMAIL. Il budget è quindi UNO SOLO per tutte e
 *    quattro le rotte: la casella del genitore è una sola, e quattro tetti
 *    indipendenti vorrebbero dire quattro volte le email verso lo stesso
 *    indirizzo — cioè il tetto che si annulla da sé.
 *
 *  · La verifica protegge una FIRMA CON VALORE LEGALE. Il codice è di sei cifre
 *    (`otp-ticket.ts:135`), il confronto HMAC che fallisce NON consuma il ticket
 *    (`consumeTicket` è chiamata solo dopo un esito positivo) e il ticket vive
 *    dieci minuti: senza tetto i tentativi erano illimitati e gratuiti. Con
 *    dieci tentativi ogni dieci minuti, esaurire un milione di codici richiede
 *    circa due anni — cioè indovinare smette di essere una strada, e l'OTP torna
 *    a dimostrare quello per cui esiste: che chi firma legge quella casella.
 *
 *    Sullo stesso budget dell'invio, invece, chiedere un codice nuovo
 *    consumerebbe i tentativi di digitazione, e chi sbaglia a scrivere resterebbe
 *    fuori dalla propria firma.
 *
 * ─── PERCHÉ LA CHIAVE È L'UTENTE E NON L'IP ─────────────────────────────────
 *
 * Queste quattro rotte sono dietro `requireUser`: l'attore ha un nome, e l'IP no.
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

/** Codici SPEDITI verso la casella del genitore, in dieci minuti, su tutte e quattro le rotte. */
export const LIMITE_OTP_INVIO = 5

/** Tentativi di VERIFICA del codice, in dieci minuti. Sopra questo, si indovina. */
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
export function limitaInvioOtp(userId: string): NextResponse | null {
  const rl = rateLimit(`otp-invio:${userId}`, {
    limit: LIMITE_OTP_INVIO,
    windowMs: FINESTRA_OTP_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}

/** Come sopra, sul budget separato dei tentativi di VERIFICA del codice. */
export function limitaVerificaOtp(userId: string): NextResponse | null {
  const rl = rateLimit(`otp-verifica:${userId}`, {
    limit: LIMITE_OTP_VERIFICA,
    windowMs: FINESTRA_OTP_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}
