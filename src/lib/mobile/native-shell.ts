import { Capacitor } from '@capacitor/core'
import { chiudiOverlayInCima } from '@/lib/mobile/overlay-indietro'
import { nascondiSplashNativo } from '@/lib/mobile/splash'
import { applicaStiloStatusBar } from '@/lib/mobile/status-bar'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { apriLinkNotifica } from '@/lib/chat/apertura-thread'

// Setup della shell nativa Capacitor (M10.5). Chiamato UNA sola volta e SOLO su
// piattaforma nativa (vedi NativeInit). Ogni plugin è import dinamico e
// best-effort: se un plugin manca l'app resta usabile — ma NON in silenzio.

/**
 * Un plugin nativo che non si carica: l'app degrada, e lo dice.
 *
 * Qui c'erano tre `catch { // ignora }`, vietati da AGENTS.md §6. L'errore È
 * ignorabile — nessuna di queste tre funzioni è indispensabile — ma «ignorabile»
 * non vuol dire «invisibile»: se domani un plugin smette di caricarsi, la barra
 * di stato cambia aspetto, il tasto Indietro esce dall'app e il tocco sulle push
 * non apre più niente, su TUTTI i dispositivi, e con un catch muto nessuno lo
 * saprebbe mai. Il canale del client non ha il livello `info` (accetta solo
 * `warn`/`error`), e `warn` è comunque la lettura giusta: è un degrado, non la
 * normalità. Nessun dato personale nel messaggio — solo il nome del plugin e il
 * NOME dell'errore.
 */
function plugineMancante(plugin: string, conseguenza: string, e: unknown): void {
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `native-shell: plugin ${plugin} non disponibile — ${conseguenza} (${nomeErrore(e)})`,
  })
}

export async function setupNativeShell(navigate: (path: string) => void): Promise<void> {
  // 0. Toglie lo splash nativo appena l'app ha dipinto. NON si attende: i passi
  //    qui sotto fanno import dinamici di plugin, e metterli davanti allo splash
  //    significherebbe tenere l'utente sulla schermata d'avvio per il tempo di
  //    caricare la status bar. Sono indipendenti, e girano in parallelo.
  void nascondiSplashNativo()

  // 1. Safe-area: marca il documento come nativo e abilita viewport-fit=cover
  //    (solo qui, mai nel browser) così env(safe-area-inset-*) diventa effettivo.
  document.documentElement.classList.add('cap-native')
  const vp = document.querySelector('meta[name="viewport"]')
  if (vp) {
    // Aggiunge al content del meta viewport SOLO i token mancanti (idempotente).
    // viewport-fit=cover è già dichiarato staticamente in layout.tsx; qui è
    // belt-and-braces. maximum-scale=1 + user-scalable=no bloccano l'auto-zoom
    // iOS al focus di un input: garanzia SOLO nella shell nativa — sul web il
    // pinch-zoom resta (WCAG 1.4.4), perché layout.tsx non li dichiara.
    let content = vp.getAttribute('content') || ''
    const appendToken = (token: string, present: RegExp) => {
      if (!present.test(content)) {
        content = `${content}${content ? ', ' : ''}${token}`
      }
    }
    appendToken('viewport-fit=cover', /viewport-fit/)
    appendToken('maximum-scale=1', /maximum-scale/)
    appendToken('user-scalable=no', /user-scalable/)
    vp.setAttribute('content', content)
  }

  // 2. Status bar: lo stile lo decide la SCHERMATA (`@/lib/mobile/status-bar`).
  //    ⚠️ Il commento che stava qui diceva: «Su Android la barra è solida
  //    (overlay off) e la WebView parte sotto → nessun inset-top serve». La
  //    misura del 2026-08-08 sull'emulatore dice il contrario: con targetSdk 36
  //    (android/variables.gradle) Android impone l'edge-to-edge,
  //    `setOverlaysWebView({overlay:false})` non ha effetto, e
  //    `env(safe-area-inset-top)` vale 24px. La WebView parte sotto la barra
  //    SOLO grazie al CSS `.cap-native [data-kv-shell]`. Il risultato a schermo
  //    è corretto (AppBar 0→82 = 58+24, nessuna sovrapposizione), ma il
  //    meccanismo che lavora non era quello descritto — ed è la stessa forma di
  //    rischio che questo repo ha già pagato: un commento che descrive una
  //    protezione che non c'è.
  //
  //    ⚠️ E LA CONSEGUENZA SUL COLORE, CHE NON ERA STATA TIRATA (rilievo Q31).
  //    Se `setBackgroundColor` non ha effetto, dietro la barra si vede il fondo
  //    della PAGINA: sulle schermate interne è il verde dell'AppBar e il caso va
  //    bene per coincidenza, sulla LOGIN è il crema — e le icone bianche
  //    chieste da `Style.Dark` sparivano. Campionati sull'emulatore: contrasto
  //    1,11:1 sulla login contro 6,51:1 su una pagina interna.
  //    Lo stile ora si decide a ogni schermata, misurando se una barra di brand
  //    c'è davvero (`applicaStiloStatusBar`, richiamata anche da `NativeInit` a
  //    ogni cambio di percorso). Qui resta solo la prima applicazione.
  //
  //    `setBackgroundColor` e `setOverlaysWebView` RESTANO, dichiarati
  //    inefficaci: toglierli non cambierebbe niente su targetSdk 36 e li
  //    rimetterebbe in gioco il giorno in cui Android tornasse a onorarli — ma
  //    nessuna decisione di questo file può poggiarci sopra.
  try {
    const { StatusBar } = await import('@capacitor/status-bar')
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: false })
      await StatusBar.setBackgroundColor({ color: '#006A5F' })
    }
  } catch (e) {
    plugineMancante('StatusBar', 'la barra di stato resta al default di sistema', e)
  }
  await applicaStiloStatusBar()

  // 3. Back button Android (chiude l'overlay in cima, altrimenti naviga indietro o esce
  //    alla radice) + deep link schema kidville:// (es. kidville://parent/agenda →
  //    /parent/agenda). Il deep link passa dalla stessa regola del tocco su una push
  //    (punto 4): chiunque può aprire un indirizzo kidville://, e `kidville://\evil.example`
  //    diventava `/\evil.example`, che per il browser è un altro sito.
  try {
    const { App } = await import('@capacitor/app')
    void App.addListener('backButton', ({ canGoBack }) => {
      // La convenzione Android: Indietro chiude PRIMA il livello più alto dell'interfaccia
      // (modale, bottom-sheet, pannello) e solo se non ce n'è nessuno torna indietro nella
      // cronologia. Senza questa riga, con la modale «Nuovo avviso» aperta un Indietro
      // distratto portava via la pagina e con lei l'avviso che si stava scrivendo.
      // `chiudiOverlayInCima()` → `true` significa «evento consumato»: si esce e basta.
      // Vedi `@/lib/mobile/overlay-indietro` per come una modale si iscrive al registro.
      if (chiudiOverlayInCima()) return
      if (canGoBack) window.history.back()
      else void App.exitApp()
    })
    void App.addListener('appUrlOpen', ({ url }) => {
      const m = /^kidville:\/\/(.*)$/i.exec(url)
      if (m) apriLinkNotifica('/' + m[1].replace(/^\/+/, ''), navigate)
    })
  } catch (e) {
    plugineMancante('App', 'il tasto Indietro e i deep link kidville:// non rispondono', e)
  }

  // 4. Tap su una push nativa → il link della notifica. Il payload FCM include
  //    data.url (vedi src/lib/push/native-push.ts). Ci passano il tocco ad app chiusa
  //    (il plugin trattiene l'evento finché questo ascoltatore non c'è), ad app in
  //    background e sul banner con l'app aperta.
  //
  //    ⚠️ QUI C'ERA `if (url.startsWith('/')) navigate(url)`, e il commento diceva «solo
  //    percorsi interni, mai URL esterni». Non era vero: `'//evil.example'` comincia con
  //    '/', e per il browser è l'indirizzo di un altro sito. Il controllo adesso sta in UN
  //    posto solo, `instradaLinkNotifica` (`@/lib/chat/link-conversazione`), che legge il
  //    link come lo legge il browser; un rifiuto lascia una riga di log, senza l'URL.
  //    Da quella regola (2026-09-15, parte C della correzione chat) il tocco riceve anche
  //    due comportamenti nuovi:
  //     · sulla pagina chat già aperta la conversazione si apre con un evento, senza
  //       navigare — in Next 16 una push allo stesso URL non rimonta la pagina, e il
  //       ritocco della stessa notifica non apriva niente;
  //     · a chi ha due profili, un link dell'altra area si riscrive nell'area in cui si
  //       trova: altrimenti la guardia d'area lo rimanda alla home e la conversazione si perde.
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const url = (action.notification?.data as { url?: unknown } | undefined)?.url
      if (typeof url === 'string') apriLinkNotifica(url, navigate)
    })
  } catch (e) {
    plugineMancante('PushNotifications', 'il tocco su una push non apre più la sua schermata', e)
  }
}
