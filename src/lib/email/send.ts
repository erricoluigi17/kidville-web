/**
 * Util email condiviso.
 *
 * Usa Resend se `RESEND_API_KEY` è configurato, altrimenti fa fallback su log
 * server-side (modalità dev/senza provider) e ritorna esito negativo.
 * Mittente di default sovrascrivibile con `OTP_FROM_EMAIL`.
 *
 * ⚠️ DELIVERABILITY: finché su Resend non è verificato il dominio kidville.it,
 * il mittente resta `onboarding@resend.dev` (sandbox) e Resend CONSEGNA SOLO
 * all'indirizzo del titolare dell'account — ogni altro destinatario è rifiutato
 * con 403. Dopo la verifica del dominio impostare in produzione
 * `OTP_FROM_EMAIL="Kidville <noreply@kidville.it>"`.
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
    console.log(`[EMAIL] (provider non configurato) → ${to}\n  Oggetto: ${subject}\n  ${text.replace(/\n/g, '\n  ')}`)
    return { ok: false, error: 'provider email non configurato (RESEND_API_KEY assente)' }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
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
    })
    if (!res.ok) {
      let dettaglio = ''
      try {
        const raw = await res.text()
        try {
          dettaglio = (JSON.parse(raw) as { message?: string }).message ?? raw
        } catch {
          dettaglio = raw
        }
      } catch {
        /* corpo illeggibile: resta il solo status */
      }
      const errore = `rifiutato dal provider email (${res.status})${dettaglio ? `: ${dettaglio}` : ''}`
      console.error(`[EMAIL] Invio fallito per ${to} — ${errore}`)
      return { ok: false, error: errore }
    }
    return { ok: true, error: null }
  } catch (err) {
    console.error('[EMAIL] Invio email fallito:', err)
    return { ok: false, error: 'errore di rete verso il provider email' }
  }
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
