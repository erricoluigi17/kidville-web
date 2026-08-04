import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import type { CapacitorConfig } from '@capacitor/cli'

/**
 * LA SCHERMATA D'AVVIO DELL'APP NATIVA — che è una schermata sola in due metà.
 *
 * IL DIFETTO, segnalato dal titolare il 2026-08-04 dopo aver installato la 1.0 (3) da
 * TestFlight: «quando apre l'app, rimane per dei secondi schermo bianco». La causa non è
 * un caricamento lento del sito: è che questa app è una WebView che scarica
 * `app.kidville.it` DALLA RETE. La schermata di lancio di iOS sparisce quando il processo
 * è pronto — qualche decimo di secondo — e il primo HTML arriva secondi dopo. In mezzo la
 * WebView non ha niente da dipingere.
 *
 * ── COSA C'ERA PRIMA, misurato e non ricordato ────────────────────────────────────────
 * `Splash.imageset` conteneva un'immagine VERDE PIENA (`#006A5F`), senza logo. Accanto
 * vivevano tre file `splash-2732x2732*.png` bianchi col marchio Capacitor, che
 * `Contents.json` **non referenziava**: residui del template, rimossi insieme a questo
 * test perché sono esattamente ciò che fa sbagliare diagnosi a chi guarda la cartella.
 *
 * ── LA CORREZIONE, E PERCHÉ QUESTO LOCK ───────────────────────────────────────────────
 * Lo splash nativo adesso è la copia esatta del `PageLoader`: fondo crema, lettering
 * «Kidville» al centro. Quando l'app web è pronta lo splash si dissolve e sotto c'è il
 * `PageLoader` — stesso fondo, stesso logo, stessa misura — quindi il passaggio non si
 * vede. Tutto il valore della correzione sta in quell'«uguale», e l'uguaglianza è
 * ripetuta in QUATTRO file che nessun compilatore tiene insieme:
 *
 *   · `src/components/ui/PageLoader.module.css`  il crema dell'app web
 *   · `capacitor.config.ts`                      il fondo dello splash e della WebView
 *   · `scripts/genera-icone.mjs`                 il crema con cui si disegna il PNG
 *   · `package.json` (`icone:native`)            il crema delle fasce, per `capacitor-assets`
 *
 * Cambiarne uno solo non rompe niente: produce un'app che all'avvio cambia colore sotto gli
 * occhi dell'utente, e nessun test rosso. Questo lock è l'unica cosa che lo impedisce.
 *
 * ── E LA PROVA CHE CONTA, che non è sulla configurazione ma sui PIXEL ──────────────────
 * Il test finale apre i PNG generati e legge il primo pixel. Serve perché tutta la
 * configurazione può essere giusta e l'immagine sbagliata: è successo, ed è il verde di
 * cui sopra. `capacitor-assets` non gira in CI — i PNG sono committati — quindi senza
 * questo controllo un file rigenerato a mano con i parametri di ieri passerebbe.
 */

const RADICE = process.cwd()
const CREMA = '#FEF1E4'

const leggi = (relativo: string) => fs.readFileSync(path.join(RADICE, relativo), 'utf8')

async function config(): Promise<CapacitorConfig> {
  vi.resetModules()
  vi.stubEnv('CAP_SERVER_URL', 'https://app.kidville.it')
  return (await import('../../capacitor.config')).default
}

/**
 * Il primo pixel della prima riga di un PNG, in `#RRGGBB`.
 *
 * PERCHÉ SI PUÒ FARE IN VENTI RIGHE, senza decodificare l'immagine e senza `sharp` (che in
 * questo repo non è nemmeno una dipendenza dichiarata: arriva per via transitiva, e un test
 * che ci si appoggiasse potrebbe sparire con un `npm ci`). Ogni riga di un PNG comincia con
 * un byte di filtro, e tutti e cinque i filtri predicono da pixel a SINISTRA e SOPRA: sulla
 * prima riga entrambi valgono zero, qualunque filtro sia. Quindi il primo pixel è sempre il
 * valore grezzo, senza bisogno di ricostruire alcunché.
 */
function primoPixel(relativo: string): string {
  const b = fs.readFileSync(path.join(RADICE, relativo))
  let offset = 8
  let profondita = 0
  let tipoColore = 0
  let tavolozza: Buffer | null = null
  const idat: Buffer[] = []
  while (offset < b.length) {
    const lunghezza = b.readUInt32BE(offset)
    const nome = b.toString('ascii', offset + 4, offset + 8)
    const dati = b.subarray(offset + 8, offset + 8 + lunghezza)
    if (nome === 'IHDR') {
      profondita = dati[8]
      tipoColore = dati[9]
      if (dati[12] !== 0) throw new Error(`${relativo}: PNG interlacciato, non gestito`)
    } else if (nome === 'PLTE') tavolozza = dati
    else if (nome === 'IDAT') idat.push(dati)
    else if (nome === 'IEND') break
    offset += 12 + lunghezza
  }
  if (profondita !== 8) throw new Error(`${relativo}: profondità ${profondita} bit, non gestita`)
  const pixel = inflateSync(Buffer.concat(idat)).subarray(1) // salta il byte di filtro
  const esa = (r: number, g: number, b2: number) =>
    '#' + [r, g, b2].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
  if (tipoColore === 3) {
    if (!tavolozza) throw new Error(`${relativo}: PNG con tavolozza ma senza PLTE`)
    const i = pixel[0] * 3
    return esa(tavolozza[i], tavolozza[i + 1], tavolozza[i + 2])
  }
  if (tipoColore === 2 || tipoColore === 6) return esa(pixel[0], pixel[1], pixel[2])
  if (tipoColore === 0 || tipoColore === 4) return esa(pixel[0], pixel[0], pixel[0])
  throw new Error(`${relativo}: tipo colore ${tipoColore} non gestito`)
}

describe('schermata d’avvio nativa', () => {
  it('lo splash e la WebView hanno il fondo del PageLoader, non il bianco di sistema', async () => {
    const c = await config()
    const splash = c.plugins?.SplashScreen as Record<string, unknown> | undefined

    expect(splash, 'il plugin SplashScreen non è configurato: senza, non c’è nessuno splash')
      .toBeDefined()
    expect(splash?.backgroundColor).toBe(CREMA)
    // Il fondo della finestra sotto la WebView: è ciò che si vede quando lo splash se n’è
    // andato e l’HTML non è ancora arrivato. Col bianco tornerebbe il lampo chiaro.
    expect(c.ios?.backgroundColor).toBe(CREMA)
    expect(c.android?.backgroundColor).toBe(CREMA)
  })

  it('il tetto esiste: nessun avvio può restare bloccato sullo splash per sempre', async () => {
    const c = await config()
    const splash = c.plugins?.SplashScreen as Record<string, unknown> | undefined

    // `launchAutoHide: false` toglierebbe lo splash SOLO da JavaScript. Basta un boot in cui
    // il JS non arriva mai — server che non risponde né fallisce, chunk che non carica —
    // perché l’app resti su una schermata fissa a tempo indeterminato.
    expect(splash?.launchAutoHide).toBe(true)
    const tetto = splash?.launchShowDuration
    expect(typeof tetto).toBe('number')
    // Il limite alto non è estetica: il tetto è anche quanto dura lo splash in MODALITÀ
    // AEREO, dove il caricamento fallisce subito e `offline.html` potrebbe non avere il
    // bridge per chiedere di toglierlo.
    expect(tetto as number).toBeGreaterThan(2_000)
    expect(tetto as number).toBeLessThanOrEqual(8_000)
  })

  it('qualcuno toglie davvero lo splash quando l’app è pronta', () => {
    const shell = leggi('src/lib/mobile/native-shell.ts')
    // Senza questa chiamata la configurazione resta perfetta e OGNI avvio dura quanto il
    // tetto: il difetto peggiora invece di risolversi, e lo fa in silenzio.
    //
    // ⚠️ Si cerca la CHIAMATA, non il nome. La prima versione di questa riga faceva
    // `toContain('nascondiSplashNativo')` e passava anche togliendo l'invocazione, perché
    // il nome resta nell'`import`. L'ha smascherata la prova per mutazione, non la lettura.
    expect(shell).toMatch(/nascondiSplashNativo\s*\(/)
    // E `offline.html` ci prova a sua volta, per non tenere sei secondi di splash davanti a
    // un messaggio già pronto.
    expect(leggi('mobile/www/offline.html')).toContain('SplashScreen')
  })

  it('il crema è LO STESSO in tutti e quattro i file che lo ripetono', () => {
    // Il valore dell'app web è il riferimento: è quello che l'utente vede per ultimo, e
    // quindi quello a cui gli altri tre devono adeguarsi.
    const css = leggi('src/components/ui/PageLoader.module.css')
    const dalCss = /--color-kidville-cream,\s*(#[0-9A-Fa-f]{6})/.exec(css)?.[1]
    expect(dalCss?.toUpperCase(), 'PageLoader.module.css non dichiara più un crema riconoscibile')
      .toBe(CREMA)

    const dalGeneratore = /const CREMA = '(#[0-9A-Fa-f]{6})'/.exec(leggi('scripts/genera-icone.mjs'))?.[1]
    expect(dalGeneratore?.toUpperCase()).toBe(CREMA)

    const script = (JSON.parse(leggi('package.json')) as { scripts: Record<string, string> })
      .scripts['icone:native']
    for (const bandiera of ['--splashBackgroundColor', '--splashBackgroundColorDark']) {
      const valore = new RegExp(`${bandiera} '(#[0-9A-Fa-f]{6})'`).exec(script)?.[1]
      expect(valore?.toUpperCase(), `${bandiera} in icone:native`).toBe(CREMA)
    }
  })

  it('i PNG committati sono crema — la configurazione giusta non basta', () => {
    // iOS: si controllano i file che `Contents.json` referenzia davvero. Guardare la cartella
    // è ciò che ha fatto sbagliare diagnosi una volta, quando accanto ai file usati vivevano
    // tre residui del template Capacitor con un'immagine completamente diversa.
    const contents = JSON.parse(
      leggi('ios/App/App/Assets.xcassets/Splash.imageset/Contents.json'),
    ) as { images: { filename?: string }[] }
    const referenziati = contents.images.map((i) => i.filename).filter(Boolean) as string[]
    expect(referenziati.length).toBeGreaterThan(0)
    for (const nome of referenziati) {
      expect(primoPixel(`ios/App/App/Assets.xcassets/Splash.imageset/${nome}`), `iOS ${nome}`)
        .toBe(CREMA)
    }
    // E nessun file non referenziato deve restare a confondere le acque.
    const suDisco = fs
      .readdirSync(path.join(RADICE, 'ios/App/App/Assets.xcassets/Splash.imageset'))
      .filter((f) => f.endsWith('.png'))
    expect(suDisco.sort()).toEqual([...referenziati].sort())

    // Android: la sorgente di tutti, più le due varianti che sbagliano più facilmente —
    // `-night`, che con un tema scuro tornerebbe nero, e una densità qualsiasi.
    for (const drawable of ['drawable', 'drawable-night', 'drawable-port-xxxhdpi']) {
      expect(primoPixel(`android/app/src/main/res/${drawable}/splash.png`), drawable).toBe(CREMA)
    }

    // Il master da cui tutto discende.
    expect(primoPixel('assets/splash.png')).toBe(CREMA)
    expect(primoPixel('assets/splash-dark.png')).toBe(CREMA)
  })
})
