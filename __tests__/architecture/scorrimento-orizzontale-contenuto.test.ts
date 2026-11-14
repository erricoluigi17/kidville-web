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
 * `overflow-x-auto` / `overflow-x-scroll` / `overflow-auto` / `overflow-scroll` che avvolge una
 * `<table>`, un `sr-only` o un `absolute` deve avere una `position` non statica (`relative`,
 * `absolute`, `sticky`, `fixed` si equivalgono: tutte fanno da blocco di contenimento).
 *
 * ⚠️ LIMITI DICHIARATI
 *  - vede solo ciò che sta DENTRO lo stesso componente: una riga disegnata da un sotto-componente
 *    (come `RigaConferma`) non si vede da qui, ed è per questo che si impone la posizione a OGNI
 *    contenitore che avvolge una tabella, anche se il difetto non c'è ancora;
 *  - il caso `TABLE_WRAP` (`kv-table-scroll`) lo copre la regola CSS, verificata sotto;
 *  - un `className` che NON è un letterale (`cn(…)`, una variabile) non si può leggere: il lock
 *    FALLISCE, a meno che il contenitore non stia in `ECCEZIONI`, con il motivo. Tienilo corto.
 */

/**
 * `file` → perché un className non letterale è accettabile (la chiave è il FILE, non la riga: le righe
 * scorrono). Tienilo corto: ogni voce è un punto in cui il lock non vede.
 */
const ECCEZIONI: Record<string, string> = {
  'src/components/ui/BarraFiltri.tsx':
    'striscia di pastiglie a scorrimento (cx(…) con `compatta`): dentro ci sono solo campi di filtro resi da `controllo()`, nessuna tabella e nessun sr-only/absolute proprio; le pastiglie sono in flusso',
}

const RADICE = join(process.cwd(), 'src')

function fileTsx(dir: string, out: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) fileTsx(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const OVERFLOW = /(?<![\w-])overflow-(x-)?(auto|scroll)(?![\w-])/
const POSIZIONATO = /(?<![\w-])(relative|absolute|sticky|fixed)(?![\w-])/
const DA_CONTENERE = /<table\b|(?<![\w-])(sr-only|absolute)(?![\w-])/

/**
 * Il tag di apertura che comincia a `da` (`<div …>`), fino al `>` che lo chiude: salta le graffe
 * (un `=>` dentro `onClick={() => …}` NON chiude il tag) e le stringhe.
 */
function tagApertura(s: string, da: number): string {
  let graffe = 0
  let virgolette: string | null = null
  for (let i = da; i < s.length; i++) {
    const c = s[i]
    if (virgolette) {
      if (c === virgolette && s[i - 1] !== '\\') virgolette = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') virgolette = c
    else if (c === '{') graffe++
    else if (c === '}') graffe--
    else if (c === '>' && graffe === 0) return s.slice(da, i + 1)
  }
  return s.slice(da)
}

/** Il className del tag: `testo` se è un letterale (stringa o template, parti statiche), altrimenti `null`. */
function classNameLetterale(tag: string): { presente: boolean; letterale: string | null } {
  const i = tag.indexOf('className=')
  if (i < 0) return { presente: false, letterale: '' }
  const resto = tag.slice(i + 'className='.length)
  const stringa = resto.match(/^"([^"]*)"/) ?? resto.match(/^\{\s*(?:"([^"]*)"|'([^']*)')\s*\}/)
  if (stringa) return { presente: true, letterale: stringa[1] ?? stringa[2] ?? '' }
  const template = resto.match(/^\{\s*`([^`]*)`\s*\}/)
  if (template) return { presente: true, letterale: template[1].replace(/\$\{[^}]*\}/g, ' ') }
  return { presente: true, letterale: null }
}

/** Il testo del `<div>` che comincia a `da`, fino al suo `</div>`. */
function spanDiv(s: string, da: number): string {
  let profondita = 0
  for (const t of s.slice(da).matchAll(/<div\b|<\/div>/g)) {
    profondita += t[0] === '</div>' ? -1 : 1
    if (profondita === 0) return s.slice(da, da + t.index! + t[0].length)
  }
  return s.slice(da)
}

interface Contenitore {
  riga: number
  posizionato: boolean
  conDaContenere: boolean
  nonLetterale: boolean
}

/** Tutti i `<div>` a scorrimento orizzontale di un sorgente. */
function analizza(s: string): Contenitore[] {
  const out: Contenitore[] = []
  for (const m of s.matchAll(/<div\b/g)) {
    const tag = tagApertura(s, m.index!)
    const { presente, letterale } = classNameLetterale(tag)
    if (!presente) continue
    const riga = s.slice(0, m.index!).split('\n').length
    if (letterale === null) {
      // Non si può leggere: conta come contenitore a scorrimento solo se il suo testo nomina l'overflow.
      if (OVERFLOW.test(tag)) out.push({ riga, posizionato: false, conDaContenere: false, nonLetterale: true })
      continue
    }
    if (!OVERFLOW.test(letterale)) continue
    const dentro = spanDiv(s, m.index!).slice(tag.length)
    out.push({
      riga,
      posizionato: POSIZIONATO.test(letterale),
      conDaContenere: DA_CONTENERE.test(dentro),
      nonLetterale: false,
    })
  }
  return out
}

describe('analizza(): vede ciò che il lock deve vedere', () => {
  it('non si ferma sul `=>` di un onClick messo prima del className', () => {
    const r = analizza('<div onClick={() => x()} className="overflow-x-auto"><table></table></div>')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ posizionato: false, conDaContenere: true })
  })

  it('vede overflow-x-scroll e overflow-scroll', () => {
    expect(analizza('<div className="overflow-x-scroll"><span className="sr-only" /></div>')).toHaveLength(1)
    expect(analizza('<div className="overflow-scroll"><span className="sr-only" /></div>')).toHaveLength(1)
  })

  it('accetta relative, absolute, sticky e fixed come equivalenti', () => {
    for (const p of ['relative', 'absolute', 'sticky', 'fixed']) {
      const r = analizza(`<div className="${p} overflow-x-auto"><table></table></div>`)
      expect(r[0].posizionato, p).toBe(true)
    }
    expect(analizza('<div className="overflow-x-auto"><table></table></div>')[0].posizionato).toBe(false)
  })

  it('un className non letterale su un div a scorrimento è segnalato', () => {
    expect(analizza("<div className={cn('overflow-x-auto', altro)}><table></table></div>")[0].nonLetterale).toBe(true)
    expect(analizza('<div className={classi}><table></table></div>')).toHaveLength(0)
  })

  it('un template letterale si legge sulle sue parti statiche', () => {
    const r = analizza('<div className={`relative overflow-x-auto ${x ? "a" : "b"}`}><table></table></div>')
    expect(r[0]).toMatchObject({ posizionato: true, nonLetterale: false, conDaContenere: true })
  })
})

describe('scorrimento orizzontale: il contenitore è il blocco di contenimento', () => {
  const tutti = fileTsx(RADICE).flatMap((file) => {
    const nome = file.slice(process.cwd().length + 1)
    return analizza(readFileSync(file, 'utf8')).map((c) => ({ ...c, nome, id: `${nome}:${c.riga}` }))
  })
  const daVerificare = tutti.filter((c) => c.conDaContenere)

  it('ha esaminato i contenitori che ci sono (il lock non è cieco)', () => {
    // 31 contenitori `overflow-x-auto` il 2026-11-13, 17 dei quali avvolgono tabelle, `sr-only` o
    // assoluti. Soglie sotto i valori misurati: se una scansione li trova meno, ha smesso di vedere.
    expect(tutti.length).toBeGreaterThanOrEqual(25)
    expect(daVerificare.length).toBeGreaterThanOrEqual(14)
  })

  it('ogni contenitore che avvolge una tabella, un sr-only o un assoluto è posizionato', () => {
    const senza = daVerificare.filter((c) => !c.posizionato).map((c) => c.id)
    expect(senza, 'aggiungi `relative` al <div> con overflow-x-auto').toEqual([])
  })

  it('nessun <div> a scorrimento ha un className che il lock non può leggere (salvo eccezione motivata)', () => {
    const illeggibili = tutti.filter((c) => c.nonLetterale && !(c.nome in ECCEZIONI)).map((c) => c.id)
    expect(
      illeggibili,
      'className non letterale (cn(…), variabile): scrivilo come letterale, oppure aggiungi il contenitore a ECCEZIONI con il motivo',
    ).toEqual([])
    for (const [file, motivo] of Object.entries(ECCEZIONI)) {
      expect(motivo.length, `motivo di ${file}`).toBeGreaterThan(10)
      expect(tutti.some((c) => c.nome === file && c.nonLetterale), `${file} ha ancora un className illeggibile`).toBe(true)
    }
  })

  it('la regola CSS di TABLE_WRAP (`.kv-table-scroll`) dichiara position: relative', () => {
    const css = readFileSync(join(RADICE, 'app', 'globals.css'), 'utf8')
    const blocco = css.match(/\n\.kv-table-scroll \{([^}]*)\}/)
    expect(blocco, 'la regola .kv-table-scroll esiste').not.toBeNull()
    expect(blocco![1]).toMatch(/position:\s*relative/)
  })
})
