import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

/**
 * LOCK · i due elementi giallo-su-verde che la rete di sicurezza non raggiunge.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * `globals.css` ha una rete che rimappa la coppia di brand — riempimento verde +
 * inchiostro giallo, 4,05:1 — sull'inchiostro che quel verde regge davvero
 * (`yellow-ink`, 4,78:1). Il collaudo del 2026-08-08 ha misurato due punti in
 * cui la rete NON arriva, e sono entrambi elementi che il genitore incontra su
 * OGNI schermata:
 *
 *  · T19 — lo skip link «Salta al contenuto», primo elemento di ogni schermata e
 *    unica scorciatoia di chi naviga da tastiera: le classi sono
 *    `focus:text-kidville-yellow` e `focus:bg-kidville-green`. Tailwind genera
 *    per le varianti classi con nome DIVERSO (`.focus\:text-kidville-yellow`) e
 *    il selettore della rete — scritto `.bg-kidville-green.text-kidville-yellow`
 *    — non le aggancia mai. Misurato al primo Tab: 4,05:1 su testo 16px/400.
 *
 *  · T20 — la pillola del selettore figlio, cioè l'unico posto della schermata
 *    che dice DI QUALE bambino si sta comunicando l'assenza: i colori sono
 *    scritti a mano nello `style` inline (`background:'#006A5F'`,
 *    `color:'#FDC400'`). Uno stile inline batte qualunque foglio senza
 *    `!important`: né la rete sulla coppia di brand né il rimappaggio dell'Alto
 *    Contrasto possono raggiungerlo — misurato, in Alto Contrasto resta 4,05:1
 *    identico, ed è l'unico elemento della schermata che non partecipa affatto
 *    al ribaltamento.
 *
 * Entrambi preesistenti a questo ciclo, entrambi su ogni schermata del genitore.
 */

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8')

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

const TOKEN: Record<string, string> = (() => {
  const blocco = CSS.slice(CSS.indexOf('@theme inline'))
  const out: Record<string, string> = {}
  for (const m of blocco.matchAll(/--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2].toUpperCase()
  }
  return out
})()

/** I due layout dell'area riservata che portano lo skip link. */
const LAYOUT = [
  'src/app/(dashboard)/parent/layout.tsx',
  'src/app/(dashboard)/teacher/layout.tsx',
] as const

const sorgente = (rel: string) => fs.readFileSync(path.join(RADICE, rel), 'utf8')

// ── ChildSwitcher: si monta per davvero ─────────────────────────────────────
vi.mock('next/navigation', () => ({
  usePathname: () => '/parent/attendance',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

const FIGLI = [
  { id: 's-1', nome: 'Alunno1', cognome: 'Test', classe_sezione: 'TEST Infanzia' },
  { id: 's-2', nome: 'Alunno2', cognome: 'Test', classe_sezione: 'TEST 1A' },
]

vi.mock('@/lib/auth/use-parent-identity', () => ({
  useParentIdentity: () => ({ parentId: 'p-1', studentId: 's-1', figliIds: ['s-1', 's-2'], ready: true }),
  fetchFigli: async () => FIGLI,
  invalidaFigliCache: () => {},
}))

import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher'

afterEach(() => cleanup())

describe('§0 · la sonda conosce le due coppie in gioco', () => {
  it('giallo su verde è sotto soglia, `yellow-ink` su verde no', () => {
    expect(contrasto(TOKEN.yellow, TOKEN.green)).toBe(4.05)
    expect(contrasto(TOKEN['yellow-ink'], TOKEN.green)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('T19 · lo skip link si legge quando appare', () => {
  it('nessun layout dipinge lo skip link con l’inchiostro giallo di brand', () => {
    const guasti: string[] = []
    for (const file of LAYOUT) {
      const testo = sorgente(file)
      const skip = testo.match(/<a[\s\S]*?href="#content"[\s\S]*?>/)
      expect(skip, `${file}: lo skip link è sparito`).not.toBeNull()
      if (/focus:text-kidville-yellow(?![\w-])/.test(skip![0])) {
        guasti.push(`${file} → focus:text-kidville-yellow = 4,05:1 su #006A5F (servono 4,5:1)`)
      }
    }
    expect(
      guasti,
      `Lo skip link è la scorciatoia pensata per chi non usa il mouse, ed è l’unico elemento ` +
        `della pagina che si mostra solo a loro:\n  ${guasti.join('\n  ')}\n` +
        'La rete di globals.css non lo raggiunge: Tailwind genera per le varianti classi con ' +
        'nome diverso (`.focus\\:text-kidville-yellow`), e il selettore `.bg-kidville-green' +
        '.text-kidville-yellow` cerca la coppia scritta NUDA. Il token giusto esiste già: ' +
        '`focus:text-kidville-yellow-ink` (#FFDA5C su #006A5F = 4,78:1).',
    ).toEqual([])
  })

  it('…e usa l’inchiostro che quel verde regge davvero', () => {
    for (const file of LAYOUT) {
      const skip = sorgente(file).match(/<a[\s\S]*?href="#content"[\s\S]*?>/)![0]
      expect(skip, `${file}: lo skip link non dichiara un inchiostro sul fuoco`).toMatch(
        /focus:text-kidville-yellow-ink/,
      )
      expect(skip, `${file}: lo skip link non dichiara più il fondo verde`).toMatch(
        /focus:bg-kidville-green/,
      )
    }
  })
})

describe('lo skip link arriva DAVVERO al contenuto', () => {
    it('il `<main id="content">` dei due layout è raggiungibile dal codice (`tabindex="-1"`)', () => {
        // Senza, lo skip link porta l'hash a `#content` ma lascia
        // `document.activeElement` su `<body>`: in Chrome funziona lo stesso
        // perché il browser sposta il punto di ripartenza della navigazione
        // sequenziale, ma il comportamento non è uniforme fra browser e
        // tecnologie assistive, e uno screen reader non annuncia la
        // destinazione. È il collo di bottiglia della scorciatoia stessa.
        for (const file of LAYOUT) {
            const main = sorgente(file).match(/<main[^>]*id="content"[^>]*>/)
            expect(main, `${file}: nessun <main id="content">`).not.toBeNull()
            expect(
                main![0],
                `${file}: la destinazione dello skip link non riceve il fuoco`,
            ).toMatch(/tabIndex=\{-1\}/)
        }
    })
})

describe('T20 · la pillola col nome del figlio partecipa alla cascata', () => {
  it('CONTROLLO POSITIVO: la pillola si monta e mostra il figlio attivo', async () => {
    render(<ChildSwitcher />)
    expect(await screen.findByText('TEST Infanzia')).toBeInTheDocument()
  })

  it('nessun colore scritto a mano nello `style` inline', async () => {
    const { container } = render(<ChildSwitcher />)
    await screen.findByText('TEST Infanzia')

    const conColoreInline = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.color !== '' || el.style.background !== '' || el.style.backgroundColor !== '',
    )
    expect(
      conColoreInline.map((el) => `${el.tagName.toLowerCase()}: ${el.getAttribute('style')}`),
      'Uno stile inline batte qualunque foglio di stile senza `!important`: né la rete sulla ' +
        'coppia di brand né il rimappaggio dell’Alto Contrasto possono raggiungerlo. Misurato: ' +
        'in Alto Contrasto la pillola resta 4,05:1 identica, ed è l’unico elemento della ' +
        'schermata che non partecipa affatto al ribaltamento.',
    ).toEqual([])
  })

  it('l’avatar e il grado usano i token, con l’inchiostro che regge AA', async () => {
    const { container } = render(<ChildSwitcher />)
    const grado = await screen.findByText('TEST Infanzia')
    const iniziali = container.querySelector('span.rounded-full')!

    for (const [dove, el] of [['avatar', iniziali], ['grado', grado]] as const) {
      const classi = el.className.split(/\s+/)
      expect(classi, `${dove}: non dichiara l’inchiostro col token`).toContain('text-kidville-yellow-ink')
      expect(
        classi,
        `${dove}: usa ancora l’inchiostro giallo di brand (4,05:1) su verde`,
      ).not.toContain('text-kidville-yellow')
    }
    // La misura, non la classe: è il numero che il collaudo aveva in mano.
    expect(contrasto(TOKEN['yellow-ink'], TOKEN.green)).toBeGreaterThanOrEqual(4.5)
  })

  it('la pillola del figlio ATTIVO dichiara il proprio fondo con un token', async () => {
    render(<ChildSwitcher />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    const attiva = screen.getAllByRole('tab').find((b) => b.getAttribute('aria-selected') === 'true')!
    expect(attiva.className.split(/\s+/)).toContain('bg-kidville-green')
  })
})
