#!/usr/bin/env node
/**
 * Genera TUTTE le icone di Kidville da un'unica sorgente: `assets/brand-lockup.png`
 * (il file esportato dal grafico: mascotte in una card bianca + lettering «Kidville»).
 *
 * PERCHÉ ESISTE QUESTO SCRIPT, invece di ritagliare a mano una volta sola.
 * Il file del grafico è un LOCKUP, non un'icona di sistema: ha il lettering sotto e una
 * cornice. Nessuna piattaforma lo mostra così com'è —
 *   · iOS applica una maschera «squircle» e RIFIUTA il canale alpha;
 *   · Android mostra solo il 66% centrale dell'adaptive icon: il lettering sparisce;
 *   · a 16px (favicon) di una figura intera non resta nulla di leggibile.
 * Quindi ogni piattaforma vuole un ritaglio diverso della STESSA immagine. Scritti a mano,
 * quei ritagli si perdono al primo cambio di logo; qui sono parametri, e si rigenera con
 *
 *     node scripts/genera-icone.mjs
 *
 * Se il grafico consegna un lockup nuovo, si sostituisce `assets/brand-lockup.png` e si
 * rilancia: se le proporzioni sono diverse, vanno riviste le costanti RITAGLIO qui sotto
 * (lo script stampa i box che usa, così si vede subito se sono fuori posto).
 *
 * ─── `npm run icone:native`, e perché ha quei parametri ────────────────────────────────
 * Propaga alle app native passando da `capacitor-assets`, che però non tocca solo le icone:
 *  · rigenera anche le SPLASH. Senza `--splashBackgroundColor '#006A5F'` le riscrive con lo
 *    sfondo bianco di default, cioè cambia una schermata che nessuno aveva chiesto di
 *    cambiare. Con il colore giusto restano identiche e non compaiono nel diff;
 *  · lascia dietro `icons/` e `public/manifest.webmanifest` — quest'ultimo è il danno
 *    peggiore, perché `public/` ha la precedenza sulle rotte di Next e quel file SOSTITUISCE
 *    il manifest vero (`src/app/manifest.ts`) puntando a `.webp` che non esistono. Il comando
 *    li rimuove in coda;
 *  · riformatta `android/app/src/main/AndroidManifest.xml` (sposta il `/>` a capo). Modifica
 *    innocua ma gratuita: conviene ripristinarla con `git checkout` prima di committare.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SORGENTE = path.join(RADICE, 'assets', 'brand-lockup.png')

/** Verde della cornice del lockup, campionato dal pixel (5,5) della sorgente. */
const VERDE = '#166D68'
const BIANCO = '#FFFFFF'

/**
 * RITAGLI misurati sulla sorgente 3200×3200 (scansione dei pixel: bordi della card bianca
 * e bounding box del soggetto). Sono espressi in FRAZIONI del lato, non in pixel, così una
 * sorgente riesportata a 2048 o 4096 continua a funzionare senza ricalcoli.
 */
const RITAGLIO = {
  /** Il mascotte dentro la card, con un filo d'aria. Tocca il fondo della card: è voluto. */
  soggetto: { left: 520 / 3200, top: 150 / 3200, width: 2300 / 3200, height: 2316 / 3200 },
  /**
   * Cappello + faccia fino al mento (misurato: il collo è la strozzatura a y≈1780), esclusa
   * la mano alzata che parte da x≈2200. È l'unica parte che sopravvive a 16px.
   */
  testa: { left: 480 / 3200, top: 140 / 3200, width: 1700 / 3200, height: 1760 / 3200 },
  /**
   * Il lettering «Kidville» bianco nella banda inferiore. Il box è misurato sui pixel
   * bianchi (x 633–2565, y 2542–3052) e NON deve risalire sopra y≈2490, dove finisce la
   * card: un pixel più su e il bordo bianco della card entra nel ritaglio, comparendo come
   * una riga chiara sospesa sopra la scritta nell'anteprima dei link.
   */
  lettering: { left: 613 / 3200, top: 2522 / 3200, width: 1973 / 3200, height: 551 / 3200 },
}

/**
 * Maschera di trasparenza che dissolve l'ultima fascia dell'immagine.
 *
 * Serve al ritaglio della testa: sotto il mento c'è il collo, e il bordo del ritaglio lo
 * tronca di netto: con una maschera quadrata quella linea si vede, e sembra un errore di
 * esportazione. Dissolvendola, il collo svanisce nel fondo bianco e non c'è nessun bordo da
 * notare. L'alternativa — spostare la testa fin sotto il bordo — la lascerebbe fuori centro,
 * perché nel ritaglio sotto il mento resta appena il 7% dell'altezza.
 */
function sfumaturaInBasso(larghezza, altezza, frazione) {
  const inizio = ((1 - frazione) * 100).toFixed(1)
  return Buffer.from(
    `<svg width="${larghezza}" height="${altezza}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="${inizio}%" stop-color="#fff" stop-opacity="1"/>` +
      `<stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `<rect width="${larghezza}" height="${altezza}" fill="url(#g)"/></svg>`,
  )
}

/**
 * Comprime un PNG prima di scriverlo.
 *
 * Non è cosmesi: `icon.png` non compresso pesava 464 KB per essere mostrato a 32 pixel, e
 * ogni visitatore se lo sarebbe scaricato. `palette: true` quantizza a 256 colori — su una
 * figura 3D con sfumature morbide si vedrebbe, ma a queste dimensioni no, e il confronto è
 * stampato a fine esecuzione per poterlo verificare invece di crederci.
 */
function comprimiPng(pipeline) {
  return pipeline.png({ compressionLevel: 9, effort: 10, palette: true, quality: 90 })
}

/** Da frazioni a pixel interi sulla sorgente reale. */
function box(frazioni, lato) {
  return {
    left: Math.round(frazioni.left * lato),
    top: Math.round(frazioni.top * lato),
    width: Math.round(frazioni.width * lato),
    height: Math.round(frazioni.height * lato),
  }
}

async function scrivi(destinazione, buffer) {
  await mkdir(path.dirname(destinazione), { recursive: true })
  await writeFile(destinazione, buffer)
  console.log('  ✔', path.relative(RADICE, destinazione))
}

/**
 * Larghezza della testa nel foreground dell'ADAPTIVE ICON Android.
 *
 * ATTENZIONE, QUI SI SBAGLIA FACILMENTE: sembra che il PNG debba avere la safe zone del 66%
 * dentro di sé, e invece no. `mipmap-anydpi-v26/ic_launcher.xml` avvolge i due livelli in un
 * `<inset android:inset="16.7%">`, che ridisegna il PNG INTERO esattamente dentro i 72dp
 * visibili su 108. La safe zone la applica già l'inset: rimpicciolire anche il contenuto la
 * conta due volte, e l'icona esce minuscola in mezzo al vuoto.
 *
 * Il riferimento non è una regola a memoria ma l'icona che questo progetto aveva prima:
 * il suo foreground riempiva il 71% del PNG. Il limite teorico è 70,7% (quadrato inscritto
 * nel cerchio, 1/√2): 0,68 sta un filo sotto, così la tesa del cappello non tocca il bordo.
 */
const TESTA_ADAPTIVE = 0.68

/**
 * Larghezza della testa nelle icone `maskable` del MANIFEST WEB — che è un caso diverso,
 * non la stessa cosa con un altro nome. Lì non c'è nessun inset: l'immagine è disegnata
 * intera e la specifica garantisce solo il cerchio centrale di diametro 80%. Quadrato
 * inscritto in quel cerchio: 0,8/√2 ≈ 0,566, arrotondato in giù per avere respiro.
 */
const TESTA_MASKABLE = 0.55

/**
 * IL LOCKUP COM'È STATO CONSEGNATO — nessun ritaglio, nessuna ricomposizione.
 *
 * ⚠️ 2026-08-04, decisione del titolare, e non è un dettaglio di gusto: **l'icona dell'app
 * deve essere l'immagine data dal grafico, esattamente com'è.** Fino a oggi
 * `assets/icon-only.png` conteneva `iconaPiena()`, cioè il mascotte RITAGLIATO dalla card e
 * ricomposto su fondo bianco: sul telefono spariva il fondo verde, spariva la card e spariva
 * il lettering «Kidville». Era una re-interpretazione del marchio fatta dallo script, non una
 * necessità tecnica.
 *
 * Tecnicamente si può, e senza compromessi: la sorgente è **quadrata e senza canale alpha**,
 * cioè già nella forma che iOS pretende. Serve solo ridimensionarla. La maschera «squircle»
 * di iOS smussa gli angoli, dove c'è il verde di fondo: non taglia niente di leggibile.
 *
 * Resta un solo ritaglio, e solo dove l'alternativa è illeggibile: la **favicon a 16px**, che
 * usa la testa. A quella dimensione il lockup intero è una macchia verde.
 */
const lockupIntatto = (lato) =>
  sharp(SORGENTE).resize(lato, lato, { fit: 'cover' }).flatten({ background: VERDE }).png().toBuffer()

/**
 * Il lockup INTERO dentro la safe zone di una maschera circolare.
 *
 * Adaptive icon Android e icone `maskable` del manifest ritagliano a cerchio. Un'immagine
 * quadrata ci sta dentro tutta solo se occupa al massimo il quadrato inscritto (1/√2 ≈ 70,7%
 * del lato): oltre, gli angoli — cioè la cornice e il lettering del lockup — vengono tagliati.
 *
 * Quindi qui il lockup **non si ritaglia: si rimpicciolisce**, e attorno resta il verde del
 * marchio. È l'unico modo di rispettare «l'immagine così com'è» su una piattaforma che
 * impone una maschera tonda.
 */
const lockupNellaSafeZone = async (lato, frazione) => {
  const dentro = Math.round(lato * frazione)
  const ridotto = await sharp(SORGENTE).resize(dentro, dentro, { fit: 'cover' }).png().toBuffer()
  const margine = Math.round((lato - dentro) / 2)
  return sharp({ create: { width: lato, height: lato, channels: 4, background: VERDE } })
    .composite([{ input: ridotto, left: margine, top: margine }])
    .png()
    .toBuffer()
}

/**
 * ── COSA C'ERA QUI, E PERCHÉ NON C'È PIÙ ───────────────────────────────────────────────
 * Fin qui vivevano `iconaPiena`, `primoPiano` e `iconaMaskable`: tre ricomposizioni che
 * ritagliavano dal lockup ora la figura intera, ora la sola testa, e le rimontavano su una
 * tela a tinta unita. Erano nate da provini veri (con la figura intera nel cerchio Android
 * il mento usciva; rimpicciolita, restava fuori un pezzo della mano alzata, che a 48px si
 * legge come un difetto).
 *
 * Sono state rimosse il 2026-08-04 perché risolvevano il problema sbagliato: **l'icona
 * dell'app deve essere l'immagine del grafico, non una sua reinterpretazione**. Il vincolo
 * della maschera tonda resta vero, e infatti `lockupNellaSafeZone` lo rispetta — ma
 * rimpicciolendo l'immagine intera invece di ritagliarla.
 *
 * Il ritaglio sulla testa sopravvive in un solo posto, `testa()`, e solo per la favicon a
 * 16px, dove il lockup intero è una macchia verde.
 */

/** Tinta unita, per il livello di fondo dell'adaptive icon. */
function tintaUnita(lato, colore) {
  return sharp({ create: { width: lato, height: lato, channels: 4, background: colore } })
    .png()
    .toBuffer()
}

/** Il ritaglio sulla testa, centrato in un quadrato bianco: l'unica cosa leggibile a 16px. */
async function testa(lato) {
  const { width: latoSorgente } = await sharp(SORGENTE).metadata()
  const b = box(RITAGLIO.testa, latoSorgente)
  const ritagliata = await sharp(SORGENTE)
    .extract(b)
    .resize(lato, lato, { fit: 'contain', background: BIANCO })
    .png()
    .toBuffer()
  return sharp(ritagliata)
    .composite([{ input: sfumaturaInBasso(lato, lato, 0.1), blend: 'dest-in' }])
    .flatten({ background: BIANCO })
    .png()
    .toBuffer()
}

/**
 * Costruisce un `.ico` multi-risoluzione con i PNG incapsulati (formato accettato da tutti i
 * browser in uso: l'ICO con PNG dentro esiste da Vista). Nessuna dipendenza esterna: sono
 * 22 byte di intestazione per immagine.
 */
function impacchettaIco(png) {
  const N = png.length
  const testata = Buffer.alloc(6 + 16 * N)
  testata.writeUInt16LE(0, 0) // riservato
  testata.writeUInt16LE(1, 2) // 1 = icona
  testata.writeUInt16LE(N, 4)
  let offset = 6 + 16 * N
  png.forEach(({ lato, dati }, i) => {
    const p = 6 + 16 * i
    testata.writeUInt8(lato >= 256 ? 0 : lato, p) // 0 significa 256
    testata.writeUInt8(lato >= 256 ? 0 : lato, p + 1)
    testata.writeUInt8(0, p + 2) // palette
    testata.writeUInt8(0, p + 3) // riservato
    testata.writeUInt16LE(1, p + 4) // piani
    testata.writeUInt16LE(32, p + 6) // bit per pixel
    testata.writeUInt32LE(dati.length, p + 8)
    testata.writeUInt32LE(offset, p + 12)
    offset += dati.length
  })
  return Buffer.concat([testata, ...png.map((x) => x.dati)])
}

/**
 * L'immagine dell'anteprima quando si condivide un link (1200×630, rapporto 1.91:1).
 * Ricostruisce il lockup in orizzontale: card bianca col mascotte a sinistra, lettering a
 * destra. Il contenuto sta lontano dai bordi perché WhatsApp e Telegram, in certe viste,
 * ritagliano l'anteprima al quadrato.
 */
async function anteprimaLink() {
  const L = 1200
  const A = 630
  const { width: latoSorgente } = await sharp(SORGENTE).metadata()

  const card = { x: 48, y: 34, w: 580, h: 562, r: 44 }
  const bSoggetto = box(RITAGLIO.soggetto, latoSorgente)
  const hSog = card.h
  const wSog = Math.round((hSog * bSoggetto.width) / bSoggetto.height)
  const soggetto = await sharp(SORGENTE).extract(bSoggetto).resize(wSog, hSog).png().toBuffer()

  const bLettering = box(RITAGLIO.lettering, latoSorgente)
  const wLet = 470
  const hLet = Math.round((wLet * bLettering.height) / bLettering.width)
  const lettering = await sharp(SORGENTE).extract(bLettering).resize(wLet, hLet).png().toBuffer()

  // La card bianca è un SVG e non un rettangolo pieno: servono gli angoli arrotondati, e
  // sharp non sa disegnarli. Fa anche da maschera per il soggetto, che altrimenti
  // sborderebbe con il suo fondo bianco rettangolare.
  const svgCard = Buffer.from(
    `<svg width="${L}" height="${A}"><rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="${card.r}" fill="#fff"/></svg>`,
  )
  const svgRitaglio = Buffer.from(
    `<svg width="${card.w}" height="${card.h}"><rect width="${card.w}" height="${card.h}" rx="${card.r}" fill="#fff"/></svg>`,
  )
  const soggettoRitagliato = await sharp({
    create: { width: card.w, height: card.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: soggetto, left: Math.round((card.w - wSog) / 2), top: 0 },
      { input: svgRitaglio, blend: 'dest-in' },
    ])
    .png()
    .toBuffer()

  // JPEG e non PNG: è una fotografia (sfumature 3D su fondo pieno), dove il PNG pesava
  // 580 KB contro gli ~80 del JPEG. WhatsApp e Telegram scaricano questa immagine a ogni
  // anteprima di link, e sopra qualche centinaio di KB alcuni client rinunciano a mostrarla.
  // Next riconosce `opengraph-image.jpg` per convenzione esattamente come il `.png`.
  return sharp({ create: { width: L, height: A, channels: 4, background: VERDE } })
    .composite([
      { input: svgCard, left: 0, top: 0 },
      { input: soggettoRitagliato, left: card.x, top: card.y },
      { input: lettering, left: 700, top: Math.round((A - hLet) / 2) },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

async function main() {
  if (!existsSync(SORGENTE)) {
    console.error(`Sorgente mancante: ${path.relative(RADICE, SORGENTE)}`)
    console.error("Serve il lockup del grafico (PNG quadrato, il più grande disponibile).")
    process.exitCode = 1
    return
  }
  const meta = await sharp(SORGENTE).metadata()
  if (meta.width !== meta.height) {
    console.error(`La sorgente deve essere quadrata: trovata ${meta.width}×${meta.height}.`)
    process.exitCode = 1
    return
  }
  console.log(`Sorgente: ${path.relative(RADICE, SORGENTE)} (${meta.width}×${meta.height})`)
  console.log('Ritagli in pixel:', {
    soggetto: box(RITAGLIO.soggetto, meta.width),
    testa: box(RITAGLIO.testa, meta.width),
    lettering: box(RITAGLIO.lettering, meta.width),
  })

  // ── Sorgenti per @capacitor/assets (iOS + Android nativi) ────────────────────────────
  console.log('\nMaster per le app native (assets/):')
  // Il lockup COM'È: è l'icona che l'utente vede su iPhone e nel launcher Android.
  // Senza alpha: App Store Connect rifiuta l'icona 1024 se ha un canale di trasparenza.
  await scrivi(path.join(RADICE, 'assets/icon-only.png'), await lockupIntatto(1024))
  // Adaptive icon: il lockup intero rimpicciolito nella safe zone, non ritagliato.
  await scrivi(path.join(RADICE, 'assets/icon-foreground.png'), await lockupNellaSafeZone(1024, TESTA_ADAPTIVE))
  await scrivi(path.join(RADICE, 'assets/icon-background.png'), await tintaUnita(1024, VERDE))

  // ── Web: favicon e icone del sito ────────────────────────────────────────────────────
  console.log('\nIcone del sito (src/app/):')
  const ico = []
  for (const lato of [16, 32, 48]) ico.push({ lato, dati: await testa(lato) })
  await scrivi(path.join(RADICE, 'src/app/favicon.ico'), impacchettaIco(ico))
  // 32px è ancora un favicon: meglio la testa, che a quella dimensione si riconosce.
  await scrivi(path.join(RADICE, 'src/app/icon.png'), await comprimiPng(sharp(await testa(512))).toBuffer())
  // 180px è l'icona di «Aggiungi a Home» su iOS Safari: è a tutti gli effetti l'icona
  // dell'app, quindi il lockup com'è.
  await scrivi(
    path.join(RADICE, 'src/app/apple-icon.png'),
    await comprimiPng(sharp(await lockupIntatto(180))).toBuffer(),
  )
  await scrivi(path.join(RADICE, 'src/app/opengraph-image.jpg'), await anteprimaLink())

  // ── PWA ──────────────────────────────────────────────────────────────────────────────
  console.log('\nIcone del manifest (public/):')
  await scrivi(path.join(RADICE, 'public/icon-192.png'), await comprimiPng(sharp(await lockupIntatto(192))).toBuffer())
  await scrivi(path.join(RADICE, 'public/icon-512.png'), await comprimiPng(sharp(await lockupIntatto(512))).toBuffer())
  await scrivi(
    path.join(RADICE, 'public/icon-maskable-512.png'),
    await comprimiPng(sharp(await lockupNellaSafeZone(512, TESTA_MASKABLE))).toBuffer(),
  )

  console.log('\nFatto. Per propagare alle app native: npm run icone:native')
}

await main()
