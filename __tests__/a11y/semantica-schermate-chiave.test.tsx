import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

// =============================================================================
// S17 — la SEMANTICA delle schermate che contano (collaudo 2026-08-01).
//
// Il gate formale era VERDE mentre tutto questo era in produzione, perché
// nessuno dei difetti qui sotto ha una forma che `tsc`, `eslint` o un test di
// comportamento possano vedere:
//
//  1. `/iscrizione` — il modulo pubblico su cui 251 famiglie hanno consegnato
//     allergie, note mediche e consensi dei figli (≈9 invii l'ora) — non aveva
//     NESSUN `<h1>`. Chi naviga per intestazioni con uno screen reader non
//     trovava la pagina; e il testo dei consensi era dipinto col token che il
//     design system dichiara DECORATIVO (`muted`, 2,51:1 su bianco). Un consenso
//     che non si legge agevolmente è un consenso più debole.
//  2. `muted` (#9AA6A2) e `yellow-dark` (#E6B100) facevano da INCHIOSTRO: le
//     etichette che dicono cosa scrivere in un campo, i metadati di ogni avviso
//     in bacheca, gli occhielli di sezione della home docente. Fino a 1,59:1 —
//     e su quel 1,59 c'era scritta la NOTA MEDICA di un bambino.
//  3. `/teacher/avvisi` saltava da `h1` a `h3` (dieci volte, una per avviso).
//  4. `AvvisoCard` formattava la scadenza col locale grezzo di next-intl e
//     SENZA fuso: è la stessa famiglia di difetti che a gennaio ha fatto sparire
//     un incasso da un KPI (su Vercel il processo gira in UTC, il browser di una
//     famiglia in Europe/Rome: fra le 00:00 e le 02:00 sono due GIORNI diversi).
//
// METODO. Niente asserzioni-fantoccio: ogni negativa ha accanto la positiva che
// cadrebbe per prima. I rapporti di contrasto NON sono numeri copiati a mano:
// si calcolano dai token dichiarati in `globals.css`, così il giorno in cui
// qualcuno cambia un token il lock lo dice invece di continuare a passare.
// =============================================================================

const RADICE = process.cwd()

// ── WCAG 2.x §1.4.3 — rapporto di contrasto ──────────────────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const luminanza = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) => parseInt(x, 16))
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}

/** I token `--color-kidville-*` dichiarati nel blocco `@theme inline`. */
function tokenTema(): Record<string, string> {
  const css = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8')
  const inizio = css.indexOf('@theme inline')
  const apre = css.indexOf('{', inizio)
  let livello = 0
  let chiude = apre
  for (let k = apre; k < css.length; k++) {
    if (css[k] === '{') livello++
    else if (css[k] === '}' && --livello === 0) { chiude = k; break }
  }
  const out: Record<string, string> = {}
  for (const m of css.slice(apre, chiude).matchAll(/--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]] = m[2].toUpperCase()
  }
  return out
}
const T = tokenTema()

/** Il sorgente SENZA commenti: i lock guardano il codice, non la prosa che lo spiega. */
const codice = (p: string) =>
  fs
    .readFileSync(path.join(RADICE, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '')

// I sei file di S17 e il token forte che ciascuno deve portare (controllo
// positivo: senza, l'asserzione negativa passerebbe su un file svuotato).
const FILE_S17: { file: string; attesi: string[] }[] = [
  { file: 'src/components/features/avvisi/AvvisoCard.tsx', attesi: ['text-kidville-sub', 'text-kidville-warn-strong'] },
  { file: 'src/components/features/avvisi/AvvisoForm.tsx', attesi: ['text-kidville-sub'] },
  { file: 'src/components/features/public/EnrollmentWizard.tsx', attesi: ['text-kidville-sub', 'text-kidville-warn-strong'] },
  { file: 'src/app/(dashboard)/teacher/page.tsx', attesi: ['text-kidville-sub', 'text-kidville-warn-strong'] },
  { file: 'src/components/features/parent/home/SectionHeader.tsx', attesi: ['text-kidville-warn-strong'] },
  { file: 'src/components/features/teacher/TeacherAgendaCard.tsx', attesi: ['text-kidville-sub', 'text-kidville-warn-strong'] },
]

// =============================================================================
describe('S17 · i token — quali colori possono fare da inchiostro, e quali no', () => {
  const SUPERFICI = ['white', 'cream', 'cream-dark', 'neutral-soft', 'yellow-soft'] as const

  it('CONTROLLO POSITIVO: `muted` e `yellow-dark` sono sotto AA su OGNI superficie chiara', () => {
    // È il difetto, misurato. Se un giorno qualcuno scurisce questi due token il
    // controllo diventa rosso e va riletto: la sostituzione potrebbe non servire più.
    for (const s of SUPERFICI) {
      expect(contrasto(T.muted, T[s]), `muted su ${s}`).toBeLessThan(4.5)
      // `yellow-dark` non regge nemmeno la soglia 3:1 del testo GRANDE e delle icone.
      expect(contrasto(T['yellow-dark'], T[s]), `yellow-dark su ${s}`).toBeLessThan(3)
    }
  })

  it('`sub` regge AA su tutte e cinque: è il token del testo informativo', () => {
    for (const s of SUPERFICI) {
      expect(contrasto(T.sub, T[s]), `sub su ${s}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('`warn-strong` regge AA su tutte e cinque: è l\'inchiostro CALDO della palette', () => {
    // Sostituisce `yellow-dark` senza spegnere il linguaggio di accento del design
    // (occhielli, chip data, icona dell\'avviso con adesione).
    for (const s of SUPERFICI) {
      expect(contrasto(T['warn-strong'], T[s]), `warn-strong su ${s}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('la nota medica va su `ink`: il testo di un dato sanitario non è un accento', () => {
    expect(contrasto(T.ink, T['cream-dark'])).toBeGreaterThanOrEqual(7) // AAA
    expect(contrasto(T['yellow-dark'], T['cream-dark'])).toBeLessThan(2) // era 1,59:1
  })
})

// =============================================================================
describe('S17 · nessun token debole fa più da inchiostro nei sei file', () => {
  it.each(FILE_S17)('$file', ({ file, attesi }) => {
    const src = codice(file)
    // Controllo POSITIVO: il file è ancora quello, è tokenizzato e porta i token forti.
    for (const atteso of attesi) {
      expect(src, `${file}: manca «${atteso}» — sonda cieca`).toContain(atteso)
    }
    // Negative: `\b` prende anche le forme con prefisso o opacità
    // (`placeholder:text-kidville-muted`, `text-kidville-yellow-dark/80`).
    expect(/\btext-kidville-muted\b/.test(src), `${file}: text-kidville-muted`).toBe(false)
    expect(/\btext-kidville-yellow-dark\b/.test(src), `${file}: text-kidville-yellow-dark`).toBe(false)
  })
})

// =============================================================================
describe('S17 · le date dei sei file non dipendono dall\'ambiente', () => {
  const CON_DATE = [
    'src/components/features/avvisi/AvvisoCard.tsx',
    'src/app/(dashboard)/teacher/page.tsx',
    'src/components/features/teacher/TeacherAgendaCard.tsx',
  ]

  it.each(CON_DATE)('%s: niente `toLocale*String`, la formattazione passa da @/lib/i18n/date o @/i18n/config', (f) => {
    const src = codice(f)
    // Controllo POSITIVO: il file formatta DAVVERO delle date con gli strumenti
    // dichiarati. Senza, la negativa passerebbe anche su un file che ha smesso
    // di mostrare date del tutto.
    expect(
      /from '@\/lib\/i18n\/date'|from '@\/i18n\/config'/.test(src),
      `${f}: nessun import da @/lib/i18n/date o @/i18n/config — sonda cieca`,
    ).toBe(true)
    expect(
      /\.toLocale(Date|Time)?String\s*\(/.test(src),
      `${f}: usa toLocale*String — il fuso e la regione tornano a essere quelli dell'ambiente`,
    ).toBe(false)
  })
})

// =============================================================================
// Le prove RESE. Da qui in giù si monta il componente vero e si guarda il DOM.
// =============================================================================

/** I livelli delle intestazioni nell'ordine in cui compaiono nel documento. */
function livelliIntestazioni(radice: ParentNode = document.body): number[] {
  return Array.from(radice.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
    Number(h.tagName.slice(1)),
  )
}

/** Il primo salto di livello (>1) nella sequenza, o `null` se non ce n'è. */
function saltoDiLivello(livelli: number[]): string | null {
  for (let i = 1; i < livelli.length; i++) {
    if (livelli[i] > livelli[i - 1] + 1) return `h${livelli[i - 1]} → h${livelli[i]} (posizione ${i})`
  }
  return null
}

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

const DOCENTE = 'dddddddd-1111-4111-8111-eeeeeeeeeeee'
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: DOCENTE, role: 'educator', ready: true }),
}))

afterEach(cleanup)

// ── /iscrizione ──────────────────────────────────────────────────────────────
import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'
import itPublic from '../../messages/it/public.json'

describe('S17 · /iscrizione — la schermata dei consensi ha un nome, e si legge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/api/iscrizione/sedi')
          ? Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
          : Promise.resolve({ ok: true, status: 200, json: async () => ({ schema: null }) }),
      ),
    )
  })

  async function montaWizard() {
    render(<EnrollmentWizard />)
    // Il primo passo non viene dipinto finché l'elenco sedi non è risolto.
    await waitFor(() => expect(screen.getByText(itPublic.wizardBambinoSub)).toBeInTheDocument())
  }

  it('esiste UN solo `<h1>`, ed è il nome della pagina', async () => {
    await montaWizard()
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    expect(h1[0]).toHaveAccessibleName(itPublic.wizardEyebrow)
  })

  it('la gerarchia non salta un livello (h1 → h2, mai h1 → h3)', async () => {
    await montaWizard()
    const livelli = livelliIntestazioni()
    // Controllo positivo: la sonda vede davvero delle intestazioni.
    expect(livelli.length).toBeGreaterThanOrEqual(2)
    expect(livelli[0]).toBe(1)
    expect(saltoDiLivello(livelli)).toBeNull()
  })

  it('il passo dei consensi si annuncia per quello che è, con UNA sola intestazione', () => {
    // Fino al 2026-08-01 il passo dei consensi portava l'intestazione del
    // RIEPILOGO («Riepilogo / Controlla e invia la richiesta») — la catena di
    // ternari non aveva un ramo per lui — e, subito sotto, una SECONDA
    // intestazione col titolo vero: due `h2` di cui uno mentiva, proprio sulla
    // schermata su cui si presta il consenso al trattamento dei dati di un minore.
    const src = codice('src/components/features/public/EnrollmentWizard.tsx')
    const inizio = src.indexOf('const heading =')
    const fine = src.indexOf('const HeadIcon')
    // Controllo POSITIVO: il blocco che decide l'intestazione di ogni passo
    // esiste ed è riconoscibile (se cambia forma, questo lock va riscritto).
    expect(inizio).toBeGreaterThan(-1)
    expect(fine).toBeGreaterThan(inizio)
    const heading = src.slice(inizio, fine)
    // Controllo POSITIVO: il ramo del riepilogo è ancora al suo posto.
    expect(heading).toContain('wizardRiepilogo')
    // Il passo dei consensi ha il PROPRIO titolo…
    expect(heading).toContain('wizardConsensiTitolo')
    // …e uno solo: la seconda intestazione dentro il corpo del passo non c'è più.
    expect(src.match(/wizardConsensiTitolo/g)).toHaveLength(1)
  })
})

// ── AvvisoCard ───────────────────────────────────────────────────────────────
import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'

/** 2026-07-30 22:30 UTC = 2026-07-31 00:30 a Roma: server e famiglia in due giorni. */
const ISTANTE = '2026-07-30T22:30:00Z'

const AVVISO: Avviso = {
  id: 'avv-1',
  author_id: DOCENTE,
  titolo: 'TEST Uscita didattica',
  contenuto: 'TEST contenuto della comunicazione.',
  tipo: 'adesione',
  target_scope: 'globale',
  target_classes: null,
  scadenza: ISTANTE,
  attachment_url: null,
  created_at: '2026-07-31T08:00:00Z',
  author: { first_name: 'TEST', last_name: 'Docente', role: 'educator' },
  stats: { letti: 3, adesioni_si: 2, adesioni_no: 1 },
}

describe('S17 · AvvisoCard — livello del titolo e fuso della scadenza', () => {
  it('il titolo dell\'avviso è un `h2`: sotto l\'`h1` della bacheca non c\'è salto', () => {
    render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)
    expect(screen.getByRole('heading', { level: 2, name: AVVISO.titolo })).toBeInTheDocument()
    // Controllo positivo speculare: nessun `h3` residuo nella card.
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
  })

  it('autore e data non sono più dipinti col token decorativo', () => {
    render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)
    const autore = screen.getByText('TEST Docente', { exact: false })
    expect(autore.className).toContain('text-kidville-sub')
    expect(autore.className).not.toContain('text-kidville-muted')
  })

  describe('con il processo in UTC, come su Vercel', () => {
    const TZ = process.env.TZ
    beforeAll(() => { process.env.TZ = 'UTC' })
    afterAll(() => { process.env.TZ = TZ })

    it('CONTROLLO POSITIVO: in questo ambiente la formattazione ingenua sbaglia giorno', () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
      expect(
        new Date(ISTANTE).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }),
      ).toBe('30 luglio 2026')
    })

    it('la scadenza resta il giorno ITALIANO, non quello del processo', () => {
      render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)
      fireEvent.click(screen.getByRole('heading', { level: 2, name: AVVISO.titolo }))
      const box = screen.getByText(/luglio 2026/)
      expect(box.textContent).toContain('31 luglio 2026')
      expect(box.textContent).not.toContain('30 luglio 2026')
    })
  })
})

// ── /teacher/avvisi ──────────────────────────────────────────────────────────
import TeacherAvvisiPage from '@/app/(dashboard)/teacher/avvisi/page'

describe('S17 · /teacher/avvisi — da h1 a h3 senza h2 (dieci volte)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/api/educator-sections')
          ? Promise.resolve({ ok: true, status: 200, json: async () => ({ role: 'educator', sections: [] }) })
          : Promise.resolve({ ok: true, status: 200, json: async () => [AVVISO, { ...AVVISO, id: 'avv-2' }] }),
      ),
    )
  })

  it('la bacheca vera scende di un livello alla volta', async () => {
    render(<TeacherAvvisiPage />)
    await waitFor(() => expect(screen.getAllByText(AVVISO.titolo).length).toBe(2))
    const livelli = livelliIntestazioni()
    // Controllo positivo: c'è l'h1 della testata più i titoli dei due avvisi.
    expect(livelli.length).toBeGreaterThanOrEqual(3)
    expect(livelli[0]).toBe(1)
    expect(saltoDiLivello(livelli)).toBeNull()
  })
})
