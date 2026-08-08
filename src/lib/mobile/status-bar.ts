import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * LO STILE DELLA BARRA DI STATO SI DECIDE PER SCHERMATA, NON UNA VOLTA SOLA.
 *
 * ─── IL DIFETTO, MISURATO (rilievo Q31) ──────────────────────────────────────
 *
 * `setupNativeShell` chiamava `StatusBar.setStyle({ style: Style.Dark })` —
 * cioè «icone CHIARE» — all'avvio, e ci metteva sotto il verde di brand con
 * `setBackgroundColor`. Con `targetSdk 36` Android impone l'edge-to-edge:
 * `setOverlaysWebView({ overlay: false })` e `setBackgroundColor` **non hanno
 * effetto**, e dietro la barra si vede il fondo della PAGINA WEB.
 *
 * Campionamento dei pixel sull'emulatore (KV-play-phone, 1080×1920, 2026-08-08):
 *
 *   [login]         fondo (254, 241, 228)  ← #FEF1E4  ·  ora (255,255,255)  →  1,11:1
 *   [pagina interna] fondo (0, 106, 95)    ← #006A5F  ·  ora (255,255,255)  →  6,51:1
 *
 * Sulle pagine interne il caso andava bene per COINCIDENZA (l'AppBar è verde e
 * dipinge anche dietro la barra). Sulla login, che è crema, l'orologio, il
 * segnale, il wi-fi e la batteria erano praticamente invisibili — ed è la prima
 * schermata che l'utente vede all'apertura dell'app.
 *
 * ─── PERCHÉ SI MISURA IL DOM E NON SI ELENCANO LE ROTTE ──────────────────────
 *
 * Un elenco di percorsi «chiari» invecchia al primo percorso nuovo, e sarebbe la
 * quarta volta in questo ciclo che una regola vive in un posto che nessuno
 * aggiorna. La domanda che conta è la stessa da cui dipende ciò che si VEDE:
 * «dietro la fascia di sistema c'è una barra di brand, o c'è il fondo della
 * pagina?». Le barre sono due — `.kv-appbar` (genitore e docente,
 * `features/shell/AppBar`) e `.kv-appbar-admin` (cockpit, `AdminTopBarMobile`) —
 * ed è lo stesso paio che `CampoNonCoperto` interroga per la sua soglia.
 */

/** C'è una barra di brand incollata in cima, cioè dietro la fascia di sistema? */
export function barraDiBrandInCima(doc: Document): boolean {
    return Array.from(doc.querySelectorAll('.kv-appbar, .kv-appbar-admin')).some((b) => {
        const r = b.getBoundingClientRect()
        // `top <= 0` perché la barra è `sticky top-0` e in shell nativa ingloba
        // la safe-area; `bottom > 0` esclude quella già uscita dallo schermo.
        return r.top <= 0 && r.bottom > 0
    })
}

/**
 * Applica alla barra di stato lo stile giusto per la schermata corrente.
 *
 * `Style.Dark` = «fondo scuro, contenuto CHIARO» (icone bianche sul verde di
 * brand); `Style.Light` = «fondo chiaro, contenuto SCURO» (icone nere sul crema).
 * I nomi del plugin descrivono il FONDO, non le icone: è la confusione che ha
 * fatto scrivere `Style.Dark` una volta per tutte.
 *
 * Best-effort come il resto della shell nativa, ma **non muta**: se il plugin
 * non c'è, la barra resta al default di sistema e la riga lo dice — vedi la
 * regola 6 di AGENTS.md.
 */
export async function applicaStiloStatusBar(): Promise<void> {
    if (typeof document === 'undefined') return
    try {
        const { StatusBar, Style } = await import('@capacitor/status-bar')
        await StatusBar.setStyle({ style: barraDiBrandInCima(document) ? Style.Dark : Style.Light })
    } catch (e) {
        logClient({
            livello: 'warn',
            evento: 'avvio',
            messaggio: `status-bar: stile non applicato — orologio e icone di sistema restano al default (${nomeErrore(e)})`,
        })
    }
}
