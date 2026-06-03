/**
 * Util email condiviso.
 *
 * Usa Resend se `RESEND_API_KEY` è configurato, altrimenti fa fallback su log
 * server-side (modalità dev/senza provider) e ritorna `false`.
 * Mittente di default sovrascrivibile con `OTP_FROM_EMAIL`.
 */

export interface SendEmailParams {
  to: string
  subject: string
  text: string
}

const DEFAULT_FROM = 'Kidville <onboarding@resend.dev>'

/** Invia un'email. Ritorna true se consegnata al provider, false in fallback/errore. */
export async function sendEmail({ to, subject, text }: SendEmailParams): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[EMAIL] (provider non configurato) → ${to}\n  Oggetto: ${subject}\n  ${text.replace(/\n/g, '\n  ')}`)
    return false
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
      console.error(`[EMAIL] Invio fallito (${res.status}) per ${to}`)
    }
    return res.ok
  } catch (err) {
    console.error('[EMAIL] Invio email fallito:', err)
    return false
  }
}

/** Corpo dell'email con le credenziali di accesso all'area genitori. */
export function credentialsEmailBody(nome: string | null | undefined, email: string, password: string): string {
  const saluto = nome ? `Gentile ${nome},` : 'Gentile genitore,'
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/login`
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
