// =============================================================================
// I token del sistema email. Brand Clay Village.
//
// NB: qui gli hex sono LETTERALI di proposito e NON violano il lock
// design-tokens-admin (che scansiona solo l'area admin/cockpit): nessun client
// email supporta le CSS custom properties (`var(--color-…)`), quindi i colori
// del brand vanno inlineati su ogni singolo elemento. Sorgente dei valori:
// `src/app/globals.css` e `design.md`. È la stessa esenzione, con la stessa
// ragione, già documentata in `src/lib/news/digest-email.ts`.
// =============================================================================

export const KV = {
    verde: '#006A5F',
    verdeScuro: '#00544B',
    verdeTenue: '#E8F5F3',
    giallo: '#FDC400',
    gialloTenue: '#FFF8E1',
    crema: '#FEF1E4',
    bianco: '#FFFFFF',
    testo: '#1F2937',
    testo2: '#6B7280',
    bordo: '#E5E7EB',
} as const

/**
 * I quattro toni semantici dei riquadri d'avviso, più il neutro.
 * Fondo tenue, bordo pieno, testo scuro: mai colore su colore.
 */
export const TONI = {
    info: { bg: '#E9F1FB', testo: '#1D4FA8', bordo: '#2A6FDB' },
    avviso: { bg: '#FBEFE2', testo: '#A64F09', bordo: '#E6720A' },
    errore: { bg: '#FDECEC', testo: '#C62828', bordo: '#E53935' },
    ok: { bg: '#E7F3E8', testo: '#1B5E20', bordo: '#43A047' },
    neutro: { bg: KV.verdeTenue, testo: KV.verde, bordo: KV.verde },
} as const

export type ToneAvviso = keyof typeof TONI

/**
 * ⚠️ Sul giallo #FDC400 l'inchiostro è SEMPRE il verde scuro #00544B (5,52:1).
 * Il verde primario #006A5F darebbe 4,07:1, sotto lo standard: è la stessa
 * correzione WCAG già fatta in `PageHeaderCard.tsx` e misurata dal lock
 * `__tests__/a11y/contrasto-schermate-assenza.test.tsx`.
 */
export const INCHIOSTRO_SU_GIALLO = KV.verdeScuro

/**
 * ─── NIENTE WEBFONT, ED È UNA DECISIONE PRESA TRE VOLTE ─────────────────────
 * La fonte di design emetteva un `<link>` a `fonts.googleapis.com` per avere
 * Nunito nei titoli. Qui non c'è, per tre ragioni che puntano tutte nella stessa
 * direzione:
 *
 *  1. il brief lo vieta esplicitamente («Niente webfont: usa lo stack di
 *     sistema. Il font del brand non arriva nelle email: non provarci»);
 *  2. un `<link>` remoto dentro un'email lo carica il CLIENT DEL DESTINATARIO:
 *     l'indirizzo IP di ogni famiglia arriverebbe a un terzo, all'apertura di
 *     una email che parla di un minore, senza comparire in nessuna informativa.
 *     È la stessa identica ragione per cui l'11 agosto 2026 `api.codicefiscale.it`
 *     è finito fra gli host VIETATI del lock `provider-esterni-osservati`;
 *  3. metà dei client email butta via `<head><style>` e i `<link>` remoti: il
 *     ripiego sarebbe comunque lo stack di sistema nella maggioranza dei casi,
 *     quindi si progetta direttamente su quello.
 *
 * `TITLE` resta uno stack che NOMINA Nunito: se un giorno il carattere sarà
 * installato sul dispositivo di chi legge verrà usato, senza che nessun dato
 * esca. Altrimenti degrada al carattere di sistema, e in Outlook ad Arial per
 * via del blocco condizionale in `layout.ts`.
 */
export const BODY_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
export const TITLE_FONT = `'Nunito',${BODY_FONT}`
export const MONO_FONT = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,'Courier New',monospace"

/** Raggi: 28px sulla tab gialla, 16px sui blocchi grandi, 12/10px sui riquadri, 999px sui bottoni. */
export const RAGGIO = { tab: 28, blocco: 16, riquadro: 12, pill: 999 } as const

/** L'indirizzo pubblico dell'app. Stesso ripiego di `src/app/layout.tsx`. */
export function appUrl(): string {
    return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.kidville.it'
}

/**
 * Le schede dell'app sugli store.
 *
 * Sono `<a href>` DENTRO l'HTML dell'email: li apre il telefono di chi legge, il
 * nostro server non contatta nessuno dei due host. Per questo stanno in
 * `HOST_NON_CHIAMATI` nel lock `provider-esterni-osservati`, accanto agli
 * iframe di YouTube e Vimeo, e non fra i provider.
 *
 * ⚠️ Misurato il 2026-08-15: la scheda App Store risponde (lookup pubblico = 1,
 * `id6794883055`), la scheda Play risponde **404** perché l'app è ancora nel
 * canale di test chiuso. Il bottone Play è comunque presente per decisione
 * esplicita del titolare, che conosceva il 404 quando ha scelto. Il giorno che
 * l'app esce dal test chiuso questo file non va toccato: l'indirizzo è già
 * quello definitivo.
 */
export const URL_APP_STORE = 'https://apps.apple.com/it/app/kidville/id6794883055'
export const URL_PLAY_STORE = 'https://play.google.com/store/apps/details?id=it.kidville.app'

/**
 * Il logo per la fascia verde: la versione CHIARA.
 * Quella verde sparirebbe sul fondo verde. Con le immagini bloccate — cioè in
 * mezzo mondo — il testo alternativo mostra «Kidville» in bianco, non un
 * rettangolo vuoto.
 */
export function urlLogo(): string {
    return `${appUrl()}/logo-light.png`
}

/**
 * La mascotte della tab gialla, in una copia tagliata per l'email.
 *
 * NON è `/mascot-hero.png`: quella è 665×994 px e 715 KB, giusta per la
 * dashboard e assurda per un francobollo di 86×128 che parte verso centinaia di
 * famiglie, spesso sotto rete mobile. La copia per l'email la genera
 * `scripts/mascotte-email.mjs`.
 */
export function urlMascotte(): string {
    return `${appUrl()}/mascot-email.png`
}
