import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataCivile } from '@/i18n/config'
import { addGiorni } from '@/lib/format/data'
import { istanteCivile, oraCivile } from '@/lib/format/confini-giorno'

/**
 * CRM della segreteria · le route dei follow-up (`/api/admin/crm/azioni`, `…/azioni/[id]`).
 *
 * Il database è il finto che APPLICA i filtri e ESEGUE le scritture: un `update` senza
 * `.is('fatta_il', null)` qui cambierebbe davvero una riga già fatta, e un elenco senza
 * `.in('scuola_id')` qui restituirebbe davvero le righe dell'altra sede. Sono finti soltanto il gate di
 * ruolo e le sedi attive del cookie; `assertSchedaInScope`, `assertPersonaInScope`, `restringiSedi`,
 * `prossimaAzione` e `pianificaAzione` sono quelli VERI.
 *
 * ⚠️ L'orologio NON si congela: i giorni si calcolano a partire da `dataCivile()` (il giorno di Roma di
 * adesso), così il test non scade e non dipende dall'ora in cui gira. I due confronti che distinguono Roma
 * da UTC (le 23:30 di oggi dentro, le 00:30 di domani fuori) valgono a qualunque ora, perché il confine è
 * un GIORNO scritto in cifre, non un istante.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string }>,
    scritture: [] as unknown[],
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
        creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] }),
}))

import { GET, POST } from '@/app/api/admin/crm/azioni/route'
import { PATCH } from '@/app/api/admin/crm/azioni/[id]/route'

const SEG_1 = '20000000-0000-4000-8000-000000000001'
const SEG_2 = '20000000-0000-4000-8000-000000000002'
const SEG_ALTRA_SEDE = '20000000-0000-4000-8000-000000000003'
const DOCENTE = '20000000-0000-4000-8000-000000000004'
const DIREZIONE = '20000000-0000-4000-8000-000000000005'

const SCHEDA = '40000000-0000-4000-8000-000000000001'
const ALTRA_SCHEDA = '40000000-0000-4000-8000-000000000002'
const SCHEDA_ALTRA_SEDE = '40000000-0000-4000-8000-0000000000bb'

const AZ_1 = '50000000-0000-4000-8000-000000000001'
const AZ_2 = '50000000-0000-4000-8000-000000000002'
const AZ_3 = '50000000-0000-4000-8000-000000000003'
const AZ_ALTRA_SEDE = '50000000-0000-4000-8000-0000000000bb'

let oggi = ''
const giorno = (n: number) => addGiorni(oggi, n)
/** L'istante (ISO) delle `ora` di Roma del giorno `n` rispetto a oggi. */
const alle = (n: number, ora = '10:30') => istanteCivile(giorno(n), ora) as string

function azione(id: string, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        scheda_id: SCHEDA,
        tipo: 'follow_up_1',
        scadenza: alle(0),
        responsabile: SEG_1,
        appuntamento_id: null,
        esito: null,
        fatta_da: null,
        fatta_il: null,
        cancellata_il: null,
        cancellata_da: null,
        creata_il: '2026-10-01T08:00:00.000Z',
        ...over,
    }
}

function bambino(id: string, esito: string, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        scheda_id: SCHEDA,
        nome: 'Bambino Prova',
        esito,
        motivo_perdita: null,
        motivo_nota: null,
        esito_origine: null,
        esito_da: null,
        esito_il: null,
        ...over,
    }
}

const get = (q = '') => GET(new NextRequest(`http://localhost/api/admin/crm/azioni${q}`))
const post = (corpo: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/crm/azioni', {
            method: 'POST',
            body: JSON.stringify(corpo),
            headers: { 'content-type': 'application/json' },
        }),
    )
const patch = (id: string, corpo: unknown) =>
    PATCH(
        new NextRequest(`http://localhost/api/admin/crm/azioni/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(corpo),
            headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ id }) },
    )

const righe = (tabella: string): Riga[] => h.db[tabella] ?? []
const scritturePer = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const eventi = (tipo: string) => righe('crm_eventi').filter((e) => e.tipo === tipo)

beforeEach(() => {
    oggi = dataCivile()
    h.ruolo = 'segreteria'
    h.utente = SEG_1
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.db = {
        utenti: [
            { id: SEG_1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: SEG_2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: SEG_ALTRA_SEDE, nome: 'Carla', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
            { id: DOCENTE, nome: 'Dora', cognome: 'Prova', ruolo: 'educator', scuola_id: SEDE_A, archiviato_il: null },
            { id: DIREZIONE, nome: 'Dario', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_A, archiviato_il: null },
        ],
        utenti_scuole: [],
        crm_schede: [
            { id: SCHEDA, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova', telefono1: '333 000 0001' },
            { id: ALTRA_SCHEDA, scuola_id: SEDE_A, genitore_nome: 'Famiglia Seconda', telefono1: '333 000 0002' },
            { id: SCHEDA_ALTRA_SEDE, scuola_id: SEDE_B, genitore_nome: 'Famiglia Altrove', telefono1: '333 000 0003' },
        ],
        crm_bambini: [],
        crm_azioni: [],
        crm_eventi: [],
    }
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/crm/azioni', () => {
    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await get(`?scuolaId=${SEDE_A}`)).status).toBe(403)
    })

    it('senza scuolaId → 400: la sede si dichiara, non si indovina', async () => {
        expect((await get()).status).toBe(400)
    })

    it('finoA che non esiste sul calendario → 400', async () => {
        expect((await get(`?scuolaId=${SEDE_A}&finoA=2026-02-30`)).status).toBe(400)
    })

    it('un’altra sede → 403 SEDE_NON_ACCESSIBILE', async () => {
        h.db.crm_azioni = [azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE })]
        const res = await get(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('GET mette prima le scadute e porta .in(scuola_id): le righe dell’altra sede non escono', async () => {
        // Inserite in ordine SBAGLIATO apposta: l'ordine in uscita lo deve fare la route.
        h.db.crm_azioni = [
            azione(AZ_3, { scadenza: alle(0, '23:30'), scheda_id: ALTRA_SCHEDA }),
            azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE, scadenza: alle(-5) }),
            azione(AZ_2, { scadenza: alle(-1) }),
            azione(AZ_1, { scadenza: alle(-3) }),
        ]
        const res = await get(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(200)
        const { data } = await res.json()
        expect(data.map((a: Riga) => a.id)).toEqual([AZ_1, AZ_2, AZ_3])
        expect(data.map((a: Riga) => a.in_ritardo)).toEqual([true, true, false])
    })

    it('ogni azione porta la sua scheda { id, genitore_nome, telefono1 }, e niente di più', async () => {
        h.db.crm_azioni = [azione(AZ_1), azione(AZ_2, { scheda_id: ALTRA_SCHEDA })]
        h.db.crm_schede = [
            ...h.db.crm_schede,
            // un dato che la lista NON deve esporre: i recapiti secondari e le tre domande del manuale
            { id: SCHEDA, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova', telefono1: '333 000 0001', paura: 'testo libero' },
        ]
        const { data } = await (await get(`?scuolaId=${SEDE_A}`)).json()
        const uno = data.find((a: Riga) => a.id === AZ_1)
        expect(uno.scheda.id).toBe(SCHEDA)
        expect(uno.scheda.genitore_nome).toBe('Famiglia Prova')
        expect(uno.scheda.telefono1).toBe('333 000 0001')
        expect(Object.keys(uno.scheda).sort()).toEqual(['genitore_nome', 'id', 'telefono1'])
        expect(data.find((a: Riga) => a.id === AZ_2).scheda.genitore_nome).toBe('Famiglia Seconda')
    })

    it('il «fino a oggi» è il giorno di ROMA: le 23:30 di oggi ci sono, le 00:30 di domani no', async () => {
        h.db.crm_azioni = [
            azione(AZ_1, { scadenza: alle(0, '23:30') }),
            // 00:30 di domani a Roma = 22:30/23:30 UTC di OGGI: un confine in UTC la farebbe entrare.
            azione(AZ_2, { scadenza: alle(1, '00:30') }),
            azione(AZ_3, { scadenza: alle(1) }),
        ]
        const { data } = await (await get(`?scuolaId=${SEDE_A}`)).json()
        expect(data.map((a: Riga) => a.id)).toEqual([AZ_1])
    })

    it('«in ritardo» è un giorno civile passato: la scadenza di stamattina alle 00:05 non lo è', async () => {
        h.db.crm_azioni = [
            azione(AZ_1, { scadenza: alle(0, '00:05') }),
            azione(AZ_2, { scadenza: alle(-1, '23:55') }),
        ]
        const { data } = await (await get(`?scuolaId=${SEDE_A}`)).json()
        const perId = Object.fromEntries(data.map((a: Riga) => [a.id, a.in_ritardo]))
        expect(perId[AZ_1]).toBe(false)
        expect(perId[AZ_2]).toBe(true)
    })

    it('finoA allarga la finestra, ma il ritardo resta quello di oggi', async () => {
        h.db.crm_azioni = [azione(AZ_1, { scadenza: alle(1, '00:30') }), azione(AZ_2, { scadenza: alle(2) })]
        const { data } = await (await get(`?scuolaId=${SEDE_A}&finoA=${giorno(1)}`)).json()
        expect(data.map((a: Riga) => a.id)).toEqual([AZ_1])
        expect(data[0].in_ritardo).toBe(false)
    })

    it('le fatte e le cancellate non sono «da richiamare»', async () => {
        h.db.crm_azioni = [
            azione(AZ_1, { fatta_il: alle(-1), esito: 'ci_pensa' }),
            azione(AZ_2, { cancellata_il: alle(-1) }),
            azione(AZ_3),
        ]
        const { data } = await (await get(`?scuolaId=${SEDE_A}`)).json()
        expect(data.map((a: Riga) => a.id)).toEqual([AZ_3])
    })

    it('il filtro per responsabile', async () => {
        h.db.crm_azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
        const { data } = await (await get(`?scuolaId=${SEDE_A}&responsabile=${SEG_2}`)).json()
        expect(data.map((a: Riga) => a.id)).toEqual([AZ_2])
    })

    it('una scheda anonimizzata o sparita non rompe l’elenco', async () => {
        h.db.crm_azioni = [azione(AZ_1, { scheda_id: '40000000-0000-4000-8000-0000000000ff' })]
        const res = await get(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(200)
        const { data } = await res.json()
        expect(data[0].scheda).toEqual({ id: '40000000-0000-4000-8000-0000000000ff', genitore_nome: null, telefono1: null })
    })

    it('un guasto del database → 500; le tabelle assenti → 503 CRM_NON_INSTALLATO', async () => {
        h.errori = { crm_azioni: { code: '08006' } }
        expect((await get(`?scuolaId=${SEDE_A}`)).status).toBe(500)
        h.errori = { crm_azioni: { code: 'PGRST205' } }
        const res = await get(`?scuolaId=${SEDE_A}`)
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/crm/azioni', () => {
    const corpo = (over: Riga = {}) => ({ schedaId: SCHEDA, giorno: giorno(2), responsabile: SEG_2, ...over })

    it('docente → 403, e non si scrive niente', async () => {
        h.ruolo = 'educator'
        expect((await post(corpo())).status).toBe(403)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('crea un «richiamare» a mano alle 10:30 di Roma del giorno scelto, con la voce nello storico', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(201)
        const { data } = await res.json()
        const riga = righe('crm_azioni').find((a) => a.id === data.id) as Riga
        expect(riga).toMatchObject({ scuola_id: SEDE_A, scheda_id: SCHEDA, tipo: 'richiamare', responsabile: SEG_2 })
        expect(riga.scadenza).toBe(alle(2))
        expect(oraCivile(riga.scadenza as string)).toBe('10:30')
        expect(eventi('azione_pianificata')).toHaveLength(1)
        expect(eventi('azione_pianificata')[0]).toMatchObject({ scheda_id: SCHEDA, scuola_id: SEDE_A, autore: SEG_1 })
    })

    it('responsabile di un’altra sede → 422 PERSONA_NON_DELLA_SEDE, nessuna scrittura', async () => {
        const res = await post(corpo({ responsabile: SEG_ALTRA_SEDE }))
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('PERSONA_NON_DELLA_SEDE')
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('responsabile che non è segreteria → 422', async () => {
        expect((await post(corpo({ responsabile: DOCENTE }))).status).toBe(422)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('scheda di un’altra sede → 403 SEDE_NON_ACCESSIBILE, nessuna scrittura', async () => {
        const res = await post(corpo({ schedaId: SCHEDA_ALTRA_SEDE }))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('scheda inesistente → 404 SCHEDA_NON_TROVATA', async () => {
        const res = await post(corpo({ schedaId: '40000000-0000-4000-8000-0000000000ee' }))
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
    })

    it('corpo incompleto, giorno che non esiste, campi in più → 400', async () => {
        expect((await post({ schedaId: SCHEDA, giorno: giorno(1) })).status).toBe(400)
        expect((await post(corpo({ giorno: '2026-02-30' }))).status).toBe(400)
        // `ora` non è ammessa: `pianificaAzione` la scadenza la fissa sempre alle 10:30, e ignorare in
        // silenzio un campo ricevuto è peggio di rifiutarlo.
        expect((await post(corpo({ ora: '16:00' }))).status).toBe(400)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('inserimento fallito → 500, mai un finto 201', async () => {
        h.errori = { 'crm_azioni:insert': { code: '08006' } }
        const res = await post(corpo())
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/crm/azioni/[id] · fatta', () => {
    const fatta = (id: string, esito: string, extra: Riga = {}) => patch(id, { azione: 'fatta', esito, ...extra })
    const apertePer = (tipo: string) => // il finto non applica i DEFAULT del database: una riga appena inserita non ha `fatta_il` (nel DB vero è NULL)
        righe('crm_azioni').filter((a) => a.tipo === tipo && a.fatta_il == null)

    beforeEach(() => {
        h.db.crm_azioni = [azione(AZ_1)]
    })

    it('docente → 403, e la riga resta aperta', async () => {
        h.ruolo = 'educator'
        expect((await fatta(AZ_1, 'ci_pensa')).status).toBe(403)
        expect(righe('crm_azioni')[0].fatta_il).toBeNull()
    })

    it('fatta follow_up_1 ci_pensa → nasce follow_up_2 fra 3 giorni alle 10:30 di Roma', async () => {
        const res = await fatta(AZ_1, 'ci_pensa')
        expect(res.status).toBe(200)
        const { data } = await res.json()

        const fattaRiga = righe('crm_azioni').find((a) => a.id === AZ_1) as Riga
        expect(fattaRiga).toMatchObject({ esito: 'ci_pensa', fatta_da: SEG_1 })
        expect(typeof fattaRiga.fatta_il).toBe('string')

        const nuove = apertePer('follow_up_2')
        expect(nuove).toHaveLength(1)
        expect(nuove[0]).toMatchObject({ scuola_id: SEDE_A, scheda_id: SCHEDA, responsabile: SEG_1 })
        expect(nuove[0].scadenza).toBe(alle(3))
        expect(oraCivile(nuove[0].scadenza as string)).toBe('10:30')

        // La route racconta al client COSA è nato, perché «Follow-up 2 · martedì 10:30» si mostra da qui.
        expect(data.prossima).toMatchObject({ id: nuove[0].id, tipo: 'follow_up_2', giorno: giorno(3), scadenza: alle(3), responsabile: SEG_1 })
        expect(data.avvisi).toEqual([])
    })

    it('fatta follow_up_1 non_risponde → riprova_1 domani', async () => {
        await fatta(AZ_1, 'non_risponde')
        const nuove = apertePer('riprova_1')
        expect(nuove).toHaveLength(1)
        expect(nuove[0].scadenza).toBe(alle(1))
    })

    it('il responsabile del passo nuovo è quello del passo fatto, non chi ha premuto', async () => {
        h.utente = SEG_2
        await fatta(AZ_1, 'ci_pensa')
        expect(apertePer('follow_up_2')[0].responsabile).toBe(SEG_1)
        expect(righe('crm_azioni').find((a) => a.id === AZ_1)?.fatta_da).toBe(SEG_2)
    })

    it('fatta ultimatum → nessuna azione nuova', async () => {
        h.db.crm_azioni = [azione(AZ_1, { tipo: 'ultimatum' })]
        const res = await fatta(AZ_1, 'non_risponde')
        expect(res.status).toBe(200)
        expect((await res.json()).data.prossima).toBeNull()
        expect(righe('crm_azioni')).toHaveLength(1)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('vuole_iscriversi chiude la catena e non tocca i bambini', async () => {
        h.db.crm_bambini = [bambino('b1', 'aperto'), bambino('b2', 'ci_pensa')]
        const res = await fatta(AZ_1, 'vuole_iscriversi')
        expect(res.status).toBe(200)
        expect((await res.json()).data.prossima).toBeNull()
        expect(righe('crm_azioni')).toHaveLength(1)
        expect(righe('crm_bambini').map((b) => b.esito)).toEqual(['aperto', 'ci_pensa'])
        expect(scritturePer('crm_bambini', 'update')).toHaveLength(0)
    })

    it('fatta due volte INSIEME → la seconda 409 GIA_FATTA, una sola azione nuova', async () => {
        const [a, b] = await Promise.all([fatta(AZ_1, 'ci_pensa'), fatta(AZ_1, 'ci_pensa')])
        expect([a.status, b.status].sort()).toEqual([200, 409])
        const respinta = a.status === 409 ? a : b
        expect((await respinta.json()).codice).toBe('GIA_FATTA')
        expect(apertePer('follow_up_2')).toHaveLength(1)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(1)
        expect(eventi('azione_fatta')).toHaveLength(1)
        expect(eventi('azione_pianificata')).toHaveLength(1)
    })

    it('fatta due volte una dopo l’altra → 409 GIA_FATTA, e il passo non si ripianifica', async () => {
        expect((await fatta(AZ_1, 'ci_pensa')).status).toBe(200)
        const seconda = await fatta(AZ_1, 'ci_pensa')
        expect(seconda.status).toBe(409)
        expect((await seconda.json()).codice).toBe('GIA_FATTA')
        expect(apertePer('follow_up_2')).toHaveLength(1)
    })

    it('fatta da due colleghe insieme, con esiti diversi → vince una sola, l’altra 409', async () => {
        h.utente = SEG_1
        const prima = fatta(AZ_1, 'ci_pensa')
        const seconda = fatta(AZ_1, 'non_risponde')
        const [a, b] = await Promise.all([prima, seconda])
        expect([a.status, b.status].sort()).toEqual([200, 409])
        expect(righe('crm_azioni').filter((x) => x.id !== AZ_1)).toHaveLength(1)
    })

    it('un’azione cancellata non si segna fatta → 409 STATO_NON_AMMESSO', async () => {
        h.db.crm_azioni = [azione(AZ_1, { cancellata_il: alle(-1), cancellata_da: SEG_2 })]
        const res = await fatta(AZ_1, 'ci_pensa')
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
        expect(righe('crm_azioni')[0].fatta_il).toBeNull()
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('scrive «azione_fatta» con tipo ed esito, e nient’altro che id ed enumerazioni', async () => {
        await fatta(AZ_1, 'non_risponde')
        const ev = eventi('azione_fatta')
        expect(ev).toHaveLength(1)
        expect(ev[0]).toMatchObject({ scheda_id: SCHEDA, scuola_id: SEDE_A, autore: SEG_1, autore_via: 'segreteria' })
        expect(ev[0].dati).toEqual({ azione_id: AZ_1, tipo: 'follow_up_1', esito: 'non_risponde' })
        expect(ev[0].testo ?? null).toBeNull()
    })

    it('non_interessato senza motivo → 422 MOTIVO_OBBLIGATORIO, e la riga resta aperta', async () => {
        h.db.crm_bambini = [bambino('b1', 'aperto')]
        const res = await fatta(AZ_1, 'non_interessato')
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(righe('crm_azioni')[0].fatta_il).toBeNull()
        expect(righe('crm_bambini')[0].esito).toBe('aperto')
        expect(scritturePer('crm_azioni', 'update')).toHaveLength(0)
    })

    it('non_interessato con motivo → i bambini aperti, “ci pensa” e in lista d’attesa passano a perso; iscritti e persi invariati', async () => {
        h.db.crm_bambini = [
            bambino('b-aperto', 'aperto'),
            bambino('b-pensa', 'ci_pensa'),
            bambino('b-lista', 'lista_attesa'),
            bambino('b-iscritto', 'iscritto'),
            bambino('b-perso', 'perso', { motivo_perdita: 'distanza' }),
            // stessa sede ma ALTRA scheda, e altra sede: non si toccano
            bambino('b-altra-scheda', 'aperto', { scheda_id: ALTRA_SCHEDA }),
            bambino('b-altra-sede', 'aperto', { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE }),
        ]
        const res = await fatta(AZ_1, 'non_interessato', { motivoPerdita: 'prezzo', motivoNota: 'Troppo cara' })
        expect(res.status).toBe(200)
        expect((await res.json()).data.prossima).toBeNull()

        const per = Object.fromEntries(righe('crm_bambini').map((b) => [b.id, b]))
        for (const id of ['b-aperto', 'b-pensa', 'b-lista']) {
            expect(per[id]).toMatchObject({ esito: 'perso', motivo_perdita: 'prezzo', motivo_nota: 'Troppo cara', esito_origine: 'manuale', esito_da: SEG_1 })
            expect(typeof per[id].esito_il).toBe('string')
        }
        expect(per['b-iscritto']).toMatchObject({ esito: 'iscritto', motivo_perdita: null })
        expect(per['b-perso']).toMatchObject({ esito: 'perso', motivo_perdita: 'distanza' })
        expect(per['b-altra-scheda'].esito).toBe('aperto')
        expect(per['b-altra-sede'].esito).toBe('aperto')

        // un «esito_cambiato» per ciascun bambino davvero cambiato, e nessuno per gli altri
        const cambi = eventi('esito_cambiato')
        expect(cambi.map((e) => (e.dati as Riga).bambino_id).sort()).toEqual(['b-aperto', 'b-lista', 'b-pensa'])
        expect(cambi.find((e) => (e.dati as Riga).bambino_id === 'b-pensa')?.dati).toMatchObject({ da: 'ci_pensa', a: 'perso', motivo: 'prezzo' })
        // la catena è chiusa: niente passo nuovo
        expect(righe('crm_azioni')).toHaveLength(1)
    })

    it('ci_pensa porta i bambini aperti a “ci pensa”, e basta', async () => {
        h.db.crm_bambini = [
            bambino('b-aperto', 'aperto'),
            bambino('b-lista', 'lista_attesa'),
            bambino('b-iscritto', 'iscritto'),
            bambino('b-perso', 'perso'),
        ]
        await fatta(AZ_1, 'ci_pensa')
        const per = Object.fromEntries(righe('crm_bambini').map((b) => [b.id, b.esito]))
        expect(per).toEqual({ 'b-aperto': 'ci_pensa', 'b-lista': 'lista_attesa', 'b-iscritto': 'iscritto', 'b-perso': 'perso' })
        expect(eventi('esito_cambiato')).toHaveLength(1)
    })

    it('non_risponde non tocca i bambini', async () => {
        h.db.crm_bambini = [bambino('b-aperto', 'aperto')]
        await fatta(AZ_1, 'non_risponde')
        expect(righe('crm_bambini')[0].esito).toBe('aperto')
        expect(scritturePer('crm_bambini', 'update')).toHaveLength(0)
    })

    it('azione di un’altra sede → 403 SEDE_NON_ACCESSIBILE, e non si scrive niente', async () => {
        h.db.crm_azioni = [azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE })]
        const res = await fatta(AZ_ALTRA_SEDE, 'ci_pensa')
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(righe('crm_azioni')[0].fatta_il).toBeNull()
        expect(scritturePer('crm_azioni', 'update')).toHaveLength(0)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('la Direzione con due sedi segna un’azione della seconda', async () => {
        h.ruolo = 'admin'
        h.utente = DIREZIONE
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [{ utente_id: DIREZIONE, scuola_id: SEDE_A }, { utente_id: DIREZIONE, scuola_id: SEDE_B }]
        h.db.crm_azioni = [azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE, responsabile: SEG_ALTRA_SEDE })]
        const res = await fatta(AZ_ALTRA_SEDE, 'ci_pensa')
        expect(res.status).toBe(200)
        // il passo nuovo nasce NELLA SEDE DELLA SCHEDA, non in quella «primaria» della Direzione
        const nuova = righe('crm_azioni').find((a) => a.tipo === 'follow_up_2') as Riga
        expect(nuova.scuola_id).toBe(SEDE_B)
    })

    it('azione inesistente → 404', async () => {
        const res = await fatta('50000000-0000-4000-8000-0000000000ee', 'ci_pensa')
        expect(res.status).toBe(404)
    })

    it('id che non è un uuid, esito inventato, azione sconosciuta → 400', async () => {
        expect((await fatta('non-un-uuid', 'ci_pensa')).status).toBe(400)
        expect((await fatta(AZ_1, 'forse')).status).toBe(400)
        expect((await patch(AZ_1, { azione: 'archivia' })).status).toBe(400)
        expect((await fatta(AZ_1, 'non_interessato', { motivoPerdita: 'capriccio' })).status).toBe(400)
        expect(righe('crm_azioni')[0].fatta_il).toBeNull()
    })

    it('il passo successivo non nasce → la riga è comunque fatta, e il client lo sa (avviso)', async () => {
        h.errori = { 'crm_azioni:insert': { code: '08006' } }
        const res = await fatta(AZ_1, 'ci_pensa')
        expect(res.status).toBe(200)
        const { data } = await res.json()
        expect(data.prossima).toBeNull()
        expect(data.avvisi).toEqual(['PROSSIMA_NON_PIANIFICATA'])
        expect(righe('crm_azioni')[0].fatta_il).not.toBeNull()
    })

    it('i bambini non si aggiornano → la riga è fatta, il passo nuovo nasce, e il client lo sa (avviso)', async () => {
        h.db.crm_bambini = [bambino('b1', 'aperto')]
        h.errori = { 'crm_bambini:update': { code: '08006' } }
        const res = await fatta(AZ_1, 'ci_pensa')
        expect(res.status).toBe(200)
        const { data } = await res.json()
        expect(data.avvisi).toEqual(['BAMBINI_NON_AGGIORNATI'])
        expect(data.prossima).not.toBeNull()
        expect(righe('crm_bambini')[0].esito).toBe('aperto')
    })

    it('l’aggiornamento della riga fallisce → 500, e nessun passo nuovo', async () => {
        h.errori = { 'crm_azioni:update': { code: '08006' } }
        const res = await fatta(AZ_1, 'ci_pensa')
        expect(res.status).toBe(500)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/crm/azioni/[id] · sposta', () => {
    const sposta = (id: string, extra: Riga) => patch(id, { azione: 'sposta', ...extra })

    beforeEach(() => {
        h.db.crm_azioni = [azione(AZ_1, { scadenza: alle(0, '16:00') })]
    })

    it('sposta al giorno e all’ora indicati (ora di Roma), con l’evento prima/dopo', async () => {
        const res = await sposta(AZ_1, { giorno: giorno(4), ora: '09:15' })
        expect(res.status).toBe(200)
        const riga = righe('crm_azioni')[0]
        expect(riga.scadenza).toBe(alle(4, '09:15'))
        expect(oraCivile(riga.scadenza as string)).toBe('09:15')
        const ev = eventi('azione_spostata')
        expect(ev).toHaveLength(1)
        expect(ev[0].dati).toMatchObject({ azione_id: AZ_1, tipo: 'follow_up_1', da: oggi, a: giorno(4) })
    })

    it('senza ora tiene l’ora che l’azione aveva, non la riporta alle 10:30', async () => {
        await sposta(AZ_1, { giorno: giorno(2) })
        expect(righe('crm_azioni')[0].scadenza).toBe(alle(2, '16:00'))
    })

    it('può passare l’azione a una collega della sede', async () => {
        const res = await sposta(AZ_1, { giorno: giorno(1), responsabile: SEG_2 })
        expect(res.status).toBe(200)
        expect(righe('crm_azioni')[0].responsabile).toBe(SEG_2)
        expect(eventi('azione_spostata')[0].dati).toMatchObject({ responsabile_da: SEG_1, responsabile_a: SEG_2 })
    })

    it('responsabile di un’altra sede → 422, e la riga non si muove', async () => {
        const res = await sposta(AZ_1, { giorno: giorno(1), responsabile: SEG_ALTRA_SEDE })
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('PERSONA_NON_DELLA_SEDE')
        expect(righe('crm_azioni')[0]).toMatchObject({ scadenza: alle(0, '16:00'), responsabile: SEG_1 })
        expect(scritturePer('crm_azioni', 'update')).toHaveLength(0)
    })

    it('un’azione già fatta o cancellata non si sposta → 409 STATO_NON_AMMESSO', async () => {
        h.db.crm_azioni = [azione(AZ_1, { fatta_il: alle(-1), esito: 'ci_pensa' }), azione(AZ_2, { cancellata_il: alle(-1) })]
        for (const id of [AZ_1, AZ_2]) {
            const res = await sposta(id, { giorno: giorno(3) })
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
        }
        expect(scritturePer('crm_azioni', 'update')).toHaveLength(0)
    })

    it('azione di un’altra sede → 403', async () => {
        h.db.crm_azioni = [azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE })]
        const res = await sposta(AZ_ALTRA_SEDE, { giorno: giorno(3) })
        expect(res.status).toBe(403)
        expect(scritturePer('crm_azioni', 'update')).toHaveLength(0)
    })

    it('giorno che non esiste, ora 99:99, campo mancante → 400', async () => {
        expect((await sposta(AZ_1, { giorno: '2026-02-30' })).status).toBe(400)
        expect((await sposta(AZ_1, { giorno: giorno(1), ora: '99:99' })).status).toBe(400)
        expect((await sposta(AZ_1, {})).status).toBe(400)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/crm/azioni/[id] · cancella', () => {
    const cancella = (id: string) => patch(id, { azione: 'cancella' })

    beforeEach(() => {
        h.db.crm_azioni = [azione(AZ_1)]
    })

    it('scrive cancellata_il e cancellata_da, e la voce nello storico', async () => {
        h.utente = SEG_2
        const res = await cancella(AZ_1)
        expect(res.status).toBe(200)
        const riga = righe('crm_azioni')[0]
        expect(typeof riga.cancellata_il).toBe('string')
        expect(riga.cancellata_da).toBe(SEG_2)
        expect(riga.fatta_il).toBeNull()
        expect(eventi('azione_cancellata')[0].dati).toEqual({ azione_id: AZ_1, tipo: 'follow_up_1' })
    })

    it('non crea nessun passo nuovo: cancellare chiude quel ramo della catena', async () => {
        await cancella(AZ_1)
        expect(scritturePer('crm_azioni', 'insert')).toHaveLength(0)
    })

    it('cancellata due volte INSIEME → una passa, l’altra 409', async () => {
        const [a, b] = await Promise.all([cancella(AZ_1), cancella(AZ_1)])
        expect([a.status, b.status].sort()).toEqual([200, 409])
        expect(eventi('azione_cancellata')).toHaveLength(1)
    })

    it('un’azione già fatta non si cancella → 409 STATO_NON_AMMESSO', async () => {
        h.db.crm_azioni = [azione(AZ_1, { fatta_il: alle(-1), esito: 'ci_pensa' })]
        const res = await cancella(AZ_1)
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
        expect(righe('crm_azioni')[0].cancellata_il).toBeNull()
    })

    it('azione di un’altra sede → 403, e la riga resta com’è', async () => {
        h.db.crm_azioni = [azione(AZ_ALTRA_SEDE, { scuola_id: SEDE_B, scheda_id: SCHEDA_ALTRA_SEDE })]
        expect((await cancella(AZ_ALTRA_SEDE)).status).toBe(403)
        expect(righe('crm_azioni')[0].cancellata_il).toBeNull()
    })

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await cancella(AZ_1)).status).toBe(403)
        expect(righe('crm_azioni')[0].cancellata_il).toBeNull()
    })
})
