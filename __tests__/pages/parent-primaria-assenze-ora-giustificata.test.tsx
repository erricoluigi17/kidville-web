import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import itPrimaria from '../../messages/it/parentPrimaria.json'
import enPrimaria from '../../messages/en/parentPrimaria.json'

/**
 * A5 (2026-09-26) · /parent/primaria/assenze — il ritardo e l'uscita GIUSTIFICATI.
 *
 * Il docente della primaria può segnare un ritardo o un'uscita anticipata come
 * giustificati (es. terapia): lo stato resta quello vero — il bambino non era in
 * classe — ma quelle ore non contano nelle assenze. Decisione del titolare: il
 * genitore VEDE la nota. Quindi la riga dice «Ritardo giustificato: terapia» (o
 * «Uscita anticipata giustificata: …») e chiarisce che quelle ore non contano.
 *
 * Si guarda la frase INTERA dal catalogo vero, e si aspetta sempre la PRESENZA
 * di qualcosa prima di controllare un'assenza.
 */

vi.mock('next/navigation', () => ({
    usePathname: () => '/parent/primaria/assenze',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p-1', studentId: 's-1', figliIds: ['s-1'], ready: true }),
}))

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Error'),
}))

/** next-intl coi cataloghi VERI e l'interpolazione: la frase deve uscire tutta. */
vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentAssenze: (await import('../../messages/it/parentAssenze.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
    }
    const risolvi = (ns: string | undefined, key: string): string =>
        (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
    const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
        modello.replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero))
    const useTranslations = (ns?: string) => {
        const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori)
        return Object.assign(t, { rich: t, markup: t, raw: (k: string) => risolvi(ns, k), has: () => true })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

import AssenzeGenitorePage from '@/app/(dashboard)/parent/primaria/assenze/page'

type Riga = Record<string, unknown>
const riga = (o: Riga): Riga => ({
    id: 'r',
    data: '2026-09-25',
    stato: 'ritardo',
    orario_entrata: '2026-09-25T10:05:00',
    orario_uscita: null,
    giustificata: false,
    giustificazione_testo: null,
    giustificata_il: null,
    note_appello: null,
    assenza_oraria_giustificata: false,
    ...o,
})

let cronologia: Riga[] = []

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            if (url.includes('/api/parent/primaria/assenze')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        success: true,
                        data: cronologia,
                        letto: true,
                        riepilogo: { presente: 120, assente: 0, ritardo: 1, uscita_anticipata: 1 },
                        riepilogoLetto: true,
                    }),
                })
            }
            if (url.includes('/api/parent/presenze')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ success: true, data: { comunicate: [], comunicateLette: true } }),
                })
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
        }),
    )
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

const frase = (modello: string, nota: string) => modello.replace('{nota}', nota)
const notaDocente = (v: string) => itPrimaria.assenzeNotaDocente.replace('{value}', v)

describe('A5 · ritardo e uscita giustificati: il genitore legge la nota', () => {
    it('ritardo giustificato: «Ritardo giustificato: terapia» e «queste ore non contano»', async () => {
        cronologia = [riga({ id: 'r1', note_appello: 'terapia', assenza_oraria_giustificata: true })]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(frase(itPrimaria.assenzeOraGiustRitardo, 'terapia'))).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeOraGiustNonConta)).toBeInTheDocument()
        // La nota non si ripete una seconda volta come «Nota docente»: è la stessa frase.
        expect(screen.queryByText(notaDocente('terapia'))).not.toBeInTheDocument()
        // L'ora d'ingresso resta: lo stato è sempre un ritardo.
        expect(screen.getByText(itPrimaria.assenzeEntrata.replace('{ora}', '10:05'))).toBeInTheDocument()
    })

    it('uscita anticipata giustificata: «Uscita anticipata giustificata: logopedia»', async () => {
        cronologia = [
            riga({
                id: 'u1',
                stato: 'uscita_anticipata',
                orario_entrata: null,
                orario_uscita: '2026-09-25T11:30:00',
                note_appello: 'logopedia',
                assenza_oraria_giustificata: true,
            }),
        ]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(frase(itPrimaria.assenzeOraGiustUscita, 'logopedia'))).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeOraGiustNonConta)).toBeInTheDocument()
        expect(screen.queryByText(frase(itPrimaria.assenzeOraGiustRitardo, 'logopedia'))).not.toBeInTheDocument()
        // L'ora d'uscita resta: lo stato è sempre un'uscita anticipata.
        expect(screen.getByText(itPrimaria.assenzeUscita.replace('{ora}', '11:30'))).toBeInTheDocument()
    })

    it('flag acceso ma nota vuota (dato storico): «Ritardo giustificato» senza due punti appesi', async () => {
        cronologia = [riga({ id: 'r2', note_appello: '   ', assenza_oraria_giustificata: true })]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(itPrimaria.assenzeOraGiustRitardoSenzaNota)).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeOraGiustNonConta)).toBeInTheDocument()
    })

    it('uscita giustificata con nota vuota: «Uscita anticipata giustificata», non la frase del ritardo', async () => {
        cronologia = [
            riga({
                id: 'u2',
                stato: 'uscita_anticipata',
                orario_entrata: null,
                orario_uscita: '2026-09-25T11:30:00',
                note_appello: '  ',
                assenza_oraria_giustificata: true,
            }),
        ]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(itPrimaria.assenzeOraGiustUscitaSenzaNota)).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeOraGiustNonConta)).toBeInTheDocument()
        expect(screen.queryByText(itPrimaria.assenzeOraGiustRitardoSenzaNota)).not.toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeUscita.replace('{ora}', '11:30'))).toBeInTheDocument()
    })

    it('CONTROLLO: ritardo NON giustificato con nota → «Nota docente», nessun «giustificato», nessun «non contano»', async () => {
        cronologia = [riga({ id: 'r3', note_appello: 'traffico', assenza_oraria_giustificata: false })]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(notaDocente('traffico'))).toBeInTheDocument()
        expect(screen.queryByText(frase(itPrimaria.assenzeOraGiustRitardo, 'traffico'))).not.toBeInTheDocument()
        expect(screen.queryByText(itPrimaria.assenzeOraGiustNonConta)).not.toBeInTheDocument()
    })

    it('un flag vero su un’assenza piena non la fa diventare «giustificata dalla scuola»', async () => {
        cronologia = [
            riga({ id: 'a1', stato: 'assente', orario_entrata: null, note_appello: 'febbre', assenza_oraria_giustificata: true }),
        ]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(notaDocente('febbre'))).toBeInTheDocument()
        expect(screen.queryByText(itPrimaria.assenzeOraGiustNonConta)).not.toBeInTheDocument()
    })

    it('server più vecchio senza il campo: la pagina resta com’era', async () => {
        const vecchia = riga({ id: 'v1', note_appello: 'terapia' })
        delete vecchia.assenza_oraria_giustificata
        cronologia = [vecchia]
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText(notaDocente('terapia'))).toBeInTheDocument()
        expect(screen.queryByText(itPrimaria.assenzeOraGiustNonConta)).not.toBeInTheDocument()
    })
})

describe('A5 · le frasi esistono in entrambe le lingue, con la nota', () => {
    it('it ed en hanno le stesse chiavi, e la nota è interpolata', () => {
        const chiavi = [
            'assenzeOraGiustRitardo',
            'assenzeOraGiustUscita',
            'assenzeOraGiustRitardoSenzaNota',
            'assenzeOraGiustUscitaSenzaNota',
            'assenzeOraGiustNonConta',
        ] as const
        for (const k of chiavi) {
            expect(typeof itPrimaria[k], `it: ${k}`).toBe('string')
            expect(typeof enPrimaria[k], `en: ${k}`).toBe('string')
        }
        expect(enPrimaria.assenzeOraGiustRitardo).toContain('{nota}')
        expect(enPrimaria.assenzeOraGiustUscita).toContain('{nota}')
    })
})
