import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import itPrimaria from '../../messages/it/teacherPrimaria.json'

/**
 * LOCK · l'appello della primaria si apre sul giorno ITALIANO.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il terzo collaudo (2026-08-08) ha misurato, alle 01:2x italiane dell'8 agosto,
 * che /teacher/primaria/<id>/appello apriva il campo «Data dell'appello» sul
 * **07/08/2026**, mentre la pagina gemella dell'appello 0-6, nello stesso
 * istante e nello stesso browser, mostrava correttamente l'8. Causa:
 * `new Date().toISOString().slice(0,10)` è UTC, e fra mezzanotte e le due
 * italiane (ora legale) restituisce ancora IERI.
 *
 * Le conseguenze sono due, e la seconda è una SCRITTURA:
 *  (a) l'assenza che il genitore ha comunicato per oggi — il modulo del genitore
 *      preseleziona `oggiFiscaleISO()`, cioè la data italiana — non compare
 *      nella schermata che la maestra apre. Ed è la destinazione del link della
 *      notifica «Assenza comunicata»;
 *  (b) se la maestra segna e salva, salva sul giorno PRECEDENTE, sovrascrivendo
 *      righe già lavorate.
 *
 * Il difetto è sopravvissuto alla correzione del ciclo perché il rilievo era
 * stato scritto sulla schermata del GENITORE, e la correzione applicata lì.
 */

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => '/teacher/primaria/sez-1/appello',
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => 'd-1' }))

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.useRealTimers() })

import AppelloPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/appello/page'

/**
 * Il campo «Data dell'appello» è un `DateField`: un `type="text"` mascherato
 * `gg/mm/aaaa`. Si legge quello che la maestra LEGGE.
 */
const campoData = () => screen.getByLabelText(itPrimaria.appelloDataAria) as HTMLInputElement

describe('l’appello della primaria apre sul giorno civile italiano', () => {
    it('CONTROLLO POSITIVO: a metà giornata la data è quella di oggi', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        vi.setSystemTime(new Date('2026-08-08T12:00:00Z'))
        render(<AppelloPage />)
        expect(campoData().value).toBe('08/08/2026')
    })

    it('all’01:20 italiane (23:20Z del giorno prima) apre sull’8, non sul 7', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        // 2026-08-07T23:20:00Z = 2026-08-08 01:20 a Roma (ora legale, UTC+2).
        vi.setSystemTime(new Date('2026-08-07T23:20:00Z'))
        render(<AppelloPage />)

        expect(
            campoData().value,
            'La maestra apre la schermata alle 01:20 e trova IERI: l’assenza comunicata dal ' +
                'genitore per oggi non c’è, e se segna e salva sovrascrive righe già lavorate. ' +
                'È lo stesso `toISOString()` UTC che il ciclo ha già corretto in quattro punti, ' +
                'lasciando fuori proprio la pagina a cui punta la notifica.',
        ).toBe('08/08/2026')
    })

    it('nella pagina esiste UNA sola idea di «oggi», e non è quella UTC', () => {
        // Il comportamento dell'anno scolastico non è falsificabile qui — la
        // suite gira già in Europe/Rome, quindi `getMonth()` del dispositivo dà
        // per caso la risposta giusta e un'asserzione a runtime sarebbe verde
        // comunque. Si misura allora la SORGENTE, che è dove sta la causa: nella
        // stessa pagina convivevano tre idee di «oggi» (`oggiIso()` in UTC,
        // `annoScolasticoDefault()` sui getter locali, e le route chiamate che
        // usano `oggiFiscaleISO()`).
        const sorgente = readFileSync(
            join(process.cwd(), 'src/app/(dashboard)/teacher/primaria/[sectionId]/appello/page.tsx'),
            'utf8',
        ).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

        expect(
            sorgente,
            '`toISOString().slice(0,10)` è UTC. In questa pagina è la data su cui la maestra ' +
                'SALVA l’appello: fra mezzanotte e le due italiane scrive sul giorno prima.',
        ).not.toMatch(/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/)
        expect(
            sorgente,
            'la pagina non dichiara nessuna sorgente di «oggi» nel fuso dell’istituto',
        ).toMatch(/oggiFiscaleISO/)
    })
})
