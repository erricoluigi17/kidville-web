import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataCivile } from '@/i18n/config'
import { addGiorni } from '@/lib/format/data'
import { oraCivile } from '@/lib/format/confini-giorno'

/**
 * Votazioni · `PATCH` (chiudere, prorogare) e `DELETE` (eliminare) di `/api/admin/votazioni/[id]`.
 *
 * Il database è il finto che APPLICA i filtri e ESEGUE le scritture: un `update` senza `.is('chiusa_il', null)`
 * qui cambierebbe davvero una votazione chiusa nel frattempo, e una proroga che non guarda i conflitti
 * riaprirebbe davvero una classe già in un'altra votazione aperta. Le corse (qualcuno chiude, o elimina, fra
 * la lettura e la scrittura) si simulano con `h.suFrom`: un gancio che cambia il database nel momento in cui
 * la route apre la tabella per scrivere.
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
    suFrom: null as null | ((tabella: string) => void),
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
    createAdminClient: async () => {
        const finto = creaFintoSupabase(h.db as DBFinto, h.tabelleLette, {
            errori: h.errori,
            scritture: h.scritture as Scrittura[],
        })
        return {
            ...finto,
            from: (tabella: string) => {
                h.suFrom?.(tabella)
                return finto.from(tabella)
            },
        }
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { DELETE, PATCH } from '@/app/api/admin/votazioni/[id]/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const V1 = uuid('90000000', 1)
const V2 = uuid('90000000', 2)
const V3 = uuid('90000000', 3)
const V_ALTRA_SEDE = uuid('90000000', 99)
const C_1 = uuid('c1000000', 1)
const C_2 = uuid('c1000000', 2)
const C_B = uuid('c1000000', 9)
const G_1 = uuid('a0000000', 1)
const G_2 = uuid('a0000000', 2)

const giorno = (n: number) => addGiorni(dataCivile(), n)
// Dopo la scadenza di partenza delle votazioni aperte (fra 7 giorni): una VERA proroga.
const FUTURO = `${giorno(10)}T18:00`
const PASSATO = `${giorno(-1)}T10:00`
const FUTURO_ISO = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PASSATO_ISO = new Date(Date.now() - 86_400_000).toISOString()
const TITOLO = 'Titolo riconoscibile'

function vot(id: string, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        titolo: TITOLO,
        scadenza: FUTURO_ISO,
        chiusa_il: null,
        rappresentante_istituto: false,
        creata_da: SEG,
        creata_il: '2026-10-01T08:00:00.000Z',
        aggiornata_da: null,
        aggiornata_il: null,
        ...over,
    }
}
const classeDi = (votazione_id: string, section_id: string, scuola_id = SEDE_A): Riga => ({ votazione_id, scuola_id, section_id })
const candidato = (votazione_id: string, utente_id: string): Riga => ({ votazione_id, scuola_id: SEDE_A, utente_id })
let contatoreVoti = 0
const voto = (votazione_id: string, elettore_id: string, candidato_id: string, scuola_id = SEDE_A): Riga => ({
    id: uuid('f0000000', ++contatoreVoti),
    votazione_id,
    scuola_id,
    ambito: 'istituto',
    section_id: null,
    elettore_id,
    candidato_id,
    votato_il: '2026-10-02T09:00:00.000Z',
    aggiornato_il: null,
})

const urlDi = (id: string) => `http://localhost/api/admin/votazioni/${id}`
const patch = (id: string, corpo: unknown, grezzo = false) =>
    PATCH(
        new NextRequest(urlDi(id), {
            method: 'PATCH',
            body: grezzo ? (corpo as string) : JSON.stringify(corpo),
            headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ id }) },
    )
const elimina = (id: string) =>
    DELETE(new NextRequest(urlDi(id), { method: 'DELETE' }), { params: Promise.resolve({ id }) })

const righe = (tabella: string): Riga[] => h.db[tabella] ?? []
const riga = (tabella: string, id: string): Riga | undefined => righe(tabella).find((r) => r.id === id)
const scritturePer = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const nessunaScrittura = () => expect(h.scritture).toEqual([])
const votazioniLogate = () => h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni')
const battitiInfo = () => votazioniLogate().filter((c) => c[1] === 'info')

/** Al secondo accesso alla tabella (il primo è la lettura della votazione) cambia il database. */
function alSecondoAccesso(tabella: string, azione: () => void) {
    let n = 0
    h.suFrom = (t) => {
        if (t === tabella && ++n === 2) azione()
    }
}

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.tabelleLette = []
    h.suFrom = null
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        sections: [
            { id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
            { id: C_2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
            { id: C_B, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
        ],
        votazioni: [vot(V1)],
        votazioni_classi: [classeDi(V1, C_1)],
        votazioni_candidati: [],
        votazioni_voti: [],
        audit_scritture_docente: [],
        utenti_scuole: [],
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli accessi, comuni a PATCH e DELETE
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
    ['PATCH', (id: string) => patch(id, { azione: 'chiudi' })],
    ['DELETE', (id: string) => elimina(id)],
] as const)('%s /api/admin/votazioni/[id] · accesso', (_nome, chiama) => {
    it('docente o genitore → 403, e il database non si tocca', async () => {
        h.ruolo = 'educator'
        expect((await chiama(V1)).status).toBe(403)
        h.ruolo = 'parent'
        expect((await chiama(V1)).status).toBe(403)
        expect(h.tabelleLette).toEqual([])
        nessunaScrittura()
    })

    it('un id che non è un uuid → 400', async () => {
        expect((await chiama('non-un-uuid')).status).toBe(400)
        nessunaScrittura()
    })

    it('una votazione che non c’è → 404 VOTAZIONE_NON_TROVATA', async () => {
        const res = await chiama(uuid('90000000', 55))
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('VOTAZIONE_NON_TROVATA')
        nessunaScrittura()
    })

    it('la votazione di un’altra sede → 403 SEDE_NON_ACCESSIBILE, e non si scrive niente', async () => {
        h.db.votazioni = [vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        h.db.votazioni_classi = [classeDi(V_ALTRA_SEDE, C_B, SEDE_B)]
        const res = await chiama(V_ALTRA_SEDE)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        nessunaScrittura()
        expect(riga('votazioni', V_ALTRA_SEDE)).toBeDefined()
        expect(battitiInfo()).toEqual([])
    })

    it('schema assente → 503 VOTAZIONI_NON_DISPONIBILI, con un warn persistito', async () => {
        h.errori = { votazioni: { code: 'PGRST205' } }
        const res = await chiama(V1)
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
        expect(votazioniLogate().some((c) => c[1] === 'warn')).toBe(true)
    })

    it('un guasto del database nella lettura → 500, non un “non trovata”', async () => {
        h.errori = { votazioni: { code: '08006' } }
        const res = await chiama(V1)
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH · il body
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/votazioni/[id] · il body', () => {
    it('il gate viene PRIMA del body: un genitore con un body rotto prende 403, non 400', async () => {
        h.ruolo = 'parent'
        expect((await patch(V1, '{non è json', true)).status).toBe(403)
    })

    it.each([
        ['vuoto', {}],
        ['azione sconosciuta', { azione: 'riapri' }],
        ['proroga senza scadenza', { azione: 'proroga' }],
        ['proroga con un ISO col fuso', { azione: 'proroga', scadenza: '2031-01-01T10:00:00.000Z' }],
        ['proroga con un giorno che non esiste', { azione: 'proroga', scadenza: '2031-02-30T10:00' }],
        ['proroga con una scadenza che non è una stringa', { azione: 'proroga', scadenza: 20310101 }],
    ])('%s → 400, e non si scrive niente', async (_nome, corpo) => {
        expect((await patch(V1, corpo)).status).toBe(400)
        nessunaScrittura()
    })

    it('un JSON rotto → 400', async () => {
        expect((await patch(V1, '{non è json', true)).status).toBe(400)
        nessunaScrittura()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH · chiudi
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/votazioni/[id] · chiudi', () => {
    it('una votazione aperta → 200 { ok: true }, chiusa ADESSO, con chi e quando l’ha toccata', async () => {
        h.db.votazioni = [vot(V1), vot(V2, { titolo: 'Un’altra' })]
        const prima = Date.now()
        const res = await patch(V1, { azione: 'chiudi' })
        const dopo = Date.now()

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        const r = riga('votazioni', V1) as Riga
        expect(new Date(r.chiusa_il as string).getTime()).toBeGreaterThanOrEqual(prima - 1)
        expect(new Date(r.chiusa_il as string).getTime()).toBeLessThanOrEqual(dopo + 1)
        expect(r.aggiornata_da).toBe(SEG)
        expect(new Date(r.aggiornata_il as string).getTime()).toBeGreaterThanOrEqual(prima - 1)
        // il resto della riga non si muove, e le altre votazioni nemmeno
        expect(r).toMatchObject({ scuola_id: SEDE_A, titolo: TITOLO, scadenza: FUTURO_ISO, creata_da: SEG })
        expect(riga('votazioni', V2)).toMatchObject({ chiusa_il: null, aggiornata_da: null })
    })

    it('la patch scritta è QUELLA e non altro: chiusa_il, aggiornata_da, aggiornata_il', async () => {
        await patch(V1, { azione: 'chiudi' })
        const upd = scritturePer('votazioni', 'update')
        expect(upd).toHaveLength(1)
        expect(Object.keys(upd[0].valori[0]).sort()).toEqual(['aggiornata_da', 'aggiornata_il', 'chiusa_il'])
        expect(upd[0].colpite).toHaveLength(1)
    })

    it('già chiusa a mano → 409 VOTAZIONE_CHIUSA, e la data di chiusura resta quella di prima', async () => {
        h.db.votazioni = [vot(V1, { chiusa_il: '2026-10-05T08:00:00.000Z' })]
        const res = await patch(V1, { azione: 'chiudi' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CHIUSA')
        nessunaScrittura()
        expect(riga('votazioni', V1)?.chiusa_il).toBe('2026-10-05T08:00:00.000Z')
    })

    it('già scaduta → 409 VOTAZIONE_CHIUSA (non c’è niente da chiudere)', async () => {
        h.db.votazioni = [vot(V1, { scadenza: PASSATO_ISO })]
        const res = await patch(V1, { azione: 'chiudi' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CHIUSA')
        nessunaScrittura()
    })

    it('la corsa: qualcuno la chiude fra la lettura e la scrittura → 409, e la sua data NON viene sovrascritta', async () => {
        alSecondoAccesso('votazioni', () => {
            ;(riga('votazioni', V1) as Riga).chiusa_il = '2026-10-05T08:00:00.000Z'
        })
        const res = await patch(V1, { azione: 'chiudi' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CHIUSA')
        expect(riga('votazioni', V1)).toMatchObject({ chiusa_il: '2026-10-05T08:00:00.000Z', aggiornata_da: null })
        expect(righe('audit_scritture_docente')).toEqual([])
        expect(battitiInfo()).toEqual([])
    })

    it('lascia la traccia di audit (nessun titolo) e il battito di successo senza chiavi “voto”', async () => {
        await patch(V1, { azione: 'chiudi' })
        const audit = righe('audit_scritture_docente')
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({ attore_id: SEG, scuola_id: SEDE_A, entita_tipo: 'votazione', entita_id: V1, azione: 'update' })
        expect(JSON.stringify(audit[0])).not.toContain(TITOLO)

        expect(battitiInfo()).toHaveLength(1)
        expect(battitiInfo()[0][2]).toMatchObject({ operazione: 'chiudi', esito: 'chiusa', votazione_id: V1 })
        for (const c of votazioniLogate()) {
            expect(Object.keys(c[2] as object).filter((k) => /voto/i.test(k))).toEqual([])
            expect(JSON.stringify(c)).not.toContain(TITOLO)
        }
    })

    it('il database rifiuta la scrittura → 500, e nessuna traccia di successo', async () => {
        h.errori = { 'votazioni:update': { code: '08006' } }
        const res = await patch(V1, { azione: 'chiudi' })
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
        expect(righe('audit_scritture_docente')).toEqual([])
        expect(battitiInfo()).toEqual([])
        expect(h.logErrore).toHaveBeenCalled()
    })

    it('la scrittura trova lo schema assente → 503', async () => {
        h.errori = { 'votazioni:update': { code: '42P01' } }
        const res = await patch(V1, { azione: 'chiudi' })
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('VOTAZIONI_NON_DISPONIBILI')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH · proroga
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/votazioni/[id] · proroga', () => {
    it('una votazione aperta → 200, la nuova scadenza è alle 18:00 di Roma, il resto non si muove', async () => {
        const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })

        const r = riga('votazioni', V1) as Riga
        expect(oraCivile(r.scadenza as string)).toBe('18:00')
        expect(new Date(r.scadenza as string).getTime()).toBeGreaterThan(Date.now())
        expect(r).toMatchObject({ chiusa_il: null, scuola_id: SEDE_A, titolo: TITOLO, aggiornata_da: SEG })
        expect(r.aggiornata_il).not.toBeNull()
        const upd = scritturePer('votazioni', 'update')
        expect(upd).toHaveLength(1)
        expect(Object.keys(upd[0].valori[0]).sort()).toEqual(['aggiornata_da', 'aggiornata_il', 'scadenza'])
    })

    it('una scadenza nel passato → 400 VOTAZIONE_SCADENZA_PASSATA, e non si scrive niente', async () => {
        const res = await patch(V1, { azione: 'proroga', scadenza: PASSATO })
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('VOTAZIONE_SCADENZA_PASSATA')
        nessunaScrittura()
        expect(riga('votazioni', V1)?.scadenza).toBe(FUTURO_ISO)
    })

    it('chiusa a mano → 409 VOTAZIONE_CHIUSA: la chiusura anticipata è definitiva', async () => {
        h.db.votazioni = [vot(V1, { chiusa_il: '2026-10-05T08:00:00.000Z', scadenza: PASSATO_ISO })]
        const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CHIUSA')
        nessunaScrittura()
    })

    it('chiusa a mano e con una data passata: vince la chiusura (409), non la data (400)', async () => {
        h.db.votazioni = [vot(V1, { chiusa_il: '2026-10-05T08:00:00.000Z' })]
        expect((await patch(V1, { azione: 'proroga', scadenza: PASSATO })).status).toBe(409)
    })

    it('la corsa: qualcuno la chiude fra la lettura e la scrittura → 409 e la chiusura resta', async () => {
        alSecondoAccesso('votazioni', () => {
            ;(riga('votazioni', V1) as Riga).chiusa_il = '2026-10-05T08:00:00.000Z'
        })
        const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CHIUSA')
        expect(riga('votazioni', V1)).toMatchObject({ chiusa_il: '2026-10-05T08:00:00.000Z', scadenza: FUTURO_ISO })
        expect(battitiInfo()).toEqual([])
    })

    it('il battito di successo di una proroga dice “prorogata”; di una riapertura, “riaperta”', async () => {
        await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        expect(battitiInfo()[0][2]).toMatchObject({ operazione: 'proroga', esito: 'prorogata', votazione_id: V1 })

        h.logEvento.mockClear()
        h.db.votazioni = [vot(V1, { scadenza: PASSATO_ISO })]
        await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        expect(battitiInfo()[0][2]).toMatchObject({ operazione: 'proroga', esito: 'riaperta', votazione_id: V1 })
    })

    it('lascia la traccia di audit, senza titolo e senza chiavi “voto”', async () => {
        await patch(V1, { azione: 'proroga', scadenza: FUTURO })
        const audit = righe('audit_scritture_docente')
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({ attore_id: SEG, entita_tipo: 'votazione', entita_id: V1, azione: 'update' })
        expect(JSON.stringify(audit[0])).not.toContain(TITOLO)
        for (const c of votazioniLogate()) {
            expect(Object.keys(c[2] as object).filter((k) => /voto/i.test(k))).toEqual([])
        }
    })

    describe('Review Focus 5 · la proroga che RIAPRE una votazione scaduta rifà i controlli del POST', () => {
        beforeEach(() => {
            // V1 è scaduta (non chiusa a mano): riaprirla la rimette fra le votazioni aperte della sede.
            h.db.votazioni = [vot(V1, { scadenza: PASSATO_ISO, rappresentante_istituto: true })]
            h.db.votazioni_classi = [classeDi(V1, C_1)]
            h.db.votazioni_candidati = [candidato(V1, G_1)]
        })

        it('senza conflitti si riapre: la scadenza è nel futuro e la votazione torna aperta', async () => {
            const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
            expect(res.status).toBe(200)
            expect(new Date(riga('votazioni', V1)?.scadenza as string).getTime()).toBeGreaterThan(Date.now())
            expect(riga('votazioni', V1)?.chiusa_il).toBeNull()
        })

        it('la sua classe è già in un’altra votazione APERTA → 409 VOTAZIONE_CLASSE_GIA_APERTA, e non si riapre', async () => {
            h.db.votazioni.push(vot(V2))
            h.db.votazioni_classi.push(classeDi(V2, C_1))
            const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('VOTAZIONE_CLASSE_GIA_APERTA')
            nessunaScrittura()
            expect(riga('votazioni', V1)?.scadenza).toBe(PASSATO_ISO)
            expect(battitiInfo()).toEqual([])
        })

        it('l’istituto della sede è già in un’altra votazione aperta → 409 VOTAZIONE_ISTITUTO_GIA_APERTA', async () => {
            h.db.votazioni.push(vot(V2, { rappresentante_istituto: true }))
            h.db.votazioni_classi.push(classeDi(V2, C_2))
            const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('VOTAZIONE_ISTITUTO_GIA_APERTA')
            nessunaScrittura()
        })

        it('una votazione CHIUSA, SCADUTA o di un’altra sede con le stesse schede non è un conflitto', async () => {
            h.db.votazioni.push(
                vot(V2, { chiusa_il: '2026-10-05T08:00:00.000Z', rappresentante_istituto: true }),
                vot(V3, { scadenza: PASSATO_ISO, rappresentante_istituto: true }),
                vot(V_ALTRA_SEDE, { scuola_id: SEDE_B, rappresentante_istituto: true }),
            )
            h.db.votazioni_classi.push(classeDi(V2, C_1), classeDi(V3, C_1), classeDi(V_ALTRA_SEDE, C_B, SEDE_B))
            const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
            expect(res.status).toBe(200)
        })

        it('un’altra votazione aperta con classi DIVERSE e senza istituto non è un conflitto', async () => {
            h.db.votazioni.push(vot(V2))
            h.db.votazioni_classi.push(classeDi(V2, C_2))
            expect((await patch(V1, { azione: 'proroga', scadenza: FUTURO })).status).toBe(200)
        })

        it('se i controlli non si riescono a leggere → 500, e la votazione NON si riapre alla cieca', async () => {
            h.db.votazioni.push(vot(V2))
            h.db.votazioni_classi.push(classeDi(V2, C_2))
            h.errori = { votazioni_classi: { code: '08006' } }
            const res = await patch(V1, { azione: 'proroga', scadenza: FUTURO })
            expect(res.status).toBe(500)
            expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
            nessunaScrittura()
            expect(riga('votazioni', V1)?.scadenza).toBe(PASSATO_ISO)
        })

    })

    it('il database rifiuta la scrittura → 500, e nessuna traccia di successo', async () => {
        h.errori = { 'votazioni:update': { code: '08006' } }
        expect((await patch(V1, { azione: 'proroga', scadenza: FUTURO })).status).toBe(500)
        expect(righe('audit_scritture_docente')).toEqual([])
        expect(battitiInfo()).toEqual([])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/admin/votazioni/[id]', () => {
    it('senza voti → 200 { ok: true }, e sparisce solo QUELLA votazione, nella sua sede', async () => {
        h.db.votazioni = [vot(V1), vot(V2)]
        h.db.votazioni_classi = [classeDi(V1, C_1), classeDi(V2, C_2)]
        const res = await elimina(V1)

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(riga('votazioni', V1)).toBeUndefined()
        expect(riga('votazioni', V2)).toBeDefined()
        const del = scritturePer('votazioni', 'delete')
        expect(del).toHaveLength(1)
        expect(del[0].colpite).toHaveLength(1)
        expect(del[0].colpite[0]).toMatchObject({ id: V1, scuola_id: SEDE_A })
    })

    it('Review Focus · con anche UN SOLO voto → 409 VOTAZIONE_CON_VOTI, e non si cancella niente', async () => {
        h.db.votazioni_voti = [voto(V1, G_1, G_2)]
        const res = await elimina(V1)
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VOTAZIONE_CON_VOTI')
        nessunaScrittura()
        expect(riga('votazioni', V1)).toBeDefined()
        expect(battitiInfo()).toEqual([])
    })

    it('con voti anche se la votazione è chiusa: i voti restano la prova di chi ha votato', async () => {
        h.db.votazioni = [vot(V1, { chiusa_il: '2026-10-05T08:00:00.000Z' })]
        h.db.votazioni_voti = [voto(V1, G_1, G_2)]
        expect((await elimina(V1)).status).toBe(409)
        nessunaScrittura()
    })

    it('i voti di un’ALTRA votazione non la bloccano', async () => {
        h.db.votazioni = [vot(V1), vot(V2)]
        h.db.votazioni_voti = [voto(V2, G_1, G_2)]
        expect((await elimina(V1)).status).toBe(200)
        expect(riga('votazioni', V1)).toBeUndefined()
        expect(righe('votazioni_voti')).toHaveLength(1)
    })

    it('se i voti non si riescono a leggere → 500, e NON si cancella (un database in difficoltà non vale “senza voti”)', async () => {
        h.errori = { votazioni_voti: { code: '08006' } }
        const res = await elimina(V1)
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
        expect(scritturePer('votazioni', 'delete')).toEqual([])
        expect(riga('votazioni', V1)).toBeDefined()
        expect(battitiInfo()).toEqual([])
    })

    it('la corsa: qualcun altro l’ha già eliminata → 404, e nessuna traccia di successo', async () => {
        alSecondoAccesso('votazioni', () => {
            h.db.votazioni = []
        })
        const res = await elimina(V1)
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('VOTAZIONE_NON_TROVATA')
        expect(righe('audit_scritture_docente')).toEqual([])
        expect(battitiInfo()).toEqual([])
    })

    it('il database rifiuta la cancellazione → 500, e la votazione resta', async () => {
        h.errori = { 'votazioni:delete': { code: '08006' } }
        const res = await elimina(V1)
        expect(res.status).toBe(500)
        expect(riga('votazioni', V1)).toBeDefined()
        expect(righe('audit_scritture_docente')).toEqual([])
        expect(battitiInfo()).toEqual([])
    })

    it('lascia la traccia di audit (nessun titolo) e il battito di successo senza chiavi “voto”', async () => {
        await elimina(V1)
        const audit = righe('audit_scritture_docente')
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({ attore_id: SEG, scuola_id: SEDE_A, entita_tipo: 'votazione', entita_id: V1, azione: 'delete' })
        expect(JSON.stringify(audit[0])).not.toContain(TITOLO)

        expect(battitiInfo()).toHaveLength(1)
        expect(battitiInfo()[0][2]).toMatchObject({ operazione: 'elimina', esito: 'eliminata', votazione_id: V1 })
        for (const c of votazioniLogate()) {
            expect(Object.keys(c[2] as object).filter((k) => /voto/i.test(k))).toEqual([])
            expect(JSON.stringify(c)).not.toContain(TITOLO)
        }
    })

    it('la Direzione con due sedi elimina una votazione della seconda', async () => {
        h.ruolo = 'admin'
        h.db.utenti_scuole = [{ utente_id: SEG, scuola_id: SEDE_B }]
        h.db.votazioni = [vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        h.db.votazioni_classi = [classeDi(V_ALTRA_SEDE, C_B, SEDE_B)]
        expect((await elimina(V_ALTRA_SEDE)).status).toBe(200)
        expect(righe('votazioni')).toEqual([])
    })
})
