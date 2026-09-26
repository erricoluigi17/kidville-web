import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { calcolaCodiceFiscale, carattereControllo, type DatiAnagraficiCf } from '@/lib/fiscale/calcolo'
import { OMOCODIA_DA_CIFRA, POSIZIONI_NUMERICHE } from '@/lib/fiscale/tabelle'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
import { risolviComune } from '@/lib/fiscale/comuni'
import { scrivibile, type RigaCodiceFiscale } from '@/components/features/admin/CodiciFiscaliDaVerificare'

// =============================================================================
// «Codici fiscali da verificare» e l'OMOCODIA (decisioni del titolare, 26/09/2026).
//
//  (a) un omocodico coerente con l'anagrafica → nessun avviso;
//  (b) un codice valido ma diverso dal calcolato per altri motivi → avviso, e
//      «Applica» RESTA;
//  (c) nel pannello un omocodico coerente NON compare.
//
// IL DIFETTO CHE QUESTO FILE TIENE CHIUSO. Con la colonna
// `codice_belfiore_nascita` vuota (è così su quasi tutte le righe vere: la
// migrazione che l'ha creata non fa backfill) e il comune scritto a mano che si
// risolve, un omocodico GIUSTO usciva `non-verificabile` con una proposta
// calcolata dai dati — cioè la base SENZA omocodia — e `proposta_combacia`
// confrontava le due stringhe alla lettera: `false`. Il pannello mostrava allora
// «Applica», che avrebbe sovrascritto il codice che l'Agenzia ha davvero
// assegnato con uno che a quella persona non appartiene.
//
// Nessun dato reale: i codici si COSTRUISCONO qui con `src/lib/fiscale` su nomi
// inventati, e l'omocodia si applica a mano con la tabella dell'Agenzia,
// ricalcolando il carattere di controllo — così ogni codice ha la checksum giusta
// e il test prova l'omocodia, non un codice scritto male.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'

const ALU_OMO_COERENTE_RISOLTO = 'a1000001-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_COERENTE_COLONNA = 'a1000002-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_INCOERENTE_COLONNA = 'a1000003-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_INCOERENTE_RISOLTO = 'a1000004-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_SENZA_LUOGO = 'a1000005-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_CHECKSUM_ERRATA = 'a1000006-1111-4111-8111-aaaaaaaaaaaa'
const ALU_NORMALE_INCOERENTE = 'a1000007-1111-4111-8111-aaaaaaaaaaaa'
const ALU_NORMALE_COMBACIA = 'a1000008-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_PARZIALE_RISOLTO = 'a1000009-1111-4111-8111-aaaaaaaaaaaa'
const ALU_OMO_LUOGO_DIVERSO = 'a1000010-1111-4111-8111-aaaaaaaaaaaa'
const PAR_OMO_COERENTE_RISOLTO = 'c1000001-1111-4111-8111-cccccccccccc'
const PAR_OMO_INCOERENTE_RISOLTO = 'c1000002-1111-4111-8111-cccccccccccc'

/** Il codice calcolato dai dati, o il test si ferma: un fixture che non si calcola non prova niente. */
function calcola(dati: DatiAnagraficiCf): string {
    const esito = calcolaCodiceFiscale(dati)
    if (!esito.ok) throw new Error(`fixture non calcolabile: ${esito.motivo}`)
    return esito.codice
}

/**
 * L'omocodia dell'Agenzia: le ultime `quante` posizioni numeriche, partendo da
 * DESTRA, diventano lettere; il carattere di controllo si ricalcola sui quindici
 * caratteri così come sono. Il risultato è un codice valido, checksum compresa.
 */
function omocodico(codice: string, quante: number): string {
    const caratteri = [...codice.slice(0, 15)]
    const daDestra = [...POSIZIONI_NUMERICHE].reverse().slice(0, quante)
    for (const posizione of daDestra) caratteri[posizione] = OMOCODIA_DA_CIFRA[caratteri[posizione]]!
    const primi15 = caratteri.join('')
    return primi15 + carattereControllo(primi15)
}

/** Lo stesso codice con un carattere di controllo SBAGLIATO (il successivo nell'alfabeto). */
function conChecksumErrata(codice: string): string {
    const giusto = codice[15]
    const sbagliato = giusto === 'Z' ? 'A' : String.fromCharCode(giusto.charCodeAt(0) + 1)
    return codice.slice(0, 15) + sbagliato
}

// ─── Le persone inventate ────────────────────────────────────────────────────
const OMOBAMBA: DatiAnagraficiCf = {
    cognome: 'Omobamba', nome: 'Primina', sesso: 'F', dataNascita: '2019-03-07', codiceBelfiore: 'H501',
}
const OMOBIMBO: DatiAnagraficiCf = {
    cognome: 'Omobimbo', nome: 'Secondo', sesso: 'M', dataNascita: '2018-11-23', codiceBelfiore: 'H501',
}
const OMOSTORTO: DatiAnagraficiCf = {
    cognome: 'Omostorto', nome: 'Terzo', sesso: 'M', dataNascita: '2019-06-14', codiceBelfiore: 'H501',
}
/** Chi possiede DAVVERO il codice omocodico messo sulla riga di `OMOSTORTO`: cognome diverso. */
const ALTROSTORTO: DatiAnagraficiCf = { ...OMOSTORTO, cognome: 'Altrostorto' }
const OMOSENZA: DatiAnagraficiCf = {
    cognome: 'Omosenza', nome: 'Quarta', sesso: 'F', dataNascita: '2020-01-30', codiceBelfiore: 'H501',
}
const OMOCHECK: DatiAnagraficiCf = {
    cognome: 'Omocheck', nome: 'Quinto', sesso: 'M', dataNascita: '2018-08-08', codiceBelfiore: 'H501',
}
const NORMALE: DatiAnagraficiCf = {
    cognome: 'Normale', nome: 'Sesta', sesso: 'F', dataNascita: '2019-10-02', codiceBelfiore: 'H501',
}
const ALTRANORMALE: DatiAnagraficiCf = { ...NORMALE, nome: 'Settima' }
const COMBACIA: DatiAnagraficiCf = {
    cognome: 'Combaciante', nome: 'Ottava', sesso: 'F', dataNascita: '2019-12-12', codiceBelfiore: 'H501',
}
const PARZIALE: DatiAnagraficiCf = {
    cognome: 'Omoparziale', nome: 'Nono', sesso: 'M', dataNascita: '2017-05-19', codiceBelfiore: 'H501',
}
/**
 * Il codice è costruito su Roma (H501), ma sulla riga la colonna Belfiore è VUOTA e il
 * comune scritto a mano è Napoli: si risolve in un altro Belfiore (comune sbagliato,
 * o fuso/rinominato). È l'unico omocodico che esce `non-verificabile` — coerente sui
 * campi che si possono confrontare — con una proposta che NON combacia con la base.
 */
const LUOGODIVERSO: DatiAnagraficiCf = {
    cognome: 'Omoluogo', nome: 'Decima', sesso: 'F', dataNascita: '2020-04-21', codiceBelfiore: 'H501',
}
const GENITORE_OMO: DatiAnagraficiCf = {
    cognome: 'Omopadre', nome: 'Adulto', sesso: 'M', dataNascita: '1984-02-17', codiceBelfiore: 'H501',
}
const GENITORE_STORTO: DatiAnagraficiCf = {
    cognome: 'Omomadre', nome: 'Adulta', sesso: 'F', dataNascita: '1986-09-04', codiceBelfiore: 'H501',
}
/** Il codice omocodico messo sulla riga di `GENITORE_STORTO` è di chi ha un altro NOME. */
const GENITORE_ALTRO: DatiAnagraficiCf = { ...GENITORE_STORTO, nome: 'Diversa' }

const CF = {
    omoBamba: omocodico(calcola(OMOBAMBA), 7),
    omoBimbo: omocodico(calcola(OMOBIMBO), 3),
    omoStortoAltrui: omocodico(calcola(ALTROSTORTO), 2),
    omoStortoAltruiRisolto: omocodico(calcola(ALTROSTORTO), 1),
    omoSenza: omocodico(calcola(OMOSENZA), 1),
    omoCheckErrata: conChecksumErrata(omocodico(calcola(OMOCHECK), 2)),
    normaleAltrui: calcola(ALTRANORMALE),
    combacia: calcola(COMBACIA),
    omoParziale: omocodico(calcola(PARZIALE), 1),
    omoLuogoDiverso: omocodico(calcola(LUOGODIVERSO), 2),
    genitoreOmo: omocodico(calcola(GENITORE_OMO), 4),
    genitoreStortoAltrui: omocodico(calcola(GENITORE_ALTRO), 2),
}

interface CampiEvento {
    [chiave: string]: unknown
}

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    tabelle: [] as string[],
    eventi: [] as { evento: string; livello: string; campi: CampiEvento }[],
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
        createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
        createClient: async () => creaFintoSupabase(h.db, h.tabelle),
    }
})

import { GET } from '@/app/api/admin/anagrafiche/codici-fiscali/route'

interface Corpo {
    righe: RigaCodiceFiscale[]
    totale: number
}

/** Colonna Belfiore VUOTA, comune scritto a mano che si risolve: la forma di produzione. */
const risolto = { codice_belfiore_nascita: null, birth_city: 'Roma', birth_province: 'RM' }
/** Colonna Belfiore valorizzata (scelta dalla tendina). */
const colonna = { codice_belfiore_nascita: 'H501', birth_city: 'Roma', birth_province: 'RM' }
/** Colonna Belfiore VUOTA, comune scritto a mano che si risolve in un Belfiore DIVERSO da H501. */
const risoltoAltrove = { codice_belfiore_nascita: null, birth_city: 'Napoli', birth_province: 'NA' }

const alunno = (id: string, d: DatiAnagraficiCf, cf: string, luogo: Record<string, unknown>) => ({
    id, scuola_id: SEDE_A, nome: d.nome, cognome: d.cognome, gender: d.sesso,
    data_nascita: d.dataNascita, codice_fiscale: cf, ...luogo,
})

const dbBase = (): DBFinto => ({
    utenti_scuole: [],
    alunni: [
        alunno(ALU_OMO_COERENTE_RISOLTO, OMOBAMBA, CF.omoBamba, risolto),
        alunno(ALU_OMO_COERENTE_COLONNA, OMOBIMBO, CF.omoBimbo, colonna),
        alunno(ALU_OMO_INCOERENTE_COLONNA, OMOSTORTO, CF.omoStortoAltrui, colonna),
        alunno(ALU_OMO_INCOERENTE_RISOLTO, OMOSTORTO, CF.omoStortoAltruiRisolto, risolto),
        alunno(ALU_OMO_SENZA_LUOGO, OMOSENZA, CF.omoSenza, {
            codice_belfiore_nascita: null, birth_city: null, birth_province: null,
        }),
        alunno(ALU_OMO_CHECKSUM_ERRATA, OMOCHECK, CF.omoCheckErrata, risolto),
        alunno(ALU_NORMALE_INCOERENTE, NORMALE, CF.normaleAltrui, colonna),
        alunno(ALU_NORMALE_COMBACIA, COMBACIA, CF.combacia, risolto),
        alunno(ALU_OMO_PARZIALE_RISOLTO, PARZIALE, CF.omoParziale, risolto),
        alunno(ALU_OMO_LUOGO_DIVERSO, LUOGODIVERSO, CF.omoLuogoDiverso, risoltoAltrove),
    ],
    student_parents: [
        { student_id: ALU_OMO_COERENTE_RISOLTO, parent_id: PAR_OMO_COERENTE_RISOLTO },
        { student_id: ALU_OMO_COERENTE_RISOLTO, parent_id: PAR_OMO_INCOERENTE_RISOLTO },
    ],
    parents: [
        {
            id: PAR_OMO_COERENTE_RISOLTO, first_name: GENITORE_OMO.nome, last_name: GENITORE_OMO.cognome,
            gender: GENITORE_OMO.sesso, birth_date: GENITORE_OMO.dataNascita, fiscal_code: CF.genitoreOmo,
            ...risolto,
        },
        {
            id: PAR_OMO_INCOERENTE_RISOLTO, first_name: GENITORE_STORTO.nome, last_name: GENITORE_STORTO.cognome,
            gender: GENITORE_STORTO.sesso, birth_date: GENITORE_STORTO.dataNascita,
            fiscal_code: CF.genitoreStortoAltrui, ...risolto,
        },
    ],
})

beforeEach(() => {
    vi.clearAllMocks()
    h.db = dbBase()
    h.tabelle = []
    h.eventi = []
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

afterEach(() => {
    // Mai un codice fiscale né un cognome nei campi di un log.
    const scritto = h.eventi.map((e) => JSON.stringify(e.campi)).join(' ')
    for (const proibito of [...Object.values(CF), 'Omobamba', 'Omostorto', 'Omoluogo', 'Omopadre', 'Omomadre', 'Normale']) {
        expect(scritto, `«${proibito}» non deve comparire nei log`).not.toContain(proibito)
    }
})

const leggi = async (query = ''): Promise<Corpo> => {
    const res = await GET(new NextRequest(`http://localhost/api/admin/anagrafiche/codici-fiscali${query}`))
    expect(res.status).toBe(200)
    return (await res.json()) as Corpo
}
const per = (c: Corpo, id: string) => c.righe.find((r) => r.id === id)

describe('premesse dei fixture: i codici sono omocodici VERI, non scritti male', () => {
    it('ogni omocodico costruito è valido, checksum compresa, e la sua base è il calcolato', () => {
        for (const [cf, dati] of [
            [CF.omoBamba, OMOBAMBA], [CF.omoBimbo, OMOBIMBO], [CF.omoSenza, OMOSENZA],
            [CF.omoParziale, PARZIALE], [CF.genitoreOmo, GENITORE_OMO], [CF.omoLuogoDiverso, LUOGODIVERSO],
        ] as const) {
            const v = validaCodiceFiscale(cf)
            expect(v.valido, cf).toBe(true)
            expect(v.omocodia).toBe(true)
            expect(v.baseSenzaOmocodia).toBe(calcola(dati))
            expect(cf).not.toBe(calcola(dati))
        }
        // Il caso della checksum sbagliata è davvero SBAGLIATO, e la sua base torna.
        const errata = validaCodiceFiscale(CF.omoCheckErrata)
        expect(errata.valido).toBe(false)
        expect(errata.baseSenzaOmocodia).toBe(calcola(OMOCHECK))
    })
})

describe('(c) un omocodico COERENTE non compare nel pannello', () => {
    it('colonna Belfiore vuota + comune risolto (la forma di produzione): la riga NON c’è', async () => {
        const corpo = await leggi()
        expect(per(corpo, ALU_OMO_COERENTE_RISOLTO), 'omocodia piena, alunna').toBeUndefined()
        expect(per(corpo, ALU_OMO_PARZIALE_RISOLTO), 'omocodia di una sola cifra, alunno').toBeUndefined()
        expect(per(corpo, PAR_OMO_COERENTE_RISOLTO), 'omocodia, genitore').toBeUndefined()
    })

    it('colonna Belfiore valorizzata: la riga non c’è (tutto verificato)', async () => {
        const corpo = await leggi()
        expect(per(corpo, ALU_OMO_COERENTE_COLONNA)).toBeUndefined()
    })

    it('nemmeno filtrando per stato «non-verificabile» o per tipo', async () => {
        const nv = await leggi('?stato=non-verificabile')
        expect(per(nv, ALU_OMO_COERENTE_RISOLTO)).toBeUndefined()
        const genitori = await leggi('?tipo=genitori')
        expect(per(genitori, PAR_OMO_COERENTE_RISOLTO)).toBeUndefined()
        // …e il totale che la pillola conta non lo include.
        expect(genitori.totale).toBe(genitori.righe.length)
        expect(genitori.righe.map((r) => r.id)).toEqual([PAR_OMO_INCOERENTE_RISOLTO])
    })

    it('un codice NON omocodico che combacia resta com’era: in priorità 0, con `proposta_combacia`', async () => {
        // Il comportamento esistente del pannello («si sceglie il comune dalla
        // tendina e la riga sparisce») non cambia per i codici senza omocodia.
        const riga = per(await leggi(), ALU_NORMALE_COMBACIA)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('non-verificabile')
        expect(riga.proposta_combacia).toBe(true)
        expect(scrivibile(riga)).toBe(false)
    })

    it('omocodico senza luogo di nascita: resta, come il suo gemello senza omocodia, e senza «Applica»', async () => {
        // Qui l'omocodia non c'entra: manca il luogo, e il pannello lo dice come
        // per ogni altro codice. Non c'è una proposta, quindi niente da sovrascrivere.
        const riga = per(await leggi(), ALU_OMO_SENZA_LUOGO)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('non-verificabile')
        expect(riga.motivi).toEqual([])
        expect(riga.non_verificabili).toEqual(['luogo-nascita'])
        expect(riga.codice_proposto).toBeNull()
        expect(scrivibile(riga)).toBe(false)
    })
})

describe('(b) omocodico INCOERENTE: l’avviso resta, e «Applica» pure', () => {
    it('colonna Belfiore valorizzata, cognome diverso: incoerente con la proposta', async () => {
        const riga = per(await leggi(), ALU_OMO_INCOERENTE_COLONNA)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['cognome'])
        expect(riga.codice_attuale).toBe(CF.omoStortoAltrui)
        expect(riga.codice_proposto).toBe(calcola(OMOSTORTO))
        expect(scrivibile(riga)).toBe(true)
    })

    it('colonna Belfiore vuota + comune risolto: incoerente con la proposta', async () => {
        const riga = per(await leggi(), ALU_OMO_INCOERENTE_RISOLTO)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['cognome'])
        expect(riga.codice_proposto).toBe(calcola(OMOSTORTO))
        expect(scrivibile(riga)).toBe(true)
    })

    it('colonna Belfiore vuota + comune che si risolve in un ALTRO Belfiore: non-verificabile, proposta diversa, «Applica»', async () => {
        // Premessa: Napoli si risolve davvero, e non in H501 — altrimenti il caso non esiste.
        const napoli = risolviComune('Napoli', 'NA')
        expect(napoli.esito).toBe('trovato')
        const belfioreNapoli = napoli.esito === 'trovato' ? napoli.comune.belfiore : ''
        expect(belfioreNapoli).not.toBe('H501')

        // La verifica usa solo la colonna (vuota): sui campi confrontabili il codice
        // torna, quindi `non-verificabile`. Ma la proposta, col Belfiore risolto, è
        // diversa dalla base: sul luogo il codice NON è coerente coi dati, e
        // l'operatore deve poter decidere. Nascondere ogni omocodico «coerente»
        // con una proposta farebbe sparire questa riga in silenzio.
        const riga = per(await leggi(), ALU_OMO_LUOGO_DIVERSO)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('non-verificabile')
        expect(riga.motivi).toEqual([])
        expect(riga.non_verificabili).toContain('luogo-nascita')
        expect(riga.codice_attuale).toBe(CF.omoLuogoDiverso)
        expect(riga.codice_proposto).toBe(calcola({ ...LUOGODIVERSO, codiceBelfiore: belfioreNapoli }))
        expect(riga.proposta_combacia).toBe(false)
        expect(scrivibile(riga)).toBe(true)
    })

    it('genitore, nome diverso: incoerente con «Applica»', async () => {
        const riga = per(await leggi(), PAR_OMO_INCOERENTE_RISOLTO)!
        expect(riga).toBeDefined()
        expect(riga.tipo).toBe('genitore')
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['nome'])
        expect(riga.codice_proposto).toBe(calcola(GENITORE_STORTO))
        expect(scrivibile(riga)).toBe(true)
    })

    it('omocodico con la CHECKSUM sbagliata la cui base coincide col calcolato: resta, rosso, con «Applica»', async () => {
        // È il caso che una correzione fatta solo su `baseSenzaOmocodia` nasconderebbe:
        // la base torna, ma il codice scritto NON è valido. Non è un omocodico coerente.
        const riga = per(await leggi(), ALU_OMO_CHECKSUM_ERRATA)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['cf-checksum'])
        expect(riga.codice_proposto).toBe(calcola(OMOCHECK))
        expect(scrivibile(riga)).toBe(true)
    })
})

describe('un codice NON omocodico incoerente: invariato', () => {
    it('nome diverso, colonna valorizzata: incoerente, proposta, «Applica»', async () => {
        const riga = per(await leggi(), ALU_NORMALE_INCOERENTE)!
        expect(riga).toBeDefined()
        expect(riga.stato).toBe('incoerente')
        expect(riga.motivi).toEqual(['nome'])
        expect(riga.codice_attuale).toBe(CF.normaleAltrui)
        expect(riga.codice_proposto).toBe(calcola(NORMALE))
        expect(riga.proposta_combacia).toBe(false)
        expect(riga.priorita).toBe(0)
    })

    it('l’elenco completo è esattamente quello atteso', async () => {
        const corpo = await leggi()
        expect(corpo.righe.map((r) => r.id).sort()).toEqual([
            ALU_OMO_INCOERENTE_COLONNA,
            ALU_OMO_INCOERENTE_RISOLTO,
            ALU_OMO_SENZA_LUOGO,
            ALU_OMO_CHECKSUM_ERRATA,
            ALU_OMO_LUOGO_DIVERSO,
            ALU_NORMALE_INCOERENTE,
            ALU_NORMALE_COMBACIA,
            PAR_OMO_INCOERENTE_RISOLTO,
        ].sort())
        expect(corpo.totale).toBe(8)
    })
})
