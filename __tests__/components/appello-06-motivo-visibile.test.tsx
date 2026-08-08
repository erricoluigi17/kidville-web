/**
 * T24 — «Il motivo lo leggono le insegnanti della sezione»: che sia vero.
 *
 * È la frase che il modulo del genitore mostra sotto il campo «Motivo», al
 * momento della raccolta di un dato di natura sanitaria di un MINORE (art. 9
 * GDPR). Per la primaria era vera — l'appello mostra la giustifica del genitore
 * da sempre. Per NIDO e INFANZIA, i due gradi che questo ciclo ha aperto per la
 * prima volta, non lo era: il testo veniva raccolto, conservato dodici mesi, e
 * non compariva su NESSUNA schermata del personale.
 *
 * Questo file lega la promessa alla superficie che la rende vera, come già fa
 * `informativa-conservazione-dichiarata.test.ts` con i dodici mesi: se un domani
 * la riga dell'appello 0-6 smettesse di mostrare il motivo, la frase mostrata
 * alla famiglia tornerebbe a essere inesatta e questo test diventerebbe rosso.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

/** next-intl con i cataloghi VERI: l'etichetta deve esistere in entrambe le lingue. */
vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        teacherPresenze: (await import('../../messages/it/teacherPresenze.json')).default,
        teacherPrimaria: (await import('../../messages/it/teacherPrimaria.json')).default,
    }
    const risolvi = (ns: string | undefined, key: string): string =>
        (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
    const useTranslations = (ns?: string) => {
        const t = (key: string) => risolvi(ns, key)
        return Object.assign(t, { rich: t, markup: t, raw: (k: string) => risolvi(ns, k), has: () => true })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

import { StudentAttendanceRow, type AttendanceRecord } from '@/components/features/teacher/StudentAttendanceRow'

const STUDENTE = { id: 'a-1', firstName: 'Bimbo', lastName: 'Test' }
const MOTIVO = 'febbre da ieri sera'

const riga = (extra: Partial<AttendanceRecord> = {}) => ({
    id: 'p-1',
    alunno_id: 'a-1',
    data: '2026-08-10',
    stato: 'assente' as const,
    orario_entrata: null,
    orario_uscita: null,
    ...extra,
})

afterEach(cleanup)

describe('T24 — la riga dell’appello 0-6 mostra il motivo comunicato dal genitore', () => {
    it('con il motivo: il testo è a schermo', () => {
        render(
            <StudentAttendanceRow
                student={STUDENTE}
                record={riga({ giustificazione_testo: MOTIVO })}
                onSetStato={() => {}}
                onCheckoutClick={() => {}}
            />,
        )
        expect(
            screen.getByText(new RegExp(MOTIVO, 'i')),
            'la famiglia legge «il motivo lo leggono le insegnanti della sezione»: deve essere vero',
        ).toBeTruthy()
    })

    it('con il motivo: c’è anche l’etichetta che dice DA CHI viene', () => {
        render(
            <StudentAttendanceRow
                student={STUDENTE}
                record={riga({ giustificazione_testo: MOTIVO })}
                onSetStato={() => {}}
                onCheckoutClick={() => {}}
            />,
        )
        // Etichetta già tradotta in italiano e inglese, riusata dall'appello
        // della primaria: nessuna stringa nuova, nessun testo cablato nel TSX.
        expect(screen.getByText(/giustificata dal genitore/i)).toBeTruthy()
    })

    it('senza motivo: la riga resta identica a prima (niente etichette vuote)', () => {
        const { container } = render(
            <StudentAttendanceRow
                student={STUDENTE}
                record={riga()}
                onSetStato={() => {}}
                onCheckoutClick={() => {}}
            />,
        )
        expect(container.textContent).not.toMatch(/giustificata dal genitore/i)
    })
})
