import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mascheraSorgente } from '../fixtures/sorgente'

// =============================================================================
// LA METÀ «STORAGE» DELLA PUBBLICAZIONE VIDEO IN GALLERIA (V08, e PR 2 video).
//
// Lo Storage NON sta dentro la transazione della RPC: il file si copia PRIMA, e la RPC
// (`video_galleria_pubblica`) si chiama SOLO a copia riuscita. È lo stesso schema, già
// provato, di `promuoviMediaBozza` per le News — con una differenza che conta e che è
// misurata qui sotto: là si SPOSTA, qui si COPIA, perché `video_jobs.output_path`
// continua a nominare l'uscita nel bucket di lavorazione. Spostarla renderebbe quella
// riga una promessa su un oggetto che non esiste più.
//
// ─── IL PERCORSO È DETERMINISTICO (2026-10-02) ───────────────────────────────
// `uploads/<owner>/v-<intento>.mp4`, non più un nome casuale. La pubblicazione gira sul
// server e un processo può morire dopo la copia e prima della RPC: col nome casuale il
// secondo tentativo copiava un altro file e il primo restava in `gallery` senza nessuna
// riga che lo nominasse. Col nome fisso il secondo tentativo trova la copia già lì:
//
//   · stessa dimensione  ⇒ vale come riuscita (si prosegue con la RPC, idempotente);
//   · dimensione diversa ⇒ errore, e si grida: un file qualunque sotto il nome di un
//     video di un minore non si adotta;
//   · non si riesce a leggere ⇒ errore: «non so quanto pesa» non vale «pesa giusto».
//
// UN ANNULLAMENTO NON C'È PIÙ (T7, 2026-10-02). `annullaCopiaVideoInGalleria` non aveva chiamanti: la
// pubblicazione gira sul server e riprova da sola, la copia di un tentativo fallito è quella che il
// tentativo dopo riusa (il 409 con la stessa dimensione), e se la pubblicazione fallisce in modo
// DEFINITIVO la copia orfana la toglie la spazzata di `retention-galleria` dopo 24 ore. Toglierla da qui
// sarebbe una `remove` sul percorso di un video che la RPC potrebbe aver già pubblicato con la risposta
// persa per strada: l'ultimo blocco di questo file lo tiene fermo.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import { copiaVideoInGalleria, percorsoVideoInGalleria } from '@/lib/gallery/video-pubblicazione'
import { BUCKET_GALLERIA, TETTO_VIDEO_GALLERIA_BYTE } from '@/lib/gallery/limiti'
import { percorsoUploadProprio } from '@/lib/gallery/pubblicazione-foto'

const OWNER = '22222222-2222-4222-8222-222222222222'
const INTENT = 'e1e1e1e1-1111-4111-8111-eeeeeeeeeeee'
const ALTRO_INTENT = 'e2e2e2e2-2222-4222-8222-eeeeeeeeeeee'
const SORGENTE = 'lavorazione/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/1/out.mp4'
const OPERAZIONE = 'gallery/pubblicazione-video:test'
const DESTINAZIONE = `uploads/${OWNER}/v-${INTENT}.mp4`
const BYTE = 12_345_678

type ChiamataCopy = { bucket: string; da: string; a: string; opzioni: unknown }

/**
 * Uno Storage finto con la sola superficie che questo modulo tocca: `copy` e `info`. C'è anche
 * `remove`, ma come CAMPANELLO: il modulo non rimuove mai niente, e `rimozioni` lo prova (un
 * `remove` che qualcuno aggiungesse un giorno lascerebbe qui la sua traccia).
 *
 * `oggetti` è lo stato VERO del finto bucket (`<bucket>/<percorso>` → byte), e `copy` lo
 * rispetta: copiare su un percorso già occupato risponde 409 come fa lo Storage, invece
 * di un errore scelto dal test. Così il caso «esiste già» si misura sul comportamento e
 * non sul copione.
 */
function storageFinto(opzioni: {
    copy?: { error?: unknown; lancia?: unknown }
    oggetti?: Record<string, number>
    /** Fa fallire `info` per questi `<bucket>/<percorso>` (errore restituito). */
    infoErrore?: Record<string, unknown>
    infoLancia?: boolean
}) {
    const copie: ChiamataCopy[] = []
    const info: string[] = []
    const rimozioni: string[][] = []
    const oggetti = { ...(opzioni.oggetti ?? {}) }
    const client = {
        storage: {
            from(bucket: string) {
                return {
                    copy: async (da: string, a: string, opt: unknown) => {
                        copie.push({ bucket, da, a, opzioni: opt })
                        if (opzioni.copy?.lancia) throw opzioni.copy.lancia
                        if (opzioni.copy?.error) return { data: null, error: opzioni.copy.error }
                        const destinazione = `${(opt as { destinationBucket?: string } | undefined)?.destinationBucket ?? bucket}/${a}`
                        if (destinazione in oggetti) {
                            // Come lo Storage vero: HTTP 409, stesso codice nel corpo.
                            return {
                                data: null,
                                error: { name: 'StorageApiError', message: 'The resource already exists', status: 409, statusCode: '409' },
                            }
                        }
                        oggetti[destinazione] = oggetti[`${bucket}/${da}`] ?? BYTE
                        return { data: { path: a }, error: null }
                    },
                    info: async (percorso: string) => {
                        info.push(`${bucket}/${percorso}`)
                        if (opzioni.infoLancia) throw new Error('fetch failed')
                        const errore = opzioni.infoErrore?.[`${bucket}/${percorso}`]
                        if (errore) return { data: null, error: errore }
                        const byte = oggetti[`${bucket}/${percorso}`]
                        if (byte === undefined) {
                            return { data: null, error: { message: 'Object not found', status: 404, statusCode: '404' } }
                        }
                        return { data: { size: byte }, error: null }
                    },
                    remove: async (percorsi: string[]) => {
                        rimozioni.push(percorsi)
                        return { data: percorsi.map((name) => ({ name })), error: null }
                    },
                }
            },
        },
    }
    return { client, copie, info, rimozioni, oggetti }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comeClient = (c: unknown) => c as any

/** La chiamata di sempre, con un solo campo da cambiare per volta. */
const copia = (
    client: unknown,
    extra: Partial<Parameters<typeof copiaVideoInGalleria>[1]> = {},
) =>
    copiaVideoInGalleria(comeClient(client), {
        bucketSorgente: 'video_processing',
        percorsoSorgente: SORGENTE,
        byte: BYTE,
        ownerId: OWNER,
        intentId: INTENT,
        operazione: OPERAZIONE,
        ...extra,
    })

const righeDiLog = (esito: string) => log.logEvento.mock.calls.filter((c) => c[2]?.esito === esito)

beforeEach(() => {
    vi.clearAllMocks()
})

describe('percorsoVideoInGalleria — deterministico, e nella forma che la RPC accetta', () => {
    it('è `uploads/<owner>/v-<intento>.mp4`, sempre lo stesso per lo stesso intento', () => {
        expect(percorsoVideoInGalleria(OWNER, INTENT)).toBe(DESTINAZIONE)
        expect(percorsoVideoInGalleria(OWNER, INTENT)).toBe(percorsoVideoInGalleria(OWNER, INTENT))
        expect(percorsoVideoInGalleria(OWNER, ALTRO_INTENT)).not.toBe(DESTINAZIONE)
    })

    it('supera `percorsoUploadProprio` e la regola di `video_galleria_pubblica` (FILE_URL_NON_VALIDO)', () => {
        const percorso = percorsoVideoInGalleria(OWNER, INTENT)
        // La stessa forma che `video_galleria_pubblica` verifica in SQL (migrazione
        // `video_pubblicazione_automatica`): un solo segmento `[A-Za-z0-9_-]+`, un'estensione
        // minuscola, dentro la cartella dell'autore, al massimo 1024 caratteri.
        expect(percorso).toMatch(new RegExp(`^uploads/${OWNER}/[A-Za-z0-9_-]+\\.[a-z0-9]+$`))
        expect(percorso.length).toBeLessThanOrEqual(1024)
        // …e quella che la pubblicazione delle foto impone in TypeScript.
        expect(percorsoUploadProprio(percorso, OWNER)).toBe(true)
        // Il percorso di un altro autore NON è il suo.
        expect(percorsoUploadProprio(percorso, '99999999-9999-4999-8999-999999999999')).toBe(false)
    })
})

describe('percorsoVideoInGalleria — e il controllo VERO della RPC, letto dalla migrazione', () => {
    it('il percorso supera la regola di `video_galleria_pubblica` così com’è scritta in SQL (se cambia, questo test lo dice)', () => {
        // Il test qui sopra ricopia la regola; questo la LEGGE. Se un giorno la RPC restringesse
        // il segmento (niente trattini, un'estensione diversa…) il percorso deterministico
        // verrebbe rifiutato in produzione con `FILE_URL_NON_VALIDO`, un difetto nostro che
        // nessun test di questo file vedrebbe. Le migrazioni si rinominano all'istante vero del
        // rilascio: si cerca per CONTENUTO, mai per nome di file.
        const cartella = join(__dirname, '..', '..', 'supabase', 'migrations')
        const sorgenti = readdirSync(cartella)
            .filter((f) => f.endsWith('.sql'))
            .map((f) => ({ f, sql: readFileSync(join(cartella, f), 'utf8') }))
            .filter(({ sql }) => sql.includes('FILE_URL_NON_VALIDO') && sql.includes('video_galleria_pubblica'))
        expect(sorgenti.length, 'nessuna migrazione definisce più il controllo FILE_URL_NON_VALIDO').toBeGreaterThan(0)

        for (const { f, sql } of sorgenti) {
            const m = sql.match(/'\^uploads\/'\s*\|\|\s*p_owner_id::text\s*\|\|\s*'([^']+)'/)
            expect(
                m,
                `${f}: la forma del controllo del percorso è cambiata. Aggiornare questo test e \`percorsoVideoInGalleria\`.`,
            ).not.toBeNull()
            const regola = new RegExp(`^uploads/${OWNER}${m![1]}`)
            expect(percorsoVideoInGalleria(OWNER, INTENT), `${f}: la RPC rifiuterebbe il percorso deterministico`).toMatch(regola)
            // E la regola ha i denti: un percorso nella cartella di un altro autore non la supera.
            expect(percorsoVideoInGalleria('99999999-9999-4999-8999-999999999999', INTENT)).not.toMatch(regola)
        }
    })
})

describe('copiaVideoInGalleria — l’uscita convertita entra in `gallery`, non ci si sposta', () => {
    it('copia dal bucket di lavorazione a `gallery`, sul percorso deterministico dell’intento', async () => {
        const s = storageFinto({})
        const esito = await copia(s.client)

        expect(esito).toEqual({ ok: true, percorso: DESTINAZIONE, giaPresente: false })
        // Il prefisso è l'uuid di CHI PUBBLICA, come in `gallery/upload-url`: è l'unica cosa
        // che separa i file di una maestra da quelli di un'altra, e il nome NON contiene
        // niente che venga dal file originale (che si chiama `IMG_bambina-rossi.mov`:
        // anagrafica di un minore).
        expect(s.copie).toHaveLength(1)
        expect(s.copie[0].bucket).toBe('video_processing')
        expect(s.copie[0].da).toBe(SORGENTE)
        expect(s.copie[0].a).toBe(DESTINAZIONE)
        expect(s.copie[0].opzioni).toEqual({ destinationBucket: BUCKET_GALLERIA })
        // Una copia nuova non ha bisogno di leggere niente.
        expect(s.info).toEqual([])
    })

    it('due tentativi sullo stesso intento puntano allo STESSO file (è il punto del nome fisso)', async () => {
        const primo = storageFinto({})
        const secondo = storageFinto({})
        const a = await copia(primo.client)
        const b = await copia(secondo.client)
        expect(a.ok && b.ok && a.percorso === b.percorso).toBe(true)
        expect(primo.copie[0].a).toBe(secondo.copie[0].a)
    })

    it('il SUCCESSO si logga (evento critico: senza, «nessun log» non distingue i due casi)', async () => {
        const s = storageFinto({})
        await copia(s.client, { byte: 1024 })
        const riga = righeDiLog('video-copiato-in-galleria')[0]
        expect(riga, 'la copia riuscita deve lasciare una riga').toBeTruthy()
        expect(riga[1]).toBe('info')
        // Mai il percorso nei log: porta l'uuid di chi carica e l'intento.
        expect(JSON.stringify(riga[2])).not.toContain(SORGENTE)
        expect(JSON.stringify(riga[2])).not.toContain(DESTINAZIONE)
        expect(JSON.stringify(riga[2])).not.toContain(OWNER)
    })

    it('un’uscita oltre il tetto del bucket viene rifiutata PRIMA di toccare lo Storage', async () => {
        const s = storageFinto({})
        const esito = await copia(s.client, { byte: TETTO_VIDEO_GALLERIA_BYTE + 1 })
        expect(esito).toEqual({ ok: false, codice: 'OUTPUT_TOO_LARGE' })
        // Il punto: lo Storage rifiuterebbe comunque, ma dopo aver spedito i byte.
        expect(s.copie).toHaveLength(0)
    })

    it('`copy` che RITORNA un errore: niente percorso, e il corpo del fornitore resta nel log', async () => {
        const s = storageFinto({ copy: { error: { message: 'Payload too large', statusCode: '413' } } })
        const esito = await copia(s.client, { byte: 1024 })
        expect(esito).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
        expect(log.logErrore).toHaveBeenCalled()
        // «413» non dice niente; «413 Payload too large» dice tutto (AGENTS §3).
        const [, errore] = log.logErrore.mock.calls[0]
        expect(JSON.stringify(errore)).toContain('Payload too large')
        // Un errore che NON è un 409 non apre nessuna verifica: non c'è niente da adottare.
        expect(s.info).toEqual([])
    })

    it('`copy` che LANCIA (guasto di trasporto) non sfugge: stesso esito, stesso log', async () => {
        const s = storageFinto({ copy: { lancia: new Error('fetch failed') } })
        const esito = await copia(s.client, { byte: 1024 })
        expect(esito).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
        expect(log.logErrore).toHaveBeenCalled()
        // `JSON.stringify(new Error(…))` vale `{}`: un'asserzione scritta così
        // sarebbe passata anche su un `catch` muto che logga un oggetto vuoto.
        // Si guarda il messaggio, che è la cosa che deve arrivare a chi indaga.
        expect((log.logErrore.mock.calls[0][1] as Error).message).toBe('fetch failed')
    })

    it('un id che non è un uuid non diventa un percorso: nessuna chiamata allo Storage', async () => {
        // Un `/` o un `..` in un id scriverebbe fuori dalla cartella dell'autore.
        for (const extra of [
            { intentId: '../../altro-autore/x' },
            { intentId: `${INTENT}/../x` },
            { intentId: '' },
            { ownerId: `${OWNER}/..` },
            { ownerId: 'non-un-uuid' },
        ]) {
            const s = storageFinto({})
            const esito = await copia(s.client, extra)
            expect(esito, JSON.stringify(extra)).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
            expect(s.copie, JSON.stringify(extra)).toEqual([])
            expect(s.info, JSON.stringify(extra)).toEqual([])
        }
        const riga = righeDiLog('video-percorso-non-valido')[0]
        expect(riga?.[1]).toBe('error')
        expect(JSON.stringify(log.logEvento.mock.calls)).not.toContain('altro-autore')
    })
})

describe('copiaVideoInGalleria — il percorso è già occupato (un tentativo precedente è arrivato fin lì)', () => {
    const DEST_CHIAVE = `${BUCKET_GALLERIA}/${DESTINAZIONE}`

    it('STESSA dimensione ⇒ vale come riuscita, e la copia non si rifà', async () => {
        const s = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE } })
        const esito = await copia(s.client)

        expect(esito).toEqual({ ok: true, percorso: DESTINAZIONE, giaPresente: true })
        // Ha provato a copiare (è così che ha scoperto il 409) e poi ha LETTO la destinazione.
        expect(s.copie).toHaveLength(1)
        expect(s.info).toEqual([DEST_CHIAVE])
        // Un file che c'è e pesa giusto non si tocca.
        expect(s.rimozioni).toEqual([])
        const riga = righeDiLog('video-copia-gia-presente')[0]
        expect(riga, 'riusare una copia già fatta deve lasciare una riga').toBeTruthy()
        expect(riga[1]).toBe('info')
        expect(riga[2]).toMatchObject({ byte: BYTE })
        expect(JSON.stringify(riga[2])).not.toContain(DESTINAZIONE)
    })

    it.each([
        ['il solo stato HTTP', { status: 409 }],
        ['il solo codice di stato del corpo', { statusCode: '409' }],
        ['il solo messaggio', { message: 'The resource already exists' }],
    ])('il 409 si riconosce anche da %s', async (_nome, errore) => {
        const s = storageFinto({ copy: { error: errore }, oggetti: { [DEST_CHIAVE]: BYTE } })
        const esito = await copia(s.client)
        expect(esito).toEqual({ ok: true, percorso: DESTINAZIONE, giaPresente: true })
    })

    it('dimensione DIVERSA ⇒ errore, e si grida: un file qualunque non si adotta', async () => {
        const s = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE + 1 } })
        const esito = await copia(s.client)

        expect(esito).toEqual({ ok: false, codice: 'DESTINAZIONE_DIVERSA' })
        const grido = righeDiLog('video-copia-destinazione-diversa')[0]
        expect(grido?.[1]).toBe('error')
        // Solo numeri: il percorso porta con sé chi ha caricato.
        expect(grido?.[2]).toMatchObject({ byte_attesi: BYTE, byte_trovati: BYTE + 1 })
        expect(JSON.stringify(grido?.[2])).not.toContain(DESTINAZIONE)
        // E il file estraneo non si tocca: non si sa di chi sia.
        expect(s.rimozioni).toEqual([])
        expect(righeDiLog('video-copia-gia-presente')).toEqual([])
    })

    it('una dimensione di zero byte NON è «uguale»: confronta davvero, non per verità', async () => {
        const s = storageFinto({ oggetti: { [DEST_CHIAVE]: 0 } })
        const esito = await copia(s.client)
        expect(esito).toEqual({ ok: false, codice: 'DESTINAZIONE_DIVERSA' })
    })

    it('senza la dimensione attesa (`byte: null`) si confronta con quella della SORGENTE', async () => {
        const uguale = storageFinto({
            oggetti: { [DEST_CHIAVE]: BYTE, [`video_processing/${SORGENTE}`]: BYTE },
        })
        expect(await copia(uguale.client, { byte: null })).toEqual({
            ok: true,
            percorso: DESTINAZIONE,
            giaPresente: true,
        })
        expect(uguale.info).toEqual([DEST_CHIAVE, `video_processing/${SORGENTE}`])

        const diversa = storageFinto({
            oggetti: { [DEST_CHIAVE]: BYTE, [`video_processing/${SORGENTE}`]: BYTE + 5 },
        })
        expect(await copia(diversa.client, { byte: null })).toEqual({ ok: false, codice: 'DESTINAZIONE_DIVERSA' })
    })

    it('«non so quanto pesa» non vale «pesa giusto»: ogni lettura fallita è `COPIA_NON_RIUSCITA`', async () => {
        // Destinazione illeggibile.
        const a = storageFinto({
            oggetti: { [DEST_CHIAVE]: BYTE },
            infoErrore: { [DEST_CHIAVE]: { message: 'Internal', status: 500, statusCode: '500' } },
        })
        expect(await copia(a.client)).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
        expect(righeDiLog('video-copia-verifica-non-riuscita')[0]?.[1]).toBe('error')

        // `info` che lancia (trasporto).
        const b = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE }, infoLancia: true })
        expect(await copia(b.client)).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })

        // Senza `byte` e con la sorgente illeggibile.
        const c = storageFinto({
            oggetti: { [DEST_CHIAVE]: BYTE },
            infoErrore: { [`video_processing/${SORGENTE}`]: { message: 'Internal', status: 500, statusCode: '500' } },
        })
        expect(await copia(c.client, { byte: null })).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })

        // Il 409 c'è, ma l'oggetto non risulta (cancellato fra le due chiamate): non si adotta.
        const d = storageFinto({ copy: { error: { status: 409 } } })
        expect(await copia(d.client)).toEqual({ ok: false, codice: 'COPIA_NON_RIUSCITA' })
    })

    it('mai un percorso, un nome o un uuid di chi carica nei log di questo ramo', async () => {
        const s1 = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE } })
        const s2 = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE + 1 } })
        const s3 = storageFinto({ oggetti: { [DEST_CHIAVE]: BYTE }, infoLancia: true })
        await copia(s1.client)
        await copia(s2.client)
        await copia(s3.client)
        const tutto = JSON.stringify(log.logEvento.mock.calls)
        expect(tutto).not.toContain(OWNER)
        expect(tutto).not.toContain(INTENT)
        expect(tutto).not.toContain('v-')
    })
})

describe('copiaVideoInGalleria — il client vero soddisfa il tipo', () => {
    it('un `SupabaseClient` è accettato (se `info` o `copy` cambiassero forma, tsc lo dice qui)', () => {
        // Compile-time: nessuna riga di runtime. Un finto che compila e un client vero che no
        // sarebbe la forma di verde più comoda che esista.
        const _clientVero: Parameters<typeof copiaVideoInGalleria>[0] = null as unknown as SupabaseClient
        expect(_clientVero).toBeNull()
    })
})

describe('niente rimozione da qui: la copia orfana la toglie la spazzata, non il pubblicatore (spec §8.3)', () => {
    // Senza commenti: le testate di questi due file NOMINANO `remove` e `annullaCopiaVideoInGalleria` per spiegare perché non ci sono, e
    // un lock che le contasse come usi sarebbe rosso per il motivo sbagliato (o immunizzato dal proprio commento).
    const codice = (rel: string) => mascheraSorgente(readFileSync(join(process.cwd(), rel), 'utf8')).senzaCommenti
    const MODULI = ['src/lib/gallery/video-pubblicazione.ts', 'src/lib/gallery/pubblicazione-video-automatica.ts']

    it.each(MODULI)('`%s` non rimuove niente da `gallery`: né una `remove` né `rimuoviEVerifica`', (rel) => {
        const sorgente = codice(rel)
        expect(sorgente, `${rel}: una remove sul percorso di un video che la RPC potrebbe aver già pubblicato`).not.toMatch(/\.remove\s*\(/)
        expect(sorgente).not.toMatch(/\brimuoviEVerifica\b/)
        expect(sorgente).not.toMatch(/\bannullaCopiaVideoInGalleria\b/)
    })

    it('il controllo vede davvero il sorgente (controllo positivo: la copia e il suo tetto ci sono)', () => {
        expect(codice('src/lib/gallery/video-pubblicazione.ts')).toMatch(/\.copy\s*\(/)
        expect(codice('src/lib/gallery/pubblicazione-video-automatica.ts')).toMatch(/copiaVideoInGalleria\s*\(/)
    })

    it('e nessun altro file di `src/` chiama più `annullaCopiaVideoInGalleria`', () => {
        const trovati: string[] = []
        const visita = (cartella: string) => {
            for (const voce of readdirSync(cartella, { withFileTypes: true })) {
                const percorso = join(cartella, voce.name)
                if (voce.isDirectory()) visita(percorso)
                else if (/\.(ts|tsx)$/.test(voce.name) && /\bannullaCopiaVideoInGalleria\b/.test(mascheraSorgente(readFileSync(percorso, 'utf8')).senzaCommenti)) {
                    trovati.push(percorso)
                }
            }
        }
        visita(join(process.cwd(), 'src'))
        expect(trovati).toEqual([])
    })
})
