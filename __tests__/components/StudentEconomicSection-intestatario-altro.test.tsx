/**
 * «Intestatario fatture → Altro» nella scheda del bambino.
 *
 * ─── IL DIFETTO CHE QUESTO FILE CHIUDE ───────────────────────────────────────
 * La tendina offriva «Altro» e quattro caselle — nome, codice fiscale, indirizzo,
 * email — e chi le compilava usciva convinto di aver impostato un intestatario.
 * Non l'aveva fatto: per un cessionario persona fisica il tracciato FatturaPA
 * pretende `CodiceFiscale`, `Nome`, `Cognome` e la `Sede` completa (`Indirizzo`,
 * `CAP`, `Comune`), tutti NON facoltativi. Mancavano **CAP** e **comune**, e il
 * **cognome** — che nel tracciato è un elemento distinto dal nome, e non si ricava
 * spaccando una stringa in due.
 *
 * Il costo non è teorico: `prossimo_numero_fattura_sezionale` alloca il numero
 * PRIMA dell'upload. Un cessionario incompleto è un numero bruciato più uno scarto
 * SDI, che si corregge solo con una nota di variazione.
 *
 * ─── PERCHÉ LA REGOLA È IMPORTATA E NON RISCRITTA ────────────────────────────
 * `validaCessionario` di `@/lib/fatturazione/cessionario` è la STESSA funzione che
 * decide in emissione (fail-closed) e nell'anteprima. Una regola, tre posti: se la
 * schermata dicesse «va bene» e l'emissione dicesse «no», il difetto tornerebbe
 * identico con un test verde davanti.
 *
 * ⚠️ REPOSITORY PUBBLICO: nomi e codici fiscali sono SINTETICI. `RSSMRA85M01H501Z`
 * è il codice d'esempio dei manuali, legato al segnaposto convenzionale del repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
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
const GENITORE = 'p-1'

/** Un intestatario «Altro» completo secondo il contratto condiviso con il backend. */
const COMPLETO = {
    nome: 'Mario',
    cognome: 'Rossi',
    cf: 'RSSMRA85M01H501Z',
    indirizzo: 'Via delle Rose',
    cap: '80014',
    comune: 'Giugliano in Campania',
}

const PARENTS = [
    { relation_type: 'mother', parents: { id: GENITORE, first_name: 'Mario', last_name: 'Rossi' } },
]

/**
 * La scheda con lo stato VERO: la validazione è «dal vivo», e un `form` congelato
 * non potrebbe mostrarlo. Qui si digita e si guarda cambiare l'avviso.
 */
function Banco({ iniziale, parents }: { iniziale: Record<string, unknown>; parents?: typeof PARENTS }) {
    const [form, setForm] = useState<Record<string, unknown>>(iniziale)
    return (
        <StudentEconomicSection
            alunnoId={AL}
            form={form}
            updateForm={(campo, valore) => setForm((p) => ({ ...p, [campo]: valore }))}
            parents={parents}
        />
    )
}

function monta(dati: Record<string, string> | null, parents?: typeof PARENTS) {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [] }) })) as unknown as typeof fetch
    render(
        <Banco
            iniziale={{
                importo_retta_mensile: 150,
                intestatario_fatture: dati === null ? null : { tipo: 'altro', dati },
            }}
            parents={parents}
        />,
    )
}

/** L'avviso dell'intestatario, distinto da quello della retta (che è un altro `alert`). */
function avvisoIntestatario(): string {
    return screen.getByTestId('avviso-intestatario-altro').textContent ?? ''
}

afterEach(cleanup)

describe('StudentEconomicSection · intestatario «Altro» completo per la fattura elettronica', () => {
    it('mostra i sei campi che il tracciato pretende: nome, COGNOME, CF, indirizzo, CAP, COMUNE', () => {
        monta({})
        expect(screen.getByLabelText('Nome')).toBeTruthy()
        expect(screen.getByLabelText('Cognome')).toBeTruthy()
        expect(screen.getByLabelText('Codice fiscale')).toBeTruthy()
        expect(screen.getByLabelText('Indirizzo')).toBeTruthy()
        expect(screen.getByLabelText('CAP')).toBeTruthy()
        expect(screen.getByLabelText('Comune')).toBeTruthy()
    })

    it('CAP a quattro cifre: l’avviso NOMINA il campo e dice che è il formato', () => {
        monta({ ...COMPLETO, cap: '' })
        fireEvent.change(screen.getByLabelText('CAP'), { target: { value: '8014' } })
        const avviso = avvisoIntestatario()
        expect(avviso).toMatch(/CAP/)
        expect(avviso).toMatch(/formato/i)
        // ⚠️ Il `role="alert"` non è decorazione: senza, chi sta compilando col lettore
        // di schermo non sente nominare il campo che ha appena sbagliato — e la
        // segreteria si accorge del CAP monco solo davanti allo scarto SDI. Va asserito
        // qui perché niente altro lo protegge: toglierlo lasciava verdi tutti gli otto.
        expect(screen.getAllByRole('alert')).toContain(screen.getByTestId('avviso-intestatario-altro'))
    })

    it('codice fiscale malformato: l’avviso NOMINA il codice fiscale', () => {
        // La forma a 14 caratteri con quattro lettere iniziali: è quella che in
        // produzione hanno venti genitori su ventidue, e supera il pattern dello XSD.
        monta({ ...COMPLETO, cf: '' })
        fireEvent.change(screen.getByLabelText('Codice fiscale'), { target: { value: 'ABCD85M01H501Z' } })
        const avviso = avvisoIntestatario()
        expect(avviso).toMatch(/codice fiscale/i)
        expect(avviso).toMatch(/formato/i)
    })

    it('con i sei campi compilati non c’è nessun avviso, e lo dice', () => {
        // Il silenzio da solo non distingue «va bene» da «il controllo non gira»:
        // serve la conferma positiva.
        monta(COMPLETO)
        expect(avvisoIntestatario()).toBe('')
        expect(screen.getByTestId('intestatario-altro-completo')).toBeTruthy()
    })

    it('l’email vuota non impedisce niente: è fuori dal tracciato, e la schermata lo dice', () => {
        monta(COMPLETO)
        expect(avvisoIntestatario()).toBe('')
        expect(screen.getByText(/non entra nella fattura/i)).toBeTruthy()
    })

    it('scegliendo un genitore dall’elenco, i campi di «Altro» spariscono', () => {
        monta(COMPLETO, PARENTS)
        expect(screen.getByLabelText('Cognome')).toBeTruthy()
        fireEvent.change(screen.getByLabelText(/intestatario fatture/i), { target: { value: GENITORE } })
        expect(screen.queryByLabelText('Cognome')).toBeNull()
        expect(screen.queryByTestId('avviso-intestatario-altro')).toBeNull()
    })

    it('provincia e civico restano facoltativi: ci sono, e senza di loro non manca nulla', () => {
        monta(COMPLETO)
        expect(screen.getByLabelText(/^Civico/)).toBeTruthy()
        expect(screen.getByLabelText(/^Provincia/)).toBeTruthy()
        expect(avvisoIntestatario()).toBe('')
    })

    it('scrivere nel campo aggiorna il dato senza perdere gli altri', () => {
        monta({ ...COMPLETO, comune: '' })
        expect(avvisoIntestatario()).toMatch(/comune/i)
        fireEvent.change(screen.getByLabelText('Comune'), { target: { value: 'Aversa' } })
        expect(avvisoIntestatario()).toBe('')
        expect((screen.getByLabelText('Cognome') as HTMLInputElement).value).toBe('Rossi')
    })
})
