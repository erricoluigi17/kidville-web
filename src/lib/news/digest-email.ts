// =============================================================================
// Template HTML del digest mensile «Kidville News», table-based per la massima
// compatibilità con i client email. Brand Clay Village.
//
// NB: qui gli hex sono LETTERALI di proposito e NON violano il lock
// design-tokens-admin (che scansiona solo l'area admin/cockpit): i client email
// non supportano le CSS custom properties (`var(--color-…)`), quindi i colori del
// brand vanno inlineati. Sorgente dei token: src/app/globals.css.
// =============================================================================

const VERDE = '#006A5F'
const GIALLO = '#FDC400'
const CREMA = '#FEF1E4'
const TESTO = '#1F2937'
const GRIGIO = '#6B7280'

export interface DigestEmailPost {
  id: string
  titolo: string
  categoria_nome?: string | null
  contenuto_testo?: string | null
}

export interface DigestEmailParams {
  titolo: string
  nomeSede: string
  posts: DigestEmailPost[]
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function estratto(testo: string | null | undefined, max = 160): string {
  const t = (testo ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

function cardPost(p: DigestEmailPost, baseUrl: string | null): string {
  const link = baseUrl ? `${baseUrl}/parent/news/${encodeURIComponent(p.id)}` : null
  const cat = p.categoria_nome
    ? `<div style="font-size:12px;font-weight:700;color:${VERDE};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${escapeHtml(p.categoria_nome)}</div>`
    : ''
  const estr = estratto(p.contenuto_testo)
  const corpo = estr ? `<div style="font-size:14px;color:${GRIGIO};line-height:1.5;margin-top:6px;">${escapeHtml(estr)}</div>` : ''
  const cta = link
    ? `<div style="margin-top:12px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:${GIALLO};color:${TESTO};text-decoration:none;font-weight:700;font-size:14px;padding:8px 16px;border-radius:8px;">Leggi in app</a></div>`
    : ''
  return `
    <tr>
      <td style="padding:0 0 16px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;">
          <tr>
            <td style="padding:20px;">
              ${cat}
              <div style="font-size:18px;font-weight:800;color:${TESTO};line-height:1.3;">${escapeHtml(p.titolo)}</div>
              ${corpo}
              ${cta}
            </td>
          </tr>
        </table>
      </td>
    </tr>`
}

/** Compone l'HTML completo del digest email. Nessuna PII di minori oltre ai contenuti redazionali. */
export function costruisciDigestHtml({ titolo, nomeSede, posts }: DigestEmailParams): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? null
  const cards = posts.map((p) => cardPost(p, baseUrl)).join('')
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(titolo)}</title>
</head>
<body style="margin:0;padding:0;background:${CREMA};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREMA};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="background:${VERDE};border-radius:16px 16px 0 0;padding:28px 24px;text-align:center;">
              <div style="font-size:22px;font-weight:800;color:#FFFFFF;">${escapeHtml(titolo)}</div>
              <div style="font-size:14px;color:${GIALLO};margin-top:4px;">${escapeHtml(nomeSede)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 16px 8px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${cards}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 28px 24px;text-align:center;">
              <div style="font-size:12px;color:${GRIGIO};line-height:1.6;">
                Questa è una comunicazione istituzionale di ${escapeHtml(nomeSede)}, inviata a tutte le famiglie della sede.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
