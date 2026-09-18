import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// LA METÀ «STORAGE» DELLA PUBBLICAZIONE VIDEO IN GALLERIA (V08).
//
// Lo Storage NON sta dentro la transazione della RPC: il file si copia PRIMA, e
// se la RPC poi rifiuta il file va tolto. È lo stesso schema, già provato e già
// compensato, di `promuoviMediaBozza`/`riportaMediaInBozza` per le News — con una
// differenza che conta e che è misurata qui sotto: là si SPOSTA (e si sposta
// indietro), qui si COPIA, perché `video_jobs.output_path` continua a nominare
// l'uscita nel bucket di lavorazione. Spostarla renderebbe quella riga una
// promessa su un oggetto che non esiste più.
//
// Da cui la compensazione: non un ritorno, ma una RIMOZIONE — e mai un `remove()`
// muto. `rimuoviEVerifica` verifica lo STATO, non il conteggio, ed è l'unica
// forma che sa distinguere «non c'è più» da «non so se c'è»: un file di un minore
// rimasto in `gallery` senza nessuna riga che lo nomini è invisibile all'oblio,
// alla retention e alla revoca del consenso, cioè pubblicabile per sempre e
// cancellabile da nessuno. Quello si GRIDA.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import {
    annullaCopiaVideoInGalleria,
    copiaVideoInGalleria,
} from '@/lib/gallery/video-pubblicazione'
import { BUCKET_GALLERIA, TETTO_VIDEO_GALLERIA_BYTE } from '@/lib/gallery/limiti'

const OWNER = '22222222-2222-4222-8222-222222222222'
const SORGENTE = 'lavorazione/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/1/out.mp4'
const OPERAZIONE = 'gallery:POST'

type ChiamataCopy = { bucket: string; da: string; a: string; opzioni: unknown }

/**
 * Uno Storage finto con la sola superficie che questo modulo tocca: `copy`,
 * `remove`, `list`. `rimuoviEVerifica` resta REALE — è il pezzo il cui verso
 * conta, e mockarlo vorrebbe dire misurare il mock.
 */
function storageFinto(opzioni: {
    copy?: { error?: unknown; lancia?: unknown }
    /** I percorsi che `remove` dichiara di aver tolto. */
    rimossi?: string[]
    /** I percorsi che una `list` successiva trova ANCORA nel bucket. */
    ancora?: string[]
    removeError?: unknown
}) {
    const copie: ChiamataCopy[] = []
    const rimozioni: string[][] = []
    const client = {
        storage: {
            from(bucket: string) {
                return {
                    copy: async (da: string, a: string, opt: unknown) => {
                        copie.push({ bucket, da, a, opzioni: opt })
                        if (opzioni.copy?.lancia) throw opzioni.copy.lancia
                        if (opzioni.copy?.error) return { data: null, error: opzioni.copy.error }
                        return { data: { path: a }, error: null }
                    },
                    remove: async (percorsi: string[]) => {
                        rimozioni.push(percorsi)
                        if (opzioni.removeError) return { data: null, error: opzioni.removeError }
                        return {
                            data: (opzioni.rimossi ?? percorsi).map((name) => ({ name })),
                            error: null,
                        }
                    },
                    list: async (cartella: string, o: { search?: string }) => ({
                        data: (opzioni.ancora ?? [])
                            .filter((p) => p.startsWith(`${cartella}/`))
                            .map((p) => ({ name: p.slice(cartella.length + 1) }))
                            .filter((r) => !o.search || r.name.startsWith(o.search)),
                        error: null,
                    }),
                }
            },
        },
    }
    return { client, copie, rimozioni }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comeClient = (c: unknown) => c as any

beforeEach(() => {
    vi.clearAllMocks()
})

describe('copiaVideoInGalleria — l’uscita convertita entra in `gallery`, non ci si sposta', () => {
    it('copia dal bucket di lavorazione a `gallery`, sotto la cartella di chi ha caricato', async () => {
        const s = storageFinto({})
        const esito = await copiaVideoInGalleria(comeClient(s.client), {
            bucketSorgente: 'video_processing',
            percorsoSorgente: SORGENTE,
            byte: 12_345_678,
            ownerId: OWNER,
            operazione: OPERAZIONE,
        })

        expect(esito.ok).toBe(true)
        if (!esito.ok) return
        // Il prefisso è l'uuid di CHI PUBBLICA, come in `gallery/upload-url`: è
        // l'unica cosa che separa i file di una maestra da quelli di un'altra, e
        // il nome NON contiene niente che venga dal file originale (che si chiama
        // `IMG_bambina-rossi.mov`: anagrafica di un minore).
        expect(esito.percorso).toMatch(new RegExp(`^uploads/${OWNER}/[0-9]+-[a-z0-9]+\\.mp4$`))
        expect(s.copie).toHaveLength(1)
        expect(s.copie[0].bucket).toBe('video_processing')
        expect(s.copie[0].da).toBe(SORGENTE)
        expect(s.copie[0].a).toBe(esito.percorso)
        expect(s.copie[0].opzioni).toEqual({ destinationBucket: BUCKET_GALLERIA })
    })

    it('il SUCCESSO si logga (evento critico: senza, «nessun log» non distingue i due casi)', async () => {
        const s = storageFinto({})
        await copiaVideoInGalleria(comeClient(s.client), {
            bucketSorgente: 'video_processing',
            percorsoSorgente: SORGENTE,
            byte: 1024,
            ownerId: OWNER,
            operazione: OPERAZIONE,
        })
        const riga = log.logEvento.mock.calls.find((c) => c[2]?.esito === 'video-copiato-in-galleria')
        expect(riga, 'la copia riuscita deve lasciare una riga').toBeTruthy()
        expect(riga?.[1]).toBe('info')
        // Mai il percorso nei log: porta l'uuid di chi carica e il nome del file.
        expect(JSON.stringify(riga?.[2])).not.toContain(SORGENTE)
    })

    it('un’uscita oltre il tetto del bucket viene rifiutata PRIMA di toccare lo Storage', async () => {
        const s = storageFinto({})
        const esito = await copiaVideoInGalleria(comeClient(s.client), {
            bucketSorgente: 'video_processing',
            percorsoSorgente: SORGENTE,
            byte: TETTO_VIDEO_GALLERIA_BYTE + 1,
            ownerId: OWNER,
            operazione: OPERAZIONE,
        })
        expect(esito).toEqual({ ok: false, codice: 'OUTPUT_TOO_LARGE' })
        // Il punto: lo Storage rifiuterebbe comunque, ma dopo aver spedito i byte.
        expect(s.copie).toHaveLength(0)
    })

    it('`copy` che RITORNA un errore: niente percorso, e il corpo del fornitore resta nel log', async () => {
        const s = storageFinto({ copy: { error: { message: 'Payload too large', statusCode: '413' } } })
        const esito = await copiaVideoInGalleria(comeClient(s.client), {
            bucketSorgente: 'video_processing',
            percorsoSorgente: SORGENTE,
            byte: 1024,
            ownerId: OWNER,
            operazione: OPERAZIONE,
        })
        expect(esito).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
        expect(log.logErrore).toHaveBeenCalled()
        // «413» non dice niente; «413 Payload too large» dice tutto (AGENTS §3).
        const [, errore] = log.logErrore.mock.calls[0]
        expect(JSON.stringify(errore)).toContain('Payload too large')
    })

    it('`copy` che LANCIA (guasto di trasporto) non sfugge: stesso esito, stesso log', async () => {
        const s = storageFinto({ copy: { lancia: new Error('fetch failed') } })
        const esito = await copiaVideoInGalleria(comeClient(s.client), {
            bucketSorgente: 'video_processing',
            percorsoSorgente: SORGENTE,
            byte: 1024,
            ownerId: OWNER,
            operazione: OPERAZIONE,
        })
        expect(esito).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
        expect(log.logErrore).toHaveBeenCalled()
        // `JSON.stringify(new Error(…))` vale `{}`: un'asserzione scritta così
        // sarebbe passata anche su un `catch` muto che logga un oggetto vuoto.
        // Si guarda il messaggio, che è la cosa che deve arrivare a chi indaga.
        expect((log.logErrore.mock.calls[0][1] as Error).message).toBe('fetch failed')
    })
})

describe('annullaCopiaVideoInGalleria — se la RPC rifiuta, il file non resta in `gallery`', () => {
    it('toglie il file e lo dice (successo osservabile)', async () => {
        const s = storageFinto({})
        const esito = await annullaCopiaVideoInGalleria(
            comeClient(s.client),
            [`uploads/${OWNER}/1-abc.mp4`],
            OPERAZIONE,
        )
        expect(esito).toEqual({ rimossi: 1, rimasti: 0 })
        expect(s.rimozioni).toEqual([[`uploads/${OWNER}/1-abc.mp4`]])
        const riga = log.logEvento.mock.calls.find((c) => c[2]?.esito === 'video-copia-annullata')
        expect(riga?.[1]).toBe('info')
    })

    it('un file che NON esce GRIDA: `error`, perché nessuna riga lo nomina più', async () => {
        const percorso = `uploads/${OWNER}/1-abc.mp4`
        // `remove` non lo nomina fra gli usciti e la verifica lo ritrova: «c'è ancora».
        const s = storageFinto({ rimossi: [], ancora: [percorso] })
        const esito = await annullaCopiaVideoInGalleria(comeClient(s.client), [percorso], OPERAZIONE)

        expect(esito).toEqual({ rimossi: 0, rimasti: 1 })
        const grido = log.logEvento.mock.calls.find(
            (c) => c[2]?.esito === 'video-copia-rimasta-in-galleria',
        )
        expect(grido, 'un file di un minore senza riga che lo nomini si grida').toBeTruthy()
        expect(grido?.[1]).toBe('error')
        expect(String(grido?.[2]?.msg ?? '')).toContain('gallery')
        // Nel log solo conteggi: il percorso porta l'uuid di chi ha caricato.
        expect(JSON.stringify(grido?.[2])).not.toContain('1-abc.mp4')
    })

    it('«non so se c’è» vale «c’è»: un `remove` in errore non passa per riuscito', async () => {
        const percorso = `uploads/${OWNER}/1-abc.mp4`
        const s = storageFinto({ removeError: { message: 'bucket not found' } })
        const esito = await annullaCopiaVideoInGalleria(comeClient(s.client), [percorso], OPERAZIONE)
        expect(esito).toEqual({ rimossi: 0, rimasti: 1 })
        expect(
            log.logEvento.mock.calls.some((c) => c[2]?.esito === 'video-copia-rimasta-in-galleria'),
        ).toBe(true)
    })

    it('niente da annullare: lo Storage non si tocca affatto', async () => {
        const s = storageFinto({})
        const esito = await annullaCopiaVideoInGalleria(comeClient(s.client), [], OPERAZIONE)
        expect(esito).toEqual({ rimossi: 0, rimasti: 0 })
        expect(s.rimozioni).toEqual([])
    })
})
