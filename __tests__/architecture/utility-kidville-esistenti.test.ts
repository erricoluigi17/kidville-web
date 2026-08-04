import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// =============================================================================
// LOCK — ogni utility `*-kidville-*` deve corrispondere a un token dichiarato.
//
// Il collaudo del 2026-08-03 (T08-F1) ha trovato SEI classi che non esistono, in
// dieci punti dell'interfaccia: `bg-kidville-success-soft0`, `bg-kidville-error-soft0`,
// `bg-kidville-info-soft0`, `bg-kidville-cream0`, `bg-kidville-warn-dark`,
// `text-kidville-warn-dark`. Non è «il colore sbagliato»: è NESSUN colore —
// pallini di stato trasparenti, barre di livello senza riempimento, un'intestazione
// senza fondo, due bottoni senza hover, e il banner della chat sospesa che perde
// l'inchiostro caldo assegnatogli apposta come rimedio d'accessibilità.
//
// Quattro delle sei sono il residuo di una sostituzione automatica andata storta:
// lo `0` finale è l'ultima cifra di un'opacità Tailwind (`/10`, `/20`) rimasta
// attaccata al nome del token quando la barra è stata tolta. Due punti d'uso lo
// dimostravano ancora: `bg-kidville-info-soft0/10` — l'opacità finita DUE volte
// nella stessa classe.
//
// ── PERCHÉ LA REGOLA È «il token deve esistere in @theme inline» ─────────────
// Non è un'assunzione: è stato MISURATO compilando davvero il foglio di stile con
// `@tailwindcss/postcss` (v4) su una sorgente che conteneva le quattro classi.
// Risultato: `.bg-kidville-success` e `.bg-kidville-success-strong` vengono
// generate, `success-soft0` compare ZERO volte nel CSS prodotto. Tailwind v4
// genera le utility DINAMICAMENTE dai token `--color-*` di `@theme`: se il token
// non c'è, la classe non viene creata e viene scartata **in silenzio**, senza
// warning, senza errore, con il gate verde. È esattamente il motivo per cui il
// difetto è sopravvissuto in produzione: nessun test misura il colore CALCOLATO.
//
// ── LA TRAPPOLA, misurata prima di scrivere questo file ─────────────────────
// La correzione del 2026-08-03 ha lasciato i nomi rotti CITATI TESTUALMENTE dentro
// i commenti che spiegano la correzione (`// bg-kidville-warn-dark non esisteva → …`).
// Senza azzerare i commenti questo lock nasce ROSSO su 5 falsi positivi:
//   teacher/locker/page.tsx · admin/ScrollableStudentForm.tsx (×2) ·
//   chat/ChatSuspensionBanner.tsx · teacher/locker/MonthlyLockerTable.tsx
// Azzerando i commenti restano 0 violazioni. Perciò il passo di azzeramento non è
// un'ottimizzazione: è parte della definizione della sonda, ed è verificato qui
// sotto da una sua asserzione dedicata.
// =============================================================================

const RADICE = process.cwd()

// ── 1. I token: `--color-kidville-<nome>` dichiarati nei blocchi `@theme` ─────
// Solo `@theme`: le ridichiarazioni dentro `[data-contrast="high"]` sono
// RIMAPPATURE di token esistenti, non nuovi nomi, e non generano utility.
export function tokenDaTheme(css: string): Set<string> {
  const fuori: string[] = []
  const re = /@theme\b[^{]*\{/g
  // Il valore del match non serve: interessa solo `re.lastIndex`, cioè dove si
  // apre la graffa del blocco `@theme` da cui parte la scansione qui sotto.
  while (re.exec(css) !== null) {
    let i = re.lastIndex
    let profondita = 1
    while (i < css.length && profondita > 0) {
      if (css[i] === '{') profondita++
      else if (css[i] === '}') profondita--
      i++
    }
    fuori.push(css.slice(re.lastIndex, i - 1))
  }
  const token = new Set<string>()
  for (const blocco of fuori) {
    for (const t of blocco.matchAll(/--color-kidville-([a-z0-9-]+)\s*:/g)) token.add(t[1])
  }
  return token
}

// ── 2. Azzeramento dei commenti, a lunghezza e righe INVARIATE ───────────────
// Sostituire con spazi (e non cancellare) tiene i numeri di riga veri: il
// messaggio d'errore deve puntare a `file:riga`, non a un offset inventato.
// `[^:]` davanti a `//` evita di mangiare `https://…`.
export function azzeraCommenti(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (intero, prima: string) => prima + ' '.repeat(intero.length - prima.length))
}

// I prefissi che in Tailwind prendono un colore. `border` accetta anche il lato
// (`border-t-kidville-…`): nel repo ci sono 59 usi, e senza il lato sfuggirebbero.
const PREFISSI =
  '(?:bg|text|border(?:-[trblxyse])?|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|caret|decoration|placeholder)'
// `(?<![\w-])` è il confine che tiene fuori `--color-kidville-green` e
// `var(--color-kidville-…)`: lì davanti a `color` c'è un trattino.
const CLASSE = new RegExp(`(?<![\\w-])${PREFISSI}-kidville-([a-z0-9]+(?:-[a-z0-9]+)*)`, 'g')

export type Violazione = { classe: string; token: string; riga: number }

/**
 * Trova le utility `*-kidville-*` di un sorgente il cui token NON è dichiarato.
 * Il suffisso d'opacità (`/10`, `/5`) non fa parte del nome del token e va tolto.
 */
export function classiSconosciute(sorgente: string, token: Set<string>): Violazione[] {
  const testo = azzeraCommenti(sorgente)
  const out: Violazione[] = []
  for (const m of testo.matchAll(CLASSE)) {
    const nome = m[1].replace(/\/.*$/, '')
    if (token.has(nome)) continue
    out.push({ classe: m[0], token: nome, riga: testo.slice(0, m.index).split('\n').length })
  }
  return out
}

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sorgenti(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('utility kidville — la classe esiste solo se il token esiste', () => {
  const TOKEN = tokenDaTheme(fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8'))

  // ── PROVA DI VALIDITÀ DELLA SONDA ────────────────────────────────────────
  // Le tre asserzioni qui sotto NON guardano il repo: guardano l'ESTRATTORE, su
  // sorgenti finti scritti a mano. Restano una prova anche il giorno in cui il
  // repo è pulito e l'asserzione sul repo passerebbe pure con una sonda cieca.
  describe('prova di validità — la sonda vede davvero', () => {
    const finti = new Set(['green', 'success', 'success-soft'])

    it('VEDE una classe inventata (e la riporta con la riga giusta)', () => {
      const finto = "const a = 1\nconst b = <div className=\"bg-kidville-success-soft0\" />\n"
      const trovate = classiSconosciute(finto, finti)
      expect(trovate).toHaveLength(1)
      expect(trovate[0]).toMatchObject({ classe: 'bg-kidville-success-soft0', token: 'success-soft0', riga: 2 })
    })

    it('NON segnala una classe valida, nemmeno con opacità o variante', () => {
      const finto = 'const a = "hover:bg-kidville-green md:text-kidville-success-soft/30 border-t-kidville-green"\n'
      expect(classiSconosciute(finto, finti)).toEqual([])
    })

    it('NON segnala una classe rotta CITATA DENTRO UN COMMENTO (la trappola di T08-F1)', () => {
      const dentroRiga = '// `bg-kidville-warn-dark` non esisteva: hover inerte\n'
      const dentroBlocco = '/* residuo: bg-kidville-cream0 */\nconst x = 1\n'
      expect(classiSconosciute(dentroRiga, finti)).toEqual([])
      expect(classiSconosciute(dentroBlocco, finti)).toEqual([])
      // …e il commento non sposta i numeri di riga di ciò che viene dopo.
      expect(classiSconosciute(dentroBlocco + 'const y = "bg-kidville-nope"\n', finti)[0].riga).toBe(3)
    })
  })

  it('i token si leggono da @theme inline e sono quelli veri', () => {
    // Controllo POSITIVO della sonda sul CSS: se l'estrattore tornasse un insieme
    // vuoto, l'asserzione sul repo passerebbe… solo perché non guarda niente.
    expect(TOKEN.size).toBeGreaterThanOrEqual(20)
    expect(TOKEN.has('green')).toBe(true)
    expect(TOKEN.has('success-strong')).toBe(true)
    // Le sei classi del collaudo NON sono token, e non devono diventarlo per
    // «far passare il lock»: la correzione è nel punto d'uso, non nella palette.
    for (const inventato of ['success-soft0', 'error-soft0', 'info-soft0', 'cream0', 'warn-dark']) {
      expect(TOKEN.has(inventato)).toBe(false)
    }
  })

  it('nessuna utility kidville punta a un token inesistente in src/', () => {
    const violazioni: string[] = []
    for (const file of sorgenti(path.join(RADICE, 'src'))) {
      for (const v of classiSconosciute(fs.readFileSync(file, 'utf8'), TOKEN)) {
        violazioni.push(`${path.relative(RADICE, file)}:${v.riga} -> ${v.classe}`)
      }
    }
    expect(
      violazioni,
      `Classi Kidville senza token in @theme inline (Tailwind le scarta in silenzio: ` +
        `l'elemento resta SENZA colore).\n` +
        `Correggere il punto d'uso — non aggiungere il token alla palette.\n` +
        violazioni.join('\n'),
    ).toEqual([])
  })
})
