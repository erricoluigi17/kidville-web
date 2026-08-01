/**
 * Lettura del SORGENTE per i lock di forma (`__tests__/architecture/*`).
 *
 * I lock di forma non provano un comportamento: vietano una FORMA di codice che
 * ha già prodotto un guasto. Per farlo devono leggere il sorgente, e leggerlo
 * con una `grep` per riga porta due errori opposti:
 *
 *  - falsi positivi: un `.eq('scuola_id', …)` dentro un COMMENTO che spiega il
 *    bug appena corretto verrebbe scambiato per il bug stesso (nel repo ce ne
 *    sono a decine, scritti apposta);
 *  - falsi negativi: una catena `.from(…).select(…).eq(…)` spezzata su otto
 *    righe, con commenti in mezzo, non sta su «una riga» e sfugge a ogni grep.
 *
 * Da qui queste due utilità: una MASCHERA (che spegne commenti e stringhe senza
 * spostare un solo carattere, così gli indici restano quelli veri) e un
 * ritagliatore di CATENE di metodi, che è l'unità con cui PostgREST costruisce
 * una query — «lo stesso blocco di query» di cui parlano i lock.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SorgenteMascherato {
  /** Il testo originale, invariato. */
  originale: string
  /**
   * Commenti sostituiti da spazi; le STRINGHE restano leggibili.
   * È il testo su cui si cercano i contenuti (`'scuola_id'`, `'classe_sezione'`),
   * senza rischiare di trovarli in un commento.
   */
  senzaCommenti: string
  /**
   * Commenti sostituiti da spazi E contenuto di stringhe/template/regex
   * sostituito da `x` (i delimitatori restano). È il testo su cui si fa
   * l'analisi STRUTTURALE: parentesi, `if`, `else`, `?`, `:` — nessuna
   * parentesi dentro una stringa può più sbilanciare il conteggio.
   * Il codice dentro `${…}` di un template resta codice: lì le query ci sono
   * davvero (`.or(\`scuola_id.in.(${plessi.join(',')})\`)`).
   */
  struttura: string
}

/** Un `/` inizia una regex solo dopo questi caratteri (euristica standard). */
const PRIMA_DI_REGEX = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
])

export function mascheraSorgente(src: string): SorgenteMascherato {
  // `split('')` e NON `Array.from(src)`: `Array.from` spezza la stringa per CODE
  // POINT, il resto di questa funzione la indicizza per UNITÀ UTF-16 (`src[i]`,
  // `src.indexOf`). Su un file con un'emoji le due numerazioni divergono, e
  // mascherare una coppia di surrogati con un solo `x` accorciava il risultato:
  // `struttura` tornava PIÙ CORTA del sorgente, e ogni indice successivo era
  // spostato.
  //
  // Non è teoria: misurato il 2026-08-01 su `TaskCard.tsx` (85 653 caratteri,
  // due «👤» dentro una stringa) — `struttura.length` era 85 652. Da lì in poi
  // ogni `senzaCommenti.slice(indiceDaStruttura, …)` leggeva una finestra
  // spostata di un carattere e ogni `riga()` poteva nominare la riga sbagliata.
  // Sei lock si appoggiano a questa funzione, fra cui `isolamento-sede-coverage`
  // e `scope-vuoto-nega`: un ritaglio spostato lì è un FALSO VERDE su una
  // query di isolamento fra sedi.
  const senza = src.split('')
  const strut = src.split('')
  const n = src.length
  // Pila dei template literal aperti. Il valore è la profondità di graffe dentro
  // `${…}`: 0 = siamo nel testo del template, >0 = siamo dentro un'espressione.
  const template: number[] = []
  let i = 0
  let ultimo = ''

  const bianca = (da: number, a: number) => {
    for (let k = da; k < a && k < n; k++) {
      if (src[k] === '\n') continue
      strut[k] = ' '
      senza[k] = ' '
    }
  }
  const xxx = (da: number, a: number) => {
    for (let k = da; k < a && k < n; k++) if (src[k] !== '\n') strut[k] = 'x'
  }

  while (i < n) {
    // ── dentro il TESTO di un template literal ────────────────────────────────
    if (template.length > 0 && template[template.length - 1] === 0) {
      const c = src[i]
      if (c === '\\') { xxx(i, i + 2); i += 2; continue }
      if (c === '`') { template.pop(); ultimo = '`'; i++; continue }
      if (c === '$' && src[i + 1] === '{') { template[template.length - 1] = 1; i += 2; continue }
      xxx(i, i + 1); i++
      continue
    }

    // ── modalità codice ───────────────────────────────────────────────────────
    const c = src[i]
    const c2 = src[i + 1]

    if (c === '/' && c2 === '/') {
      let j = src.indexOf('\n', i)
      if (j < 0) j = n
      bianca(i, j)
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      const fine = src.indexOf('*/', i + 2)
      const j = fine < 0 ? n : fine + 2
      bianca(i, j)
      i = j
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        j++
      }
      xxx(i + 1, j)
      ultimo = c
      i = Math.min(j + 1, n)
      continue
    }
    if (c === '`') {
      template.push(0)
      i++
      continue
    }
    if (c === '/' && PRIMA_DI_REGEX.has(ultimo)) {
      // Una regex non può andare a capo: se il `/` di chiusura non è sulla
      // stessa riga, era una divisione e non si maschera nulla.
      let j = i + 1
      let chiusa = -1
      let inClasse = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '[') inClasse = true
        else if (src[j] === ']') inClasse = false
        else if (src[j] === '/' && !inClasse) { chiusa = j; break }
        j++
      }
      if (chiusa > 0) {
        xxx(i + 1, chiusa)
        ultimo = '/'
        i = chiusa + 1
        continue
      }
    }
    if (template.length > 0) {
      if (c === '{') template[template.length - 1]++
      else if (c === '}') {
        template[template.length - 1]--
        // Tornati a 0 si rientra nel testo del template (il `}` chiude `${`).
        if (template[template.length - 1] < 0) template[template.length - 1] = 0
      }
    }
    if (!/\s/.test(c)) ultimo = c
    i++
  }

  return { originale: src, senzaCommenti: senza.join(''), struttura: strut.join('') }
}

/**
 * Indice DOPO la parentesi che chiude quella aperta in `apertura`.
 * Va usato sul testo `struttura`: lì nessuna parentesi vive dentro una stringa.
 */
export function fineParentesi(strut: string, apertura: number): number {
  let livello = 0
  for (let k = apertura; k < strut.length; k++) {
    if (strut[k] === '(') livello++
    else if (strut[k] === ')') {
      livello--
      if (livello === 0) return k + 1
    }
  }
  return strut.length
}

/**
 * Fine (esclusa) della catena di chiamate che comincia in `da` — indice del `.`
 * di `.metodo(`. Attraversa a capo e commenti già spenti:
 * `.from('alunni')\n  .select('id')\n  .in('scuola_id', plessi)` è UNA catena.
 * Si ferma al primo accesso che non è una chiamata (`.data`, `.length`).
 */
export function fineCatena(strut: string, da: number): number {
  let i = da
  for (;;) {
    if (strut[i] !== '.') return i
    let j = i + 1
    while (j < strut.length && /\s/.test(strut[j])) j++
    const inizioId = j
    while (j < strut.length && /[A-Za-z0-9_$]/.test(strut[j])) j++
    if (j === inizioId) return i
    while (j < strut.length && /\s/.test(strut[j])) j++
    if (strut[j] !== '(') return i
    j = fineParentesi(strut, j)
    while (j < strut.length && /\s/.test(strut[j])) j++
    i = j
  }
}

/** Tutti i file `.ts`/`.tsx` sotto `dir` (ricorsivo). */
export function fileSorgente(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...fileSorgente(full))
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Numero di riga (1-based) dell'indice `idx`. */
export function riga(src: string, idx: number): number {
  let n = 1
  for (let k = 0; k < idx && k < src.length; k++) if (src[k] === '\n') n++
  return n
}
