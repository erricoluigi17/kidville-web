import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FINESTRA DI LETTURA DELLE RIGHE AUTOMATICHE — dove si ferma, e con quante.
 *
 * `leggiRigheAutomatiche` è l'unica query che guardano le tre porte dell'import
 * (l'elenco, l'annullo in blocco, la notifica differita). Il PREDICATO è lo
 * stesso per tutte e tre — quello lo sorveglia il lock
 * `annullo-in-blocco-solo-le-auto` — e ciò che cambia è quanto in là si legge.
 *
 * ⚠️ QUESTO FILE ESISTE PERCHÉ LE DUE COSE CHE MISURA NON SI VEDONO DA UNA ROTTA.
 *
 *  1. IL TAGLIO A `TETTO+1`. Le rotte tagliano comunque a `TETTO_ANNULLO` prima
 *     di mostrare o di stornare, quindi dalla loro risposta un lettore che
 *     restituisce 201 righe e uno che ne restituisce 300 sono indistinguibili.
 *     La differenza è reale lo stesso: si pagina a blocchi di cento, e le
 *     novantanove righe di troppo sono nomi e codici fiscali di minori portati
 *     nel processo per essere buttati una riga dopo. Per due giri di revisione
 *     due commenti hanno dichiarato «TETTO+1» mentre il codice ne leggeva fino a
 *     TETTO+100: adesso è il codice a garantirlo, e questo test lo tiene fermo.
 *
 *  2. LA FINESTRA LARGA. La notifica differita legge con `TETTO_FINESTRA` e non
 *     col tetto dell'annullo: fermarsi a 200 su un import che la fase automatica
 *     può chiudere fino a 500 lasciava le righe oltre senza avviso PER SEMPRE —
 *     l'ordine è stabile, notificare non cambia lo stato della riga, e ogni
 *     riapertura del riepilogo ripescava le stesse prime 200.
 */

const h = vi.hoisted(() => ({
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
    righe: [] as Record<string, unknown>[],
    errore: null as { code: string; message: string } | null,
    /** Le finestre chieste al database, in ordine: `[da, a]`. */
    pagine: [] as [number, number][],
}))

vi.mock('@/lib/logging/logger', () => ({ logOk: h.logOk, logErrore: h.logErrore, logEvento: h.logEvento }))

import {
    leggiRigheAutomatiche,
    TETTO_ANNULLO,
    TETTO_FINESTRA,
} from '@/lib/pagamenti/righe-automatiche'

/** Un client che pagina davvero: `range` taglia, come fa PostgREST. */
function finto() {
    return {
        from: () => {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.not = () => b
            b.order = () => b
            b.range = (da: number, a: number) => {
                h.pagine.push([da, a])
                b._range = [da, a]
                return b
            }
            b.then = (resolve: (v: unknown) => unknown) => {
                if (h.errore) return resolve({ data: null, error: h.errore })
                const [da, a] = (b._range as number[]) ?? [0, 99]
                return resolve({ data: h.righe.slice(da, a + 1), error: null })
            }
            return b
        },
    }
}

const IMP = 'ffffffff-ffff-4fff-8fff-fffffffffff0'
const OP = 'test/righe-automatiche'

const molte = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        scuola_id: 'sc-1',
        data_operazione: '2026-09-18',
        importo: 150,
        causale: 'BONIFICO',
        controparte: 'MARIO ROSSI',
        pagamento_id: `p${i}`,
        incasso_id: `i${i}`,
        transazione_id: null,
        abbinato_auto_il: '2026-09-20T08:00:00.000Z',
    }))

const leggi = (tetto?: number) =>
    leggiRigheAutomatiche(finto() as never, IMP, OP, tetto === undefined ? {} : { tetto })

beforeEach(() => {
    vi.clearAllMocks()
    h.righe = []
    h.errore = null
    h.pagine = []
})

describe('la finestra di default: il bersaglio dell’annullo', () => {
    it('pagina fino alla pagina vuota e restituisce tutto ciò che c’è', async () => {
        h.righe = molte(150)
        const esito = await leggi()
        expect('righe' in esito && esito.righe).toHaveLength(150)
        expect('troppe' in esito && esito.troppe).toBe(false)
        // Si avanza di quante righe si sono RICEVUTE, e ci si ferma sulla vuota.
        expect(h.pagine).toEqual([[0, 99], [100, 199], [150, 249]])
    })

    it('🔴 oltre il tetto restituisce ESATTAMENTE `TETTO+1` righe, non la pagina intera', async () => {
        // 250 righe: la terza pagina ne porta 50 e il tetto è superato. Senza il
        // taglio uscirebbero di qui 250 righe — cioè quarantanove anagrafiche di
        // minori in più di quelle che servono a dire «sono troppe».
        h.righe = molte(250)
        const esito = await leggi()
        expect('troppe' in esito && esito.troppe).toBe(true)
        expect('righe' in esito && esito.righe).toHaveLength(TETTO_ANNULLO + 1)
        // La riga in più è la PROVA del superamento, e non una a caso: è la
        // prima oltre il tetto, nell'ordine stabile della query.
        expect('righe' in esito && esito.righe[TETTO_ANNULLO].id).toBe(`m${TETTO_ANNULLO}`)
    })

    it('al tetto esatto NON è «troppe»: 200 righe si annullano', async () => {
        // Il confine si misura dal verso giusto: `>` e non `>=`, o l'annullo
        // rifiuterebbe proprio l'import che il tetto dichiara di ammettere.
        h.righe = molte(TETTO_ANNULLO)
        const esito = await leggi()
        expect('troppe' in esito && esito.troppe).toBe(false)
        expect('righe' in esito && esito.righe).toHaveLength(TETTO_ANNULLO)
    })
})

describe('la finestra larga: l’import intero, per la notifica', () => {
    it('🔴 350 righe entrano tutte, e non è un troncamento', async () => {
        // È il numero che rende visibile il difetto: oltre il tetto dell'annullo
        // (200) e dentro ciò che la fase automatica può chiudere (500).
        h.righe = molte(350)
        const esito = await leggi(TETTO_FINESTRA)
        expect('troppe' in esito && esito.troppe).toBe(false)
        expect('righe' in esito && esito.righe).toHaveLength(350)
    })

    it('la finestra strutturale è un tetto vero: ci si ferma, e si DICHIARA', async () => {
        // Un ciclo senza fine su una rotta serverless sarebbe un timeout
        // travestito da successo parziale anche qui. Oltre la finestra si esce
        // troncati, e il fatto si grida a livello `error`: quelle righe non
        // verranno avvisate riaprendo il riepilogo.
        h.righe = molte(TETTO_FINESTRA + 1)
        const esito = await leggi(TETTO_FINESTRA)
        expect('troppe' in esito && esito.troppe).toBe(true)
        expect('righe' in esito && esito.righe).toHaveLength(TETTO_FINESTRA)
        const gridato = h.logEvento.mock.calls.filter(
            (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'righe-automatiche-finestra-troncata',
        )
        expect(gridato).toHaveLength(1)
    })
})

describe('il database che non ha la marca, e quello che si rompe', () => {
    it('colonna assente (DB E2E non migrato) ⇒ `marcaAssente`, e un `warn`', async () => {
        h.errore = { code: '42703', message: 'column does not exist' }
        const esito = await leggi()
        expect('marcaAssente' in esito).toBe(true)
        expect(h.logEvento).toHaveBeenCalledWith(
            'pagamento',
            'warn',
            expect.objectContaining({ esito: 'righe-automatiche-non-disponibili' }),
        )
    })

    it('🔴 un guasto di lettura NON diventa «non c’è niente da annullare»', async () => {
        // PostgREST non lancia: senza il controllo sul valore di ritorno, un
        // errore uscirebbe come un elenco vuoto su un import che la macchina ha
        // chiuso per intero.
        h.errore = { code: '57014', message: 'statement timeout' }
        const esito = await leggi()
        expect('errore' in esito && esito.errore.status).toBe(500)
        expect(h.logErrore).toHaveBeenCalled()
    })
})
