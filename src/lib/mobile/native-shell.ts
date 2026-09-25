import { Capacitor } from '@capacitor/core'
import { chiudiOverlayInCima } from '@/lib/mobile/overlay-indietro'
import { nascondiSplashNativo } from '@/lib/mobile/splash'
import { applicaStiloStatusBar } from '@/lib/mobile/status-bar'
import { impostaVersioneApp, logClient, nomeErrore } from '@/lib/logging/client'
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
function plugineMancante(plugin: string, conseguenza: string, e: unknown, tentativi = 1): void {
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `native-shell: plugin ${plugin} non disponibile — ${conseguenza} (${nomeErrore(e)})`,
    campi: { tentativi },
  })
}

/**
 * IL PEZZO DI PROGRAMMA CHE NON È ARRIVATO (2026-09-25, PC2).
 *
 * L'app nativa carica il SITO: ogni `import('@capacitor/…')` qui sotto è un file JavaScript scaricato
 * dalla rete al momento. Un genitore che apre l'app in ascensore, o col telefono appena uscito dalla
 * modalità aereo, riceve un `ChunkLoadError` — e fino a oggi la shell si arrendeva per tutta la
 * sessione: il tasto Indietro usciva dall'app, i deep link e il tocco sulle push non aprivano niente
 * finché l'app non veniva chiusa e riaperta. Non è un plugin che MANCA: è un file che non è arrivato
 * ADESSO, e arriverà al ritorno della rete.
 *
 * La forma è la stessa di `TESTO_CHUNK` in `ChunkErrorBoundary.tsx`: il nome che Next dà all'errore e
 * i testi equivalenti dei browser. Un errore di forma diversa (il plugin assente dal binario, un metodo
 * che lancia) NON si ritenta: ripeterlo darebbe lo stesso esito.
 *
 * Il ritentativo di un `import()` fallito funziona davvero, ed è verificato sul runtime del bundle
 * (Turbopack, `.next/static/chunks/turbopack-*.js`): quando un chunk fallisce il suo resolver viene
 * tolto dalla cache (`B.delete`) e lo `<script>` rimosso dal documento, quindi l'`import()` successivo
 * riparte da zero invece di restituire la stessa promise rifiutata.
 */
const TESTO_CHUNK = /chunkloaderror|loading chunk|loading css chunk|dynamically imported module|importing a module script failed/i

export function eCaricamentoMancato(e: unknown): boolean {
  try {
    if (!(e instanceof Error)) return false
    return TESTO_CHUNK.test(`${e.name}: ${e.message}`)
  } catch {
    // Un getter ostile su `name`/`message`: l'errore non si può classificare, quindi nel dubbio NON è
    // un chunk e non si ritenta (ritentare un errore sconosciuto darebbe lo stesso esito, a vuoto).
    // Non è un catch muto (AGENTS.md §6): la riga dice che la classificazione è saltata. È `warn` e
    // non `error` perché il chiamante prosegue comunque col warn di sempre (`plugineMancante`), e il
    // messaggio NON rilegge `name`/`message` — sono proprio le proprietà che hanno appena lanciato.
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: 'native-shell: errore di caricamento non classificabile — non si ritenta',
    })
    return false
  }
}

/**
 * Quanti ritentativi al massimo, per ogni plugin, in una sessione. Il ritentativo parte solo su un
 * evento (rete tornata, app in primo piano), quindi non c'è raffica per costruzione; il tetto chiude
 * il caso patologico di una rete che va e viene di continuo, o di un deploy che ha tolto il file per
 * sempre (lì solo un ricaricamento aiuta, e a dirlo c'è `ChunkErrorBoundary`).
 */
export const RITENTATIVI_PLUGIN_MAX = 5

/**
 * Una promise che si risolve al primo segnale di ripresa: la rete che torna (`online`) o l'app che
 * torna in primo piano (`visibilitychange` → visibile, che la WebView riceve anche su iOS e Android).
 *
 * Non si usa `appStateChange` di `@capacitor/app`, e non per pigrizia: è proprio uno dei plugin che
 * possono non essere arrivati. Il segnale di ripresa non può dipendere dalla cosa da riprendere.
 */
function aspettaRipresa(): Promise<void> {
  return new Promise((risolvi) => {
    const fatto = () => {
      window.removeEventListener('online', fatto)
      document.removeEventListener('visibilitychange', suVisibilita)
      risolvi()
    }
    const suVisibilita = () => {
      if (document.visibilityState === 'visible') fatto()
    }
    window.addEventListener('online', fatto)
    document.addEventListener('visibilitychange', suVisibilita)
  })
}

interface PassoShell {
  plugin: string
  conseguenza: string
  esegui: () => Promise<void>
  /**
   * Cosa rifare quando il passo riesce in un RITENTATIVO, oltre a `esegui`. Serve a StatusBar: la
   * prima applicazione dello stile (`applicaStiloStatusBar`) parte una volta sola, subito dopo il
   * primo tentativo, e se il file del plugin non era arrivato fallisce anche lei. Senza questo gancio
   * il log direbbe «caricato al ritorno della rete» con le icone della barra ancora sbagliate.
   */
  dopoRecupero?: () => Promise<void>
}

/**
 * Esegue un passo della shell (import del plugin + aggancio). Si risolve dopo il PRIMO tentativo —
 * l'ordine dei passi di `setupNativeShell` resta quello di sempre — e, se il file del plugin non è
 * arrivato, lascia armato un ritentativo alla ripresa, fino a `RITENTATIVI_PLUGIN_MAX`.
 *
 * I log, uno per fase e mai uno per evento di rete:
 *  · il primo `ChunkLoadError` → `warn` «si riprova»: senza, un plugin arrivato tardi sarebbe
 *    indistinguibile da uno arrivato subito;
 *  · il recupero → `warn` con i tentativi: è la prova che il ritentativo serve (e quanto);
 *  · il tetto raggiunto, o un errore che non è di rete → il `warn` di sempre (`plugineMancante`).
 *
 * Al recupero (`tentativo > 0` e `esegui` riuscito) parte anche `dopoRecupero`, FUORI dal `try` di
 * `esegui`: un suo guasto non deve passare per «plugin non disponibile», né armare un ritentativo.
 */
async function eseguiPasso(passo: PassoShell, tentativo = 0): Promise<void> {
  try {
    await passo.esegui()
  } catch (e) {
    if (!eCaricamentoMancato(e) || tentativo >= RITENTATIVI_PLUGIN_MAX) {
      plugineMancante(passo.plugin, passo.conseguenza, e, tentativo + 1)
      return
    }
    if (tentativo === 0) {
      logClient({
        livello: 'warn',
        evento: 'avvio',
        messaggio: `native-shell: plugin ${passo.plugin} non caricato (rete) — si riprova al ritorno della rete o in primo piano`,
        campi: { error_code: nomeErrore(e) },
      })
    }
    void aspettaRipresa().then(() => eseguiPasso(passo, tentativo + 1))
    return
  }
  if (tentativo === 0) return
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `native-shell: plugin ${passo.plugin} caricato al ritorno della rete o in primo piano`,
    campi: { tentativi: tentativo + 1 },
  })
  if (!passo.dopoRecupero) return
  try {
    await passo.dopoRecupero()
  } catch (e) {
    // Qui si arriva da `aspettaRipresa().then(…)`: senza questo catch sarebbe un rifiuto non gestito.
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: `native-shell: plugin ${passo.plugin} recuperato, ma il passo successivo al recupero è fallito`,
      campi: { error_code: nomeErrore(e) },
    })
  }
}

/**
 * La versione del binario nei log di OGNI evento del client (`versione_app`, vedi `client.ts`).
 * Separata dall'aggancio dei listener di `App`, e non per ordine: se `getInfo` lanciasse dentro lo
 * stesso `try`, il tasto Indietro e i deep link risulterebbero «non disponibili» per un campo di log.
 */
async function registraVersioneApp(App: typeof import('@capacitor/app').App): Promise<void> {
  try {
    const info = await App.getInfo()
    impostaVersioneApp(info.version, info.build)
  } catch (e) {
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: 'native-shell: versione dell’app illeggibile — i log partono senza `versione_app`',
      campi: { error_code: nomeErrore(e) },
    })
  }
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
  //
  //    Per la stessa ragione un passo StatusBar RECUPERATO (file del plugin arrivato solo al ritorno
  //    della rete) deve rifare lo stile, non soltanto le due chiamate inefficaci: la prima
  //    `applicaStiloStatusBar` qui sotto è fallita insieme al suo import, e senza `dopoRecupero` chi
  //    resta sulla login non vedrebbe mai le icone giuste (le riapplica `NativeInit` solo al cambio
  //    di percorso). Al primo tentativo l'ordine resta quello di sempre: passo, poi stile.
  await eseguiPasso({
    plugin: 'StatusBar',
    conseguenza: 'la barra di stato resta al default di sistema',
    esegui: async () => {
      const { StatusBar } = await import('@capacitor/status-bar')
      if (Capacitor.getPlatform() === 'android') {
        await StatusBar.setOverlaysWebView({ overlay: false })
        await StatusBar.setBackgroundColor({ color: '#006A5F' })
      }
    },
    dopoRecupero: applicaStiloStatusBar,
  })
  await applicaStiloStatusBar()

  // 3. Back button Android (chiude l'overlay in cima, altrimenti naviga indietro o esce
  //    alla radice) + deep link schema kidville:// (es. kidville://parent/agenda →
  //    /parent/agenda). Il deep link passa dalla stessa regola del tocco su una push
  //    (punto 4): chiunque può aprire un indirizzo kidville://, e `kidville://\evil.example`
  //    diventava `/\evil.example`, che per il browser è un altro sito.
  //    Nello stesso passo si legge la versione del binario per i log (`registraVersioneApp`): è lo
  //    stesso plugin, e se il suo file arriva al secondo tentativo arriva anche la versione.
  await eseguiPasso({
    plugin: 'App',
    conseguenza: 'il tasto Indietro e i deep link kidville:// non rispondono',
    esegui: async () => {
      const { App } = await import('@capacitor/app')
      void registraVersioneApp(App)
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
    },
  })

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
  //
  //    Un ritentativo tardivo qui non perde il tocco che ha aperto l'app: il plugin trattiene
  //    l'evento finché un ascoltatore non c'è (vedi sopra).
  await eseguiPasso({
    plugin: 'PushNotifications',
    conseguenza: 'il tocco su una push non apre più la sua schermata',
    esegui: async () => {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const url = (action.notification?.data as { url?: unknown } | undefined)?.url
        if (typeof url === 'string') apriLinkNotifica(url, navigate)
      })
    },
  })
}
