import { describe, it, expect, afterEach, vi } from 'vitest'
import {
    apriBudgetAccesso,
    conTettoDiTempo,
    TETTO_ACCESSO_MS,
} from '@/lib/auth/errore-accesso'

/**
 * IL TETTO DI TEMPO DELL'ACCESSO, misurato sulla primitiva invece che attraverso la pagina.
 *
 * Perché un file suo. Due proprietà di `conTettoDiTempo`/`apriBudgetAccesso` sono INVISIBILI
 * dallo schermo, e finché sono state provate solo attraverso il componente hanno prodotto due
 * test finti (rilievo W8, 2026-08-03):
 *
 *  1. **il timer si spegne**. A corsa già decisa, un timer che scatta dopo non produce nessun
 *     messaggio: un test che guarda lo schermo resta verde anche con `clearTimeout` tolto.
 *     Qui si guarda il timer (`vi.getTimerCount()`), che è la cosa di cui si parla.
 *  2. **il rifiuto che arriva tardi resta gestito**. Il vecchio test lo attribuiva a una
 *     «neutralizzazione» che non c'entrava nulla (la garanzia è di `Promise.race`, che
 *     aggancia i gestori a TUTTI i concorrenti) e restava verde togliendola. Qui il rifiuto
 *     orfano si misura con il rilevatore che lo vede davvero: `process.on('unhandledRejection')`.
 *
 * ⚠️ Un `unhandledrejection` non è un dettaglio in quest'app: `installaLoggerClient` lo
 * traduce in una riga di log `error` in `app_log` per ogni volta che succede.
 */

/** Oltre qualunque tetto: serve solo a dire «questa promise non risponde mai in tempo». */
const NON_RISPONDE = new Promise<never>(() => {})

/**
 * Il valore atteso da `Promise.race` quando la corsa NON è ancora finita.
 *
 * Serve a non far scadere il test invece dell'asserzione: senza, una corsa che resta in volo
 * darebbe un timeout di vitest (rosso illeggibile, 5 secondi buttati) al posto di un confronto
 * che dice esattamente cosa non è successo.
 */
const IN_VOLO = { ancoraInCorsa: true } as const

async function esitoOra<T>(corsa: Promise<T>): Promise<T | typeof IN_VOLO> {
    return Promise.race([corsa, Promise.resolve(IN_VOLO)])
}

afterEach(() => {
    vi.useRealTimers()
})

describe('conTettoDiTempo — la corsa', () => {
    it('il lavoro risponde in tempo: passa il valore, e il timer viene SPENTO', async () => {
        vi.useFakeTimers()
        const esito = await conTettoDiTempo(Promise.resolve('profilo'), TETTO_ACCESSO_MS)

        expect(esito).toEqual({ scaduto: false, valore: 'profilo' })
        // ⟵ È l'asserzione che il vecchio test non aveva. Senza `clearTimeout` il conto è 1:
        // un timer da 15 secondi resta in volo per ogni accesso riuscito, e in un test tiene
        // sveglio il processo.
        expect(vi.getTimerCount(), 'il tetto non è stato spento dopo la risposta').toBe(0)
    })

    it('un valore `null` non si confonde con la scadenza', async () => {
        // `leggiProfilo()` restituisce `null` quando `/api/me` risponde male: se il valore
        // nudo fosse anche il segnale di «scaduto», un profilo non leggibile diventerebbe un
        // timeout — cioè il messaggio sbagliato per il guasto sbagliato.
        vi.useFakeTimers()
        expect(await conTettoDiTempo(Promise.resolve(null), TETTO_ACCESSO_MS)).toEqual({
            scaduto: false,
            valore: null,
        })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('il lavoro rifiuta PRIMA del tetto: l’errore arriva al chiamante tale e quale', async () => {
        vi.useFakeTimers()
        const guasto = new Error('GoTrue giù')
        await expect(conTettoDiTempo(Promise.reject(guasto), TETTO_ACCESSO_MS)).rejects.toBe(guasto)
        expect(vi.getTimerCount(), 'il tetto non è stato spento dopo il rifiuto').toBe(0)
    })

    it('il lavoro non risponde mai: scade, e il timer non resta acceso', async () => {
        vi.useFakeTimers()
        const corsa = conTettoDiTempo(NON_RISPONDE, 1_000)

        expect(await esitoOra(corsa)).toEqual(IN_VOLO) // prima del tetto non è successo nulla
        await vi.advanceTimersByTimeAsync(1_000)

        expect(await corsa).toEqual({ scaduto: true })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('un rifiuto che arriva DOPO il tetto non diventa una promise senza gestore', async () => {
        // LA MISURA È QUESTA LISTA, non il fatto che il test finisca. Con il lavoro lasciato
        // orfano (p.es. un wrapper che aggancia solo il ramo `resolve`) qui dentro compare il
        // rifiuto, e il confronto in fondo diventa rosso — oltre a far fallire la run intera,
        // che è ciò che vitest fa con un rifiuto non gestito.
        const orfani: unknown[] = []
        const spia = (motivo: unknown) => { orfani.push(motivo) }
        process.on('unhandledRejection', spia)
        try {
            vi.useFakeTimers()
            const tardivo = new Error('rifiuto arrivato a corsa finita')
            const lavoro = new Promise<never>((_risolvi, rifiuta) => {
                setTimeout(() => rifiuta(tardivo), 5_000)
            })

            const corsa = conTettoDiTempo(lavoro, 1_000)
            await vi.advanceTimersByTimeAsync(1_000)
            expect(await corsa).toEqual({ scaduto: true })

            // …e adesso il lavoro ABBANDONATO rifiuta, quando non lo aspetta più nessuno.
            await vi.advanceTimersByTimeAsync(5_000)

            // Node dichiara orfano un rifiuto solo dopo un giro di event loop VERO: i timer
            // finti non bastano a farglielo dire.
            vi.useRealTimers()
            await new Promise((r) => setTimeout(r, 0))
            await new Promise((r) => setTimeout(r, 0))

            expect(orfani, 'il lavoro abbandonato ha prodotto un unhandledrejection').toEqual([])
        } finally {
            process.off('unhandledRejection', spia)
        }
    })
})

describe('apriBudgetAccesso — il tetto è dell’INTERA sequenza (W8)', () => {
    it('il tempo speso dalla prima chiamata è tempo tolto alla seconda', async () => {
        vi.useFakeTimers()
        const budget = apriBudgetAccesso(15_000)

        // 1ª attesa: lenta ma vera, 10 secondi. Deve passare.
        const lenta = new Promise<string>((risolvi) => {
            setTimeout(() => risolvi('sessione'), 10_000)
        })
        const prima = budget.corri(lenta)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await prima).toEqual({ scaduto: false, valore: 'sessione' })

        // 2ª attesa: non risponde mai. Restano 5 secondi del budget, NON altri 15.
        const seconda = budget.corri(NON_RISPONDE)
        await vi.advanceTimersByTimeAsync(5_000)

        expect(
            await esitoOra(seconda),
            'la seconda chiamata ha avuto un tetto TUTTO SUO: con un tetto per chiamata il ' +
            'bottone «Accesso…» resta bloccato per la somma delle attese, che è il difetto W8',
        ).toEqual({ scaduto: true })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('budget esaurito: la chiamata successiva scade subito, non riparte da capo', async () => {
        vi.useFakeTimers()
        const budget = apriBudgetAccesso(1_000)
        await vi.advanceTimersByTimeAsync(1_500) // il budget è già finito qui

        const tardiva = budget.corri(NON_RISPONDE)
        await vi.advanceTimersByTimeAsync(0)

        expect(await esitoOra(tardiva)).toEqual({ scaduto: true })
    })

    it('finché il budget basta, i valori passano intatti', async () => {
        vi.useFakeTimers()
        const budget = apriBudgetAccesso(15_000)

        expect(await budget.corri(Promise.resolve({ id: 'u-1' }))).toEqual({
            scaduto: false,
            valore: { id: 'u-1' },
        })
        expect(await budget.corri(Promise.resolve(true))).toEqual({ scaduto: false, valore: true })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('senza argomento vale il tetto dichiarato per l’accesso', async () => {
        vi.useFakeTimers()
        const budget = apriBudgetAccesso()
        const corsa = budget.corri(NON_RISPONDE)

        await vi.advanceTimersByTimeAsync(TETTO_ACCESSO_MS - 1)
        expect(await esitoOra(corsa)).toEqual(IN_VOLO)

        await vi.advanceTimersByTimeAsync(1)
        expect(await corsa).toEqual({ scaduto: true })
    })
})
