import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

/**
 * L'ICONA PICCOLA DELLE NOTIFICHE ANDROID (app 1.1, 24/09/2026).
 *
 * Senza `com.google.firebase.messaging.default_notification_icon`, una push che
 * arriva ad app chiusa usa l'icona dell'app ridotta alla sola SAGOMA: la nostra è
 * una card piena, e nella barra di stato diventa un quadrato bianco. L'icona
 * piccola deve essere monocromatica — bianco su trasparente — e il colore lo
 * mette il sistema da `default_notification_color`.
 *
 * Nessun test che giri in jsdom vede una barra di stato: questo lock guarda i
 * pezzi che la producono, cioè manifest, drawable e colore, tutti file TRACCIATI.
 * La generazione è in `scripts/genera-icona-notifica.mjs`.
 */

const RADICE = path.resolve(__dirname, '..', '..')
const RES = path.join(RADICE, 'android/app/src/main/res')
const manifest = fs.readFileSync(path.join(RADICE, 'android/app/src/main/AndroidManifest.xml'), 'utf8')

/** Lato in pixel dell'icona a 24dp per densità. */
const DENSITA: Record<string, number> = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 }

function metaData(nome: string): string | null {
  const m = manifest.match(
    new RegExp(`<meta-data\\s+android:name="${nome.replace(/\./g, '\\.')}"\\s+android:(?:resource|value)="([^"]+)"`),
  )
  return m ? m[1] : null
}

describe('icona piccola delle notifiche Android', () => {
  it('il manifest dichiara icona e colore di default di FCM', () => {
    expect(metaData('com.google.firebase.messaging.default_notification_icon')).toBe('@drawable/ic_stat_kidville')
    expect(metaData('com.google.firebase.messaging.default_notification_color')).toBe('@color/kv_green')
  })

  it('il manifest è XML valido: nessun commento contiene «--»', () => {
    // Un `--` dentro `<!-- … -->` è XML malformato: il merge del manifest di Gradle
    // fallisce («Error parsing AndroidManifest.xml») e l'app non si costruisce più.
    // Successo davvero scrivendo il nome di un token CSS in un commento.
    const commenti = manifest.match(/<!--[\s\S]*?-->/g) ?? []
    expect(commenti.length).toBeGreaterThan(0)
    const malformati = commenti.filter((c) => c.slice(4, -3).includes('--'))
    expect(malformati).toEqual([])
  })

  it('il colore è il verde del marchio dei design token', () => {
    const colori = fs.readFileSync(path.join(RES, 'values/colors.xml'), 'utf8')
    const verde = colori.match(/<color name="kv_green">(#[0-9A-Fa-f]{6})<\/color>/)?.[1]
    const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8')
    const token = css.match(/--color-kidville-green:\s*(#[0-9A-Fa-f]{6})/)?.[1]
    expect(verde).toBeDefined()
    expect(verde?.toUpperCase()).toBe(token?.toUpperCase())
  })

  it.each(Object.entries(DENSITA))('drawable-%s: %ipx, bianco su trasparente, con un disegno', async (densita, lato) => {
    const file = path.join(RES, `drawable-${densita}`, 'ic_stat_kidville.png')
    expect(fs.existsSync(file), `${file} mancante`).toBe(true)
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([lato, lato])

    let visibili = 0
    let colorati = 0
    let trasparenti = 0
    for (let i = 0; i < data.length; i += 4) {
      const alfa = data[i + 3]
      if (alfa === 0) {
        trasparenti++
        continue
      }
      visibili++
      // Tolleranza di 2 livelli per l'arrotondamento del ridimensionamento.
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 253) colorati++
    }
    expect(colorati, 'pixel non bianchi: Android userebbe comunque solo l’alfa, ma l’icona non è monocromatica').toBe(0)
    // Un disegno vero: né vuoto né un quadrato pieno (che è il difetto da evitare).
    expect(visibili / (lato * lato)).toBeGreaterThan(0.15)
    expect(trasparenti / (lato * lato)).toBeGreaterThan(0.3)
  })
})
