import { esc, grezzo, h, unisci, type Html } from '../html'
import { documento, piedeTesto } from '../layout'
import { h2, riquadroApp, riquadroAppTesto, spazio, tabMascotte, testo } from '../componenti'
import { BODY_FONT, KV, TITLE_FONT } from '../tema'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 10 · Il riepilogo mensile delle news.
//
// ─── DEVE REGGERE DA 1 A 20 ARTICOLI ────────────────────────────────────────
// Con uno solo non deve sembrare un errore: l'apertura lo dice («questo mese una
// sola notizia»). Con venti non deve diventare un muro: si raggruppa per
// categoria e si alterna il fondo delle schede, così l'occhio trova un ritmo.
//
// ─── IL LINK DI DISISCRIZIONE NON C'È, ED È UNA DECISIONE ───────────────────
// Il design lo prevede solo qui, e lo punta a `/parent/news/preferenze`. Quella
// pagina NON ESISTE — e non è un file che manca: l'opt-out della singola
// famiglia non esiste come funzione, per scelta scritta in `@/lib/news/digest`
// (è una comunicazione istituzionale; l'unico interruttore è per scuola).
// Metterlo significherebbe promettere una schermata che risponde 404, cioè
// esattamente il tipo di comando che promette e non mantiene.
//
// Il piè di pagina lo supporta già come opzione: si accende il giorno che la
// pagina esiste, passando `disiscrizione` a `documento()`. Non serve toccare
// questo file.
//
// ─── IL CONTRASTO CHE QUI SI CORREGGE ───────────────────────────────────────
// Il template precedente scriveva il nome della sede in giallo #FDC400 sul verde
// #006A5F dell'intestazione: 4,05:1, sotto lo standard. Nel layout master quel
// nome è bianco su verde, e il giallo resta dov'è leggibile — sulla tab, con
// l'inchiostro verde scuro.
// =============================================================================

export interface ArticoloDigest {
    /** Etichetta di categoria, es. «Avvisi». Assente ⇒ la riga non compare. */
    categoria?: string | null
    titolo: string
    /** Estratto già troncato da chi chiama. Assente ⇒ solo titolo e bottone. */
    estratto?: string | null
    /** Link all'articolo nell'area genitori. Assente ⇒ nessun bottone morto. */
    url?: string | null
}

export interface DatiDigestNews {
    /** Es. «marzo». Già in italiano e già minuscolo o maiuscolo come va mostrato. */
    mese: string
    anno: number
    articoli: readonly ArticoloDigest[]
}

export function oggettoDigest(d: Pick<DatiDigestNews, 'mese' | 'anno'>): string {
    return `Kidville News — ${d.mese} ${d.anno}`
}

/** Una scheda-articolo. Il fondo si alterna per dare ritmo a un elenco lungo. */
function scheda(a: ArticoloDigest, indice: number): Html {
    const alternata = indice % 2 === 1
    const fondo = grezzo(alternata ? KV.crema : KV.bianco)
    const bordo = grezzo(alternata ? KV.crema : KV.bordo)

    const categoria = a.categoria
        ? h`<div style="font-family:${grezzo(BODY_FONT)};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${grezzo(KV.verde)};padding-bottom:5px;">${esc(a.categoria)}</div>`
        : ('' as Html)
    const estratto = a.estratto
        ? h`<div style="font-family:${grezzo(BODY_FONT)};font-size:14px;line-height:1.55;color:${grezzo(KV.testo2)};padding:7px 0 12px 0;">${esc(a.estratto)}</div>`
        : ('' as Html)
    // Il bottone «Leggi in app» è giallo con inchiostro scuro, non verde: dentro
    // una scheda bianca sarebbe indistinguibile dal bottone principale
    // dell'email, e qui non è l'azione principale — è una fra venti.
    const bottone = a.url
        ? h`<a href="${esc(a.url)}" style="display:inline-block;background:${grezzo(KV.giallo)};color:${grezzo(KV.testo)};font-family:${grezzo(BODY_FONT)};font-size:13px;font-weight:700;line-height:34px;text-decoration:none;padding:0 18px;border-radius:999px;">Leggi in app</a>`
        : ('' as Html)

    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${fondo};border:1px solid ${bordo};border-radius:14px;margin:0 0 12px 0;"><tr><td style="padding:16px 18px 18px 18px;">${categoria}<div style="font-family:${grezzo(TITLE_FONT)};font-size:17px;line-height:1.3;mso-line-height-rule:exactly;font-weight:800;color:${grezzo(KV.testo)};">${esc(a.titolo)}</div>${estratto}${bottone}</td></tr></table>`
}

export function messaggioDigestNews(d: DatiDigestNews, sede: ContestoSede): Messaggio {
    const oggetto = oggettoDigest(d)
    const motivo = `Ricevi questa comunicazione perché il tuo bambino è iscritto a ${sede.nome}.`
    const uno = d.articoli.length === 1

    let elenco: Html
    if (uno) {
        elenco = unisci([
            testo('Questo mese una sola notizia, ma vale la pena leggerla.'),
            scheda(d.articoli[0], 0),
        ])
    } else {
        // Raggruppate per categoria, nell'ordine in cui le categorie compaiono:
        // così un elenco di venti ha delle pause, invece di essere un muro.
        const gruppi = new Map<string, ArticoloDigest[]>()
        for (const a of d.articoli) {
            const chiave = a.categoria ?? 'Altre notizie'
            const esistente = gruppi.get(chiave)
            if (esistente) esistente.push(a)
            else gruppi.set(chiave, [a])
        }
        const pezzi: Html[] = [testo(`Le notizie di ${d.mese.toLowerCase()}, raggruppate per argomento.`)]
        let primo = true
        for (const [categoria, articoli] of gruppi) {
            if (!primo) pezzi.push(spazio(10))
            primo = false
            pezzi.push(h2(categoria))
            articoli.forEach((a, i) => pezzi.push(scheda(a, i)))
        }
        elenco = unisci(pezzi)
    }

    // Se nessun articolo ha un link, il riquadro app non rimanda a bottoni che
    // non esistono: dice dove si leggono le news, e basta.
    const conLink = d.articoli.some((a) => !!a.url)
    const introApp = conLink
        ? h`I bottoni «Leggi in app» aprono l'area genitori. L'app è gratuita su App Store e Google Play.`
        : h`Le news si leggono nell'area genitori, anche dall'app: è gratuita su App Store e Google Play.`
    const introAppTesto = conLink
        ? 'I bottoni «Leggi in app» aprono l\'area genitori. L\'app è gratuita su App Store e Google Play.'
        : 'Le news si leggono nell\'area genitori, anche dall\'app: è gratuita su App Store e Google Play.'

    const corpo = unisci([
        elenco,
        spazio(10),
        riquadroApp(sede, { titolo: 'Leggere le news dal telefono', introduzione: introApp }),
    ])

    const primoTitolo = d.articoli[0]?.titolo ?? ''

    return {
        oggetto,
        html: documento(sede, {
            oggetto,
            preheader: uno
                ? `Una notizia da ${sede.nome}: ${primoTitolo}.`
                : `${d.articoli.length} notizie di ${d.mese.toLowerCase()} da ${sede.nome}.`,
            tab: tabMascotte({
                occhiello: 'Kidville News',
                titolo: `${d.mese} ${d.anno}`,
                sottotitolo: uno ? `Una notizia da ${sede.nome}.` : `${d.articoli.length} notizie da ${sede.nome}.`,
            }),
            corpo,
            motivo,
        }),
        testo: [
            `KIDVILLE NEWS — ${d.mese.toUpperCase()} ${d.anno} · ${sede.nome.toUpperCase()}`,
            '',
            uno ? 'Questo mese una sola notizia, ma vale la pena leggerla.' : `Le notizie di ${d.mese.toLowerCase()}, raggruppate per argomento.`,
            '',
            ...d.articoli.map((a) => [
                a.categoria ? `[${a.categoria.toUpperCase()}] ${a.titolo}` : a.titolo,
                ...(a.estratto ? [a.estratto] : []),
                ...(a.url ? [`Leggi in app: ${a.url}`] : []),
                '',
            ].join('\n')),
            riquadroAppTesto(sede, introAppTesto),
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
