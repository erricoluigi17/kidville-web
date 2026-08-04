import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendEmail } from '@/lib/email/send'
import { parseBody } from '@/lib/validation/http'
import {
  creaTicketCancellazione,
  costruisciLinkConferma,
  risolviGenitorePerEmail,
} from '@/lib/gdpr/cancellazione-pubblica'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Cancellazione account via risorsa web PUBBLICA (C5 §1 — Google Play Data safety).
// Percorso SENZA login, complementare a quello in-app (/parent/profilo).
//
// Il POST avvia la richiesta: se l'email combacia con un genitore non ancora
// anonimizzato, spedisce un magic-link firmato verso /cancellazione-account/
// conferma. La richiesta vera e propria (riga `pending`) nasce SOLO dopo la
// conferma via link — questa route non registra e NON cancella nulla.
//
// ANTI-ENUMERAZIONE: la risposta è SEMPRE la stessa 200 generica, che l'email
// esista o meno. Rivelare l'esistenza di un account è una fuga d'informazione.
//
// RATE-LIMIT: route pubblica, senza login, che INVIA UN'EMAIL all'indirizzo
// ricevuto → senza limite è un'arma di email-bombing verso la casella di una
// famiglia. Il limite è la PRIMA istruzione, prima di `parseBody` e della
// risoluzione del genitore: applicarlo dopo significherebbe far partire l'email
// e poi nascondere l'abuso dietro la 200 generica dell'anti-enumerazione.
// =============================================================================

const postBodySchema = z.object({ email: z.string().email() })

// 5 richieste / 10 minuti per IP. Più stretto degli 8 di `forms/send-otp`: là il
// reinvio di un codice da ritrascrivere è un gesto legittimo e ripetuto (codice
// non arrivato, secondo firmatario), qui chi vuole cancellare il proprio account
// riceve un link valido un'ora — oltre le prime richieste non c'è più un uso
// buono, solo qualcuno che riempie la casella di un altro.
const RL_LIMITE = 5
const RL_FINESTRA_MS = 10 * 60 * 1000

// Risposta unica: identica in ogni ramo, così il client non può dedurre nulla.
const risposta = () => NextResponse.json({ ok: true })

export const POST = withRoute('public/cancellazione-account:POST', async (request: Request) => {
  // Prima di tutto il resto: nessuna lettura del body, nessuna query, nessuna
  // email. Il rifiuto NON va loggato qui a mano — `withRoute` persiste già ogni
  // 429 a livello `warn` (è un'anomalia, non un 4xx di routine), come per
  // `forms/send-otp`: un log esplicito sarebbe solo un doppione.
  const rl = await rateLimit(`cancellazione-account:${clientIp(request)}`, {
    limit: RL_LIMITE,
    windowMs: RL_FINESTRA_MS,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    )
  }

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const email = b.data.email

  try {
    const admin = await createAdminClient()
    const { genitore, error } = await risolviGenitorePerEmail(admin, email)
    if (error) {
      // Errore DB inatteso: loggato, ma risposta comunque generica (mai un 500 che
      // per differenza segnalerebbe qualcosa sull'email).
      logErrore({ operazione: 'public/cancellazione-account:POST', stato: 200 }, error)
      return risposta()
    }
    if (!genitore) {
      // Email non associata: nessuna email inviata. Il SUCCESSO dell'evento (email
      // non associata) va loggato — con i soli errori "nessun log" sarebbe ambiguo.
      logEvento('gdpr', 'info', {
        operazione: 'public/cancellazione-account:POST',
        esito: 'email_non_associata',
      })
      return risposta()
    }

    const { code, expiry, ticket } = creaTicketCancellazione(email)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
    const link = costruisciLinkConferma({ baseUrl, email, code, expiry, ticket })

    const inviata = await sendEmail({
      to: email,
      subject: 'Conferma la richiesta di cancellazione — Kidville',
      text: [
        'Gentile utente,',
        '',
        'abbiamo ricevuto una richiesta di cancellazione del tuo account Kidville.',
        'Per confermarla, apri questo link (valido per 1 ora):',
        '',
        link,
        '',
        'Se non hai richiesto tu la cancellazione, ignora questo messaggio: senza',
        'conferma non verrà avviata alcuna richiesta.',
        '',
        '— — —',
        '',
        'Dear user,',
        '',
        'we received a request to delete your Kidville account.',
        'To confirm it, open this link (valid for 1 hour):',
        '',
        link,
        '',
        'If you did not request this, ignore this message: without confirmation no',
        'request will be started.',
        '',
        'Lo staff Kidville',
      ].join('\n'),
    })

    // Evento critico: si logga anche il successo. Nessuna PII (né email né link).
    logEvento('gdpr', inviata ? 'info' : 'error', {
      operazione: 'public/cancellazione-account:POST',
      esito: inviata ? 'magic_link_inviato' : 'magic_link_non_inviato',
    })
    return risposta()
  } catch (err) {
    // Anche in errore: risposta generica (l'anti-enumerazione vale sopra ogni cosa),
    // ma l'errore va loggato — withRoute vede solo una 200 e non lo registrerebbe.
    logErrore({ operazione: 'public/cancellazione-account:POST', stato: 200 }, err)
    return risposta()
  }
})
