import { describe, expect, it } from 'vitest'
import { calcolaSlotLiberi, fuoriDisponibilita } from '@/lib/crm/slot'
import type { AppuntamentoRow, DisponibilitaRow, IndisponibilitaRow } from '@/lib/crm/tipi'
import { SEDE_A } from '../../fixtures/sedi'

/**
 * GLI SLOT LIBERI · disponibilità settimanale − assenze − visite in programma.
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

function disp(o: Partial<DisponibilitaRow> & Pick<DisponibilitaRow, 'giorno_settimana' | 'ora_inizio' | 'ora_fine'>): DisponibilitaRow {
    return {
        id: 'd-1',
        scuola_id: SEDE_A,
        utente_id: PERSONA_1,
        durata_slot_min: 45,
        valida_dal: '2026-01-01',
        valida_al: null,
        creata_il: '2026-01-01T00:00:00Z',
        ...o,
    }
}

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

function slot(i: Partial<Parameters<typeof calcolaSlotLiberi>[0]> & { disponibilita: DisponibilitaRow[]; dal: string; al: string }) {
    return calcolaSlotLiberi({ indisponibilita: [], appuntamenti: [], adesso: ADESSO_LONTANO, ...i })
}

describe('calcolaSlotLiberi · la regola', () => {
    it('lunedì 9:00–11:00 da 45 min → 9:00 e 9:45, non 10:30', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '11:00:00' })],
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
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '10:30', durata_slot_min: 45 })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z', '2026-10-26T08:45:00.000Z'])
    })

    it('un appuntamento in programma toglie lo slot; uno annullato no', () => {
        const base = {
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '10:30:00' })],
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
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' })],
            appuntamenti: [app({ assegnata_a: PERSONA_2, inizio: '2026-10-26T08:00:00.000Z', fine: '2026-10-26T08:45:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toHaveLength(1)
    })

    it('una visita che si sovrappone solo in parte toglie lo slot; una che inizia quando finisce lo slot no', () => {
        const disponibilita = [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' })]
        const parziale = app({ inizio: '2026-10-26T08:30:00.000Z', fine: '2026-10-26T09:15:00.000Z' })
        const adiacente = app({ inizio: '2026-10-26T08:45:00.000Z', fine: '2026-10-26T09:30:00.000Z' })
        expect(slot({ disponibilita, appuntamenti: [parziale], dal: '2026-10-26', al: '2026-10-26' })).toHaveLength(0)
        expect(slot({ disponibilita, appuntamenti: [adiacente], dal: '2026-10-26', al: '2026-10-26' })).toHaveLength(1)
    })

    it('la chiusura di sede toglie gli slot di tutte', () => {
        const r = slot({
            disponibilita: [
                disp({ id: 'd-1', utente_id: PERSONA_1, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
                disp({ id: 'd-2', utente_id: PERSONA_2, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
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
            disponibilita: [
                disp({ id: 'd-1', utente_id: PERSONA_1, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
                disp({ id: 'd-2', utente_id: PERSONA_2, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
            ],
            indisponibilita: [indisp({ utente_id: PERSONA_1, dal: '2026-10-25T23:00:00.000Z', al: '2026-10-26T23:00:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.utenteId)).toEqual([PERSONA_2])
    })

    it('un’assenza che finisce quando inizia lo slot lo lascia libero', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' })],
            indisponibilita: [indisp({ dal: '2026-10-26T07:00:00.000Z', al: '2026-10-26T08:00:00.000Z' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toHaveLength(1)
    })

    it('valida_al nel passato → nessuno slot', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '11:00', valida_al: '2026-10-19' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toEqual([])
    })

    it('valida_al è inclusa; valida_dal anche', () => {
        const disponibilita = [
            disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45', valida_dal: '2026-10-26', valida_al: '2026-10-26' }),
        ]
        expect(slot({ disponibilita, dal: '2026-10-19', al: '2026-11-09' })).toHaveLength(1)
    })

    it('valida_dal nel futuro → nessuno slot prima', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45', valida_dal: '2026-11-02' })],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r).toEqual([])
    })

    it('il giorno della settimana è quello ISO: 1 = lunedì, 7 = domenica', () => {
        const disponibilita = [disp({ giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '10:45' })]
        // Dal lunedì 26/10 al domenica 1/11: l'unico giorno 7 è il 1/11.
        const r = slot({ disponibilita, dal: '2026-10-26', al: '2026-11-01' })
        expect(r.map((s) => s.inizio)).toEqual(['2026-11-01T09:00:00.000Z'])
    })

    it('ordina per inizio e, a parità, per persona', () => {
        const r = slot({
            disponibilita: [
                disp({ id: 'd-2', utente_id: PERSONA_2, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
                disp({ id: 'd-1', utente_id: PERSONA_1, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '10:30' }),
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
            disponibilita: [
                disp({ id: 'd-1', giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '10:30' }),
                disp({ id: 'd-2', giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '09:45' }),
            ],
            dal: '2026-10-26',
            al: '2026-10-26',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:00:00.000Z', '2026-10-26T08:45:00.000Z'])
    })

    it('dal dopo al → nessuno slot', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '11:00' })],
            dal: '2026-10-27',
            al: '2026-10-26',
        })
        expect(r).toEqual([])
    })
})

describe('calcolaSlotLiberi · adesso', () => {
    const disponibilita = [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '10:30' })]

    it('nessuno slot prima di adesso', () => {
        // Lunedì 26/10 alle 08:30Z (le 9:30 di Roma): lo slot delle 9:00 è passato, quello delle 9:45 no.
        const r = slot({ disponibilita, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-26T08:30:00.000Z') })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
    })

    it('uno slot che inizia esattamente adesso è ancora prenotabile', () => {
        const r = slot({ disponibilita, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-26T08:45:00.000Z') })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-26T08:45:00.000Z'])
    })

    it('tutto il giorno nel passato → nessuno slot', () => {
        const r = slot({ disponibilita, dal: '2026-10-26', al: '2026-10-26', adesso: new Date('2026-10-27T00:00:00.000Z') })
        expect(r).toEqual([])
    })
})

describe('calcolaSlotLiberi · il cambio dell’ora legale (Da tenere d’occhio 5)', () => {
    it('domenica 25/10/2026 alle 10:00 di Roma = 09:00Z', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '10:45' })],
            dal: '2026-10-25',
            al: '2026-10-25',
        })
        expect(r).toEqual([{ utenteId: PERSONA_1, inizio: '2026-10-25T09:00:00.000Z', fine: '2026-10-25T09:45:00.000Z' }])
    })

    it('sabato 24/10/2026 alle 10:00 di Roma = 08:00Z, il giorno prima è un’ora indietro', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 6, ora_inizio: '10:00', ora_fine: '10:45' })],
            dal: '2026-10-24',
            al: '2026-10-24',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-24T08:00:00.000Z'])
    })

    it('la stessa ora di Roma resta la stessa ora di Roma attraverso il cambio: sabato e domenica alle 10:00', () => {
        const r = slot({
            disponibilita: [
                disp({ id: 'd-1', giorno_settimana: 6, ora_inizio: '10:00', ora_fine: '10:45' }),
                disp({ id: 'd-2', giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '10:45' }),
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
            disponibilita: [disp({ giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '10:45' })],
            dal: '2026-03-29',
            al: '2026-03-29',
            // `adesso` di default (settembre 2026) sta DOPO questo giorno: gli slot di marzo sarebbero «passati».
            adesso: new Date('2026-01-01T00:00:00Z'),
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-03-29T08:00:00.000Z'])
    })

    it('una visita fissata domenica alle 10:00 di Roma occupa quello slot e non quello di un’ora dopo', () => {
        const r = slot({
            disponibilita: [disp({ giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '11:30' })],
            appuntamenti: [app({ inizio: '2026-10-25T09:00:00.000Z', fine: '2026-10-25T09:45:00.000Z' })],
            dal: '2026-10-25',
            al: '2026-10-25',
        })
        expect(r.map((s) => s.inizio)).toEqual(['2026-10-25T09:45:00.000Z'])
    })
})

describe('fuoriDisponibilita', () => {
    const lunedi9_13 = [disp({ giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '13:00:00' })]
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
        const dellaCollega = [disp({ utente_id: PERSONA_2, giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '13:00' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), dellaCollega, [])).toBe(true)
    })

    it('una disponibilità scaduta non conta', () => {
        const scaduta = [disp({ giorno_settimana: 1, ora_inizio: '09:00', ora_fine: '13:00', valida_al: '2026-10-19' })]
        expect(fuoriDisponibilita(visita('2026-10-26T09:00:00.000Z', '2026-10-26T09:45:00.000Z'), scaduta, [])).toBe(true)
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
        const notte = [disp({ giorno_settimana: 1, ora_inizio: '00:00', ora_fine: '01:00' })]
        expect(fuoriDisponibilita(visita('2026-10-25T23:30:00.000Z', '2026-10-26T00:00:00.000Z'), notte, [])).toBe(false)
    })

    it('domenica 25/10/2026 alle 10:00 di Roma (09:00Z) è dentro una disponibilità 10–11 della domenica', () => {
        const domenica = [disp({ giorno_settimana: 7, ora_inizio: '10:00', ora_fine: '11:00' })]
        expect(fuoriDisponibilita(visita('2026-10-25T09:00:00.000Z', '2026-10-25T09:45:00.000Z'), domenica, [])).toBe(false)
        // Un'ora prima (08:00Z = 09:00 di Roma, ora solare) è fuori: l'ora legale NON sposta la finestra.
        expect(fuoriDisponibilita(visita('2026-10-25T08:00:00.000Z', '2026-10-25T08:45:00.000Z'), domenica, [])).toBe(true)
    })
})
