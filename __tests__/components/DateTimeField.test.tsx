import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { DateTimeField } from '@/components/ui/DateTimeField'

// =============================================================================
// `DateTimeField` — due campi, un istante.
//
// 🔑 IL TEST CHE PORTA IL PESO È QUELLO DELLA DIGITAZIONE, e la ragione è che il
// difetto che chiude NON SI VEDE LEGGENDO IL CODICE: si vede digitando.
//
// `DateField` emette `onChange('')` a ogni battuta intermedia (`12/10/202` non è
// una data). Se quel vuoto risalisse al padre e tornasse giù come `value`, il
// componente ricalcolerebbe i propri pezzi da un istante che non c'è — e quello
// che sparisce sotto le dita non è la data (`DateField` si difende da solo
// aggiornando il proprio `lastValue`) ma **l'ORA già scritta accanto**: si corregge
// una cifra del giorno e le 18:00 si azzerano.
//
// Perciò qui non si monta il componente con una prop finta: si monta un PADRE
// CONTROLLATO vero — stato in alto, `value` che ridiscende — che è la sola forma
// in cui il difetto può manifestarsi. Un test che tenesse `value` costante sarebbe
// verde con e senza la correzione.
//
// METODO a11y come in `AvvisoForm-campi-a11y.test.tsx`: l'etichetta si verifica
// risalendo da `input.labels` al testo visibile, mai con un `toBeTruthy()` su un
// attributo, e ogni asserzione negativa ha il suo controllo positivo accanto.
// =============================================================================

expect.extend(toHaveNoViolations)

/** Istanti scritti A MANO e non calcolati con la stessa funzione del componente:
 *  `2026-06-01T18:00` e `2026-10-12T23:59` sono in ora legale (Roma, +02:00). */
const ISO_1_GIU_18 = '2026-06-01T16:00:00.000Z'
const ISO_12_OTT_2359 = '2026-10-12T21:59:00.000Z'

const ETICHETTA_GRUPPO = 'Scadenza adesioni'
const ETICHETTA_DATA = 'Giorno'
const ETICHETTA_ORA = 'Ora'
const AIUTO = 'Dopo questo istante non si può più aderire.'

/** Il padre CONTROLLATO: stato in alto, `value` che ridiscende. Come il modulo vero. */
function Padre({ iniziale = '', className }: { iniziale?: string; className?: string }) {
    const [iso, setIso] = useState(iniziale)
    return (
        <div>
            <span id="gruppo-scadenza">{ETICHETTA_GRUPPO}</span>
            <p id="aiuto-scadenza">{AIUTO}</p>
            <DateTimeField
                value={iso}
                onChange={setIso}
                idData="campo-data"
                idOra="campo-ora"
                labelledBy="gruppo-scadenza"
                aria-describedby="aiuto-scadenza"
                etichettaData={ETICHETTA_DATA}
                etichettaOra={ETICHETTA_ORA}
                className={className}
            />
            {/* Quello che il padre ha davvero in mano, a schermo: le asserzioni
                sull'ISO leggono QUESTO, non un mock. */}
            <output data-testid="iso">{iso}</output>
        </div>
    )
}

const campoData = () => screen.getByLabelText(ETICHETTA_DATA) as HTMLInputElement
const campoOra = () => screen.getByLabelText(ETICHETTA_ORA) as HTMLInputElement
const isoDelPadre = () => screen.getByTestId('iso').textContent

/** Batte una cifra in fondo al campo, come farebbe una tastiera vera. */
function batti(campo: HTMLInputElement, cifra: string) {
    fireEvent.change(campo, { target: { value: campo.value + cifra } })
}

/** Cancella l'ultimo carattere, come il tasto indietro. */
function cancella(campo: HTMLInputElement) {
    fireEvent.change(campo, { target: { value: campo.value.slice(0, -1) } })
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
// 🔑 LA TRAPPOLA — le cifre non spariscono mai sotto le dita
// =============================================================================

describe('DateTimeField — digitare la data non cancella quello che si sta scrivendo', () => {
    it('battuta per battuta, il campo mostra ESATTAMENTE quello che è stato digitato', () => {
        render(<Padre />)
        const atteso = ['1', '12', '12/1', '12/10', '12/10/2', '12/10/20', '12/10/202', '12/10/2026']

        for (const [i, cifra] of [...'12102026'].entries()) {
            batti(campoData(), cifra)
            // Se un `''` di risalita tornasse giù come `value` e riscrivesse i
            // pezzi, qui si leggerebbe una stringa più corta di quella digitata.
            expect(campoData().value, `dopo ${i + 1} cifre`).toBe(atteso[i])
        }
    })

    it('e finché la data è incompleta il padre tiene un valore VUOTO — che è la verità', () => {
        render(<Padre />)
        for (const cifra of [...'1210202']) {
            batti(campoData(), cifra)
            // `''` non è un lampeggio: è «non è ancora un istante». Può risalire
            // proprio perché nessun campo si ridisegna più a partire da lui.
            expect(isoDelPadre()).toBe('')
        }
        batti(campoData(), '6')
        expect(isoDelPadre()).toBe(ISO_12_OTT_2359)
    })

    it('🔴 correggendo la data di un istante COMPLETO, l’ora già scritta NON si azzera', () => {
        // È la forma in cui il difetto si manifesta davvero: i due pezzi ci sono,
        // il padre ha un ISO, si tocca la data e il valore del padre torna `''`.
        render(<Padre iniziale={ISO_1_GIU_18} />)
        expect(campoData().value).toBe('01/06/2026')
        expect(campoOra().value).toBe('18:00')

        for (let i = 0; i < 4; i++) {
            cancella(campoData())
            expect(campoOra().value, `l’ora dopo ${i + 1} cancellazioni`).toBe('18:00')
        }
        // Quattro tasti indietro su `01/06/2026`: l'ultimo mangia anche lo slash,
        // che la maschera non riscrive finché non torna una cifra d'anno.
        expect(campoData().value).toBe('01/06')
        expect(isoDelPadre()).toBe('')

        // …e ribattendo l'anno si ricompone l'istante con l'ora di prima.
        for (const cifra of [...'2027']) batti(campoData(), cifra)
        expect(campoData().value).toBe('01/06/2027')
        expect(campoOra().value).toBe('18:00')
        expect(isoDelPadre()).toBe('2027-06-01T16:00:00.000Z')
    })
})

// =============================================================================
// L'istante: esce solo quando i due pezzi ci sono, e il giro si chiude
// =============================================================================

describe('DateTimeField — l’ISO esce solo quando c’è tutto', () => {
    it('la sola ORA non basta: il padre resta a mani vuote', () => {
        render(<Padre />)
        fireEvent.change(campoOra(), { target: { value: '09:30' } })
        expect(campoOra().value).toBe('09:30')
        expect(isoDelPadre()).toBe('')

        // Controllo positivo: appena arriva anche la data, l'istante esce.
        fireEvent.change(campoData(), { target: { value: '01062026' } })
        expect(isoDelPadre()).toBe('2026-06-01T07:30:00.000Z')
    })

    it('svuotare l’ora di un istante completo lo riporta a vuoto', () => {
        render(<Padre iniziale={ISO_1_GIU_18} />)
        fireEvent.change(campoOra(), { target: { value: '' } })
        expect(isoDelPadre()).toBe('')
        expect(campoData().value, 'la data non c’entra e resta dov’è').toBe('01/06/2026')
    })

    it('giro completo: `2026-06-01T18:00` → ISO → riletto → `18:00` (e non 16:00 UTC)', () => {
        render(<Padre />)
        fireEvent.change(campoData(), { target: { value: '01062026' } })
        fireEvent.change(campoOra(), { target: { value: '18:00' } })
        expect(isoDelPadre()).toBe(ISO_1_GIU_18)

        // Rimontato DA CAPO su quell'ISO: è la riapertura in modifica.
        cleanup()
        render(<Padre iniziale={ISO_1_GIU_18} />)
        expect(campoData().value).toBe('01/06/2026')
        expect(campoOra().value).toBe('18:00')
    })

    it('un `value` cambiato DALL’ESTERNO riallinea i due campi', () => {
        // Il controllo positivo del guard: i pezzi non sono congelati, solo
        // immuni alla digitazione in corso.
        function Esterno() {
            const [iso, setIso] = useState('')
            return (
                <div>
                    <span id="g">{ETICHETTA_GRUPPO}</span>
                    <button type="button" onClick={() => setIso(ISO_12_OTT_2359)}>carica</button>
                    <DateTimeField
                        value={iso}
                        onChange={setIso}
                        idData="d"
                        idOra="o"
                        labelledBy="g"
                        etichettaData={ETICHETTA_DATA}
                        etichettaOra={ETICHETTA_ORA}
                    />
                </div>
            )
        }
        render(<Esterno />)
        expect(campoData().value).toBe('')
        fireEvent.click(screen.getByRole('button', { name: 'carica' }))
        expect(campoData().value).toBe('12/10/2026')
        expect(campoOra().value).toBe('23:59')
    })
})

// =============================================================================
// Il preriempimento dell'ora: visibile, modificabile, mai sovrascritto
// =============================================================================

describe('DateTimeField — l’ora si scrive da sola la prima volta, e poi mai più', () => {
    it('alla prima data valida, l’ora vuota diventa `23:59` — e si VEDE nel campo', () => {
        render(<Padre />)
        fireEvent.change(campoData(), { target: { value: '12102026' } })
        expect(campoOra().value).toBe('23:59')
        expect(isoDelPadre()).toBe(ISO_12_OTT_2359)
    })

    it('un’ora già scritta NON viene sovrascritta dalla data che arriva dopo', () => {
        render(<Padre />)
        fireEvent.change(campoOra(), { target: { value: '07:45' } })
        fireEvent.change(campoData(), { target: { value: '12102026' } })
        expect(campoOra().value).toBe('07:45')
    })

    it('e dopo che è stata svuotata a mano non ricompare: «mai sovrascritta» è un comportamento', () => {
        render(<Padre />)
        fireEvent.change(campoData(), { target: { value: '12102026' } })
        expect(campoOra().value).toBe('23:59')

        fireEvent.change(campoOra(), { target: { value: '' } })
        // Si ritocca la data: l'ora è vuota, ma è vuota PER SCELTA.
        cancella(campoData())
        batti(campoData(), '7')
        expect(campoOra().value).toBe('')
        expect(isoDelPadre()).toBe('')
    })
})

// =============================================================================
// Accessibilità — due etichette vere, un gruppo con un nome
// =============================================================================

describe('DateTimeField — i due campi hanno un nome, e il gruppo pure', () => {
    it('ogni campo si raggiunge dalla sua etichetta VISIBILE, nei due versi', () => {
        render(<Padre />)
        for (const [etichetta, campo] of [
            [ETICHETTA_DATA, campoData()],
            [ETICHETTA_ORA, campoOra()],
        ] as const) {
            // `element.labels` è la lettura che fa il browser: un `aria-label`
            // messo per far passare il test non la soddisfa.
            expect(campo.labels?.length, `«${etichetta}» non ha un <label> associato`).toBe(1)
            expect(campo.labels?.[0].textContent).toBe(etichetta)
        }
        expect(campoOra().type).toBe('time')
        expect(campoData().type, 'la data resta il campo MASCHERATO, non un `type=date`').toBe('text')
    })

    it('i due campi stanno in un `role="group"` che porta il nome della scadenza', () => {
        render(<Padre />)
        const gruppo = screen.getByRole('group', { name: ETICHETTA_GRUPPO })
        expect(gruppo).toContainElement(campoData())
        expect(gruppo).toContainElement(campoOra())
    })

    it('l’aiuto descrive ENTRAMBI i campi', () => {
        render(<Padre />)
        for (const campo of [campoData(), campoOra()]) {
            expect(campo).toHaveAttribute('aria-describedby', 'aiuto-scadenza')
        }
        // Controllo positivo: l'id puntato esiste davvero e porta quel testo.
        expect(document.getElementById('aiuto-scadenza')?.textContent).toBe(AIUTO)
    })

    it('`required` si dichiara su tutti e due i pezzi (metà istante non è un istante)', () => {
        function Obbligatorio() {
            return (
                <div>
                    <span id="g">{ETICHETTA_GRUPPO}</span>
                    <DateTimeField
                        value=""
                        onChange={() => {}}
                        idData="d"
                        idOra="o"
                        labelledBy="g"
                        required
                        etichettaData={ETICHETTA_DATA}
                        etichettaOra={ETICHETTA_ORA}
                    />
                </div>
            )
        }
        render(<Obbligatorio />)
        expect(campoData()).toBeRequired()
        expect(campoOra()).toBeRequired()
        cleanup()
        // …e senza la prop non lo dichiara nessuno dei due: senza questa metà,
        // `required` scritto fisso passerebbe.
        render(<Padre />)
        expect(campoData()).not.toBeRequired()
        expect(campoOra()).not.toBeRequired()
    })

    it('gli id arrivano dal CHIAMANTE: due istanze non si rubano le etichette', () => {
        // Nessun `useId()` interno: il punto d'uso deve poter puntare le proprie
        // `<label>`, il proprio aiuto e il proprio errore agli stessi id. Due
        // istanze con id distinti restano due campi distinti, e la digitazione in
        // una non tocca l'altra.
        function Uno({ suffisso }: { suffisso: string }) {
            const [iso, setIso] = useState('')
            return (
                <div>
                    <span id={`g-${suffisso}`}>{`Gruppo ${suffisso}`}</span>
                    <DateTimeField
                        value={iso}
                        onChange={setIso}
                        idData={`d-${suffisso}`}
                        idOra={`o-${suffisso}`}
                        labelledBy={`g-${suffisso}`}
                        etichettaData={`Giorno ${suffisso}`}
                        etichettaOra={`Ora ${suffisso}`}
                    />
                </div>
            )
        }
        render(
            <>
                <Uno suffisso="uno" />
                <Uno suffisso="due" />
            </>,
        )
        const primo = screen.getByLabelText('Giorno uno') as HTMLInputElement
        const secondo = screen.getByLabelText('Giorno due') as HTMLInputElement
        expect(primo.id).not.toBe(secondo.id)
        fireEvent.change(primo, { target: { value: '01062026' } })
        expect(primo.value).toBe('01/06/2026')
        expect(secondo.value).toBe('')
    })

    it('nessuna violazione axe', async () => {
        const { container } = render(<Padre iniziale={ISO_1_GIU_18} />)
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })

    it('ENTRAMBI i campi stanno a ≥16px: sotto quella soglia iOS zooma e la pagina resta ingrandita', () => {
        // Il chiamante vero (`AvvisoFormScadenze.tsx`) passa `CLASSI_CAMPO`, che
        // contiene `text-sm` (14px): la difesa non può dipendere dalla classe, o
        // metà coppia resta scoperta.
        render(<Padre iniziale={ISO_1_GIU_18} className="text-sm" />)
        for (const campo of [campoData(), campoOra()]) {
            expect(parseFloat(campo.style.fontSize)).toBeGreaterThanOrEqual(16)
        }
    })
})
