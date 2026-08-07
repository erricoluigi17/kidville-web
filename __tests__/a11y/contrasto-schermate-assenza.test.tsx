import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import { btnClass, type BtnVariant } from '@/components/ui/Btn'

// =============================================================================
// Le due schermate «Comunica un'assenza» — i rapporti si MISURANO.
//
// Il collaudo del 2026-08-07 ha trovato tre contrasti sotto soglia che tutta la
// rete di sicurezza esistente lasciava passare:
//
//  1. Il SOTTOTITOLO della card-header (`PageHeaderCard`) sulla fascia gialla:
//     `text-kidville-green-dark/80` = 4,00:1 contro i 4,5:1 di WCAG 1.4.3.
//     Nessuno strumento del repo sapeva leggerlo: Tailwind v4 compila l'alfa in
//     `lab(… / 0.8)`, axe-core restituisce `NaN` su quel formato, e il lock
//     jsdom non composita. Qui l'alfa si COMPONE a mano sul suo fondo, che è
//     ciò che l'occhio vede.
//
//  2. Dieci testi della schermata `/parent/primaria/assenze` dipinti con
//     `text-kidville-muted` (2,51:1 su bianco) — fra cui il motivo scritto dal
//     genitore, la nota del docente e l'orario d'entrata di un ritardo — più le
//     due pillole di stato («Assente» 3,70:1, «✓ Giustificata» 3,30:1).
//
//  3. La SUPERFICIE dei bottoni «soft» (WCAG 1.4.11, soglia 3:1): il fondo di
//     `Btn variant="danger"` contro la riga crema su cui è posato vale 1,03:1 e
//     il bottone non ha né bordo né ombra. È l'unico comando distruttivo della
//     schermata, e non si vede che è un bottone. Idem per `ghost` (1,07:1).
//     ⚠️ Il bordo `border-kidville-error/40` suggerito dal rapporto di collaudo
//     è stato MISURATO e scartato: vale 1,74:1 sulla riga crema, non 3:1.
//
// La sonda risolve anche il RIMAPPO degli inchiostri di stato di `globals.css`
// (`.text-kidville-warn → warn-strong`), altrimenti misurerebbe un colore che a
// schermo non compare mai.
// =============================================================================

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8')

// ── WCAG 2.x §1.4.3 / §1.4.11 — il rapporto di contrasto ────────────────────
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

/** I token `--color-kidville-*` dichiarati in `@theme inline`. */
const TOKEN: Record<string, string> = (() => {
  const blocco = CSS.slice(CSS.indexOf('@theme inline'))
  const out: Record<string, string> = {}
  for (const m of blocco.matchAll(/--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2].toUpperCase()
  }
  return out
})()

/**
 * Il RIMAPPO degli inchiostri di stato: `globals.css` riscrive per intero
 * `.text-kidville-warn` in `warn-strong` (rete del 2026-08-02, misurata da
 * `contrasto-cascata.test.tsx` §6). Senza risolverlo, questa sonda misurerebbe
 * un arancio che a schermo non compare mai e chiederebbe di correggere righe già
 * corrette. Si leggono solo le regole a CLASSE SINGOLA: quelle a discendente
 * (`.kv-tab-giallo .text-kidville-yellow`) dipendono dal contesto.
 */
const RIMAPPO: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  const senzaCommenti = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  // Si spezza sulle graffe di chiusura invece di usare una regex con `}` in
  // testa: `matchAll` consuma la graffa che chiude la regola precedente, e due
  // regole adiacenti — che è esattamente il caso qui — la seconda non la
  // troverebbe mai. Un blocco dentro un'at-rule finisce col prelude nel
  // selettore e viene scartato dal confronto stretto qui sotto.
  for (const blocco of senzaCommenti.split('}')) {
    const graffa = blocco.indexOf('{')
    if (graffa < 0) continue
    const selettore = blocco.slice(0, graffa).trim()
    const corpo = blocco.slice(graffa + 1)
    const colore = corpo.match(/(?:^|;)\s*color\s*:\s*var\(\s*--color-kidville-([a-z0-9-]+)\s*\)/)
    if (!colore) continue
    const parti = selettore.split(',').map((s) => s.trim()).filter(Boolean)
    // SOLO classe singola: `.kv-tab-giallo .text-kidville-green` dipende dal
    // contesto e non è un rimappo universale.
    const nomi = parti.map((p) => {
      const m =
        p.match(/^\.text-kidville-([a-z0-9-]+)$/) ??
        p.match(/^\[class\*="text-kidville-([a-z0-9-]+)\/"\]$/)
      return m ? m[1] : null
    })
    if (nomi.some((n) => n === null)) continue
    for (const n of nomi) out[n!] = colore[1]
  }
  return out
})()

/** L'inchiostro EFFETTIVO di un elemento: token della classe, rimappo, alfa. */
function inchiostro(el: Element): { token: string; hex: string; alfa: number } | null {
  for (const c of Array.from(el.classList)) {
    const m = c.match(/^text-kidville-([a-z0-9-]+?)(?:\/(\d{1,3}))?$/)
    if (!m) continue
    const scritto = m[1]
    const effettivo = RIMAPPO[scritto] ?? scritto
    const hex = TOKEN[effettivo]
    if (!hex) continue
    return { token: scritto, hex, alfa: m[2] ? Number(m[2]) / 100 : 1 }
  }
  return null
}

/**
 * La superficie su cui quell'elemento è posato. Si risale finché non si trova un
 * fondo dichiarato; il default è la CREMA, che è il fondo del `<body>`
 * (`globals.css`: `body { background-color: var(--color-kidville-cream) }`).
 */
function fondo(el: Element): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    for (const c of Array.from(n.classList)) {
      if (c === 'bg-white') return '#FFFFFF'
      const m = c.match(/^bg-kidville-([a-z0-9-]+)$/)
      if (m && TOKEN[m[1]]) return TOKEN[m[1]]
    }
  }
  return TOKEN.cream
}

/**
 * La SOGLIA applicabile a quel testo. WCAG 1.4.3 chiede 4,5:1 al testo normale e
 * 3:1 al «testo grande» — ≥24px, oppure ≥18,66px se in grassetto. Ignorarlo
 * renderebbe la sonda bugiarda in entrambi i versi: chiederebbe 4,5:1 al titolo
 * di pagina (Barlow 900 a 30px, dove la coppia di marchio verde-su-giallo vale
 * 4,05:1 ed è a norma) e non saprebbe distinguerlo da una pillola da 11px.
 */
const PX_TAILWIND: Record<string, number> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48,
}
function soglia(el: Element): { valore: number; px: number; grassetto: boolean } {
  let px = 16 // `font-size` di partenza del documento
  let grassetto = false
  const catena: Element[] = []
  for (let n: Element | null = el; n; n = n.parentElement) catena.unshift(n)
  for (const n of catena) {
    for (const c of Array.from(n.classList)) {
      const arb = c.match(/^text-\[([\d.]+)px\]$/)
      if (arb) px = Number(arb[1])
      else {
        const nome = c.match(/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/)
        if (nome) px = PX_TAILWIND[nome[1]]
      }
      // Solo il grassetto VERO (≥700): `font-semibold` è 600 e per WCAG non è bold.
      if (/^font-(bold|extrabold|black)$/.test(c)) grassetto = true
      else if (/^font-(thin|light|normal|medium|semibold)$/.test(c)) grassetto = false
    }
  }
  return { valore: px >= 24 || (px >= 18.66 && grassetto) ? 3 : 4.5, px, grassetto }
}

/** Ogni nodo di TESTO dell'albero che dichiara un inchiostro tokenizzato. */
function sondaTesti(radice: ParentNode) {
  const out: {
    el: Element; testo: string; token: string; fg: string; bg: string
    rapporto: number; soglia: number; px: number
  }[] = []
  for (const el of Array.from(radice.querySelectorAll('*'))) {
    const ink = inchiostro(el)
    if (!ink) continue
    const testo = (el.textContent ?? '').trim()
    if (!testo) continue
    const bg = fondo(el)
    const fg = ink.alfa < 1 ? composita(ink.hex, bg, ink.alfa) : ink.hex
    const s = soglia(el)
    out.push({ el, testo, token: ink.token, fg, bg, rapporto: contrasto(fg, bg), soglia: s.valore, px: s.px })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// §0 — La sonda, prima di misurare, si dimostra.
// ─────────────────────────────────────────────────────────────────────────────
describe('§0 · la sonda misura davvero', () => {
  it('legge i token e ritrova le misure note della palette', () => {
    expect(TOKEN.green).toBe('#006A5F')
    expect(TOKEN.yellow).toBe('#FDC400')
    expect(TOKEN.cream).toBe('#FEF1E4')
    expect(contrasto(TOKEN.muted, '#FFFFFF')).toBe(2.51)
    expect(contrasto(TOKEN.sub, '#FFFFFF')).toBe(6.46)
    expect(contrasto(TOKEN['error-strong'], TOKEN['error-soft'])).toBe(4.92)
  })

  it('compone l\'alfa sul fondo invece di ignorarla', () => {
    // È il pezzo che manca a tutta la rete esistente: senza compositing,
    // `green-dark/80` verrebbe misurato come `green-dark` pieno (5,52:1) e il
    // difetto sarebbe invisibile.
    expect(composita(TOKEN['green-dark'], TOKEN.yellow, 0.8)).toBe('#336A3C')
    expect(contrasto(TOKEN['green-dark'], TOKEN.yellow)).toBe(5.52)
    expect(contrasto(composita(TOKEN['green-dark'], TOKEN.yellow, 0.8), TOKEN.yellow)).toBe(4)
  })

  it('risolve il RIMAPPO degli inchiostri di stato di globals.css', () => {
    // Senza questo, la sonda chiederebbe di correggere `text-kidville-warn`,
    // che a schermo è già `warn-strong` dal 2026-08-02.
    expect(RIMAPPO.warn).toBe('warn-strong')
    expect(RIMAPPO['yellow-dark']).toBe('yellow-strong')
    // …e NON inventa rimappi che non ci sono: `error` e `success` restano quelli.
    expect(RIMAPPO.error).toBeUndefined()
    expect(RIMAPPO.success).toBeUndefined()
    expect(RIMAPPO.muted).toBeUndefined()
  })

  it('applica la soglia del TESTO GRANDE solo dove spetta (WCAG 1.4.3)', () => {
    document.body.innerHTML =
      '<h1 id="grande" class="text-3xl font-black">T</h1>' +
      '<p id="normale" class="text-xs">t</p>' +
      '<span id="pill" class="text-[11px] font-semibold">p</span>' +
      '<div class="text-lg"><b id="ereditato" class="font-bold">e</b></div>'
    expect(soglia(document.getElementById('grande')!)).toEqual({ valore: 3, px: 30, grassetto: true })
    expect(soglia(document.getElementById('normale')!).valore).toBe(4.5)
    // `font-semibold` è 600: per WCAG non è grassetto, e a 11px la soglia resta 4,5:1.
    expect(soglia(document.getElementById('pill')!)).toEqual({ valore: 4.5, px: 11, grassetto: false })
    // 18px in grassetto NON arriva ai 18,66px richiesti.
    expect(soglia(document.getElementById('ereditato')!)).toEqual({ valore: 4.5, px: 18, grassetto: true })
    document.body.innerHTML = ''
  })

  it('risale al fondo dichiarato, e in mancanza usa la crema del body', () => {
    document.body.innerHTML =
      '<div class="bg-kidville-error-soft"><span id="a" class="text-kidville-error">x</span></div>' +
      '<p id="b" class="text-kidville-muted">y</p>'
    expect(fondo(document.getElementById('a')!)).toBe(TOKEN['error-soft'])
    expect(fondo(document.getElementById('b')!)).toBe(TOKEN.cream)
    document.body.innerHTML = ''
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Il SOTTOTITOLO della card-header, sulla fascia gialla.
// ─────────────────────────────────────────────────────────────────────────────
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'

describe('§1 · PageHeaderCard — il sottotitolo si legge sulla fascia gialla (WCAG 1.4.3)', () => {
  afterEach(cleanup)

  /** Il nodo del sottotitolo, dal componente VERO (non da un markup ricopiato). */
  function sottotitolo() {
    const { container } = render(
      <PageHeaderCard eyebrow="SEGNALA ASSENZA" title="Assenze" subtitle="Comunica un'assenza alla scuola" />,
    )
    const nodo = Array.from(container.querySelectorAll('div')).find(
      (d) => (d.textContent ?? '').trim() === "Comunica un'assenza alla scuola",
    )
    expect(nodo, 'il sottotitolo non è a schermo: il componente è cambiato').toBeTruthy()
    return nodo!
  }

  it('CONTROLLO POSITIVO: il colore di ieri (`green-dark/80`) misura 4,00:1 — è il difetto', () => {
    // Senza questa riga «≥ 4,5:1» direbbe solo che la sonda non ha trovato nulla.
    const finto = document.createElement('p')
    finto.className = 'text-kidville-green-dark/80'
    finto.textContent = 'x'
    const banda = document.createElement('div')
    banda.className = 'bg-kidville-yellow'
    banda.appendChild(finto)
    document.body.appendChild(banda)
    const [m] = sondaTesti(banda)
    expect(m.rapporto).toBe(4)
    expect(m.rapporto).toBeLessThan(4.5)
    banda.remove()
  })

  it('il sottotitolo REALE regge AA sulla fascia gialla', () => {
    const nodo = sottotitolo()
    const ink = inchiostro(nodo)
    expect(ink, 'il sottotitolo non dichiara nessun token di inchiostro').toBeTruthy()
    const bg = fondo(nodo)
    expect(bg, 'il sottotitolo non è posato sulla fascia gialla').toBe(TOKEN.yellow)
    const fg = ink!.alfa < 1 ? composita(ink!.hex, bg, ink!.alfa) : ink!.hex
    expect(contrasto(fg, bg), `${fg} su ${bg} (token ${ink!.token}, alfa ${ink!.alfa})`).toBeGreaterThanOrEqual(4.5)
  })

  it('e l\'inchiostro non porta più un\'alfa che si mangia il margine', () => {
    // La causa radice non è il token: è l'opacità DECORATIVA applicata a un
    // inchiostro che a piena opacità stava già stretto (5,52:1 → 4,00:1).
    const ink = inchiostro(sottotitolo())
    expect(ink!.alfa, `il sottotitolo è ancora al ${ink!.alfa * 100}% di opacità`).toBe(1)
  })

  it('l\'Alto Contrasto continua a raggiungere quell\'inchiostro (non è uscito dal remap)', () => {
    // Sulla card-header nera dell'Alto Contrasto le utility colore NON si
    // ribaltano da sole (`@theme inline` inlina l'hex): il testo verde vive solo
    // perché `globals.css` lo rimappa esplicitamente a #FFFFFF. Cambiare token
    // senza aggiornare quella riga creerebbe un difetto NUOVO proprio nella
    // modalità pensata per chi fatica a leggere.
    const ink = inchiostro(sottotitolo())!
    const regola = CSS.match(
      /\[data-contrast="high"\]\s+\.kv-tab-giallo[^{]*\{[^}]*color\s*:\s*#FFFFFF[^}]*\}/i,
    )
    expect(regola, 'manca il blocco che ribalta a bianco i testi verdi della card-header in HC').toBeTruthy()
    const selettori = CSS.slice(0, CSS.indexOf(regola![0]) + regola![0].length)
    const bloccoHC = selettori.slice(selettori.lastIndexOf('}', selettori.lastIndexOf(regola![0])) + 1)
    expect(
      bloccoHC.includes(`.text-kidville-${ink.token}`),
      `in Alto Contrasto \`text-kidville-${ink.token}\` non viene ribaltato a bianco: ` +
        'sulla card-header nera resterebbe verde scuro su nero',
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — La SUPERFICIE dei bottoni «soft» (WCAG 1.4.11, soglia 3:1).
// ─────────────────────────────────────────────────────────────────────────────
describe('§2 · Btn — un comando si vede che è un comando (WCAG 1.4.11)', () => {
  /** Le superfici su cui questi due bottoni sono davvero posati. */
  const SUPERFICI = ['white', 'cream'] as const
  const SOFT: BtnVariant[] = ['ghost', 'danger']

  const classi = (v: BtnVariant) => btnClass(v, 'sm').split(/\s+/)
  const bordo = (v: BtnVariant) => classi(v).find((c) => /^border-kidville-/.test(c))?.replace('border-kidville-', '')
  const riempimento = (v: BtnVariant) => classi(v).find((c) => /^bg-kidville-/.test(c))!.replace('bg-kidville-', '')

  it('CONTROLLO POSITIVO: il solo RIEMPIMENTO non basta — 1,03:1 sulla riga crema', () => {
    // È il difetto misurato in pagina: la pillola sparisce nel fondo della riga
    // e dell'unico comando distruttivo resta la sola scritta rossa.
    expect(contrasto(TOKEN['error-soft'], TOKEN.cream)).toBe(1.03)
    expect(contrasto(TOKEN['green-soft'], TOKEN.cream)).toBe(1.07)
  })

  it('CONTROLLO POSITIVO: `border-kidville-error/40` (il bordo proposto) NON arriva a 3:1', () => {
    // Misurato, non dedotto: sulla riga crema vale 1,74:1. Un'alfa applicata a
    // un rosso su fondo chiaro consuma quasi tutto il contorno.
    expect(contrasto(composita(TOKEN.error, TOKEN.cream, 0.4), TOKEN.cream)).toBe(1.74)
  })

  it.each(SOFT)('«%s» dichiara un CONTORNO tokenizzato', (v) => {
    expect(classi(v), `variante ${v}: manca la classe \`border\``).toContain('border')
    expect(
      bordo(v),
      `variante ${v}: nessun \`border-kidville-*\`. Il riempimento vale ${contrasto(
        TOKEN[riempimento(v)],
        TOKEN.cream,
      )}:1 sulla riga crema — senza contorno il bottone non si distingue dal fondo.`,
    ).toBeTruthy()
  })

  it.each(SOFT)('«%s»: il contorno tiene 3:1 su bianco E su crema', (v) => {
    const b = bordo(v)
    expect(b, `variante ${v} senza contorno`).toBeTruthy()
    for (const s of SUPERFICI) {
      expect(
        contrasto(TOKEN[b!], TOKEN[s]),
        `${v}: bordo ${b} (${TOKEN[b!]}) su ${s} (${TOKEN[s]})`,
      ).toBeGreaterThanOrEqual(3)
    }
    // …e anche contro il proprio riempimento, che è l'altro lato del confine.
    expect(contrasto(TOKEN[b!], TOKEN[riempimento(v)]), `${v}: bordo su riempimento`).toBeGreaterThanOrEqual(3)
  })

  it('il contorno non tocca l\'INCHIOSTRO: le coppie testo/fondo restano quelle misurate', () => {
    expect(classi('danger')).toContain('bg-kidville-error-soft')
    expect(classi('danger')).toContain('text-kidville-error-strong')
    expect(classi('ghost')).toContain('bg-kidville-green-soft')
    expect(classi('ghost')).toContain('text-kidville-green')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — La schermata `/parent/primaria/assenze`, montata davvero.
// ─────────────────────────────────────────────────────────────────────────────
const stub = vi.hoisted(() => ({
  pathname: '/parent/primaria/assenze',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
  useParentIdentity: () => ({ parentId: 'p-1', studentId: 's-1', figliIds: ['s-1'], ready: true }),
}))

vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, string>> = {
    parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
    shared: (await import('../../messages/it/shared.json')).default,
  }
  const risolvi = (ns: string | undefined, key: string): string =>
    (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
  const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
    modello.replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero))
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori)
    return Object.assign(t, { rich: t, markup: t, raw: (k: string) => risolvi(ns, k), has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

import AssenzeGenitorePage from '@/app/(dashboard)/parent/primaria/assenze/page'
import itPrimaria from '../../messages/it/parentPrimaria.json'

/** Una cronologia che accende TUTTE le righe di testo della schermata. */
const CRONOLOGIA = [
  {
    id: 'p-1', data: '2026-06-02', stato: 'assente',
    orario_entrata: null, orario_uscita: null,
    giustificata: false, giustificazione_testo: 'Visita medica',
    giustificata_il: null, note_appello: 'Rientrato nel pomeriggio',
  },
  {
    id: 'p-2', data: '2026-06-03', stato: 'ritardo',
    orario_entrata: '2026-06-03T09:15:00Z', orario_uscita: null,
    giustificata: true, giustificazione_testo: null,
    giustificata_il: '2026-06-04T08:00:00Z', note_appello: null,
  },
  {
    id: 'p-3', data: '2026-06-04', stato: 'uscita_anticipata',
    orario_entrata: null, orario_uscita: '2026-06-04T12:30:00Z',
    giustificata: true, giustificazione_testo: null,
    giustificata_il: '2026-06-05T08:00:00Z', note_appello: null,
  },
]

const fetchMock = vi.fn()
let otpOk = true

beforeEach(() => {
  vi.clearAllMocks()
  otpOk = true
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/giustifica/otp')) {
      return Promise.resolve({
        ok: otpOk,
        status: otpOk ? 200 : 429,
        json: async () =>
          otpOk
            ? { success: true, data: { ticket: 't', expiry: 1, devCode: '123456' } }
            : { error: 'troppe', codice: 'TROPPE_RICHIESTE' },
      })
    }
    if (url.includes('/api/parent/primaria/assenze')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          success: true, data: CRONOLOGIA,
          riepilogo: { presente: 120, assente: 3, ritardo: 1, uscita_anticipata: 1 },
        }),
      })
    }
    if (url.includes('/api/parent/presenze')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: {
            comunicate: [{ id: 'c-1', data: '2026-08-12', giustificazione_testo: 'Febbre', stato: 'assente' }],
            comunicateLette: true,
          },
        }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }), })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

/** Tutti i testi della schermata che sono sotto soglia, con la loro misura. */
function sottoSoglia(container: HTMLElement) {
  return sondaTesti(container)
    .filter((m) => m.rapporto < m.soglia)
    .map(
      (m) =>
        `«${m.testo.slice(0, 48)}» ${m.token} ${m.fg} su ${m.bg} = ${m.rapporto}:1 ` +
        `(serve ${m.soglia}:1 a ${m.px}px)`,
    )
}

describe('§3 · /parent/primaria/assenze — ogni testo regge AA sulla propria superficie', () => {
  it('CONTROLLO POSITIVO: la sonda vede davvero i testi della pagina', async () => {
    const { container } = render(<AssenzeGenitorePage />)
    await screen.findByText(itPrimaria.assenzeSezioneTitolo)
    // Una sonda cieca farebbe passare qualunque cosa.
    expect(sondaTesti(container).length).toBeGreaterThan(8)
  })

  it('la cronologia, il riepilogo e le pillole di stato: nessun testo sotto 4,5:1', async () => {
    const { container } = render(<AssenzeGenitorePage />)
    await screen.findByText(itPrimaria.assenzeSezioneTitolo)
    await screen.findByText(/Visita medica/)

    expect(
      sottoSoglia(container),
      'Testi sotto WCAG AA. `text-kidville-muted` vale 2,51:1 su bianco: il token del testo ' +
        'secondario è `text-kidville-sub` (6,46:1). Per gli stati ci sono già `error-strong` ' +
        '(4,92:1) e `success-strong` (7,87:1), usati dieci righe più su nei riquadri di riepilogo.',
    ).toEqual([])
  })

  it('anche il flusso OTP — dove un COMANDO era dipinto di grigio (1.4.11)', async () => {
    const { container } = render(<AssenzeGenitorePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itPrimaria.assenzeGiustifica, 'i') }))
    await screen.findByText(itPrimaria.otpIstruzione)

    expect(sottoSoglia(container)).toEqual([])

    // Il bottone «Annulla» del flusso non era un bottone: testo grigio nudo,
    // senza fondo né bordo — WCAG 1.4.11 oltre a 1.4.3.
    const annulla = screen.getByRole('button', { name: itPrimaria.annulla })
    expect(
      annulla.className,
      'il comando che annulla la giustifica non ha nessuna forma di bottone: ' +
        'usa `Btn`, che porta riempimento e contorno tokenizzati',
    ).toMatch(/rounded-pill/)
  })

  it('anche la fascia di esito — riuscito e rifiutato', async () => {
    otpOk = false
    const { container } = render(<AssenzeGenitorePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itPrimaria.assenzeGiustifica, 'i') }))
    await waitFor(() => expect(screen.getByText(/troppe richieste/i)).toBeInTheDocument())

    expect(sottoSoglia(container)).toEqual([])
  })
})
