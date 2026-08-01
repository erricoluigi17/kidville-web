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

function valoreProp(r: Regola, prop: 'color' | 'background-color'): string | null {
  let v: string | null = null
  for (const d of r.dich) {
    if (d.prop === prop) v = d.val
    else if (prop === 'background-color' && d.prop === 'background') {
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
function vince(el: Element, prop: 'color' | 'background-color', regole: Regola[]): string | null {
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

/** Misura testo/fondo effettivi di `#sonda` e ne restituisce il rapporto. */
function misura(html: string, hc: boolean, regole = REGOLE) {
  const el = monta(html, hc)
  const fg = coloreTesto(el, hc, regole)
  const bg = sfondo(el, hc, regole)
  return { fg, bg, rapporto: contrasto(fg, bg) }
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
