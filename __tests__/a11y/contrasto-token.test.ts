import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'

// =============================================================================
// S16 — Il contrasto si corregge ALLA RADICE (a11y F5, F6, F7, F10).
//
// Il collaudo del 2026-07-31 ha misurato, sui colori COMPUTATI nel browser:
//   · 12 coppie sotto AA dentro la modale «Nuovo avviso»
//   ·  9 su /admin/avvisi
//   ·  8 su /admin/students?tab=sections
//   · una banda NERA larga 40px che, in Alto Contrasto, copre la prima lettera
//     di ogni riga delle tabelle admin (10 schermate)
//   · il numero KPI giallo su bianco a 1,61:1
//
// Due assunti scritti NEI COMMENTI del codice erano falsi, ed è per quello che
// il difetto è arrivato in produzione col gate verde:
//   (a) «il colore-coperchio è il token superficie → si ribalta da solo in Alto
//       Contrasto». FALSO: la superficie della tabella è `bg-kidville-white`,
//       che `@theme inline` ha già inlinato a #FFFFFF e che quindi NON segue il
//       rimappaggio del token. Coperchio nero su tavolo bianco.
//   (b) `--color-kidville-muted` è dichiarato «decorativo» ma è usato come
//       inchiostro delle etichette: 2,51:1 su bianco, 2,27:1 su crema.
//
// Questo file non asserisce «la classe è cambiata»: calcola i RAPPORTI DI
// CONTRASTO veri dai token dichiarati in `globals.css`, e accanto a ogni
// asserzione negativa mette il controllo POSITIVO che dimostra che la sonda
// stava davvero guardando qualcosa (il token debole è misurato ed è sotto
// soglia; il file esiste e contiene il token forte; la regola di copertura
// esiste davvero).
// =============================================================================

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8')

// ── WCAG 2.x — rapporto di contrasto (§1.4.3) ────────────────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const luminanza = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
/** Rapporto di contrasto fra due colori opachi, arrotondato a 2 decimali. */
export const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}

// ── Parser CSS minimo: regole + contesto delle at-rule che le contengono ─────
type Regola = { selettore: string; corpo: string; contesto: string[] }

/**
 * Estrae le regole di un foglio di stile con il loro CONTESTO (la catena di
 * at-rule che le racchiude). Serve a due cose in questo file: sapere se una
 * regola sta dentro un `@layer` (le utility Tailwind ci stanno, le regole
 * scritte a mano no) e leggere i token dichiarati nei blocchi.
 */
export function regole(css: string, contesto: string[] = []): Regola[] {
  const testo = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Regola[] = []
  let buf = ''
  let i = 0
  while (i < testo.length) {
    const c = testo[i]
    if (c === '{') {
      let profondita = 1
      let k = i + 1
      while (k < testo.length && profondita > 0) {
        if (testo[k] === '{') profondita++
        else if (testo[k] === '}') profondita--
        k++
      }
      const selettore = buf.trim().replace(/\s+/g, ' ')
      const corpo = testo.slice(i + 1, k - 1)
      // Un corpo che contiene altre graffe è un contenitore (@media/@layer/@supports).
      if (corpo.includes('{')) out.push(...regole(corpo, [...contesto, selettore]))
      else out.push({ selettore, corpo, contesto })
      buf = ''
      i = k
      continue
    }
    // `}` chiude un blocco, `;` chiude una at-rule senza corpo (`@import …;`):
    // in entrambi i casi quello che si è accumulato NON è un selettore.
    if (c === '}' || c === ';') { buf = ''; i++; continue }
    buf += c
    i++
  }
  return out
}

const REGOLE = regole(CSS)

/** I token `--color-kidville-*` dichiarati in un blocco. */
function token(selettore: string): Record<string, string> {
  const blocco = REGOLE.find((r) => r.selettore === selettore)
  expect(blocco, `blocco «${selettore}» presente in globals.css`).toBeTruthy()
  const out: Record<string, string> = {}
  for (const m of blocco!.corpo.matchAll(/--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]] = m[2].toUpperCase()
  }
  return out
}

const T = token('@theme inline')
const T_HC = token('[data-contrast="high"]')

const leggi = (p: string) => fs.readFileSync(path.join(RADICE, p), 'utf8')

/**
 * Il sorgente SENZA commenti. I lock di questo file guardano il codice, non la
 * prosa che lo spiega: un commento che cita il difetto storico («era
 * `text-kidville-muted`», «era un rosso Tailwind») è documentazione utile, non
 * una regressione, e non deve far diventare rosso il gate.
 */
const codice = (p: string) =>
  leggi(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '')

/** I file di S16 che portavano testo informativo in `muted`. */
const FILE_S16 = [
  'src/app/(dashboard)/admin/avvisi/page.tsx',
  'src/app/(dashboard)/teacher/avvisi/page.tsx',
  'src/components/features/admin/SezioniMultiSelect.tsx',
  'src/components/features/admin/primaria/GiudiziManager.tsx',
  'src/components/features/admin/settings/SettingsPanel.tsx',
  'src/components/features/admin/ScrollableStudentForm.tsx',
]

// =============================================================================
describe('S16 · i token — la scala di contrasto è quella dichiarata, non quella sperata', () => {
  it('CONTROLLO POSITIVO: `muted` è sotto AA su TUTTE le superfici chiare (è il difetto)', () => {
    // Se un giorno qualcuno scurisce `--color-kidville-muted`, questo controllo
    // diventa rosso e va riletto: la sostituzione con `sub` potrebbe non servire
    // più. Finché è verde, `muted` NON può fare da inchiostro.
    expect(contrasto(T.muted, T.white)).toBeLessThan(4.5)
    expect(contrasto(T.muted, T.cream)).toBeLessThan(4.5)
    expect(contrasto(T.muted, T.line)).toBeLessThan(4.5)
  })

  it('`sub` regge AA su bianco, crema e linea — è il token da usare per le etichette', () => {
    expect(contrasto(T.sub, T.white)).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(T.sub, T.cream)).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(T.sub, T.line)).toBeGreaterThanOrEqual(4.5)
  })

  it('errore: il token debole è sotto soglia sulla propria fascia, il forte no', () => {
    expect(contrasto(T.error, T['error-soft'])).toBeLessThan(4.5)          // 3,70:1
    expect(contrasto(T['error-strong'], T['error-soft'])).toBeGreaterThanOrEqual(4.5) // 4,92:1
  })

  it('info: stessa forma — il badge «Adesione» va sul token forte', () => {
    expect(contrasto(T.info, T['info-soft'])).toBeLessThan(4.5)            // 4,20:1
    expect(contrasto(T['info-strong'], T['info-soft'])).toBeGreaterThanOrEqual(4.5) // 6,74:1
  })

  it('il giallo NON è un inchiostro su bianco nemmeno per il testo grande (soglia 3:1)', () => {
    expect(contrasto(T.yellow, T.white)).toBeLessThan(3)                   // 1,61:1
    expect(contrasto(T.green, T.white)).toBeGreaterThanOrEqual(4.5)        // 6,51:1
  })
})

// =============================================================================
describe('S16 · etichette e testo informativo — `muted` non fa più da inchiostro', () => {
  it.each(FILE_S16)('%s non usa più `text-kidville-muted`', (f) => {
    const src = codice(f)
    // Controllo POSITIVO: il file esiste, è quello giusto ed è tokenizzato.
    // Senza, l'asserzione negativa passerebbe anche su un file rinominato o vuoto.
    expect(src, `${f}: il file non contiene token di testo — sonda cieca`).toContain('text-kidville-sub')
    expect(src.split(/\s|"|'|`/)).not.toContain('text-kidville-muted')
  })
})

// =============================================================================
describe('S16 · le fasce d\'errore usano il token forte', () => {
  /** Le classi di ogni elemento con `role="alert"` del file. */
  const fasce = (src: string) =>
    Array.from(src.matchAll(/<[a-zA-Z]+[^>]*\brole="alert"[^>]*>/g))
      .map((m) => m[0].match(/className="([^"]*)"/)?.[1] ?? '')
      .filter((c) => c.includes('bg-kidville-error-soft'))
      .map((c) => c.split(/\s+/))

  const CON_FASCIA = [
    'src/app/(dashboard)/admin/avvisi/page.tsx',
    'src/app/(dashboard)/teacher/avvisi/page.tsx',
    'src/components/features/admin/primaria/GiudiziManager.tsx',
    'src/components/features/admin/settings/SettingsPanel.tsx',
    // Entrato il 2026-08-12. La scheda staff aveva DUE fasce rosse e una sola era
    // giusta: quella dell'anagrafica a 4,92:1 con `role="alert"`, e quella che
    // SOSTITUISCE l'intera scheda a **3,70:1** senza alert — cioè l'unica a
    // schermo intero, e l'unica muta. Il rilevatore qui sotto cerca proprio
    // `role="alert"`: finché quell'attributo mancava, aggiungere il file a questo
    // elenco non avrebbe misurato niente (`trovate.length` a zero, che il
    // controllo positivo fa fallire). Le due cose andavano fatte insieme.
    'src/components/features/admin/StaffDetailPanel.tsx',
    // Entrato il 2026-09-04, con la stessa forma e per la stessa ragione della
    // riga qui sopra: la scheda del BAMBINO aveva anche lei due fasce rosse su
    // `error-soft`, entrambe con l'inchiostro DEBOLE a **3,70:1** — quella
    // nuova dell'esito dello spostamento di sede e quella, già lì, del rifiuto
    // dell'archiviazione. Una riga nuova non rifinanzia un debito vecchio: si
    // sono raddrizzate insieme, perché il lock guarda TUTTE le fasce del file e
    // aggiungerlo lasciandone una storta sarebbe stato aggiungere un rosso.
    //
    // ⚠️ IL DEBITO CHE RESTA, DICHIARATO E NON NASCOSTO: nel blocco delle
    // segnalazioni la stessa scheda porta ancora `text-kidville-success` su
    // `bg-kidville-success-soft/50` e su `/20` (le pillole «Risolto» e la nota
    // di chiusura). Sono PREGRESSE, non hanno `role="alert"` e questo
    // rilevatore non le vede: chi le raddrizzerà tolga anche questo capoverso.
    'src/components/features/admin/StudentDetailPanel.tsx',
  ]

  it.each(CON_FASCIA)('%s: la fascia su `error-soft` porta `error-strong`', (f) => {
    const trovate = fasce(codice(f))
    // Controllo POSITIVO: la fascia esiste davvero. Se sparisce (o cambia forma)
    // il test deve diventare rosso, non passare a vuoto.
    expect(trovate.length, `${f}: nessun role="alert" su bg-kidville-error-soft`).toBeGreaterThan(0)
    for (const classi of trovate) {
      expect(classi).toContain('text-kidville-error-strong')
      expect(classi).not.toContain('text-kidville-error')
    }
  })
})

// =============================================================================
// L'ESITO DI UNO SPOSTAMENTO DI SEDE (2026-09-04).
//
// La fascia rossa la coglie `CON_FASCIA` qui sopra, perché ha `role="alert"`.
// Quella VERDE no — è un `role="status"` — e senza queste righe l'unico rilievo
// sul successo sarebbe l'occhio di chi rilegge il diff. È testo `text-xs` che
// dice a un'operatrice se il bambino è stato spostato di plesso o no.
//
// ⚠️ SI MISURA IL COLORE CHE SI VEDE, non il token. La fascia è
// `bg-kidville-success-soft/30` sopra `bg-kidville-cream`: misurare il token
// pieno direbbe 3,49:1 — un numero vero su un colore che a schermo non c'è.
// Appiattito sulla crema fa **2,95:1**, ed è il numero del rilievo.
// =============================================================================
describe('S16 · lo spostamento di sede — anche la fascia VERDE sta sopra AA', () => {
  /** Un colore con alpha appiattito sulla superficie opaca che gli sta sotto. */
  const su = (colore: string, sotto: string, alpha: number) => {
    const [sopra, fondo] = [rgb(colore), rgb(sotto)]
    const misto = (i: number) => Math.round(sopra[i] * alpha + fondo[i] * (1 - alpha))
    return `#${[0, 1, 2].map((i) => misto(i).toString(16).padStart(2, '0')).join('').toUpperCase()}`
  }

  /** La superficie vera della fascia di successo: `success-soft` al 30% sulla crema. */
  const FASCIA = su(T['success-soft'], T.cream, 0.3)

  it('CONTROLLO POSITIVO: la sonda dell\'alpha non inventa — 0% è la crema, 100% è il token', () => {
    expect(su(T['success-soft'], T.cream, 0)).toBe(T.cream)
    expect(su(T['success-soft'], T.cream, 1)).toBe(T['success-soft'])
  })

  it('CONTROLLO POSITIVO: `success` su quella fascia è 2,95:1 (è il difetto), `success-strong` 7,04:1', () => {
    expect(contrasto(T.success, FASCIA)).toBe(2.95)
    expect(contrasto(T['success-strong'], FASCIA)).toBe(7.04)
    expect(contrasto(T.success, FASCIA)).toBeLessThan(4.5)
    expect(contrasto(T['success-strong'], FASCIA)).toBeGreaterThanOrEqual(4.5)
  })

  it('StudentDetailPanel: la fascia di esito su `success-soft` porta l\'inchiostro FORTE', () => {
    const trovate = Array.from(
      codice('src/components/features/admin/StudentDetailPanel.tsx').matchAll(
        /<[a-zA-Z]+[^>]*\brole="status"[^>]*>/g,
      ),
    )
      .map((m) => m[0].match(/className="([^"]*)"/)?.[1] ?? '')
      .filter((c) => c.includes('bg-kidville-success-soft'))
      .map((c) => c.split(/\s+/))
    // Controllo POSITIVO: la fascia esiste. Se sparisce, questo test deve
    // diventare rosso e non passare a vuoto.
    expect(trovate.length, 'nessun role="status" su bg-kidville-success-soft').toBeGreaterThan(0)
    for (const classi of trovate) {
      expect(classi).toContain('text-kidville-success-strong')
      expect(classi).not.toContain('text-kidville-success')
    }
  })
})

// =============================================================================
describe('S16 · il badge «Adesione»', () => {
  it('/admin/avvisi: il badge «Adesione» passa da `info` a `info-strong`', () => {
    const src = codice('src/app/(dashboard)/admin/avvisi/page.tsx')
    expect(src).toContain('bg-kidville-info-soft')          // controllo positivo
    expect(src.split(/\s|"|'|`/)).not.toContain('text-kidville-info')
    expect(src).toContain('text-kidville-info-strong')
  })
})

// =============================================================================
describe('S16 · Alto Contrasto — nessun coperchio NERO su una superficie chiara', () => {
  /**
   * Le regole, FUORI da `[data-contrast="high"]`, che usano
   * `var(--color-kidville-white)` come colore di COPERTURA (sfondo o gradiente).
   * In Alto Contrasto quel token vale #000000: se la superficie sotto NON si
   * ribalta (e non si ribalta, perché è la utility `bg-white`/`bg-kidville-white`
   * con l'hex già inlinato da `@theme inline`), il coperchio diventa una banda
   * nera sopra il testo. È la causa radice di a11y F6.
   */
  const coperture = REGOLE.filter(
    (r) =>
      !r.selettore.includes('[data-contrast="high"]') &&
      !r.contesto.some((c) => c.includes('[data-contrast="high"]')) &&
      /background(-image|-color)?\s*:/.test(r.corpo) &&
      r.corpo.includes('var(--color-kidville-white)'),
  )

  it('CONTROLLO POSITIVO: in Alto Contrasto il token bianco È nero, e la sonda trova le coperture', () => {
    expect(T_HC.white).toBe('#000000')
    expect(coperture.map((r) => r.selettore)).toContain('.kv-table-scroll')
  })

  it.each(coperture.map((r) => r.selettore))(
    '«%s» ha la sua regola esplicita in Alto Contrasto, col colore della superficie VERA',
    (selettore) => {
      const hc = REGOLE.filter(
        (r) => r.selettore.includes('[data-contrast="high"]') && r.selettore.includes(selettore),
      )
      expect(hc.length, `manca [data-contrast="high"] ${selettore}`).toBeGreaterThan(0)
      const corpo = hc.map((r) => r.corpo).join('\n')
      expect(corpo).toMatch(/background(-image)?\s*:/)
      // Il colore di copertura non può tornare a essere il token (che in HC è nero),
      // né un nero letterale: sotto c'è una card BIANCA.
      expect(corpo).not.toContain('var(--color-kidville-white)')
      expect(corpo).not.toMatch(/#000(000)?\b/i)
      expect(corpo).toMatch(/#FFFFFF/i)
    },
  )
})

// =============================================================================
describe('S16 · `:focus-visible` resta FUORI da ogni @layer', () => {
  it('CONTROLLO POSITIVO: la sonda riconosce una regola annidata in un @layer', () => {
    const finto = regole('@layer utilities { :focus-visible { outline: none; } }')
    expect(finto).toHaveLength(1)
    expect(finto[0].selettore).toBe(':focus-visible')
    expect(finto[0].contesto).toEqual(['@layer utilities'])
  })

  it('la regola globale esiste, è verde esplicito e non sta dentro nessun layer', () => {
    // Le 171 `focus:outline-none` sparse in `src/` NON uccidono l'anello di
    // focus solo perché questa regola vive fuori da ogni `@layer`, mentre le
    // utility Tailwind stanno in `@layer utilities`. Spostarla dentro un layer
    // — anche per «ordine» — spegnerebbe il focus su tutta l'app in silenzio.
    const r = REGOLE.filter((x) => x.selettore === ':focus-visible')
    expect(r.length, 'regola :focus-visible globale presente').toBe(1)
    expect(r[0].contesto.filter((c) => c.startsWith('@layer'))).toEqual([])
    expect(r[0].corpo).toContain('#006A5F')
  })
})

// =============================================================================
// KPI — il numero non è più giallo su bianco (a11y F10). Si asserisce sul DOM
// RENDERIZZATO della pagina vera, non su una stringa del sorgente.
// =============================================================================
const USER = 'aaaabbbb-1111-4111-8111-cccccccccccc'
const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}))

const AVVISO_ADESIONE = {
  id: 'avv-1', author_id: USER, titolo: 'Uscita didattica', contenuto: '…',
  tipo: 'adesione', target_scope: 'globale', target_classes: null,
  scadenza: null, attachment_url: null, created_at: '2026-07-30T10:00:00Z',
  author: { first_name: 'A', last_name: 'B', role: 'admin' },
  stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn((url: string) =>
    String(url).includes('/api/admin/sections/scoped')
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
      : Promise.resolve({ ok: true, status: 200, json: async () => [AVVISO_ADESIONE] }),
  ))
})

/**
 * Il colore che VINCE su un nodo di testo: la utility `text-kidville-*` più
 * vicina risalendo gli antenati. Le utility Tailwind hanno tutte la stessa
 * specificità e `color` si eredita → decide l'elemento più interno.
 */
function coloreTesto(el: Element | null): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = Array.from(n.classList).find((x) => /^text-kidville-[a-z-]+$/.test(x))
    if (c) return c.replace('text-kidville-', '')
  }
  return null
}

import AdminAvvisiPage from '@/app/(dashboard)/admin/avvisi/page'

describe('S16 · KPI «Con adesione» — il numero non è più giallo su bianco', () => {
  it('CONTROLLO POSITIVO: la sonda del colore vede il giallo quando c\'è', () => {
    const esterno = document.createElement('span')
    esterno.className = 'font-barlow text-kidville-yellow'
    const interno = document.createElement('b')
    esterno.appendChild(interno)
    expect(coloreTesto(interno)).toBe('yellow')
  })

  it('il numero è VERDE (6,51:1), e il giallo resta come accento su bordo e icona', async () => {
    render(React.createElement(AdminAvvisiPage))
    const etichetta = await screen.findByText('Con adesione')
    const card = etichetta.closest('div.rounded-card') as HTMLElement
    expect(card, 'card KPI trovata').toBeTruthy()

    await waitFor(() => {
      const foglie = Array.from(card.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && e.textContent?.trim() === '1',
      )
      expect(foglie, 'il numero della KPI è a schermo').toHaveLength(1)
      // È QUESTA l'asserzione che conta: il colore effettivo del numero.
      expect(coloreTesto(foglie[0])).toBe('green')
    })

    // Il giallo non è sparito: resta il linguaggio di accento della card.
    expect(card.className).toContain('border-kidville-yellow')
    expect(card.querySelector('[class*="bg-kidville-yellow"]'), 'chip icona giallo').toBeTruthy()
  })
})

// =============================================================================
describe('S16 · nessun colore letterale fuori palette', () => {
  it('ScrollableStudentForm: l\'alone d\'errore usa il token, non un rosso Tailwind', () => {
    const src = codice('src/components/features/admin/ScrollableStudentForm.tsx')
    // Controllo POSITIVO: l'alone esiste ancora (non è stato semplicemente cancellato).
    expect(src).toContain('shadow-[0_0_10px_')
    expect(src).not.toContain('rgba(239,68,68')
    expect(src).toContain('--color-kidville-error')
  })
})
