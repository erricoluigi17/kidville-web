import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { Stepper, clamp } from '@/components/ui/Stepper'

// =============================================================================
// `Stepper` — il contatore ± con clamp.
//
// Le due asserzioni che portano il peso:
//
//  1. 🔴 AI BORDI I COMANDI SI DICHIARANO `aria-disabled`, NON `disabled`. Si
//     pretendono ENTRAMBE le cose, ma NON pesano uguale, e vale la pena scriverlo:
//     un `disabled` nativo esce dal giro del Tab e Chrome scarica il fuoco su
//     `<body>` — e al bordo ci si arriva proprio premendo ± ripetutamente, cioè
//     col fuoco SOPRA il bottone che si spegne. Sotto test la prova è
//     `not.toBeDisabled()`: il controllo su `document.activeElement` NON arrossa,
//     perché in jsdom un bottone focalizzato che diventa `disabled` TIENE il fuoco
//     (misurato). È la fotografia dello stato buono, non la guardia.
//     La guardia vera contro il conteggio oltre il bordo è ancora un'altra cosa,
//     sta nell'handler, e si misura sul fatto che `onChange` NON venga chiamato.
//
//  2. `NaN`, `Infinity` e il campo svuotato non escono mai verso il padre. È il
//     difetto di `NumberField` (`Number('') === 0` con un minimo di 1), che qui
//     non può ripetersi: o un numero dentro l'intervallo, o `null`, o niente.
//
// jsdom non fa layout: la misura dei bersagli si verifica sulle CLASSI dichiarate,
// come già fa il lock del bottone «Chiudi» di `AvvisoForm`.
// =============================================================================

expect.extend(toHaveNoViolations)

const MENO = 'Diminuisci i posti'
const PIU = 'Aumenta i posti'

const meno = () => screen.getByRole('button', { name: MENO })
const piu = () => screen.getByRole('button', { name: PIU })
const campo = () => screen.getByRole('spinbutton') as HTMLInputElement

/** Montaggio CONTROLLATO: lo stato sta fuori, come nel modulo vero. */
function Padre({
    iniziale = null,
    onValore,
    ...props
}: {
    iniziale?: number | null
    onValore?: (n: number | null) => void
} & Partial<Omit<React.ComponentProps<typeof Stepper>, 'value' | 'onChange'>>) {
    const [n, setN] = useState<number | null>(iniziale)
    return (
        <div>
            <label htmlFor="posti">Posti disponibili</label>
            <Stepper
                id="posti"
                value={n}
                onChange={(v) => {
                    setN(v)
                    onValore?.(v)
                }}
                etichettaDiminuisci={MENO}
                etichettaAumenta={PIU}
                {...props}
            />
        </div>
    )
}

const axeOpts = {
    rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
    },
}

afterEach(() => cleanup())

// =============================================================================
// Il clamp
// =============================================================================

describe('Stepper — il valore resta dentro l’intervallo', () => {
    it('i comandi ± contano di `step`, dentro i limiti', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={5} min={1} max={8} step={2} onValore={onValore} />)
        fireEvent.click(piu())
        expect(onValore).toHaveBeenLastCalledWith(7)
        fireEvent.click(meno())
        expect(onValore).toHaveBeenLastCalledWith(5)
        expect(campo().value).toBe('5')
    })

    it('`+` non scavalca il massimo e `−` non scende sotto il minimo', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={7} min={1} max={8} step={5} onValore={onValore} />)
        fireEvent.click(piu())
        expect(onValore).toHaveBeenLastCalledWith(8)
        fireEvent.click(meno())
        expect(onValore).toHaveBeenLastCalledWith(3)
        fireEvent.click(meno())
        expect(onValore).toHaveBeenLastCalledWith(1)
    })

    it('anche un numero DIGITATO viene clampato', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={5} min={2} max={40} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '900' } })
        expect(onValore).toHaveBeenLastCalledWith(40)
        fireEvent.change(campo(), { target: { value: '1' } })
        expect(onValore).toHaveBeenLastCalledWith(2)
        fireEvent.change(campo(), { target: { value: '12' } })
        expect(onValore).toHaveBeenLastCalledWith(12)
    })

    it('senza `min`/`max` non clampa niente: il limite è una scelta del chiamante', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={0} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '900' } })
        expect(onValore).toHaveBeenLastCalledWith(900)
        fireEvent.change(campo(), { target: { value: '-4' } })
        expect(onValore).toHaveBeenLastCalledWith(-4)
    })

    it('da «non indicato» il primo tocco porta al primo valore ammesso', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={null} min={3} max={9} consentiVuoto onValore={onValore} />)
        expect(campo().value).toBe('')
        fireEvent.click(piu())
        expect(onValore).toHaveBeenLastCalledWith(3)
    })
})

// =============================================================================
// `null` = «non indicato», che non è zero
// =============================================================================

describe('Stepper — il campo svuotato', () => {
    it('con `consentiVuoto` torna `null`, e il campo resta vuoto', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={6} consentiVuoto min={1} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '' } })
        expect(onValore).toHaveBeenLastCalledWith(null)
        expect(campo().value).toBe('')
    })

    it('senza `consentiVuoto` ricade sul minimo — MAI su `Number(\'\') === 0`', () => {
        // È il difetto misurato in `NumberField`: con un minimo di 1, svuotare il
        // campo produceva uno 0 che il modulo non dovrebbe poter generare.
        const onValore = vi.fn()
        render(<Padre iniziale={6} min={1} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '' } })
        expect(onValore).toHaveBeenLastCalledWith(1)
        expect(onValore).not.toHaveBeenLastCalledWith(0)
    })

    it('…e se il minimo è davvero 0, ricade su 0: il ripiego è `min`, non una costante', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={6} min={0} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '' } })
        expect(onValore).toHaveBeenLastCalledWith(0)
    })

    it('anche il RIPIEGO del campo svuotato è clampato: nessuna via salta il clamp', () => {
        // Era l'unico dei tre percorsi verso `onChange` a non passare da `clamp`:
        // con un `max` e nessun `min`, svuotare emetteva la costante 1 — sopra il massimo.
        const onValore = vi.fn()
        render(<Padre iniziale={0} max={0} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '' } })
        expect(onValore).toHaveBeenLastCalledWith(0)
        expect(onValore).not.toHaveBeenLastCalledWith(1)
    })
})

// =============================================================================
// 🔴 I bordi: `aria-disabled`, e la guardia nell'handler
// =============================================================================

describe('Stepper — ai bordi i comandi restano raggiungibili', () => {
    it('al massimo il `+` si dichiara `aria-disabled` e NON è `disabled`', () => {
        render(<Padre iniziale={8} min={1} max={8} />)
        expect(piu()).toHaveAttribute('aria-disabled', 'true')
        // La metà che porta il peso: un `disabled` nativo esce dal giro del Tab e
        // fa scaricare il fuoco su `<body>` — proprio mentre il dito è lì sopra.
        expect(piu()).not.toBeDisabled()
        // …e il `−`, che al bordo non è, non dichiara niente: senza questa metà un
        // `aria-disabled` scritto fisso passerebbe.
        expect(meno()).not.toHaveAttribute('aria-disabled')
    })

    it('al minimo vale lo stesso, a parti invertite', () => {
        render(<Padre iniziale={1} min={1} max={8} />)
        expect(meno()).toHaveAttribute('aria-disabled', 'true')
        expect(meno()).not.toBeDisabled()
        expect(piu()).not.toHaveAttribute('aria-disabled')
    })

    it('il bottone al bordo resta FOCALIZZABILE e tiene il fuoco', () => {
        render(<Padre iniziale={7} min={1} max={8} />)
        const cta = piu()
        cta.focus()
        expect(document.activeElement).toBe(cta)
        fireEvent.click(cta) // si arriva al bordo premendo, col fuoco sopra
        expect(piu()).toHaveAttribute('aria-disabled', 'true')
        expect(piu()).not.toBeDisabled()
        // ⚠️ MISURATO: in jsdom un bottone focalizzato che diventa `disabled` TIENE il
        // fuoco — quindi questa riga non è la prova, è la fotografia dello stato buono.
        // La prova che arrossa davvero è `not.toBeDisabled()` qui sopra: è lei che
        // impedisce a Chrome di scaricare il fuoco su <body> col dito ancora lì.
        expect(document.activeElement).toBe(cta)
    })

    it('e premerlo al bordo non fa NIENTE: la guardia sta nell’handler', () => {
        const onValore = vi.fn()
        render(<Padre iniziale={8} min={1} max={8} onValore={onValore} />)
        fireEvent.click(piu())
        fireEvent.click(piu())
        expect(onValore).not.toHaveBeenCalled()
        expect(campo().value).toBe('8')
        // Controllo positivo: l'altro comando funziona eccome.
        fireEvent.click(meno())
        expect(onValore).toHaveBeenLastCalledWith(7)
    })

    it('la prop `disabled` è un’ALTRA cosa: lì il controllo è spento davvero', () => {
        // Al bordo si è raggiunto un estremo contando; `disabled` è il controllo
        // intero fuori uso (modulo in invio, permesso mancante), e lì il `disabled`
        // nativo è la dichiarazione giusta.
        const onValore = vi.fn()
        render(<Padre iniziale={4} min={1} max={8} disabled onValore={onValore} />)
        expect(piu()).toBeDisabled()
        expect(meno()).toBeDisabled()
        expect(campo()).toBeDisabled()
        fireEvent.click(piu())
        expect(onValore).not.toHaveBeenCalled()
    })
})

// =============================================================================
// Niente `NaN`, niente `Infinity`, niente testo
// =============================================================================

describe('Stepper — i valori impossibili non arrivano mai al padre', () => {
    it('del testo non produce nessun `NaN`', () => {
        // Un `type="number"` sanifica il testo a `''` (sia in jsdom sia nei
        // browser): quello che si prova qui è che il campo svuotato dal testo
        // ricada sul minimo invece di emettere `Number('ciao') === NaN`, che è
        // esattamente ciò che fa `NumberField`.
        const onValore = vi.fn()
        render(<Padre iniziale={5} min={1} max={40} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: 'ciao' } })
        for (const [n] of onValore.mock.calls) {
            expect(Number.isNaN(n as number), `è uscito un NaN: ${String(n)}`).toBe(false)
        }
        expect(campo().value).not.toBe('ciao')
    })

    it('⚠️ `1e999` dal DOM non arriva nemmeno all’handler: in jsdom è già `\'\'`', () => {
        // MISURATO, non dedotto: `input.value = '1e999'` su un `type="number"` in
        // jsdom viene sanificato a stringa vuota (un `Infinity` non è
        // riserializzabile). Chrome invece lo tiene: `value === '1e999'`,
        // `valueAsNumber === Infinity`. Quindi da qui il percorso che si esercita è
        // quello del CAMPO SVUOTATO — e va scritto, perché un test che dicesse
        // «ecco la prova che Infinity è fermato» direbbe il falso.
        const onValore = vi.fn()
        render(<Padre iniziale={5} min={1} max={40} onValore={onValore} />)
        fireEvent.change(campo(), { target: { value: '1e999' } })
        expect(onValore).toHaveBeenLastCalledWith(1) // il minimo, non `Infinity`
        for (const [n] of onValore.mock.calls) {
            expect(Number.isFinite(n as number) || n === null, `valore non finito: ${String(n)}`).toBe(true)
        }
    })

    it('la guardia su `Infinity`/`NaN` si prova dove vive: sulla funzione di clamp', () => {
        // È l'unico modo onesto di provarla (vedi il test qui sopra), ed è il
        // motivo per cui `clamp` è esportata. Nel browser vero è questa riga che
        // impedisce a un `Infinity` di attraversare il componente.
        expect(clamp(Number.POSITIVE_INFINITY, 1, 40)).toBeNull()
        expect(clamp(Number.NEGATIVE_INFINITY, 1, 40)).toBeNull()
        expect(clamp(Number.NaN, 1, 40)).toBeNull()
        // …e i valori buoni passano, altrimenti un `clamp` che tornasse sempre
        // `null` supererebbe le tre righe qui sopra.
        expect(clamp(12, 1, 40)).toBe(12)
        expect(clamp(900, 1, 40)).toBe(40)
        expect(clamp(-3, 1, 40)).toBe(1)
        expect(clamp(-3)).toBe(-3)
    })
})

// =============================================================================
// Il pollice, e quello che uno screen reader sente
// =============================================================================

describe('Stepper — bersagli, tastiera nativa, ruolo', () => {
    it('i comandi ± sono `type="button"` e dichiarano almeno 44×44', () => {
        render(<Padre iniziale={3} />)
        for (const b of [meno(), piu()]) {
            // Dentro un `<form>` un bottone senza `type` INVIA: qui si contava.
            expect(b.getAttribute('type')).toBe('button')
            expect(b.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
            expect(b.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
            // L'icona è decorativa: il nome lo porta l'`aria-label`.
            expect(b.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
        }
    })

    it('il campo ha la tastiera numerica, un font ≥16px e nessuna freccia nativa', () => {
        render(<Padre iniziale={3} min={1} max={9} />)
        const input = campo()
        expect(input.getAttribute('inputmode')).toBe('numeric')
        // Sotto i 16px iOS zooma sul campo al fuoco e la pagina resta ingrandita.
        expect(parseFloat(input.style.fontSize)).toBeGreaterThanOrEqual(16)
        expect(input.className).toContain('[appearance:textfield]')
        expect(input.className).toContain('[&::-webkit-inner-spin-button]:appearance-none')
    })

    it('resta uno `spinbutton`, quindi annuncia valore e limiti senza ARIA scritta a mano', () => {
        render(<Padre iniziale={3} min={1} max={9} />)
        // È la ragione per cui il campo NON è un `type="text"`: il ruolo implicito
        // porta con sé `aria-valuenow`/`min`/`max` presi dagli attributi nativi.
        const input = campo()
        expect(input.type).toBe('number')
        expect(input.min).toBe('1')
        expect(input.max).toBe('9')
    })

    it('l’etichetta del punto d’uso resta associata al campo', () => {
        render(<Padre iniziale={3} />)
        expect(campo().labels?.length).toBe(1)
        expect(campo().labels?.[0].textContent).toBe('Posti disponibili')
    })

    it('nessuna violazione axe', async () => {
        const { container } = render(<Padre iniziale={3} min={1} max={9} />)
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })

    it('nessuna violazione axe nemmeno ai bordi (dove compare `aria-disabled`)', async () => {
        const { container } = render(<Padre iniziale={9} min={1} max={9} consentiVuoto />)
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })
})
