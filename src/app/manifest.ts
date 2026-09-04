import type { MetadataRoute } from 'next'

/**
 * Manifest della web app (servito da Next su `/manifest.webmanifest`).
 *
 * Prima non esisteva: chi faceva «Aggiungi a schermata Home» dal browser si ritrovava
 * un'icona di ripiego decisa dal sistema — nei fatti uno screenshot della pagina o
 * l'iniziale del titolo — mentre l'app installata dagli store aveva la sua.
 *
 * Le icone stanno in `public/` e le genera `scripts/genera-icone.mjs` dal lockup del brand:
 * NON vanno ritoccate a mano, verrebbero sovrascritte alla prossima esecuzione.
 *
 * Sulle due voci `512`, che sembrano un doppione e non lo sono:
 *  · `purpose: 'any'` è l'immagine mostrata così com'è;
 *  · `purpose: 'maskable'` è quella che il sistema può RITAGLIARE con una forma sua (cerchio,
 *    squircle…). Ha il soggetto più piccolo, perché la specifica garantisce solo il cerchio
 *    centrale di diametro 80%. Se si dichiarasse `maskable` l'immagine piena, Android le
 *    taglierebbe i bordi; se non se ne dichiarasse nessuna, ci metterebbe intorno una
 *    cornice bianca automatica.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Kidville',
    short_name: 'Kidville',
    description: 'La tua scuola, sempre con te',
    lang: 'it-IT',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FEF1E4',
    theme_color: '#006A5F',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
