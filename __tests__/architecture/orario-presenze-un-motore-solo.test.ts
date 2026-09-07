// @vitest-environment node
/**
 * LOCK · l'orario di una presenza si legge e si scrive in UN POSTO SOLO, e quel
 * posto è `src/lib/presenze/orario.ts`.
 *
 * ─── IL DIFETTO, misurato in produzione il 2026-09-07 ─────────────────────────
 *
 * `presenze.orario_entrata` e `presenze.orario_uscita` sono colonne `text`, e ci
 * convivono TRE forme scritte da tre epoche del prodotto (1.244 righe non nulle):
 *   · 1.219  `2026-09-07T10:35:04.428Z`   ISO con fuso   — lo 0-6, `toISOString()`
 *   ·    19  `08:45`                      HH:MM nudo     — storico e seed E2E
 *   ·     6  `2026-09-04T09:40:00`        ISO NAÏVE      — la primaria
 *
 * A leggerle c'erano CINQUE copie di logica, e sbagliavano ognuna a modo suo:
 *   · `PresenzeTodayCard` faceva `.slice(0, 5)` → sull'ISO rendeva **`2026-`**, e
 *     sulla home del genitore usciva «Ingresso alle 2026-»: 450 righe d'appello su
 *     450, **490 famiglie**, tutti i giorni;
 *   · `oreAssenza` faceva `getHours()`, cioè l'ora LOCALE DEL PROCESSO (UTC su
 *     Vercel): l'ISO valeva due ore in meno e l'`HH:MM` valeva `null`, cioè 19
 *     ritardi contati ZERO;
 *   · altre tre copie di `getHours()` nei client, dove leggeva l'ora del
 *     DISPOSITIVO invece di quella della scuola.
 *
 * Nessun test era rosso, e uno non poteva esserlo: il fixture di
 * `oreAssenza.test.ts` costruiva l'ora col fuso del processo e `getHours()` la
 * rileggeva con lo stesso fuso — **il test usava l'assunzione sbagliata su tutti e
 * due i lati**, quindi passava ovunque senza saper distinguere il giusto dallo
 * sbagliato. È stato ancorato a `+02:00` e adesso, con `TZ=UTC`, vede il difetto.
 *
 * ─── COSA SORVEGLIA ───────────────────────────────────────────────────────────
 *  1. Fuori dal motore, in `src/`, nessuno ricava ore e minuti da un orario di
 *     presenza con `new Date`, `getHours()`, `.slice(0, 5)` o uno `split(':')`.
 *  2. Chi mostra o calcola un orario di presenza IMPORTA il motore.
 *  3. Il motore non reintroduce da sé il difetto che chiude: niente `getHours()`.
 *
 * NON verifica che la lettura sia GIUSTA: quello è
 * `__tests__/lib/orario-presenze.test.ts` (le quattro forme, i due giorni di
 * cambio ora, l'andata e ritorno) e
 * `__tests__/components/presenze-today-card-orario.test.tsx` (la frase che il
 * genitore legge davvero).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')
const MOTORE = path.join('src', 'lib', 'presenze', 'orario.ts')

/** Le due colonne di cui parla questo lock. Nient'altro. */
const COLONNE = ['orario_entrata', 'orario_uscita', 'orarioEntrata', 'orarioUscita']

function sorgenti(dir: string, acc: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) sorgenti(p, acc)
    else if (/\.tsx?$/.test(voce.name)) acc.push(p)
  }
  return acc
}

const FILE = sorgenti(RADICE).map((p) => ({
  rel: path.relative(process.cwd(), p),
  testo: fs.readFileSync(p, 'utf8'),
}))

/**
 * Le righe che manipolano un orario di presenza con le proprie mani.
 *
 * Il criterio è di PROSSIMITÀ e non di file: una funzione che si chiama `hhmm` è
 * innocente finché non la si applica a `orario_entrata`. Si guarda quindi ogni
 * riga che nomina una delle due colonne insieme a un'operazione di parsing, e la
 * riga della definizione della funzione quando il file la applica a quelle colonne.
 */
function righeColpevoli(rel: string, testo: string): string[] {
  if (rel === MOTORE) return []
  const nominaColonne = COLONNE.some((c) => testo.includes(c))
  if (!nominaColonne) return []
  const colpe: string[] = []
  testo.split('\n').forEach((riga, i) => {
    const parla = COLONNE.some((c) => riga.includes(c))
    if (!parla) return
    // `new Date(<qualcosa che è un orario>)`, `.getHours()`, `.slice(0, 5)`
    if (/new Date\s*\(/.test(riga) || /\.getHours\s*\(/.test(riga) || /\.slice\s*\(\s*0\s*,\s*5\s*\)/.test(riga)) {
      colpe.push(`${rel}:${i + 1}  ${riga.trim()}`)
    }
  })
  return colpe
}

describe('LOCK · un motore solo per l\'orario delle presenze', () => {
  it('nessun file di src/ ricava ore e minuti da un orario di presenza per conto suo', () => {
    const colpe = FILE.flatMap(({ rel, testo }) => righeColpevoli(rel, testo))
    expect(
      colpe,
      'Queste righe leggono un orario di presenza a mano. Le forme in colonna sono TRE ' +
        '(ISO con fuso, ISO naïve, HH:MM) e ognuna di queste tre strade ne sbaglia almeno ' +
        'una: `.slice(0,5)` rende «2026-», `getHours()` legge il fuso del processo. ' +
        'Usa `oraDiRoma` / `minutiDiRoma` / `aOrarioIso` da `@/lib/presenze/orario`.',
    ).toEqual([])
  })

  it('chi mostra o calcola un orario di presenza importa il motore', () => {
    // I file che DERIVANO un'ora da quelle colonne devono passare dal motore.
    // (Chi le trasporta soltanto — una `select`, un tipo, un body — non deve.)
    const derivano = FILE.filter(({ rel, testo }) => {
      if (rel === MOTORE) return false
      if (!COLONNE.some((c) => testo.includes(c))) return false
      return /oraDaTs|hhmm\s*\(|formatTime|minutiDaTimestamp/.test(testo)
    })
    const senzaMotore = derivano
      .filter(({ testo }) => !testo.includes("@/lib/presenze/orario"))
      .map(({ rel }) => rel)
    expect(
      senzaMotore,
      'Questi file derivano un\'ora da un orario di presenza senza importare il motore.',
    ).toEqual([])
  })

  it('il motore non reintroduce il difetto che chiude', () => {
    const motore = fs.readFileSync(path.join(process.cwd(), MOTORE), 'utf8')
    expect(motore.includes('.getHours(')).toBe(false)
    expect(motore.includes('.getMinutes(')).toBe(false)
    // Ogni `Intl.DateTimeFormat` qui dentro dichiara il proprio fuso (lock gemello
    // `date-con-timezone`), e lo dichiara come APP_TIMEZONE, non come letterale.
    expect(motore.includes('timeZone: APP_TIMEZONE')).toBe(true)
  })
})
