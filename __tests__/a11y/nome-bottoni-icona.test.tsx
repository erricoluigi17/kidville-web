import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

/**
 * Il NOME ACCESSIBILE dei comandi a sola icona — reso davvero, non dedotto.
 *
 * IL DIFETTO. Nel registro presenze del docente i tre comandi in cima alla tabella
 * mensile (mese precedente, mese successivo, aggiorna) erano `<button>` con dentro
 * una sola icona di lucide e nient'altro: nessun testo, nessun `aria-label`. Uno
 * screen reader li annunciava «pulsante», tre volte di fila, e non c'era modo di
 * sapere quale spostasse il mese indietro. axe li vede come `button-name`, impatto
 * `critical` — cioè un fallimento di WCAG 4.1.2 (Nome, Ruolo, Valore), livello A.
 *
 * PERCHÉ QUESTO TEST ESISTE ACCANTO AL LOCK STATICO.
 * `__tests__/architecture/bottone-icona-con-nome.test.ts` legge il SORGENTE di tutti
 * i `.tsx` e vieta la forma. È il presidio che scala. Ma un lock statico non può
 * accorgersi che l'attributo esiste e viene reso VUOTO, né che la chiave i18n
 * scritta lì dentro non esista nel catalogo: `aria-label={t('chiaveSbagliata')}` è
 * indistinguibile, per una sonda sul testo, da `aria-label={t('chiaveGiusta')}`.
 * Qui il componente si monta davvero e il nome si legge dall'albero accessibile.
 *
 * LA TRAPPOLA DEL MOCK (già pagata in questo ciclo).
 * `test/setup.ts` mocka `next-intl` con `t = (chiave) => messages/it[ns][chiave]`:
 * risolve la chiave sul catalogo italiano VERO, ma IGNORA i valori di
 * interpolazione. Due conseguenze che questo file evita di proposito:
 *   · un'asserzione scritta come `expect(nome).toBe(t('mesePrecedente'))` sarebbe
 *     VERDE PER COSTRUZIONE — confronterebbe la stessa funzione con se stessa,
 *     anche con la chiave sbagliata. Qui il testo atteso è scritto in chiaro
 *     («Mese precedente»), quindi la chiave dev'essere quella giusta E deve
 *     esistere nel catalogo italiano;
 *   · una chiave ASSENTE dal catalogo non lascia il nome vuoto: il mock (come
 *     next-intl in produzione) restituisce il percorso `teacherPresenze.chiave`.
 *     axe sarebbe verde su un nome che a schermo si legge come un percorso — e
 *     per questo axe da solo non basta, e il testo atteso è scritto qui sotto.
 * Nessuno dei nomi qui coinvolti è interpolato, ed è una scelta: il nome
 * accessibile di un comando deve restare STABILE (un nome che cambia insieme allo
 * stato fa perdere il riferimento a chi naviga per elenco di controlli).
 */

expect.extend(toHaveNoViolations)

import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable'
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal'

const risposta = (dati: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(dati) } as unknown as Response)

beforeEach(() => {
    // Il componente carica alunni e presenze in parallelo appena montato: senza
    // rete la resa è la stessa (elenco vuoto), ma il fetch reale di jsdom
    // stamperebbe un errore non gestito e sporcherebbe l'output.
    vi.stubGlobal('fetch', vi.fn((url: string) =>
        risposta(String(url).includes('/api/diary/students') ? [] : []),
    ))
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('a11y · i comandi a sola icona hanno un nome (WCAG 4.1.2, livello A)', () => {
    it('registro presenze del docente: nessuna violazione axe, `button-name` compreso', async () => {
        const { container } = render(<MonthlyAttendanceTable sezione="SEZIONE-DI-PROVA" />)
        // Rule-set come in `smoke.axe.test.tsx`: le regole di documento non si
        // applicano a un componente isolato, e senza layout il contrasto non è
        // calcolabile in jsdom.
        expect(
            await axe(container, {
                rules: {
                    region: { enabled: false },
                    'landmark-one-main': { enabled: false },
                    'page-has-heading-one': { enabled: false },
                },
            }),
        ).toHaveNoViolations()
    })

    it('i tre comandi del mese si annunciano col loro nome italiano, non «pulsante»', () => {
        render(<MonthlyAttendanceTable sezione="SEZIONE-DI-PROVA" />)

        // `getByRole(..., { name })` interroga l'ALBERO ACCESSIBILE: è esattamente
        // ciò che legge uno screen reader, non l'attributo grezzo.
        expect(screen.getByRole('button', { name: 'Mese precedente' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Mese successivo' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Aggiorna' })).toBeInTheDocument()

        // CONTROLLO POSITIVO sul MOCK: se `test/setup.ts` smettesse di risolvere le
        // chiavi sul catalogo italiano vero (per esempio tornando a `t = k => k`),
        // le tre righe qui sopra fallirebbero — ma per la ragione sbagliata, e
        // qualcuno le «aggiusterebbe» confrontando la chiave. Questa riga dice ad
        // alta voce che cosa deve fare il mock perché il test abbia senso.
        expect(screen.getByRole('button', { name: /Esporta PDF/i })).toBeInTheDocument()
    })

    it('modale di uscita dell’alunno: la X di chiusura si annuncia «Chiudi»', () => {
        // Secondo componente montato di proposito: il lock statico vede la FORMA in
        // tutto `src/`, questo vede il NOME reso — e sono due prove diverse. Qui la
        // chiave (`teacherPresenze.chiudi`) è nata in questo intervento: se il
        // catalogo la perdesse, il nome diventerebbe «teacherPresenze.chiudi» e
        // axe resterebbe verde. Questa riga no.
        render(
            <CheckoutModal
                studentName="Alunno di prova"
                delegates={[]}
                onClose={() => {}}
                onConfirmCheckout={() => {}}
                onPanicAlert={() => {}}
            />,
        )
        expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
    })

    it('nessun bottone dell’intestazione resta senza nome accessibile', () => {
        const { container } = render(<MonthlyAttendanceTable sezione="SEZIONE-DI-PROVA" />)
        const senzaNome = [...container.querySelectorAll('button')].filter((b) => {
            const etichetta = b.getAttribute('aria-label') ?? ''
            return !etichetta.trim() && !b.textContent?.trim() && !b.getAttribute('aria-labelledby')
        })
        expect(
            senzaNome.map((b) => b.outerHTML.slice(0, 120)),
            'Bottoni senza nome accessibile: uno screen reader li annuncia «pulsante».',
        ).toEqual([])
    })
})
