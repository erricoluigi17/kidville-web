import { describe, expect, it } from 'vitest'
import { calcolaSlotLiberi, fuoriDisponibilita } from '@/lib/crm/slot'
import type { FasciaEffettiva } from '@/lib/crm/settimane'
import type { AppuntamentoRow, IndisponibilitaRow } from '@/lib/crm/tipi'
import { SEDE_A } from '../../fixtures/sedi'

/**
 * GLI SLOT LIBERI · fasce della settimana − assenze − visite in programma.
 *
 * Le fasce sono `FasciaEffettiva`: già risolte per UNA settimana (il suo lunedì in `settimana`), della persona
 * o della sede (`utenteId: null`). Una fascia vale solo nella settimana in cui è scritta.
 *
 * Tutto lavora su GIORNI CIVILI di Roma (`YYYY-MM-DD`) e produce istanti UTC: la funzione non guarda
 * l'orologio (`adesso` è un argomento), quindi nessun test dipende dalla data in cui gira.
 *
 * Calendario di riferimento (verificato): lunedì 2026-10-26, domenica 2026-10-25, sabato 2026-10-24.
 * L'ora legale è finita alle 3 di notte di domenica 25/10/2026: sabato Roma è +02:00, domenica +01:00.
 */

const PERSONA_1 = '30000000-0000-4000-8000-000000000001'
const PERSONA_2 = '30000000-0000-4000-8000-000000000002'

/** Prima di ogni giorno provato (tranne marzo 2026, che passa il proprio `adesso`): il filtro «prima di adesso» non tocca niente. */
const ADESSO_LONTANO = new Date('2026-09-01T00:00:00Z')

/** Il lunedì della settimana su cui lavorano quasi tutte le prove. */
const LUNEDI = '2026-10-26'
/** Il lunedì della settimana che finisce con la domenica del cambio dell'ora (25/10/2026). */
const LUNEDI_PRIMA = '2026-10-19'

type DatiFascia = Partial<FasciaEffettiva> & Pick<FasciaEffettiva, 'giornoSettimana' | 'oraInizio' | 'oraFine'>

function fascia(o: DatiFascia): FasciaEffettiva {
    return { utenteId: PERSONA_1, settimana: LUNEDI, durataSlotMin: 45, ...o }
}

/** Una fascia della SEDE: nessun proprietario, la sceglie chi fissa. */
const fasciaSede = (o: DatiFascia) => fascia({ ...o, utenteId: null })

function indisp(o: Partial<IndisponibilitaRow> & Pick<IndisponibilitaRow, 'dal' | 'al'>): IndisponibilitaRow {
    return {
        id: 'i-1',
        scuola_id: SEDE_A,
        utente_id: PERSONA_1,
        motivo: 'ferie',
        creata_da: null,
        creata_il: '2026-01-01T00:00:00Z',
        ...o,
    }
}

type AppDiProva = Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine' | 'stato'>
function app(o: Partial<AppDiProva> & Pick<AppDiProva, 'inizio' | 'fine'>): AppDiProva {
    return { assegnata_a: PERSONA_1, stato: 'in_programma', ...o }
}

function slot(i: Partial<Parameters<typeof calcolaSlotLiberi>[0]> & { fasce: FasciaEffettiva[]; dal: string; al: string }) {
    return calcolaSlotLiberi({ persone: [PERSONA_1, PERSONA_2], indisponibilita: [], appuntamenti: [], adesso: ADESSO_LONTANO, ...i })
}

describe('calcolaSlotLiberi · la regola', () => {
    it('lunedì 9:00–11:00 da 45 min → 9:00 e 9:45, non 10:30', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00:00', oraFine: '11:00:00' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        // Lunedì 26/10/2026 è già ora solare (+01:00): 9:00 → 08:00Z, 9:45 → 08:45Z.
        expect(r).toEqual([
            { utenteId: PERSONA_1, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' },
            { utenteId: PERSONA_1, inizio: '2026-10-26T08:45:00.000Z', fine: '2026-10-26T09:30:00.000Z' },
        ])
    })

    it('uno slot che finirebbe oltre ora_fine non si taglia: 10:30 + 45 min sfora le 11:00', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30', durataSlotMin: 45 })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z', '2026-10-26T08:45:00.000Z'])
    })

    it('un appuntamento in programma toglie lo slot; uno annullato no', () => {
        const base = {
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00:00', oraFine: '10:30:00' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        }
        const occupato = app({ inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })

        expect(slot({ ...base, appuntamenti: [occupato] }).map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
        expect(slot({ ...base, appuntamenti: [{ ...occupato, stato: 'annullato' }] }).map((s) => s.inizio)).toEqual([
            '2026-10-26T08:00:00.000Z',
            '2026-10-26T08:45:00.000Z',
        ])
        // Né una visita già svolta, né una non presentata, occupa più l'orario: l'EXCLUDE del database vale solo `in_programma`.
        for (const stato of ['svolto', 'non_presentato'] as const) {
            expect(slot({ ...base, appuntamenti: [{ ...occupato, stato }] }), stato).toHaveLength(2)
        }
    })

    it('la visita di un’altra persona non toglie lo slot', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })],
            appuntamenti: [app({ assegnata_a: PERSONA_2, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toHaveLength(1)
    })

    it('una visita che si sovrappone solo in parte toglie lo slot; una che inizia quando finisce lo slot no', () => {
        const fasce = [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })]
        const parziale = app({ inizio: '2026-10-26T08:30:00.000Z', fine: '2026-10-26T09:15:00.000Z' })
        const adiacente = app({ inizio: '2026-10-26T08:45:00.000Z', fine: '2026-10-26T09:30:00.000Z' })
        expect(slot({ fasce, appuntamenti: [parziale], dal: '2026-10-26', al: '2026-10-26' })).toHaveLength(0)
        expect(slot({ fasce, appuntamenti: [adiacente], dal: '2026-10-26', al: '2026-10-26' })).toHaveLength(1)
    })

    it('la chiusura di sede toglie gli slot di tutte', () => {
        const r = slot({
            fasce: [
                fascia({ utenteId: PERSONA_1, giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
                fascia({ utenteId: PERSONA_2, giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
            ],
            // Tutto lunedì 26/10 (00:00 → 24:00 di Roma), per la sede intera.
            indisponibilita: [indisp({ utente_id: null, motivo: 'chiusura', dal: '2026-10-25T23:00:00.000Z', al: '2026-10-26T23:00:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toEqual([])
    })

    it('l’assenza di una persona non toglie gli slot della collega', () => {
        const r = slot({
            fasce: [
                fascia({ utenteId: PERSONA_1, giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
                fascia({ utenteId: PERSONA_2, giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
            ],
            indisponibilita: [indisp({ utente_id: PERSONA_1, dal: '2026-10-25T23:00:00.000Z', al: '2026-10-26T23:00:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.utenteId)).toEqual([PERSONA_2])
    })

    it('un’assenza che finisce quando inizia lo slot lo lascia libero', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })],
            indisponibilita: [indisp({ dal: '2026-10-26T07:00:00.000Z', al: '2026-10-26T08:00:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toHaveLength(1)
    })

    it('una fascia vale solo nella sua settimana', () => {
        const fasce = [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45', settimana: LUNEDI })]
        // Tre lunedì nel periodo (19/10, 26/10, 2/11): solo quello della settimana della fascia ha lo slot.
        expect(slot({ fasce, dal: '2026-10-19', al: '2026-11-08' }).map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z'])
    })

    it('una fascia della settimana scorsa non vale in questa, e una della prossima nemmeno', () => {
        const base = { giornoSettimana: 1, oraInizio: '09:00', oraFine: '11:00' }
        expect(slot({ fasce: [fascia({ ...base, settimana: LUNEDI_PRIMA })], dal: '2026-10-26', al: '2026-10-26' })).toEqual([])
        expect(slot({ fasce: [fascia({ ...base, settimana: '2026-11-02' })], dal: '2026-10-26', al: '2026-10-26' })).toEqual([])
    })

    it('la settimana va dal lunedì alla domenica, estremi compresi: il 7 della settimana del 19 è il 25, non il 1/11', () => {
        const fasce = [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '10:45', settimana: LUNEDI_PRIMA })]
        const r = slot({ fasce, dal: '2026-10-19', al: '2026-11-01' })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-25T09:00:00.000Z'])
    })

    it('due settimane diverse della stessa persona danno ciascuna i propri slot', () => {
        const fasce = [
            fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45', settimana: '2026-10-19' }),
            fascia({ giornoSettimana: 3, oraInizio: '15:00', oraFine: '15:45', settimana: '2026-10-26' }),
        ]
        const r = slot({ fasce, dal: '2026-10-19', al: '2026-11-01' })
        // Lunedì 19/10 alle 9:00 è ancora ora legale (+02:00 → 07:00Z); mercoledì 28/10 alle 15:00 è ora solare (14:00Z).
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-19T07:00:00.000Z', '2026-10-28T14:00:00.000Z'])
    })

    it('il giorno della settimana è quello ISO: 1 = lunedì, 7 = domenica', () => {
        const fasce = [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '10:45' })]
        // Dal lunedì 26/10 al domenica 1/11: l'unico giorno 7 è il 1/11.
        const r = slot({ fasce, dal: '2026-10-26', al: '2026-11-01' })
        expect(r.map((s) => s.inizio)).toEqual(['2026-11-01T09:00:00.000Z'])
    })

    it('ordina per inizio e, a parità, per persona', () => {
        const r = slot({
            fasce: [
                fascia({ utenteId: PERSONA_2, giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
                fascia({ utenteId: PERSONA_1, giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30' }),
            ],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => [s.inizio, s.utenteId])).toEqual([
            ['2026-10-26T08:00:00.000Z', PERSONA_1],
            ['2026-10-26T08:00:00.000Z', PERSONA_2],
            ['2026-10-26T08:45:00.000Z', PERSONA_1],
        ])
    })

    it('due righe di disponibilità che coprono lo stesso orario non producono lo slot due volte', () => {
        const r = slot({
            fasce: [
                fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30' }),
                fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
            ],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z', '2026-10-26T08:45:00.000Z'])
    })

    it('dal dopo al → nessuno slot', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '11:00' })],
            dal: '2026-10-27',
            al: '2026-10-26',
        })
        expect(r).toEqual([])
    })
})

describe('calcolaSlotLiberi · adesso', () => {
    const fasce = [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30' })]

    it('nessuno slot prima di adesso', () => {
        // Lunedì 26/10 alle 08:30Z (le 9:30 di Roma): lo slot delle 9:00 è passato, quello delle 9:45 no.
        const r = slot({ fasce, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-26T08:30:00.000Z') })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
    })

    it('uno slot che inizia esattamente adesso è ancora prenotabile', () => {
        const r = slot({ fasce, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-26T08:45:00.000Z') })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
    })

    it('tutto il giorno nel passato → nessuno slot', () => {
        const r = slot({ fasce, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-27T00:00:00.000Z') })
        expect(r).toEqual([])
    })
})

describe('calcolaSlotLiberi · la fascia della sede', () => {
    // Lunedì 26/10/2026 9:00–10:30 da 45 minuti → 9:00 (08:00Z) e 9:45 (08:45Z).
    const fasce = [fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30' })]
    const lunedi = { dal: '2026-10-26', al: '2026-10-26' }

    it('libera finché una persona è libera, e personeLibere dice solo quella (spec §8.7)', () => {
        const r = slot({
            fasce,
            ...lunedi,
            // A ha una visita alle 9:00; B è in ferie alle 9:45.
            appuntamenti: [app({ assegnata_a: PERSONA_1, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
            indisponibilita: [indisp({ utente_id: PERSONA_2, dal: '2026-10-26T08:45:00.000Z', al: '2026-10-26T09:30:00.000Z' })],
        })
        expect(r).toEqual([
            { utenteId: null, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z', personeLibere: [PERSONA_2] },
            { utenteId: null, inizio: '2026-10-26T08:45:00.000Z', fine: '2026-10-26T09:30:00.000Z', personeLibere: [PERSONA_1] },
        ])
    })

    it('se tutte sono libere le propone tutte, nell’ordine in cui arrivano', () => {
        const dritto = slot({ fasce, ...lunedi, persone: [PERSONA_1, PERSONA_2] })
        const rovescio = slot({ fasce, ...lunedi, persone: [PERSONA_2, PERSONA_1] })
        expect(dritto[0].personeLibere).toEqual([PERSONA_1, PERSONA_2])
        expect(rovescio[0].personeLibere).toEqual([PERSONA_2, PERSONA_1])
    })

    it('nessuna persona libera → nessuno slot', () => {
        const r = slot({
            fasce,
            ...lunedi,
            appuntamenti: [app({ assegnata_a: PERSONA_1, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
            indisponibilita: [indisp({ utente_id: PERSONA_2, dal: '2026-10-26T07:00:00.000Z', al: '2026-10-26T08:30:00.000Z' })],
        })
        // Lo slot delle 9:00 non ha nessuno; quello delle 9:45 le ha entrambe.
        expect(r.map((s) => [s.inizio, s.personeLibere])).toEqual([['2026-10-26T08:45:00.000Z', [PERSONA_1, PERSONA_2]]])
    })

    it('una chiusura di sede toglie lo slot della sede', () => {
        const r = slot({
            fasce,
            ...lunedi,
            indisponibilita: [indisp({ utente_id: null, motivo: 'chiusura', dal: '2026-10-25T23:00:00.000Z', al: '2026-10-26T23:00:00.000Z' })],
        })
        expect(r).toEqual([])
    })

    it('senza persone nella sede non c’è nessuno a cui dare la visita: nessuno slot', () => {
        expect(slot({ fasce, ...lunedi, persone: [] })).toEqual([])
    })

    it('una visita annullata (o già svolta) non occupa la persona', () => {
        const r = slot({
            fasce,
            ...lunedi,
            persone: [PERSONA_1],
            appuntamenti: [app({ stato: 'annullato', inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
        })
        expect(r.map((s) => s.personeLibere)).toEqual([[PERSONA_1], [PERSONA_1]])
    })

    it('la visita di chi non è nell’elenco delle persone non toglie nessuno', () => {
        const r = slot({
            fasce,
            ...lunedi,
            persone: [PERSONA_1],
            appuntamenti: [app({ assegnata_a: PERSONA_2, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
        })
        expect(r[0].personeLibere).toEqual([PERSONA_1])
    })

    it('persona e sede alla stessa ora: si vedono entrambi gli slot, quello della persona per primo', () => {
        const r = slot({
            fasce: [
                fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
                fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45', utenteId: PERSONA_1 }),
            ],
            ...lunedi,
        })
        expect(r).toEqual([
            { utenteId: PERSONA_1, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' },
            { utenteId: null, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z', personeLibere: [PERSONA_1, PERSONA_2] },
        ])
    })

    it('uno slot di persona non porta personeLibere', () => {
        const r = slot({ fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })], ...lunedi })
        expect(r).toHaveLength(1)
        expect(r[0]).not.toHaveProperty('personeLibere')
    })

    it('due fasce della sede che si coprono non offrono lo stesso orario due volte', () => {
        const r = slot({
            fasce: [
                fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '10:30' }),
                fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' }),
            ],
            ...lunedi,
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z', '2026-10-26T08:45:00.000Z'])
    })

    it('nessuno slot della sede prima di adesso', () => {
        const r = slot({ fasce, ...lunedi, adesso: new Date('2026-10-26T08:30:00.000Z') })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
    })

    it('anche la fascia della sede vale solo nella sua settimana', () => {
        const altra = [fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45', settimana: LUNEDI_PRIMA })]
        expect(slot({ fasce: altra, ...lunedi })).toEqual([])
    })
})

describe('calcolaSlotLiberi · il cambio dell’ora legale (Da tenere d’occhio 5)', () => {
    it('lunedì 26/10/2026 alle 9:00 di Roma è 08:00 UTC (la settimana del cambio dell’ora, Da tenere d’occhio 5)', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z'])
        // …e la stessa fascia della sede, nello stesso giorno, ha lo stesso istante.
        const sede = slot({ fasce: [fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '09:45' })], dal: '2026-10-26', al: '2026-10-26' })
        expect(sede.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z'])
    })

    it('domenica 25/10/2026 alle 10:00 di Roma = 09:00Z', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '10:45', settimana: LUNEDI_PRIMA })],
            dal: '2026-10-25',
            al: '2026-10-25',
        })
        expect(r).toEqual([{ utenteId: PERSONA_1, inizio: '2026-10-25T09:00:00.000Z', fine: '2026-10-25T09:45:00.000Z' }])
    })

    it('sabato 24/10/2026 alle 10:00 di Roma = 08:00Z, il giorno prima è un’ora indietro', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 6, oraInizio: '10:00', oraFine: '10:45', settimana: LUNEDI_PRIMA })],
            dal: '2026-10-24',
            al: '2026-10-24',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-24T08:00:00.000Z'])
    })

    it('la stessa ora di Roma resta la stessa ora di Roma attraverso il cambio: sabato e domenica alle 10:00', () => {
        const r = slot({
            fasce: [
                fascia({ giornoSettimana: 6, oraInizio: '10:00', oraFine: '10:45', settimana: LUNEDI_PRIMA }),
                fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '10:45', settimana: LUNEDI_PRIMA }),
            ],
            dal: '2026-10-24',
            al: '2026-10-25',
        })
        // Fra i due slot passano 25 ore reali, non 24: è esattamente l'ora in più dell'autunno.
        const [sabato, domenica] = r.map((s) => Date.parse(s.inizio))
        expect((domenica - sabato) / 3_600_000).toBe(25)
    })

    it('primavera: domenica 29/03/2026 alle 10:00 di Roma = 08:00Z (ora legale, +02:00)', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '10:45', settimana: '2026-03-23' })],
            dal: '2026-03-29',
            al: '2026-03-29',
            // `adesso` di default (settembre 2026) sta DOPO questo giorno: gli slot di marzo sarebbero «passati».
            adesso: new Date('2026-01-01T00:00:00Z'),
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-03-29T08:00:00.000Z'])
    })

    it('una visita fissata domenica alle 10:00 di Roma occupa quello slot e non quello di un’ora dopo', () => {
        const r = slot({
            fasce: [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '11:30', settimana: LUNEDI_PRIMA })],
            appuntamenti: [app({ inizio: '2026-10-25T09:00:00.000Z', fine: '2026-10-25T09:45:00.000Z' })],
            dal: '2026-10-25',
            al: '2026-10-25',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-25T09:45:00.000Z'])
    })
})

describe('fuoriDisponibilita', () => {
    const lunedi9_13 = [fascia({ giornoSettimana: 1, oraInizio: '09:00:00', oraFine: '13:00:00' })]
    const visita = (inizio: string, fine: string, assegnata_a = PERSONA_1) => ({ assegnata_a, inizio, fine })

    it('visita alle 18:00 con disponibilità 9–13 → true', () => {
        // 18:00 di Roma, lunedì 26/10 = 17:00Z.
        expect(fuoriDisponibilita(visita('2026-10-26T17:00:00.000Z', '2026-10-26T17:45:00.000Z'), lunedi9_13, [])).toBe(true)
    })

    it('visita alle 10:00 con disponibilità 9–13 → false, anche se non cade sulla griglia degli slot', () => {
        expect(fuoriDisponibilita(visita('2026-10-26T09:10:00.000Z', '2026-10-26T09:55:00.000Z'), lunedi9_13, [])).toBe(false)
    })

    it('una visita che sfora l’ora di fine è fuori: 12:30–13:15 con disponibilità fino alle 13', () => {
        expect(fuoriDisponibilita(visita('2026-10-26T11:30:00.000Z', '2026-10-26T12:15:00.000Z'), lunedi9_13, [])).toBe(true)
    })

    it('visita in un giorno senza disponibilità → true', () => {
        // Martedì 27/10.
        expect(fuoriDisponibilita(visita('2026-10-27T09:00:00.000Z', '2026-10-27T09:45:00.000Z'), lunedi9_13, [])).toBe(true)
    })

    it('la disponibilità di un’altra persona non conta', () => {
        const dellaCollega = [fascia({ utenteId: PERSONA_2, giornoSettimana: 1, oraInizio: '09:00', oraFine: '13:00' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), dellaCollega, [])).toBe(true)
    })

    it('una fascia di un’altra settimana non conta, né quella della scorsa né quella della prossima', () => {
        const base = { giornoSettimana: 1, oraInizio: '09:00', oraFine: '13:00' }
        const v = visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z')
        expect(fuoriDisponibilita(v, [fascia({ ...base, settimana: LUNEDI_PRIMA })], [])).toBe(true)
        expect(fuoriDisponibilita(v, [fascia({ ...base, settimana: '2026-11-02' })], [])).toBe(true)
        expect(fuoriDisponibilita(v, [fascia({ ...base, settimana: LUNEDI })], [])).toBe(false)
    })

    describe('la fascia della sede', () => {
        const sede9_13 = [fasciaSede({ giornoSettimana: 1, oraInizio: '09:00:00', oraFine: '13:00:00' })]

        it('una visita dentro una fascia della sede non è fuori, a chiunque sia assegnata', () => {
            const v = (assegnata_a: string) => visita('2026-10-26T09:10:00.000Z', '2026-10-26T09:55:00.000Z', assegnata_a)
            expect(fuoriDisponibilita(v(PERSONA_1), sede9_13, [])).toBe(false)
            expect(fuoriDisponibilita(v(PERSONA_2), sede9_13, [])).toBe(false)
        })

        it('una visita fuori dalla fascia della sede (o che sfora) è fuori', () => {
            expect(fuoriDisponibilita(visita('2026-10-26T17:00:00.000Z', '2026-10-26T17:45:00.000Z'), sede9_13, [])).toBe(true)
            expect(fuoriDisponibilita(visita('2026-10-26T11:30:00.000Z', '2026-10-26T12:15:00.000Z'), sede9_13, [])).toBe(true)
        })

        it('basta una delle due: la fascia della persona o quella della sede', () => {
            const soloPersona = [fascia({ giornoSettimana: 1, oraInizio: '14:00', oraFine: '16:00' })]
            const mattina = visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z') // 10:00 di Roma
            const pomeriggio = visita('2026-10-26T13:30:00.000Z', '2026-10-26T14:15:00.000Z') // 14:30 di Roma
            const entrambe = [...sede9_13, ...soloPersona]
            expect(fuoriDisponibilita(mattina, soloPersona, [])).toBe(true)
            expect(fuoriDisponibilita(mattina, entrambe, [])).toBe(false) // la sede
            expect(fuoriDisponibilita(pomeriggio, entrambe, [])).toBe(false) // la persona
        })

        it('una fascia della sede non salva una visita durante le ferie della persona o la chiusura della sede', () => {
            const v = visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z')
            const ferie = [indisp({ dal: '2026-10-25T23:00:00.000Z', al: '2026-10-27T23:00:00.000Z' })]
            const chiusura = [indisp({ utente_id: null, motivo: 'chiusura', dal: '2026-10-26T08:00:00.000Z', al: '2026-10-26T10:00:00.000Z' })]
            expect(fuoriDisponibilita(v, sede9_13, ferie)).toBe(true)
            expect(fuoriDisponibilita(v, sede9_13, chiusura)).toBe(true)
        })

        it('la fascia della sede di un’altra settimana non conta', () => {
            const altra = [fasciaSede({ giornoSettimana: 1, oraInizio: '09:00', oraFine: '13:00', settimana: LUNEDI_PRIMA })]
            expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), altra, [])).toBe(true)
        })
    })

    it('dentro l’orario ma durante le ferie → true', () => {
        const ferie = [indisp({ dal: '2026-10-25T23:00:00.000Z', al: '2026-10-27T23:00:00.000Z' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), lunedi9_13, ferie)).toBe(true)
    })

    it('dentro l’orario durante la chiusura di sede → true', () => {
        const chiusura = [indisp({ utente_id: null, motivo: 'chiusura', dal: '2026-10-26T08:00:00.000Z', al: '2026-10-26T10:00:00.000Z' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), lunedi9_13, chiusura)).toBe(true)
    })

    it('le ferie di un’altra persona non contano', () => {
        const ferieDellaCollega = [indisp({ utente_id: PERSONA_2, dal: '2026-10-25T23:00:00.000Z', al: '2026-10-27T23:00:00.000Z' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), lunedi9_13, ferieDellaCollega)).toBe(false)
    })

    it('il giorno si legge a Roma, non in UTC: lunedì 00:30 di Roma è ancora domenica sera in UTC', () => {
        // 26/10/2026 00:30 a Roma = 25/10 23:30Z. Disponibilità del lunedì 0:00–1:00 → dentro.
        const notte = [fascia({ giornoSettimana: 1, oraInizio: '00:00', oraFine: '01:00' })]
        expect(fuoriDisponibilita(visita('2026-10-25T23:30:00.000Z', '2026-10-26T00:00:00.000Z'), notte, [])).toBe(false)
    })

    it('domenica 25/10/2026 alle 10:00 di Roma (09:00Z) è dentro una disponibilità 10–11 della domenica', () => {
        const domenica = [fascia({ giornoSettimana: 7, oraInizio: '10:00', oraFine: '11:00', settimana: LUNEDI_PRIMA })]
        expect(fuoriDisponibilita(visita('2026-10-25T09:00:00.000Z', '2026-10-25T09:45:00.000Z'), domenica, [])).toBe(false)
        // Un'ora prima (08:00Z = 09:00 di Roma, ora solare) è fuori: l'ora legale NON sposta la finestra.
        expect(fuoriDisponibilita(visita('2026-10-25T08:00:00.000Z', '2026-10-25T08:45:00.000Z'), domenica, [])).toBe(true)
    })
})
