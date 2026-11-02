import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataCivile } from '@/i18n/config'
import { addGiorni } from '@/lib/format/data'
import { oraCivile } from '@/lib/format/confini-giorno'

/**
 * Votazioni · `POST /api/admin/votazioni` (aprire una votazione).
 *
 * Il database è il finto che APPLICA i filtri e ESEGUE le scritture. Gli aventi diritto (i candidati
 * dell'istituto devono essere genitori della sede con un account attivo) li calcola il codice VERO di
 * `src/lib/votazioni/aventi-diritto.ts` su `alunni`, `legame_genitori_alunni` e `utenti` finti: un candidato
 * di un'altra sede, con l'account spento o che non è un genitore verrebbe accettato solo se il controllo
 * mancasse. Sono finti soltanto il gate di ruolo e le sedi attive del cookie.
 *
 * ⚠️ L'orologio NON si congela: i giorni si calcolano da `dataCivile()` (il giorno di Roma di adesso), così il
 * test non scade e non dipende dall'ora in cui gira.
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

import { POST } from '@/app/api/admin/votazioni/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const DIREZIONE = uuid('20000000', 5)

const C_1 = uuid('c1000000', 1)
const C_2 = uuid('c1000000', 2)
const C_B = uuid('c1000000', 9) // della sede B
const C_INESISTENTE = uuid('c1000000', 77)

const AL_1 = uuid('b0000000', 1)
const AL_2 = uuid('b0000000', 2)
const AL_B = uuid('b0000000', 9)

const G_1 = uuid('a0000000', 1)
const G_2 = uuid('a0000000', 2)
const G_B = uuid('a0000000', 3) // genitore della sede B
const G_INATTIVO = uuid('a0000000', 4)
const STAFF = uuid('a0000000', 5) // un account che non è genitore di nessuno
const SCONOSCIUTO = uuid('a0000000', 6) // non è nemmeno un utente

const V_APERTA = uuid('90000000', 1)

const giorno = (n: number) => addGiorni(dataCivile(), n)
const FUTURO = `${giorno(2)}T18:00`
const PASSATO = `${giorno(-1)}T10:00`
const FUTURO_ISO = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PASSATO_ISO = new Date(Date.now() - 86_400_000).toISOString()

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
    id,
    cognome,
    nome,
    ruolo: 'genitore',
    attivo: true,
    scuola_id: SEDE_A,
    ...extra,
})
const alunno = (id: string, section_id: string, scuola_id = SEDE_A): Riga => ({
    id,
    scuola_id,
    section_id,
    stato: 'iscritto',
    archiviato_il: null,
})
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })

const aperta = (id: string, over: Riga = {}): Riga => ({
    id,
    scuola_id: SEDE_A,
    titolo: 'Un’altra elezione',
    scadenza: FUTURO_ISO,
    chiusa_il: null,
    rappresentante_istituto: false,
    creata_da: SEG,
    creata_il: '2026-10-01T08:00:00.000Z',
    aggiornata_da: null,
    aggiornata_il: null,
    ...over,
})
const classeDi = (votazione_id: string, section_id: string, scuola_id = SEDE_A): Riga => ({ votazione_id, scuola_id, section_id })

function corpo(over: Riga = {}): Riga {
    return {
        titolo: 'Elezione di prova',
        scadenza: FUTURO,
        sectionIds: [C_1],
        rappresentanteIstituto: false,
        candidatiIstituto: [],
        ...over,
    }
}
const post = (b: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/votazioni', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )

const righe = (tabella: string): Riga[] => h.db[tabella] ?? []
const scritturePer = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const nessunaScrittura = () => expect(h.scritture).toEqual([])
const votazioniLogate = () => h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni')

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
        votazioni: [],
        votazioni_classi: [],
        votazioni_candidati: [],
        votazioni_voti: [],
        audit_scritture_docente: [],
        utenti_scuole: [],
        sections: [
            { id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
            { id: C_2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
            { id: C_B, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
        ],
        alunni: [alunno(AL_1, C_1), alunno(AL_2, C_2), alunno(AL_B, C_B, SEDE_B)],
        student_parents: [],
        parents: [],
        legame_genitori_alunni: [
            legame(AL_1, G_1),
            legame(AL_2, G_2),
            legame(AL_B, G_B),
            legame(AL_1, G_INATTIVO),
        ],
        utenti: [
            utente(G_1, 'Alfa', 'Anna'),
            utente(G_2, 'Beta', 'Bruno'),
            utente(G_B, 'Gamma', 'Carla', { scuola_id: SEDE_B }),
            utente(G_INATTIVO, 'Delta', 'Dario', { attivo: false }),
            utente(STAFF, 'Epsilon', 'Elena', { ruolo: 'segreteria' }),
        ],
    }
})

describe('POST /api/admin/votazioni · gate e sede', () => {
    it('docente o genitore → 403, e non si scrive niente', async () => {
        h.ruolo = 'educator'
        expect((await post(corpo())).status).toBe(403)
        h.ruolo = 'parent'
        expect((await post(corpo())).status).toBe(403)
        nessunaScrittura()
        expect(h.tabelleLette).toEqual([])
    })

    it('il gate viene PRIMA del body: un docente con un body illeggibile riceve 403, non 400', async () => {
        h.ruolo = 'educator'
        const res = await POST(
            new NextRequest('http://localhost/api/admin/votazioni', { method: 'POST', body: '{non json', headers: { 'content-type': 'application/json' } }),
        )
        expect(res.status).toBe(403)
    })

    it('la sede di un altro plesso → 403 SEDE_NON_ACCESSIBILE, nessuna scrittura', async () => {
        const res = await post(corpo({ scuolaId: SEDE_B, sectionIds: [C_B] }))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        nessunaScrittura()
    })

    it('più sedi e nessuna dichiarata → 400 SEDE_DA_SPECIFICARE: la sede non si indovina', async () => {
        h.ruolo = 'admin'
        h.utente = DIREZIONE
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [
            { utente_id: DIREZIONE, scuola_id: SEDE_A },
            { utente_id: DIREZIONE, scuola_id: SEDE_B },
        ]
        const res = await post(corpo())
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        nessunaScrittura()
    })

    it('la Direzione con più sedi dichiara la seconda: la votazione nasce LÌ', async () => {
        h.ruolo = 'admin'
        h.utente = DIREZIONE
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [
            { utente_id: DIREZIONE, scuola_id: SEDE_A },
            { utente_id: DIREZIONE, scuola_id: SEDE_B },
        ]
        const res = await post(corpo({ scuolaId: SEDE_B, sectionIds: [C_B] }))
        expect(res.status).toBe(201)
        expect(righe('votazioni')[0].scuola_id).toBe(SEDE_B)
        expect(righe('votazioni_classi')[0]).toMatchObject({ scuola_id: SEDE_B, section_id: C_B })
    })
})

describe('POST /api/admin/votazioni · forma del body', () => {
    it('titolo vuoto o troppo lungo, scadenza in un’altra forma, id che non sono uuid, istituto non booleano → 400', async () => {
        expect((await post(corpo({ titolo: '   ' }))).status).toBe(400)
        expect((await post(corpo({ titolo: 'x'.repeat(121) }))).status).toBe(400)
        expect((await post(corpo({ scadenza: '2030-01-01T10:00:00.000Z' }))).status).toBe(400)
        expect((await post(corpo({ scadenza: `${giorno(3)}T25:99` }))).status).toBe(400)
        expect((await post(corpo({ sectionIds: ['non-un-uuid'] }))).status).toBe(400)
        expect((await post(corpo({ rappresentanteIstituto: 'si' }))).status).toBe(400)
        expect((await post({})).status).toBe(400)
        nessunaScrittura()
    })

    it('un giorno che non esiste sul calendario → 400', async () => {
        expect((await post(corpo({ scadenza: '2031-02-30T10:00' }))).status).toBe(400)
        nessunaScrittura()
    })
})

describe('POST /api/admin/votazioni · i controlli, nell’ordine del piano', () => {
    it('nessuna classe e l’istituto spento → 400 VOTAZIONE_SENZA_SCHEDE', async () => {
        const res = await post(corpo({ sectionIds: [], rappresentanteIstituto: false }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('VOTAZIONE_SENZA_SCHEDE')
        nessunaScrittura()
    })

    it('scadenza nel passato → 400 VOTAZIONE_SCADENZA_PASSATA', async () => {
        const res = await post(corpo({ scadenza: PASSATO }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('VOTAZIONE_SCADENZA_PASSATA')
        nessunaScrittura()
    })

    it('una classe che non è della sede → 400 VOTAZIONE_CLASSE_FUORI_SEDE (di un’altra sede, o inesistente)', async () => {
        for (const sectionIds of [[C_B], [C_INESISTENTE], [C_1, C_B]]) {
            const res = await post(corpo({ sectionIds }))
            expect(res.status, sectionIds.join()).toBe(400)
            expect((await res.json()).codice, sectionIds.join()).toBe('VOTAZIONE_CLASSE_FUORI_SEDE')
        }
        nessunaScrittura()
    })

    it('istituto acceso senza candidati → 400 VOTAZIONE_CANDIDATI_MANCANTI', async () => {
        const res = await post(corpo({ rappresentanteIstituto: true, candidatiIstituto: [] }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('VOTAZIONE_CANDIDATI_MANCANTI')
        nessunaScrittura()
    })

    it('un candidato che non è un genitore della sede con account attivo → 400 VOTAZIONE_CANDIDATO_NON_VALIDO', async () => {
        // G_B è genitore di un’altra sede · G_INATTIVO ha l’account spento · STAFF non è genitore di nessuno ·
        // SCONOSCIUTO non è nemmeno un utente. Con un solo candidato cattivo fra due buoni la richiesta cade.
        for (const cattivo of [G_B, G_INATTIVO, STAFF, SCONOSCIUTO]) {
            const res = await post(corpo({ rappresentanteIstituto: true, candidatiIstituto: [G_1, cattivo] }))
            expect(res.status, cattivo).toBe(400)
            expect((await res.json()).codice, cattivo).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
        }
        nessunaScrittura()
    })

    it('un guasto nel leggere i genitori NON è “candidato non valido”: 500, e non si scrive niente', async () => {
        h.errori = { legame_genitori_alunni: { code: '08006' } }
        const res = await post(corpo({ rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
        nessunaScrittura()
    })

    it('una classe già in una votazione APERTA della sede → 409 VOTAZIONE_CLASSE_GIA_APERTA', async () => {
        h.db.votazioni = [aperta(V_APERTA)]
        h.db.votazioni_classi = [classeDi(V_APERTA, C_2)]
        const res = await post(corpo({ sectionIds: [C_1, C_2] }))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CLASSE_GIA_APERTA')
        expect(scritturePer('votazioni', 'insert')).toHaveLength(0)
    })

    it('una classe in una votazione CHIUSA a mano o SCADUTA non è in conflitto', async () => {
        h.db.votazioni = [
            aperta(V_APERTA, { chiusa_il: PASSATO_ISO }),
            aperta(uuid('90000000', 2), { scadenza: PASSATO_ISO }),
        ]
        h.db.votazioni_classi = [classeDi(V_APERTA, C_1), classeDi(uuid('90000000', 2), C_1)]
        const res = await post(corpo({ sectionIds: [C_1] }))
        expect(res.status).toBe(201)
    })

    it('l’istituto già aperto nella sede → 409 VOTAZIONE_ISTITUTO_GIA_APERTA', async () => {
        h.db.votazioni = [aperta(V_APERTA, { rappresentante_istituto: true })]
        const res = await post(corpo({ sectionIds: [C_1], rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_ISTITUTO_GIA_APERTA')
        expect(scritturePer('votazioni', 'insert')).toHaveLength(0)
    })

    it('l’istituto di un’ALTRA sede, o già chiuso, non è in conflitto', async () => {
        h.db.votazioni = [
            aperta(V_APERTA, { rappresentante_istituto: true, scuola_id: SEDE_B }),
            aperta(uuid('90000000', 2), { rappresentante_istituto: true, chiusa_il: PASSATO_ISO }),
        ]
        const res = await post(corpo({ rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        expect(res.status).toBe(201)
    })

    it('una classe aperta in un’altra votazione della SEDE B non blocca la stessa sede A', async () => {
        h.db.votazioni = [aperta(V_APERTA, { scuola_id: SEDE_B })]
        h.db.votazioni_classi = [classeDi(V_APERTA, C_B, SEDE_B)]
        expect((await post(corpo({ sectionIds: [C_1] }))).status).toBe(201)
    })

    it('l’ordine: scadenza passata batte classe fuori sede; classe fuori sede batte candidati mancanti; classe già aperta batte istituto già aperto', async () => {
        const a = await post(corpo({ scadenza: PASSATO, sectionIds: [C_B] }))
        expect((await a.json()).codice).toBe('VOTAZIONE_SCADENZA_PASSATA')
        const b = await post(corpo({ sectionIds: [C_B], rappresentanteIstituto: true, candidatiIstituto: [] }))
        expect((await b.json()).codice).toBe('VOTAZIONE_CLASSE_FUORI_SEDE')
        const c = await post(corpo({ sectionIds: [C_1], rappresentanteIstituto: true, candidatiIstituto: [STAFF] }))
        expect((await c.json()).codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
        h.db.votazioni = [aperta(V_APERTA, { rappresentante_istituto: true })]
        h.db.votazioni_classi = [classeDi(V_APERTA, C_1)]
        const d = await post(corpo({ sectionIds: [C_1], rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        expect((await d.json()).codice).toBe('VOTAZIONE_CLASSE_GIA_APERTA')
    })
})

describe('POST /api/admin/votazioni · la scrittura', () => {
    it('201 { id }, con la testata nella sede dichiarata, la scadenza in ora di Roma e ogni figlia col suo scuola_id', async () => {
        const res = await post(
            corpo({ titolo: '  Elezione di prova  ', sectionIds: [C_1, C_2], rappresentanteIstituto: true, candidatiIstituto: [G_1, G_2] }),
        )
        expect(res.status).toBe(201)
        const { id } = await res.json()
        expect(typeof id).toBe('string')

        const testata = righe('votazioni')
        expect(testata).toHaveLength(1)
        expect(testata[0]).toMatchObject({
            id,
            scuola_id: SEDE_A,
            titolo: 'Elezione di prova', // ripulito ai lati
            rappresentante_istituto: true,
            creata_da: SEG,
        })
        expect(oraCivile(testata[0].scadenza as string)).toBe('18:00')
        expect(Date.parse(testata[0].scadenza as string)).toBeGreaterThan(Date.now())
        expect(testata[0].chiusa_il ?? null).toBeNull() // una votazione nuova non nasce chiusa

        expect(righe('votazioni_classi').map((c) => c.section_id).sort()).toEqual([C_1, C_2].sort())
        for (const c of righe('votazioni_classi')) expect(c).toMatchObject({ votazione_id: id, scuola_id: SEDE_A })
        expect(righe('votazioni_candidati').map((c) => c.utente_id).sort()).toEqual([G_1, G_2].sort())
        for (const c of righe('votazioni_candidati')) expect(c).toMatchObject({ votazione_id: id, scuola_id: SEDE_A })
    })

    it('solo classe: nessun candidato scritto, anche se il client ne manda con l’istituto spento', async () => {
        const res = await post(corpo({ rappresentanteIstituto: false, candidatiIstituto: [G_1] }))
        expect(res.status).toBe(201)
        expect(righe('votazioni')[0].rappresentante_istituto).toBe(false)
        expect(righe('votazioni_candidati')).toEqual([])
        expect(scritturePer('votazioni_candidati', 'insert')).toHaveLength(0)
    })

    it('solo istituto (nessuna classe) è una votazione valida', async () => {
        const res = await post(corpo({ sectionIds: [], rappresentanteIstituto: true, candidatiIstituto: [G_2] }))
        expect(res.status).toBe(201)
        expect(righe('votazioni_classi')).toEqual([])
        expect(scritturePer('votazioni_classi', 'insert')).toHaveLength(0)
        expect(righe('votazioni_candidati')).toHaveLength(1)
    })

    it('la stessa classe due volte (doppio clic) è una riga sola, non un 23505', async () => {
        const res = await post(corpo({ sectionIds: [C_1, C_1.toUpperCase()] }))
        expect(res.status).toBe(201)
        expect(righe('votazioni_classi')).toHaveLength(1)
    })

    it('lascia la traccia di audit (nessun nome, nessun testo libero) e il battito di successo senza chiavi “voto”', async () => {
        const res = await post(corpo({ titolo: 'Titolo riconoscibile', rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        const { id } = await res.json()

        const audit = righe('audit_scritture_docente')
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({ attore_id: SEG, scuola_id: SEDE_A, entita_tipo: 'votazione', azione: 'insert' })
        expect(JSON.stringify(audit[0])).not.toContain('Titolo riconoscibile')

        const info = votazioniLogate().filter((c) => c[1] === 'info')
        expect(info).toHaveLength(1)
        expect(info[0][2]).toMatchObject({ operazione: 'crea', esito: 'creata', votazione_id: id })
        for (const c of votazioniLogate()) {
            expect(Object.keys(c[2] as object).filter((k) => /voto/i.test(k))).toEqual([])
            expect(JSON.stringify(c)).not.toContain('Titolo riconoscibile')
        }
    })

    it('un rifiuto non lascia nessun battito di successo', async () => {
        await post(corpo({ sectionIds: [] }))
        await post(corpo({ scadenza: PASSATO }))
        expect(votazioniLogate().filter((c) => c[1] === 'info')).toEqual([])
    })
})

describe('POST /api/admin/votazioni · quando la scrittura fallisce', () => {
    it('le classi non si scrivono → 500, e la testata appena creata viene tolta (con id e scuola_id)', async () => {
        h.errori = { 'votazioni_classi:insert': { code: '08006' } }
        const res = await post(corpo())
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
        expect(righe('votazioni')).toEqual([])
        const tolte = scritturePer('votazioni', 'delete')
        expect(tolte).toHaveLength(1)
        expect(tolte[0].colpite[0]).toMatchObject({ scuola_id: SEDE_A })
        expect(votazioniLogate().filter((c) => c[1] === 'info')).toEqual([])
        expect(righe('audit_scritture_docente')).toEqual([])
    })

    it('i candidati non si scrivono → 500 e la testata viene tolta', async () => {
        h.errori = { 'votazioni_candidati:insert': { code: '08006' } }
        const res = await post(corpo({ rappresentanteIstituto: true, candidatiIstituto: [G_1] }))
        expect(res.status).toBe(500)
        expect(righe('votazioni')).toEqual([])
    })

    it('se anche il ripristino fallisce la risposta resta 500 e il guasto è nel log (testata orfana)', async () => {
        h.errori = { 'votazioni_classi:insert': { code: '08006' }, 'votazioni:delete': { code: '08006' } }
        const res = await post(corpo())
        expect(res.status).toBe(500)
        expect(righe('votazioni')).toHaveLength(1) // orfana: lo dice il log, non il silenzio
        expect(h.logErrore.mock.calls.some((c) => (c[0] as Riga).evento === 'votazione-orfana')).toBe(true)
    })

    it('la testata non si scrive → 500, mai un finto 201', async () => {
        h.errori = { 'votazioni:insert': { code: '08006' } }
        const res = await post(corpo())
        expect(res.status).toBe(500)
        expect(righe('votazioni_classi')).toEqual([])
    })

    it('schema assente → 503 VOTAZIONI_NON_DISPONIBILI, sia nel leggere i conflitti sia nello scrivere', async () => {
        h.errori = { votazioni: { code: 'PGRST205' } }
        const res = await post(corpo())
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
        expect(scritturePer('votazioni', 'insert')).toHaveLength(0)

        h.errori = { 'votazioni:insert': { code: '42P01' } }
        const res2 = await post(corpo())
        expect(res2.status).toBe(503)
        expect((await res2.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
        expect(votazioniLogate().filter((c) => c[1] === 'info')).toEqual([])
    })
})
