// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'
import {
    controlloCodaFatture,
    ORE_ALLARME_ATTESA,
    ORE_ALLARME_SOSPESA,
    STATI_IN_ATTESA,
    TETTO_CONTROLLO_MS,
} from '@/lib/health/controlli'

/**
 * IL SETTIMO CONTROLLO DI `/api/health`: LA CODA DELLE FATTURE NON È FERMA.
 *
 * La segreteria accoda, spegne il PC e se ne va: da quel momento l'unico occhio sulla
 * coda è questo controllo. Ogni caso qui sotto FORZA un guasto (o un quasi-guasto) e
 * pretende il verdetto giusto, sul finto client che applica davvero filtri, ordine e
 * limite — un mock piatto sarebbe verde con e senza il codice.
 *
 * PROVE DI ROTTURA, eseguite davvero sul codice il 2026-09-23 (e poi rimesso a posto):
 *  · `attesaMs >= …` al posto di `>` e soglia a 25 h → rosso il caso dei confini (1);
 *  · `.order('in_attesa_dal', …)` tolto → rosso «la più VECCHIA, non la prima arrivata» (1);
 *  · `.in('stato', …)` tolto → rosso «errore, emessa e tolta non aspettano» (1);
 *  · `in_attesa_dal` sostituito con `accodata_il` → rosso «voce rimessa» (3);
 *  · ramo della tabella assente che risponde `degradato` → rosso (4);
 *  · `error.message` al posto del codice → rosso (5);
 *  · lo stesso ripiego «non installata» applicato a `fatture_coda_stato` → rosso (7).
 */

const MIN = 60_000
const ORA = 60 * MIN
const SECONDO = 1_000

/** Un istante fisso: il controllo riceve `adesso` e non legge l'orologio per decidere. */
const ADESSO = Date.parse('2026-09-23T10:00:00.000Z')

/** Istante di `ms` millisecondi prima di `ADESSO`, nella forma in cui PostgREST rende i timestamptz. */
const fa = (ms: number) => new Date(ADESSO - ms).toISOString()

/** Uuid finti (repo pubblico: mai id veri). */
const idVoce = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Voce = { stato: string; in_attesa_dal: string | null; accodata_il?: string }

function voce(n: number, v: Voce) {
    return { id: idVoce(n), accodata_il: v.in_attesa_dal, ...v }
}

function db(voci: ReturnType<typeof voce>[], stato: Record<string, unknown> | null = { sospesa: false, sospesa_il: null }): DBFinto {
    return {
        fatture_coda: voci,
        fatture_coda_stato: stato === null ? [] : [{ id: 1, ...stato }],
    }
}

async function misura(d: DBFinto, errori: Record<string, ErrorePostgrest> = {}) {
    return controlloCodaFatture(creaFintoSupabase(d, [], { errori }), ADESSO)
}

afterEach(() => {
    vi.useRealTimers()
})

describe('coda-fatture · una voce che aspetta da più di 24 ore è un guasto', () => {
    it('il confine è STRETTO: 24 h − 1 s è ok, 24 h + 1 s è degradato', async () => {
        const quasi = await misura(db([voce(1, { stato: 'in_coda', in_attesa_dal: fa(ORE_ALLARME_ATTESA * ORA - SECONDO) })]))
        expect([quasi.nome, quasi.esito]).toEqual(['coda-fatture', 'ok'])

        const oltre = await misura(db([voce(1, { stato: 'in_coda', in_attesa_dal: fa(ORE_ALLARME_ATTESA * ORA + SECONDO) })]))
        expect(oltre.esito).toBe('degradato')
        expect(oltre.dettaglio).toMatch(/voci in attesa da oltre 24 h/)
    })

    it('la soglia è quella del nucleo: 24 ore, non un numero scelto qui', () => {
        expect(ORE_ALLARME_ATTESA).toBe(24)
        expect(ORE_ALLARME_SOSPESA).toBe(24)
    })

    it('guarda la più VECCHIA, non la prima arrivata nell\'elenco', async () => {
        // L'elenco del fixture mette in testa una voce fresca: un controllo che leggesse
        // la prima riga senza ordinare direbbe «ok» con una voce ferma da due giorni.
        const esito = await misura(
            db([
                voce(1, { stato: 'in_coda', in_attesa_dal: fa(5 * MIN) }),
                voce(2, { stato: 'in_coda', in_attesa_dal: fa(48 * ORA) }),
                voce(3, { stato: 'in_coda', in_attesa_dal: fa(2 * ORA) }),
            ]),
        )
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toContain('la più vecchia da 48 h')
        expect(esito.dettaglio).toContain('in attesa: 3')
    })

    it('anche una voce `in_invio` ferma conta: il lavoratore morto la lascia lì', async () => {
        expect(STATI_IN_ATTESA).toEqual(['in_coda', 'in_invio'])
        const esito = await misura(db([voce(1, { stato: 'in_invio', in_attesa_dal: fa(30 * ORA) })]))
        expect(esito.esito).toBe('degradato')
    })

    it('errore, emessa e tolta non aspettano niente: non accendono l\'allarme', async () => {
        const esito = await misura(
            db([
                voce(1, { stato: 'errore', in_attesa_dal: fa(72 * ORA) }),
                voce(2, { stato: 'emessa', in_attesa_dal: fa(72 * ORA) }),
                voce(3, { stato: 'tolta', in_attesa_dal: fa(72 * ORA) }),
            ]),
        )
        expect(esito.esito).toBe('ok')
        expect(esito.dettaglio).toContain('in attesa: 0')
    })

    it('la coda vuota è ok', async () => {
        const esito = await misura(db([]))
        expect(esito).toMatchObject({ nome: 'coda-fatture', esito: 'ok' })
        expect(typeof esito.ms).toBe('number')
    })

    it('un `in_attesa_dal` illeggibile è una misura mancata, non un «nessuna attesa»', async () => {
        const esito = await misura(db([voce(1, { stato: 'in_coda', in_attesa_dal: 'ieri' })]))
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toContain('in_attesa_dal illeggibile')
    })
})

describe('coda-fatture · «Rimetti in coda» riparte da zero', () => {
    it('una voce accodata tre giorni fa e rimessa adesso non grida', async () => {
        // `accodata_il` resta quello del primo gesto; `in_attesa_dal` si azzera al
        // rientro. Misurare sul primo farebbe suonare l'allarme proprio quando qualcuno
        // ha appena rimediato.
        const esito = await misura(
            db([voce(1, { stato: 'in_coda', accodata_il: fa(72 * ORA), in_attesa_dal: fa(10 * MIN) })]),
        )
        expect(esito.esito).toBe('ok')
    })
})

describe('coda-fatture · una coda sospesa da più di 24 ore è un guasto', () => {
    it('il confine è STRETTO anche qui: 24 h − 1 s ok, 24 h + 1 s degradato', async () => {
        const quasi = await misura(db([], { sospesa: true, sospesa_il: fa(ORE_ALLARME_SOSPESA * ORA - SECONDO) }))
        expect(quasi.esito).toBe('ok')
        expect(quasi.dettaglio).toContain('sospesa da 23 h')

        const oltre = await misura(db([], { sospesa: true, sospesa_il: fa(ORE_ALLARME_SOSPESA * ORA + SECONDO) }))
        expect(oltre.esito).toBe('degradato')
        expect(oltre.dettaglio).toMatch(/coda sospesa da oltre 24 h/)
    })

    it('un vecchio `sospesa_il` di una coda RIPRESA non conta', async () => {
        const esito = await misura(db([], { sospesa: false, sospesa_il: fa(10 * 24 * ORA) }))
        expect(esito.esito).toBe('ok')
    })

    it('sospesa senza istante di sospensione non si può misurare: degradato', async () => {
        const esito = await misura(db([], { sospesa: true, sospesa_il: null }))
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toContain('senza istante di sospensione')
    })

    it('i due guasti insieme si nominano tutti e due', async () => {
        const esito = await misura(
            db([voce(1, { stato: 'in_coda', in_attesa_dal: fa(30 * ORA) })], { sospesa: true, sospesa_il: fa(30 * ORA) }),
        )
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toMatch(/voci in attesa da oltre 24 h.*; coda sospesa da oltre 24 h/)
    })

    it('senza la riga `id=1` non si sa nemmeno se la coda è sospesa: degradato', async () => {
        const esito = await misura(db([], null))
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toContain('senza la riga id=1')
    })
})

describe('coda-fatture · tabella assente → ok con la nota, ogni altro errore → degradato', () => {
    it.each(['PGRST205', 'PGRST202', '42P01'])(
        'con `fatture_coda` che risponde %s la coda non è ancora installata: ok, e lo dice',
        async (codice) => {
            const esito = await misura(db([]), { fatture_coda: { code: codice, message: 'relation does not exist' } })
            expect(esito.esito).toBe('ok')
            expect(esito.dettaglio).toBe(`coda non ancora installata (${codice})`)
        },
    )

    it('un altro codice è un guasto, e nel corpo esce il CODICE, mai il messaggio', async () => {
        // La rotta è pubblica: un messaggio di Postgres può portare il valore che ha
        // violato un vincolo. Qui il messaggio contiene un codice fiscale FINTO.
        const esito = await misura(db([]), {
            fatture_coda: { code: 'XX000', message: 'valore RSSMRA20A01Z999X non valido' },
        })
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toBe('fatture_coda XX000')
        expect(JSON.stringify(esito)).not.toContain('RSSMRA20A01Z999X')
    })

    it('`fatture_coda` c\'è e `fatture_coda_stato` no: è una coda installata a metà, non un «non ancora»', async () => {
        const esito = await misura(db([]), { fatture_coda_stato: { code: 'PGRST205', message: 'not found' } })
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toBe('fatture_coda_stato PGRST205')
    })

    it('una lettura dello stato caduta è degradata, col solo codice', async () => {
        const esito = await misura(db([]), { fatture_coda_stato: { code: '57014', message: 'canceling statement' } })
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toBe('fatture_coda_stato 57014')
    })
})

describe('coda-fatture · il tetto di tempo vale anche qui', () => {
    it('una lettura che non risponde mai diventa degradato allo scadere del tetto', async () => {
        vi.useFakeTimers()
        // Un costruttore di query che accetta ogni catena e non si risolve MAI: è la
        // forma di un database appeso. Il controllo deve rispondere lo stesso.
        const appeso: unknown = new Proxy(
            {},
            {
                get(_t, prop) {
                    // `then` che non chiama mai né la risoluzione né il rifiuto.
                    if (prop === 'then') return () => undefined
                    return () => appeso
                },
            },
        )
        const client = { from: () => appeso } as unknown as SupabaseClient
        const promessa = controlloCodaFatture(client, ADESSO)
        await vi.advanceTimersByTimeAsync(TETTO_CONTROLLO_MS + 1)
        const esito = await promessa
        expect(esito.esito).toBe('degradato')
        expect(esito.dettaglio).toBe(`oltre il tetto di ${TETTO_CONTROLLO_MS} ms`)
    })
})
