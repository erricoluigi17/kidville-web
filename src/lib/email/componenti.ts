// =============================================================================
// La libreria dei componenti. Ognuno è una funzione pura che ritorna `Html`.
//
// Tutto è a TABELLE (`role="presentation"`) con CSS inline su ogni elemento, e
// non è una scelta di stile: Gmail rimuove `<style>` dall'head, nessun client
// email supporta le variabili CSS, e `flex`/`grid`/`position` si rompono in
// Outlook. Un template che si rompe in Outlook non è un template.
//
// Regola dei tipi, valida per tutto il file: i parametri sono `string` (testo da
// scappare) tranne dove il tipo dice `Html`, che significa «HTML già formato,
// responsabilità di chi chiama». Ce ne sono esattamente due — il contenuto di
// `notice()` e il `body` di `doc()` — e ogni altro `Html` in ingresso sarebbe un
// difetto.
// =============================================================================

import { formatEuro } from '@/lib/format/valuta'
import { esc, grezzo, h, unisci, type Html } from './html'
import {
    BODY_FONT,
    INCHIOSTRO_SU_GIALLO,
    KV,
    MONO_FONT,
    TITLE_FONT,
    TONI,
    URL_APP_STORE,
    URL_PLAY_STORE,
    urlMascotte,
    type ToneAvviso,
} from './tema'
import type { ContestoSede } from './contesto'

/* ─────────────────────────────────────────────────────────── testo e spazio */

export function h1(testo: string): Html {
    return h`<h1 class="kv-h" style="margin:0 0 12px 0;font-family:${grezzo(TITLE_FONT)};font-size:26px;line-height:1.25;font-weight:800;color:${grezzo(KV.verde)};">${esc(testo)}</h1>`
}

export function h2(testo: string): Html {
    return h`<h2 class="kv-h" style="margin:28px 0 10px 0;font-family:${grezzo(TITLE_FONT)};font-size:17px;line-height:1.3;font-weight:800;color:${grezzo(KV.verde)};">${esc(testo)}</h2>`
}

/**
 * Un paragrafo. `contenuto` è `Html` perché è l'unico modo di avere un
 * `<strong>` dentro una frase: chi chiama compone con `h` e `esc`.
 */
export function p(contenuto: Html, opzioni: { dimensione?: number; colore?: string } = {}): Html {
    const size = opzioni.dimensione ?? 16
    const colore = opzioni.colore ?? KV.testo
    return h`<p class="kv-t" style="margin:0 0 16px 0;font-family:${grezzo(BODY_FONT)};font-size:${size}px;line-height:1.6;mso-line-height-rule:exactly;color:${grezzo(colore)};">${contenuto}</p>`
}

/** Scorciatoia per il caso più comune: un paragrafo di solo testo. */
export function testo(t: string, opzioni?: { dimensione?: number }): Html {
    return p(esc(t), opzioni)
}

/** Riga secondaria, più piccola e grigia: note, avvertenze, rimandi. */
export function nota(contenuto: Html): Html {
    return h`<p class="kv-t2" style="margin:0 0 12px 0;font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.55;color:${grezzo(KV.testo2)};">${contenuto}</p>`
}

export function spazio(altezza: number): Html {
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${altezza}" style="height:${altezza}px;line-height:${altezza}px;font-size:0;">&nbsp;</td></tr></table>`
}

export function riga(): Html {
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:${grezzo(KV.bordo)};">&nbsp;</td></tr></table>`
}

/* ────────────────────────────────────────────────────────────────── bottone */

/**
 * Bottone principale. Pill da 999px — la forma dei bottoni dell'app, ed è
 * l'unico punto in cui il prodotto ha vinto sul brief, che ne chiedeva 8-10px.
 *
 * Il blocco `<v:roundrect>` è il ripiego per Outlook desktop, che ignora
 * `border-radius` e `background` sugli `<a>`: senza, il bottone diventa un link
 * blu sottolineato in mezzo alla pagina.
 */
export function bottone(url: string, etichetta: string, opzioni: { larghezza?: number } = {}): Html {
    const w = opzioni.larghezza ?? 300
    return h`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center" bgcolor="${grezzo(KV.verde)}" style="border-radius:999px;"><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(url)}" style="height:48px;v-text-anchor:middle;width:${w}px;" arcsize="50%" stroke="f" fillcolor="${grezzo(KV.verde)}"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${esc(etichetta)}</center></v:roundrect><![endif]--><!--[if !mso]><!--><a class="kv-btn" href="${esc(url)}" style="display:inline-block;background:${grezzo(KV.verde)};color:#FFFFFF;font-family:${grezzo(BODY_FONT)};font-size:16px;font-weight:700;line-height:48px;text-align:center;text-decoration:none;padding:0 28px;border-radius:999px;">${esc(etichetta)}</a><!--<![endif]--></td></tr></table>`
}

/** Il link in chiaro sotto il bottone: alcuni client rompono i bottoni. */
export function linkDiScorta(url: string, introduzione: string): Html {
    return h`<p class="kv-t2" style="margin:0;font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.5;color:${grezzo(KV.testo2)};text-align:center;">${esc(introduzione)}<br><a class="kv-lnk" href="${esc(url)}" style="color:${grezzo(KV.verde)};text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${esc(url)}</a></p>`
}

/* ────────────────────────────────────────────────────────── tab della mascotte */

export interface Hero {
    occhiello?: string
    titolo: string
    sottotitolo?: string
    /** Senza mascotte e col titolo più piccolo: il contenuto deve arrivare prima. */
    compatta?: boolean
}

/**
 * La tab gialla dell'app portata in email, da `HeroCard` / `PageHeaderCard`.
 *
 * L'inchiostro sul giallo è SEMPRE `#00544B` (5,52:1). Il verde primario
 * darebbe 4,07:1 — sotto lo standard — ed è la stessa correzione WCAG già fatta
 * nel repo, misurata dal lock sul contrasto.
 *
 * La mascotte ha `alt=""` perché è decorativa: con le immagini spente non lascia
 * un buco con una didascalia. In Outlook desktop la figura resta intera e più
 * piccola, perché quel client non sa ritagliare con `overflow`.
 */
export function tabMascotte(o: Hero): Html {
    const occhiello = o.occhiello
        ? h`<div style="font-family:${grezzo(BODY_FONT)};font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${grezzo(INCHIOSTRO_SU_GIALLO)};padding-bottom:6px;">${esc(o.occhiello)}</div>`
        : grezzo('')
    const titolo = h`<h1 class="kv-hero-t" style="margin:0;font-family:${grezzo(TITLE_FONT)};font-size:${o.compatta ? 20 : 24}px;line-height:1.12;mso-line-height-rule:exactly;font-weight:800;text-transform:uppercase;letter-spacing:0.4px;color:${grezzo(INCHIOSTRO_SU_GIALLO)};">${esc(o.titolo)}</h1>`
    const sottotitolo = o.sottotitolo
        ? h`<div style="font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.5;color:${grezzo(INCHIOSTRO_SU_GIALLO)};padding-top:8px;">${esc(o.sottotitolo)}</div>`
        : grezzo('')
    const sinistra = unisci([occhiello, titolo, sottotitolo])

    if (o.compatta) {
        return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${grezzo(KV.giallo)}" style="background:${grezzo(KV.giallo)};border-radius:28px;"><tr><td class="kv-pad" style="padding:20px 28px 22px 28px;">${sinistra}</td></tr></table>`
    }

    const src = urlMascotte()
    const mascotte = h`<!--[if !mso]><!--><div class="kv-masc-c" style="height:106px;overflow:hidden;font-size:0;line-height:0;border-bottom-right-radius:28px;"><img src="${esc(src)}" width="86" height="128" alt="" class="kv-masc-i" style="display:block;border:0;outline:none;width:86px;height:128px;"></div><!--<![endif]--><!--[if mso]><img src="${esc(src)}" width="72" height="107" alt="" style="display:block;border:0;"><![endif]-->`
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${grezzo(KV.giallo)}" style="background:${grezzo(KV.giallo)};border-radius:28px;"><tr><td class="kv-pad" valign="middle" style="padding:22px 4px 24px 28px;">${sinistra}</td><td class="kv-masc" width="96" valign="bottom" align="right" style="width:96px;padding:0 10px 0 0;font-size:0;line-height:0;">${mascotte}</td></tr></table>`
}

/* ──────────────────────────────────────────────────────── codice e credenziali */

/**
 * Il riquadro del codice di verifica: la cosa più grande dell'email, e l'unica
 * che conta. Niente deve competere con lui.
 */
export function riquadroCodice(codice: string): Html {
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kv-box" style="background:${grezzo(KV.verdeTenue)};border-radius:16px;"><tr><td align="center" style="padding:28px 16px 30px 16px;"><div class="kv-code" style="font-family:${grezzo(MONO_FONT)};font-size:40px;line-height:1.1;mso-line-height-rule:exactly;font-weight:700;letter-spacing:10px;color:${grezzo(KV.verde)};white-space:nowrap;">${esc(codice)}</div></td></tr></table>`
}

/**
 * Il riquadro delle credenziali: il contenuto più delicato dell'intero sistema.
 *
 * Monospaziato e selezionabile, mai dentro un'immagine, mai dentro un link. La
 * password non si spezza MAI su due righe (`white-space:nowrap`): una password
 * andata a capo si copia sbagliata. L'indirizzo email invece sì — è lui, a
 * nowrap, che imporrebbe 364px di larghezza minima a tutta l'email.
 */
export function riquadroCredenziali(email: string, password: string): Html {
    const campo = (etichetta: string, valore: string, o: { ultimo?: boolean; nowrap?: boolean } = {}): Html =>
        h`<tr><td style="padding:${grezzo(o.ultimo ? '14px 16px 18px 16px' : '18px 16px 14px 16px')};"><div style="font-family:${grezzo(BODY_FONT)};font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${grezzo(KV.testo2)};padding-bottom:6px;">${esc(etichetta)}</div><div class="kv-cred-v" style="font-family:${grezzo(MONO_FONT)};font-size:${o.nowrap ? 17 : 16}px;line-height:1.35;mso-line-height-rule:exactly;font-weight:700;color:${grezzo(KV.testo)};${grezzo(o.nowrap ? 'white-space:nowrap;' : 'overflow-wrap:anywhere;word-break:break-word;')}">${esc(valore)}</div></td></tr>`

    const divisore = h`<tr><td style="padding:0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:${grezzo(KV.giallo)};">&nbsp;</td></tr></table></td></tr>`

    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${grezzo(KV.gialloTenue)};border:1px solid ${grezzo(KV.giallo)};border-radius:16px;">${campo('Email di accesso', email)}${divisore}${campo('Password temporanea', password, { ultimo: true, nowrap: true })}</table>`
}

/* ────────────────────────────────────────────────────── tabella di riepilogo */

export interface RigaDati {
    etichetta: string
    valore: string
    /** Il dato si copia (IBAN, causale, riferimento): monospaziato e spezzabile. */
    mono?: boolean
}

/** Due colonne 42/58, valori in grassetto, monospaziato dove il dato si copia. */
export function tabellaDati(righe: readonly RigaDati[]): Html {
    const corpo = righe.map((r, i) => {
        const bordo = i > 0 ? grezzo(`border-top:1px solid ${KV.bordo};`) : grezzo('')
        const alto = i === 0 ? grezzo('16px') : grezzo('12px')
        const font = grezzo(r.mono ? MONO_FONT : BODY_FONT)
        const spezza = r.mono ? grezzo('overflow-wrap:anywhere;word-break:break-word;') : grezzo('')
        return h`<tr><td width="42%" style="width:42%;padding:${alto} 8px 12px 20px;font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.4;color:${grezzo(KV.testo2)};${bordo}">${esc(r.etichetta)}</td><td width="58%" style="width:58%;padding:${alto} 20px 12px 8px;font-family:${font};font-size:15px;line-height:1.4;font-weight:700;color:${grezzo(KV.testo)};${spezza}${bordo}">${esc(r.valore)}</td></tr>`
    })
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${grezzo(KV.bianco)};border:1px solid ${grezzo(KV.bordo)};border-radius:16px;">${unisci(corpo)}</table>`
}

/* ────────────────────────────────────────────────────────── riquadro d'avviso */

/**
 * Riquadro d'avviso, quattro toni semantici più il neutro.
 * `contenuto` è `Html`: è uno dei due soli posti del modulo in cui chi chiama
 * passa HTML già formato, perché quasi sempre contiene un `<strong>`.
 */
export function avviso(tono: ToneAvviso, contenuto: Html): Html {
    const t = TONI[tono]
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${grezzo(t.bg)};border:1px solid ${grezzo(t.bordo)};border-radius:12px;"><tr><td style="padding:14px 18px;font-family:${grezzo(BODY_FONT)};font-size:14px;line-height:1.55;mso-line-height-rule:exactly;color:${grezzo(t.testo)};">${contenuto}</td></tr></table>`
}

/* ─────────────────────────────────────────────────────── linea del tempo */

/** Tre tappe in tabelle, senza immagini: si legge anche a immagini spente. */
export function tappe(passi: readonly string[], attiva: number): Html {
    const celle: Html[] = []
    passi.forEach((s, i) => {
        const acceso = i <= attiva
        const inchiostro = grezzo(acceso ? '#FFFFFF' : KV.testo2)
        const fondo = grezzo(acceso ? KV.verde : KV.bordo)
        const etichettaColore = grezzo(acceso ? KV.verde : KV.testo2)
        const segno = acceso ? grezzo('&#10003;') : esc(i + 1)
        celle.push(h`<td width="33%" align="center" style="width:33.33%;padding:0 4px;"><div style="font-family:${grezzo(MONO_FONT)};font-size:15px;line-height:26px;mso-line-height-rule:exactly;font-weight:700;color:${inchiostro};background:${fondo};border-radius:999px;width:26px;height:26px;margin:0 auto;">${segno}</div><div style="font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.4;font-weight:700;color:${etichettaColore};padding-top:8px;">${esc(s)}</div></td>`)
        if (i < passi.length - 1) {
            celle.push(h`<td width="8" align="center" valign="top" style="width:8px;font-family:${grezzo(BODY_FONT)};font-size:14px;color:${grezzo(KV.testo2)};padding-top:4px;">&#8250;</td>`)
        }
    })
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${grezzo(KV.crema)};border-radius:16px;"><tr><td style="padding:20px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${unisci(celle)}</tr></table></td></tr></table>`
}

/** Il gemello testuale della linea del tempo: `[✓] Ricevuta → [ ] In esame`. */
export function tappeTesto(passi: readonly string[], attiva: number): string {
    return passi.map((s, i) => `[${i <= attiva ? '✓' : ' '}] ${s}`).join('  →  ')
}

/* ────────────────────────────────────────────────────── riepilogo dei pagamenti */

export interface VocePagamento {
    descrizione: string
    scadenza: string
    giorniRitardo: number
    importo: number
}

/**
 * Una riga per voce, e da due in su la riga del totale.
 *
 * Con una voce sola il totale non compare: ripetere lo stesso importo due volte
 * fa sembrare l'email un modulo e non aggiunge niente a chi legge.
 *
 * Ogni voce sta per sé — mensa e uscite didattiche sono partite distinte, con
 * scadenze e importi propri: accorparle renderebbe il riepilogo impossibile da
 * riconciliare con la contabilità della segreteria.
 */
export function riepilogoVoci(voci: readonly VocePagamento[]): Html {
    const totale = voci.reduce((a, v) => a + v.importo, 0)
    const righe = voci.map((v, i) => {
        const bordo = i > 0 ? grezzo(`border-top:1px solid ${KV.bordo};`) : grezzo('')
        const alto = i > 0 ? grezzo('13px') : grezzo('16px')
        return h`<tr><td valign="top" style="padding:${alto} 8px 13px 18px;${bordo}"><div style="font-family:${grezzo(BODY_FONT)};font-size:15px;line-height:1.35;font-weight:700;color:${grezzo(KV.testo)};">${esc(v.descrizione)}</div><div style="font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.45;color:${grezzo(KV.testo2)};padding-top:3px;">Scadenza ${esc(v.scadenza)} &middot; ${esc(v.giorniRitardo)} giorni di ritardo</div></td><td valign="top" align="right" width="96" style="width:96px;padding:${alto} 18px 13px 8px;font-family:${grezzo(BODY_FONT)};font-size:15px;line-height:1.35;font-weight:700;color:${grezzo(KV.testo)};white-space:nowrap;${bordo}">${esc(formatEuro(v.importo))}</td></tr>`
    })

    const rigaTotale = voci.length > 1
        ? h`<tr><td class="kv-box kv-h" style="padding:14px 8px 16px 18px;border-top:2px solid ${grezzo(KV.verde)};background:${grezzo(KV.verdeTenue)};border-bottom-left-radius:16px;font-family:${grezzo(BODY_FONT)};font-size:15px;line-height:1.35;font-weight:700;color:${grezzo(KV.verde)};">Totale da saldare<div class="kv-h" style="font-family:${grezzo(BODY_FONT)};font-size:13px;font-weight:400;color:${grezzo(KV.verde)};padding-top:3px;">${esc(voci.length)} pagamenti arretrati</div></td><td class="kv-box kv-h" align="right" width="96" style="width:96px;padding:14px 18px 16px 8px;border-top:2px solid ${grezzo(KV.verde)};background:${grezzo(KV.verdeTenue)};border-bottom-right-radius:16px;font-family:${grezzo(BODY_FONT)};font-size:19px;line-height:1.35;font-weight:700;color:${grezzo(KV.verde)};white-space:nowrap;">${esc(formatEuro(totale))}</td></tr>`
        : grezzo('')

    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${grezzo(KV.bianco)};border:1px solid ${grezzo(KV.bordo)};border-radius:16px;">${unisci(righe)}${rigaTotale}</table>`
}

/** Il gemello testuale del riepilogo, con lo stesso totale. */
export function riepilogoVociTesto(voci: readonly VocePagamento[]): string {
    const totale = voci.reduce((a, v) => a + v.importo, 0)
    const righe = voci
        .map((v) => `  ${v.descrizione}\n    scadenza ${v.scadenza} · ${v.giorniRitardo} giorni di ritardo · ${formatEuro(v.importo)}`)
        .join('\n')
    if (voci.length <= 1) return righe
    return `${righe}\n  ${'-'.repeat(46)}\n  TOTALE DA SALDARE (${voci.length} pagamenti arretrati): ${formatEuro(totale)}`
}

/* ──────────────────────────────────────────────────────── riquadro «scarica l'app» */

/**
 * Bottoni testuali e non i badge ufficiali degli store: quelli sono immagini col
 * testo dentro, e mezzo mondo blocca le immagini. Con un badge bloccato resta un
 * rettangolo vuoto; con questi resta un bottone leggibile.
 */
function bottoneStore(url: string, etichetta: string): Html {
    return h`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 8px 0;"><tr><td align="center" bgcolor="${grezzo(KV.verde)}" style="border-radius:10px;"><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(url)}" style="height:46px;v-text-anchor:middle;width:250px;" arcsize="22%" stroke="f" fillcolor="${grezzo(KV.verde)}"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${esc(etichetta)}</center></v:roundrect><![endif]--><!--[if !mso]><!--><a href="${esc(url)}" style="display:block;color:#FFFFFF;font-family:${grezzo(BODY_FONT)};font-size:15px;font-weight:700;line-height:46px;text-align:center;text-decoration:none;padding:0 14px;border-radius:10px;">${esc(etichetta)}</a><!--<![endif]--></td></tr></table>`
}

export function riquadroApp(sede: ContestoSede, o: { titolo?: string; introduzione?: Html } = {}): Html {
    const titolo = o.titolo ?? 'Scarica l\'app Kidville'
    const intro = o.introduzione ?? h`L'app è gratuita: si cerca <strong>Kidville</strong> su App Store o Google Play.`
    const dominio = sede.app.replace(/^https?:\/\//, '')
    // ⚠️ Le classi `kv-t` e `kv-t2` su questi due `<div>` non sono decorative.
    // Il riquadro ha `kv-box`, che in modalità scura diventa #0F2E29: senza la
    // classe sul TESTO, l'inchiostro resterebbe #1F2937 — grigio scuro su verde
    // scurissimo, cioè illeggibile. È il difetto che il brief chiama «il più
    // comune di tutti», e che si vede solo aprendo l'email col tema scuro acceso.
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kv-box" style="background:${grezzo(KV.verdeTenue)};border-radius:16px;"><tr><td style="padding:20px 20px 22px 20px;"><div class="kv-h" style="font-family:${grezzo(TITLE_FONT)};font-size:16px;line-height:1.3;font-weight:800;color:${grezzo(KV.verde)};padding-bottom:4px;">${esc(titolo)}</div><div class="kv-t" style="font-family:${grezzo(BODY_FONT)};font-size:14px;line-height:1.55;color:${grezzo(KV.testo)};padding-bottom:14px;">${intro}</div>${bottoneStore(URL_APP_STORE, 'Scarica su App Store')}${bottoneStore(URL_PLAY_STORE, 'Scarica su Google Play')}<div class="kv-t2" style="font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.5;color:${grezzo(KV.testo2)};padding-top:8px;">Si entra con le stesse credenziali dell'area riservata. Dal computer resta <a class="kv-lnk" href="${esc(sede.app)}" style="color:${grezzo(KV.verde)};text-decoration:underline;">${esc(dominio)}</a>.</div></td></tr></table>`
}

export function riquadroAppTesto(sede: ContestoSede, introduzione?: string): string {
    const intro = introduzione ?? 'L\'app è gratuita: si cerca "Kidville" su App Store o Google Play.'
    return [
        'SCARICA L\'APP KIDVILLE',
        intro,
        `  App Store:    ${URL_APP_STORE}`,
        `  Google Play:  ${URL_PLAY_STORE}`,
        `  Si entra con le stesse credenziali dell'area riservata. Dal computer: ${sede.app}`,
    ].join('\n')
}

/* ───────────────────────────────────────────────────────────── piè di pagina */

/**
 * Il piè di pagina, uguale su tutte.
 *
 * Si costruisce per RIGHE, non come una stringa con dei buchi: un recapito che
 * manca non lascia un «Tel. » orfano, un `mailto:` vuoto o un separatore
 * spaiato — la riga semplicemente non esiste. È la stessa regola di
 * `parseAnagraficaSede`: si omette ciò che manca, non si inventa e non si
 * stampa vuoto.
 *
 * Il link di disiscrizione compare SOLO nel digest news: le altre undici sono
 * comunicazioni necessarie al rapporto in corso, non marketing.
 */
export function piede(sede: ContestoSede, motivo: string, o: { disiscrizione?: string } = {}): Html {
    const stileLink = grezzo(`color:${KV.verde};text-decoration:underline;`)

    const righe: Html[] = [
        h`<strong class="kv-h" style="color:${grezzo(KV.verde)};font-family:${grezzo(TITLE_FONT)};font-size:14px;">${esc(sede.nome)}</strong>`,
    ]
    if (sede.indirizzo) righe.push(esc(sede.indirizzo))

    const recapiti: Html[] = []
    if (sede.telefono) {
        recapiti.push(h`Tel. <a class="kv-lnk" href="tel:${esc(sede.telefono.replace(/[^\d+]/g, ''))}" style="${stileLink}">${esc(sede.telefono)}</a>`)
    }
    if (sede.email) {
        recapiti.push(h`<a class="kv-lnk" href="mailto:${esc(sede.email)}" style="${stileLink}">${esc(sede.email)}</a>`)
    }
    if (recapiti.length > 0) righe.push(unisci(recapiti, grezzo(' &middot; ')))

    righe.push(esc('Scuola dell\'infanzia La Favola soc. coop.'))

    const disiscrizione = o.disiscrizione
        ? h` &middot; <a class="kv-lnk" href="${esc(o.disiscrizione)}" style="${stileLink}">Non ricevere più il riepilogo mensile</a>`
        : grezzo('')

    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="kv-t2" style="padding:24px 28px 8px 28px;font-family:${grezzo(BODY_FONT)};font-size:13px;line-height:1.65;color:${grezzo(KV.testo2)};">${unisci(righe, grezzo('<br>'))}</td></tr><tr><td class="kv-t2" style="padding:0 28px 24px 28px;font-family:${grezzo(BODY_FONT)};font-size:12px;line-height:1.6;color:${grezzo(KV.testo2)};"><a class="kv-lnk" href="${esc(sede.privacy)}" style="${stileLink}">Informativa privacy</a>${disiscrizione}<br><span class="kv-t2" style="color:${grezzo(KV.testo2)};">${esc(motivo)}</span></td></tr></table>`
}

/** Il gemello testuale del piè di pagina, con la stessa regola dell'omissione. */
export function piedeTesto(sede: ContestoSede, motivo: string, o: { disiscrizione?: string } = {}): string {
    const righe: string[] = ['--', sede.nome]
    if (sede.indirizzo) righe.push(sede.indirizzo)
    const recapiti = [sede.telefono ? `Tel. ${sede.telefono}` : null, sede.email].filter((v): v is string => !!v)
    if (recapiti.length > 0) righe.push(recapiti.join(' · '))
    righe.push('Scuola dell\'infanzia La Favola soc. coop.')
    righe.push(`Informativa privacy: ${sede.privacy}`)
    if (o.disiscrizione) righe.push(`Per non ricevere più il riepilogo mensile: ${o.disiscrizione}`)
    return `${righe.join('\n')}\n\n${motivo}\n`
}
