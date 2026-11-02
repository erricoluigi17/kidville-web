import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Votazioni · `GET /api/admin/votazioni/[id]` (il dettaglio: risultati e «chi ha votato chi»).
 *
 * Gli aventi diritto li calcola il codice VERO di `src/lib/votazioni/aventi-diritto.ts` su `alunni`,
 * `legame_genitori_alunni` e `utenti` finti, e il conteggio è quello VERO di `contaVoti`: qui si prova che la
 * route li mette insieme senza mescolare votazioni, sedi e schede. Il database filtra davvero: un voto di
 * un’altra votazione, o di un’altra sede, comparirebbe nei numeri solo se mancasse il filtro.
 *
 * Solo dati finti: cognomi e nomi di fantasia (greci), uuid inventati.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string }>,
    scritture: [] as unknown[],
    maxRighe: undefined as number | undefined,
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
        creaFintoSupabase(h.db as DBFinto, h.tabelleLette, {
            errori: h.errori,
            scritture: h.scritture as Scrittura[],
            maxRighe: h.maxRighe,
        }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET } from '@/app/api/admin/votazioni/[id]/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const V1 = uuid('90000000', 1)
const V_ALTRA = uuid('90000000', 2) // un’altra votazione della stessa sede
const V_ALTRA_SEDE = uuid('90000000', 99)

const C_1 = uuid('c1000000', 1) // «2 ANNI»
const C_2 = uuid('c1000000', 2) // «3 ANNI»
const C_VUOTA = uuid('c1000000', 3) // «1 ANNO»: nessun genitore con account
const C_ALTRO = uuid('c1000000', 4) // «4 ANNI»: dove si sposta un bambino
const C_B = uuid('c1000000', 9)

const AL_1A = uuid('b0000000', 1)
const AL_1B = uuid('b0000000', 2) // fratello di AL_1A, STESSA classe
const AL_2 = uuid('b0000000', 3)
const AL_3 = uuid('b0000000', 4)
const AL_ALTRO = uuid('b0000000', 5)
const AL_VUOTA = uuid('b0000000', 6)

// Gli id seguono un ordine DIVERSO da quello dei cognomi, perché si veda lo spareggio per nome.
const G_1 = uuid('a0000000', 1) // Delta Dario
const G_2 = uuid('a0000000', 2) // Beta Bruno
const G_3 = uuid('a0000000', 3) // Gamma Carla
const G_4 = uuid('a0000000', 4) // Alfa Anna
const G_5 = uuid('a0000000', 5) // Epsilon Elena
const G_INATTIVO = uuid('a0000000', 6) // Zeta Zoe, account spento
const G_SPOSTATO = uuid('a0000000', 7) // Eta Ettore, il figlio è passato in un’altra classe

const FUTURO = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PASSATO = new Date(Date.now() - 86_400_000).toISOString()

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
    id,
    cognome,
    nome,
    ruolo: 'genitore',
    attivo: true,
    scuola_id: SEDE_A,
    ...extra,
})
const alunno = (id: string, section_id: string): Riga => ({
    id,
    scuola_id: SEDE_A,
    section_id,
    stato: 'iscritto',
    archiviato_il: null,
})
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })

function vot(id: string, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        titolo: 'Elezione di prova',
        scadenza: FUTURO,
        chiusa_il: null,
        rappresentante_istituto: true,
        creata_da: SEG,
        creata_il: '2026-10-01T08:00:00.000Z',
        aggiornata_da: null,
        aggiornata_il: null,
        ...over,
    }
}
const classeDi = (votazione_id: string, section_id: string, scuola_id = SEDE_A): Riga => ({ votazione_id, scuola_id, section_id })
const candidato = (votazione_id: string, utente_id: string): Riga => ({ votazione_id, scuola_id: SEDE_A, utente_id })

let n = 0
function voto(votazione_id: string, ambito: 'classe' | 'istituto', section_id: string | null, elettore_id: string, candidato_id: string, over: Riga = {}): Riga {
    n += 1
    return {
        id: uuid('f0000000', n),
        votazione_id,
        scuola_id: SEDE_A,
        ambito,
        section_id,
        elettore_id,
        candidato_id,
        votato_il: `2026-10-02T09:${String(n % 60).padStart(2, '0')}:00.000Z`,
        aggiornato_il: null,
        ...over,
    }
}

const get = (id: string) =>
    GET(new NextRequest(`http://localhost/api/admin/votazioni/${id}`), { params: Promise.resolve({ id }) })
const votazioniLogate = () => h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni')

beforeEach(() => {
    n = 0
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.maxRighe = undefined
    h.tabelleLette = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        schools: [{ id: SEDE_A, nome: 'Kidville Prova' }, { id: SEDE_B, nome: 'Kidville Altrove' }],
        sections: [
            { id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
            { id: C_2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
            { id: C_VUOTA, scuola_id: SEDE_A, name: '1 ANNO', school_type: 'nido' },
            { id: C_ALTRO, scuola_id: SEDE_A, name: '4 ANNI', school_type: 'infanzia' },
            { id: C_B, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
        ],
        alunni: [alunno(AL_1A, C_1), alunno(AL_1B, C_1), alunno(AL_2, C_2), alunno(AL_3, C_1), alunno(AL_ALTRO, C_ALTRO), alunno(AL_VUOTA, C_VUOTA)],
        // C_1: Delta (due figli, UNA sola volta), Beta e Gamma (AL_3) · C_2: Alfa · C_VUOTA: nessun account
        legame_genitori_alunni: [
            legame(AL_1A, G_1),
            legame(AL_1B, G_1),
            legame(AL_3, G_2),
            legame(AL_3, G_3),
            legame(AL_2, G_4),
            legame(AL_1A, G_INATTIVO),
            legame(AL_ALTRO, G_SPOSTATO),
        ],
        utenti: [
            utente(G_1, 'Delta', 'Dario'),
            utente(G_2, 'Beta', 'Bruno'),
            utente(G_3, 'Gamma', 'Carla'),
            utente(G_4, 'Alfa', 'Anna'),
            utente(G_5, 'Epsilon', 'Elena', { ruolo: 'docente' }), // una docente-genitore
            utente(G_INATTIVO, 'Zeta', 'Zoe', { attivo: false }),
            utente(G_SPOSTATO, 'Eta', 'Ettore'),
        ],
        student_parents: [],
        parents: [],
        votazioni: [vot(V1)],
        votazioni_classi: [classeDi(V1, C_1), classeDi(V1, C_2), classeDi(V1, C_VUOTA)],
        votazioni_candidati: [candidato(V1, G_1), candidato(V1, G_4), candidato(V1, G_5)],
        votazioni_voti: [],
        audit_scritture_docente: [],
        utenti_scuole: [],
    }
})

const scheda = (corpo: { votazione: { schede: Riga[] } }, sectionId: string | null) =>
    corpo.votazione.schede.find((s) => s.sectionId === sectionId) as Riga

describe('GET /api/admin/votazioni/[id] · accesso', () => {
    it('docente o genitore → 403, e il database non si tocca', async () => {
        h.ruolo = 'educator'
        expect((await get(V1)).status).toBe(403)
        h.ruolo = 'parent'
        expect((await get(V1)).status).toBe(403)
        expect(h.tabelleLette).toEqual([])
    })

    it('un id che non è un uuid → 400', async () => {
        expect((await get('non-un-uuid')).status).toBe(400)
    })

    it('una votazione che non c’è → 404 VOTAZIONE_NON_TROVATA', async () => {
        const res = await get(uuid('90000000', 55))
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('VOTAZIONE_NON_TROVATA')
    })

    it('la votazione di un’altra sede → 403 SEDE_NON_ACCESSIBILE, e voti e genitori non si leggono', async () => {
        h.db.votazioni = [vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        h.db.votazioni_voti = [voto(V_ALTRA_SEDE, 'istituto', null, G_1, G_4, { scuola_id: SEDE_B })]
        const res = await get(V_ALTRA_SEDE)
        expect(res.status).toBe(403)
        const corpo = await res.json()
        expect(corpo.codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(JSON.stringify(corpo)).not.toContain('Elezione di prova') // il titolo altrui non esce dal diniego
        expect(h.tabelleLette).not.toContain('votazioni_voti')
        expect(h.tabelleLette).not.toContain('alunni')
    })

    it('la Direzione con due sedi apre una votazione della seconda', async () => {
        h.ruolo = 'admin'
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [{ utente_id: SEG, scuola_id: SEDE_B }]
        h.db.votazioni = [vot(V_ALTRA_SEDE, { scuola_id: SEDE_B, rappresentante_istituto: false })]
        h.db.votazioni_classi = [classeDi(V_ALTRA_SEDE, C_B, SEDE_B)]
        h.db.votazioni_candidati = []
        const res = await get(V_ALTRA_SEDE)
        expect(res.status).toBe(200)
        expect((await res.json()).votazione.scuolaId).toBe(SEDE_B)
    })
})

describe('GET /api/admin/votazioni/[id] · i risultati', () => {
    beforeEach(() => {
        h.db.votazioni_voti = [
            // C_1: Beta ha 2 voti, Delta 1
            voto(V1, 'classe', C_1, G_1, G_2, { votato_il: '2026-10-02T09:30:00.000Z' }),
            voto(V1, 'classe', C_1, G_2, G_2, { votato_il: '2026-10-02T09:10:00.000Z', aggiornato_il: '2026-10-03T10:00:00.000Z' }),
            voto(V1, 'classe', C_1, G_3, G_1, { votato_il: '2026-10-02T09:20:00.000Z' }),
            // C_2: Alfa si vota da sola
            voto(V1, 'classe', C_2, G_4, G_4),
            // istituto: parità fra Delta e Alfa, Epsilon a 0
            voto(V1, 'istituto', null, G_1, G_1),
            voto(V1, 'istituto', null, G_4, G_4),
        ]
    })

    it('la testata ha la forma del contratto e lo stato ricavato', async () => {
        const { votazione } = await (await get(V1)).json()
        expect(votazione).toMatchObject({
            id: V1,
            scuolaId: SEDE_A,
            titolo: 'Elezione di prova',
            scadenza: FUTURO,
            chiusaIl: null,
            stato: 'aperta',
            rappresentanteIstituto: true,
            creataIl: '2026-10-01T08:00:00.000Z',
        })
        expect(votazione.classi).toEqual([
            { sectionId: C_VUOTA, nome: '1 ANNO', grado: 'nido' },
            { sectionId: C_1, nome: '2 ANNI', grado: 'infanzia' },
            { sectionId: C_2, nome: '3 ANNI', grado: 'infanzia' },
        ])
        // elettori distinti su tutte le schede: Delta, Beta, Gamma, Alfa
        expect(votazione.votanti).toBe(4)
        expect(votazione.candidatiIstituto).toEqual([
            { utenteId: G_4, nome: 'Alfa Anna' },
            { utenteId: G_1, nome: 'Delta Dario' },
            { utenteId: G_5, nome: 'Epsilon Elena' },
        ])
        expect(votazione.schede.map((s: Riga) => [s.ambito, s.sectionId])).toEqual([
            ['classe', C_VUOTA],
            ['classe', C_1],
            ['classe', C_2],
            ['istituto', null],
        ])
    })

    it('la classe: aventi diritto (un genitore con due figli nella classe conta UNA volta), votanti, candidati e eletto', async () => {
        const corpo = await (await get(V1)).json()
        const s = scheda(corpo, C_1)
        expect(s).toMatchObject({ ambito: 'classe', sectionId: C_1, nome: '2 ANNI', aventiDiritto: 3, votanti: 3 })
        expect(s.candidati).toEqual([
            { utenteId: G_2, nome: 'Beta Bruno', voti: 2 },
            { utenteId: G_1, nome: 'Delta Dario', voti: 1 },
        ])
        expect(s.eletti).toEqual([G_2])
    })

    it('«chi ha votato chi»: ordinato per nome dell’elettore, con l’ora del voto e quella dell’ultima modifica', async () => {
        const s = scheda(await (await get(V1)).json(), C_1)
        expect(s.voti).toEqual([
            {
                elettoreId: G_2,
                elettoreNome: 'Beta Bruno',
                candidatoId: G_2,
                candidatoNome: 'Beta Bruno',
                votatoIl: '2026-10-02T09:10:00.000Z',
                aggiornatoIl: '2026-10-03T10:00:00.000Z',
            },
            {
                elettoreId: G_1,
                elettoreNome: 'Delta Dario',
                candidatoId: G_2,
                candidatoNome: 'Beta Bruno',
                votatoIl: '2026-10-02T09:30:00.000Z',
                aggiornatoIl: null,
            },
            {
                elettoreId: G_3,
                elettoreNome: 'Gamma Carla',
                candidatoId: G_1,
                candidatoNome: 'Delta Dario',
                votatoIl: '2026-10-02T09:20:00.000Z',
                aggiornatoIl: null,
            },
        ])
    })

    it('Review Focus 4 · una classe senza genitori con account: 0 aventi diritto, 0 votanti, nessun eletto, e il dettaglio si apre', async () => {
        const res = await get(V1)
        expect(res.status).toBe(200)
        const s = scheda(await res.json(), C_VUOTA)
        expect(s).toEqual({
            ambito: 'classe',
            sectionId: C_VUOTA,
            nome: '1 ANNO',
            aventiDiritto: 0,
            votanti: 0,
            candidati: [],
            eletti: [],
            voti: [],
        })
    })

    it('la parità: per l’istituto eletti ha DUE elementi, la segreteria decide; i candidati a zero restano, per nome', async () => {
        const s = scheda(await (await get(V1)).json(), null)
        expect(s).toMatchObject({ ambito: 'istituto', sectionId: null, nome: 'Kidville Prova', votanti: 2 })
        expect(s.eletti).toHaveLength(2)
        expect([...(s.eletti as string[])].sort()).toEqual([G_1, G_4].sort())
        // voti decrescenti, poi NOME (Alfa prima di Delta anche se l’id di Delta viene prima)
        expect(s.candidati).toEqual([
            { utenteId: G_4, nome: 'Alfa Anna', voti: 1 },
            { utenteId: G_1, nome: 'Delta Dario', voti: 1 },
            { utenteId: G_5, nome: 'Epsilon Elena', voti: 0 },
        ])
    })

    it('l’istituto: gli aventi diritto sono tutti i genitori attivi della sede, una volta sola ciascuno', async () => {
        const s = scheda(await (await get(V1)).json(), null)
        // Delta, Beta, Gamma, Alfa, Eta: l’inattivo (Zeta) no; Epsilon (docente-genitore) non ha figli qui
        expect(s.aventiDiritto).toBe(5)
    })

    it('nessun voto: eletti vuoto, la classe non ha candidati e l’istituto li ha tutti a zero', async () => {
        h.db.votazioni_voti = []
        const corpo = await (await get(V1)).json()
        expect(corpo.votazione.votanti).toBe(0)
        expect(scheda(corpo, C_1)).toMatchObject({ votanti: 0, candidati: [], eletti: [] })
        const istituto = scheda(corpo, null)
        expect(istituto.eletti).toEqual([])
        expect((istituto.candidati as Riga[]).map((c) => c.voti)).toEqual([0, 0, 0])
    })

    it('chi non ha più un account attivo compare come «—», ma il suo voto conta', async () => {
        h.db.votazioni_voti = [
            voto(V1, 'classe', C_1, G_INATTIVO, G_INATTIVO),
            voto(V1, 'classe', C_1, G_1, G_INATTIVO),
        ]
        const s = scheda(await (await get(V1)).json(), C_1)
        expect(s.candidati).toEqual([{ utenteId: G_INATTIVO, nome: '—', voti: 2 }])
        expect(s.eletti).toEqual([G_INATTIVO])
        const riga = (s.voti as Riga[]).find((v) => v.elettoreId === G_INATTIVO) as Riga
        expect(riga).toMatchObject({ elettoreNome: '—', candidatoNome: '—' })
    })

    it('un genitore il cui figlio è passato in un’altra classe: il voto già dato resta, votanti può superare gli aventi diritto', async () => {
        h.db.votazioni_voti = [
            voto(V1, 'classe', C_2, G_4, G_4),
            voto(V1, 'classe', C_2, G_SPOSTATO, G_4), // oggi i suoi figli sono in C_ALTRO
        ]
        const s = scheda(await (await get(V1)).json(), C_2)
        expect(s).toMatchObject({ aventiDiritto: 1, votanti: 2 })
        expect(s.candidati).toEqual([{ utenteId: G_4, nome: 'Alfa Anna', voti: 2 }])
    })

    it('i voti di un’altra votazione, o di un’altra sede, non entrano nei numeri', async () => {
        h.db.votazioni = [vot(V1), vot(V_ALTRA)]
        h.db.votazioni_voti.push(
            voto(V_ALTRA, 'classe', C_1, G_3, G_3), // stessa classe, altra votazione
            voto(V1, 'classe', C_1, G_3, G_3, { scuola_id: SEDE_B }), // riga con la sede sbagliata
        )
        const corpo = await (await get(V1)).json()
        expect(scheda(corpo, C_1)).toMatchObject({ votanti: 3 })
        expect(scheda(corpo, C_1).candidati).toEqual([
            { utenteId: G_2, nome: 'Beta Bruno', voti: 2 },
            { utenteId: G_1, nome: 'Delta Dario', voti: 1 },
        ])
        expect(corpo.votazione.votanti).toBe(4)
    })

    it('solo classi: niente scheda d’istituto e niente candidati; solo istituto: niente classi', async () => {
        h.db.votazioni = [vot(V1, { rappresentante_istituto: false })]
        const soloClassi = await (await get(V1)).json()
        expect(soloClassi.votazione.candidatiIstituto).toEqual([])
        expect(soloClassi.votazione.schede.every((s: Riga) => s.ambito === 'classe')).toBe(true)

        h.db.votazioni = [vot(V1, { rappresentante_istituto: true })]
        h.db.votazioni_classi = []
        const soloIstituto = await (await get(V1)).json()
        expect(soloIstituto.votazione.classi).toEqual([])
        expect(soloIstituto.votazione.schede.map((s: Riga) => s.ambito)).toEqual(['istituto'])
    })

    it('una votazione scaduta o chiusa a mano si apre lo stesso, con lo stato giusto', async () => {
        h.db.votazioni = [vot(V1, { scadenza: PASSATO })]
        expect((await (await get(V1)).json()).votazione.stato).toBe('chiusa')
        h.db.votazioni = [vot(V1, { chiusa_il: '2026-10-05T08:00:00.000Z' })]
        const { votazione } = await (await get(V1)).json()
        expect(votazione).toMatchObject({ stato: 'chiusa', chiusaIl: '2026-10-05T08:00:00.000Z' })
    })

    it('oltre le 1000 righe PostgREST taglia in silenzio: i voti si leggono a blocchi', async () => {
        h.maxRighe = 1000
        h.db.votazioni_voti = Array.from({ length: 1200 }, (_, i) =>
            voto(V1, 'classe', C_1, uuid('e0000000', i + 1), G_2),
        )
        const s = scheda(await (await get(V1)).json(), C_1)
        expect(s.votanti).toBe(1200)
        expect((s.candidati as Riga[])[0]).toMatchObject({ utenteId: G_2, voti: 1200 })
    })
})

describe('GET /api/admin/votazioni/[id] · quando qualcosa si rompe', () => {
    it('i genitori non si leggono → 500, non una classe a “0 aventi diritto”', async () => {
        h.errori = { legame_genitori_alunni: { code: '08006' } }
        const res = await get(V1)
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    })

    it('lo stesso per una votazione di SOLE classi (nessuna scheda d’istituto a coprire il guasto) → 500', async () => {
        h.db.votazioni = [vot(V1, { rappresentante_istituto: false })]
        h.errori = { legame_genitori_alunni: { code: '08006' } }
        const res = await get(V1)
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    })

    it('i voti non si leggono → 500', async () => {
        h.errori = { votazioni_voti: { code: '08006' } }
        expect((await get(V1)).status).toBe(500)
    })

    it('le classi o i candidati non si leggono → 500', async () => {
        h.errori = { votazioni_classi: { code: '08006' } }
        expect((await get(V1)).status).toBe(500)
        h.errori = { votazioni_candidati: { code: '08006' } }
        expect((await get(V1)).status).toBe(500)
    })

    it('i nomi non si leggono → 500, non tutti “—”', async () => {
        h.db.votazioni_voti = [voto(V1, 'classe', C_1, G_1, G_2)]
        h.errori = { utenti: { code: '08006' } }
        expect((await get(V1)).status).toBe(500)
    })

    it('schema assente → 503 VOTAZIONI_NON_DISPONIBILI (non un 200 vuoto: qui la votazione dovrebbe esserci)', async () => {
        h.errori = { votazioni: { code: 'PGRST205' } }
        const res = await get(V1)
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
    })

    it('è una lettura: non scrive niente e non lascia battiti di successo', async () => {
        await get(V1)
        expect(h.scritture).toEqual([])
        expect(votazioniLogate().filter((c) => c[1] === 'info')).toEqual([])
    })
})
