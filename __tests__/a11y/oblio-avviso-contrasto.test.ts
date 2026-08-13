import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// =============================================================================
// IL RIQUADRO PIÙ IMPORTANTE DELL'APPLICAZIONE DEVE ESSERE LEGGIBILE.
//
// ─── IL DIFETTO, misurato il 2026-08-13 ─────────────────────────────────────
//
// `AvvisoOblio` è il riquadro su cui la Direzione decide un'anonimizzazione
// IRREVERSIBILE. La riga delle foto di gruppo — una delle due che portano un
// NUMERO — era scritta `text-[12px] text-kidville-ink/70` su
// `bg-kidville-error-soft`: **4,46:1**, sotto i 4,5:1 che WCAG 1.4.3 AA chiede
// per il testo normale. Le altre righe stavano bene (ink/80 = 5,87:1).
//
// ─── PERCHÉ AXE NON L'AVEVA VISTO, E PERCHÉ SERVE QUESTO FILE ───────────────
//
// `OblioPanel-sede.test.tsx` asserisce «nessuna violazione axe». In jsdom la
// regola `color-contrast` NON gira — jsdom non calcola i colori — quindi
// quell'asserzione, su questo difetto, dà una rassicurazione che non ha. È
// esattamente il motivo per cui il repo ha già due lock di contrasto ARITMETICI
// (`contrasto-token.test.ts`, `inchiostro-muted-superfici.test.ts`): il rapporto
// si calcola dai token dichiarati, non si spera che un motore lo guardi.
//
// COSA FA QUESTO FILE, con la stessa disciplina degli altri due:
//  · §1 legge i token VERI da `globals.css` (se cambiano, cambia la misura);
//  · §2 estrae da `AvvisoOblio.tsx` ogni classe che dipinge testo dentro il
//       riquadro e ne calcola il contrasto sulla superficie del riquadro;
//  · §3 controlli positivi: il difetto storico è MISURATO (non dedotto) e la
//       sonda vede davvero una violazione piantata apposta.
//
// ⚠️ Il calcolo è sulla composizione sRGB dell'alfa, che è ciò che l'occhio
// vede. Tailwind v4 compone in oklab e il numero cambia di qualche centesimo:
// la soglia resta la stessa e il verdetto pure (4,46 e 4,43 sono entrambi sotto
// 4,5; 5,87 e 5,88 entrambi sopra).
// =============================================================================

const RADICE = process.cwd()

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto ───────────────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const luminanza = ([r, g, b]: [number, number, number]) =>
  0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
const contrasto = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}
/** Il colore che si VEDE quando un inchiostro con alfa sta su una superficie. */
const composito = (
  inchiostro: [number, number, number],
  superficie: [number, number, number],
  alfa: number,
): [number, number, number] =>
  inchiostro.map((c, i) => Math.round(c * alfa + superficie[i] * (1 - alfa))) as [number, number, number]

/** Il valore dichiarato di un token nel blocco `@theme inline` di globals.css. */
function token(nome: string): string {
  const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8')
  const blocco = css.slice(css.indexOf('@theme inline'))
  const m = blocco.match(new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`))
  expect(m, `token --color-kidville-${nome} non trovato in globals.css`).toBeTruthy()
  return m![1].toUpperCase()
}

const SORGENTE = fs.readFileSync(
  path.join(RADICE, 'src/components/features/admin/settings/AvvisoOblio.tsx'),
  'utf8',
)

/** La superficie del riquadro: è dichiarata nel sorgente, non ipotizzata qui. */
const SUPERFICIE = 'error-soft'
const SOGLIA_AA = 4.5

describe('AvvisoOblio · ogni riga del riquadro passa WCAG 1.4.3 AA', () => {
  it('il riquadro sta davvero su `error-soft` (se cambia, cambia tutta la misura)', () => {
    expect(SORGENTE).toContain(`bg-kidville-${SUPERFICIE}`)
  })

  it('nessun inchiostro del riquadro scende sotto 4,5:1', () => {
    // Ogni `text-kidville-<token>` con o senza alfa che compare nel sorgente.
    const usati = [...SORGENTE.matchAll(/text-kidville-([a-z-]+?)(?:\/(\d{1,3}))?(?=["'\s])/g)].map((m) => ({
      nome: m[1],
      alfa: m[2] ? Number(m[2]) / 100 : 1,
    }))
    // Autoinganno: se la regex non trovasse niente, il test sarebbe verde sul vuoto.
    expect(usati.length, 'nessun inchiostro trovato: la sonda non sta guardando niente').toBeGreaterThan(2)

    const superficie = rgb(token(SUPERFICIE))
    const deboli: string[] = []
    for (const u of usati) {
      // `white` è la superficie del riquadro d'errore interno, non un inchiostro:
      // lì l'inchiostro è `error-strong`, misurato nella riga sotto.
      if (u.nome === SUPERFICIE || u.nome === 'white') continue
      const r = contrasto(composito(rgb(token(u.nome)), superficie, u.alfa), superficie)
      if (r < SOGLIA_AA) deboli.push(`text-kidville-${u.nome}${u.alfa < 1 ? `/${u.alfa * 100}` : ''} = ${r}:1`)
    }
    expect(
      deboli,
      `Sotto i 4,5:1 di WCAG 1.4.3 AA, dentro il riquadro su cui si conferma ` +
        `un'anonimizzazione irreversibile:\n  ${deboli.join('\n  ')}\n` +
        `La regola axe del contrasto NON gira in jsdom: qui non c'è nessun altro ` +
        `controllo che se ne accorga.`,
    ).toEqual([])
  })

  it('il riquadro rosso interno è leggibile sulla sua superficie bianca', () => {
    // `role="alert"` sta su `bg-kidville-white` con inchiostro `error-strong`.
    expect(SORGENTE).toContain('bg-kidville-white')
    const r = contrasto(rgb(token('error-strong')), rgb('#FFFFFF'))
    expect(r).toBeGreaterThanOrEqual(SOGLIA_AA)
  })
})

describe('controlli positivi · la sonda misura, non deduce', () => {
  it('il difetto storico è MISURATO: ink/70 su error-soft è sotto soglia', () => {
    // Senza questa riga, «ink/80 va bene» sarebbe un'affermazione senza un metro:
    // il test passerebbe anche se la formula fosse sbagliata e desse 20:1 a tutto.
    const superficie = rgb(token(SUPERFICIE))
    const r70 = contrasto(composito(rgb(token('ink')), superficie, 0.7), superficie)
    const r80 = contrasto(composito(rgb(token('ink')), superficie, 0.8), superficie)
    expect(r70, `ink/70 su ${SUPERFICIE} dovrebbe essere sotto soglia: misurato ${r70}`).toBeLessThan(SOGLIA_AA)
    expect(r80, `ink/80 su ${SUPERFICIE} dovrebbe passare: misurato ${r80}`).toBeGreaterThanOrEqual(SOGLIA_AA)
  })

  it('la sonda vede una violazione piantata apposta', () => {
    const finto = `<p className="text-[12px] text-kidville-ink/70">x</p>`
    const trovati = [...finto.matchAll(/text-kidville-([a-z-]+?)(?:\/(\d{1,3}))?(?=["'\s])/g)]
    expect(trovati).toHaveLength(1)
    expect(trovati[0][2]).toBe('70')
  })

  it('il difetto NON è più nel sorgente', () => {
    expect(SORGENTE, 'ink/70 è tornato nel riquadro').not.toContain('text-kidville-ink/70')
  })
})
