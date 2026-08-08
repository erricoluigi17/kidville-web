import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { btnClass, type BtnVariant } from '@/components/ui/Btn'

/**
 * LOCK · lo stato DISABILITATO di un pulsante si dipinge, non si sbiadisce.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il terzo collaudo (2026-08-08) ha misurato che il pulsante primario, quando è
 * disabilitato, ha il testo a **1,20:1** (Chrome, /parent/attendance, 390×844).
 * La causa è `disabled:opacity-45` nel BASE di `Btn` — dal 2026-06-29, quindi su
 * TUTTA l'app: l'alfa abbassa in blocco il riempimento E l'inchiostro, e su un
 * fondo saturo come #006A5F il risultato è un pulsante lattiginoso con sopra un
 * testo quasi invisibile. Sullo screenshot dello stato «Invio…» il contenuto
 * sottostante TRASPARIVA attraverso il pulsante.
 *
 * Colpisce tre momenti, e il terzo è il peggiore: mentre la richiesta è in volo
 * il pulsante mostra «Invio…», che è l'unico segnale visivo che il gesto sia
 * partito — e quel segnale scompare. «Ho premuto o no?» resta senza risposta.
 * (Quel terzo momento è chiuso a parte, spostando l'attesa da `disabled` ad
 * `aria-disabled`: vedi `__tests__/pages/assenze-terzo-collaudo.test.tsx`. Qui
 * si chiude il colore, che vale per gli altri due momenti e per tutta l'app.)
 *
 * Nessuno strumento poteva vederlo: il lock esistente
 * `contrasto-schermate-assenza.test.tsx` misura riempimento, inchiostro e bordi
 * delle quattro varianti e non contiene né la parola `disabled` né `opacity` —
 * lo stato spento non era mai stato misurato da nessuno.
 *
 * ─── COSA CONTROLLA ──────────────────────────────────────────────────────────
 *  1. il CONTROLLO POSITIVO: la sonda ritrova il difetto (l'alfa 0,45 composta
 *     sulla card bianca sta molto sotto 4,5:1) — senza, il divieto sotto sarebbe
 *     verde su una sonda che non misura niente;
 *  2. `Btn` non abbassa più in blocco fondo e inchiostro con un'alfa;
 *  3. lo stato disabilitato di TUTTE e quattro le varianti regge AA (4,5:1: le
 *     tre taglie stanno sotto i 18,66px del «testo grande»);
 *  4. il pulsante spento resta DISTINGUIBILE da quello attivo — altrimenti la
 *     leggibilità si sarebbe comprata togliendo il segnale.
 */

const RADICE = process.cwd()
const CSS = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8')

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto ──────────────────────────────
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
/** Un colore con alfa COMPOSTO sul suo fondo: è ciò che l'occhio vede. */
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

const VARIANTI: BtnVariant[] = ['primary', 'secondary', 'ghost', 'danger']

/** Le classi di `Btn` che valgono SOLO nello stato disabilitato. */
const classiDisabled = (v: BtnVariant): string[] =>
  btnClass(v, 'lg')
    .split(/\s+/)
    .filter((c) => c.startsWith('disabled:'))
    .map((c) => c.slice('disabled:'.length))

/** Le classi che valgono a RIPOSO (nessuna variante di stato davanti). */
const classiRiposo = (v: BtnVariant): string[] =>
  btnClass(v, 'lg').split(/\s+/).filter((c) => !c.includes(':'))

const tokenDa = (classi: string[], prefisso: string): string | null => {
  for (const c of classi) {
    const m = c.match(new RegExp(`^${prefisso}-kidville-([a-z0-9-]+)$`))
    if (m && TOKEN[m[1]]) return TOKEN[m[1]]
  }
  return null
}

/** Le due superfici su cui questi pulsanti vivono davvero. */
const SUPERFICI: Array<{ nome: string; hex: string }> = [
  { nome: 'card bianca', hex: '#FFFFFF' },
  { nome: 'riga crema', hex: '#FEF1E4' },
]

describe('a11y §0 · la sonda ritrova il difetto che deve impedire', () => {
  it('i token si leggono da globals.css', () => {
    expect(TOKEN.green).toBe('#006A5F')
    expect(TOKEN['yellow-ink']).toBe('#FFDA5C')
    expect(TOKEN['neutral-soft']).toBeTruthy()
  })

  it('CONTROLLO POSITIVO: `opacity-45` sul primary lo rende illeggibile', () => {
    // Il difetto misurato: fondo e inchiostro sbiaditi insieme sulla card bianca.
    const fondo = composita(TOKEN.green, '#FFFFFF', 0.45)
    const inchiostro = composita(TOKEN['yellow-ink'], '#FFFFFF', 0.45)
    const misura = contrasto(inchiostro, fondo)
    expect(
      misura,
      'la sonda non ritrova nemmeno il difetto di partenza: allora non misura niente',
    ).toBeLessThan(4.5)
    // …e a riposo lo stesso pulsante è sano: la sonda distingue i due stati.
    expect(contrasto(TOKEN['yellow-ink'], TOKEN.green)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('a11y §1 · nessuna variante si spegne con un’alfa', () => {
  it('`Btn` non porta più `disabled:opacity-*`', () => {
    for (const v of VARIANTI) {
      expect(
        btnClass(v, 'lg'),
        `${v}: l’alfa abbassa in blocco fondo E inchiostro. Lo stato spento va DIPINTO — una ` +
          'coppia fondo/inchiostro dichiarata — non sbiadito.',
      ).not.toMatch(/disabled:opacity-/)
    }
  })

  it('e dichiara comunque uno stato disabilitato (non si è tolta la regola e basta)', () => {
    for (const v of VARIANTI) {
      expect(classiDisabled(v).length, `${v}: nessuna classe per lo stato disabilitato`).toBeGreaterThan(0)
    }
  })
})

describe('a11y §2 · il pulsante spento si LEGGE (WCAG 1.4.3, soglia 4,5:1)', () => {
  it('tutte e quattro le varianti, su entrambe le superfici', () => {
    const sotto: string[] = []
    for (const v of VARIANTI) {
      const classi = classiDisabled(v)
      const fondo = tokenDa(classi, 'bg')
      const inchiostro = tokenDa(classi, 'text')
      expect(fondo, `${v}: lo stato disabilitato non dichiara un riempimento`).not.toBeNull()
      expect(inchiostro, `${v}: lo stato disabilitato non dichiara un inchiostro`).not.toBeNull()
      const misura = contrasto(inchiostro!, fondo!)
      if (misura < 4.5) sotto.push(`${v}: ${inchiostro} su ${fondo} = ${misura}:1`)
    }
    expect(
      sotto,
      `Lo stato disabilitato di queste varianti resta illeggibile:\n  ${sotto.join('\n  ')}\n` +
        'Nessuna taglia di `Btn` arriva ai 18,66px del «testo grande»: la soglia è 4,5:1.',
    ).toEqual([])
  })

  it('il riempimento dello stato spento è un colore DICHIARATO, non un’alfa sulla superficie', () => {
    for (const v of VARIANTI) {
      for (const c of classiDisabled(v)) {
        expect(
          c,
          `${v}: «${c}» porta un’alfa. Un fondo semitrasparente cambia con la superficie sotto — ` +
            'ed è così che la nota privacy traspariva attraverso il pulsante.',
        ).not.toMatch(/\/\d{1,3}$/)
      }
    }
  })
})

describe('a11y §3 · spento resta DIVERSO da acceso', () => {
  it('il riempimento cambia: la leggibilità non si è comprata togliendo il segnale', () => {
    for (const v of VARIANTI) {
      const acceso = tokenDa(classiRiposo(v), 'bg')
      const spento = tokenDa(classiDisabled(v), 'bg')
      expect(acceso, `${v}: variante senza riempimento a riposo`).not.toBeNull()
      expect(
        spento,
        `${v}: acceso e spento hanno lo stesso riempimento (${acceso}) — un pulsante spento che ` +
          'sembra premibile è un no-op silenzioso.',
      ).not.toBe(acceso)
    }
  })

  it('…e su entrambe le superfici il riempimento spento resta distinguibile dal fondo', () => {
    // Non è 1.4.11 (un controllo inattivo ne è esente): serve a che il pulsante
    // si veda ancora COME pulsante, e il bordo dichiarato è ciò che lo tiene.
    for (const v of VARIANTI) {
      const bordo = tokenDa(classiDisabled(v), 'border')
      expect(bordo, `${v}: lo stato spento non dichiara nessun contorno`).not.toBeNull()
      for (const s of SUPERFICI) {
        expect(
          contrasto(bordo!, s.hex),
          `${v}: il contorno dello stato spento sulla ${s.nome} è quasi invisibile`,
        ).toBeGreaterThanOrEqual(2.5)
      }
    }
  })
})
