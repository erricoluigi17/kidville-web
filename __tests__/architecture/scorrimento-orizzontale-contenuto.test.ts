import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UN CONTENITORE A SCORRIMENTO ORIZZONTALE È ANCHE UN BLOCCO DI CONTENIMENTO.
 *
 * Il 2026-11-13 l'agente 1 ha misurato in produzione che `/admin/students/conferme` scorre di lato a
 * 390 px: `documentElement.scrollWidth` 416 su `innerWidth` 390, e dopo `scrollTo(100,0)` lo
 * `scrollX` era 26. Ogni riga della tabella (`min-w-[720px]`) ha un `<label class="sr-only">` e
 * `sr-only` è `position: absolute`: un figlio assoluto è tagliato dall'`overflow` di un antenato
 * SOLO se quell'antenato è il suo blocco di contenimento, cioè ha una `position` diversa da
 * `static`. Il wrapper `overflow-x-auto` non l'aveva: l'assoluto sfuggiva al taglio e allargava la
 * PAGINA di 26 px.
 *
 * Il lock guarda il sorgente (in jsdom la larghezza non si misura): ogni `<div>` con
 * `overflow-x-auto` / `overflow-auto` che avvolge una `<table>`, un `sr-only` o un `absolute` deve
 * dichiarare `relative`. ⚠️ Vede solo ciò che sta DENTRO lo stesso componente: una riga disegnata da
 * un sotto-componente (come `RigaConferma`) non si vede da qui, ed è per questo che si impone
 * `relative` a OGNI contenitore che avvolge una tabella, anche se il difetto non c'è ancora.
 * Il caso `TABLE_WRAP` (`kv-table-scroll`) lo copre la regola CSS, verificata qui sotto.
 */

const RADICE = join(process.cwd(), 'src')

function fileTsx(dir: string, out: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) fileTsx(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const APRE_DIV = /<div\b[^>]*?className=(?:"|\{`)([^"`]*)/g
const A_SCORRIMENTO = /(?<![\w-])overflow-(x-)?auto(?![\w-])/
const RELATIVE = /(?<![\w-])relative(?![\w-])/
const DA_CONTENERE = /<table\b|(?<![\w-])(sr-only|absolute)(?![\w-])/

/** Il testo del `<div>` che comincia a `da`, fino al suo `</div>`. */
function spanDiv(s: string, da: number): string {
  let profondita = 0
  for (const t of s.slice(da).matchAll(/<div\b|<\/div>/g)) {
    profondita += t[0] === '</div>' ? -1 : 1
    if (profondita === 0) return s.slice(da, da + t.index! + t[0].length)
  }
  return s.slice(da)
}

function contenitori() {
  const esaminati: { file: string; riga: number; relative: boolean; conDaContenere: boolean }[] = []
  for (const file of fileTsx(RADICE)) {
    const s = readFileSync(file, 'utf8')
    for (const m of s.matchAll(APRE_DIV)) {
      if (!A_SCORRIMENTO.test(m[1])) continue
      const span = spanDiv(s, m.index!)
      const dentro = span.slice(m[0].length)
      esaminati.push({
        file: file.slice(process.cwd().length + 1),
        riga: s.slice(0, m.index!).split('\n').length,
        relative: RELATIVE.test(m[1]),
        conDaContenere: DA_CONTENERE.test(dentro),
      })
    }
  }
  return esaminati
}

describe('scorrimento orizzontale: il contenitore è il blocco di contenimento', () => {
  const tutti = contenitori()
  const daVerificare = tutti.filter((c) => c.conDaContenere)

  it('ha esaminato i contenitori che ci sono (il lock non è cieco)', () => {
    // 31 contenitori `overflow-x-auto` il 2026-11-13, 17 dei quali avvolgono tabelle, `sr-only` o
    // assoluti. Soglie sotto i valori misurati: se una scansione li trova meno, ha smesso di vedere.
    expect(tutti.length).toBeGreaterThanOrEqual(25)
    expect(daVerificare.length).toBeGreaterThanOrEqual(14)
  })

  it('ogni contenitore che avvolge una tabella, un sr-only o un assoluto dichiara `relative`', () => {
    const senza = daVerificare.filter((c) => !c.relative).map((c) => `${c.file}:${c.riga}`)
    expect(senza, 'aggiungi `relative` al <div> con overflow-x-auto').toEqual([])
  })

  it('la regola CSS di TABLE_WRAP (`.kv-table-scroll`) dichiara position: relative', () => {
    const css = readFileSync(join(RADICE, 'app', 'globals.css'), 'utf8')
    const blocco = css.match(/\n\.kv-table-scroll \{([^}]*)\}/)
    expect(blocco, 'la regola .kv-table-scroll esiste').not.toBeNull()
    expect(blocco![1]).toMatch(/position:\s*relative/)
  })
})
