/**
 * L'ora dell'appello 0-6 si può CORREGGERE.
 *
 * Fino a oggi, nel nido e nell'infanzia, l'orario era testo in sola lettura: il
 * registro scriveva l'ora del TOCCO — `new Date().toISOString()` sul tablet della
 * maestra — e non c'era nessun modo di dire che il bambino era arrivato alle 09:40
 * e non alle 10:15. La primaria sa farlo da sempre (`<input type="time">` nella sua
 * schermata d'appello); lo 0-6 no.
 *
 * ⚠️ TRE COSE CHE QUESTO FILE SORVEGLIA, e che sono la parte difficile:
 *
 * 1. **L'ora mostrata è quella ITALIANA, e quella proposta nell'input pure.** La
 *    colonna contiene un ISO UTC: un input pre-riempito con `10:35` invece di
 *    `12:35` farebbe correggere alla maestra un'ora che era già giusta.
 * 2. **Senza `onSetOrario` la riga resta com'era.** La prop è opzionale apposta:
 *    due schermate montano questo componente senza, e non devono cambiare.
 * 3. **Il comando è tattile e nominato.** Si fa l'appello da tablet: il bersaglio
 *    non scende sotto i 44px e l'etichetta dice DI CHI è l'ora, perché in una
 *    lista di venti bambini «modifica orario» da solo non dice niente.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        teacherPresenze: (await import('../../messages/it/teacherPresenze.json')).default,
        teacherPrimaria: (await import('../../messages/it/teacherPrimaria.json')).default,
    }
    const risolvi = (ns: string | undefined, key: string, v?: Record<string, unknown>): string => {
        const grezzo = ns ? cataloghi[ns]?.[key] : undefined
        if (grezzo == null) return ns ? `${ns}.${key}` : key
        return grezzo.replace(/\{(\w+)\}/g, (_m, k) => String(v?.[k] ?? `{${k}}`))
    }
    const useTranslations = (ns?: string) => {
        const t = (key: string, v?: Record<string, unknown>) => risolvi(ns, key, v)
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

const riga = (extra: Partial<AttendanceRecord> = {}): AttendanceRecord => ({
    id: 'p-1',
    alunno_id: 'a-1',
    data: '2026-09-07',
    stato: 'presente',
    orario_entrata: '2026-09-07T10:35:00.000Z', // = 12:35 italiane
    orario_uscita: null,
    ...extra,
})

type FintoSetOrario = (studentId: string, campo: 'entrata' | 'uscita', ora: string) => void

function monta(record: AttendanceRecord, onSetOrario?: FintoSetOrario) {
    return render(
        <StudentAttendanceRow
            student={STUDENTE}
            record={record}
            onSetStato={vi.fn()}
            onCheckoutClick={vi.fn()}
            {...(onSetOrario ? { onSetOrario } : {})}
        />,
    )
}

afterEach(cleanup)

describe('senza onSetOrario — la riga di prima, intatta', () => {
    it('l\'orario resta testo: nessun comando compare', () => {
        monta(riga())
        expect(document.querySelector('#btn-orario-entrata-a-1')).toBeNull()
        expect(screen.getByText(/12:35/)).toBeTruthy()
    })
})

describe('con onSetOrario — l\'ora si corregge', () => {
    it('l\'ingresso di un PRESENTE è un comando, e mostra l\'ora italiana', () => {
        monta(riga(), vi.fn())
        const b = document.querySelector('#btn-orario-entrata-a-1') as HTMLButtonElement
        expect(b).toBeTruthy()
        expect(b.textContent).toContain('12:35')
    })

    it('l\'etichetta dice di CHI è l\'ora: in venti righe «modifica orario» non basta', () => {
        monta(riga(), vi.fn())
        const b = document.querySelector('#btn-orario-entrata-a-1') as HTMLButtonElement
        expect(b.getAttribute('aria-label')).toContain('Bimbo')
        expect(b.getAttribute('aria-label')).toContain('12:35')
    })

    it('il bersaglio tattile non scende sotto i 44px: l\'appello si fa da tablet', () => {
        monta(riga(), vi.fn())
        const b = document.querySelector('#btn-orario-entrata-a-1') as HTMLButtonElement
        expect(b.className).toContain('min-h-11')
    })

    it('al tocco compare un campo ora PRE-RIEMPITO con l\'ora italiana, non con l\'UTC', () => {
        monta(riga(), vi.fn())
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        const input = document.querySelector('#input-orario-entrata-a-1') as HTMLInputElement
        expect(input).toBeTruthy()
        expect(input.type).toBe('time')
        expect(input.value).toBe('12:35')
    })

    it('salvando si chiama onSetOrario con il campo e la nuova ora', () => {
        const onSetOrario = vi.fn()
        monta(riga(), onSetOrario)
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        const input = document.querySelector('#input-orario-entrata-a-1') as HTMLInputElement
        fireEvent.change(input, { target: { value: '09:10' } })
        fireEvent.click(document.querySelector('#btn-salva-orario-entrata-a-1')!)
        expect(onSetOrario).toHaveBeenCalledWith('a-1', 'entrata', '09:10')
    })

    it('Invio conferma senza dover cercare il bottone', () => {
        const onSetOrario = vi.fn()
        monta(riga(), onSetOrario)
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        const input = document.querySelector('#input-orario-entrata-a-1') as HTMLInputElement
        fireEvent.change(input, { target: { value: '09:10' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onSetOrario).toHaveBeenCalledWith('a-1', 'entrata', '09:10')
    })

    it('annullando non si chiama niente e torna il valore di prima', () => {
        const onSetOrario = vi.fn()
        monta(riga(), onSetOrario)
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        fireEvent.change(document.querySelector('#input-orario-entrata-a-1')!, { target: { value: '09:10' } })
        fireEvent.click(document.querySelector('#btn-annulla-orario-entrata-a-1')!)
        expect(onSetOrario).not.toHaveBeenCalled()
        expect((document.querySelector('#btn-orario-entrata-a-1') as HTMLElement).textContent).toContain('12:35')
    })

    it('Esc annulla', () => {
        const onSetOrario = vi.fn()
        monta(riga(), onSetOrario)
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        fireEvent.keyDown(document.querySelector('#input-orario-entrata-a-1')!, { key: 'Escape' })
        expect(onSetOrario).not.toHaveBeenCalled()
        expect(document.querySelector('#input-orario-entrata-a-1')).toBeNull()
    })

    it('un\'ora vuota non si salva: cancellare non è correggere', () => {
        const onSetOrario = vi.fn()
        monta(riga(), onSetOrario)
        fireEvent.click(document.querySelector('#btn-orario-entrata-a-1')!)
        fireEvent.change(document.querySelector('#input-orario-entrata-a-1')!, { target: { value: '' } })
        fireEvent.click(document.querySelector('#btn-salva-orario-entrata-a-1')!)
        expect(onSetOrario).not.toHaveBeenCalled()
    })
})

describe('quali orari sono correggibili, per stato', () => {
    it('RITARDO: l\'ingresso sì — è il caso per cui la richiesta è nata', () => {
        monta(riga({ stato: 'ritardo' }), vi.fn())
        expect(document.querySelector('#btn-orario-entrata-a-1')).toBeTruthy()
    })

    it('USCITA ANTICIPATA: si correggono TUTTI E DUE — chi esce prima era comunque entrato', () => {
        monta(riga({ stato: 'uscita_anticipata', orario_uscita: '2026-09-07T11:06:00.000Z' }), vi.fn())
        expect(document.querySelector('#btn-orario-entrata-a-1')).toBeTruthy()
        const uscita = document.querySelector('#btn-orario-uscita-a-1') as HTMLButtonElement
        expect(uscita).toBeTruthy()
        expect(uscita.textContent).toContain('13:06')
    })

    it('ASSENTE: nessun orario, in nessuna forma', () => {
        monta(riga({ stato: 'assente', orario_entrata: null }), vi.fn())
        expect(document.querySelector('#btn-orario-entrata-a-1')).toBeNull()
        expect(document.querySelector('#btn-orario-uscita-a-1')).toBeNull()
    })

    // ⚠️ ROVESCIATO IL 2026-09-07, per decisione del titolare, e la riga esiste perché
    // il prossimo lettore non lo «ripristini» leggendolo come una svista. Fino a quel
    // giorno l'uscita si mostrava solo a chi era in `uscita_anticipata` (o l'aveva già
    // registrata): un bambino uscito all'orario NORMALE non aveva nessuna ora d'uscita
    // da segnare, e della sua giornata mancava l'ora in cui è andato a casa.
    // La regola vive ora in `@/lib/presenze/orario-ammesso`, insieme al 422 del server.
    it('PRESENTE: anche l\'uscita si può registrare, e lo dice quando non c\'è', () => {
        monta(riga(), vi.fn())
        const b = document.querySelector('#btn-orario-uscita-a-1') as HTMLButtonElement
        expect(b).toBeTruthy()
        expect(b.textContent).toContain('non registrato')
    })

    it('ASSENTE: nessuno dei due, perché non è mai arrivato', () => {
        monta(riga({ stato: 'assente', orario_entrata: null }), vi.fn())
        expect(document.querySelector('#btn-orario-entrata-a-1')).toBeNull()
        expect(document.querySelector('#btn-orario-uscita-a-1')).toBeNull()
    })

    it('presente senza ora registrata: lo dice, e propone l\'ora corrente', () => {
        monta(riga({ orario_entrata: null }), vi.fn())
        const b = document.querySelector('#btn-orario-entrata-a-1') as HTMLButtonElement
        expect(b).toBeTruthy()
        expect(b.textContent).toContain('non registrato')
        fireEvent.click(b)
        const input = document.querySelector('#input-orario-entrata-a-1') as HTMLInputElement
        expect(input.value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
    })
})

describe('le altre forme che la colonna contiene', () => {
    it('HH:MM nudo (storico e seed E2E)', () => {
        monta(riga({ orario_entrata: '08:45' }), vi.fn())
        expect((document.querySelector('#btn-orario-entrata-a-1') as HTMLElement).textContent).toContain('08:45')
    })

    it('ISO naïve (la primaria): le cifre sono già italiane', () => {
        monta(riga({ orario_entrata: '2026-09-04T09:40:00' }), vi.fn())
        expect((document.querySelector('#btn-orario-entrata-a-1') as HTMLElement).textContent).toContain('09:40')
    })
})
