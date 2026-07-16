import { Capacitor } from '@capacitor/core'

// Setup della shell nativa Capacitor (M10.5). Chiamato UNA sola volta e SOLO su
// piattaforma nativa (vedi NativeInit). Ogni plugin è import dinamico e
// best-effort: se un plugin manca, si degrada in silenzio. Nessun effetto sul web.

export async function setupNativeShell(navigate: (path: string) => void): Promise<void> {
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

  // 2. Status bar: testo chiaro su sfondo verde brand. Su Android la barra è
  //    solida (overlay off) e la WebView parte sotto → nessun inset-top serve.
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: false })
      await StatusBar.setBackgroundColor({ color: '#006A5F' })
    }
  } catch {
    // plugin StatusBar non disponibile: ignora
  }

  // 3. Back button Android (naviga indietro o esce alla radice) + deep link
  //    schema kidville:// (es. kidville://parent/agenda → /parent/agenda).
  try {
    const { App } = await import('@capacitor/app')
    void App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back()
      else void App.exitApp()
    })
    void App.addListener('appUrlOpen', ({ url }) => {
      const m = /^kidville:\/\/(.*)$/i.exec(url)
      if (m) navigate('/' + m[1].replace(/^\/+/, ''))
    })
  } catch {
    // plugin App non disponibile: ignora
  }

  // 4. Tap su una push nativa → deep-link sul link della notifica. Il payload
  //    FCM include data.url (vedi src/lib/push/native-push.ts); si accettano
  //    solo percorsi interni ('/...') — mai URL esterni.
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const url = (action.notification?.data as { url?: string } | undefined)?.url
      if (typeof url === 'string' && url.startsWith('/')) navigate(url)
    })
  } catch {
    // plugin PushNotifications non disponibile: ignora
  }
}
