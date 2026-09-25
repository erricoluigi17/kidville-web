#!/usr/bin/env node
/**
 * Genera l'ICONA PICCOLA delle notifiche Android (`ic_stat_kidville`) dal marchio Kidville.
 *
 *     node scripts/genera-icona-notifica.mjs
 *
 * PERCHÉ ESISTE. Senza `com.google.firebase.messaging.default_notification_icon` nel manifest,
 * una push FCM che arriva ad app chiusa usa come icona piccola l'icona dell'app: Android la
 * riduce alla sola SAGOMA (canale alfa), e la nostra icona — una card piena — diventa un
 * quadrato bianco nella barra di stato. L'icona piccola dev'essere monocromatica: bianco su
 * trasparente. Il colore lo aggiunge il sistema, da `default_notification_color`.
 *
 * DA DOVE VIENE LA FORMA. Dalla «K» del lettering `public/logo-kidville.png` (lo stesso file
 * che il PageLoader mette al centro): è l'unica parte del marchio che resta leggibile a 24dp.
 * La mascotte, ridotta a sagoma, sarebbe una macchia. La K non si ritaglia con un rettangolo,
 * perché la gamba inferiore passa sotto la «i»: si prendono le COMPONENTI CONNESSE del canale
 * alfa che cominciano nella prima fascia a sinistra (asta + braccio/gamba), e basta.
 *
 * Misure Material: 24dp di lato con 2dp di margine per parte (area utile 20dp).
 * Densità: mdpi 24px · hdpi 36 · xhdpi 48 · xxhdpi 72 · xxxhdpi 96.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SORGENTE = path.join(RADICE, 'public', 'logo-kidville.png')
const RES = path.join(RADICE, 'android', 'app', 'src', 'main', 'res')
const NOME = 'ic_stat_kidville.png'

const DENSITA = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 }
/** 20dp utili su 24: 2dp di margine per lato. */
const AREA_UTILE = 20 / 24
/** Soglia del canale alfa oltre la quale un pixel appartiene al lettering. */
const SOGLIA = 20
/**
 * Una componente fa parte della K se il suo primo pixel sta nel primo 12% della larghezza
 * del lettering (la «K» occupa il ~20%, la «i» comincia al ~19%). Misurato: le componenti
 * trovate sono due, asta (x 0–206) e braccio+gamba (x 172–449), su una sorgente di 2227px.
 */
const FASCIA_K = 0.12

const { data, info } = await sharp(SORGENTE).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: w, height: h, channels } = info
const alfa = (x, y) => data[(y * w + x) * channels + 3]

// Componenti connesse (4-vicinato) che toccano la fascia della K.
const maschera = new Uint8Array(w * h)
const limite = Math.round(w * FASCIA_K)
let minX = w, maxX = 0, minY = h, maxY = 0
for (let x0 = 0; x0 < limite; x0++) {
  for (let y0 = 0; y0 < h; y0++) {
    if (alfa(x0, y0) <= SOGLIA || maschera[y0 * w + x0]) continue
    const coda = [y0 * w + x0]
    maschera[y0 * w + x0] = 1
    while (coda.length > 0) {
      const i = coda.pop()
      const x = i % w
      const y = (i - x) / w
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (maschera[j] || alfa(nx, ny) <= SOGLIA) continue
        maschera[j] = 1
        coda.push(j)
      }
    }
  }
}

const larg = maxX - minX + 1
const alt = maxY - minY + 1
console.log(`K: x ${minX}–${maxX}, y ${minY}–${maxY} (${larg}×${alt})`)
if (larg > w * 0.3 || larg < w * 0.1) {
  throw new Error(`Ritaglio della K fuori scala (${larg}px su ${w}): il lettering è cambiato?`)
}

// Bianco pieno, alfa = alfa originale dentro la maschera (bordi antialias conservati).
const rgba = Buffer.alloc(larg * alt * 4)
for (let y = 0; y < alt; y++) {
  for (let x = 0; x < larg; x++) {
    const sx = x + minX
    const sy = y + minY
    const o = (y * larg + x) * 4
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 255
    rgba[o + 3] = maschera[sy * w + sx] ? alfa(sx, sy) : 0
  }
}

for (const [densita, lato] of Object.entries(DENSITA)) {
  const utile = Math.round(lato * AREA_UTILE)
  const glifo = await sharp(rgba, { raw: { width: larg, height: alt, channels: 4 } })
    .resize(utile, utile, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer()
  const png = await sharp({
    create: { width: lato, height: lato, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  })
    .composite([{ input: glifo, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  const destinazione = path.join(RES, `drawable-${densita}`, NOME)
  await mkdir(path.dirname(destinazione), { recursive: true })
  await writeFile(destinazione, png)
  console.log('  ✔', path.relative(RADICE, destinazione), `${lato}×${lato}`)
}
