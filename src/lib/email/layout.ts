// =============================================================================
// Il layout master: la cornice da cui derivano tutte e dodici le email.
//
// Deve reggere sia un'email di quattro righe (un codice di verifica) sia una di
// due schermate (la ricevuta d'iscrizione). Struttura, dall'alto:
//
//   preheader nascosto (display:none, max-height:0, mso-hide:all)
//   intestazione verde, radius 16px — logo a sinistra, nome sede a destra
//   tab gialla con mascotte                                      ← opzionale
//   scheda bianca, radius 16px, padding 30/28/34 — il contenuto
//   piè di pagina
// =============================================================================

import { esc, grezzo, h, type Html } from './html'
import { BODY_FONT, KV, TITLE_FONT, urlLogo } from './tema'
import { piede, piedeTesto } from './componenti'
import type { ContestoSede } from './contesto'

/**
 * Gli override della modalità scura.
 *
 * ⚠️ VENGONO EMESSI DUE VOLTE, e non è una svista da deduplicare: una sotto
 * `@media (prefers-color-scheme:dark)`, per i client che dichiarano il tema, e
 * una sotto `html[data-force-dark]`, che serve all'anteprima locale per mostrare
 * il tema scuro senza cambiare le impostazioni del sistema operativo.
 *
 * Il motivo per cui è una FUNZIONE con un prefisso, invece di una stringa da
 * riscrivere con una `replace`: le liste di selettori si rompono. `body,.kv-bg{`
 * diventerebbe `html[data-force-dark] body,.kv-bg{`, e la seconda metà della
 * lista resterebbe senza prefisso — accendendo il tema scuro a tutti.
 */
function cssScuro(prefisso: string): string {
    const r = (selettore: string, regole: string): string => `${prefisso}${selettore}{${regole}}`
    return [
        r(`body,${prefisso}.kv-bg`, 'background:#152220 !important;'),
        r('.kv-card', 'background:#1D2C29 !important;'),
        r('.kv-t', 'color:#F4F6F5 !important;'),
        r('.kv-t2', 'color:#C9D1CE !important;'),
        r('.kv-h', 'color:#8FE0D1 !important;'),
        r('.kv-lnk', 'color:#8FE0D1 !important;'),
        r('.kv-box', 'background:#0F2E29 !important;'),
        r('.kv-code', 'color:#9FE7D9 !important;'),
    ].join('\n    ')
}

export interface Documento {
    /** L'oggetto: finisce nel `<title>`, e il chiamante lo usa come subject. */
    oggetto: string
    /**
     * La riga d'anteprima nella casella di posta. Scritta a mano, email per
     * email: non è mai la ripetizione dell'oggetto. Per il codice di verifica
     * contiene il codice stesso — la gente lo legge dalla notifica del telefono
     * e non apre mai il messaggio.
     */
    preheader: string
    /** La tab gialla, già resa. Assente in 08 e 09, che sono volutamente sobrie. */
    tab?: Html
    /** Il contenuto della scheda bianca: HTML già composto da chi chiama. */
    corpo: Html
    /** Perché il destinatario riceve questo messaggio. Sempre presente. */
    motivo: string
    /** Solo per il digest news: le altre undici non sono marketing. */
    disiscrizione?: string
    /** `false` toglie il link dal logo: usato dove non si vuole invitare a cliccare. */
    logoCliccabile?: boolean
    lingua?: string
}

/** Compone il documento HTML completo, dal `<!DOCTYPE>` al `</html>`. */
export function documento(sede: ContestoSede, d: Documento): string {
    const logo = h`<img src="${esc(urlLogo())}" width="132" height="32" alt="Kidville" style="display:block;border:0;outline:none;height:32px;width:auto;max-width:180px;font-family:${grezzo(TITLE_FONT)};font-size:22px;font-weight:800;color:#FFFFFF;text-decoration:none;">`
    const logoBlocco = d.logoCliccabile === false
        ? logo
        : h`<a href="${esc(sede.app)}" style="text-decoration:none;color:#FFFFFF;">${logo}</a>`

    const tab = d.tab
        ? h`<tr><td height="14" style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>
<tr><td>${d.tab}</td></tr>`
        : grezzo('')

    return `<!DOCTYPE html>
<html lang="${d.lingua ?? 'it'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(d.oggetto)}</title>
<!--[if mso]><style>h1,h2,.kv-title{font-family:Arial,sans-serif !important;}</style><![endif]-->
<style>
  @media (prefers-color-scheme:dark){
    ${cssScuro('')}
  }
  ${cssScuro('html[data-force-dark] ')}
  @media screen and (max-width:640px){
    .kv-w{width:100% !important;}
  }
  @media screen and (max-width:480px){
    .kv-pad{padding-left:18px !important;padding-right:18px !important;}
    .kv-code{font-size:34px !important;letter-spacing:6px !important;}
    .kv-hero-t{font-size:20px !important;}
    .kv-masc{width:70px !important;}
    .kv-masc-i{width:64px !important;height:96px !important;}
    .kv-masc-c{height:80px !important;}
    .kv-btn{padding:0 16px !important;font-size:15px !important;}
  }
</style>
</head>
<body class="kv-bg" style="margin:0;padding:0;width:100%;background:${KV.crema};-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;color:${KV.crema};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(d.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kv-bg" style="background:${KV.crema};">
<tr><td align="center" style="padding:24px 12px 32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="kv-w" style="width:100%;max-width:600px;">
<tr><td style="background:${KV.verde};border-radius:16px;padding:20px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" style="font-family:${TITLE_FONT};font-size:22px;font-weight:800;color:#FFFFFF;">${logoBlocco}</td>
<td align="right" style="font-family:${BODY_FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#FFFFFF;">${esc(sede.nome)}</td>
</tr></table></td></tr>
${tab}
<tr><td height="14" style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>
<tr><td class="kv-card kv-pad" style="background:${KV.bianco};border-radius:16px;padding:30px 28px 34px 28px;">
${d.corpo}
</td></tr>
<tr><td class="kv-pad">${piede(sede, d.motivo, { disiscrizione: d.disiscrizione })}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

/** L'intestazione del gemello testuale: titolo in maiuscolo e nome della sede. */
export function intestazioneTesto(titolo: string, sede: ContestoSede): string {
    return `${titolo.toUpperCase()} — ${sede.nome.toUpperCase()}`
}

export { piedeTesto }
