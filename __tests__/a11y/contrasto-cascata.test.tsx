import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, cleanup } from '@testing-library/react'
import { btnClass, type BtnVariant, type BtnSize } from '@/components/ui/Btn'

// =============================================================================
// S18 — il contrasto si misura sulla CASCATA, non sulla singola classe.
//
// Il collaudo del 2026-08-01 ha trovato un BLOCCANTE che nessun test del repo
// poteva vedere: attivando l'Alto Contrasto — cioè l'aiuto per chi fatica a
// leggere — il bottone d'azione della card-header diventava TESTO BIANCO SU
// FONDO GIALLO (1,28:1). Nessuna riga di CSS diceva «bianco su giallo»: lo
// diceva la CASCATA di DUE regole ciascuna sensata da sola.
//
//   [data-contrast="high"] .kv-tab-giallo .bg-kidville-yellow  → fondo #FFE500, testo #000
//   [data-contrast="high"] .kv-tab-giallo .text-kidville-green → testo #FFFFFF
//
// Stessa specificità (0,3,0), la seconda più in basso nel file → su un elemento
// che porta ENTRAMBE le classi (ed è esattamente `<Btn variant="secondary">`:
// `bg-kidville-yellow text-kidville-green`) vince il bianco, sul giallo appena
// imposto dalla prima. Il blocco «tab gialla» in luce normale l'invariante
// ce l'ha scritta nei commenti («va tenuto DOPO il remap dei testi»); il blocco
// Alto Contrasto, aggiunto dopo, non l'ha rispettata.
//
// Un lock che guarda le classi del sorgente (`toContain('text-kidville-…')`)
// non poteva accorgersene: le classi erano giuste. Serviva RISOLVERE la
// cascata. È quello che fa questo file: costruisce il DOM vero in jsdom,
// chiede a `Element.matches()` — il matcher CSS reale di jsdom — quali regole
// di `globals.css` colpiscono l'elemento, le ordina per livello/specificità/
// posizione come fa un browser, risolve le `var()` sul set di token giusto
// (base o Alto Contrasto) e MISURA il rapporto WCAG fra testo e fondo.
//
// Ogni asserzione negativa ha il suo CONTROLLO POSITIVO, e il difetto storico
// è rimesso dentro il test (§1.3): togliendo dal CSS le regole nuove la sonda
// deve tornare a misurare 1,28:1. Senza quella prova, «≥ 4,5:1» direbbe solo
// che la sonda non ha trovato niente.
// =============================================================================

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8')
const CSS_LOGIN = fs.readFileSync(
  path.join(RADICE, 'src', 'app', 'auth', 'login', 'page.module.css'),
  'utf8',
)

// ── WCAG 2.x §1.4.3 — rapporto di contrasto ─────────────────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const luminanza = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}
/** Un colore con alfa, COMPOSTO sul suo fondo: è ciò che l'occhio vede davvero. */
const composita = (fg: string, bg: string, alfa: number) => {
  const canali = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
  const [a, b] = [canali(fg), canali(bg)]
  return `#${[0, 1, 2]
    .map((i) => Math.round(a[i] * alfa + b[i] * (1 - alfa)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

// ── Parser CSS: regole ordinate, con il contesto delle at-rule ──────────────
type Dich = { prop: string; val: string }
type Regola = { sel: string; dich: Dich[]; contesto: string[]; ordine: number; layer: boolean }

function dichiarazioni(corpo: string): Dich[] {
  return corpo
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s) => ({
      prop: s.slice(0, s.indexOf(':')).trim().toLowerCase(),
      val: s.slice(s.indexOf(':') + 1).trim(),
    }))
    .filter((d) => d.prop.length > 0)
}

export function parseRegole(css: string): Regola[] {
  const testo = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Regola[] = []
  let ordine = 0
  const scendi = (src: string, contesto: string[]) => {
    let buf = ''
    let i = 0
    while (i < src.length) {
      const c = src[i]
      if (c === '{') {
        let liv = 1
        let k = i + 1
        while (k < src.length && liv > 0) {
          if (src[k] === '{') liv++
          else if (src[k] === '}') liv--
          k++
        }
        const sel = buf.trim().replace(/\s+/g, ' ')
        const corpo = src.slice(i + 1, k - 1)
        if (corpo.includes('{')) scendi(corpo, [...contesto, sel])
        else {
          const dich = dichiarazioni(corpo)
          const pos = ordine++
          for (const uno of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
            out.push({ sel: uno, dich, contesto, ordine: pos, layer: false })
          }
        }
        buf = ''
        i = k
        continue
      }
      if (c === '}' || c === ';') {
        buf = ''
        i++
        continue
      }
      buf += c
      i++
    }
  }
  scendi(testo, [])
  return out
}

/** Specificità CSS (a,b,c) — id / classi+attributi+pseudo-classi / elementi. */
export function specificita(sel: string): [number, number, number] {
  const s = sel.replace(/\\./g, 'µ') // gli escape (`.text-white\/70`) non sono combinatori
  const id = (s.match(/#[-\wµ]+/g) ?? []).length
  const cls = (s.match(/\.[-\wµ]+/g) ?? []).length
  const attr = (s.match(/\[[^\]]*\]/g) ?? []).length
  const pcl = (s.match(/(?<![:\w])::?[-\w]+/g) ?? []).filter((p) => !p.startsWith('::')).length
  const pel = (s.match(/::[-\w]+/g) ?? []).length
  const elementi = (
    s
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[.#]{1}[-\wµ]+/g, ' ')
      .replace(/::?[-\w]+(\([^)]*\))?/g, ' ')
      .match(/[a-zA-Z][-\w]*/g) ?? []
  ).length
  return [id, cls + attr + pcl, elementi + pel]
}

/** I token `--color-kidville-*` dichiarati in un blocco di `globals.css`. */
function token(selettore: string, regole: Regola[]): Record<string, string> {
  const blocco = regole.filter((r) => r.sel === selettore)
  expect(blocco.length, `blocco «${selettore}» presente in globals.css`).toBeGreaterThan(0)
  const out: Record<string, string> = {}
  for (const d of blocco.flatMap((r) => r.dich)) {
    const m = d.prop.match(/^--color-kidville-([a-z0-9-]+)$/)
    const h = d.val.match(/^#[0-9A-Fa-f]{6}$/)
    if (m && h) out[m[1]] = h[0].toUpperCase()
  }
  return out
}

const REGOLE_CSS = parseRegole(CSS)
const T = token('@theme inline', REGOLE_CSS)
const T_HC = token('[data-contrast="high"]', REGOLE_CSS)

/**
 * Le utility Tailwind dei token, come le emette davvero il compilatore: con
 * `@theme inline` l'hex è INLINATO nella classe (verificato sul CSS costruito:
 * `.text-kidville-yellow{color:#fdc400}`), NON è un `var()`. È la ragione per
 * cui il rimappaggio dei token in Alto Contrasto non le tocca, e per cui ogni
 * superficie in HC ha bisogno della sua regola esplicita. Vivono in
 * `@layer utilities` → perdono contro qualunque regola non-layered di
 * `globals.css`, a prescindere dalla specificità.
 */
function utilityTailwind(): Regola[] {
  const out: Regola[] = []
  let o = 0
  for (const [nome, hex] of Object.entries(T)) {
    out.push({ sel: `.text-kidville-${nome}`, dich: [{ prop: 'color', val: hex }], contesto: [], ordine: o++, layer: true })
    out.push({ sel: `.bg-kidville-${nome}`, dich: [{ prop: 'background-color', val: hex }], contesto: [], ordine: o++, layer: true })
    // Il BORDO serve a §7: senza, «il contorno sparisce» si misurerebbe come
    // «nessuna regola trovata» invece che come 1,23:1 — che è il difetto vero.
    out.push({ sel: `.border-kidville-${nome}`, dich: [{ prop: 'border-color', val: hex }], contesto: [], ordine: o++, layer: true })
  }
  out.push({ sel: '.text-white', dich: [{ prop: 'color', val: '#FFFFFF' }], contesto: [], ordine: o++, layer: true })
  out.push({ sel: '.bg-white', dich: [{ prop: 'background-color', val: '#FFFFFF' }], contesto: [], ordine: o++, layer: true })
  return out
}

const REGOLE = [...utilityTailwind(), ...REGOLE_CSS]

function coloreDaShorthand(val: string): string | null {
  if (/gradient|url\(/i.test(val)) return null
  const m = val.match(/#[0-9A-Fa-f]{3,6}\b|var\(\s*--[-\w]+\s*\)|transparent/i)
  return m ? m[0] : null
}

/**
 * Le proprietà che la sonda sa risolvere. `border-color` e `outline-color`
 * servono a S18 §7 e §9: il CONTORNO di un campo e l'ANELLO di focus sono
 * «informazione visiva necessaria a identificare un controllo» (WCAG 1.4.11),
 * e come il colore del testo nascono da una cascata, non da una singola classe.
 */
type Prop = 'color' | 'background-color' | 'border-color' | 'outline-color'

/** Le shorthand che portano dentro di sé il colore della loro proprietà lunga. */
const SHORTHAND: Record<Prop, string | null> = {
  'color': null,
  'background-color': 'background',
  'border-color': 'border',
  'outline-color': 'outline',
}

function valoreProp(r: Regola, prop: Prop): string | null {
  let v: string | null = null
  const corta = SHORTHAND[prop]
  for (const d of r.dich) {
    if (d.prop === prop) v = d.val
    else if (corta && d.prop === corta) {
      const c = coloreDaShorthand(d.val)
      if (c) v = c
    }
  }
  return v
}

/** Confronto lessicografico dei pesi di cascata: `a` batte `b`? */
function batte(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** La dichiarazione che VINCE su `el` per `prop`: livello → specificità → ordine. */
function vince(el: Element, prop: Prop, regole: Regola[]): string | null {
  let miglioreVal: string | null = null
  let migliore: number[] | null = null
  for (const r of regole) {
    if (r.contesto.length > 0) continue // nessuna at-rule dichiara colore: §0 lo verifica
    const v = valoreProp(r, prop)
    if (v === null) continue
    let ok = false
    try {
      ok = el.matches(r.sel)
    } catch {
      ok = false // selettori non-CSS (`@theme inline`) → non colpiscono nulla
    }
    if (!ok) continue
    const [a, b, c] = specificita(r.sel)
    const peso = [r.layer ? 0 : 1, a, b, c, r.ordine]
    if (migliore === null || batte(peso, migliore)) {
      migliore = peso
      miglioreVal = v
    }
  }
  return miglioreVal
}

function risolviVar(v: string, hc: boolean): string | null {
  const m = v.match(/var\(\s*(--color-kidville-[a-z0-9-]+)\s*\)/)
  if (m) {
    const nome = m[1].replace('--color-kidville-', '')
    const val = (hc ? T_HC[nome] : undefined) ?? T[nome]
    return val ?? null
  }
  const h = v.match(/#[0-9A-Fa-f]{6}\b/) ?? v.match(/#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])\b/)
  if (!h) return null
  if (h[0].length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`.toUpperCase()
  return h[0].toUpperCase()
}

function coloreTesto(el: Element, hc: boolean, regole = REGOLE): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = vince(n, 'color', regole)
    if (v) {
      const c = risolviVar(v, hc)
      if (c) return c
    }
  }
  return hc ? '#FFFFFF' : T.green
}

function sfondo(el: Element, hc: boolean, regole = REGOLE): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = vince(n, 'background-color', regole)
    if (v) {
      const c = risolviVar(v, hc)
      if (c) return c
    }
  }
  return hc ? '#000000' : T.cream
}

/** Monta l'albero in jsdom e restituisce l'elemento `#sonda`. */
function monta(html: string, hc: boolean): Element {
  document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal')
  document.body.innerHTML = html
  const el = document.getElementById('sonda')
  expect(el, 'elemento #sonda montato').toBeTruthy()
  return el!
}

/** Misura testo/fondo effettivi di un elemento GIÀ montato. */
function misuraEl(el: Element, hc: boolean, regole = REGOLE) {
  const fg = coloreTesto(el, hc, regole)
  const bg = sfondo(el, hc, regole)
  return { fg, bg, rapporto: contrasto(fg, bg) }
}

/** Misura testo/fondo effettivi di `#sonda` e ne restituisce il rapporto. */
function misura(html: string, hc: boolean, regole = REGOLE) {
  return misuraEl(monta(html, hc), hc, regole)
}

afterEach(() => {
  document.documentElement.removeAttribute('data-contrast')
  document.body.innerHTML = ''
  cleanup()
})

// =============================================================================
describe('S18 §0 · la sonda — prima di misurare, si dimostra che misura', () => {
  it('la specificità è quella del CSS, non una stima', () => {
    expect(specificita('.kv-tab-giallo .bg-kidville-yellow')).toEqual([0, 2, 0])
    expect(specificita('[data-contrast="high"] .kv-tab-giallo .bg-kidville-yellow')).toEqual([0, 3, 0])
    expect(specificita('[data-contrast="high"] .kv-tab-giallo .bg-kidville-yellow.text-kidville-green')).toEqual([0, 4, 0])
    expect(specificita('body')).toEqual([0, 0, 1])
    expect(specificita('[data-contrast="high"] body')).toEqual([0, 1, 1])
    expect(specificita('.kv-tab-giallo .text-white\\/70')).toEqual([0, 2, 0])
  })

  it('a parità di specificità vince l\'ULTIMA regola — ed è così che nasce il difetto', () => {
    const finto = parseRegole('.a { color: #111111; } .b { color: #222222; }')
    const el = monta('<span id="sonda" class="a b"></span>', false)
    expect(coloreTesto(el, false, finto)).toBe('#222222')
    // …e invertendo l'ordine vince l'altra: la sonda guarda davvero la posizione.
    const rovescio = parseRegole('.b { color: #222222; } .a { color: #111111; }')
    expect(coloreTesto(el, false, rovescio)).toBe('#111111')
  })

  it('una regola NON-layered batte una utility layered anche se meno specifica', () => {
    const util: Regola[] = [
      { sel: '.x.y', dich: [{ prop: 'color', val: '#111111' }], contesto: [], ordine: 0, layer: true },
    ]
    const globali = parseRegole('.z { color: #222222; }')
    const el = monta('<span id="sonda" class="x y z"></span>', false)
    expect(coloreTesto(el, false, [...util, ...globali])).toBe('#222222')
  })

  it('le utility dei token sono INLINATE: in Alto Contrasto NON si ribaltano da sole', () => {
    // È l'assunto su cui poggia tutto il blocco HC di globals.css. Verificato
    // sul CSS costruito: `.text-kidville-green{color:#006a5f}`.
    const el = monta('<span id="sonda" class="text-kidville-green"></span>', true)
    expect(coloreTesto(el, true)).toBe(T.green)
    expect(T_HC.green).toBe('#FFFFFF') // il TOKEN sì che si ribalta
  })

  it('`var()` segue il set di token giusto (base vs Alto Contrasto)', () => {
    const finto = parseRegole('#sonda { color: var(--color-kidville-yellow); }')
    const el = monta('<span id="sonda"></span>', false)
    expect(coloreTesto(el, false, finto)).toBe(T.yellow)
    expect(coloreTesto(el, true, finto)).toBe(T_HC.yellow)
  })

  it('nessuna regola dentro una at-rule dichiara colore o sfondo (la sonda può ignorarle)', () => {
    const dentro = REGOLE_CSS.filter((r) => r.contesto.length > 0)
    expect(dentro.length, 'ci sono davvero regole dentro at-rule da controllare').toBeGreaterThan(0)
    const colorate = dentro.filter((r) => valoreProp(r, 'color') || valoreProp(r, 'background-color'))
    expect(colorate.map((r) => `${r.contesto.join(' ')} ${r.sel}`)).toEqual([])
  })
})

// =============================================================================
// §1 — IL BLOCCANTE. La pill gialla dentro la card-header gialla, in Alto Contrasto.
// =============================================================================
const HEADER_GIALLO = (interno: string) =>
  `<header class="kv-header-card kv-tab-giallo relative bg-kidville-yellow">${interno}</header>`

/** `<Btn variant="secondary">` — la forma esatta del pill «NUOVO» di /teacher/avvisi. */
const PILL_SECONDARIA = `<button id="sonda" class="${btnClass('secondary', 'sm')}">NUOVO</button>`
/** La coppia di classi che ha prodotto il difetto, indipendente da `Btn`. */
const PILL_GIALLA_INCHIOSTRO_VERDE =
  '<span id="sonda" class="bg-kidville-yellow text-kidville-green">NUOVO</span>'

describe('S18 §1 · Alto Contrasto — attivare l\'aiuto non può peggiorare le cose', () => {
  it('CONTROLLO POSITIVO: col difetto RIMESSO la sonda misura bianco su giallo (1,28:1)', () => {
    // Si tolgono dal CSS le regole compound aggiunte per chiudere il difetto:
    // resta la cascata del 2026-08-01, e la sonda deve tornare a vedere il guasto.
    const senzaFix = REGOLE.filter(
      (r) => !/\.bg-kidville-yellow(\.|\s+\.)text-kidville/.test(r.sel),
    )
    expect(senzaFix.length, 'il filtro toglie qualcosa').toBeLessThan(REGOLE.length)
    const m = misura(HEADER_GIALLO(PILL_GIALLA_INCHIOSTRO_VERDE), true, senzaFix)
    expect(m.fg).toBe('#FFFFFF')
    expect(m.bg).toBe(T_HC.yellow)
    expect(m.rapporto).toBeLessThan(1.5)
  })

  it('la pill gialla con inchiostro verde regge AA in Alto Contrasto', () => {
    const m = misura(HEADER_GIALLO(PILL_GIALLA_INCHIOSTRO_VERDE), true)
    expect(m.rapporto, `${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it('anche un testo verde DENTRO la pill gialla regge AA in Alto Contrasto', () => {
    const m = misura(
      HEADER_GIALLO('<span class="bg-kidville-yellow"><b id="sonda" class="text-kidville-green">3</b></span>'),
      true,
    )
    expect(m.rapporto, `${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it('`<Btn variant="secondary">` nella card-header regge AA in Alto Contrasto e in luce normale', () => {
    for (const hc of [false, true]) {
      const m = misura(HEADER_GIALLO(PILL_SECONDARIA), hc)
      expect(m.rapporto, `hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('`<Btn variant="primary">` nella card-header gialla regge AA (il remap dei testi non lo spegne)', () => {
    // `.kv-tab-giallo .text-kidville-yellow → verde scuro` è pensato per il testo
    // POSATO sulla card gialla: su una pill che porta il PROPRIO fondo verde
    // darebbe verde su verde (1,36:1).
    const primario = `<button id="sonda" class="${btnClass('primary', 'sm')}">SALVA</button>`
    for (const hc of [false, true]) {
      const m = misura(HEADER_GIALLO(primario), hc)
      expect(m.rapporto, `hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('la card-header resta il fondo nero dell\'Alto Contrasto (non è sparita la regola)', () => {
    const el = monta(HEADER_GIALLO('<span id="sonda">x</span>'), true)
    expect(sfondo(el, true)).toBe('#000000')
  })
})

// =============================================================================
// §2 — Il bottone d'azione: verde/giallo è il BRAND, ma 4,05:1 non è un inchiostro.
// =============================================================================
const VARIANTI: BtnVariant[] = ['primary', 'secondary', 'ghost', 'danger']
const TAGLIE: BtnSize[] = ['sm', 'md', 'lg']

/** Estrae dal risultato di `btnClass()` i token di fondo, testo e fondo:hover. */
function coppie(v: BtnVariant, s: BtnSize) {
  const classi = btnClass(v, s).split(/\s+/)
  const bg = classi.find((c) => /^bg-kidville-/.test(c))?.replace('bg-kidville-', '')
  const fg = classi.find((c) => /^text-kidville-/.test(c))?.replace('text-kidville-', '')
  const hover = classi.find((c) => /^hover:bg-kidville-/.test(c))?.replace('hover:bg-kidville-', '')
  const px = Number(classi.find((c) => /^text-\[[\d.]+px\]$/.test(c))?.match(/[\d.]+/)?.[0])
  return { bg, fg, hover, px }
}

describe('S18 §2 · il bottone d\'azione — l\'inchiostro regge il proprio fondo', () => {
  it('CONTROLLO POSITIVO: la coppia di BRAND giallo/verde è sotto AA (4,05:1) — è il difetto', () => {
    // Il riempimento resta quello del brand: qui si misura che come coppia
    // TESTO/FONDO non basta, ed è il motivo per cui serve un inchiostro dedicato.
    expect(contrasto(T.yellow, T.green)).toBeLessThan(4.5)
    expect(contrasto(T.yellow, T.green)).toBeGreaterThanOrEqual(3) // non è invisibile: è sotto soglia
  })

  it('nessuna delle tre taglie è «testo grande» → la soglia applicabile è 4,5:1, non 3:1', () => {
    for (const s of TAGLIE) {
      const { px } = coppie('primary', s)
      expect(px, `taglia ${s}`).toBeGreaterThan(0)
      expect(px, `taglia ${s}: 14pt grassetto = 18,66px`).toBeLessThan(18.66)
    }
  })

  it.each(VARIANTI)('«%s»: testo su fondo ≥ 4,5:1 in tutte e tre le taglie', (v) => {
    for (const s of TAGLIE) {
      const { bg, fg } = coppie(v, s)
      expect(bg, `${v}/${s}: fondo tokenizzato`).toBeTruthy()
      expect(fg, `${v}/${s}: testo tokenizzato`).toBeTruthy()
      expect(contrasto(T[fg!], T[bg!]), `${v}/${s}: ${fg} su ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(VARIANTI)('«%s»: anche lo stato :hover resta ≥ 4,5:1', (v) => {
    const { fg, hover } = coppie(v, 'md')
    if (!hover) return // ghost/danger non cambiano fondo al passaggio
    expect(contrasto(T[fg!], T[hover]), `${v}:hover ${fg} su ${hover}`).toBeGreaterThanOrEqual(4.5)
  })

  it('il bottone montato davvero misura ≥ 4,5:1, fuori e dentro l\'Alto Contrasto', () => {
    for (const v of VARIANTI) {
      for (const hc of [false, true]) {
        const m = misura(`<button id="sonda" class="${btnClass(v, 'md')}">AZIONE</button>`, hc)
        expect(m.rapporto, `${v} hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('il RIEMPIMENTO resta il brand: verde #006A5F e giallo #FDC400 non si toccano', () => {
    expect(coppie('primary', 'md').bg).toBe('green')
    expect(coppie('secondary', 'md').bg).toBe('yellow')
    expect(T.green).toBe('#006A5F')
    expect(T.yellow).toBe('#FDC400')
  })
})

// =============================================================================
// §3 — La bottom-nav: la navigazione principale sul telefono, fuori dai token.
// =============================================================================
const stub = vi.hoisted(() => ({ pathname: '/parent', search: '' }))

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(stub.search),
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/lib/auth/use-child-school-type', () => ({
  useChildSchoolType: () => ({ schoolType: 'infanzia', ready: true }),
}))
vi.mock('@/lib/auth/use-teacher-identity', () => ({
  useTeacherIdentity: () => ({ userId: 'u1', pronta: true, withUser: (h: string) => h }),
}))
vi.mock('@/lib/auth/use-teacher-gradi', () => ({
  useTeacherGradi: () => ({
    gradi: [], hasInfanzia: false, hasPrimaria: false,
    isPrimariaOnly: false, isInfanziaOnly: false, diarioPrimariaVisibile: false, ready: false,
  }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'admin', withUser: (h: string) => h }),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [], selezionate: [], effettive: [], sedeCorrente: null,
    reFetchKey: '', epocaSede: 0, loading: false,
    toggle: vi.fn(), soloSede: vi.fn(), tutte: vi.fn(),
  }),
}))

import BottomNavGenitore from '@/components/features/parent/BottomNav'
import BottomNavDocente from '@/components/features/teacher/TeacherBottomNav'
import { AdminBottomNav } from '@/components/features/admin/AdminBottomNav'

const NAV = [
  ['genitore', BottomNavGenitore, '/parent'],
  ['docente', BottomNavDocente, '/teacher'],
  ['direzione', AdminBottomNav, '/admin'],
] as const

describe('S18 §3 · bottom-nav — le voci inattive stanno nei token, non in un hex a mano', () => {
  it('CONTROLLO POSITIVO: il grigio usato finora è sotto AA sul bianco della pillola', () => {
    expect(contrasto('#9CA3AF', '#FFFFFF')).toBeLessThan(4.5) // 2,54:1 — il difetto misurato
    expect(contrasto(T.sub, '#FFFFFF')).toBeGreaterThanOrEqual(4.5) // 6,46:1 — il token da usare
  })

  it.each(NAV)('%s: nessun colore scritto a mano negli stili inline della barra', (nome, Comp, pathname) => {
    stub.pathname = pathname
    const { container } = render(<Comp />)
    const nav = container.querySelector('nav')
    expect(nav, `${nome}: la barra è a schermo`).toBeTruthy()
    const inline = Array.from(nav!.querySelectorAll<HTMLElement>('[style]'))
      .map((e) => e.getAttribute('style') ?? '')
      .filter((s) => /#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(s))
    expect(inline, `${nome}: hex/rgb negli style inline`).toEqual([])
  })

  it.each(NAV)('%s: le voci INATTIVE usano `text-kidville-sub` (6,46:1), non un grigio chiaro', (nome, Comp, pathname) => {
    stub.pathname = pathname
    const { container } = render(<Comp />)
    const nav = container.querySelector('nav')!
    const voci = Array.from(nav.children)
    expect(voci.length, `${nome}: la barra ha le sue voci`).toBeGreaterThanOrEqual(4)
    const inattive = voci.filter((v) => v.getAttribute('aria-current') === null)
    expect(inattive.length, `${nome}: ci sono voci inattive da controllare`).toBeGreaterThan(0)
    for (const v of inattive) {
      expect(v.innerHTML, `${nome}: voce inattiva senza token di testo`).toContain('text-kidville-sub')
    }
  })

  it.each(NAV)('%s: la voce ATTIVA resta verde su bianco (6,51:1) con icona gialla sul pill verde', (nome, Comp, pathname) => {
    stub.pathname = pathname
    const { container } = render(<Comp />)
    const attiva = container.querySelector('nav > [aria-current="page"]')
    expect(attiva, `${nome}: c'è una voce attiva`).toBeTruthy()
    expect(attiva!.innerHTML).toContain('text-kidville-green')
    expect(attiva!.innerHTML).toContain('bg-kidville-green')
    expect(attiva!.innerHTML).toContain('text-kidville-yellow')
    expect(contrasto(T.green, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(T.yellow, T.green), 'icona su pill verde: soglia 3:1 (WCAG 1.4.11)').toBeGreaterThanOrEqual(3)
  })
})

// =============================================================================
// §4 — Il bordo dei campi della login: l'unico segno di dove comincia il controllo.
// =============================================================================
describe('S18 §4 · login — il bordo del campo si vede (WCAG 1.4.11, 3:1)', () => {
  const REG_LOGIN = parseRegole(CSS_LOGIN)
  const campo = REG_LOGIN.find((r) => r.sel === '.input')

  it('CONTROLLO POSITIVO: la sonda trova il campo, e `line` su bianco è invisibile (1,23:1)', () => {
    expect(campo, 'regola `.input` presente in page.module.css').toBeTruthy()
    expect(contrasto(T.line, T.white)).toBeLessThan(3) // 1,23:1 — il difetto misurato
  })

  it('il bordo a riposo tiene 3:1 contro il fondo bianco del campo', () => {
    const bordo = campo!.dich.find((d) => d.prop === 'border')?.val ?? ''
    const fondo = campo!.dich.find((d) => d.prop === 'background')?.val ?? ''
    const c = risolviVar(bordo, false)
    const f = risolviVar(fondo, false)
    expect(c, `colore del bordo risolto da «${bordo}»`).toBeTruthy()
    expect(f, `fondo del campo risolto da «${fondo}»`).toBeTruthy()
    expect(contrasto(c!, f!), `${c} su ${f}`).toBeGreaterThanOrEqual(3)
  })

  it('e lo tiene anche in Alto Contrasto (dove fondo e bordo si ribaltano insieme)', () => {
    const bordo = campo!.dich.find((d) => d.prop === 'border')?.val ?? ''
    const fondo = campo!.dich.find((d) => d.prop === 'background')?.val ?? ''
    expect(contrasto(risolviVar(bordo, true)!, risolviVar(fondo, true)!)).toBeGreaterThanOrEqual(3)
  })
})

// =============================================================================
// §5 — L'inchiostro di brand vale anche per EREDITARIETÀ (a11y #1, 2026-08-02).
//
// La rete di sicurezza scritta il 2026-08-01 (`.bg-kidville-green.text-kidville-yellow`)
// pretende che le DUE classi stiano sullo STESSO elemento. Ma il fondo di sezione
// si mette quasi sempre sul CONTENITORE — ed è esattamente ciò che fa `/offline`,
// la schermata che un genitore vede in strada, con poca rete e spesso in pieno
// sole: `<main class="bg-kidville-green">` e, dentro, `<h2 class="text-kidville-yellow">`.
// Il selettore non aggancia mai e restano i 4,05:1 di partenza.
//
// La regola correggeva la coppia SCRITTA insieme, non la coppia che si FORMA per
// ereditarietà. Qui si misura la seconda, e la si misura sul markup vero della
// pagina — reso da `OfflinePage`, non ricopiato a mano.
// =============================================================================
import { renderToString } from 'react-dom/server'
import OfflinePage from '@/app/offline/page'

/** Il markup VERO di `/offline`, reso dal componente di pagina. */
function montaOffline(hc: boolean) {
  document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal')
  document.body.innerHTML = renderToString(<OfflinePage />)
}

/** Le regole SENZA le varianti a discendente della rete di sicurezza di brand. */
const SENZA_DISCENDENTE = () =>
  REGOLE.filter(
    (r) =>
      !/^\.bg-kidville-(green|yellow)\s+\.text-kidville-(yellow|green)$/.test(r.sel),
  )

describe('S18 §5 · /offline — il giallo di marchio sul verde di marchio, per EREDITARIETÀ', () => {
  it('CONTROLLO POSITIVO: senza la variante a discendente la sonda misura 4,05:1', () => {
    const senza = SENZA_DISCENDENTE()
    expect(senza.length, 'il filtro toglie davvero qualcosa').toBeLessThan(REGOLE.length)
    const m = misura(
      '<main class="bg-kidville-green"><h2 id="sonda" class="text-kidville-yellow">x</h2></main>',
      false,
      senza,
    )
    expect(m.fg).toBe(T.yellow)
    expect(m.bg).toBe(T.green)
    expect(m.rapporto).toBe(4.05)
  })

  it('l\'intestazione dell\'elenco e il messaggio «nessuna connessione» reggono AA', () => {
    montaOffline(false)
    const sonde = [
      ...Array.from(document.querySelectorAll('nav[data-kv-disponibili] h2')),
      ...Array.from(document.querySelectorAll('p[data-kv-nessuna-rete]')),
    ]
    // Controllo POSITIVO: la pagina ha davvero i due nodi (due lingue ciascuno).
    expect(sonde.length, 'h2 dell\'elenco + messaggio di stato, in IT e EN').toBe(4)
    for (const el of sonde) {
      const m = misuraEl(el, false)
      expect(m.bg, 'il fondo effettivo è il verde di marchio, ereditato dal <main>').toBe(T.green)
      expect(m.rapporto, `${el.tagName}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('col difetto RIMESSO gli stessi nodi della pagina vera tornano sotto soglia', () => {
    montaOffline(false)
    const h2 = document.querySelector('nav[data-kv-disponibili] h2')!
    expect(misuraEl(h2, false, SENZA_DISCENDENTE()).rapporto).toBeLessThan(4.5)
  })

  it('il RIEMPIMENTO della pagina non cambia: resta il verde #006A5F', () => {
    montaOffline(false)
    const main = document.querySelector('main')!
    expect(main.className).toContain('bg-kidville-green')
    expect(sfondo(main, false)).toBe('#006A5F')
  })

  it('vale anche per il rovescio (verde di marchio posato sul giallo di marchio)', () => {
    const m = misura(
      '<div class="bg-kidville-yellow"><span id="sonda" class="text-kidville-green">x</span></div>',
      false,
    )
    expect(m.bg).toBe(T.yellow)
    expect(m.rapporto, `${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it('dentro la card-header gialla la pill verde non si spegne (la variante non crea un nuovo guasto)', () => {
    // `.kv-tab-giallo .bg-kidville-yellow` RIDIPINGE la pill di VERDE: un testo
    // `text-kidville-green` al suo interno starebbe verde su verde. La variante a
    // discendente da sola lo porterebbe a `green-ink` su verde (1,36:1) — sempre
    // illeggibile. Serve il guardiano più specifico, in entrambe le modalità.
    for (const hc of [false, true]) {
      const m = misura(
        HEADER_GIALLO('<span class="bg-kidville-yellow"><b id="sonda" class="text-kidville-green">3</b></span>'),
        hc,
      )
      expect(m.rapporto, `hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// =============================================================================
// §6 — Gli inchiostri di STATO: il giallo e l'arancio non dipingono TESTO
//      su una fascia chiara (a11y #2, 2026-08-02).
//
// `text-kidville-yellow-dark` (#E6B100) e `text-kidville-warn` (#E6720A) stanno
// su fasce chiare in 180 punti di `src/`: il banner che spiega al genitore perché
// la chat è bloccata, il badge del giudizio scolastico del figlio, l'intestazione
// e il contatore «mancanti N» dell'appello. Misurati: da 1,56:1 a 3,10:1.
//
// La palette aveva già l'inchiostro «forte» per il caldo (`warn-strong`) ma NON
// per il giallo, e nessun lock misurava l'USO: `contrasto-token` misura
// `yellow-dark` come CONTROLLO POSITIVO («è sotto AA su ogni superficie chiara»)
// senza però vietarne l'uso come testo.
//
// Qui si misura la CASCATA su OGNI fascia chiara della palette: se la rete di
// sicurezza c'è, il difetto è chiuso in tutti i punti in cui la classe è scritta,
// compresi quelli che nasceranno domani.
// =============================================================================

/**
 * Le fasce CHIARE su cui questi due inchiostri vivono davvero. Fuori dall'elenco
 * restano di proposito i due RIEMPIMENTI di marchio (`yellow`, `yellow-ink`): là
 * l'inchiostro non è uno stato ma `green-ink`, ed è la rete di sicurezza di §5 a
 * governarli. Nessuno dei 180 punti censiti scrive un inchiostro di stato sul
 * giallo pieno.
 */
const FASCE_CHIARE = [
  'white', 'cream', 'cream-dark', 'yellow-soft', 'yellow-light', 'green-light',
  'green-soft', 'warn-soft', 'error-soft', 'success-soft', 'info-soft',
  'neutral-soft', 'line',
] as const

/** Le regole SENZA la rete di sicurezza sugli inchiostri di stato. */
const SENZA_INCHIOSTRI_STATO = () =>
  REGOLE.filter((r) => !/text-kidville-(yellow-dark|warn)(\/|\b)/.test(r.sel) || r.layer)

describe('S18 §6 · inchiostri di stato — giallo e arancio non fanno da testo su fascia chiara', () => {
  it('CONTROLLO POSITIVO: la sonda vede la palette, e le fasce esistono tutte', () => {
    for (const f of FASCE_CHIARE) expect(T[f], `fascia «${f}» dichiarata in @theme inline`).toBeTruthy()
    expect(T['yellow-dark']).toBe('#E6B100')
    expect(T.warn).toBe('#E6720A')
  })

  it('CONTROLLO POSITIVO: i due token GREZZI sono sotto AA su ogni fascia chiara — è il difetto', () => {
    for (const f of FASCE_CHIARE) {
      expect(contrasto(T['yellow-dark'], T[f]), `yellow-dark su ${f}`).toBeLessThan(4.5)
      expect(contrasto(T.warn, T[f]), `warn su ${f}`).toBeLessThan(4.5)
    }
  })

  it('esiste un inchiostro GIALLO che regge AA su tutte le fasce chiare', () => {
    const ink = T['yellow-strong']
    expect(ink, '`--color-kidville-yellow-strong` dichiarato in @theme inline').toBeTruthy()
    for (const f of FASCE_CHIARE) {
      expect(contrasto(ink, T[f]), `yellow-strong su ${f}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('e l\'inchiostro ARANCIO già in palette regge AA sulle stesse fasce', () => {
    for (const f of FASCE_CHIARE) {
      expect(contrasto(T['warn-strong'], T[f]), `warn-strong su ${f}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(FASCE_CHIARE)('sulla fascia «%s» il testo giallo misura ≥ 4,5:1 (cascata risolta)', (f) => {
    for (const hc of [false, true]) {
      const m = misura(
        `<div class="bg-kidville-${f}"><span id="sonda" class="text-kidville-yellow-dark">x</span></div>`,
        hc,
      )
      expect(m.rapporto, `hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(FASCE_CHIARE)('sulla fascia «%s» il testo arancio misura ≥ 4,5:1 (cascata risolta)', (f) => {
    for (const hc of [false, true]) {
      const m = misura(
        `<div class="bg-kidville-${f}"><span id="sonda" class="text-kidville-warn">x</span></div>`,
        hc,
      )
      expect(m.rapporto, `hc=${hc}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('anche le varianti con ALFA (`/80`) — che un elenco di classi esatte lascerebbe fuori', () => {
    // Le utility con alfa sono classi DIVERSE (`.text-kidville-warn\/80`): una
    // regola scritta su `.text-kidville-warn` non le aggancia. È lo stesso modo
    // in cui la sidebar desktop era rimasta scoperta (`text-kidville-ink\/70`).
    for (const [classe, base, fascia, difetto] of [
      // `difetto` = il rapporto misurato oggi, senza la rete: l'alfa scende
      // ancora più in basso del token pieno (1,75:1 e 2,74:1).
      ['text-kidville-yellow-dark\\/80', T['yellow-dark'], 'yellow-soft', 1.56],
      ['text-kidville-warn\\/80', T.warn, 'warn-soft', 2.25],
    ] as const) {
      const conAlfa: Regola[] = [
        { sel: `.${classe}`, dich: [{ prop: 'color', val: composita(base, T[fascia], 0.8) }], contesto: [], ordine: -1, layer: true },
        ...REGOLE,
      ]
      const html = `<div class="bg-kidville-${fascia}"><p id="sonda" class="${classe.replace('\\', '')}">x</p></div>`
      // Controllo POSITIVO: senza la rete, l'alfa scende ancora più in basso.
      const senza = misura(html, false, conAlfa.filter((r) => r.layer || !/text-kidville-(yellow-dark|warn)\//.test(r.sel)))
      expect(senza.rapporto, `${classe} senza rete`).toBe(difetto)
      const m = misura(html, false, conAlfa)
      expect(m.rapporto, `${classe}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('CONTROLLO POSITIVO: col difetto RIMESSO le stesse sonde tornano a 1,75:1 e 2,74:1', () => {
    const senza = SENZA_INCHIOSTRI_STATO()
    expect(senza.length, 'il filtro toglie davvero qualcosa').toBeLessThan(REGOLE.length)
    const giallo = misura(
      '<div class="bg-kidville-yellow-soft"><span id="sonda" class="text-kidville-yellow-dark">x</span></div>',
      false,
      senza,
    )
    expect(giallo.rapporto).toBe(1.75)
    const arancio = misura(
      '<div class="bg-kidville-warn-soft"><span id="sonda" class="text-kidville-warn">x</span></div>',
      false,
      senza,
    )
    expect(arancio.rapporto).toBe(2.74)
  })

  it('il RIEMPIMENTO non cambia: `bg-kidville-warn` e `bg-kidville-yellow-dark` restano i loro', () => {
    // La rete tocca l'INCHIOSTRO, non la tinta: il pallino di stato, la barra di
    // avanzamento e l'hover del bottone secondario devono restare identici.
    for (const nome of ['warn', 'yellow-dark']) {
      const el = monta(`<span id="sonda" class="bg-kidville-${nome}"></span>`, false)
      expect(sfondo(el, false), `bg-kidville-${nome}`).toBe(T[nome])
    }
  })
})

// =============================================================================
// §7 — Il contorno del campo: la regola che lo rende visibile non deve spegnere
//      l'AFFORDANCE di hover (design #2, 2026-08-02).
//
// Il blocco `input|select|textarea[class*="border-kidville-…"]:not(:focus)` è
// non-layered per battere `@layer utilities`, e si sfila solo con `:not(:focus)`.
// L'hover non è escluso → vince anche sulle utility `hover:border-*`, e i 19
// select del cockpit hanno smesso di rispondere al passaggio del mouse.
//
// Le due «correzioni ovvie» sono entrambe sbagliate, e il test le vieta:
//   · `:not(:hover)` → sul campo SENZA utility di hover il bordo torna a
//     `border-kidville-line`, 1,23:1: il difetto che il blocco chiudeva.
//   · restringere il selettore a chi non porta `hover:border-*` → quei 19 campi
//     restano a 1,23:1 anche a riposo.
// Serve che a riposo e in hover il bordo sia DIVERSO e che entrambi reggano 3:1.
// =============================================================================

/** jsdom non ha un puntatore: `:hover` si riscrive in un attributo equivalente. */
const conHover = (r: Regola): Regola => ({ ...r, sel: r.sel.replace(/:hover/g, '[data-hover]') })

/** L'utility Tailwind `hover:border-kidville-green/50`, come la emette il compilatore. */
const UTILITY_HOVER: Regola = {
  sel: '.hover\\:border-kidville-green\\/50[data-hover]',
  dich: [{ prop: 'border-color', val: '#80B5AF' }], // #006A5F al 50% composto su bianco
  contesto: [], ordine: -1, layer: true,
}
const REGOLE_HOVER = [...REGOLE.map(conHover), UTILITY_HOVER]

/** Il colore di bordo che vince su `#sonda`, risolto sul set di token giusto. */
function bordo(el: Element, hc: boolean, regole = REGOLE_HOVER): string | null {
  const v = vince(el, 'border-color', regole)
  return v ? risolviVar(v, hc) : null
}

const SELECT_COCKPIT = 'border-[1.5px] border-kidville-line hover:border-kidville-green/50'

describe('S18 §7 · il contorno del campo — a riposo si vede, col mouse sopra RISPONDE', () => {
  it('CONTROLLO POSITIVO: la riscrittura di `:hover` funziona, e `line` su bianco è invisibile', () => {
    expect(conHover({ sel: 'a:hover', dich: [], contesto: [], ordine: 0, layer: false }).sel)
      .toBe('a[data-hover]')
    expect(contrasto(T.line, T.white)).toBe(1.23)
    expect(contrasto('#80B5AF', T.white), 'green/50 su bianco: sotto 3:1 anche da solo').toBeLessThan(3)
  })

  it('a RIPOSO il contorno del select del cockpit tiene 3:1 sul bianco del campo', () => {
    const el = monta(`<select id="sonda" class="${SELECT_COCKPIT}"></select>`, false)
    const b = bordo(el, false)
    expect(b, 'un colore di bordo risolto').toBeTruthy()
    expect(contrasto(b!, T.white), `${b} su bianco`).toBeGreaterThanOrEqual(3)
  })

  it('col MOUSE SOPRA il contorno CAMBIA — e tiene 3:1 (l\'affordance è tornata)', () => {
    const riposo = bordo(monta(`<select id="sonda" class="${SELECT_COCKPIT}"></select>`, false), false)
    const sopra = bordo(
      monta(`<select id="sonda" data-hover class="${SELECT_COCKPIT}"></select>`, false),
      false,
    )
    expect(sopra, 'un colore di bordo risolto in hover').toBeTruthy()
    expect(sopra, 'a riposo e in hover il bordo deve essere DIVERSO').not.toBe(riposo)
    expect(contrasto(sopra!, T.white), `${sopra} su bianco`).toBeGreaterThanOrEqual(3)
  })

  it('un campo SENZA utility di hover non perde il contorno quando ci passi sopra', () => {
    // È la trappola di `:not(:hover)`: chiuderebbe design #2 riaprendo il difetto
    // che il blocco esisteva per chiudere. Senza la rete il bordo ricadrebbe
    // sulla utility `border-kidville-line`, cioè 1,23:1 — non su «niente».
    const el = monta('<input id="sonda" data-hover class="border border-kidville-line" />', false)
    const b = bordo(el, false)
    expect(b, 'un colore di bordo risolto').toBeTruthy()
    expect(b, 'il bordo non può ricadere sulla utility debole').not.toBe(T.line)
    expect(contrasto(b!, T.white), `${b} su bianco`).toBeGreaterThanOrEqual(3)
  })

  it('in Alto Contrasto il contorno resta NERO anche col mouse sopra (il campo resta bianco)', () => {
    const el = monta(`<select id="sonda" data-hover class="${SELECT_COCKPIT}"></select>`, true)
    expect(bordo(el, true)).toBe('#000000')
  })
})

// =============================================================================
// §8 — L'avviso «presenza non salvata» dell'appello, in Alto Contrasto
//      (design #3, 2026-08-02).
//
// È la fascia che dice al docente che la presenza di un bambino NON è stata
// registrata. Con l'Alto Contrasto attivo restava identica alla luce normale —
// fondo #FDECEC, testo #C62828 — mentre accanto le righe alunno diventavano
// bianco/nero e il body nero: `@theme inline` inlina l'hex nelle utility, e il
// remap dei token dentro [data-contrast="high"] non le raggiunge.
// I contrasti INTERNI reggevano già (4,92:1): il difetto è di COERENZA.
// =============================================================================
const AVVISO_APPELLO = (marker: string) => `
  <div role="alert" class="${marker} rounded-2xl border border-kidville-error/30 bg-kidville-error-soft p-4">
    <p id="sonda" class="font-barlow text-sm font-extrabold uppercase text-kidville-error-strong">Salvataggio fallito</p>
    <span class="font-maven text-sm text-kidville-ink">Nome — Presente</span>
    <button class="rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-semibold text-kidville-yellow">Riprova</button>
  </div>`

describe('S18 §8 · appello — l\'avviso di salvataggio fallito parla anche in Alto Contrasto', () => {
  it('la fascia della pagina VERA porta il marcatore (senza, le regole HC non l\'agganciano)', () => {
    const src = fs.readFileSync(
      path.join(RADICE, 'src/app/(dashboard)/teacher/attendance/page.tsx'),
      'utf8',
    )
    const fasce = Array.from(src.matchAll(/<div\s+role="alert"[\s\S]{0,600}?className="([^"]*)"/g))
      .map((m) => m[1])
      .filter((c) => c.includes('bg-kidville-error-soft'))
    // Controllo POSITIVO: la fascia esiste ancora. Se cambia forma o sparisce,
    // il test deve diventare rosso, non passare a vuoto.
    expect(fasce.length, 'nessun role="alert" su bg-kidville-error-soft in attendance/page.tsx')
      .toBeGreaterThan(0)
    for (const c of fasce) expect(c.split(/\s+/)).toContain('kv-appello-avviso')
  })

  it('CONTROLLO POSITIVO: senza marcatore la fascia NON si ribalta (è la causa radice)', () => {
    const el = monta(AVVISO_APPELLO(''), true)
    expect(sfondo(el, true), 'l\'utility inlinata resta chiara con l\'HC attivo').toBe(T['error-soft'])
  })

  it('in luce normale la fascia resta quella del design (4,92:1)', () => {
    const m = misura(AVVISO_APPELLO('kv-appello-avviso'), false)
    expect(m.bg).toBe(T['error-soft'])
    expect(m.fg).toBe(T['error-strong'])
    expect(m.rapporto).toBe(4.92)
  })

  it('in Alto Contrasto passa al linguaggio HC: fondo nero e testi ≥ 4,5:1', () => {
    const el = monta(AVVISO_APPELLO('kv-appello-avviso'), true)
    expect(sfondo(el, true), 'la fascia adotta il fondo nero come `.kv-mensa-alt`').toBe('#000000')
    for (const sel of ['#sonda', 'span', 'button']) {
      const n = document.querySelector(sel)!
      const m = misuraEl(n, true)
      expect(m.rapporto, `${sel}: ${m.fg} su ${m.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// =============================================================================
// §9 — L'anello di focus non parte da `currentColor` (a11y, warning 8).
//
// `transition-colors` di Tailwind v4 include `outline-color`. Il valore INIZIALE
// di `outline-color` è `currentcolor`: su un controllo a testo chiaro il primo
// frame dell'anello è invisibile e ci mette ~150 ms ad arrivare al verde.
// Si chiude dichiarando il colore dell'anello anche a RIPOSO (larghezza 0: non
// si vede nulla), così la transizione parte già dal colore giusto.
// =============================================================================
describe('S18 §9 · l\'anello di focus ha un colore anche PRIMA di accendersi', () => {
  it('CONTROLLO POSITIVO: la sonda sa leggere `outline-color` da una shorthand', () => {
    const finto = parseRegole('#sonda { outline: 2px solid #123456; }')
    const el = monta('<button id="sonda"></button>', false)
    expect(risolviVar(vince(el, 'outline-color', finto)!, false)).toBe('#123456')
  })

  it.each(['a', 'button', 'input', 'select', 'textarea'])(
    'su <%s> il colore dell\'anello è già dichiarato a riposo, e non è currentColor',
    (tag) => {
      const el = monta(`<${tag} id="sonda"></${tag}>`, false)
      const v = vince(el, 'outline-color', REGOLE)
      expect(v, `nessun outline-color a riposo su <${tag}>`).toBeTruthy()
      expect(v!.toLowerCase()).not.toContain('currentcolor')
      expect(risolviVar(v!, false)).toBe('#006A5F')
    },
  )

  it('in Alto Contrasto il colore a riposo è quello dell\'anello HC', () => {
    const el = monta('<button id="sonda"></button>', true)
    expect(risolviVar(vince(el, 'outline-color', REGOLE)!, true)).toBe('#FFE500')
  })

  it('la regola di focus vera non è stata toccata: resta 2px verde, fuori da ogni layer', () => {
    const r = REGOLE_CSS.filter((x) => x.sel === ':focus-visible')
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((x) => x.contesto.every((c) => !c.startsWith('@layer')))).toBe(true)
    expect(r.flatMap((x) => x.dich).some((d) => d.val.includes('#006A5F'))).toBe(true)
  })
})

// =============================================================================
// §10 — Il segnaposto dei campi PUBBLICI (design, warning 3).
//
// `placeholder-kidville-green/40` vale ~1,92:1 su bianco, e in Alto Contrasto non
// si ribalta: è l'ultimo elemento delle superfici pubbliche rimasto fuori dal
// ribaltamento. Il segnaposto è TESTO: 1.4.3 si applica. Si corregge dove è già
// stato corretto il resto (blocco `.kv-public`), non nel componente condiviso
// con la modulistica in-app.
// =============================================================================
describe('S18 §10 · il segnaposto dei campi pubblici si legge, in entrambe le modalità', () => {
  const placeholder = (hc: boolean) =>
    REGOLE_CSS.filter(
      (r) =>
        r.sel.includes('.kv-public') &&
        r.sel.includes('::placeholder') &&
        r.sel.includes('[data-contrast="high"]') === hc,
    )

  it('CONTROLLO POSITIVO: il segnaposto di oggi è sotto soglia (1,92:1 su bianco)', () => {
    expect(contrasto('#99C3BF', T.white)).toBe(1.92) // green/40 composto su bianco
  })

  it('luce normale: la regola esiste e il colore regge AA su bianco e crema', () => {
    const r = placeholder(false)
    expect(r.length, 'nessuna regola `.kv-public ::placeholder` in luce normale').toBeGreaterThan(0)
    const c = risolviVar(r.flatMap((x) => x.dich).find((d) => d.prop === 'color')!.val, false)
    expect(c, 'colore del segnaposto risolto').toBeTruthy()
    expect(contrasto(c!, T.white), `${c} su bianco`).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(c!, T.cream), `${c} su crema`).toBeGreaterThanOrEqual(4.5)
  })

  it('Alto Contrasto: la carta resta bianca, quindi il segnaposto va scuro', () => {
    const r = placeholder(true)
    expect(r.length, 'nessuna regola `.kv-public ::placeholder` in Alto Contrasto').toBeGreaterThan(0)
    const c = risolviVar(r.flatMap((x) => x.dich).find((d) => d.prop === 'color')!.val, true)
    expect(contrasto(c!, '#FFFFFF'), `${c} sulla carta bianca HC`).toBeGreaterThanOrEqual(4.5)
  })
})
