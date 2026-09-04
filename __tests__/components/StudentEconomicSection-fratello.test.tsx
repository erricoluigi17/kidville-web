/**
 * «Oppure: la paga …» nella scheda dell'alunno.
 *
 * ─── PERCHÉ QUESTA TENDINA ESISTE ────────────────────────────────────────────
 * `alunni.retta_a_carico_di` c'è dal 2026-08-16 ed è rispettata da entrambe le strade
 * che generano le rette, ma si poteva valorizzare SOLO dall'import delle iscrizioni.
 * Al 2026-09-04 in produzione **44 alunni** ce l'avevano — 37 alla sola Giugliano —
 * senza che nessuna schermata la mostrasse. La route dell'import lo sapeva già, e nel
 * suo messaggio d'errore mandava «Va corretto dalla scheda dell'alunno»: una schermata
 * che non esisteva.
 *
 * 🔴 Che cosa costa non vederla, misurato: un bambino di Giugliano con retta 250 €
 * marcato a carico di un fratello che aveva 0,01 €. Entrambi i generatori saltano chi
 * è a carico di un altro, quindi la famiglia è stata addebitata di un centesimo per
 * settembre 2026. L'ultimo caso qui sotto è esattamente quella situazione, guardata
 * dalla scheda: dev'essere leggibile a occhio.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next-intl', async () => {
    const catalogo = (await import('../../messages/it/adminStudents.json')).default as Record<string, string>
    const useTranslations = () => {
        const t = (key: string, valori?: Record<string, unknown>) => {
            const grezzo = catalogo[key] ?? key
            return valori
                ? grezzo.replace(/\{(\w+)\}/g, (_m, k: string) => String(valori[k] ?? ''))
                : grezzo
        }
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    }
    return { useTranslations, useLocale: () => 'it', NextIntlClientProvider: ({ children }: { children: unknown }) => children }
})

import { StudentEconomicSection } from '@/components/features/admin/StudentEconomicSection'

const AL = 'al-1'
const PAGANTE = 'al-2'
const RITIRATO = 'al-3'

interface FratelloProva {
    id: string
    nome: string
    cognome: string
    stato: string
    retta_a_carico_di: string | null
    importo_retta_mensile: number
}

const FRATELLI: FratelloProva[] = [
    { id: PAGANTE, nome: 'Anna', cognome: 'Bianchi', stato: 'iscritto', retta_a_carico_di: null, importo_retta_mensile: 250 },
    { id: RITIRATO, nome: 'Luca', cognome: 'Bianchi', stato: 'ritirato', retta_a_carico_di: null, importo_retta_mensile: 0 },
]

function monta(form: Record<string, unknown>, fratelli: FratelloProva[] = FRATELLI) {
    const updateForm = vi.fn()
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [] }) })) as unknown as typeof fetch
    render(
        <StudentEconomicSection
            alunnoId={AL}
            form={form}
            updateForm={updateForm}
            siblings={fratelli}
        />
    )
    return { updateForm }
}

function tendina(): HTMLSelectElement {
    return screen.getByLabelText(/oppure/i) as HTMLSelectElement
}

afterEach(cleanup)

describe('StudentEconomicSection · «la paga il fratello»', () => {
    it('elenca i fratelli ISCRITTI, e solo quelli', () => {
        monta({ importo_retta_mensile: 150 })
        const opzioni = [...tendina().options].map((o) => o.value)
        expect(opzioni).toContain(PAGANTE)
        // Un ritirato non genera più rette: metterglielo a carico significa che la
        // retta di questo bambino non la chiede più nessuno.
        expect(opzioni).not.toContain(RITIRATO)
    })

    it('sceglierlo scrive il legame E porta l’importo a 0, insieme', () => {
        const { updateForm } = monta({ importo_retta_mensile: 150 })
        fireEvent.change(tendina(), { target: { value: PAGANTE } })
        expect(updateForm).toHaveBeenCalledWith('retta_a_carico_di', PAGANTE)
        expect(updateForm).toHaveBeenCalledWith('importo_retta_mensile', 0)
    })

    it('con un fratello che paga, il campo dell’importo è BLOCCATO', () => {
        monta({ importo_retta_mensile: 0, retta_a_carico_di: PAGANTE })
        const importo = screen.getByLabelText(/importo retta mensile/i) as HTMLInputElement
        expect(importo.disabled).toBe(true)
    })

    it('«paga la propria retta» toglie il legame e riapre il campo', () => {
        const { updateForm } = monta({ importo_retta_mensile: 0, retta_a_carico_di: PAGANTE })
        fireEvent.change(tendina(), { target: { value: '' } })
        expect(updateForm).toHaveBeenCalledWith('retta_a_carico_di', null)
        // L'importo NON si tocca: uno zero su questa colonna significa «default di
        // sede», e sceglierlo al posto dell'operatore vorrebbe dire decidere una retta.
        expect(updateForm).not.toHaveBeenCalledWith('importo_retta_mensile', 0)
    })

    it('senza fratelli collegati la tendina non compare', () => {
        monta({ importo_retta_mensile: 150 }, [])
        expect(screen.queryByLabelText(/oppure/i)).toBeNull()
    })

    it('AVVISA su un importo simbolico: 0,01 € è il ripiego che le famiglie hanno inventato', () => {
        monta({ importo_retta_mensile: 0.01 })
        expect(screen.getByRole('alert').textContent).toMatch(/simbolic/i)
    })

    it('AVVISA quando il legame c’è ma l’importo non è zero — le due facce divergono', () => {
        monta({ importo_retta_mensile: 250, retta_a_carico_di: PAGANTE })
        expect(screen.getByRole('alert').textContent).toBeTruthy()
    })

    it('dice, in sola lettura, quando è QUESTO bambino a pagare per un fratello', () => {
        // Il caso di Giugliano guardato dalla scheda giusta: il fratello ha 250 € ed è
        // a carico di questo bambino. Senza questa riga il legame rovesciato resta
        // invisibile da entrambe le schede.
        monta({ importo_retta_mensile: 0.01 }, [
            { id: PAGANTE, nome: 'Anna', cognome: 'Bianchi', stato: 'iscritto', retta_a_carico_di: AL, importo_retta_mensile: 250 },
        ])
        expect(screen.getByText(/paghi anche la retta di/i)).toBeTruthy()
        expect(screen.getByText(/Anna Bianchi/)).toBeTruthy()
    })
})
