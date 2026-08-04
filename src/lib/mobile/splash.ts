import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * Toglie lo splash nativo — cioè decide QUANDO l'attesa d'avvio è finita.
 *
 * IL PEZZO CHE MANCAVA. La shell Capacitor carica l'app da `app.kidville.it` sulla rete: fra
 * la comparsa della WebView e il primo HTML passano secondi, e in quei secondi lo schermo era
 * bianco. Lo splash nativo (vedi `capacitor.config.ts`) adesso copre quell'intervallo con la
 * stessa schermata del `PageLoader`; questa funzione è l'altra metà, quella che lo leva.
 *
 * PERCHÉ NON BASTA CHIAMARE `hide()` E BASTA. `hide()` restituisce il controllo alla WebView
 * nell'istante in cui viene invocata. Chiamandola appena il JavaScript parte, si scopre il
 * frame PRIMA che il browser abbia dipinto: lo splash si dissolve su una pagina ancora vuota,
 * e il lampo bianco che si voleva togliere ricompare — più corto e più fastidioso, perché ora
 * arriva dopo qualcosa di finito. Il doppio `requestAnimationFrame` è il segnale «il frame
 * successivo è stato consegnato al compositore», ed è il primo momento in cui nascondere lo
 * splash mostra davvero dei pixel.
 *
 * IL TIMEOUT NON È PARANOIA. `requestAnimationFrame` **non viene servito** quando la pagina
 * non è visibile: se l'utente apre l'app e passa subito a un'altra, i frame smettono di
 * arrivare e senza la sveglia da 1,5 s questa promise non si risolverebbe mai. Al ritorno
 * l'utente troverebbe lo splash ancora lì, fino al tetto dei 10 s del plugin.
 *
 * NON LANCIA MAI, MA NON TACE (regola 6 di AGENTS.md). Se il plugin manca o `hide()` fallisce,
 * lo splash resta a schermo fino al tetto: un difetto che l'utente vede e che senza una riga
 * di log sarebbe indistinguibile da «la rete era lenta».
 */
export async function nascondiSplashNativo(): Promise<void> {
  let nativo = false
  try {
    nativo = Capacitor.isNativePlatform()
  } catch {
    // Bridge assente: siamo nel browser. Niente splash da togliere, niente da dire.
    return
  }
  if (!nativo) return

  await primoFramedipinto()

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    // 250 ms come `launchFadeOutDuration`: è lo stesso passaggio, e due durate diverse si
    // noterebbero confrontando l'avvio normale con quello scaduto per timeout.
    await SplashScreen.hide({ fadeOutDuration: 250 })
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'avvio',
      messaggio: `splash-nativo-non-nascosto: ${nomeErrore(e)}`,
    })
  }
}

/** Si risolve dopo che il browser ha consegnato un frame — o dopo 1,5 s, se i frame non arrivano. */
function primoFramedipinto(): Promise<void> {
  return new Promise((resolve) => {
    let risolto = false
    const finito = () => {
      if (risolto) return
      risolto = true
      resolve()
    }
    const sveglia = setTimeout(finito, 1500)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(sveglia)
        finito()
      }),
    )
  })
}
