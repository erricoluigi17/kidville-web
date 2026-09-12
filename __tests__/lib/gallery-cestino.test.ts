import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// IL CESTINO DELLA GALLERIA — le tre direzioni, e il degrado che non deve
// diventare un fail-open.
//
// Perché queste prove e non altre: il cestino ha un verso che rompe le cose in
// silenzio in ENTRAMBE le direzioni, ed è raro.
//
//  · se una lettura di vista dimentica il filtro, una foto eliminata RIAPPARE —
//    senza errori, senza log, senza che nessuno lo sappia;
//  · se una lettura di OBLIO aggiunge il filtro, una foto cestinata SOPRAVVIVE
//    alla cancellazione chiesta da una famiglia — e il chiamante scrive comunque
//    `spazio_liberato_il`, cioè un «fatto» falso accanto al nome di un bambino.
//
// Quindi `ancheNelCestino` deve restare l'IDENTITÀ, e c'è una prova che diventa
// rossa se qualcuno, un giorno, la «migliora» aggiungendovi un filtro.
//
// E c'è la prova che conta più di tutte: il degrado scatta SOLO su «colonna
// assente». Su un `42501 permission denied` NON si rilegge senza filtro — se lo
// facesse, un permesso che cade in produzione mostrerebbe a tutti le foto
// cestinate, e il degrado sarebbe diventato il fail-open che finge di proteggere.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
    logEvento: (...a: unknown[]) => logEvento(...a),
    logErrore: vi.fn(),
    logOk: vi.fn(),
}))

const {
    GIORNI_CESTINO_GALLERIA,
    sogliaScadenzaCestino,
    soloVive,
    soloNelCestino,
    ancheNelCestino,
    colonnaCestinoAssente,
    leggiVive,
} = await import('@/lib/gallery/cestino')

/** Un filtro registrato, nella forma in cui il finto builder lo annota. */
type Filtro = [metodo: string, ...argomenti: unknown[]]

/**
 * Un finto builder PostgREST: chainabile, thenable, e che ANNOTA i filtri.
 *
 * Riproduce le due proprietà che contano, e la seconda è quella che ha dettato la
 * firma di `leggiVive`:
 *  · i metodi ritornano `this`, cioè MUTANO il builder — non esiste una copia
 *    «senza filtro» da recuperare dopo un tentativo fallito;
 *  · `await` esegue, e ritorna `{ data, error }` senza mai lanciare.
 */
class FintoBuilder<T> {
    readonly filtri: Filtro[] = []
    esecuzioni = 0
    constructor(private readonly esito: { data: T | null; error: { code?: string } | null }) {}
    private annota(metodo: string, ...args: unknown[]): this {
        this.filtri.push([metodo, ...args])
        return this
    }
    is(c: string, v: boolean | null) { return this.annota('is', c, v) }
    not(c: string, o: string, v: unknown) { return this.annota('not', c, o, v) }
    lt(c: string, v: unknown) { return this.annota('lt', c, v) }
    eq(c: string, v: unknown) { return this.annota('eq', c, v) }
    select(c: string) { return this.annota('select', c) }
    maybeSingle() { return this.annota('maybeSingle') }
    then<A = { data: T | null; error: { code?: string } | null }, B = never>(
        ok?: ((v: { data: T | null; error: { code?: string } | null }) => A | PromiseLike<A>) | null,
        ko?: ((r: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
        this.esecuzioni++
        return Promise.resolve(this.esito).then(ok, ko)
    }
}

const vuoto = () => new FintoBuilder<{ id: string }[]>({ data: [], error: null })

beforeEach(() => logEvento.mockClear())

describe('cestino galleria — i 30 giorni e la soglia', () => {
    it('i giorni di grazia sono 30, in una costante sola', () => {
        expect(GIORNI_CESTINO_GALLERIA).toBe(30)
    })

    it('la soglia della purga è 30 giorni prima dell’istante dato', () => {
        // Orologio congelato: un confine temporale non si prova aspettando un mese.
        const adesso = new Date('2026-09-12T10:30:00.000Z')
        expect(sogliaScadenzaCestino(adesso)).toBe('2026-08-13T10:30:00.000Z')
    })

    it('la soglia si calcola sui millisecondi, quindi attraversa i cambi di mese', () => {
        // 1° marzo meno 30 giorni = 30 gennaio in un anno non bisestile, 31 gennaio
        // nel 2028 che lo è. Se qualcuno riscrivesse la soglia con `setMonth(-1)`
        // questa prova lo prenderebbe.
        expect(sogliaScadenzaCestino(new Date('2027-03-01T00:00:00.000Z'))).toBe(
            '2027-01-30T00:00:00.000Z',
        )
        expect(sogliaScadenzaCestino(new Date('2028-03-01T00:00:00.000Z'))).toBe(
            '2028-01-31T00:00:00.000Z',
        )
    })
})

describe('cestino galleria — i tre versi', () => {
    it('soloVive filtra `eliminato_il IS NULL`, e nient’altro', () => {
        const q = vuoto()
        expect(soloVive(q)).toBe(q) // la catena si conserva: `is` ritorna `this`
        expect(q.filtri).toEqual([['is', 'eliminato_il', null]])
    })

    it('soloNelCestino pretende DUE condizioni: nel cestino, e ancora ripristinabile', () => {
        const q = vuoto()
        soloNelCestino(q)
        expect(q.filtri).toEqual([
            ['not', 'eliminato_il', 'is', null],
            // Senza questa, il cestino offrirebbe «Ripristina» su righe il cui file
            // è già uscito dallo Storage: un bottone che restituisce una foto rotta.
            ['is', 'file_rimosso_il', null],
        ])
    })

    it('soloNelCestino con il taglio temporale aggiunge `eliminato_il <` la soglia', () => {
        const q = vuoto()
        soloNelCestino(q, new Date('2026-08-13T10:30:00.000Z'))
        expect(q.filtri[2]).toEqual(['lt', 'eliminato_il', '2026-08-13T10:30:00.000Z'])
    })

    it('soloNelCestino accetta anche una soglia già in ISO, senza riformattarla', () => {
        const q = vuoto()
        soloNelCestino(q, '2026-08-13T10:30:00.000Z')
        expect(q.filtri[2]).toEqual(['lt', 'eliminato_il', '2026-08-13T10:30:00.000Z'])
    })

    /**
     * ⚠️ LA PROVA CHE DEVE RESTARE ROSSA SE QUALCUNO «MIGLIORA» `ancheNelCestino`.
     *
     * È l'identità, e non per pigrizia: è la funzione che usa l'oblio GDPR. Se un
     * giorno le si aggiungesse un filtro «per coerenza con le sorelle», una foto
     * nel cestino sopravviverebbe alla cancellazione chiesta da una famiglia — la
     * riga in tabella, il file nel bucket per i 30 giorni della purga — e
     * `liberaSpazio` scriverebbe comunque `spazio_liberato_il`. Nessun test
     * dell'oblio diventerebbe rosso da solo: i suoi finti client non hanno le
     * colonne del cestino. Questa prova è l'unica che lo vedrebbe.
     */
    it('ancheNelCestino NON aggiunge nessun filtro: è l’identità', () => {
        const q = vuoto()
        expect(ancheNelCestino(q, 'una ragione qualunque, scritta per esteso')).toBe(q)
        expect(q.filtri).toEqual([])
    })

    it('ancheNelCestino non tocca nemmeno una catena già filtrata da altri', () => {
        const q = vuoto()
        q.eq('id', 'abc')
        ancheNelCestino(q, 'oblio GDPR: deve vedere anche ciò che è nel cestino')
        expect(q.filtri).toEqual([['eq', 'id', 'abc']])
    })
})

describe('cestino galleria — riconoscimento della colonna assente', () => {
    it('riconosce i due codici di «colonna che non esiste»', () => {
        expect(colonnaCestinoAssente({ code: '42703' })).toBe(true)
        expect(colonnaCestinoAssente({ code: 'PGRST204' })).toBe(true)
    })

    it('NON riconosce gli altri, e ciascuno per una ragione diversa', () => {
        // `42P01`/`PGRST205` dicono che manca la TABELLA: un guasto che non si
        // degrada togliendo un filtro.
        expect(colonnaCestinoAssente({ code: '42P01' })).toBe(false)
        expect(colonnaCestinoAssente({ code: 'PGRST205' })).toBe(false)
        // `42501` è un PERMESSO negato: degradare qui vorrebbe dire mostrare le
        // foto cestinate proprio quando l'accesso si è ristretto.
        expect(colonnaCestinoAssente({ code: '42501' })).toBe(false)
        expect(colonnaCestinoAssente(null)).toBe(false)
        expect(colonnaCestinoAssente(undefined)).toBe(false)
        expect(colonnaCestinoAssente({})).toBe(false)
    })
})

describe('cestino galleria — leggiVive: il filtro, e il degrado che non è un fail-open', () => {
    it('nel caso normale applica il filtro, esegue UNA volta e non logga niente', async () => {
        const costruiti: FintoBuilder<{ id: string }[]>[] = []
        const esito = await leggiVive((vive) => {
            const q = new FintoBuilder<{ id: string }[]>({ data: [{ id: 'a' }], error: null })
            costruiti.push(q)
            return vive(q.select('id'))
        }, 'prova:GET')

        expect(esito.data).toEqual([{ id: 'a' }])
        expect(costruiti).toHaveLength(1)
        expect(costruiti[0].filtri).toEqual([['select', 'id'], ['is', 'eliminato_il', null]])
        // Nessun log nel caso felice: una riga per ogni lettura di galleria
        // accecherebbe il canale, e 100 righe di log sono 10 richieste viste.
        expect(logEvento).not.toHaveBeenCalled()
    })

    it('il filtro entra PRIMA delle trasformazioni: dopo `maybeSingle()` non entrerebbe più', async () => {
        // È il motivo per cui `leggiVive` consegna `vive` invece di avvolgere la
        // catena da fuori: `.maybeSingle()` restituisce un builder che non ha più
        // `is()`, e un filtro applicato all'esterno non potrebbe più entrare.
        const costruiti: FintoBuilder<{ id: string }>[] = []
        await leggiVive((vive) => {
            const q = new FintoBuilder<{ id: string }>({ data: { id: 'a' }, error: null })
            costruiti.push(q)
            return vive(q.eq('id', 'a')).maybeSingle()
        }, 'prova:POST')
        expect(costruiti[0].filtri).toEqual([
            ['eq', 'id', 'a'],
            ['is', 'eliminato_il', null],
            ['maybeSingle'],
        ])
    })

    it('su colonna assente RICOSTRUISCE la query senza filtro, e lo dice a livello warn', async () => {
        const costruiti: FintoBuilder<{ id: string }[]>[] = []
        let giro = 0
        const esito = await leggiVive((vive) => {
            giro++
            const q = new FintoBuilder<{ id: string }[]>(
                giro === 1
                    ? { data: null, error: { code: '42703' } }
                    : { data: [{ id: 'degradato' }], error: null },
            )
            costruiti.push(q)
            return vive(q.select('id'))
        }, 'prova:GET')

        expect(esito.data).toEqual([{ id: 'degradato' }])
        // DUE builder distinti, e non lo stesso riusato: `is()` ritorna `this`,
        // quindi dopo il primo tentativo il filtro è già dentro l'URL e non si può
        // togliere. Se un giorno qualcuno riscrivesse `leggiVive` per riusare la
        // query, questa prova diventerebbe rossa — ed è l'unica che lo vedrebbe.
        expect(costruiti).toHaveLength(2)
        expect(costruiti[0]).not.toBe(costruiti[1])
        expect(costruiti[0].filtri).toContainEqual(['is', 'eliminato_il', null])
        expect(costruiti[1].filtri).toEqual([['select', 'id']])

        expect(logEvento).toHaveBeenCalledTimes(1)
        const [evento, livello, campi] = logEvento.mock.calls[0]
        expect(evento).toBe('galleria')
        // `warn` e non `info`: in produzione le colonne esistono, quindi questo ramo
        // non deve scattare mai. Un degrado seppellito fra gli `info` è un
        // fail-open che non si vede.
        expect(livello).toBe('warn')
        expect(campi).toMatchObject({
            operazione: 'prova:GET',
            esito: 'degrado-cestino-colonna-assente',
            error_code: '42703',
        })
    })

    /**
     * ⚠️ LA PROVA PIÙ IMPORTANTE DI QUESTO FILE.
     *
     * Il degrado esiste per il DB E2E della CI, che non è migrato. Se scattasse su
     * QUALUNQUE errore diventerebbe l'opposto di una protezione: un `42501
     * permission denied` in produzione — cioè il momento in cui l'accesso si
     * restringe — riletto senza filtro mostrerebbe a tutti le foto cestinate. È la
     * stessa forma del difetto chiuso su `degradoSedeLecito`, dove il fallback
     * senza filtro scattava proprio quando l'isolamento non era disponibile.
     */
    it('NON degrada su un errore che non è «colonna assente»: l’errore torna al chiamante', async () => {
        let giri = 0
        const esito = await leggiVive((vive) => {
            giri++
            const q = new FintoBuilder<{ id: string }[]>({
                data: null,
                error: { code: '42501' },
            })
            return vive(q.select('id'))
        }, 'prova:GET')

        expect(giri).toBe(1)
        expect(esito.error).toEqual({ code: '42501' })
        expect(logEvento).not.toHaveBeenCalled()
    })

    it('non ritenta due volte: se anche la seconda lettura fallisce, l’errore torna intatto', async () => {
        let giri = 0
        const esito = await leggiVive((vive) => {
            giri++
            const q = new FintoBuilder<{ id: string }[]>({
                data: null,
                error: { code: giri === 1 ? '42703' : '42501' },
            })
            return vive(q.select('id'))
        }, 'prova:GET')

        // Due tentativi, non tre: un ciclo che non termina è peggio di un 500,
        // perché quello almeno si vede.
        expect(giri).toBe(2)
        // E non si inghiotte niente: PostgREST non lancia, e chi chiama resta
        // quello che decide se fermarsi.
        expect(esito.error).toEqual({ code: '42501' })
        expect(logEvento).toHaveBeenCalledTimes(1)
    })
})
