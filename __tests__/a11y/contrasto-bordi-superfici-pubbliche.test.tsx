import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, cleanup, screen } from '@testing-library/react'

// =============================================================================
// S19 — il bordo che dice dove comincia il campo, e l'Alto Contrasto che arriva
//       anche a chi non è ancora dentro l'app.
//
// Tre difetti misurati nel collaudo del 2026-08-02, tutti della stessa famiglia:
// una regola giusta applicata a UNA strada sola.
//
//  (5) Il contorno dei campi vale 1,23:1 (`--color-kidville-line` #EFE7DC su
//      bianco). Su una card bianca il bordo è l'UNICA cosa che dice dove comincia
//      il controllo: WCAG 1.4.11 chiede 3:1. Questo stesso ciclo l'aveva già
//      riconosciuto e corretto — ma solo in `auth/login/page.module.css`, dove il
//      campo è disegnato con `var()`. Il resto dell'app usa la utility
//      `border-kidville-line`, il cui hex è INLINATO da `@theme inline` e che
//      quindi nessuna rimappatura centrale può raggiungere.
//
//  (6) L'Alto Contrasto non tocca le intestazioni di gruppo della sidebar admin
//      («ANAGRAFICA», «DIDATTICA», …): 2,51:1 con l'aiuto attivo esattamente come
//      senza. Le rimappature `[data-contrast="high"]` erano state scritte per le
//      superfici MOBILE nuove (sheet, row-card) e la sidebar desktop era rimasta
//      fuori dall'elenco.
//
//  (7) L'Alto Contrasto NON ESISTE fuori dall'area autenticata. Sul modulo
//      pubblico d'iscrizione — ~9 domande l'ora da famiglie vere — non c'è alcun
//      comando per attivarlo, e attivandolo altrove la pagina non cambia di un
//      pixel: `ContrastMenuButton` vive solo nei menu account, e nessuna regola
//      `[data-contrast="high"]` nomina le superfici pubbliche.
//
// Questo file NON guarda le classi del sorgente: RISOLVE la cascata di
// `globals.css` in jsdom (`Element.matches`, ordinamento livello → specificità →
// posizione, `var()` sul set di token giusto, composizione delle alfa) e MISURA
// i rapporti WCAG. Ogni asserzione ha il suo CONTROLLO POSITIVO, e i difetti
// sono rimessi dentro il test: tolte le regole nuove, la sonda deve tornare a
// vedere 1,23:1 e 2,51:1. Senza quella prova, «≥ 3:1» direbbe soltanto che la
// sonda non ha trovato niente.
// =============================================================================

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8')

// ── WCAG 2.x §1.4.3 / §1.4.11 — rapporto di contrasto ───────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const luminanza = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}
/** Composizione di `fg` con alfa `a` sopra il fondo opaco `bg`. */
const sopra = (fg: string, bg: string, a: number) => {
  const [r1, g1, b1] = rgb(fg)
  const [r2, g2, b2] = rgb(bg)
  const m = (x: number, y: number) => Math.round(x * a + y * (1 - a))
  return (
    '#' +
    [m(r1, r2), m(g1, g2), m(b1, b2)].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')
  )
}

// ── Parser CSS: regole ordinate, col contesto delle at-rule ─────────────────
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

function parseRegole(css: string): Regola[] {
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
function specificita(sel: string): [number, number, number] {
  const s = sel.replace(/\\./g, 'µ')
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

/** Le alfa Tailwind effettivamente scritte nel sorgente delle superfici in esame. */
const ALFA = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90]

/**
 * Le utility Tailwind dei token, come le emette davvero il compilatore: con
 * `@theme inline` l'hex è INLINATO nella classe (`.text-kidville-green{color:#006a5f}`),
 * NON è un `var()` — è la ragione per cui il rimappaggio dei token in Alto
 * Contrasto non le tocca e ogni superficie ha bisogno della sua regola esplicita.
 * Vivono in `@layer utilities` → perdono contro qualunque regola non-layered.
 * Le varianti con alfa (`/70`) si portano dietro il fattore, composto sul fondo
 * al momento della misura.
 */
function utilityTailwind(): Regola[] {
  const out: Regola[] = []
  let o = 0
  const agg = (sel: string, prop: string, val: string) =>
    out.push({ sel, dich: [{ prop, val }], contesto: [], ordine: o++, layer: true })
  for (const [nome, hex] of Object.entries(T)) {
    agg(`.text-kidville-${nome}`, 'color', hex)
    agg(`.bg-kidville-${nome}`, 'background-color', hex)
    agg(`.border-kidville-${nome}`, 'border-color', hex)
    for (const a of ALFA) {
      agg(`.text-kidville-${nome}\\/${a}`, 'color', `mix(${hex},${a / 100})`)
      agg(`.bg-kidville-${nome}\\/${a}`, 'background-color', `mix(${hex},${a / 100})`)
      agg(`.border-kidville-${nome}\\/${a}`, 'border-color', `mix(${hex},${a / 100})`)
    }
  }
  agg('.text-white', 'color', '#FFFFFF')
  agg('.bg-white', 'background-color', '#FFFFFF')
  agg('.border-white', 'border-color', '#FFFFFF')
  agg('.text-gray-500', 'color', '#6A7282')
  agg('.border-transparent', 'border-color', 'transparent')
  return out
}

const REGOLE = [...utilityTailwind(), ...REGOLE_CSS]

function coloreDaShorthand(val: string): string | null {
  if (/gradient|url\(/i.test(val)) return null
  const m = val.match(/#[0-9A-Fa-f]{3,6}\b|var\(\s*--[-\w]+\s*\)|mix\([^)]*\)|transparent/i)
  return m ? m[0] : null
}

type Prop = 'color' | 'background-color' | 'border-color'

function valoreProp(r: Regola, prop: Prop): string | null {
  let v: string | null = null
  for (const d of r.dich) {
    if (d.prop === prop) v = d.val
    else if (prop === 'background-color' && d.prop === 'background') {
      const c = coloreDaShorthand(d.val)
      if (c) v = c
    } else if (prop === 'border-color' && d.prop === 'border') {
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
  let migliorVal: string | null = null
  let miglior: number[] | null = null
  for (const r of regole) {
    if (r.contesto.length > 0) continue
    const v = valoreProp(r, prop)
    if (v === null) continue
    let ok = false
    try {
      ok = el.matches(r.sel)
    } catch {
      ok = false
    }
    if (!ok) continue
    const [a, b, c] = specificita(r.sel)
    const peso = [r.layer ? 0 : 1, a, b, c, r.ordine]
    if (miglior === null || batte(peso, miglior)) {
      miglior = peso
      migliorVal = v
    }
  }
  return migliorVal
}

/** Risolve un valore in hex opaco; `sotto` serve a comporre le alfa. */
function risolvi(v: string, hc: boolean, sotto: string): string | null {
  const mix = v.match(/mix\(\s*(#[0-9A-Fa-f]{6})\s*,\s*([\d.]+)\s*\)/)
  if (mix) return sopra(mix[1].toUpperCase(), sotto, Number(mix[2]))
  const m = v.match(/var\(\s*(--color-kidville-[a-z0-9-]+)\s*\)/)
  if (m) {
    const nome = m[1].replace('--color-kidville-', '')
    return (hc ? T_HC[nome] : undefined) ?? T[nome] ?? null
  }
  if (/^transparent$/i.test(v.trim())) return null
  const h = v.match(/#[0-9A-Fa-f]{6}\b/)
  if (h) return h[0].toUpperCase()
  const c = v.match(/#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])\b/)
  if (c) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toUpperCase()
  return null
}

/**
 * Il fondo OPACO effettivo dietro `el` (le alfa si compongono risalendo).
 * Memoizzato per elemento+modalità: su /privacy (600 righe di testo) la
 * risalita non memoizzata costa migliaia di scansioni delle ~1400 regole.
 */
const CACHE_SFONDO = new WeakMap<Element, Map<string, string>>()
function sfondo(el: Element | null, hc: boolean, regole = REGOLE): string {
  if (!el) return hc ? '#000000' : T.cream
  const chiave = `${hc}:${regole === REGOLE ? 'std' : 'alt'}`
  const per = CACHE_SFONDO.get(el) ?? new Map<string, string>()
  const gia = per.get(chiave)
  if (gia !== undefined) return gia
  const v = vince(el, 'background-color', regole)
  const padre = () => sfondo(el.parentElement, hc, regole)
  const calcola = () => {
    if (!v) return padre()
    const mix = v.match(/mix\(\s*(#[0-9A-Fa-f]{6})\s*,\s*([\d.]+)\s*\)/)
    if (mix) return sopra(mix[1].toUpperCase(), padre(), Number(mix[2]))
    return risolvi(v, hc, padre()) ?? padre()
  }
  const out = calcola()
  per.set(chiave, out)
  CACHE_SFONDO.set(el, per)
  return out
}

/** Il colore di testo effettivo su `el` (eredita risalendo, alfa composte sul fondo). */
function coloreTesto(el: Element, hc: boolean, regole = REGOLE): string {
  const bg = sfondo(el, hc, regole)
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = vince(n, 'color', regole)
    if (v) {
      const c = risolvi(v, hc, bg)
      if (c) return c
    }
  }
  return hc ? '#FFFFFF' : T.green
}

/** Il colore del BORDO effettivo su `el`, o `null` se non ne dichiara nessuno. */
function coloreBordo(el: Element, hc: boolean, regole = REGOLE): string | null {
  const v = vince(el, 'border-color', regole)
  if (!v) return null
  return risolvi(v, hc, sfondo(el, hc, regole))
}

function monta(html: string, hc: boolean): Element {
  document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal')
  document.body.innerHTML = html
  const el = document.getElementById('sonda')
  expect(el, 'elemento #sonda montato').toBeTruthy()
  return el!
}

const leggi = (p: string) => fs.readFileSync(path.join(RADICE, p), 'utf8')

/**
 * Il sorgente SENZA commenti — prosa, blocchi `/* *\/` e commenti JSX `{/* *\/}`.
 * Serve perché un lock che cerca un nome nel file lo trova anche quando quel
 * nome è soltanto CITATO in un commento: togliendo il componente da /assistenza
 * il test restava verde, perché il commento accanto lo nominava. Un lock che si
 * accontenta della prosa non è un lock.
 */
const codice = (p: string) =>
  leggi(p)
    // ⚠️ L'ORDINE È LA CORREZIONE DI UN DIFETTO, NON UNO STILE (19/08/2026).
    //
    // Prima qui la riga d'apertura era `.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')`,
    // cioè «togli i commenti JSX `{/* … */}`». Sembra innocua e non lo è: cerca
    // una graffa aperta seguita da `/*`, e la trova anche sulla graffa dei
    // PARAMETRI di un componente che comincia con un JSDoc —
    //
    //     export async function PublicPageHeader({
    //       /** Il percorso da cui si è arrivati. */
    //       ritorno,
    //
    // — dopodiché il quantificatore pigro corre fino al PRIMO `*/` seguito da `}`,
    // che è la fine di un commento JSX centinaia di righe più in basso. Tutto ciò
    // che sta in mezzo sparisce: codice vero compreso.
    //
    // MISURATO su `PublicPageHeader.tsx` il 19/08/2026, quando al file è stato
    // aggiunto il primo commento JSX: il match ha inghiottito 5272 caratteri e con
    // essi `<PublicContrastButton />`, che nel file c'è. Il lock ha accusato le
    // quattro pagine legali di essere rimaste senza comando di Alto Contrasto —
    // una diagnosi falsa, prodotta dallo spogliatore e non dal codice.
    //
    // Il difetto era LATENTE: si arma solo quando nel file esiste un `*/}` dopo la
    // graffa dei parametri, e fino a quel giorno in quel file non ce n'erano.
    //
    // Togliere prima TUTTI i blocchi `/* … */` lo chiude alla radice: quando si
    // arriva alla graffa, il commento che la seguiva non c'è più, e del commento
    // JSX resta il guscio `{}`, che si toglie dopo. Un lock non può permettersi di
    // cancellare il codice che deve misurare.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/(?<!:)\/\/.*$/gm, '')

afterEach(() => {
  document.documentElement.removeAttribute('data-contrast')
  document.body.innerHTML = ''
  cleanup()
})

// =============================================================================
describe('S19 §0 · la sonda — prima di misurare, si dimostra che misura', () => {
  it('risolve il BORDO come fa il browser: utility layered vs regola non-layered', () => {
    const util: Regola[] = [
      { sel: '.border-kidville-line', dich: [{ prop: 'border-color', val: T.line }], contesto: [], ordine: 0, layer: true },
    ]
    const el = monta('<input id="sonda" class="border-kidville-line">', false)
    expect(coloreBordo(el, false, util), 'senza regole globali vince la utility').toBe(T.line)
    const globali = parseRegole('input.border-kidville-line { border-color: #123456; }')
    expect(coloreBordo(el, false, [...util, ...globali]), 'la non-layered vince').toBe('#123456')
  })

  it('compone le ALFA sul fondo vero (è così che si misura `border-kidville-green/15`)', () => {
    // Sulle SOLE utility, cioè come stava il campo del modulo pubblico prima:
    // #006A5F al 15% sopra #FFFFFF = #D9E9E7 → 1,25:1, invisibile quanto `line`.
    const soloUtility = REGOLE.filter((r) => r.layer)
    const el = monta('<div class="bg-white"><input id="sonda" class="border-kidville-green/15"></div>', false)
    expect(coloreBordo(el, false, soloUtility)).toBe('#D9E9E7')
    expect(contrasto('#D9E9E7', '#FFFFFF')).toBeLessThan(3)
  })

  it('il fondo si eredita risalendo, e in Alto Contrasto le utility NON si ribaltano da sole', () => {
    // Fuori dalle superfici marcate (niente `.kv-public`, niente `.kv-admin-*`)
    // il crema resta crema anche in Alto Contrasto: è l'assunto su cui poggia
    // tutto il blocco HC di globals.css.
    const el = monta('<main class="bg-kidville-cream"><span id="sonda">x</span></main>', true)
    expect(sfondo(el, true)).toBe(T.cream) // hex inlinato: resta crema anche in HC
    expect(T_HC.cream).toBe('#000000') // il TOKEN sì che si ribalta
  })

  it('`[data-contrast="high"]` sta sull\'ELEMENTO RADICE, o le regole HC non agganciano niente', () => {
    // Trappola vera, trovata da questa stessa sonda: misurando l'albero
    // renderizzato senza mettere l'attributo su <html>, `el.matches()` non fa
    // combaciare NESSUNA regola `[data-contrast="high"] …` e la misura torna
    // quella della luce normale — cioè un verde falso.
    document.body.innerHTML =
      '<div class="kv-public bg-kidville-cream"><span id="con">x</span></div>' +
      '<div class="kv-public bg-kidville-cream"><span id="senza">x</span></div>'
    document.documentElement.setAttribute('data-contrast', 'high')
    expect(sfondo(document.getElementById('con')!, true)).toBe('#FFFFFF')
    document.documentElement.removeAttribute('data-contrast')
    expect(sfondo(document.getElementById('senza')!, true)).toBe(T.cream)
  })
})

// =============================================================================
// §1 — Il bordo dei campi (rilievo a11y #5). WCAG 1.4.11: 3:1 sul contorno.
// =============================================================================

/** Le forme di campo prese TALI E QUALI dal codice, con la loro provenienza. */
const CAMPI: Array<[string, string]> = [
  // src/components/features/admin/settings/SettingsPanel.tsx — i 33 campi misurati
  ['/admin/impostazioni', '<input id="sonda" class="w-full rounded-input border border-kidville-line bg-white px-3 py-2">'],
  // src/app/(dashboard)/admin/students/page.tsx:519 — ricerca anagrafica (border-2)
  ['/admin/students (ricerca)', '<input id="sonda" class="w-full border-2 border-kidville-line rounded-input focus:border-kidville-green">'],
  // src/app/(dashboard)/admin/students/sezioni/[id]/page.tsx:532 — select di sezione
  ['/admin/students/sezioni (select)', '<select id="sonda" class="w-full rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5"></select>'],
  // src/app/(dashboard)/admin/modulistica/page.tsx:823 — area di testo
  ['/admin/modulistica (textarea)', '<textarea id="sonda" class="w-full border-2 border-kidville-line rounded-xl"></textarea>'],
  // src/app/cancellazione-account/CancellazioneForm.tsx:58 — modulo PUBBLICO
  ['/cancellazione-account', '<input id="sonda" class="w-full rounded-input border border-kidville-line bg-white">'],
  // src/components/features/forms/FieldRenderer.tsx — i campi del modulo d'iscrizione
  // (`FIELD_BASE`, dall'11/08/2026 scritto coi token `rounded-input`/`bg-kidville-white`).
  ['/iscrizione (FIELD_BASE)', '<input id="sonda" class="w-full rounded-input bg-kidville-white border border-kidville-green/15">'],
  ['/iscrizione (select)', '<select id="sonda" class="w-full rounded-input bg-kidville-white border border-kidville-green/15"></select>'],
  ['/iscrizione (textarea)', '<textarea id="sonda" class="w-full rounded-input bg-kidville-white border border-kidville-green/15"></textarea>'],
  // src/components/features/admin/StudentDetailPanel.tsx:504 — casella di spunta
  ['StudentDetailPanel (checkbox)', '<input type="checkbox" id="sonda" class="w-4 h-4 rounded border-kidville-muted">'],
]

const CARD_BIANCA = (interno: string) => `<div class="bg-white rounded-card">${interno}</div>`

describe('S19 §1 · il contorno di un campo si vede (WCAG 1.4.11 — 3:1)', () => {
  it('CONTROLLO POSITIVO: col difetto RIMESSO la sonda misura 1,23:1 su TUTTI i campi', () => {
    // Si tolgono dal CSS le regole nuove sui controlli: resta lo stato del
    // 2026-08-02 e la sonda deve tornare a vedere il bordo invisibile.
    const senzaFix = REGOLE.filter((r) => !/^(input|select|textarea)[.[]/.test(r.sel))
    expect(senzaFix.length, 'il filtro toglie qualcosa').toBeLessThan(REGOLE.length)
    const deboli = CAMPI.map(([nome, html]) => {
      const el = monta(CARD_BIANCA(html), false)
      const b = coloreBordo(el, false, senzaFix)!
      return [nome, contrasto(b, sfondo(el, false, senzaFix))] as const
    })
    // Tutti sotto soglia, nessuno escluso: è la fotografia del difetto.
    expect(deboli.filter(([, r]) => r >= 3)).toEqual([])
    expect(deboli.find(([n]) => n === '/admin/impostazioni')?.[1]).toBe(1.23)
  })

  it.each(CAMPI)('%s: bordo ≥ 3:1 sul proprio fondo, in luce normale', (_nome, html) => {
    const el = monta(CARD_BIANCA(html), false)
    const bordo = coloreBordo(el, false)
    expect(bordo, 'il campo dichiara un colore di bordo').toBeTruthy()
    const bg = sfondo(el, false)
    expect(contrasto(bordo!, bg), `${bordo} su ${bg}`).toBeGreaterThanOrEqual(3)
  })

  it.each(CAMPI)('%s: bordo ≥ 3:1 anche in Alto Contrasto', (_nome, html) => {
    const el = monta(CARD_BIANCA(html), true)
    const bordo = coloreBordo(el, true)
    const bg = sfondo(el, true)
    expect(contrasto(bordo!, bg), `${bordo} su ${bg}`).toBeGreaterThanOrEqual(3)
  })

  it('il bordo di STATO non viene sovrascritto: rosso d\'errore e verde di focus restano', () => {
    // `border-kidville-error` (#E53935, 4,23:1) è già un segnale: la regola dei
    // contorni deboli non deve toccarlo, o il campo in errore perde il rosso.
    const err = monta(
      CARD_BIANCA('<input id="sonda" class="border border-kidville-error bg-kidville-error-soft">'),
      false,
    )
    expect(coloreBordo(err, false)).toBe(T.error)
    // Il focus lo decide il componente (`focus:border-kidville-green`): la regola
    // dei contorni si sfila con `:not(:focus)`.
    const fuoriFocus = REGOLE.filter((r) => r.sel.includes(':not(:focus)'))
    expect(fuoriFocus.length, 'la regola si sfila davvero sul :focus').toBeGreaterThan(0)
  })

  it('un bordo dichiarato TRASPARENTE resta trasparente (non lo si dipinge di nascosto)', () => {
    // `border-b border-transparent focus:border-kidville-green/50` — il titolo
    // modificabile del costruttore moduli: il contorno compare al focus, di proposito.
    const el = monta(
      CARD_BIANCA('<input id="sonda" class="border-b border-transparent focus:border-kidville-green/50">'),
      false,
    )
    expect(coloreBordo(el, false)).toBeNull()
  })
})

// =============================================================================
// §2 — La sidebar del cockpit in Alto Contrasto (rilievo a11y #6).
// =============================================================================
import { AdminSidebar } from '@/components/features/admin/AdminSidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/avvisi',
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'admin', withUser: (h: string) => h }),
}))

/**
 * Monta un albero React e, se `hc`, mette `data-contrast="high"` sull'elemento
 * RADICE — senza, nessuna regola `[data-contrast="high"] …` aggancia niente e
 * la misura tornerebbe quella della luce normale (§0 lo dimostra).
 */
function montaReact(nodo: React.ReactElement, hc: boolean): HTMLElement {
  document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal')
  const { container } = render(
    <AccessibilityProvider initialHighContrast={hc}>{nodo}</AccessibilityProvider>,
  )
  // Il provider riscrive l'attributo in useEffect: lo si riafferma dopo il render.
  document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal')
  return container
}

/** Le intestazioni di gruppo della sidebar, dal DOM vero del componente. */
function intestazioniSidebar(hc = false): HTMLElement[] {
  const nav = montaReact(<AdminSidebar />, hc).querySelector('.kv-admin-nav')
  expect(nav, 'la sidebar è a schermo').toBeTruthy()
  return Array.from(nav!.querySelectorAll<HTMLElement>('p'))
}

describe('S19 §2 · sidebar admin — l\'Alto Contrasto arriva anche alle intestazioni', () => {
  it('CONTROLLO POSITIVO: `muted` su bianco è 2,51:1, e senza la regola HC resta identico', () => {
    expect(contrasto(T.muted, '#FFFFFF')).toBe(2.51)
    const senzaFix = REGOLE.filter((r) => !/\.kv-admin-nav \.text-kidville-(muted|sub|ink)/.test(r.sel))
    const el = monta(
      '<aside class="bg-kidville-white"><nav class="kv-admin-nav"><p id="sonda" class="text-kidville-muted">ANAGRAFICA</p></nav></aside>',
      true,
    )
    expect(contrasto(coloreTesto(el, true, senzaFix), sfondo(el, true, senzaFix))).toBe(2.51)
  })

  it('le intestazioni ci sono, e nessuna usa più `text-kidville-muted`', () => {
    const p = intestazioniSidebar()
    expect(p.length, 'i gruppi della nav hanno la loro intestazione').toBeGreaterThanOrEqual(4)
    for (const el of p) {
      expect(Array.from(el.classList), el.textContent ?? '').not.toContain('text-kidville-muted')
    }
  })

  it('ogni intestazione regge AA in luce normale (soglia 4,5:1)', () => {
    for (const el of intestazioniSidebar()) {
      const fg = coloreTesto(el, false)
      const bg = sfondo(el, false)
      expect(contrasto(fg, bg), `«${el.textContent}» ${fg} su ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('e in Alto Contrasto sale a NERO PIENO sulla sidebar bianca (21:1)', () => {
    const p = intestazioniSidebar(true)
    expect(p.length).toBeGreaterThanOrEqual(4)
    for (const el of p) {
      const fg = coloreTesto(el, true)
      const bg = sfondo(el, true)
      expect(fg, `«${el.textContent}»`).toBe('#000000')
      expect(contrasto(fg, bg), `«${el.textContent}» ${fg} su ${bg}`).toBe(21)
    }
  })

  it('la voce ATTIVA resta bianca sul pill nero: la regola nuova non la spegne', () => {
    const attiva = montaReact(<AdminSidebar />, true).querySelector('.kv-admin-nav a[aria-current="page"]')
    expect(attiva, 'c\'è una voce attiva').toBeTruthy()
    expect(coloreTesto(attiva!, true)).toBe('#FFFFFF')
  })
})

// =============================================================================
// §3 — L'Alto Contrasto per chi NON è ancora dentro l'app (rilievo a11y #7).
// =============================================================================

/** Le pagine pubbliche: sorgente + rotta. */
const PUBBLICHE: Array<[string, string]> = [
  ['/iscrizione', 'src/components/features/public/EnrollmentWizard.tsx'],
  ['/privacy', 'src/app/privacy/page.tsx'],
  ['/termini', 'src/app/termini/page.tsx'],
  ['/assistenza', 'src/app/assistenza/page.tsx'],
  ['/cancellazione-account', 'src/app/cancellazione-account/page.tsx'],
]

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import PrivacyPage from '@/app/privacy/page'
import TerminiPage from '@/app/termini/page'
import AssistenzaPage from '@/app/assistenza/page'
import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

/** Il guscio delle 4 pagine legali, identico nei quattro file. */
const GUSCIO_LEGALE = (interno: string) =>
  `<main class="kv-public min-h-screen bg-kidville-cream"><div><article class="rounded-card border border-kidville-line bg-white">${interno}</article></div></main>`

/** Il guscio del modulo d'iscrizione (EnrollmentWizard.tsx:383). */
const GUSCIO_ISCRIZIONE = (interno: string) =>
  `<div class="kv-public min-h-screen bg-kidville-cream text-kidville-ink"><div>${interno}</div></div>`

/** Un testo è "visibile" se non è nascosto agli occhi o al solo screen reader. */
function nascosto(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = n.classList
    if (c.contains('sr-only') || c.contains('hidden') || n.getAttribute('aria-hidden') === 'true') return true
  }
  return false
}

/**
 * Ogni foglia di TESTO dell'albero renderizzato, col colore e il fondo che
 * vincono davvero la cascata, e il rapporto WCAG fra i due. È la stessa misura
 * che il collaudo fa nel browser sui colori computati, fatta qui sul DOM vero.
 */
function coppieDiTesto(root: Element, hc: boolean) {
  const out: Array<{ testo: string; fg: string; bg: string; rapporto: number }> = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const testo = (n.textContent ?? '').trim()
    const el = n.parentElement
    if (!testo || !el || nascosto(el)) continue
    const fg = coloreTesto(el, hc)
    const bg = sfondo(el, hc)
    out.push({ testo: testo.slice(0, 40), fg, bg, rapporto: contrasto(fg, bg) })
  }
  return out
}

/** Ogni controllo di modulo dell'albero, col contorno risolto. */
function bordiDeiControlli(root: Element, hc: boolean) {
  return Array.from(root.querySelectorAll('input, select, textarea'))
    .filter((el) => !nascosto(el))
    .map((el) => ({ el, bordo: coloreBordo(el, hc), bg: sfondo(el, hc) }))
    .filter((x) => x.bordo !== null)
    .map((x) => ({
      tag: `${x.el.tagName.toLowerCase()}.${(x.el.getAttribute('class') ?? '').slice(0, 60)}`,
      bordo: x.bordo!,
      bg: x.bg,
      rapporto: contrasto(x.bordo!, x.bg),
    }))
}

/** Le pagine PUBBLICHE renderizzabili in jsdom (server component sincroni + wizard). */
const RESE: Array<[string, () => React.ReactElement]> = [
  ['/privacy', () => <PrivacyPage />],
  ['/termini', () => <TerminiPage />],
  ['/assistenza', () => <AssistenzaPage />],
  ['/iscrizione', () => <EnrollmentWizard scuolaId="e2e00000-0000-4000-8000-000000000001" />],
]

const rendi = (fabbrica: () => React.ReactElement, hc: boolean) => montaReact(fabbrica(), hc)

describe('S19 §3 · pagine pubbliche — l\'Alto Contrasto esiste anche prima del login', () => {
  it('CONTROLLO POSITIVO: senza le regole `.kv-public` la pagina NON cambia di un pixel', () => {
    const senzaFix = REGOLE.filter((r) => !r.sel.includes('.kv-public'))
    expect(senzaFix.length, 'il filtro toglie qualcosa').toBeLessThan(REGOLE.length)
    const html = GUSCIO_LEGALE('<p id="sonda" class="text-kidville-muted">Versione: 1</p>')
    const misuraSenza = (hc: boolean) => {
      const el = monta(html, hc)
      return { fg: coloreTesto(el, hc, senzaFix), bg: sfondo(el, hc, senzaFix) }
    }
    const normale = misuraSenza(false)
    const alto = misuraSenza(true)
    expect(alto, 'è il difetto: attivare l\'aiuto non cambia niente').toEqual(normale)
    expect(contrasto(alto.fg, alto.bg)).toBe(2.51)
  })

  it.each(RESE)('%s: in Alto Contrasto nessuna coppia testo/fondo sotto AA', (rotta, fabbrica) => {
    const sotto = coppieDiTesto(rendi(fabbrica, true), true).filter((x) => x.rapporto < 4.5)
    expect(sotto.map((x) => `«${x.testo}» ${x.fg} su ${x.bg} = ${x.rapporto}:1`), rotta).toEqual([])
  }, 30000)

  it.each(RESE)('%s: e nemmeno in luce normale', (rotta, fabbrica) => {
    const sotto = coppieDiTesto(rendi(fabbrica, false), false).filter((x) => x.rapporto < 4.5)
    expect(sotto.map((x) => `«${x.testo}» ${x.fg} su ${x.bg} = ${x.rapporto}:1`), rotta).toEqual([])
  }, 30000)

  it.each(RESE)('%s: ogni controllo ha il contorno ≥ 3:1, in entrambe le modalità', (rotta, fabbrica) => {
    for (const hc of [false, true]) {
      const sotto = bordiDeiControlli(rendi(fabbrica, hc), hc).filter((x) => x.rapporto < 3)
      expect(sotto.map((x) => `${x.tag} → ${x.bordo} su ${x.bg} = ${x.rapporto}:1`), `${rotta} hc=${hc}`).toEqual([])
      cleanup()
    }
  }, 30000)

  it('il bottone d\'invio del modulo pubblico resta leggibile in Alto Contrasto', () => {
    const el = monta(
      GUSCIO_ISCRIZIONE('<button id="sonda" class="bg-kidville-green text-kidville-yellow">AVANTI</button>'),
      true,
    )
    const fg = coloreTesto(el, true)
    const bg = sfondo(el, true)
    expect(contrasto(fg, bg), `${fg} su ${bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it.each(PUBBLICHE)('%s monta il comando di Alto Contrasto e il marcatore di superficie', (_rotta, file) => {
    // Si guarda il CODICE, non i commenti: vedi `codice()`. Con la prosa dentro,
    // togliere il componente lasciava il test verde.
    //
    // ⚠️ IL COMANDO PUÒ ARRIVARE PER DUE STRADE (R13). Dal 2026-08-08 la riga di
    // testa delle pagine pubbliche è un componente unico — `PublicPageHeader` —
    // che porta con sé ritorno E alto contrasto: era il difetto opposto, il
    // ritorno copiato a mano in ogni pagina mentre il contrasto era già
    // condiviso. Montare la riga vale quindi quanto montare il bottone, ma la
    // catena si VERIFICA (riga sotto) invece di darla per buona: se un giorno
    // `PublicPageHeader` smettesse di montare il comando, le quattro pagine
    // resterebbero senza e questo test non se ne accorgerebbe.
    const src = codice(file)
    const viaRiga = src.includes('<PublicPageHeader')
    expect(
      viaRiga || src.includes('<PublicContrastButton'),
      `${file}: nessun comando di Alto Contrasto in pagina (né diretto, né via <PublicPageHeader>)`,
    ).toBe(true)
    if (viaRiga) {
      expect(
        codice('src/components/ui/PublicPageHeader.tsx'),
        'PublicPageHeader non monta più il comando di Alto Contrasto: le pagine che si affidano ' +
        'a lui sono rimaste senza, e nessuna di loro lo saprebbe',
      ).toContain('<PublicContrastButton')
    }
    expect(src, `${file}: manca il marcatore \`kv-public\``).toContain('kv-public')
  })

  /**
   * `/auth/login` È LA SESTA SUPERFICIE PUBBLICA, E IL COMANDO NON C'È.
   *
   * Misurato il 2026-08-02: zero comandi di contrasto nel DOM della schermata
   * d'accesso. Chi apre l'app per la prima volta e ha bisogno dell'alto
   * contrasto per leggere «Email» e «Password» non ha modo di attivarlo — cioè
   * la motivazione scritta in testa a `PublicContrastButton` vale per tutte le
   * superfici pubbliche tranne quella d'ingresso.
   *
   * NON è però una dimenticanza: il comando era stato TOLTO da lì di proposito
   * («la login deve stare in una schermata sola, senza scroll») e la scelta ha
   * il suo lock in `__tests__/components/login-contrast.test.tsx:43`. Rimetterlo
   * è una decisione di prodotto, e questo test la registra invece di ribaltarla
   * di sponda: se un giorno il comando tornerà, saranno DUE i test da cambiare,
   * e chi li cambia leggerà da entrambe le parti il perché.
   *
   * Quello che il test verifica adesso è che il RIMEDIO esista comunque: il tema
   * Alto Contrasto della login c'è ed è corretto (fondo nero, testo bianco,
   * bordi dei campi 15,91:1 — misurato). Manca il comando, non il tema. Se un
   * giorno sparisse anche il tema, il rilievo passerebbe da «scomodo» a
   * «impossibile», e questo `it` diventerebbe rosso.
   */
  it('/auth/login: il comando manca PER SCELTA, ma il tema Alto Contrasto c\'è', () => {
    const src = codice('src/app/auth/login/page.tsx')
    expect(
      src,
      'il comando è tornato sulla login: allora va aggiornato anche ' +
      '`__tests__/components/login-contrast.test.tsx`, che oggi ne pretende l\'assenza',
    ).not.toContain('<PublicContrastButton')
    // Il tema HC della login: è ciò che rende il rilievo «scomodo» e non «letale».
    expect(
      codice('src/app/auth/login/page.module.css'),
      'la login non ha più un tema Alto Contrasto: senza comando E senza tema, ' +
      'la schermata d\'accesso diventa inaccessibile a chi ne ha bisogno',
    ).toContain('high')
  })
})

// =============================================================================
describe('S19 §3bis · il comando pubblico — montato davvero, con etichetta e stato', () => {
  it('ha nome accessibile testuale e dichiara `aria-pressed`', async () => {
    const { PublicContrastButton } = await import('@/components/ui/PublicContrastButton')
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <PublicContrastButton />
      </AccessibilityProvider>,
    )
    const b = screen.getByRole('button', { name: /alto contrasto/i })
    expect(b.getAttribute('aria-pressed')).toBe('false')
    // Non è solo un'icona: l'etichetta è testo, come chiede il rilievo.
    expect(b.textContent?.trim().length ?? 0).toBeGreaterThan(3)
  })

  it('col provider attivo lo STATO segue il contrasto (non è un bottone finto)', async () => {
    const { PublicContrastButton } = await import('@/components/ui/PublicContrastButton')
    render(
      <AccessibilityProvider initialHighContrast>
        <PublicContrastButton />
      </AccessibilityProvider>,
    )
    expect(screen.getByRole('button', { name: /alto contrasto/i }).getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * La pill non si spezza, in nessun contenitore.
   *
   * Misurato il 2026-08-02 su /iscrizione a 390/375/360/320 px: 138,4×58 px con
   * «Alto» e «contrasto» su due righe e la forma pill persa, contro 143,2×38 su
   * una riga sulle quattro pagine legali. Il contenitore del wizard è un flex
   * SENZA `flex-wrap`, quello delle pagine legali ce l'ha: la divergenza è
   * proprio quella che mettere il comando in un posto solo doveva evitare, ed è
   * stata replicata un livello più su. Il rimedio sta nel componente, così vale
   * ovunque venga montato — compreso /auth/login, aggiunta oggi.
   */
  it('non va a capo dentro sé stessa, qualunque sia il contenitore', async () => {
    const { PublicContrastButton } = await import('@/components/ui/PublicContrastButton')
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <PublicContrastButton />
      </AccessibilityProvider>,
    )
    const b = screen.getByRole('button', { name: /alto contrasto/i })
    expect(b.className, 'senza whitespace-nowrap la pill si spezza in due righe').toContain('whitespace-nowrap')
  })

  it('fuori dal provider NON abbatte la pagina: degrada a nulla', async () => {
    // Il modulo d'iscrizione raccoglie dati di minori da ~9 famiglie l'ora: un
    // comando di contorno non può farlo cadere. Vedi il commento nel componente.
    const { PublicContrastButton } = await import('@/components/ui/PublicContrastButton')
    const { container } = render(<PublicContrastButton />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('…e in produzione il provider C\'È: il root layout monta `AccessibilityProvider`', () => {
    // È questo il lock che rende accettabile il degrado qui sopra: se il provider
    // sparisse davvero dal guscio dell'app, il comando smetterebbe di comparire
    // ovunque — e questo test diventa rosso prima che succeda.
    const layout = codice('src/app/layout.tsx')
    expect(layout).toContain('<RootProviders')
    expect(layout).toContain('initialHighContrast')
    const providers = codice('src/components/providers/RootProviders.tsx')
    expect(providers).toContain('<AccessibilityProvider')
  })
})
