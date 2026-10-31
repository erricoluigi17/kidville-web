import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · le cinque route delle schede (Sessione 2).
 *
 * Il database è il FINTO che applica davvero i filtri e le scritture: «la segreteria di A non vede la
 * famiglia di B» e «l'update porta `scuola_id`» sono proprietà verificate, non asserite. Il gate di
 * ruolo è finto (decide solo chi entra); `resolveScuoleAttive`, `resolveScuolaScrittura`,
 * `assertSchedaInScope` e `restringiSedi` sono quelli VERI, perché sono loro a dire quale sede vale.
 *
 * Dati di prova soltanto: «Famiglia Prova», `333 000 0001`, `prova@example.com`.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    sedePropria: null as string | null,
    db: {} as Record<string, Record<string, unknown>[]>,
    scritture: [] as unknown[],
    errori: {} as Record<string, unknown>,
    maxRighe: undefined as number | undefined,
    prima: null as null | ((tabella: string, metodo: string) => void),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: h.sedePropria } })
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (...a: Parameters<typeof vero.logEvento>) => {
            h.logEvento(...a)
            return vero.logEvento(...a)
        },
        logErrore: (...a: Parameters<typeof vero.logErrore>) => {
            h.logErrore(...a)
            return vero.logErrore(...a)
        },
        logOk: (...a: Parameters<typeof vero.logOk>) => {
            h.logOk(...a)
            return vero.logOk(...a)
        },
    }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const vero = creaFintoSupabase(h.db as DBFinto, [], {
            scritture: h.scritture as Scrittura[],
            errori: h.errori as Record<string, ErrorePostgrest>,
            maxRighe: h.maxRighe,
        })
        if (!h.prima) return vero
        // Un osservatore sul punto in cui parte una scrittura: serve a simulare chi cambia la riga
        // fra la lettura e l'update (il finto client, da solo, è sequenziale).
        const prima = h.prima
        return new Proxy(vero, {
            get(target, prop, ricevitore) {
                if (prop !== 'from') return Reflect.get(target, prop, ricevitore)
                return (tabella: string) => {
                    const costruttore = target.from(tabella)
                    return new Proxy(costruttore, {
                        get(t, metodo) {
                            const valore = (t as unknown as Record<string | symbol, unknown>)[metodo]
                            if (typeof valore !== 'function' || typeof metodo !== 'string') return valore
                            return (...argomenti: unknown[]) => {
                                prima(tabella, metodo)
                                return (valore as (...a: unknown[]) => unknown).apply(t, argomenti)
                            }
                        },
                    })
                }
            },
        })
    },
}))

import { GET as GET_ELENCO, POST as POST_SCHEDA } from '@/app/api/admin/crm/schede/route'
import { GET as GET_DETTAGLIO, PATCH as PATCH_SCHEDA } from '@/app/api/admin/crm/schede/[id]/route'
import { POST as POST_BAMBINO } from '@/app/api/admin/crm/schede/[id]/bambini/route'
import { PATCH as PATCH_BAMBINO } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/route'
import { POST as POST_EVENTO } from '@/app/api/admin/crm/schede/[id]/eventi/route'

const USER = '20000000-0000-4000-8000-0000000000aa'
const SEG_A = '20000000-0000-4000-8000-00000000000a'
const SEG_B = '20000000-0000-4000-8000-00000000000b'

const S1 = '30000000-0000-4000-8000-000000000001' // sede A, la famiglia con tutto
const S2 = '30000000-0000-4000-8000-000000000002' // sede A, instagram, una visita svolta da SEG_A
const S3 = '30000000-0000-4000-8000-000000000003' // sede A, il bambino iscritto è collegato a una domanda
const SB = '30000000-0000-4000-8000-0000000000b1' // sede B, stesso numero di S1
const DOMANDA = '40000000-0000-4000-8000-000000000001'

const B1A = '50000000-0000-4000-8000-0000000000a1'
const B1B = '50000000-0000-4000-8000-0000000000a2'
const B2 = '50000000-0000-4000-8000-0000000000a3'
const B3 = '50000000-0000-4000-8000-0000000000a4'
const BB = '50000000-0000-4000-8000-0000000000b1'

const ADESSO_FUTURO = '2099-01-10T10:00:00.000Z'
const PASSATO = '2020-01-10T10:00:00.000Z'

const scheda = (id: string, sede: string, extra: Record<string, unknown> = {}) => ({
    id,
    scuola_id: sede,
    genitore_nome: 'Famiglia Prova',
    telefono1: '333 000 0001',
    telefono2: null,
    email1: null,
    email2: null,
    telefoni_norm: ['3330000001'],
    email_norm: [],
    origine: 'telefonata',
    routine: null,
    paura: null,
    desiderio: null,
    domanda_da_associare: null,
    creato_da: SEG_A,
    creato_via: 'segreteria',
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    anonimizzata_il: null,
    ...extra,
})

const bambino = (id: string, schedaId: string, sede: string, extra: Record<string, unknown> = {}) => ({
    id,
    scuola_id: sede,
    scheda_id: schedaId,
    nome: 'Bimbo Prova',
    data_nascita: null,
    anno_ingresso: 'prossimo',
    esito: 'aperto',
    motivo_perdita: null,
    motivo_nota: null,
    esito_origine: null,
    esito_da: null,
    esito_il: null,
    domanda_id: null,
    domanda_figlio: null,
    domanda_collegata_il: null,
    nota_collegamento: null,
    da_verificare: false,
    quota_saldata: false,
    quota_saldata_il: null,
    quota_segnata_da: null,
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    ...extra,
})

const richiesta = (metodo: string, percorso: string, corpo?: unknown) =>
    new NextRequest(`http://localhost${percorso}`, {
        method: metodo,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
    })

const conId = (id: string) => ({ params: Promise.resolve({ id }) })
const conIdEBambino = (id: string, bambinoId: string) => ({ params: Promise.resolve({ id, bambinoId }) })

const elenco = (query = '') => GET_ELENCO(richiesta('GET', `/api/admin/crm/schede${query}`))
const idsElenco = async (query: string) => {
    const res = await elenco(query)
    expect(res.status).toBe(200)
    return ((await res.json()).data as { id: string }[]).map((r) => r.id)
}

const scritto = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const eventiScritti = () => scritto('crm_eventi', 'insert').flatMap((s) => s.valori)

const corpoNuova = (extra: Record<string, unknown> = {}) => ({
    genitoreNome: 'Famiglia Prova',
    telefono1: '333 000 0009',
    origine: 'telefonata',
    bambini: [{ nome: 'Bimbo Prova', annoIngresso: 'prossimo' }],
    ...extra,
})

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.sedePropria = SEDE_A
    h.scritture = []
    h.errori = {}
    h.maxRighe = undefined
    h.prima = null
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.logOk.mockClear()
    h.db = {
        utenti: [
            { id: SEG_A, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: SEG_B, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
        ],
        utenti_scuole: [],
        crm_schede: [
            scheda(S1, SEDE_A, { genitore_nome: 'Famiglia Prova Uno', creata_il: '2026-10-01T09:00:00.000Z' }),
            scheda(S2, SEDE_A, {
                genitore_nome: 'Famiglia Prova Due',
                telefono1: '333 000 0002',
                telefoni_norm: ['3330000002'],
                email1: 'prova@example.com',
                email_norm: ['prova@example.com'],
                origine: 'instagram',
                creata_il: '2026-10-15T09:00:00.000Z',
            }),
            scheda(S3, SEDE_A, {
                genitore_nome: 'Famiglia Prova Tre',
                telefono1: '333 000 0003',
                telefoni_norm: ['3330000003'],
                origine: 'sito',
                creata_il: '2026-10-20T09:00:00.000Z',
            }),
            scheda(SB, SEDE_B, { genitore_nome: 'Famiglia Prova Uno B', creata_il: '2026-10-05T09:00:00.000Z' }),
        ],
        crm_bambini: [
            bambino(B1A, S1, SEDE_A, { nome: 'Bimbo Prova Uno', esito: 'iscritto' }),
            bambino(B1B, S1, SEDE_A, { nome: 'Bimba Prova Uno', esito: 'perso', motivo_perdita: 'prezzo' }),
            bambino(B2, S2, SEDE_A, { nome: 'Bimbo Prova Due', esito: 'aperto' }),
            bambino(B3, S3, SEDE_A, { nome: 'Bimbo Terzo', esito: 'iscritto', domanda_id: DOMANDA, domanda_figlio: 0 }),
            bambino(BB, SB, SEDE_B, { nome: 'Bimbo Prova Uno', esito: 'aperto' }),
        ],
        crm_appuntamenti: [
            { id: 'a1', scuola_id: SEDE_A, scheda_id: S1, inizio: ADESSO_FUTURO, fine: '2099-01-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'in_programma' },
            // una visita passata mai segnata e una annullata nel futuro non sono «la prossima visita»
            { id: 'a2', scuola_id: SEDE_A, scheda_id: S1, inizio: PASSATO, fine: '2020-01-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'in_programma' },
            { id: 'a3', scuola_id: SEDE_A, scheda_id: S1, inizio: '2098-01-10T10:00:00.000Z', fine: '2098-01-10T10:45:00.000Z', assegnata_a: SEG_A, svolto_da: null, stato: 'annullato' },
            { id: 'a4', scuola_id: SEDE_A, scheda_id: S2, inizio: PASSATO, fine: '2020-01-11T10:45:00.000Z', assegnata_a: SEG_B, svolto_da: SEG_A, stato: 'svolto' },
        ],
        crm_azioni: [
            { id: 'z1', scuola_id: SEDE_A, scheda_id: S1, tipo: 'follow_up_1', scadenza: '2026-11-02T09:30:00.000Z', responsabile: SEG_A, fatta_il: null, cancellata_il: null },
            { id: 'z2', scuola_id: SEDE_A, scheda_id: S1, tipo: 'richiamare', scadenza: '2026-10-02T09:30:00.000Z', responsabile: SEG_A, fatta_il: '2026-10-02T10:00:00.000Z', cancellata_il: null },
            { id: 'z3', scuola_id: SEDE_A, scheda_id: S1, tipo: 'riprova_1', scadenza: '2026-10-03T09:30:00.000Z', responsabile: SEG_A, fatta_il: null, cancellata_il: '2026-10-03T10:00:00.000Z' },
        ],
        crm_eventi: [
            { id: 'e1', scuola_id: SEDE_A, scheda_id: S1, tipo: 'creata', autore: SEG_A, autore_via: 'segreteria', dati: {}, testo: null, creato_il: '2026-10-01T09:00:00.000Z' },
            { id: 'e2', scuola_id: SEDE_A, scheda_id: S1, tipo: 'nota', autore: SEG_A, autore_via: 'segreteria', dati: {}, testo: 'Preferisce il pomeriggio.', creato_il: '2026-10-02T09:00:00.000Z' },
            { id: 'e3', scuola_id: SEDE_A, scheda_id: S2, tipo: 'creata', autore: SEG_A, autore_via: 'segreteria', dati: {}, testo: null, creato_il: '2026-10-15T09:00:00.000Z' },
        ],
    }
})

// ── il gate ──────────────────────────────────────────────────────────────────

describe('gate di ruolo', () => {
    const tutte: [string, () => Promise<Response>][] = [
        ['GET /schede', () => elenco(`?scuolaId=${SEDE_A}`)],
        ['POST /schede', () => POST_SCHEDA(richiesta('POST', '/api/admin/crm/schede', corpoNuova()))],
        ['GET /schede/[id]', () => GET_DETTAGLIO(richiesta('GET', `/api/admin/crm/schede/${S1}`), conId(S1))],
        ['PATCH /schede/[id]', () => PATCH_SCHEDA(richiesta('PATCH', `/api/admin/crm/schede/${S1}`, { routine: 'x' }), conId(S1))],
        ['POST bambini', () => POST_BAMBINO(richiesta('POST', `/api/admin/crm/schede/${S1}/bambini`, { nome: 'x', annoIngresso: 'prossimo' }), conId(S1))],
        [
            'PATCH bambino',
            () => PATCH_BAMBINO(richiesta('PATCH', `/api/admin/crm/schede/${S1}/bambini/${B1A}`, { nome: 'x' }), conIdEBambino(S1, B1A)),
        ],
        ['POST eventi', () => POST_EVENTO(richiesta('POST', `/api/admin/crm/schede/${S1}/eventi`, { tipo: 'nota', testo: 'x' }), conId(S1))],
    ]

    for (const ruolo of ['educator', 'coordinator', 'parent']) {
        it.each(tutte)(`${ruolo} → 403 su %s, e niente viene scritto`, async (_nome, chiama) => {
            h.ruolo = ruolo
            const res = await chiama()
            expect(res.status).toBe(403)
            expect(h.scritture).toHaveLength(0)
        })
    }
})

// ── GET /schede ──────────────────────────────────────────────────────────────

describe('GET /schede', () => {
    it('torna le sole schede della sede, dalla più recente, con bambini, prossima visita e prossima azione', async () => {
        const res = await elenco(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo.totale).toBe(3)
        expect(corpo.data.map((r: { id: string }) => r.id)).toEqual([S3, S2, S1])

        const r1 = corpo.data.find((r: { id: string }) => r.id === S1)
        expect(r1).toMatchObject({
            id: S1,
            genitore_nome: 'Famiglia Prova Uno',
            origine: 'telefonata',
            creata_il: '2026-10-01T09:00:00.000Z',
            prossima_visita: ADESSO_FUTURO, // né la passata mai segnata né l'annullata
            prossima_azione: '2026-11-02T09:30:00.000Z', // né la fatta né la cancellata
        })
        expect(r1.bambini).toEqual([
            { id: B1A, nome: 'Bimbo Prova Uno', esito: 'iscritto', domanda_id: null },
            { id: B1B, nome: 'Bimba Prova Uno', esito: 'perso', domanda_id: null },
        ])
        const r2 = corpo.data.find((r: { id: string }) => r.id === S2)
        expect(r2.prossima_visita).toBeNull()
        expect(r2.prossima_azione).toBeNull()
    })

    it('la famiglia di un’altra sede non compare, nemmeno cercandola per numero o per nome', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}`)).not.toContain(SB)
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=${encodeURIComponent('333 000 0001')}`)).toEqual([S1])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=Uno%20B`)).toEqual([])
    })

    it('sede di un’altra segreteria → 403 SEDE_NON_ACCESSIBILE', async () => {
        const res = await elenco(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('la sede si dichiara: senza scuolaId → 400', async () => {
        expect((await elenco()).status).toBe(400)
    })

    it('filtro esito: le schede con almeno un bambino in quell’esito', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}&esito=perso`)).toEqual([S1])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&esito=aperto`)).toEqual([S2])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&esito=iscritto`)).toEqual([S3, S1])
        expect((await elenco(`?scuolaId=${SEDE_A}&esito=inventato`)).status).toBe(400)
    })

    it('filtro origine', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}&origine=instagram`)).toEqual([S2])
    })

    it('filtro persona: la visita è assegnata a lei oppure l’ha svolta lei', async () => {
        // SEG_A: assegnataria delle visite di S1, e ha svolto quella di S2 (assegnata a SEG_B)
        expect((await idsElenco(`?scuolaId=${SEDE_A}&persona=${SEG_A}`)).sort()).toEqual([S1, S2].sort())
        expect(await idsElenco(`?scuolaId=${SEDE_A}&persona=${SEG_B}`)).toEqual([S2])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&persona=${USER}`)).toEqual([])
    })

    it('filtro «senza domanda collegata»: iscritto e domanda_id nullo', async () => {
        // S3 ha un bambino iscritto MA collegato; S1 ha un iscritto senza domanda → solo S1
        expect(await idsElenco(`?scuolaId=${SEDE_A}&senzaDomanda=true`)).toEqual([S1])
        // spento, non filtra
        expect((await idsElenco(`?scuolaId=${SEDE_A}&senzaDomanda=false`)).sort()).toEqual([S1, S2, S3].sort())
    })

    it('ricerca: nome del genitore, nome di un bambino, telefono in qualunque forma; mai doppioni', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=due`)).toEqual([S2]) // genitore, senza badare alle maiuscole
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=terzo`)).toEqual([S3]) // nome di un bambino
        // «uno» è nel genitore di S1 e nel nome di entrambi i suoi bambini: una riga sola
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=uno`)).toEqual([S1])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=${encodeURIComponent('+39 333-0000002')}`)).toEqual([S2])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&q=nessuno-con-questo-nome`)).toEqual([])
    })

    it('ricerca fatta solo di metacaratteri: non filtra e non rompe', async () => {
        expect((await idsElenco(`?scuolaId=${SEDE_A}&q=${encodeURIComponent('%,()')}`)).sort()).toEqual([S1, S2, S3].sort())
    })

    it('periodo di creazione: creataDa/creataA (come la barra) e dal/al (come il contratto)', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}&creataDa=2026-10-10&creataA=2026-10-16`)).toEqual([S2])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&dal=2026-10-10`)).toEqual([S3, S2])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&al=2026-10-01`)).toEqual([S1]) // l'ultimo istante del giorno è incluso
        expect((await elenco(`?scuolaId=${SEDE_A}&dal=ieri`)).status).toBe(400)
    })

    it('filtri combinati: tutti insieme, non uno qualunque', async () => {
        expect(await idsElenco(`?scuolaId=${SEDE_A}&esito=iscritto&origine=sito`)).toEqual([S3])
        expect(await idsElenco(`?scuolaId=${SEDE_A}&esito=perso&origine=sito`)).toEqual([])
    })

    it('a pagine di 50: la seconda porta il resto, il totale resta intero', async () => {
        const molte = Array.from({ length: 57 }, (_, i) =>
            scheda(`31000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SEDE_A, {
                genitore_nome: `Famiglia Prova ${i}`,
                creata_il: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
            }),
        )
        h.db.crm_schede.push(...molte)
        const p1 = await (await elenco(`?scuolaId=${SEDE_A}`)).json()
        const p2 = await (await elenco(`?scuolaId=${SEDE_A}&pagina=2`)).json()
        expect(p1.totale).toBe(60)
        expect(p1.data).toHaveLength(50)
        expect(p2.totale).toBe(60)
        expect(p2.data).toHaveLength(10)
        const tutti = [...p1.data, ...p2.data].map((r: { id: string }) => r.id)
        expect(new Set(tutti).size).toBe(60)
        expect((await elenco(`?scuolaId=${SEDE_A}&pagina=0`)).status).toBe(400)
    })

    it('più di 1000 righe in una tabella: legge a blocchi, non si ferma al primo (max_rows)', async () => {
        const molte = Array.from({ length: 1300 }, (_, i) =>
            scheda(`32000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SEDE_A, {
                creata_il: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
            }),
        )
        h.db.crm_schede.push(...molte)
        h.maxRighe = 1000 // il tetto di PostgREST: oltre, la risposta è troncata e muta
        const res = await GET_ELENCO(richiesta('GET', `/api/admin/crm/schede?scuolaId=${SEDE_A}`))
        expect((await res.json()).totale).toBe(1303)
    })

    it('guasto del database → 500 CRM_OPERAZIONE_NON_RIUSCITA, e il testo del database non esce', async () => {
        h.errori = { 'crm_schede:select': { code: '08006', message: 'tabella crm_schede colonna segreta' } }
        const res = await elenco(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(500)
        const corpo = await res.json()
        expect(corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
        expect(JSON.stringify(corpo)).not.toContain('segreta')
    })

    it('tabelle assenti → 503 CRM_NON_INSTALLATO', async () => {
        h.errori = { 'crm_schede:select': { code: 'PGRST205' } }
        const res = await elenco(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    })

    it('un guasto nella lettura dei bambini non diventa un elenco con bambini mancanti', async () => {
        h.errori = { 'crm_bambini:select': { code: '08006' } }
        expect((await elenco(`?scuolaId=${SEDE_A}`)).status).toBe(500)
    })
})

// ── POST /schede ─────────────────────────────────────────────────────────────

describe('POST /schede', () => {
    const crea = (corpo: unknown) => POST_SCHEDA(richiesta('POST', '/api/admin/crm/schede', corpo))

    it('senza telefono né email → 422 CONTATTO_OBBLIGATORIO, e non scrive niente', async () => {
        const res = await crea(corpoNuova({ telefono1: undefined }))
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('CONTATTO_OBBLIGATORIO')
        expect(h.scritture).toHaveLength(0)
    })

    it('un telefono troppo corto per essere un telefono non è un contatto → 422', async () => {
        const res = await crea(corpoNuova({ telefono1: '12 34' }))
        expect(res.status).toBe(422)
    })

    it('basta un’email', async () => {
        const res = await crea(corpoNuova({ telefono1: undefined, email1: '  Nuova.Prova@Example.com ' }))
        expect(res.status).toBe(201)
        expect(scritto('crm_schede', 'insert')[0].valori[0]).toMatchObject({ email_norm: ['nuova.prova@example.com'], telefoni_norm: [] })
    })

    it('admin con due sedi e nessuna sede indicata → 400 SEDE_DA_SPECIFICARE (la sede non si indovina)', async () => {
        h.ruolo = 'admin'
        h.sedePropria = null
        h.db.utenti_scuole = [
            { utente_id: USER, scuola_id: SEDE_A },
            { utente_id: USER, scuola_id: SEDE_B },
        ]
        const res = await crea(corpoNuova())
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        expect(h.scritture).toHaveLength(0)
    })

    it('admin con due sedi che dichiara la sede B → la scheda nasce in B, con i figli in B', async () => {
        h.ruolo = 'admin'
        h.sedePropria = null
        h.db.utenti_scuole = [
            { utente_id: USER, scuola_id: SEDE_A },
            { utente_id: USER, scuola_id: SEDE_B },
        ]
        const res = await crea(corpoNuova({ scuolaId: SEDE_B }))
        expect(res.status).toBe(201)
        expect(scritto('crm_schede', 'insert')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
        expect(scritto('crm_bambini', 'insert')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
        for (const e of eventiScritti()) expect(e).toMatchObject({ scuola_id: SEDE_B })
    })

    it('la segreteria che dichiara la sede di un altro plesso → 403, niente scritto', async () => {
        const res = await crea(corpoNuova({ scuolaId: SEDE_B }))
        expect(res.status).toBe(403)
        expect(h.scritture).toHaveLength(0)
    })

    it('201: scheda, bambini ed eventi (creata + un bambino_aggiunto per bambino) nella sede giusta', async () => {
        const res = await crea(
            corpoNuova({
                telefono2: '+39 333 000 0010',
                email1: 'Nuova@Example.com',
                routine: 'Dorme dopo pranzo',
                bambini: [
                    { nome: 'Bimbo Prova', dataNascita: '2024-03-05', annoIngresso: 'prossimo' },
                    { nome: 'Bimba Prova', annoIngresso: 'in_corso' },
                ],
            }),
        )
        expect(res.status).toBe(201)
        const { id } = await res.json()
        expect(id).toBe(h.db.crm_schede[h.db.crm_schede.length - 1].id) // l'id della riga appena scritta

        expect(scritto('crm_schede', 'insert')[0].valori[0]).toMatchObject({
            scuola_id: SEDE_A,
            genitore_nome: 'Famiglia Prova',
            origine: 'telefonata',
            routine: 'Dorme dopo pranzo',
            telefoni_norm: ['3330000009', '3330000010'],
            email_norm: ['nuova@example.com'],
            creato_da: USER,
            creato_via: 'segreteria',
        })
        const figli = scritto('crm_bambini', 'insert')[0].valori
        expect(figli).toHaveLength(2)
        expect(figli[0]).toMatchObject({ scuola_id: SEDE_A, scheda_id: id, nome: 'Bimbo Prova', data_nascita: '2024-03-05', anno_ingresso: 'prossimo' })
        expect(figli[1]).toMatchObject({ scuola_id: SEDE_A, scheda_id: id, nome: 'Bimba Prova', anno_ingresso: 'in_corso' })

        const eventi = eventiScritti()
        expect(eventi.map((e) => e.tipo)).toEqual(['creata', 'bambino_aggiunto', 'bambino_aggiunto'])
        for (const e of eventi) expect(e).toMatchObject({ scheda_id: id, scuola_id: SEDE_A, autore: USER, autore_via: 'segreteria' })
        // nello storico niente nomi né numeri: solo identificativi e conteggi
        expect(JSON.stringify(eventi)).not.toMatch(/Prova|333|example/)
    })

    it('telefono già presente nella sede (scritto in un altro modo) → 409 SCHEDA_ESISTENTE con lo schedaId', async () => {
        const res = await crea(corpoNuova({ telefono1: '0039 333-0000001' }))
        expect(res.status).toBe(409)
        const corpo = await res.json()
        expect(corpo.codice).toBe('SCHEDA_ESISTENTE')
        expect(corpo.schedaId).toBe(S1)
        expect(h.scritture).toHaveLength(0)
    })

    it('email già presente nella sede (maiuscole e spazi non contano) → 409', async () => {
        const res = await crea(corpoNuova({ telefono1: undefined, email1: ' PROVA@example.com ' }))
        expect(res.status).toBe(409)
        expect((await res.json()).schedaId).toBe(S2)
    })

    it('con forza → 201 anche se il telefono c’è già', async () => {
        const res = await crea(corpoNuova({ telefono1: '333 000 0001', forza: true }))
        expect(res.status).toBe(201)
        expect(scritto('crm_schede', 'insert')).toHaveLength(1)
    })

    it('telefono presente solo in un’altra sede → 201 (le sedi non si guardano fra loro)', async () => {
        h.db.crm_schede = [scheda(SB, SEDE_B)]
        const res = await crea(corpoNuova({ telefono1: '333 000 0001' }))
        expect(res.status).toBe(201)
    })

    it('1–6 bambini: zero e sette → 400', async () => {
        expect((await crea(corpoNuova({ bambini: [] }))).status).toBe(400)
        const sette = Array.from({ length: 7 }, () => ({ nome: 'Bimbo Prova', annoIngresso: 'prossimo' }))
        expect((await crea(corpoNuova({ bambini: sette }))).status).toBe(400)
        expect(h.scritture).toHaveLength(0)
    })

    it('origine inventata → 400; l’origine «ai» non si sceglie da qui', async () => {
        expect((await crea(corpoNuova({ origine: 'inventata' }))).status).toBe(400)
        expect((await crea(corpoNuova({ origine: 'ai' }))).status).toBe(400)
    })

    it('se i figli non si scrivono, la scheda appena creata non resta orfana: 500 e scheda tolta', async () => {
        h.errori = { 'crm_bambini:insert': { code: 'XX000' } }
        const prima = h.db.crm_schede.length
        const res = await crea(corpoNuova())
        expect(res.status).toBe(500)
        expect(h.db.crm_schede).toHaveLength(prima)
        const tolta = scritto('crm_schede', 'delete')
        expect(tolta).toHaveLength(1)
        expect(eventiScritti()).toHaveLength(0)
    })

    it('se non si scrive la scheda → 500, senza figli né storico', async () => {
        h.errori = { 'crm_schede:insert': { code: 'XX000' } }
        const res = await crea(corpoNuova())
        expect(res.status).toBe(500)
        expect(scritto('crm_bambini', 'insert')).toHaveLength(0)
    })

    it('lo storico che non si scrive non annulla la scheda: 201, e un log error', async () => {
        h.errori = { 'crm_eventi:insert': { code: 'XX000' } }
        const res = await crea(corpoNuova())
        expect(res.status).toBe(201)
        expect(h.logEvento.mock.calls.some((c) => c[0] === 'crm' && c[1] === 'error')).toBe(true)
    })

    it('tabelle assenti → 503', async () => {
        h.errori = { 'crm_schede': { code: 'PGRST205' } }
        const res = await crea(corpoNuova())
        expect(res.status).toBe(503)
    })

    it('un campo che non esiste nello schema non entra (lista bianca)', async () => {
        const res = await crea(corpoNuova({ creato_da: SEG_B, anonimizzata_il: '2026-01-01', telefoni_norm: ['1'] }))
        expect(res.status).toBe(201)
        const riga = scritto('crm_schede', 'insert')[0].valori[0]
        expect(riga.creato_da).toBe(USER)
        expect(riga.anonimizzata_il).toBeUndefined()
        expect(riga.telefoni_norm).toEqual(['3330000009'])
    })
})

// ── GET /schede/[id] ─────────────────────────────────────────────────────────

describe('GET /schede/[id]', () => {
    const apri = (id: string) => GET_DETTAGLIO(richiesta('GET', `/api/admin/crm/schede/${id}`), conId(id))

    it('scheda, bambini, visite, richiami aperti e storico — del più recente — con le persone come {id, nome, cognome}', async () => {
        const res = await apri(S1)
        expect(res.status).toBe(200)
        const corpo = await res.json()

        expect(corpo.scheda).toMatchObject({ id: S1, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova Uno' })
        expect(corpo.bambini.map((b: { id: string }) => b.id)).toEqual([B1A, B1B])
        // tutte le visite della scheda (anche la passata e l'annullata), non solo le future: è il dettaglio
        expect(corpo.appuntamenti.map((a: { id: string }) => a.id).sort()).toEqual(['a1', 'a2', 'a3'])
        expect(corpo.appuntamenti[0].assegnata_a_persona).toEqual({ id: SEG_A, nome: 'Anna', cognome: 'Prova' })
        // i richiami aperti: né il fatto né il cancellato
        expect(corpo.azioni_aperte.map((a: { id: string }) => a.id)).toEqual(['z1'])
        expect(corpo.azioni_aperte[0].responsabile_persona).toEqual({ id: SEG_A, nome: 'Anna', cognome: 'Prova' })
        // lo storico, dal più recente
        expect(corpo.eventi.map((e: { id: string }) => e.id)).toEqual(['e2', 'e1'])
        expect(corpo.eventi[0].autore_persona).toEqual({ id: SEG_A, nome: 'Anna', cognome: 'Prova' })
        expect(corpo.eventi_totale).toBe(2)
    })

    it('non porta niente di un’altra scheda', async () => {
        const corpo = await (await apri(S2)).json()
        expect(corpo.bambini.map((b: { id: string }) => b.id)).toEqual([B2])
        expect(corpo.eventi.map((e: { id: string }) => e.id)).toEqual(['e3'])
        expect(corpo.azioni_aperte).toEqual([])
    })

    it('scheda di un’altra sede → 403, senza leggere il resto', async () => {
        const res = await apri(SB)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('scheda che non esiste → 404 SCHEDA_NON_TROVATA', async () => {
        const res = await apri('30000000-0000-4000-8000-0000000000ff')
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
    })

    it('id che non è un uuid → 400', async () => {
        expect((await apri('non-un-uuid')).status).toBe(400)
    })

    it('lo storico è a 500 righe, le più recenti, e dice quante sono in tutto', async () => {
        h.db.crm_eventi = Array.from({ length: 501 }, (_, i) => ({
            id: `ev-${String(i).padStart(4, '0')}`,
            scuola_id: SEDE_A,
            scheda_id: S1,
            tipo: 'nota',
            autore: SEG_A,
            autore_via: 'segreteria',
            dati: {},
            testo: `nota ${i}`,
            creato_il: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        }))
        const corpo = await (await apri(S1)).json()
        expect(corpo.eventi).toHaveLength(500)
        expect(corpo.eventi_totale).toBe(501)
        expect(corpo.eventi[0].id).toBe('ev-0500') // il più recente in testa
        expect(corpo.eventi.map((e: { id: string }) => e.id)).not.toContain('ev-0000') // il più vecchio resta fuori
    })

    it('un guasto nella lettura dei bambini è un 500, non una scheda senza figli', async () => {
        h.errori = { 'crm_bambini:select': { code: '08006' } }
        expect((await apri(S1)).status).toBe(500)
    })
})

// ── PATCH /schede/[id] ───────────────────────────────────────────────────────

describe('PATCH /schede/[id]', () => {
    const modifica = (id: string, corpo: unknown) => PATCH_SCHEDA(richiesta('PATCH', `/api/admin/crm/schede/${id}`, corpo), conId(id))

    it('cambia il telefono: ricalcola le forme normalizzate e scrive «modificata» con i soli nomi dei campi', async () => {
        const res = await modifica(S1, { telefono1: '+39 333 000 0077', telefono2: '333 000 0088' })
        expect(res.status).toBe(200)
        const riga = h.db.crm_schede.find((s) => s.id === S1)!
        expect(riga).toMatchObject({ telefono1: '+39 333 000 0077', telefono2: '333 000 0088', telefoni_norm: ['3330000077', '3330000088'] })
        expect(riga.aggiornata_il).not.toBe('2026-10-01T09:00:00.000Z')

        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ tipo: 'modificata', scheda_id: S1, scuola_id: SEDE_A, autore: USER, autore_via: 'segreteria' })
        expect(eventi[0].dati).toEqual({ campi: 'telefono1,telefono2' })
        expect(JSON.stringify(eventi)).not.toMatch(/333|0077|0088/)
    })

    it('l’update porta scuola_id: una riga con lo stesso id in un’altra sede non si tocca', async () => {
        // impossibile in produzione (la chiave primaria è l'id): serve a far vedere al finto client la differenza
        h.db.crm_schede.push(scheda(S1, SEDE_B, { genitore_nome: 'Famiglia Prova Gemella' }))
        await modifica(S1, { genitoreNome: 'Famiglia Prova Nuova' })
        expect(h.db.crm_schede.find((s) => s.id === S1 && s.scuola_id === SEDE_A)!.genitore_nome).toBe('Famiglia Prova Nuova')
        expect(h.db.crm_schede.find((s) => s.id === S1 && s.scuola_id === SEDE_B)!.genitore_nome).toBe('Famiglia Prova Gemella')
    })

    it('le tre domande e il genitore: si possono cambiare e svuotare', async () => {
        h.db.crm_schede.find((s) => s.id === S1)!.paura = 'Il distacco'
        const res = await modifica(S1, { paura: '', desiderio: 'Un posto a settembre', origine: 'passaparola' })
        expect(res.status).toBe(200)
        expect(h.db.crm_schede.find((s) => s.id === S1)).toMatchObject({ paura: null, desiderio: 'Un posto a settembre', origine: 'passaparola' })
        expect(eventiScritti()[0].dati).toEqual({ campi: 'origine,paura,desiderio' })
    })

    it('nessun valore davvero cambiato → 200, nessuna scrittura, nessun evento', async () => {
        const res = await modifica(S1, { genitoreNome: 'Famiglia Prova Uno', origine: 'telefonata' })
        expect(res.status).toBe(200)
        expect(h.scritture).toHaveLength(0)
    })

    it('corpo vuoto → 400', async () => {
        expect((await modifica(S1, {})).status).toBe(400)
    })

    it('togliere l’unico recapito → 422 CONTATTO_OBBLIGATORIO; cambiare altro su una scheda senza recapiti no', async () => {
        const res = await modifica(S1, { telefono1: '' })
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('CONTATTO_OBBLIGATORIO')
        expect(h.db.crm_schede.find((s) => s.id === S1)!.telefono1).toBe('333 000 0001')

        Object.assign(h.db.crm_schede.find((s) => s.id === S3)!, { telefono1: null, telefoni_norm: [] })
        expect((await modifica(S3, { routine: 'Gioca all’aperto' })).status).toBe(200)
    })

    it('origine «ai» non si imposta da qui → 400', async () => {
        expect((await modifica(S1, { origine: 'ai' })).status).toBe(400)
    })

    it('scheda di un’altra sede → 403, nessuna scrittura; scheda inesistente → 404', async () => {
        const altrui = await modifica(SB, { routine: 'x' })
        expect(altrui.status).toBe(403)
        expect((await modifica('30000000-0000-4000-8000-0000000000ff', { routine: 'x' })).status).toBe(404)
        expect(h.scritture).toHaveLength(0)
    })

    it('guasto dell’update → 500 e nessun evento «modificata»', async () => {
        h.errori = { 'crm_schede:update': { code: 'XX000' } }
        const res = await modifica(S1, { routine: 'x' })
        expect(res.status).toBe(500)
        expect(eventiScritti()).toHaveLength(0)
    })
})

// ── POST /schede/[id]/bambini ────────────────────────────────────────────────

describe('POST /schede/[id]/bambini', () => {
    const aggiungi = (id: string, corpo: unknown) => POST_BAMBINO(richiesta('POST', `/api/admin/crm/schede/${id}/bambini`, corpo), conId(id))

    it('aggiunge il bambino nella sede della scheda e scrive «bambino_aggiunto» con il solo id', async () => {
        const res = await aggiungi(S2, { nome: 'Bimba Prova Nuova', dataNascita: '2025-02-01', annoIngresso: 'in_corso' })
        expect(res.status).toBe(201)
        const { id } = await res.json()
        expect(scritto('crm_bambini', 'insert')[0].valori[0]).toMatchObject({
            scuola_id: SEDE_A,
            scheda_id: S2,
            nome: 'Bimba Prova Nuova',
            data_nascita: '2025-02-01',
            anno_ingresso: 'in_corso',
        })
        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ tipo: 'bambino_aggiunto', scheda_id: S2, scuola_id: SEDE_A })
        expect(eventi[0].dati).toEqual({ bambino_id: id })
        expect(JSON.stringify(eventi)).not.toContain('Nuova')
    })

    it('scheda di un’altra sede → 403; anno inventato → 400; guasto → 500', async () => {
        expect((await aggiungi(SB, { nome: 'x', annoIngresso: 'prossimo' })).status).toBe(403)
        expect((await aggiungi(S2, { nome: 'x', annoIngresso: 'mai' })).status).toBe(400)
        h.errori = { 'crm_bambini:insert': { code: 'XX000' } }
        expect((await aggiungi(S2, { nome: 'x', annoIngresso: 'prossimo' })).status).toBe(500)
        expect(eventiScritti()).toHaveLength(0)
    })
})

// ── PATCH /schede/[id]/bambini/[bambinoId] ───────────────────────────────────

describe('PATCH /schede/[id]/bambini/[bambinoId]', () => {
    const cambia = (id: string, bambinoId: string, corpo: unknown) =>
        PATCH_BAMBINO(richiesta('PATCH', `/api/admin/crm/schede/${id}/bambini/${bambinoId}`, corpo), conIdEBambino(id, bambinoId))
    const riga = (id: string, sede = SEDE_A) => h.db.crm_bambini.find((b) => b.id === id && b.scuola_id === sede)!

    it('esito «perso» senza motivo → 422 MOTIVO_OBBLIGATORIO, e non scrive niente', async () => {
        const res = await cambia(S2, B2, { esito: 'perso' })
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(h.scritture).toHaveLength(0)
        expect(riga(B2).esito).toBe('aperto')
    })

    it('esito «perso» con motivo → salvato, con la nota; «esito_cambiato» dice da e a', async () => {
        const res = await cambia(S2, B2, { esito: 'perso', motivoPerdita: 'altra_scuola', motivoNota: 'Ha scelto vicino a casa' })
        expect(res.status).toBe(200)
        expect(riga(B2)).toMatchObject({ esito: 'perso', motivo_perdita: 'altra_scuola', motivo_nota: 'Ha scelto vicino a casa' })
        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ tipo: 'esito_cambiato', scheda_id: S2, scuola_id: SEDE_A, autore: USER, autore_via: 'segreteria' })
        expect(eventi[0].dati).toEqual({ bambino_id: B2, da: 'aperto', a: 'perso' })
        expect(JSON.stringify(eventi)).not.toContain('vicino a casa')
    })

    it('motivo fuori dall’elenco → 400', async () => {
        expect((await cambia(S2, B2, { esito: 'perso', motivoPerdita: 'capriccio' })).status).toBe(400)
    })

    it('esito «iscritto» → esito_origine manuale, esito_da e esito_il; evento esito_cambiato', async () => {
        const res = await cambia(S2, B2, { esito: 'iscritto' })
        expect(res.status).toBe(200)
        const r = riga(B2)
        expect(r).toMatchObject({ esito: 'iscritto', esito_origine: 'manuale', esito_da: USER })
        expect(typeof r.esito_il).toBe('string')
        expect(Number.isNaN(Date.parse(r.esito_il as string))).toBe(false)
        expect(eventiScritti()[0]).toMatchObject({ tipo: 'esito_cambiato' })
        expect(eventiScritti()[0].dati).toEqual({ bambino_id: B2, da: 'aperto', a: 'iscritto' })
    })

    it('uscire da «perso» svuota motivo e nota: non restano a descrivere un esito che non c’è più', async () => {
        const res = await cambia(S1, B1B, { esito: 'ci_pensa' })
        expect(res.status).toBe(200)
        expect(riga(B1B)).toMatchObject({ esito: 'ci_pensa', motivo_perdita: null, motivo_nota: null })
    })

    it('un bambino già «perso» si può correggere nel motivo, senza rimandare l’esito', async () => {
        const res = await cambia(S1, B1B, { motivoPerdita: 'orari' })
        expect(res.status).toBe(200)
        expect(riga(B1B)).toMatchObject({ esito: 'perso', motivo_perdita: 'orari' })
        expect(eventiScritti()[0]).toMatchObject({ tipo: 'bambino_modificato' })
        expect(eventiScritti()[0].dati).toEqual({ bambino_id: B1B, campi: 'motivo_perdita' })
    })

    it('un motivo di perdita su un bambino che non è «perso» → 409 STATO_NON_AMMESSO, non un dato incoerente', async () => {
        const res = await cambia(S2, B2, { motivoPerdita: 'prezzo' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
        expect(riga(B2).motivo_perdita).toBeNull()
    })

    it('quota saldata: data scelta o, in mancanza, oggi a Roma; chi l’ha segnata; evento quota_segnata', async () => {
        const res = await cambia(S1, B1A, { quotaSaldata: true, quotaSaldataIl: '2026-10-20' })
        expect(res.status).toBe(200)
        expect(riga(B1A)).toMatchObject({ quota_saldata: true, quota_saldata_il: '2026-10-20', quota_segnata_da: USER })
        expect(eventiScritti()[0]).toMatchObject({ tipo: 'quota_segnata' })
        expect(eventiScritti()[0].dati).toEqual({ bambino_id: B1A, saldata: true })

        h.scritture = []
        await cambia(S3, B3, { quotaSaldata: true })
        expect(riga(B3).quota_saldata_il).toMatch(/^\d{4}-\d{2}-\d{2}$/)

        h.scritture = []
        await cambia(S1, B1A, { quotaSaldata: false })
        expect(riga(B1A)).toMatchObject({ quota_saldata: false, quota_saldata_il: null })
        expect(eventiScritti()[0].dati).toEqual({ bambino_id: B1A, saldata: false })
    })

    it('nome, data di nascita e anno: evento «bambino_modificato» con i soli nomi dei campi', async () => {
        const res = await cambia(S2, B2, { nome: 'Bimbo Prova Corretto', annoIngresso: 'in_corso' })
        expect(res.status).toBe(200)
        expect(riga(B2)).toMatchObject({ nome: 'Bimbo Prova Corretto', anno_ingresso: 'in_corso' })
        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0].dati).toEqual({ bambino_id: B2, campi: 'nome,anno_ingresso' })
        expect(JSON.stringify(eventi)).not.toContain('Corretto')
    })

    it('più cose insieme: un evento per ciascuna (esito, quota, modifica)', async () => {
        await cambia(S2, B2, { esito: 'iscritto', quotaSaldata: true, nome: 'Bimbo Prova Rinominato' })
        expect(eventiScritti().map((e) => e.tipo).sort()).toEqual(['bambino_modificato', 'esito_cambiato', 'quota_segnata'])
    })

    it('l’update porta scuola_id e scheda_id: la riga gemella di un’altra sede non si tocca', async () => {
        h.db.crm_bambini.push(bambino(B2, S2, SEDE_B, { nome: 'Bimbo Prova Gemello' }))
        await cambia(S2, B2, { nome: 'Bimbo Prova Nuovo' })
        expect(riga(B2, SEDE_A).nome).toBe('Bimbo Prova Nuovo')
        expect(riga(B2, SEDE_B).nome).toBe('Bimbo Prova Gemello')
        const upd = scritto('crm_bambini', 'update')
        expect(upd).toHaveLength(1)
        expect(upd[0].colpite).toHaveLength(1)
    })

    it('qualcun altro ha cambiato l’esito fra la lettura e il salvataggio → 409 STATO_NON_AMMESSO, nessun evento', async () => {
        h.prima = (tabella, metodo) => {
            if (tabella === 'crm_bambini' && metodo === 'update') {
                // il collegamento automatico alla domanda, che arriva proprio ora
                riga(B2).esito = 'iscritto'
                h.prima = null
            }
        }
        const res = await cambia(S2, B2, { esito: 'perso', motivoPerdita: 'prezzo' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
        expect(riga(B2)).toMatchObject({ esito: 'iscritto', motivo_perdita: null })
        expect(eventiScritti()).toHaveLength(0)
    })

    it('un bambino che non è di quella scheda → 404, e nemmeno una scrittura', async () => {
        const res = await cambia(S1, B2, { nome: 'x' })
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
        expect(h.scritture).toHaveLength(0)
    })

    it('scheda di un’altra sede → 403', async () => {
        expect((await cambia(SB, BB, { nome: 'x' })).status).toBe(403)
        expect(h.scritture).toHaveLength(0)
    })

    it('corpo vuoto → 400; nulla di cambiato → 200 senza scrivere', async () => {
        expect((await cambia(S2, B2, {})).status).toBe(400)
        const res = await cambia(S2, B2, { nome: 'Bimbo Prova Due', esito: 'aperto' })
        expect(res.status).toBe(200)
        expect(h.scritture).toHaveLength(0)
    })

    it('guasto dell’update → 500 e nessun evento', async () => {
        h.errori = { 'crm_bambini:update': { code: 'XX000' } }
        expect((await cambia(S2, B2, { nome: 'x' })).status).toBe(500)
        expect(eventiScritti()).toHaveLength(0)
    })
})

// ── POST /schede/[id]/eventi ─────────────────────────────────────────────────

describe('POST /schede/[id]/eventi', () => {
    const scrivi = (id: string, corpo: unknown) => POST_EVENTO(richiesta('POST', `/api/admin/crm/schede/${id}/eventi`, corpo), conId(id))
    const SEGRETO = 'La nonna Prova ritira il bambino il martedì'

    it('una nota entra nello storico con il suo testo; il log non lo contiene', async () => {
        const res = await scrivi(S1, { tipo: 'nota', testo: SEGRETO })
        expect(res.status).toBe(201)
        const eventi = eventiScritti()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            tipo: 'nota',
            scheda_id: S1,
            scuola_id: SEDE_A,
            autore: USER,
            autore_via: 'segreteria',
            testo: SEGRETO,
        })
        const loggato = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls])
        expect(loggato).not.toContain('nonna')
        expect(loggato).not.toContain(SEGRETO)
    })

    it('anche la telefonata; e il testo si ripulisce ai lati', async () => {
        const res = await scrivi(S1, { tipo: 'telefonata', testo: '  Ha richiamato.  ' })
        expect(res.status).toBe(201)
        expect(eventiScritti()[0]).toMatchObject({ tipo: 'telefonata', testo: 'Ha richiamato.' })
    })

    it('gli altri tipi di evento non si scrivono a mano → 400', async () => {
        for (const tipo of ['creata', 'esito_cambiato', 'appuntamento_fissato', 'azione_fatta']) {
            expect((await scrivi(S1, { tipo, testo: 'x' })).status).toBe(400)
        }
        expect(h.scritture).toHaveLength(0)
    })

    it('testo vuoto, di soli spazi, o oltre 2000 caratteri → 400', async () => {
        expect((await scrivi(S1, { tipo: 'nota', testo: '' })).status).toBe(400)
        expect((await scrivi(S1, { tipo: 'nota', testo: '   ' })).status).toBe(400)
        expect((await scrivi(S1, { tipo: 'nota', testo: 'a'.repeat(2001) })).status).toBe(400)
        expect((await scrivi(S1, { tipo: 'nota', testo: 'a'.repeat(2000) })).status).toBe(201)
    })

    it('scheda di un’altra sede → 403 e niente scritto', async () => {
        expect((await scrivi(SB, { tipo: 'nota', testo: 'x' })).status).toBe(403)
        expect(h.scritture).toHaveLength(0)
    })

    it('se lo storico non si scrive, questa volta è un errore: la nota È il gesto → 500', async () => {
        h.errori = { 'crm_eventi:insert': { code: 'XX000' } }
        const res = await scrivi(S1, { tipo: 'nota', testo: 'x' })
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    })
})
