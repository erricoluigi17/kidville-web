#!/usr/bin/env node
/**
 * Genera `public/mascot-email.png`: la mascotte tagliata su misura per le email.
 *
 * ─── PERCHÉ NON SI RIUSA `mascot-hero.png` ────────────────────────────────────────────
 * Quella sorgente è **665×994 px e 715 KB**, ed è giusta dov'è: nella dashboard, dentro
 * `HeroCard`, su uno schermo che la disegna a 150×180 con la densità doppia. Nelle email la
 * stessa figura viene disegnata a **86×128** (64×96 sotto i 480 px), cioè un francobollo —
 * e il file lo scarica il telefono di ogni famiglia a ogni apertura, spesso sotto rete
 * mobile. Sono 715 KB per otto millimetri di mascotte.
 *
 * Un'immagine sovradimensionata non rompe niente e non avvisa nessuno: è esattamente la
 * classe di difetto che in questo repo si è deciso di misurare invece di dedurre. Qui la
 * misura è il peso del file, e il tetto è dichiarato sotto.
 *
 * ─── LA DIMENSIONE, E PERCHÉ QUELLA ───────────────────────────────────────────────────
 * 172×256 = il doppio dello slot da 86×128, cioè quanto basta a un display a densità
 * doppia. Andare oltre non si vede: i client email non fanno `srcset`, e nessuno guarda una
 * mascotte decorativa con la lente.
 *
 *     node scripts/mascotte-email.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..')
const SORGENTE = join(RADICE, 'public', 'mascot-hero.png')
const USCITA = join(RADICE, 'public', 'mascot-email.png')

/** Lo slot nell'email è 86×128; questa è la densità doppia. */
const LARGHEZZA = 172
const ALTEZZA = 256

/**
 * Il tetto di peso, dichiarato perché sia un fatto e non una speranza. Se un giorno la
 * mascotte cambia e non ci sta più dentro, questo script lo dice invece di lasciar passare
 * mezzo megabyte in silenzio.
 */
const TETTO_BYTE = 30 * 1024

const originale = statSync(SORGENTE).size

const buffer = await sharp(readFileSync(SORGENTE))
    .resize(LARGHEZZA, ALTEZZA, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    // La mascotte sta su fondo giallo pieno e ha poche tinte: la tavolozza a 8 bit la rende
    // identica a occhio e la fa pesare una frazione.
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer()

if (buffer.length > TETTO_BYTE) {
    console.error(
        `La mascotte per l'email pesa ${(buffer.length / 1024).toFixed(1)} KB, oltre il tetto di ` +
        `${TETTO_BYTE / 1024} KB. Non la scrivo: va ridotta la tavolozza o le dimensioni.`,
    )
    process.exit(1)
}

writeFileSync(USCITA, buffer)
console.log(
    `public/mascot-email.png — ${LARGHEZZA}×${ALTEZZA} px, ${(buffer.length / 1024).toFixed(1)} KB ` +
    `(da ${(originale / 1024).toFixed(0)} KB: ${(100 - (buffer.length / originale) * 100).toFixed(1)}% in meno)`,
)
