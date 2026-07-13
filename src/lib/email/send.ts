import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { hashCorrelabile } from '@/lib/logging/redact'

/**
 * Util email condiviso.
 *
 * Usa Resend se `RESEND_API_KEY` è configurato, altrimenti degrada a un esito negativo
 * PARLANTE. Mittente di default sovrascrivibile con `OTP_FROM_EMAIL`.
 *
 * ⚠️ DELIVERABILITY: finché su Resend non è verificato il dominio kidville.it,
 * il mittente resta `onboarding@resend.dev` (sandbox) e Resend CONSEGNA SOLO
 * all'indirizzo del titolare dell'account — ogni altro destinatario è rifiutato
 * con 403. Dopo la verifica del dominio impostare in produzione
 * `OTP_FROM_EMAIL="Kidville <noreply@kidville.it>"`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUESTO FILE È LA SCENA DEL DELITTO. Per mesi nessuna email di credenziali è arrivata a
 * un genitore: Resend rispondeva 403 «the kidville.it domain is not verified», nessun test
 * era rosso e nessuno se n'è accorto. Le tre regole che escono da lì, e che qui valgono:
 *
 *  1. il CORPO del rifiuto non si butta via → la chiamata passa da `externalFetch`, che lo
 *     legge, lo logga nella colonna `app_log.messaggio` e lo propaga nell'esito;
 *  2. il SUCCESSO si logga → `evento: 'email'` è in `EVENTI_PERSISTITI`, quindi la riga di
 *     `externalFetch` finisce in tabella anche quando l'invio riesce. È il battito: con i
 *     soli errori, «nessun log» non distingue «tutte partite» da «non è mai partito niente»,
 *     ed è ESATTAMENTE l'ambiguità che ha tenuto nascosto il guasto;
 *  3. configurazione mancante = livello `error`, mai `info`. Una `RESEND_API_KEY` assente in
 *     produzione è un incidente muto: zero email, zero errori, zero sospetti.
 *
 * E il destinatario non compare MAI in chiaro nei log: solo `hashCorrelabile` (che senza
 * `LOG_HASH_SALT` è fail-closed e non produce nulla di leggibile).
 * ─────────────────────────────────────────────────────────────────────────────────
 */

export interface SendEmailParams {
  to: string
  subject: string
  text: string
}

export interface SendEmailResult {
  ok: boolean
  /** Motivo del fallimento, già leggibile (per warning UI/audit). Null se ok. */
  error: string | null
}

const DEFAULT_FROM = 'Kidville <onboarding@resend.dev>'

/**
 * Invia un'email e riporta l'ESITO CON MOTIVO. Il corpo dell'errore Resend
 * viene letto e propagato: un rifiuto (es. sandbox: "solo verso il proprio
 * indirizzo") non deve mai ridursi a un generico "non inviata".
 */
export async function sendEmailDetailed({ to, subject, text }: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // `error`, non `info`: senza chiave NESSUNA email parte, e in produzione è un incidente.
    // Il vecchio `console.log` stampava anche `text` in chiaro — cioè, sulle credenziali,
    // «Password temporanea: …» dritta nei Runtime Logs. Quella stampa è morta qui.
    logEvento('config', 'error', {
      operazione: 'sendEmail',
      // `msg` non è in lista bianca (nel jsonb resta redatto), ma `testoEvento()` lo promuove
      // alla colonna `app_log.messaggio`, che è in chiaro e sanificata: è lì che si legge.
      msg: 'RESEND_API_KEY assente: nessuna email può partire da questo ambiente',
    })
    return { ok: false, error: 'provider email non configurato (RESEND_API_KEY assente)' }
  }

  const esito = await externalFetch(
    'resend',
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL ?? DEFAULT_FROM,
        to,
        subject,
        text,
      }),
    },
    {
      // Il battito (successo E rifiuto) lo emette `externalFetch`: una riga sola, con il corpo
      // del provider nella colonna `messaggio`. Non se ne aggiunge una seconda qui.
      evento: 'email',
      campi: {
        operazione: 'sendEmail',
        // Hash, mai l'indirizzo. `destinatario` NON è in lista bianca, quindi in `app_log`
        // resta `[redatto:str/9]`: l'hash si legge solo su Vercel. È il prezzo accettato —
        // l'alternativa sarebbe allargare la lista bianca di `redact` a un campo che porta
        // identità, e quella lista difende dati di minori (AGENTS, regola 8).
        destinatario: hashCorrelabile(to),
      },
    }
  )

  if (esito.ok) return { ok: true, error: null }

  // `stato: 0` = una risposta non c'è stata affatto (rete giù, DNS, TLS).
  if (esito.stato === 0) {
    return { ok: false, error: `errore di rete verso il provider email: ${esito.corpo}` }
  }

  // Il motivo del rifiuto arriva fino a chi ha chiesto l'invio (audit, avviso in UI): un 403
  // che dice solo «403» è ciò che ha nascosto il guasto per mesi.
  const dettaglio = messaggioDelProvider(esito.corpo)
  return {
    ok: false,
    error: `rifiutato dal provider email (${esito.stato})${dettaglio ? `: ${dettaglio}` : ''}`,
  }
}

/** Resend impacchetta il motivo in `{ message }`; se non è JSON, il corpo grezzo va benissimo. */
function messaggioDelProvider(corpo: string): string {
  try {
    const v: unknown = JSON.parse(corpo)
    if (v !== null && typeof v === 'object') {
      const m = (v as { message?: unknown }).message
      if (typeof m === 'string' && m !== '') return m
    }
  } catch {
    // Non era JSON: è già il testo del provider.
  }
  return corpo
}

/** Invia un'email. Ritorna true se consegnata al provider, false in fallback/errore. */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  return (await sendEmailDetailed(params)).ok
}

/** Corpo dell'email con le credenziali di accesso all'area genitori. */
export function credentialsEmailBody(nome: string | null | undefined, email: string, password: string): string {
  const saluto = nome ? `Gentile ${nome},` : 'Gentile genitore,'
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/login`
    : 'la pagina di accesso all\'area genitori'
  return [
    saluto,
    '',
    'la tua iscrizione a Kidville è stata registrata. Di seguito le credenziali per accedere all\'area genitori:',
    '',
    `  Email: ${email}`,
    `  Password temporanea: ${password}`,
    '',
    `Accedi da ${loginUrl} e, per la tua sicurezza, modifica la password al primo accesso.`,
    '',
    'A presto,',
    'Lo staff Kidville',
  ].join('\n')
}
