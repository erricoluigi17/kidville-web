import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Votazioni · `GET /api/admin/votazioni/genitori` (i genitori della sede fra cui scegliere i candidati).
 *
 * L'elenco lo calcola il codice VERO di `src/lib/votazioni/aventi-diritto.ts` su `sections`, `alunni`,
 * `legame_genitori_alunni` e `utenti` finti: un genitore di un'altra sede, con l'account spento o senza figli
 * a scuola comparirebbe solo se mancasse il filtro. Il filtro `q` e il tetto di 50 sono della route.
 *
 * Solo dati finti: cognomi e nomi di fantasia, uuid inventati.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string }>,
    scritture: [] as unknown[],
    tabelleLette: [] as string[],
    logEvento: vi.fn(),
    logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: h.utente, role: h.ruolo, scuola_id: h.attive[0] ?? null } })
    },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () =>
        creaFintoSupabase(h.db as DBFinto, h.tabelleLette, { errori: h.errori, scritture: h.scritture as Scrittura[] }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET } from '@/app/api/admin/votazioni/genitori/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const C_1 = uuid('c1000000', 1)
const C_2 = uuid('c1000000', 2)
const C_SENZA_FIGLI = uuid('c1000000', 3)
const C_B = uuid('c1000000', 9)

const AL = (n: number) => uuid('b0000000', n)
const GE = (n: number) => uuid('a0000000', n)

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
    id,
    cognome,
    nome,
    ruolo: 'genitore',
    attivo: true,
    scuola_id: SEDE_A,
    ...extra,
})
const alunno = (id: string, section_id: string, scuola_id = SEDE_A, extra: Riga = {}): Riga => ({
    id,
    scuola_id,
    section_id,
    stato: 'iscritto',
    archiviato_il: null,
    ...extra,
})
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })

const get = (query = '') => GET(new NextRequest(`http://localhost/api/admin/votazioni/genitori${query}`))
const nomi = async (res: Response): Promise<string[]> =>
    ((await res.json()).genitori as { nome: string }[]).map((g) => g.nome)

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.tabelleLette = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        sections: [
            { id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
            { id: C_2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
            { id: C_SENZA_FIGLI, scuola_id: SEDE_A, name: '1 ANNO', school_type: 'nido' },
            { id: C_B, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
        ],
        alunni: [
            alunno(AL(1), C_1), // Delta
            alunno(AL(2), C_1), // Beta
            alunno(AL(3), C_2), // Alfa
            alunno(AL(4), C_2), // Pérez José
            alunno(AL(5), C_1), // Peres Giulia
            alunno(AL(6), C_1), // Theta Teresa (docente e madre)
            alunno(AL(7), C_1), // Zeta Zoe (account spento)
            alunno(AL(8), C_B, SEDE_B), // Eta Ettore (altra sede)
            alunno(AL(9), C_1, SEDE_A, { stato: 'ritirato' }), // Iota Irene: il figlio non frequenta più
            alunno(AL(10), C_2), // Gamma Carla, con due figli
            alunno(AL(11), C_2),
        ],
        student_parents: [],
        parents: [],
        legame_genitori_alunni: [
            legame(AL(1), GE(1)),
            legame(AL(2), GE(2)),
            legame(AL(3), GE(3)),
            legame(AL(4), GE(4)),
            legame(AL(5), GE(5)),
            legame(AL(6), GE(6)),
            legame(AL(7), GE(7)),
            legame(AL(8), GE(8)),
            legame(AL(9), GE(9)),
            legame(AL(10), GE(10)),
            legame(AL(11), GE(10)),
        ],
        utenti: [
            utente(GE(1), 'Delta', 'Dario'),
            utente(GE(2), 'Beta', 'Bruno'),
            utente(GE(3), 'Alfa', 'Anna'),
            utente(GE(4), 'Pérez', 'José'),
            utente(GE(5), 'Peres', 'Giulia'),
            utente(GE(6), 'Theta', 'Teresa', { ruolo: 'docente' }),
            utente(GE(7), 'Zeta', 'Zoe', { attivo: false }),
            utente(GE(8), 'Eta', 'Ettore', { scuola_id: SEDE_B }),
            utente(GE(9), 'Iota', 'Irene'),
            utente(GE(10), 'Gamma', 'Carla'),
        ],
        audit_scritture_docente: [],
        utenti_scuole: [],
    }
})

describe('GET /api/admin/votazioni/genitori · accesso e sede', () => {
    it('docente o genitore → 403, e il database non si tocca', async () => {
        h.ruolo = 'educator'
        expect((await get()).status).toBe(403)
        h.ruolo = 'parent'
        expect((await get()).status).toBe(403)
        expect(h.tabelleLette).toEqual([])
    })

    it('una sede che non è tua → 403 SEDE_NON_ACCESSIBILE, e i genitori dell’altra sede non si leggono', async () => {
        const res = await get(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.tabelleLette).not.toContain('alunni')
        expect(h.tabelleLette).not.toContain('utenti')
    })

    it('più sedi e nessuna indicata → 400 SEDE_DA_SPECIFICARE: non si indovina il plesso', async () => {
        h.ruolo = 'admin'
        h.db.utenti_scuole = [{ utente_id: SEG, scuola_id: SEDE_B }]
        const res = await get()
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        expect(h.tabelleLette).not.toContain('alunni')
    })

    it('la Direzione con due sedi sceglie la seconda con ?scuolaId e vede SOLO i suoi genitori', async () => {
        h.ruolo = 'admin'
        h.db.utenti_scuole = [{ utente_id: SEG, scuola_id: SEDE_B }]
        const res = await get(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(200)
        expect(await nomi(res)).toEqual(['Eta Ettore'])
    })

    it('uno scuolaId che non è un uuid → 400', async () => {
        expect((await get('?scuolaId=non-un-uuid')).status).toBe(400)
    })

    it('una ricerca più lunga di 60 caratteri → 400', async () => {
        expect((await get(`?q=${'a'.repeat(61)}`)).status).toBe(400)
        expect((await get(`?q=${'a'.repeat(60)}`)).status).toBe(200)
    })
})

describe('GET /api/admin/votazioni/genitori · l’elenco', () => {
    it('ha la forma del contratto: { genitori: [{ utenteId, nome: «Cognome Nome» }] }, per cognome e nome', async () => {
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            genitori: [
                { utenteId: GE(3), nome: 'Alfa Anna' },
                { utenteId: GE(2), nome: 'Beta Bruno' },
                { utenteId: GE(1), nome: 'Delta Dario' },
                { utenteId: GE(10), nome: 'Gamma Carla' },
                { utenteId: GE(5), nome: 'Peres Giulia' },
                { utenteId: GE(4), nome: 'Pérez José' },
                { utenteId: GE(6), nome: 'Theta Teresa' },
            ],
        })
    })

    it('sono i genitori con un account ATTIVO e un figlio a scuola nella sede: non l’altra sede, non l’account spento, non il figlio ritirato', async () => {
        const elenco = await nomi(await get())
        expect(elenco).not.toContain('Eta Ettore') // altra sede
        expect(elenco).not.toContain('Zeta Zoe') // account spento
        expect(elenco).not.toContain('Iota Irene') // il figlio è ritirato
    })

    it('una docente che è anche madre c’è: l’identità del voto è l’account, qualunque ruolo abbia', async () => {
        expect(await nomi(await get())).toContain('Theta Teresa')
    })

    it('un genitore con due figli compare UNA volta', async () => {
        expect((await nomi(await get())).filter((n) => n === 'Gamma Carla')).toHaveLength(1)
    })

    it('una sede senza genitori → { genitori: [] }, non un errore', async () => {
        h.db.legame_genitori_alunni = []
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ genitori: [] })
    })
})

describe('GET /api/admin/votazioni/genitori · la ricerca ?q=', () => {
    it('senza maiuscole: “ALFA” trova Alfa Anna', async () => {
        expect(await nomi(await get('?q=ALFA'))).toEqual(['Alfa Anna'])
    })

    it('senza accenti, in tutti e due i sensi: “perez” trova Pérez, e “pérez” non trova Peres', async () => {
        expect(await nomi(await get('?q=perez'))).toEqual(['Pérez José'])
        expect(await nomi(await get(`?q=${encodeURIComponent('PÉREZ')}`))).toEqual(['Pérez José'])
        expect(await nomi(await get(`?q=${encodeURIComponent('jose')}`))).toEqual(['Pérez José'])
        expect(await nomi(await get(`?q=${encodeURIComponent('josé')}`))).toEqual(['Pérez José'])
    })

    it('si può scrivere prima il nome e poi il cognome: ogni parola deve esserci', async () => {
        expect(await nomi(await get(`?q=${encodeURIComponent('anna alfa')}`))).toEqual(['Alfa Anna'])
        expect(await nomi(await get(`?q=${encodeURIComponent('anna beta')}`))).toEqual([])
    })

    it('un pezzo di parola basta, e gli spazi attorno non contano', async () => {
        expect(await nomi(await get(`?q=${encodeURIComponent('  ta ')}`))).toEqual(['Beta Bruno', 'Delta Dario', 'Theta Teresa'])
    })

    it('una ricerca vuota o di soli spazi è nessun filtro', async () => {
        const tutti = await nomi(await get())
        expect(await nomi(await get('?q='))).toEqual(tutti)
        expect(await nomi(await get('?q=%20%20'))).toEqual(tutti)
    })

    it('una ricerca senza risultati → { genitori: [] }', async () => {
        const res = await get('?q=nessuno')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ genitori: [] })
    })

    it('i caratteri speciali sono testo, non un’espressione: “(.*)” e “%” non trovano niente e non rompono niente', async () => {
        for (const q of ['(.*)', '%', '[', '\\', '*']) {
            const res = await get(`?q=${encodeURIComponent(q)}`)
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ genitori: [] })
        }
    })

    it('il filtro non cambia la sede: la ricerca “eta” trova Beta e Theta ma non Eta Ettore, che è dell’altra sede', async () => {
        expect(await nomi(await get('?q=eta'))).toEqual(['Beta Bruno', 'Theta Teresa'])
    })
})

describe('GET /api/admin/votazioni/genitori · il tetto di 50', () => {
    beforeEach(() => {
        for (let i = 1; i <= 60; i++) {
            const n = String(i).padStart(2, '0')
            h.db.alunni.push(alunno(AL(100 + i), C_1))
            h.db.legame_genitori_alunni.push(legame(AL(100 + i), GE(100 + i)))
            h.db.utenti.push(utente(GE(100 + i), `Cognome${n}`, 'Nome'))
        }
    })

    it('al massimo 50 risultati, i primi in ordine di cognome', async () => {
        const elenco = await nomi(await get('?q=cognome'))
        expect(elenco).toHaveLength(50)
        expect(elenco[0]).toBe('Cognome01 Nome')
        expect(elenco[49]).toBe('Cognome50 Nome')
    })

    it('anche senza ricerca il tetto vale, e i 50 sono i primi dell’elenco intero', async () => {
        const elenco = await nomi(await get())
        expect(elenco).toHaveLength(50)
        expect(elenco.slice(0, 3)).toEqual(['Alfa Anna', 'Beta Bruno', 'Cognome01 Nome'])
    })

    it('con meno di 50 corrispondenze non si aggiunge niente', async () => {
        expect(await nomi(await get('?q=cognome1'))).toHaveLength(10) // Cognome10…Cognome19
    })
})

describe('GET /api/admin/votazioni/genitori · quando qualcosa si rompe', () => {
    it('i legami dei genitori non si leggono → 500: un elenco corto non è “nessun genitore”', async () => {
        h.errori = { legame_genitori_alunni: { code: '08006' } }
        const res = await get()
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    })

    it('gli alunni non si leggono → 500', async () => {
        h.errori = { alunni: { code: '08006' } }
        expect((await get()).status).toBe(500)
    })

    it('le classi della sede non si leggono → 500', async () => {
        h.errori = { sections: { code: '08006' } }
        expect((await get()).status).toBe(500)
    })

    it('i nomi non si leggono → 500', async () => {
        h.errori = { utenti: { code: '08006' } }
        expect((await get()).status).toBe(500)
    })

    it('schema assente → 503 VOTAZIONI_NON_DISPONIBILI', async () => {
        h.errori = { alunni: { code: 'PGRST205' } }
        const res = await get()
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
    })

    it('è una lettura: non scrive niente e non lascia battiti di successo', async () => {
        await get()
        await get('?q=alfa')
        expect(h.scritture).toEqual([])
        expect(h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni' && c[1] === 'info')).toEqual([])
    })
})
