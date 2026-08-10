import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Riga } from '../fixtures/finto-supabase'

// =============================================================================
// GET /api/admin/anagrafiche/codici-fiscali — il pannello «Codici fiscali da
// verificare».
//
// ⚠️ LA PROPRIETÀ CHE QUESTO FILE ESISTE PER TENERE FERMA È CHE GLI STATI SONO
// TRE, NON DUE. Misurato in produzione il 2026-08-10: 18 alunni su 33 e 27
// genitori su 50 non hanno il codice fiscale, e lo stesso numero non ha il
// comune di nascita; 17 alunni non hanno nemmeno il sesso registrato. Se
// «manca» venisse contato come «sbagliato», questo pannello aprirebbe con 45
// record su 83 in rosso per un dato che nessuno ha mai inserito — e un pannello
// che segnala tutto non segnala niente: si impara a ignorarlo in una settimana,
// e da quel momento non segnala nemmeno le cose vere.
//
// Nessun dato reale qui dentro: il repository è PUBBLICO. I codici fiscali dei
// fixture sono costruiti a tavolino con `calcolaCodiceFiscale` su nomi inventati
// («Collaudo», «Esempio», «Nuovo»), e i tre casi incoerenti sono il codice
// CORRETTO DI UN'ALTRA PERSONA — cioè un codice formalmente valido, checksum
// compresa, che contraddice l'anagrafica su un campo solo. Un codice inventato a
// mano fallirebbe la checksum e proverebbe un'altra cosa.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

const ALU_INCOERENTE = 'a0000001-1111-4111-8111-aaaaaaaaaaaa'
const ALU_SENZA_SESSO = 'a0000002-1111-4111-8111-aaaaaaaaaaaa'
const ALU_SENZA_LUOGO = 'a0000003-1111-4111-8111-aaaaaaaaaaaa'
const ALU_DA_COMPILARE = 'a0000004-1111-4111-8111-aaaaaaaaaaaa'
const ALU_COERENTE = 'a0000005-1111-4111-8111-aaaaaaaaaaaa'
const ALU_LUOGO_AMBIGUO = 'a0000006-1111-4111-8111-aaaaaaaaaaaa'
const ALU_LUOGO_RISOLTO = 'a0000007-1111-4111-8111-aaaaaaaaaaaa'
const ALU_COMUNE_FUSO = 'a0000008-1111-4111-8111-aaaaaaaaaaaa'
const ALU_COMBACIA = 'a0000009-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRA_SEDE = 'b0000001-2222-4222-8222-bbbbbbbbbbbb'
const PAR_IN_SCOPE = 'c0000001-1111-4111-8111-cccccccccccc'
const PAR_ALTRA_SEDE = 'c0000002-2222-4222-8222-dddddddddddd'

/** I codici a tavolino: la persona a cui appartiene DAVVERO ciascuno è nel nome. */
const CF_COLLAUDO_PROVA = 'CLLPRV19C47H501P'
const CF_VERIFICA_PROVA = 'VRFPRV19C47H501J'
const CF_ESEMPIO_TIZIO = 'SMPTZI18E12H501Q'
const CF_SENZASESSO_BIMBO = 'SNZBMB18S03H501L'
const CF_NUOVO_CAIO = 'NVUCAI20A15H501E'
const CF_REGOLARE_SEMPRONIO = 'RGLSPR17P20H501L'
const CF_RISOLTA_COMUNE = 'RSLCMN19L02H501X'
const CF_FITTIZIO_BIMBA = 'FTTBMB19B42H501A'
const CF_GENITORE_ADULTO = 'GNTDLT85D11H501Q'
const CF_DIVERSOCOGNOME_ADULTO = 'DVRDLT85D11H501K'
const CF_GENITOREB_ADULTO = 'GNTDLT86E52H501C'

/**
 * IL COMUNE FUSO — l'unico caso che in produzione gira su OGNI riga.
 *
 * `codice_belfiore_nascita` nasce dalla migrazione `20260810094625`, che dichiara
 * di NON fare backfill («si valorizza quando qualcuno apre la scheda e sceglie il
 * luogo»): al 2026-08-10 quella colonna è quindi NULL su tutte e 83 le righe
 * vere, e il ramo «Belfiore assente dalla colonna, comune scritto a mano» è
 * l'unico che qualcuno eseguirà davvero.
 *
 * Rossano (CS) è stato soppresso nel 2018 nella fusione con Corigliano Calabro:
 * il codice fiscale di chi ci è nato porta `H579` — ed è GIUSTO — mentre
 * `birth_city`, aggiornata al nome nuovo, risolve a `M403`. Se si accusasse col
 * Belfiore indovinato dal testo libero, questa riga uscirebbe `incoerente` su un
 * codice fiscale corretto di una bambina, davanti a una segretaria che poi lo
 * «corregge».
 */
const CF_FUSA_ROSA = 'FSURSO19D48H579V'
/** Lo stesso nome col Belfiore NUOVO: la proposta, che è un suggerimento, non un'accusa. */
const CF_FUSA_ROSA_M403 = 'FSURSO19D48M403B'

/**
 * LA FORMA CHE IL PANNELLO VEDRÀ OGNI GIORNO, e che fino al 2026-08-10 il fixture
 * non conteneva affatto: colonna `codice_belfiore_nascita` NULL (è così su tutte e
 * 83 le righe vere), comune scritto a mano RISOLVIBILE, codice fiscale GIUSTO.
 *
 * È l'unica forma in cui `proposta_combacia` vale `true`, cioè l'unico caso in cui
 * quel campo distingue qualcosa: dentro il blocco a priorità 0 è LUI, e nient'altro,
 * a separare «il codice è giusto, manca solo di scegliere il comune dalla tendina»
 * da «il codice è sbagliato, ecco quello corretto». Senza questa riga il campo si
 * poteva cablare a `false` e la suite restava verde — misurato.
 */
const CF_COMBACIA_UGUALE = 'CMBGLU19E50H501N'

interface CampiEvento {
    [chiave: string]: unknown
}

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    tabelle: [] as string[],
    eventi: [] as { evento: string; livello: string; campi: CampiEvento }[],
    /** Colonna che questo database «non ha»: il finto client risponde 42703 se la si chiede. */
    colonnaAssente: null as string | null,
    /** Errore PostgREST iniettato per tabella (guasto di lettura vero, non degrado di schema). */
    errori: {} as Record<string, { code: string; message: string }>,
    /** tabella → i `.limit(n)` chiesti, nell'ordine: la FINESTRA di ogni lotto. */
    limiti: {} as Record<string, number[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (evento: string, livello: string, campi: CampiEvento, err?: unknown) => {
            h.eventi.push({ evento, livello, campi })
            return vero.logEvento(evento, livello as never, campi as never, err)
        },
    }
})

vi.mock('@/lib/supabase/server-client', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    return {
        createAdminClient: async () => {
            const vero = conSpiaLimiti(creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }), h.limiti)
            return h.colonnaAssente === null ? vero : conColonnaAssente(vero, h.colonnaAssente)
        },
        createClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
    }
})

/**
 * REGISTRA LA FINESTRA CHE OGNI QUERY CHIEDE — cioè l'argomento di `.limit(n)`,
 * tabella per tabella e nell'ordine.
 *
 * Serve perché la lettura dei legami a lotti ha una proprietà che il RISULTATO non
 * mostra: il secondo lotto non deve chiedere di nuovo `LIMITE_SCANSIONE` righe, ma
 * solo lo SPAZIO rimasto nel buffer. Con il cap in memoria (`slice(0, spazio)`) le
 * righe rese sono identiche in entrambi i casi — cambia solo quanto si scarica dal
 * database, e senza questa spia sostituire `.limit(Math.max(spazio, 1))` con
 * `.limit(LIMITE_SCANSIONE)` non produce nessun rosso (misurato).
 */
function conSpiaLimiti<T extends object>(vero: T, spia: Record<string, number[]>): T {
    return new Proxy(vero, {
        get(bersaglio, chiave, ricevitore) {
            if (chiave !== 'from') return Reflect.get(bersaglio, chiave, ricevitore)
            return (tabella: string) => {
                const costruttore = (bersaglio as { from: (t: string) => Record<string, unknown> }).from(tabella)
                const limitVero = costruttore.limit as (n: number, o?: unknown) => unknown
                costruttore.limit = (n: number, opzioni?: unknown) => {
                    if (!spia[tabella]) spia[tabella] = []
                    spia[tabella].push(n)
                    return limitVero.call(costruttore, n, opzioni)
                }
                return costruttore
            }
        },
    })
}

/**
 * Un client che si comporta come un database in cui QUELLA COLONNA NON ESISTE:
 * chiederla dà `42703` col nome nel messaggio, e le righe che restituisce non
 * la portano affatto.
 *
 * Le due metà servono entrambe. L'iniezione d'errore per tabella del finto
 * client (`{ errori: … }`) fallisce OGNI tentativo, compreso il secondo — e il
 * secondo tentativo, senza la colonna, è esattamente ciò che il degrado deve far
 * riuscire: un finto che fallisce sempre non distingue «degrada» da «si arrende».
 * E il finto client non emula la proiezione (le righe tornano INTERE), quindi
 * senza lo spoglio il test vedrebbe il Belfiore arrivare lo stesso e crederebbe
 * a un degrado che non è avvenuto.
 */
function conColonnaAssente<T extends object>(vero: T, mancante: string): T {
    return new Proxy(vero, {
        get(bersaglio, chiave, ricevitore) {
            if (chiave !== 'from') return Reflect.get(bersaglio, chiave, ricevitore)
            return (tabella: string) => {
                const costruttore = (bersaglio as { from: (t: string) => Record<string, unknown> }).from(tabella)
                const selectVero = costruttore.select as (c?: string, o?: unknown) => unknown
                costruttore.select = (colonne?: string, opzioni?: unknown) => {
                    if (typeof colonne === 'string' && colonne.includes(mancante)) {
                        return catenaConErrore({
                            code: '42703',
                            message: `column ${tabella}.${mancante} does not exist`,
                        })
                    }
                    return senzaColonna(selectVero.call(costruttore, colonne, opzioni), mancante)
                }
                return costruttore
            }
        },
    })
}

/** La catena del finto client, con la colonna tolta da ogni riga che ne esce. */
function senzaColonna(costruttore: unknown, mancante: string): unknown {
    const bersaglio = costruttore as Record<string | symbol, unknown>
    const involucro: unknown = new Proxy(bersaglio, {
        get(t, chiave) {
            if (chiave === 'then') {
                return (risolvi: (v: unknown) => unknown, rifiuta?: (e: unknown) => unknown) =>
                    Promise.resolve(t as unknown as PromiseLike<unknown>)
                        .then((esito) => {
                            const r = esito as { data?: unknown }
                            if (!r || !Array.isArray(r.data)) return esito
                            return {
                                ...r,
                                data: (r.data as Riga[]).map((riga) => {
                                    const copia = { ...riga }
                                    delete copia[mancante]
                                    return copia
                                }),
                            }
                        })
                        .then(risolvi, rifiuta)
            }
            const valore = t[chiave]
            if (typeof valore !== 'function') return valore
            return (...argomenti: unknown[]) => {
                const uscita = (valore as (...a: unknown[]) => unknown).apply(t, argomenti)
                return uscita === t ? involucro : uscita
            }
        },
    })
    return involucro
}

/** Una catena PostgREST che accetta qualunque filtro e si risolve nell'errore dato. */
function catenaConErrore(errore: { code: string; message: string }): unknown {
    const risposta = { data: null, error: { details: null, hint: null, ...errore }, count: null }
    const catena: unknown = new Proxy(
        {},
        {
            get(_bersaglio, chiave) {
                if (chiave === 'then') {
                    return (risolvi: (v: unknown) => unknown, rifiuta?: (e: unknown) => unknown) =>
                        Promise.resolve(risposta).then(risolvi, rifiuta)
                }
                return () => catena
            },
        },
    )
    return catena
}

import { GET } from '@/app/api/admin/anagrafiche/codici-fiscali/route'

const req = (query = '') => new NextRequest(`http://localhost/api/admin/anagrafiche/codici-fiscali${query}`)

interface RigaVerifica {
    tipo: 'alunno' | 'genitore'
    id: string
    nome: string | null
    cognome: string | null
    scuole_ids: string[]
    stato: 'incoerente' | 'non-verificabile' | 'da-compilare'
    codice_attuale: string | null
    motivi: string[]
    non_verificabili: string[]
    codice_belfiore: string | null
    luogo_esito: 'belfiore' | 'risolto' | 'ambiguo' | 'sconosciuto' | 'assente'
    luogo_candidati: { belfiore: string; nome: string; sigla: string }[]
    codice_proposto: string | null
    proposta_bloccata_da: 'luogo' | 'anagrafica' | null
    proposta_combacia: boolean
    priorita: number
}

interface Corpo {
    righe: RigaVerifica[]
    totale: number
    scansionati: number
    troncato: boolean
}

const dbBase = (): DBFinto => ({
    utenti_scuole: [],
    alunni: [
        {
            id: ALU_INCOERENTE, scuola_id: SEDE_A, nome: 'Prova', cognome: 'Collaudo',
            gender: 'F', data_nascita: '2019-03-07', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            // Il codice di «Verifica Prova»: valido, checksum compresa, cognome diverso.
            codice_fiscale: CF_VERIFICA_PROVA,
        },
        {
            id: ALU_SENZA_SESSO, scuola_id: SEDE_A, nome: 'Bimbo', cognome: 'Senzasesso',
            gender: null, data_nascita: '2018-11-03', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            codice_fiscale: CF_SENZASESSO_BIMBO,
        },
        {
            id: ALU_SENZA_LUOGO, scuola_id: SEDE_A, nome: 'Tizio', cognome: 'Esempio',
            gender: null, data_nascita: '2018-05-12', codice_belfiore_nascita: null,
            birth_city: null, birth_province: null,
            codice_fiscale: CF_ESEMPIO_TIZIO,
        },
        {
            id: ALU_DA_COMPILARE, scuola_id: SEDE_A, nome: 'Caio', cognome: 'Nuovo',
            gender: 'M', data_nascita: '2020-01-15', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            // `character(16)` impagina con spazi: un codice ASSENTE torna così.
            codice_fiscale: '                ',
        },
        {
            id: ALU_COERENTE, scuola_id: SEDE_A, nome: 'Sempronio', cognome: 'Regolare',
            gender: 'M', data_nascita: '2017-09-20', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            codice_fiscale: CF_REGOLARE_SEMPRONIO,
        },
        {
            id: ALU_LUOGO_AMBIGUO, scuola_id: SEDE_A, nome: 'Luogo', cognome: 'Ambigua',
            gender: 'F', data_nascita: '2019-06-01', codice_belfiore_nascita: null,
            // «Calliano» esiste ad Asti e a Trento, con due Belfiore diversi.
            birth_city: 'Calliano', birth_province: null,
            codice_fiscale: null,
        },
        {
            id: ALU_LUOGO_RISOLTO, scuola_id: SEDE_A, nome: 'Comune', cognome: 'Risolta',
            gender: 'M', data_nascita: '2019-07-02', codice_belfiore_nascita: null,
            birth_city: 'Roma', birth_province: 'RM',
            codice_fiscale: null,
        },
        {
            // Colonna NULL (com'è in produzione su ogni riga) + comune RINOMINATO:
            // il codice porta il Belfiore vecchio, il testo libero il nuovo.
            id: ALU_COMUNE_FUSO, scuola_id: SEDE_A, nome: 'Rosa', cognome: 'Fusa',
            gender: 'F', data_nascita: '2019-04-08', codice_belfiore_nascita: null,
            birth_city: 'Corigliano-Rossano', birth_province: 'CS',
            codice_fiscale: CF_FUSA_ROSA,
        },
        {
            // Colonna NULL + comune risolvibile + codice GIUSTO: la forma che in
            // produzione ha ogni riga a cui non manca niente. Esce
            // `non-verificabile` (il luogo non si può confrontare) con una
            // proposta che COMBACIA col codice registrato.
            id: ALU_COMBACIA, scuola_id: SEDE_A, nome: 'Uguale', cognome: 'Combacia',
            gender: 'F', data_nascita: '2019-05-10', codice_belfiore_nascita: null,
            birth_city: 'Roma', birth_province: 'RM',
            codice_fiscale: CF_COMBACIA_UGUALE,
        },
        {
            id: ALU_ALTRA_SEDE, scuola_id: SEDE_B, nome: 'Bimbo', cognome: 'Altrasede',
            gender: 'M', data_nascita: '2019-02-02', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            codice_fiscale: CF_FITTIZIO_BIMBA,
        },
    ],
    student_parents: [
        { student_id: ALU_INCOERENTE, parent_id: PAR_IN_SCOPE },
        { student_id: ALU_ALTRA_SEDE, parent_id: PAR_ALTRA_SEDE },
    ],
    parents: [
        {
            id: PAR_IN_SCOPE, first_name: 'Adulto', last_name: 'Genitore', gender: 'M',
            birth_date: '1985-04-11', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            fiscal_code: CF_DIVERSOCOGNOME_ADULTO,
        },
        {
            id: PAR_ALTRA_SEDE, first_name: 'Adulto', last_name: 'Genitoreb', gender: 'F',
            birth_date: '1986-05-12', codice_belfiore_nascita: 'H501',
            birth_city: 'Roma', birth_province: 'RM',
            fiscal_code: CF_GENITOREB_ADULTO,
        },
    ],
})

/**
 * OGNI dato personale che compare nei fixture di questo file. Se una di queste
 * stringhe finisce nei campi di un `logEvento`, la riga è già in `app_log`.
 */
const DATI_PERSONALI_PROIBITI = [
    CF_VERIFICA_PROVA, CF_COLLAUDO_PROVA, CF_ESEMPIO_TIZIO, CF_SENZASESSO_BIMBO,
    CF_NUOVO_CAIO, CF_REGOLARE_SEMPRONIO, CF_RISOLTA_COMUNE, CF_FITTIZIO_BIMBA,
    CF_GENITORE_ADULTO, CF_DIVERSOCOGNOME_ADULTO, CF_GENITOREB_ADULTO,
    CF_FUSA_ROSA, CF_FUSA_ROSA_M403, CF_COMBACIA_UGUALE,
    'Collaudo', 'Esempio', 'Senzasesso', 'Nuovo', 'Regolare', 'Ambigua', 'Risolta',
    'Altrasede', 'Genitore', 'Genitoreb', 'Prova', 'Tizio', 'Caio', 'Sempronio',
    'Fusa', 'Rosa', 'Combacia', 'Uguale',
    'Roma', 'Calliano', 'Corigliano', 'Rossano', 'H501', 'B418', 'B419', 'H579', 'M403',
]

beforeEach(() => {
    vi.clearAllMocks()
    h.db = dbBase()
    h.tabelle = []
    h.eventi = []
    h.colonnaAssente = null
    h.errori = {}
    h.limiti = {}
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

/**
 * ⚠️ LA SPIA STA QUI, E NON DENTRO UN `it`, PER UNA RAGIONE MISURATA.
 *
 * Finché il controllo dei nomi proibiti è vissuto dentro un solo test, ispezionava
 * i soli eventi della richiesta di default — cioè il log `info` di successo. Ma
 * `anagrafica` NON è in `EVENTI_PERSISTITI`: quel log, per costruzione, in
 * `app_log` non ci arriva mai. L'unico evento di questa rotta che SOPRAVVIVE al
 * deploy è il `warn` di `scansione-troncata`, e proprio quello non era coperto:
 * iniettando `chi: persone[0]?.cognome` accanto a `esito: 'scansione-troncata'`
 * la suite restava tutta verde. La spia guardava l'unico ramo che non conta.
 *
 * In `afterEach` guarda invece TUTTI gli eventi di TUTTI i test — troncamento,
 * degrado su colonna assente, guasti di lettura compresi — e ogni caso nuovo che
 * qualcuno aggiungerà a questo file entra sotto la spia senza doversene ricordare.
 */
afterEach(() => {
    const scritto = h.eventi.map((e) => JSON.stringify(e.campi)).join(' ')
    for (const proibito of DATI_PERSONALI_PROIBITI) {
        expect(scritto, `«${proibito}» non deve comparire nei campi di nessun log`)
            .not.toContain(proibito)
    }
})

const corpoDi = async (res: Response): Promise<Corpo> => (await res.json()) as Corpo
const per = (c: Corpo, id: string) => c.righe.find((r) => r.id === id)

describe('gate — chi può aprire il pannello', () => {
    it('401 senza identità: il pannello non tocca l’anagrafica', async () => {
        h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })

        const res = await GET(req())

        expect(res.status).toBe(401)
        expect(h.tabelle, 'nessuna lettura prima del gate').toHaveLength(0)
    })

    it('403 per un ruolo non ammesso', async () => {
        h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })

        const res = await GET(req())

        expect(res.status).toBe(403)
        expect(h.tabelle).toHaveLength(0)
    })

    it('scope di sede VUOTO ⇒ nega, non «nessun filtro»', async () => {
        h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: null } })

        const res = await GET(req())

        expect(res.status).toBe(403)
        const corpo = (await res.json()) as { codice?: string }
        expect(corpo.codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.tabelle, 'con lo scope vuoto non si legge niente').toHaveLength(0)
    })
})

describe('isolamento per sede', () => {
    it('un alunno di un’altra sede non compare, e nemmeno il suo codice fiscale', async () => {
        const res = await GET(req())
        const testo = await res.clone().text()
        const corpo = await corpoDi(res)

        expect(res.status).toBe(200)
        expect(corpo.righe.map((r) => r.id)).not.toContain(ALU_ALTRA_SEDE)
        expect(testo).not.toContain(CF_FITTIZIO_BIMBA)
        expect(testo).not.toContain('Altrasede')
    })

    it('il ramo GENITORI passa dal legame: il genitore dell’altra sede resta fuori', async () => {
        const res = await GET(req())
        const testo = await res.clone().text()
        const corpo = await corpoDi(res)

        const genitori = corpo.righe.filter((r) => r.tipo === 'genitore')
        expect(genitori.map((r) => r.id)).toEqual([PAR_IN_SCOPE])
        expect(testo).not.toContain(CF_GENITOREB_ADULTO)
        expect(testo).not.toContain('Genitoreb')
        // La sede del genitore è quella dei suoi FIGLI: `parents` non ha `scuola_id`.
        expect(genitori[0].scuole_ids).toEqual([SEDE_A])
    })

    it('il genitore incoerente porta il suo perché e il codice che l’anagrafica implica', async () => {
        const corpo = await corpoDi(await GET(req()))

        const genitore = per(corpo, PAR_IN_SCOPE)!
        expect(genitore.stato).toBe('incoerente')
        expect(genitore.motivi).toContain('cognome')
        expect(genitore.codice_attuale).toBe(CF_DIVERSOCOGNOME_ADULTO)
        expect(genitore.codice_proposto).toBe(CF_GENITORE_ADULTO)
    })
})

describe('tre stati, non due', () => {
    it('«manca» non è «sbagliato»: un record senza codice non finisce fra gli incoerenti', async () => {
        const corpo = await corpoDi(await GET(req()))

        const daCompilare = per(corpo, ALU_DA_COMPILARE)!
        expect(daCompilare.stato).toBe('da-compilare')
        expect(daCompilare.motivi, 'un codice assente non è una contraddizione').toEqual([])
        expect(daCompilare.codice_attuale, '`character(16)` impagina con spazi: va sempre `trim()`').toBeNull()

        const incoerenti = corpo.righe.filter((r) => r.stato === 'incoerente').map((r) => r.id)
        expect(incoerenti).not.toContain(ALU_DA_COMPILARE)
        expect(incoerenti).not.toContain(ALU_LUOGO_AMBIGUO)
        expect(incoerenti).not.toContain(ALU_LUOGO_RISOLTO)
    })

    it('c’è un codice e non torna ⇒ incoerente, e dice DOVE', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_INCOERENTE)!
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['cognome'])
        expect(riga.non_verificabili).toEqual([])
        expect(riga.codice_proposto).toBe(CF_COLLAUDO_PROVA)
    })

    it('c’è un codice ma mancano i dati per confrontarlo ⇒ non verificabile, mai rosso', async () => {
        const corpo = await corpoDi(await GET(req()))

        const senzaSesso = per(corpo, ALU_SENZA_SESSO)!
        expect(senzaSesso.stato).toBe('non-verificabile')
        expect(senzaSesso.motivi).toEqual([])
        expect(senzaSesso.non_verificabili).toEqual(['sesso'])

        const senzaLuogo = per(corpo, ALU_SENZA_LUOGO)!
        expect(senzaLuogo.stato).toBe('non-verificabile')
        expect(senzaLuogo.motivi).toEqual([])
        expect(senzaLuogo.non_verificabili).toEqual(['sesso', 'luogo-nascita'])
    })

    it('il record che TORNA non compare affatto: il pannello elenca ciò che c’è da fare', async () => {
        const corpo = await corpoDi(await GET(req()))

        expect(corpo.righe.map((r) => r.id)).not.toContain(ALU_COERENTE)
    })

    it('il filtro `stato` restringe senza cambiare il verdetto', async () => {
        const corpo = await corpoDi(await GET(req('?stato=incoerente')))

        expect(corpo.righe.every((r) => r.stato === 'incoerente')).toBe(true)
        expect(corpo.righe.map((r) => r.id).sort()).toEqual([ALU_INCOERENTE, PAR_IN_SCOPE].sort())
    })
})

describe('il codice proposto — mai un’ipotesi', () => {
    it('comune AMBIGUO ⇒ nessuna proposta, e la riga dice che il luogo va corretto prima', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_LUOGO_AMBIGUO)!
        expect(riga.codice_proposto).toBeNull()
        expect(riga.luogo_esito).toBe('ambiguo')
        expect(riga.proposta_bloccata_da).toBe('luogo')
        expect(riga.luogo_candidati.map((c) => c.belfiore).sort()).toEqual(['B418', 'B419'])
    })

    it('comune ASSENTE ⇒ nessuna proposta: il luogo si corregge prima', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_SENZA_LUOGO)!
        expect(riga.codice_proposto).toBeNull()
        expect(riga.luogo_esito).toBe('assente')
        expect(riga.proposta_bloccata_da).toBe('luogo')
    })

    it('comune riconosciuto dal testo libero ⇒ proposta, e il Belfiore è quello risolto', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_LUOGO_RISOLTO)!
        expect(riga.luogo_esito).toBe('risolto')
        expect(riga.codice_belfiore).toBe('H501')
        expect(riga.codice_proposto).toBe(CF_RISOLTA_COMUNE)
        expect(riga.proposta_bloccata_da).toBeNull()
    })

    it('luogo determinato ma anagrafica incompleta ⇒ nessuna proposta, e lo dice', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_SENZA_SESSO)!
        expect(riga.luogo_esito).toBe('belfiore')
        expect(riga.codice_proposto).toBeNull()
        expect(riga.proposta_bloccata_da).toBe('anagrafica')
    })

    it('la colonna `codice_belfiore_nascita` VINCE sul testo libero, e non lo si indovina mai', async () => {
        // Il comune scritto a mano dice Napoli, la colonna dice Roma: si usa la
        // colonna, perché l'ha scelta qualcuno da una tendina.
        const alunni = h.db.alunni as Riga[]
        const riga = alunni.find((a) => a.id === ALU_LUOGO_RISOLTO)!
        riga.codice_belfiore_nascita = 'F839'
        riga.birth_city = 'Roma'

        const corpo = await corpoDi(await GET(req()))

        expect(per(corpo, ALU_LUOGO_RISOLTO)!.luogo_esito).toBe('belfiore')
        expect(per(corpo, ALU_LUOGO_RISOLTO)!.codice_belfiore).toBe('F839')
    })

    it('comune SCONOSCIUTO ⇒ nessuna proposta', async () => {
        const alunni = h.db.alunni as Riga[]
        const riga = alunni.find((a) => a.id === ALU_LUOGO_RISOLTO)!
        riga.birth_city = 'Fantasialandia'
        riga.birth_province = null

        const corpo = await corpoDi(await GET(req()))

        expect(per(corpo, ALU_LUOGO_RISOLTO)!.luogo_esito).toBe('sconosciuto')
        expect(per(corpo, ALU_LUOGO_RISOLTO)!.codice_proposto).toBeNull()
    })
})

describe('si ACCUSA solo col Belfiore della colonna, si PROPONE anche col testo libero', () => {
    /**
     * ⚠️ QUESTO È IL TEST CHE TIENE FERMA LA REGOLA PIÙ IMPORTANTE DEL FILE, ed è
     * quello che mancava: fino al 2026-08-10 si poteva sostituire
     * `codiceBelfiore: normalizzaCodiceBelfiore(persona.belfioreColonna)` con
     * `codiceBelfiore: determinaLuogo(persona).belfiore` dentro `valuta()` e la
     * suite restava tutta verde — cioè si poteva cancellare la regola scritta a
     * chiare lettere nel commento della funzione senza che niente diventasse
     * rosso.
     *
     * Non è un caso di laboratorio: la colonna `codice_belfiore_nascita` è nata
     * senza backfill, quindi in produzione è NULL ovunque e questo ramo è l'unico
     * che gira sui 33 alunni e 50 genitori veri.
     */
    it('comune RINOMINATO: la riga NON è incoerente, e il luogo non è fra i motivi', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_COMUNE_FUSO)!
        expect(riga.stato, 'un codice GIUSTO non diventa rosso perché il comune ha cambiato nome')
            .not.toBe('incoerente')
        expect(riga.stato).toBe('non-verificabile')
        expect(riga.motivi, 'il testo libero basta a PROPORRE, non ad ACCUSARE').toEqual([])
        expect(riga.motivi).not.toContain('luogo-nascita')
        // Il luogo resta NON VERIFICATO — che è un'informazione, non un allarme:
        // la colonna scelta da una tendina non c'è, e il nome nuovo non prova
        // niente sul Belfiore vecchio scritto nel codice.
        expect(riga.non_verificabili).toContain('luogo-nascita')
    })

    it('…e la proposta si calcola lo stesso, col Belfiore risolto dal testo libero', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_COMUNE_FUSO)!
        expect(riga.luogo_esito).toBe('risolto')
        expect(riga.codice_belfiore).toBe('M403')
        expect(riga.codice_proposto).toBe(CF_FUSA_ROSA_M403)
        expect(riga.codice_attuale).toBe(CF_FUSA_ROSA)
        expect(riga.proposta_bloccata_da).toBeNull()
        expect(riga.proposta_combacia, 'proposta e codice registrato differiscono: la scelta è di chi ha il certificato')
            .toBe(false)
    })
})

describe('`proposta_combacia` — dentro la priorità 0 è l’unica cosa che distingue giusto da sbagliato', () => {
    /**
     * ⚠️ QUESTO BLOCCO ESISTE PERCHÉ IL CAMPO NON AVEVA NESSUN TEST NELLA DIREZIONE
     * `true`. Cablandolo a `false` la suite restava verde (misurato il 2026-08-10):
     * l'unica asserzione che lo nominava era `.toBe(false)` sulla riga del comune
     * fuso, cioè esattamente il valore che il campo avrebbe assumendo di essere
     * stato cancellato — un'asserzione decorativa.
     *
     * E la forma che produce `true` non è marginale: `codice_belfiore_nascita` è
     * NULL su tutte e 83 le righe di produzione, quindi ogni persona con un codice
     * CORRETTO e un `birth_city` risolvibile ricade qui. È la riga che la segreteria
     * vedrà più spesso di ogni altra.
     */
    it('codice GIUSTO + colonna NULL + comune risolvibile ⇒ `true`, e la riga non ha niente da correggere', async () => {
        const corpo = await corpoDi(await GET(req()))

        const riga = per(corpo, ALU_COMBACIA)!
        expect(riga.proposta_combacia, 'la proposta coincide col codice registrato').toBe(true)
        expect(riga.codice_proposto).toBe(CF_COMBACIA_UGUALE)
        expect(riga.codice_attuale).toBe(CF_COMBACIA_UGUALE)
        // Non è un errore: è un codice che TORNA su tutto ciò che si è potuto
        // confrontare, con il solo luogo di nascita non verificabile.
        expect(riga.stato).toBe('non-verificabile')
        expect(riga.motivi).toEqual([])
        expect(riga.non_verificabili).toEqual(['luogo-nascita'])
        expect(riga.luogo_esito).toBe('risolto')
        expect(riga.proposta_bloccata_da).toBeNull()
    })

    it('è distinguibile da un incoerente vero, che sta nello stesso blocco a priorità 0', async () => {
        const corpo = await corpoDi(await GET(req()))

        const combacia = per(corpo, ALU_COMBACIA)!
        const incoerente = per(corpo, ALU_INCOERENTE)!

        // Stessa priorità — entrambe si chiudono in un gesto — ma il gesto è
        // OPPOSTO: una conferma il luogo di nascita, l'altra riscrive il codice
        // fiscale di un bambino. Se il pannello non le sapesse separare,
        // «correggi tutto» sovrascriverebbe codici giusti.
        expect(combacia.priorita).toBe(0)
        expect(incoerente.priorita).toBe(0)
        expect(combacia.proposta_combacia).toBe(true)
        expect(incoerente.proposta_combacia, 'qui la proposta CONTRADDICE il codice registrato').toBe(false)
        expect(incoerente.stato).toBe('incoerente')

        // …e su TUTTO l'elenco il campo vale `true` esattamente dove deve: né
        // cablato a `false` (l'elenco sarebbe vuoto) né a `true` (sarebbero tutte).
        expect(corpo.righe.filter((r) => r.proposta_combacia).map((r) => r.id)).toEqual([ALU_COMBACIA])
        expect(corpo.righe.length).toBeGreaterThan(1)
    })
})

describe('ordinamento per azionabilità', () => {
    it('prima chi si corregge in un gesto, poi il luogo da sistemare, poi i non verificabili', async () => {
        const corpo = await corpoDi(await GET(req()))

        const priorita = corpo.righe.map((r) => r.priorita)
        expect(priorita, 'le priorità non sono decrescenti').toEqual([...priorita].sort((a, b) => a - b))

        // Chi ha una proposta sta in cima, e ci sta tutto.
        const conProposta = corpo.righe.filter((r) => r.codice_proposto !== null)
        expect(conProposta.length).toBeGreaterThan(0)
        expect(corpo.righe.slice(0, conProposta.length).every((r) => r.codice_proposto !== null)).toBe(true)

        // Poi il luogo da sistemare, e solo dopo i non verificabili per altro.
        expect(per(corpo, ALU_LUOGO_AMBIGUO)!.priorita).toBe(1)
        expect(per(corpo, ALU_SENZA_LUOGO)!.priorita).toBe(1)
        expect(per(corpo, ALU_SENZA_SESSO)!.priorita).toBe(2)
    })
})

describe('paginazione e troncamento', () => {
    it('`X-Total-Count` dice il totale, non la lunghezza della pagina', async () => {
        const res = await GET(req('?limit=2'))
        const corpo = await corpoDi(res)

        expect(corpo.righe).toHaveLength(2)
        expect(corpo.totale).toBe(9)
        expect(res.headers.get('X-Total-Count')).toBe('9')
        expect(corpo.troncato, 'nove record non toccano il tetto di scansione').toBe(false)
    })

    it('`offset` porta alla pagina DOPO, non alla stessa', async () => {
        const prima = await corpoDi(await GET(req('?limit=3&offset=0')))
        const seconda = await corpoDi(await GET(req('?limit=3&offset=3')))
        const intera = await corpoDi(await GET(req()))

        expect(prima.righe.map((r) => r.id)).toEqual(intera.righe.slice(0, 3).map((r) => r.id))
        expect(seconda.righe.map((r) => r.id)).toEqual(intera.righe.slice(3, 6).map((r) => r.id))
        // Disgiunte: senza `offset` la seconda pagina ripeterebbe la prima, e chi
        // scorre l'elenco correggerebbe due volte le stesse righe e mai le altre.
        const ripetute = seconda.righe.filter((r) => prima.righe.some((p) => p.id === r.id))
        expect(ripetute, 'la seconda pagina non ripete la prima').toEqual([])
        // Il totale NON è la lunghezza della pagina, su nessuna delle due.
        expect(prima.totale).toBe(9)
        expect(seconda.totale).toBe(9)
    })

    it('un elenco troncato non dà errore: dà meno righe — quindi lo si LOGGA', async () => {
        const molti: Riga[] = []
        for (let i = 0; i < 2001; i++) {
            molti.push({
                id: `a${String(i).padStart(7, '0')}-1111-4111-8111-aaaaaaaaaaaa`,
                scuola_id: SEDE_A, nome: 'Caio', cognome: 'Nuovo', gender: 'M',
                data_nascita: '2020-01-15', codice_belfiore_nascita: 'H501',
                birth_city: 'Roma', birth_province: 'RM', codice_fiscale: null,
            })
        }
        h.db.alunni = molti
        h.db.student_parents = []

        const corpo = await corpoDi(await GET(req('?limit=1')))

        expect(corpo.troncato).toBe(true)
        const troncamenti = h.eventi.filter((e) => e.campi.esito === 'scansione-troncata')
        expect(troncamenti, 'un elenco troncato senza log è il modo più silenzioso di mentire').toHaveLength(1)
        expect(troncamenti[0].evento).toBe('anagrafica')
        expect(troncamenti[0].livello).toBe('warn')
        // I due rami hanno due coppie di numeri: la riga deve dire QUALE lettura
        // è stata tagliata, perché sono due interventi diversi.
        expect(troncamenti[0].campi.alunni_totale).toBe(2001)
        expect(troncamenti[0].campi.alunni_letti).toBe(2000)
        expect(troncamenti[0].campi.legami_totale).toBe(0)
    })

    it('anche il ramo GENITORI ha un tetto, e quando morde lo dice', async () => {
        // Il ramo alunni sta larghissimo (otto righe): a mordere è SOLO la
        // lettura dei legami. Senza questo caso `troncatoLegami` non aveva alcun
        // test, e il tetto sulla seconda query era una riga di codice che nessuno
        // aveva mai visto scattare.
        const legami: Riga[] = []
        for (let i = 0; i < 2001; i++) {
            legami.push({
                student_id: ALU_INCOERENTE,
                parent_id: `c${String(i).padStart(7, '0')}-1111-4111-8111-cccccccccccc`,
            })
        }
        h.db.student_parents = legami
        // I genitori non esistono in anagrafica: qui si misura il TETTO, non le righe.
        h.db.parents = []

        const corpo = await corpoDi(await GET(req('?tipo=genitori')))

        expect(corpo.troncato, 'il tetto dei legami morde e la risposta lo dichiara').toBe(true)
        const troncamenti = h.eventi.filter((e) => e.campi.esito === 'scansione-troncata')
        expect(troncamenti).toHaveLength(1)
        expect(troncamenti[0].livello).toBe('warn')
        expect(troncamenti[0].campi.legami_totale).toBe(2001)
        expect(troncamenti[0].campi.legami_letti).toBe(2000)
        // Il ramo alunni NON è troncato: la riga non deve far credere il contrario.
        expect(troncamenti[0].campi.alunni_totale).toBe(9)
        expect(troncamenti[0].campi.alunni_letti).toBe(9)
    })

    it('lo scope dei legami sta NELLA QUERY, non solo nel filtro in memoria', async () => {
        // 2001 legami che puntano all'alunno dell'ALTRA sede. Il filtro in memoria
        // (`if (!sede) continue`) li scarterebbe comunque — è difesa in profondità,
        // ed è la ragione per cui cancellare `.in('student_id', …)` non produceva
        // nessun rosso. Ma il CONTEGGIO ESATTO no: senza il filtro nella query
        // quelle 2001 righe verrebbero lette davvero, il tetto morderebbe e la
        // risposta direbbe `troncato: true` su un elenco di una riga sola.
        const legami: Riga[] = [{ student_id: ALU_INCOERENTE, parent_id: PAR_IN_SCOPE }]
        for (let i = 0; i < 2001; i++) {
            legami.push({
                student_id: ALU_ALTRA_SEDE,
                parent_id: `d${String(i).padStart(7, '0')}-2222-4222-8222-dddddddddddd`,
            })
        }
        h.db.student_parents = legami

        const corpo = await corpoDi(await GET(req('?tipo=genitori')))

        expect(corpo.troncato, 'i legami fuori scope non si leggono affatto').toBe(false)
        expect(h.eventi.filter((e) => e.campi.esito === 'scansione-troncata')).toHaveLength(0)
        expect(corpo.righe.map((r) => r.id)).toEqual([PAR_IN_SCOPE])
    })
})

describe('i lotti di uuid — il tetto dichiarato (2000) dev’essere raggiungibile DAVVERO', () => {
    /**
     * ⚠️ IL LOTTEGGIO NON AVEVA NESSUN TEST, ed è la riparazione che senza test non
     * esiste. Misurato il 2026-08-10: sei mutazioni distinte su `aLotti`,
     * `UUID_PER_LOTTO` e `spazio` lasciavano tutti i test verdi, perché NESSUN caso
     * esercitava più di un lotto CON righe dentro (il caso dei 2001 alunni azzera
     * `student_parents`; i due casi dei 2001 legami hanno otto alunni, cioè un lotto
     * solo).
     *
     * Perché conta: `student_id=in.(…)` viaggia nella QUERY STRING di una GET.
     * Duemila uuid fanno ~76 KB di URL e nessun proxy davanti al database accetta
     * una riga di richiesta simile. Senza i lotti il tetto vero non sarebbe 2000 ma
     * ~180 alunni, e oltre quella soglia la pagina risponderebbe 500 — cioè si
     * romperebbe esattamente dove promette di DEGRADARE dando meno righe.
     *
     * E il difetto che i lotti prevengono è SILENZIOSO per costruzione: un lotto
     * perso non produce nessun errore, produce meno bambini in una lista.
     */
    const N_ALUNNI = 450
    const GENITORI_PER_ALUNNO = 10
    const idAlunno = (i: number) => `a${String(i).padStart(7, '0')}-1111-4111-8111-aaaaaaaaaaaa`
    const idGenitore = (i: number) => `c${String(i).padStart(7, '0')}-1111-4111-8111-cccccccccccc`

    /** `quanti` alunni in SEDE_A, e i legami che il chiamante costruisce sopra. */
    const popola = (quanti: number, legamiPerAlunno: number) => {
        const alunni: Riga[] = []
        const legami: Riga[] = []
        const genitori: Riga[] = []
        let progressivo = 0
        for (let i = 0; i < quanti; i++) {
            alunni.push({
                id: idAlunno(i), scuola_id: SEDE_A, nome: 'Caio', cognome: 'Nuovo', gender: 'M',
                data_nascita: '2020-01-15', codice_belfiore_nascita: 'H501',
                birth_city: 'Roma', birth_province: 'RM', codice_fiscale: null,
            })
            for (let k = 0; k < legamiPerAlunno; k++) {
                const genitore = idGenitore(progressivo++)
                legami.push({ student_id: idAlunno(i), parent_id: genitore })
                genitori.push({
                    id: genitore, first_name: 'Adulto', last_name: 'Genitore', gender: 'M',
                    birth_date: '1985-04-11', codice_belfiore_nascita: 'H501',
                    birth_city: 'Roma', birth_province: 'RM', fiscal_code: null,
                })
            }
        }
        h.db.alunni = alunni
        h.db.student_parents = legami
        h.db.parents = genitori
    }

    it('oltre 150 alunni in scope: i genitori RESI sono tutti, non quelli del primo lotto', async () => {
        // 320 alunni ⇒ tre lotti (150 + 150 + 20), un genitore per alunno. Se il
        // lotteggio leggesse solo il primo lotto i genitori sarebbero 150; se
        // saltasse un alunno per lotto sarebbero 318. Sono 320.
        popola(320, 1)

        const corpo = await corpoDi(await GET(req('?tipo=genitori')))

        expect(corpo.totale, 'né 150 (un lotto solo) né 318 (un alunno saltato per lotto)').toBe(320)
        expect(corpo.scansionati).toBe(320)
        expect(corpo.troncato, '320 legami stanno larghi sotto il tetto di 2000').toBe(false)
        expect(corpo.righe.every((r) => r.tipo === 'genitore')).toBe(true)

        // IL NUMERO DI LOTTI EMESSI, contato sulle letture vere. È l'asserzione che
        // impedisce a `UUID_PER_LOTTO` di tornare a un valore che ricrea l'URL fuori
        // scala: con 5000 uuid per lotto la chiamata sarebbe UNA, e i genitori resi
        // sarebbero comunque 320 — cioè il difetto passerebbe.
        expect(h.tabelle.filter((t) => t === 'student_parents'), 'ceil(320 / 150) = 3').toHaveLength(3)
        expect(h.tabelle.filter((t) => t === 'parents'), 'anche `id IN (…)` è lo stesso URL').toHaveLength(3)
    })

    it('a lotti il tetto resta esatto: il conteggio si SOMMA e la finestra si RESTRINGE', async () => {
        // 450 alunni × 10 genitori = 4500 legami su tre lotti da 150 alunni.
        //   lotto 1 → spazio 2000, legge 1500, buffer 1500
        //   lotto 2 → spazio  500, legge  500 (di 1500), buffer 2000
        //   lotto 3 → spazio    0, chiede 1 riga SOLO per avere il `count`
        // È l'unico caso in cui il troncamento attraversa il confine fra due lotti.
        popola(N_ALUNNI, GENITORI_PER_ALUNNO)
        h.db.parents = []

        const corpo = await corpoDi(await GET(req('?tipo=genitori')))

        expect(corpo.troncato, 'il troncamento dei legami deve reggere anche a lotti').toBe(true)
        const troncamenti = h.eventi.filter((e) => e.campi.esito === 'scansione-troncata')
        expect(troncamenti).toHaveLength(1)
        // Il conteggio è la SOMMA dei lotti: con `=` invece di `+=` varrebbe 1500
        // (l'ultimo lotto), `1500 > 2000` sarebbe falso e `troncato` direbbe `false`
        // su un elenco tagliato di 2500 righe.
        expect(troncamenti[0].campi.legami_totale).toBe(N_ALUNNI * GENITORI_PER_ALUNNO)
        // Il buffer non sfora: senza il cap `slice(0, spazio)` sarebbero 2001.
        expect(troncamenti[0].campi.legami_letti).toBe(2000)
        expect(troncamenti[0].campi.alunni_totale).toBe(N_ALUNNI)

        // Tre lotti, e ognuno chiede SOLO lo spazio che gli resta: la finestra è
        // l'unica prova che il secondo giro non riscarica duemila righe da buttare.
        expect(h.tabelle.filter((t) => t === 'student_parents'), 'ceil(450 / 150) = 3').toHaveLength(3)
        expect(h.limiti.student_parents, 'la finestra si restringe lotto per lotto').toEqual([2000, 500, 1])
    })
})

describe('i quattro parametri dichiarati, tutti e quattro', () => {
    // Il contratto della rotta dichiara `tipo`, `stato`, `scuola_id`, `limit` e
    // `offset`. Solo `stato` e `limit` avevano un test: gli altri funzionavano —
    // misurato — ma «funziona oggi» e «resta vero domani» sono due affermazioni
    // diverse, e solo la seconda la fa un test.

    it('`tipo=alunni` esclude i genitori, e non legge nemmeno i legami', async () => {
        const corpo = await corpoDi(await GET(req('?tipo=alunni')))

        expect(corpo.righe.length).toBeGreaterThan(0)
        expect(corpo.righe.every((r) => r.tipo === 'alunno')).toBe(true)
        expect(corpo.righe.map((r) => r.id)).not.toContain(PAR_IN_SCOPE)
        expect(corpo.scansionati).toBe(9)
        expect(h.tabelle, 'chiedendo i soli alunni, `student_parents` non si tocca')
            .not.toContain('student_parents')
    })

    it('`tipo=genitori` esclude gli alunni', async () => {
        const corpo = await corpoDi(await GET(req('?tipo=genitori')))

        expect(corpo.righe.map((r) => r.id)).toEqual([PAR_IN_SCOPE])
        expect(corpo.righe.every((r) => r.tipo === 'genitore')).toBe(true)
        // Gli alunni si LEGGONO comunque (è da lì che passa lo scope dei genitori),
        // ma non si scansionano: `scansionati` conta le persone verificate.
        expect(corpo.scansionati).toBe(1)
    })

    it('`tipo=tutti` è il default e li tiene entrambi', async () => {
        const esplicito = await corpoDi(await GET(req('?tipo=tutti')))
        const implicito = await corpoDi(await GET(req()))

        expect(esplicito.righe.map((r) => r.id)).toEqual(implicito.righe.map((r) => r.id))
        expect(esplicito.righe.some((r) => r.tipo === 'alunno')).toBe(true)
        expect(esplicito.righe.some((r) => r.tipo === 'genitore')).toBe(true)
    })

    it('un `tipo` fuori dall’enumerato è 400, non un elenco a caso', async () => {
        const res = await GET(req('?tipo=pippo'))

        expect(res.status).toBe(400)
        expect(h.tabelle, 'un input rifiutato non tocca l’anagrafica').toHaveLength(0)
    })

    it('`limit` fuori scala è 400', async () => {
        const res = await GET(req('?limit=9999'))

        expect(res.status).toBe(400)
        expect(h.tabelle).toHaveLength(0)
    })

    it('`scuola_id` di una sede ALTRUI: 200 con zero righe, e nessun dato di quella sede', async () => {
        // L'AND non seleziona nulla. Mai «non posso filtrare, allora eccoti tutto»:
        // è il rovescio esatto dello scope vuoto, e va provato nella direzione in
        // cui il difetto sarebbe silenzioso.
        const res = await GET(req(`?scuola_id=${SEDE_B}`))
        const testo = await res.clone().text()
        const corpo = await corpoDi(res)

        expect(res.status).toBe(200)
        expect(corpo.righe).toEqual([])
        expect(corpo.totale).toBe(0)
        expect(testo).not.toContain(CF_FITTIZIO_BIMBA)
        expect(testo).not.toContain('Altrasede')
        expect(testo).not.toContain(SEDE_B)
    })
})

describe('multi-sede — le sedi di un genitore sono quelle dei suoi FIGLI', () => {
    /**
     * ⚠️ CON UNO STAFF MONO-SEDE QUESTA PROPRIETÀ NON SI PUÒ PROVARE: `plessi`
     * vale `[SEDE_A]` e `scuole_ids` vale `[SEDE_A]`, quindi l'asserzione è vera
     * anche se la route scrivesse `scuoleIds: plessi` — cioè anche se la sede del
     * genitore non venisse dai figli affatto. Serve uno scope con DUE sedi e un
     * genitore che ne abbia una sola: solo lì i due valori si separano.
     */
    const direzioneSuDueSedi = () => {
        h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'admin', scuola_id: SEDE_A } })
        h.db.utenti_scuole = [
            { utente_id: 'dir1', scuola_id: SEDE_A },
            { utente_id: 'dir1', scuola_id: SEDE_B },
        ]
        // Il genitore in scope prende un secondo figlio, nell'altra sede.
        ;(h.db.student_parents as Riga[]).push({ student_id: ALU_ALTRA_SEDE, parent_id: PAR_IN_SCOPE })
        // …e il genitore dell'altra sede diventa segnalabile, altrimenti la riga
        // che serve al confronto non comparirebbe affatto (un record che TORNA
        // non entra nel pannello).
        const altro = (h.db.parents as Riga[]).find((p) => p.id === PAR_ALTRA_SEDE)!
        altro.fiscal_code = CF_GENITORE_ADULTO
    }

    it('due figli in due sedi ⇒ due sedi; un figlio in una sola ⇒ una sola', async () => {
        direzioneSuDueSedi()

        const corpo = await corpoDi(await GET(req()))

        const dueSedi = per(corpo, PAR_IN_SCOPE)!
        expect([...dueSedi.scuole_ids].sort()).toEqual([SEDE_A, SEDE_B].sort())

        const unaSede = per(corpo, PAR_ALTRA_SEDE)!
        expect(unaSede.scuole_ids, 'sottoinsieme STRETTO dello scope: non è `plessi`').toEqual([SEDE_B])
    })

    it('`scuola_id` restringe IN AND con lo scope, non al posto suo', async () => {
        direzioneSuDueSedi()

        const senza = await corpoDi(await GET(req()))
        const res = await GET(req(`?scuola_id=${SEDE_A}`))
        const testo = await res.clone().text()
        const corpo = await corpoDi(res)

        expect(senza.righe.map((r) => r.id)).toContain(ALU_ALTRA_SEDE)
        expect(corpo.righe.map((r) => r.id), 'la sede chiesta restringe').not.toContain(ALU_ALTRA_SEDE)
        expect(corpo.righe.map((r) => r.id)).toContain(ALU_INCOERENTE)
        expect(testo).not.toContain(CF_FITTIZIO_BIMBA)
        expect(testo).not.toContain('Altrasede')
        // Il genitore resta, ma con la sola sede che il filtro lascia passare.
        expect(per(corpo, PAR_IN_SCOPE)!.scuole_ids).toEqual([SEDE_A])
    })
})

describe('degrado su un database non migrato', () => {
    it('`42703` sul Belfiore non è un 500: si ritenta senza la colonna, e il log la NOMINA', async () => {
        h.colonnaAssente = 'codice_belfiore_nascita'

        const res = await GET(req())
        const corpo = await corpoDi(res)

        expect(res.status, 'una colonna assente non è un guasto del server').toBe(200)
        // Senza la colonna il Belfiore si risolve dal testo libero, dove si può.
        expect(per(corpo, ALU_INCOERENTE)!.codice_belfiore).toBe('H501')
        expect(per(corpo, ALU_INCOERENTE)!.luogo_esito).toBe('risolto')

        const degradi = h.eventi.filter((e) => String(e.campi.esito ?? '').startsWith('colonna-assente'))
        expect(degradi.length, 'il degrado va detto, non subìto').toBeGreaterThan(0)
        const detto = degradi.map((e) => JSON.stringify(e.campi)).join(' ')
        expect(detto, 'il warn deve NOMINARE la colonna caduta').toContain('codice_belfiore_nascita')
    })

    it('un guasto di lettura risponde con un CODICE, non con la prosa di PostgREST', async () => {
        // `08006` non è «colonna assente»: non si riprova, si dichiara il guasto.
        h.errori = { alunni: { code: '08006', message: 'connection failure' } }

        const res = await GET(req())
        const corpo = (await res.json()) as { error?: string; codice?: string }

        expect(res.status).toBe(500)
        expect(corpo.codice).toBe('VERIFICA_CODICI_FISCALI_NON_RIUSCITA')
        expect(JSON.stringify(corpo), 'la prosa del fornitore resta nel log').not.toContain('connection failure')
    })
})

describe('i log non portano mai un dato personale', () => {
    it('nessun codice fiscale, nessun nome, nessun comune nei campi di `logEvento`', async () => {
        await GET(req())

        expect(h.eventi.length, 'un successo che non logga non distingue «tutto ok» da «non è partito niente»')
            .toBeGreaterThan(0)

        const scritto = h.eventi.map((e) => JSON.stringify(e.campi)).join(' ')
        for (const proibito of DATI_PERSONALI_PROIBITI) {
            expect(scritto, `«${proibito}» non deve comparire nei log`).not.toContain(proibito)
        }
    })

    it('anche il `warn` di troncamento — il SOLO che finisce davvero in `app_log`', async () => {
        // `anagrafica` non è in `EVENTI_PERSISTITI`: il log `info` di successo non
        // viene scritto. Il `warn` sì. Un test sulla privacy che guarda solo il
        // successo controlla l'unico ramo che sul server non lascia traccia.
        const molti: Riga[] = []
        for (let i = 0; i < 2001; i++) {
            molti.push({
                id: `a${String(i).padStart(7, '0')}-1111-4111-8111-aaaaaaaaaaaa`,
                scuola_id: SEDE_A, nome: 'Caio', cognome: 'Nuovo', gender: 'M',
                data_nascita: '2020-01-15', codice_belfiore_nascita: 'H501',
                birth_city: 'Roma', birth_province: 'RM', codice_fiscale: null,
            })
        }
        h.db.alunni = molti
        h.db.student_parents = []

        await GET(req('?limit=1'))

        const warn = h.eventi.filter((e) => e.campi.esito === 'scansione-troncata')
        expect(warn, 'il ramo che si vuole ispezionare deve essere stato percorso').toHaveLength(1)
        // Ogni campo della riga persistita è un numero o una stringa d'enumerato:
        // nessun testo che venga dall'anagrafica.
        for (const [chiave, valore] of Object.entries(warn[0].campi)) {
            expect(['number', 'boolean'].includes(typeof valore) || chiave === 'esito' || chiave === 'operazione',
                `il campo «${chiave}» del warn persistito non è un conteggio né un enumerato`).toBe(true)
        }
        // …e l'`afterEach` di questo file ripassa comunque i nomi proibiti.
    })

    it('il successo logga i conteggi, e solo quelli', async () => {
        await GET(req())

        const ok = h.eventi.find((e) => e.evento === 'anagrafica' && e.campi.esito === 'ok')
        expect(ok, 'gli eventi critici loggano anche il SUCCESSO').toBeDefined()
        expect(ok!.campi.operazione).toBe('admin/anagrafiche/codici-fiscali:GET')
        expect(typeof ok!.campi.totale).toBe('number')
        expect(typeof ok!.campi.troncato).toBe('boolean')
    })
})
