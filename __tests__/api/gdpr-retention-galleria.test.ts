import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GIORNI_CESTINO_GALLERIA } from '@/lib/gallery/cestino'

// =============================================================================
// LA PURGA DEL CESTINO DELLA GALLERIA — e le cinque cose che i due gemelli
// (`retention-candidature`, `retention-personale`) hanno già pagato al posto
// nostro.
//
// 1. PRIMA IL FILE, POI LA RIGA — e per riga, non per lotto. Al contrario, un
//    errore a metà lascerebbe la foto nel bucket senza più nessuna riga che la
//    nomini: irraggiungibile, non cancellata, e nemmeno identificabile per
//    cancellarla se una famiglia lo chiedesse.
// 2. FRA IL FILE E LA RIGA C'È `file_rimosso_il`. È il timbro che rende la purga
//    idempotente: se la `delete` fallisce, il giro dopo riprende quella riga
//    senza richiedere niente allo Storage — e nel frattempo il cestino non offre
//    più un «Ripristina» su una foto che non esiste.
// 3. IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO, dentro un `finally`. Con i soli
//    errori, «nessun log» non distingue «cestino vuoto» da «la purga non parte
//    più».
// 4. RIGHE TRATTENUTE ⇒ 500. Un 200 direbbe «fatto» a chi sorveglia il lavoro
//    notturno, e resterebbero foto di minori nell'archivio oltre il termine.
// 5. IL TERMINE APPLICATO È IL TERMINE PROMESSO. I trenta giorni non sono un
//    numero di questo file né della route: sono `GIORNI_CESTINO_GALLERIA`, la
//    stessa costante che l'elenco del cestino legge e che il lock
//    `cestino-galleria-ogni-lettura-dichiara` confronta con il testo che
//    l'insegnante vede nel dialogo di eliminazione.
//
// E una sesta, che è di questo dominio e non dei gemelli: **il percorso nel
// bucket è una credenziale, e la didascalia è spesso il nome di un bambino**. Il
// percorso è `uploads/<uuid utente>/<nome>`: con quello si firma la foto di un
// minore in un bucket privato. `app_log` è interrogabile in SQL per 30 giorni.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-galleria-non-usato-altrove'

/** Il bucket, e l'uuid di una cartella-utente: il percorso ha TRE segmenti. */
const UTENTE = '11111111-1111-4111-8111-111111111111'
const ALTRO_UTENTE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
    /**
     * LA SEQUENZA REALE DELLE OPERAZIONI: è l'ORDINE la cosa da provare.
     * `remove` → `update` (il timbro) → `delete`. Un mock che non registrasse
     * l'ordine renderebbe verde una route che cancella la riga e poi prova a
     * togliere il file — cioè il difetto che tutta la famiglia esiste per
     * impedire.
     */
    sequenza: [] as { tipo: 'remove' | 'update' | 'delete'; tabella?: string; valore: unknown }[],
    /** Le colonne chieste a ogni `select()`: i due lotti si distinguono da qui. */
    select: [] as string[],
    /**
     * GLI ARGOMENTI DELLE CLAUSOLE, E LA QUERY A CUI APPARTENGONO.
     *
     * Non registrare gli argomenti è un difetto già misurato sul gemello: la
     * clausola WHERE diventa INVISIBILE alla suite, e una soglia sbagliata (30
     * giorni → 300) passerebbe con tutti i test verdi.
     *
     * ⚠️ MA REGISTRARE GLI ARGOMENTI NON BASTA, e questa versione del doppio esiste
     * perché la precedente lo dava per fatto. Registrava `{tabella, metodo,
     * argomenti}` e **non l'operazione**: le asserzioni potevano dire soltanto «da
     * qualche parte in questo giro, su questa tabella, esiste una clausola così»,
     * che è un'affermazione quasi sempre vera e quindi quasi mai una prova.
     * Misurato il 2026-09-12, su questo stesso file:
     *   · togliendo il taglio dei 30 giorni dal LOTTO A — la lettura che decide
     *     quali FILE vengono distrutti — il `lt` del lotto B soddisfaceva da solo
     *     la prova intitolata «la SOGLIA applicata è GIORNI_CESTINO_GALLERIA»:
     *     48 prove su 48 verdi, e la purga avrebbe distrutto una foto cestinata
     *     ieri, ventinove giorni prima del termine promesso all'insegnante;
     *   · togliendo dalla `delete` la cintura `eliminato_il IS NOT NULL`, le tre
     *     LETTURE ne emettevano già a sufficienza per soddisfare la prova
     *     intitolata «una riga VIVA non è raggiungibile»: 48 su 48 verdi, e cadeva
     *     l'ultima difesa contro la distruzione di una foto che nessuno ha messo
     *     nel cestino.
     * Perciò ogni clausola porta `operazione` (la `select`/`update`/`delete` a cui
     * appartiene), `colonne` (che distingue il lotto A dal lotto B) e `ordinale`
     * (che distingue un lotto di scrittura dal successivo). Le asserzioni si fanno
     * **per query**, non sul flusso.
     */
    clausole: [] as {
        tabella: string
        operazione: string
        ordinale: number
        colonne?: string
        metodo: string
        argomenti: unknown[]
    }[],
    /**
     * IL CENSIMENTO DELLE QUERY, clausole o no.
     *
     * Serve a rendere universale un'affermazione come «OGNI `delete` su
     * `galleria_media_v2` porta la sua cintura»: senza il censimento, una `delete`
     * con NESSUNA clausola — il caso peggiore, quello che cancella tutto — non
     * comparirebbe da nessuna parte e il `for` girerebbe a vuoto, verde.
     */
    query: [] as { ordinale: number; tabella: string; operazione: string; colonne?: string }[],
    nQuery: 0,
    /** LOTTO A — le righe scadute il cui file è ancora nel bucket. */
    righeConFile: [] as Record<string, unknown>[],
    /** LOTTO B — le righe già timbrate: la RIPRESA dopo una `delete` fallita. */
    righeSenzaFile: [] as Record<string, unknown>[],
    erroreLottoA: null as unknown,
    erroreLottoB: null as unknown,
    erroreTimbro: null as unknown,
    erroreDelete: null as unknown,
    erroreSegnalazioni: null as unknown,
    /** Il `count` che PostgREST restituisce sulla `delete` delle righe. */
    countDelete: undefined as number | undefined,
    countSegnalazioni: undefined as number | undefined,
    /** `true` ⇒ PostgREST il conteggio NON lo restituisce, anche se richiesto. */
    countAssente: false,
    eccezioneClient: null as unknown,
    // ── LO STORAGE ──
    /** Cosa risponde `storage.remove()`. `null` ⇒ ha tolto tutto ciò che gli è stato chiesto. */
    removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
    /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket. */
    ancoraNelBucket: new Set<string>(),
    /** Le verifiche PER FILE (`list` con `search`): una per percorso non uscito. */
    verifiche: [] as string[],
    erroreVerifica: null as unknown,
    // ── LA SPAZZATA DEGLI ORFANI, che è a DUE livelli ──
    /** Le voci che lo Storage elenca sotto `uploads` (cartelle-utente, `id: null`). */
    radice: [] as { name?: string | null; id?: string | null; created_at?: string | null }[],
    /** I file dentro ogni cartella-utente, per percorso di cartella. */
    dentro: {} as Record<string, { name?: string | null; id?: string | null; created_at?: string | null }[]>,
    /** Le elencazioni del prefisso: cartella e opzioni, come le riceve la Storage API. */
    elencazioni: [] as { cartella: string; opzioni: unknown }[],
    erroreRadice: null as unknown,
    /** Le cartelle il cui elenco fallisce. */
    cartelleRotte: new Set<string>(),
    /**
     * LE RIGHE, OLTRE A QUELLE DEL LOTTO, CHE NOMINANO UN PERCORSO.
     *
     * Su `file_url` non c'è nessun indice UNIQUE, e il 2026-09-12 due righe VIVE
     * condividono lo stesso percorso in produzione (nate a 0,33 s di distanza, da
     * una `POST` dei metadati arrivata due volte). Questo fixture è quel fatto.
     */
    righeCheNominano: [] as { id: string; file_url: string }[],
    erroreRigheCheNominano: null as unknown,
    /** I `file_url` che il database dichiara reclamati da una riga (cestino compreso). */
    reclamati: [] as string[],
    erroreReclamati: null as unknown,
    /** Quante righe NON portano un percorso nudo: > 0 ⇒ la spazzata non parte. */
    nonConfrontabili: 0,
    erroreConfronto: null as unknown,
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
    staffNegato: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn(async () =>
        h.staffNegato
            ? { user: null, response: h.staffNegato }
            : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
    ),
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        if (h.eccezioneClient) throw h.eccezioneClient

        // ⚠️ I FILTRI DEL CESTINO NON SONO MOCKATI. `soloNelCestino`,
        // `ancheNelCestino` e `colonnaCestinoAssente` arrivano dal modulo VERO
        // (`src/lib/gallery/cestino.ts`): il doppio si limita a implementare `is`,
        // `not` e `lt` restituendo sé stesso, che è ciò che fa PostgREST. Mockare
        // quel modulo renderebbe verde una route che non filtra il cestino affatto.
        const builder = (tabella: string) => {
            const ordinale = ++h.nQuery
            // Le clausole si accumulano QUI e si versano in `h.clausole` solo quando
            // la query viene attesa: prima di `then()` l'operazione può ancora
            // cambiare (`.delete()` si chiama dopo `.from()`), e registrare
            // un'operazione provvisoria rimetterebbe dentro la cecità che questo
            // doppio è stato riscritto per togliere.
            const proprie: { metodo: string; argomenti: unknown[] }[] = []
            let versato = false
            const qb: Record<string, unknown> = { __tabella: tabella, __op: 'select' }
            qb.select = (colonne: string, opzioni?: { count?: string; head?: boolean }) => {
                qb.__colonne = colonne
                qb.__opzioni = opzioni
                h.select.push(colonne)
                return qb
            }
            qb.update = (patch: unknown) => {
                qb.__op = 'update'
                qb.__patch = patch
                return qb
            }
            qb.delete = (opzioni?: { count?: string }) => {
                qb.__op = 'delete'
                qb.__conteggio = opzioni?.count
                return qb
            }
            for (const m of ['not', 'is', 'lt', 'gt', 'eq', 'order', 'limit']) {
                qb[m] = (...argomenti: unknown[]) => {
                    proprie.push({ metodo: m, argomenti })
                    return qb
                }
            }
            qb.in = (...argomenti: unknown[]) => {
                proprie.push({ metodo: 'in', argomenti })
                qb.__in = argomenti[1]
                return qb
            }
            const versa = () => {
                if (versato) return
                versato = true
                const operazione = qb.__op as string
                const colonne = qb.__colonne as string | undefined
                h.query.push({ ordinale, tabella, operazione, colonne })
                for (const c of proprie) {
                    h.clausole.push({ tabella, operazione, ordinale, colonne, ...c })
                }
            }
            qb.then = (res: (v: unknown) => unknown) => {
                versa()
                const ids = (qb.__in as string[] | undefined) ?? []
                if (qb.__op === 'update') {
                    h.sequenza.push({ tipo: 'update', tabella, valore: { patch: qb.__patch, ids } })
                    return Promise.resolve({ data: null, error: h.erroreTimbro }).then(res)
                }
                if (qb.__op === 'delete') {
                    h.sequenza.push({ tipo: 'delete', tabella, valore: ids })
                    if (tabella === 'segnalazioni') {
                        return Promise.resolve({
                            data: null,
                            error: h.erroreSegnalazioni,
                            count: h.countSegnalazioni ?? ids.length,
                        }).then(res)
                    }
                    // Il `count` arriva SOLO se la route l'ha chiesto: un mock che lo
                    // restituisse sempre certificherebbe una route che non lo chiede.
                    const count =
                        qb.__conteggio === 'exact' && !h.countAssente
                            ? (h.countDelete ?? ids.length)
                            : undefined
                    return Promise.resolve({ data: null, error: h.erroreDelete, count }).then(res)
                }
                // ── LE QUATTRO LETTURE, tenute separate dalle colonne chieste ──
                const colonne = qb.__colonne as string
                if (colonne === 'id, file_url, eliminato_il') {
                    return Promise.resolve({ data: h.righeConFile, error: h.erroreLottoA }).then(res)
                }
                if (colonne === 'id, eliminato_il') {
                    return Promise.resolve({ data: h.righeSenzaFile, error: h.erroreLottoB }).then(res)
                }
                if (colonne === 'id, file_url') {
                    // ⚠️ IL DOPPIO RISPONDE COME RISPONDEREBBE POSTGREST, E QUINDI
                    // COMPRENDE LE RIGHE CHE STIAMO CANCELLANDO: sono loro le prime a
                    // nominare quei percorsi. Un doppio che le omettesse renderebbe
                    // verde una route che non le esclude per `id` — e quella route non
                    // distruggerebbe MAI niente, perché ogni file risulterebbe
                    // reclamato da sé stesso.
                    const lotto = new Set(ids)
                    if (h.erroreRigheCheNominano) {
                        return Promise.resolve({ data: null, error: h.erroreRigheCheNominano }).then(res)
                    }
                    const tabellaIntera = [
                        ...h.righeConFile.map((r) => ({ id: r.id as string, file_url: r.file_url as string })),
                        ...h.righeCheNominano,
                    ]
                    return Promise.resolve({
                        data: tabellaIntera.filter((r) => lotto.has(r.file_url)),
                        error: null,
                    }).then(res)
                }
                if (colonne === 'file_url') {
                    // La risposta contiene solo i percorsi CHIESTI, come fa PostgREST: un
                    // doppio che restituisse tutti i reclamati a ogni lotto renderebbe
                    // verde una route che sbaglia a spezzare i lotti.
                    const lotto = new Set(ids)
                    return Promise.resolve(
                        h.erroreReclamati
                            ? { data: null, error: h.erroreReclamati }
                            : {
                                  data: h.reclamati
                                      .filter((p) => lotto.has(p))
                                      .map((file_url) => ({ file_url })),
                                  error: null,
                              },
                    ).then(res)
                }
                if (colonne === 'id') {
                    return Promise.resolve({
                        data: null,
                        error: h.erroreConfronto,
                        count: h.nonConfrontabili,
                    }).then(res)
                }
                return Promise.resolve({ data: [], error: null }).then(res)
            }
            return qb
        }

        return {
            from: builder,
            storage: {
                from: () => ({
                    remove: (percorsi: string[]) => {
                        h.sequenza.push({ tipo: 'remove', valore: percorsi })
                        return Promise.resolve(
                            h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
                        )
                    },
                    // ⚠️ `list()` serve TRE scopi, e confonderli è il modo più facile di
                    // rendere verde una spazzata cieca: `rimuoviEVerifica` chiede di UN
                    // percorso passando `search`; la spazzata elenca il PREFISSO (le
                    // cartelle-utente) e poi OGNI CARTELLA. Il doppio li distingue sugli
                    // stessi parametri su cui li distingue la Storage API.
                    list: (cartella: string, opzioni?: { search?: string }) => {
                        if (typeof opzioni?.search === 'string') {
                            const nome = opzioni.search
                            h.verifiche.push(`${cartella}|${nome}`)
                            if (h.erroreVerifica) return Promise.resolve({ data: null, error: h.erroreVerifica })
                            const completo = cartella ? `${cartella}/${nome}` : nome
                            return Promise.resolve({
                                data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
                                error: null,
                            })
                        }
                        h.elencazioni.push({ cartella, opzioni })
                        if (cartella === 'uploads') {
                            if (h.erroreRadice) return Promise.resolve({ data: null, error: h.erroreRadice })
                            return Promise.resolve({ data: h.radice, error: null })
                        }
                        if (h.cartelleRotte.has(cartella)) {
                            return Promise.resolve({ data: null, error: { code: 'X', message: 'no' } })
                        }
                        return Promise.resolve({ data: h.dentro[cartella] ?? [], error: null })
                    },
                }),
            },
        }
    },
}))

import { POST } from '@/app/api/gdpr/retention-galleria/route'

const SORGENTE_ROUTE = readFileSync(
    join(process.cwd(), 'src/app/api/gdpr/retention-galleria/route.ts'),
    'utf8',
)

/**
 * Le costanti della route, LETTE dal sorgente invece che ribattute: se il giorno in
 * cui la grazia degli orfani si sposta questi test restassero verdi col numero
 * vecchio, misurerebbero una regola che non è più quella applicata.
 */
const ORE_GRAZIA = Number(SORGENTE_ROUTE.match(/ORE_GRAZIA_ORFANI = (\d+)/)![1])
const TETTO_LOTTO = Number(SORGENTE_ROUTE.match(/TETTO_LOTTO = (\d+)/)![1])
const LOTTO_RECLAMI = Number(SORGENTE_ROUTE.match(/LOTTO_RECLAMI = (\d+)/)![1])
const LOTTO_SCRITTURA = Number(SORGENTE_ROUTE.match(/LOTTO_SCRITTURA = (\d+)/)![1])

/**
 * SANITA DELLE COSTANTI ESTRATTE — e il guinzaglio del pattern qui sopra.
 *
 * Le quattro costanti si leggono dalla SORGENTE della route, non si ricopiano: cosi
 * il test misura la regola applicata e non una vecchia. Ma un'estrazione che non
 * viene mai usata e un'estrazione che nessuno verifica: se un domani la route
 * rinominasse `LOTTO_SCRITTURA`, il `!` della regex esploderebbe in fase di
 * caricamento e il messaggio non direbbe perche. Questo test lo dice.
 */
describe('le costanti del lotto vengono dalla route, non da qui', () => {
    it('tutte e quattro sono state trovate, e sono numeri plausibili', () => {
        expect(Number.isInteger(ORE_GRAZIA)).toBe(true)
        expect(ORE_GRAZIA).toBeGreaterThan(0)
        // I lotti hanno un tetto per non tenere aperta una transazione lunga su una
        // tabella che le insegnanti stanno scrivendo adesso: un tetto a zero
        // fermerebbe la purga, uno enorme la renderebbe un lock.
        for (const [nome, valore] of [['TETTO_LOTTO', TETTO_LOTTO], ['LOTTO_RECLAMI', LOTTO_RECLAMI], ['LOTTO_SCRITTURA', LOTTO_SCRITTURA]] as const) {
            expect(Number.isInteger(valore), nome).toBe(true)
            expect(valore, nome).toBeGreaterThan(0)
            expect(valore, nome).toBeLessThanOrEqual(1000)
        }
    })
})

const chiama = (headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) =>
    POST(
        new Request('http://localhost/api/gdpr/retention-galleria', {
            method: 'POST',
            headers,
        }) as never,
    )

/** Una data di `n` giorni fa. */
const giorniFa = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
/** Una data di `n` ore fa. */
const oreFa = (n: number): string => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

/** Il percorso nudo, nella forma che il prodotto produce: `uploads/<utente>/<nome>`. */
const percorso = (utente: string, nome: string) => `uploads/${utente}/${nome}`

/**
 * Una riga del cestino scaduta, col percorso NELLA FORMA CHE IL PRODOTTO PRODUCE.
 * Misurato in produzione il 2026-09-12: 1.327 righe su 1.327 hanno `file_url` nella
 * forma `uploads/…`, zero sono URL completi. Un fixture che usasse una forma che il
 * prodotto non genera metterebbe alla prova un caso che non accade, e smetterebbe di
 * mettere alla prova quello che accade.
 */
const riga = (id: string, nome: string, extra: Record<string, unknown> = {}) => ({
    id,
    file_url: percorso(UTENTE, nome),
    eliminato_il: giorniFa(GIORNI_CESTINO_GALLERIA + 1),
    ...extra,
})

/** Una voce-CARTELLA come la elenca la Storage API: `id` e `created_at` a `null`. */
const cartella = (nome: string) => ({ name: nome, id: null, created_at: null })
/** Un OGGETTO: `id` valorizzato, `created_at` vero. Nasce già oltre la grazia. */
const oggetto = (nome: string, ore = ORE_GRAZIA + 1) => ({
    name: nome,
    id: `og-${nome}`,
    created_at: oreFa(ore),
})

const soloDi = (tipo: 'remove' | 'update' | 'delete') => h.sequenza.filter((c) => c.tipo === tipo)
const deleteDi = (tabella: string) =>
    h.sequenza.filter((c) => c.tipo === 'delete' && c.tabella === tabella)
const idsCancellati = () => deleteDi('galleria_media_v2').flatMap((c) => c.valore as string[])
const percorsiRimossi = () => soloDi('remove').flatMap((c) => c.valore as string[])
/** Il battito che `controlloBattitoCron` sa leggere: `cron` · `info` · con i conteggi. */
const battiti = () =>
    h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'n_cestino_scaduti' in e.campi)
const eventiDi = (livello: string) => h.eventi.filter((e) => e.livello === livello)
/**
 * LE QUERY DI UNA DATA FORMA — non le clausole: le QUERY.
 *
 * `colonne` distingue il lotto A (`id, file_url, eliminato_il`) dal lotto B
 * (`id, eliminato_il`) e dalla domanda sui reclami (`id, file_url`); l'assenza di
 * `colonne` è ciò che un `update` o un `delete` hanno per natura.
 */
const queryDi = (
    operazione: 'select' | 'update' | 'delete',
    tabella = 'galleria_media_v2',
    colonne?: string,
) =>
    h.query.filter(
        (q) =>
            q.tabella === tabella &&
            q.operazione === operazione &&
            (colonne === undefined || q.colonne === colonne),
    )
/** Le clausole di UNA query e di quella sola, per ordinale. */
const clausoleDellaQuery = (ordinale: number) => h.clausole.filter((c) => c.ordinale === ordinale)

beforeEach(() => {
    vi.clearAllMocks()
    h.sequenza = []
    h.select = []
    h.clausole = []
    h.query = []
    h.nQuery = 0
    h.righeConFile = []
    h.righeSenzaFile = []
    h.erroreLottoA = null
    h.erroreLottoB = null
    h.erroreTimbro = null
    h.erroreDelete = null
    h.erroreSegnalazioni = null
    h.countDelete = undefined
    h.countSegnalazioni = undefined
    h.countAssente = false
    h.eccezioneClient = null
    h.removeRisposta = null
    h.ancoraNelBucket = new Set()
    h.verifiche = []
    h.erroreVerifica = null
    h.radice = []
    h.dentro = {}
    h.elencazioni = []
    h.erroreRadice = null
    h.cartelleRotte = new Set()
    h.righeCheNominano = []
    h.erroreRigheCheNominano = null
    h.reclamati = []
    h.erroreReclamati = null
    h.nonConfrontabili = 0
    h.erroreConfronto = null
    h.eventi = []
    h.staffNegato = null
    process.env.CRON_SECRET = CRON_SECRET
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — il gate', () => {
    it('senza segreto e senza sessione staff NON passa (401/403)', async () => {
        // Questa route distrugge in modo irreversibile foto e video di minori, e li
        // distrugge su TUTTE le sedi: è la porta che deve essere più chiusa di
        // tutte. Senza questa prova il resto del file collauderebbe una route
        // aperta.
        h.staffNegato = new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401 })
        const res = await chiama({})
        expect([401, 403]).toContain(res.status)
        expect(soloDi('remove')).toHaveLength(0)
        expect(soloDi('delete')).toHaveLength(0)
    })

    it('un segreto SBAGLIATO grida, e non passa per la porta del cron', async () => {
        // Un cron che bussa con la chiave sbagliata è il guasto invisibile: smette di
        // distruggere e non lo dice a nessuno. Se l'header manca del tutto è lo staff
        // che lancia il giro a mano, e allora il gate è `requireStaff`.
        h.staffNegato = new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 403 })
        const res = await chiama({ 'x-cron-secret': 'non-e-quello' })
        expect(res.status).toBe(403)
        expect(
            eventiDi('error').some((e) => e.campi.esito === 'secret-errato'),
            'un segreto errato deve lasciare una riga di `error`: è il solo modo di sapere che il cron ' +
                'non entra più',
        ).toBe(true)
    })

    it('con `CRON_SECRET` non configurato NESSUNO passa dalla porta del cron', async () => {
        // Fail-closed: mai «se non è configurato allora va bene». La variabile
        // presente ma VUOTA è il modo in cui una configurazione sbagliata si presenta
        // più spesso.
        process.env.CRON_SECRET = ''
        h.staffNegato = new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401 })
        const res = await chiama({ 'x-cron-secret': '' })
        expect(res.status).toBe(401)
    })

    it('il battito si scrive anche quando il gate NEGA', async () => {
        h.staffNegato = new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401 })
        await chiama({})
        expect(battiti()).toHaveLength(1)
        expect(battiti()[0].campi.esito).toBe('non-autorizzato')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — prima il file, poi il timbro, poi la riga', () => {
    it('CONTROLLO POSITIVO: toglie il file, timbra e cancella, IN QUEST’ORDINE', async () => {
        // Senza questo, l'intero file certificherebbe una route che non distrugge mai
        // niente — cioè una promessa sullo schermo che nessun programma mantiene, che
        // è esattamente lo stato da cui questo lavoro parte.
        h.righeConFile = [riga('m1', 'a.jpg')]
        const res = await chiama()
        const corpo = await res.json()

        expect(res.status).toBe(200)
        expect(corpo.ok).toBe(true)
        expect(corpo.righe).toBe(1)
        expect(corpo.file).toBe(1)
        expect(corpo.giorni).toBe(GIORNI_CESTINO_GALLERIA)

        const ordine = h.sequenza.filter((c) => c.tabella !== 'segnalazioni').map((c) => c.tipo)
        // `remove` degli orfani in coda compreso: ciò che conta è che fra le
        // operazioni sulla riga `m1` l'ordine sia remove → update → delete.
        expect(ordine.slice(0, 3)).toEqual(['remove', 'update', 'delete'])
        expect(percorsiRimossi()).toContain(percorso(UTENTE, 'a.jpg'))
        expect(idsCancellati()).toEqual(['m1'])
    })

    it('il TIMBRO scrive `file_rimosso_il`, ed è ciò che rende la purga idempotente', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        await chiama()
        const timbro = soloDi('update')[0].valore as { patch: Record<string, unknown>; ids: string[] }
        expect(Object.keys(timbro.patch)).toEqual(['file_rimosso_il'])
        expect(typeof timbro.patch.file_rimosso_il).toBe('string')
        expect(timbro.ids).toEqual(['m1'])
    })

    it('🔴 la SOGLIA dei trenta giorni sta su OGNI lettura che la deve portare, una per una', async () => {
        // Il difetto che questa prova chiude è silenzioso e grave: con la soglia a
        // 300 giorni invece di 30 nessuna riga verrebbe letta, nessuna cancellata, e
        // il battito continuerebbe a scrivere `esito: 'ok', n_righe: 0` — un giro a
        // vuoto che si dichiara riuscito.
        //
        // ⚠️ RIFATTA IL 2026-09-12, perché la versione precedente era cieca per
        // costruzione e il difetto è stato MISURATO, non supposto: raccoglieva tutte
        // le clausole `lt` su `eliminato_il` emesse nel giro, da qualunque query, e
        // si accontentava che ce ne fosse almeno una. Togliendo il taglio dal LOTTO A
        // — la lettura che decide quali FILE vengono distrutti — il taglio del lotto
        // B la soddisfaceva da solo: `Tests 48 passed (48)`, exit 0, e in produzione
        // una foto messa nel cestino ieri distrutta stanotte, ventinove giorni prima
        // del termine che il dialogo di eliminazione promette all'insegnante e che
        // questo stesso lavoro dichiara in `/privacy`.
        //
        // Adesso ogni lettura risponde per sé: il taglio si cerca fra le clausole di
        // QUELLA query, e nient'altro può soddisfarla al suo posto.
        h.righeConFile = [riga('m1', 'a.jpg')]
        await chiama()
        for (const colonne of ['id, file_url, eliminato_il', 'id, eliminato_il']) {
            const letture = queryDi('select', 'galleria_media_v2', colonne)
            expect(letture, `la lettura \`${colonne}\` non è stata eseguita affatto`).toHaveLength(1)
            const tagli = clausoleDellaQuery(letture[0].ordinale).filter(
                (c) => c.metodo === 'lt' && c.argomenti[0] === 'eliminato_il',
            )
            expect(
                tagli,
                `la lettura \`${colonne}\` non porta nessun taglio su \`eliminato_il\`: guarda TUTTO il ` +
                    `cestino, e la purga distruggerebbe anche le foto cestinate ieri`,
            ).toHaveLength(1)
            const giorni = (Date.now() - Date.parse(String(tagli[0].argomenti[1]))) / (24 * 60 * 60 * 1000)
            expect(Math.round(giorni)).toBe(GIORNI_CESTINO_GALLERIA)
        }
    })

    it('🔴 una riga VIVA non è raggiungibile: la cintura sta sulla DELETE, non «da qualche parte»', async () => {
        // La cintura conta: gli id arrivano da una lettura, e se quella lettura
        // sbagliasse verso, questa `delete` distruggerebbe una foto che nessuno ha
        // messo nel cestino — senza cestino, senza trenta giorni, senza ritorno.
        //
        // ⚠️ RIFATTA IL 2026-09-12 per la stessa cecità della prova qui sopra, e
        // anche questa misurata: l'asserzione contava i `not` su `eliminato_il`
        // filtrando per tabella e NON per operazione, e le tre LETTURE ne emettevano
        // già a sufficienza. Togliendo la cintura dalla `delete`: `Tests 48 passed
        // (48)`, exit 0, con la prova intitolata proprio a lei fra le verdi.
        //
        // Adesso l'affermazione è universale e vale anche sui lotti: OGNI `delete` su
        // `galleria_media_v2` porta la sua cintura, e il censimento `h.query`
        // comprende anche un'eventuale `delete` senza NESSUNA clausola — che è il
        // caso peggiore e che un `filter` sulle clausole non vedrebbe mai.
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.righeSenzaFile = [{ id: 'm9', eliminato_il: giorniFa(GIORNI_CESTINO_GALLERIA + 5) }]
        await chiama()
        const cancellazioni = queryDi('delete')
        expect(cancellazioni.length, 'nessuna `delete`: la prova non misurerebbe niente').toBeGreaterThan(0)
        for (const q of cancellazioni) {
            expect(
                clausoleDellaQuery(q.ordinale).filter(
                    (c) =>
                        c.metodo === 'not' &&
                        c.argomenti[0] === 'eliminato_il' &&
                        c.argomenti[1] === 'is' &&
                        c.argomenti[2] === null,
                ),
                'una `delete` su `galleria_media_v2` senza `eliminato_il IS NOT NULL`: basta un `id` ' +
                    'arrivato da una lettura col verso sbagliato e distrugge una foto viva',
            ).toHaveLength(1)
        }
        // E il TIMBRO porta la sua, per la stessa ragione: non si scrive
        // `file_rimosso_il` su una riga che nessuno ha messo nel cestino.
        for (const q of queryDi('update')) {
            const sue = clausoleDellaQuery(q.ordinale)
            expect(
                sue.some(
                    (c) => c.metodo === 'not' && c.argomenti[0] === 'eliminato_il' && c.argomenti[2] === null,
                ),
                'il timbro può cadere su una riga VIVA',
            ).toBe(true)
        }
    })

    it('le SEGNALAZIONI orfane si ripuliscono, e solo per gli id appena distrutti', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.countSegnalazioni = 2
        const corpo = await (await chiama()).json()
        const seg = deleteDi('segnalazioni')
        expect(seg).toHaveLength(1)
        expect(seg[0].valore).toEqual(['m1'])
        expect(
            h.clausole.some(
                (c) =>
                    c.tabella === 'segnalazioni' &&
                    c.metodo === 'eq' &&
                    c.argomenti[0] === 'tipo_oggetto' &&
                    c.argomenti[1] === 'media_galleria',
            ),
            'la pulizia deve restringersi al tipo `media_galleria`: senza, toccherebbe le segnalazioni ' +
                'della chat e del diario che hanno lo stesso `oggetto_id` per caso',
        ).toBe(true)
        expect(corpo.segnalazioni_orfane).toBe(2)
        expect(corpo.segnalazioni_esito).toBe('ok')
    })

    it('nessuna riga scaduta ⇒ nessun `remove` e nessuna `delete` sulla tabella', async () => {
        await chiama()
        expect(deleteDi('galleria_media_v2')).toHaveLength(0)
        expect(deleteDi('segnalazioni')).toHaveLength(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — LA RIPRESA (lotto B)', () => {
    it('una riga già timbrata si cancella SENZA chiedere niente allo Storage', async () => {
        // È il caso che `soloNelCestino` esclude per costruzione (filtra
        // `file_rimosso_il IS NULL`): senza il secondo lotto, una riga rimasta
        // indietro da una `delete` fallita non rientrerebbe in nessun giro
        // successivo e resterebbe in tabella PER SEMPRE, col file già distrutto.
        h.righeSenzaFile = [{ id: 'm9', eliminato_il: giorniFa(GIORNI_CESTINO_GALLERIA + 5) }]
        const corpo = await (await chiama()).json()
        expect(corpo.ok).toBe(true)
        expect(idsCancellati()).toEqual(['m9'])
        expect(
            percorsiRimossi(),
            'la riga era già senza file: richiederlo allo Storage sarebbe una chiamata inutile a ogni giro',
        ).toEqual([])
    })

    it('i due lotti si cancellano INSIEME, con una sola `delete`', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.righeSenzaFile = [{ id: 'm9', eliminato_il: giorniFa(GIORNI_CESTINO_GALLERIA + 5) }]
        const corpo = await (await chiama()).json()
        expect(deleteDi('galleria_media_v2')).toHaveLength(1)
        expect(idsCancellati().sort()).toEqual(['m1', 'm9'])
        expect(corpo.righe).toBe(2)
        expect(corpo.righe_scadute).toBe(2)
    })

    it('se la lettura della RIPRESA fallisce non si cancella NIENTE, nemmeno il lotto letto', async () => {
        // «Non so quante righe restano indietro» non autorizza a lavorare a metà: la
        // `delete` dei due lotti è una sola, e con una metà ignota il conteggio nel
        // battito mentirebbe.
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.erroreLottoB = { code: '57014', message: 'canceling statement' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('lettura-ripresa-fallita')
        expect(soloDi('remove')).toHaveLength(0)
        expect(soloDi('delete')).toHaveLength(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — righe trattenute ⇒ 500', () => {
    it('🔴 un file che NON esce trattiene la SUA riga, e la risposta è 500', async () => {
        // È la prova centrale di tutto il file. `rimuoviEVerifica` guarda lo STATO e
        // non il conteggio: il file non nominato fra i rimossi viene RICHIESTO allo
        // Storage, e se risulta ancora lì la riga non si cancella. Cancellarla
        // lascerebbe la foto di un bambino nel bucket senza più nessuna riga che la
        // nomini — invisibile, non cancellata.
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket.add(percorso(UTENTE, 'a.jpg'))

        const res = await chiama()
        const corpo = await res.json()

        expect(res.status).toBe(500)
        expect(corpo.ok).toBe(false)
        expect(corpo.motivo).toBe('file-non-rimossi')
        expect(corpo.righe).toBe(0)
        expect(corpo.righe_trattenute).toBe(1)
        expect(
            soloDi('delete'),
            'nessuna `delete` deve partire: la riga è l’unico riferimento che resta a quel file',
        ).toHaveLength(0)
        expect(
            soloDi('update'),
            'nemmeno il timbro: `file_rimosso_il` su un file che c’è ancora direbbe il falso, e ' +
                'toglierebbe la riga dal cestino rendendola non ripristinabile',
        ).toHaveLength(0)
        expect(battiti()[0].campi.esito).toBe('righe-trattenute')
        expect(battiti()[0].campi.n_righe_trattenute).toBe(1)
    })

    it('🔴 «non so se c’è ancora» vale «c’è»: anche la verifica non riuscita trattiene', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.removeRisposta = { data: [], error: null }
        h.erroreVerifica = { message: 'storage non risponde' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('verifica-non-riuscita')
        expect(soloDi('delete')).toHaveLength(0)
    })

    it('un file che NON esce trattiene SOLO la sua riga: l’altra si chiude', async () => {
        // La rinuncia è PER RIGA e non per lotto: con il blocco sull'intero lotto una
        // sola foto ostinata fermerebbe la purga di tutte le altre, ogni notte, per
        // sempre.
        h.righeConFile = [riga('m1', 'a.jpg'), riga('m2', 'b.jpg')]
        h.removeRisposta = { data: [{ name: percorso(UTENTE, 'b.jpg') }], error: null }
        h.ancoraNelBucket.add(percorso(UTENTE, 'a.jpg'))

        const res = await chiama()
        expect(res.status).toBe(500)
        expect(idsCancellati()).toEqual(['m2'])
        expect((await res.json()).righe_trattenute).toBe(1)
    })

    it('un file GIÀ ASSENTE non è un guasto: l’esito voluto era raggiunto', async () => {
        // Il verso opposto, e va provato: contare, e fermarsi se i conti non tornano,
        // bloccherebbe la purga PER SEMPRE su un file che non tornerà.
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.removeRisposta = { data: [], error: null }
        // `ancoraNelBucket` vuoto ⇒ la verifica dice «non c'è più».
        const res = await chiama()
        const corpo = await res.json()
        expect(res.status).toBe(200)
        expect(idsCancellati()).toEqual(['m1'])
        expect(corpo.file_gia_assenti).toBe(1)
    })

    it('`remove` che risponde ERRORE: nessuna riga cancellata, 500', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.removeRisposta = { data: null, error: { message: 'bucket non raggiungibile' } }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('file-non-rimossi')
        expect(soloDi('update')).toHaveLength(0)
        expect(soloDi('delete')).toHaveLength(0)
    })

    it('il TIMBRO che non si scrive trattiene la riga: 500, e nessuna `delete`', async () => {
        // Il file è uscito e la riga non porta il timbro. Cancellarla sarebbe
        // tollerabile, lasciarla senza timbro NO: il giro dopo la rileggerebbe fra le
        // ripristinabili, e la segreteria si vedrebbe offrire un «Ripristina» su un
        // file che non esiste più.
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.erroreTimbro = { code: '55P03', message: 'lock not available' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect(soloDi('delete')).toHaveLength(0)
        expect(
            eventiDi('error').some((e) => e.campi.esito === 'timbro-non-scritto'),
            'il timbro mancato è un fatto che va scritto col suo nome: senza, il giro successivo ' +
                'sembrerebbe un giro normale',
        ).toBe(true)
    })

    it('la `delete` che fallisce ⇒ 500, e il timbro è GIÀ scritto (la ripresa esiste per questo)', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.erroreDelete = { code: '57014', message: 'canceling statement' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('righe-non-cancellate')
        expect(soloDi('update')).toHaveLength(1)
        expect(battiti()[0].campi.esito).toBe('cancellazione-fallita')
    })

    it('un `file_url` da cui non si ricava un percorso NON autorizza a cancellare la riga', async () => {
        // Misurato il 2026-09-12: in produzione ZERO righe sono in questa condizione.
        // Il ramo esiste perché cancellare la riga sarebbe l'unico modo di perdere per
        // sempre l'unica traccia che nomina quel file.
        h.righeConFile = [{ id: 'm1', file_url: 'https://cdn.esterno.example/foto.jpg', eliminato_il: giorniFa(40) }]
        const res = await chiama()
        expect(res.status).toBe(500)
        expect(soloDi('delete')).toHaveLength(0)
        expect(
            eventiDi('error').some((e) => e.campi.esito === 'percorso-non-ricavabile'),
            'il fatto va scritto col suo nome: è l’unico modo di sapere che una riga sta bloccando la purga',
        ).toBe(true)
    })

    it('con righe trattenute la SPAZZATA non parte, e il battito non dice «ok»', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket.add(percorso(UTENTE, 'a.jpg'))
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('orfano.jpg')]

        await chiama()
        expect(h.elencazioni, 'la spazzata gira in coda al percorso felice').toEqual([])
        expect(
            battiti()[0].campi.orfani_esito,
            '`non-eseguita` e `ok` sono due fatti diversi: un `ok` qui direbbe «guardato, niente da ' +
                'fare» su un giro in cui nessuno ha guardato niente',
        ).toBe('non-eseguita')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — la spazzata degli orfani del bucket', () => {
    it('SCENDE nelle cartelle-utente: il prefisso è a DUE livelli, non piatto', async () => {
        // Misurato in produzione il 2026-09-12: 1.352 oggetti, TUTTI con tre segmenti
        // (`uploads/<utente>/<nome>`), zero con due, 37 cartelle distinte. Una
        // spazzata copiata dal gemello dei curriculum avrebbe elencato 37 voci-cartella,
        // non ne avrebbe riconosciuta nessuna come oggetto, e avrebbe riferito «zero
        // orfani» ogni notte — verde, e cieca.
        h.radice = [cartella(UTENTE), cartella(ALTRO_UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('orfano-a.jpg')]
        h.dentro[`uploads/${ALTRO_UTENTE}`] = [oggetto('orfano-b.jpg')]

        const corpo = await (await chiama()).json()
        expect(h.elencazioni.map((e) => e.cartella)).toEqual([
            'uploads',
            `uploads/${UTENTE}`,
            `uploads/${ALTRO_UTENTE}`,
        ])
        expect(corpo.orfani_cartelle).toBe(2)
        expect(corpo.orfani_esaminati).toBe(2)
        expect(corpo.orfani_rimossi).toBe(2)
        expect(percorsiRimossi().sort()).toEqual(
            [percorso(UTENTE, 'orfano-a.jpg'), percorso(ALTRO_UTENTE, 'orfano-b.jpg')].sort(),
        )
    })

    it('🔴 LA GRAZIA È ALMENO 24 ORE, e questo è il numero che i test qui sotto NON misurano', () => {
        // ─── PERCHÉ QUESTA PROVA ESISTE: UNA MUTAZIONE SOPRAVVISSUTA ─────────
        //
        // Misurato scrivendo questo file: portando `ORE_GRAZIA_ORFANI` da 24 a **0**
        // tutti e 46 i test restavano VERDI. Non per distrazione: per costruzione. I
        // fixture leggono la soglia dal sorgente (`ORE_GRAZIA`, in testa a questo
        // file) proprio per non ribattere un numero che può cambiare — e così si
        // spostano INSIEME alla costante. `oggetto(nome, ORE_GRAZIA + 1)` con la
        // soglia a zero nasce vecchio di un'ora, e un'ora basta: la prova continua a
        // dire «gli oggetti più giovani della grazia non si toccano», che con una
        // grazia di zero è una frase vera e vuota.
        //
        // Cosa avrebbe significato in produzione: la spazzata porta via, ogni notte,
        // i file che nessuna riga reclama — e un file che nessuna riga reclama ANCORA
        // è il file di un'insegnante che sta finendo di caricare. Con la grazia a zero
        // il caricamento in corso di una maestra su rete mobile finisce nel mucchio
        // degli orfani, e lei ricomincia senza sapere perché.
        //
        // Da qui la regola: il NUMERO si sorveglia una volta, qui, contro la soglia
        // GEMELLA del repo (`ORE_CURRICULUM_ORFANO` in `retention-candidature`), che
        // porta lo stesso 24 e per la stessa ragione. Abbassarlo resta possibile — è
        // una decisione del titolare — ma passa sotto gli occhi di qualcuno invece che
        // in silenzio.
        const gemella = readFileSync(
            join(process.cwd(), 'src/app/api/gdpr/retention-candidature/route.ts'),
            'utf8',
        ).match(/ORE_CURRICULUM_ORFANO = (\d+)/)
        expect(
            gemella,
            '`ORE_CURRICULUM_ORFANO` non si trova più in `retention-candidature/route.ts`: senza la ' +
                'soglia gemella questa prova non ha più niente contro cui misurare, e va riscritta — non ' +
                'tolta.',
        ).not.toBeNull()
        expect(
            ORE_GRAZIA,
            `La grazia degli orfani della galleria è di ${ORE_GRAZIA} ore. Il margine deve coprire ` +
                'ABBONDANTEMENTE un caricamento interrotto e ripreso: sotto le 24 ore la spazzata porta ' +
                'via il file di chi sta ancora caricando, e quella persona ricomincia senza sapere ' +
                'perché. Le 24 ore sono la soglia gemella di `ORE_CURRICULUM_ORFANO` ' +
                '(`retention-candidature`) e di `ORE_CARICAMENTO_IN_SOSPESO` (modulo del personale). ' +
                'Se il titolare vuole abbassarla, si abbassa QUI insieme al numero — e si scriva cosa ' +
                'copre il margine nuovo.',
        ).toBeGreaterThanOrEqual(Number(gemella![1]))
    })

    it('🔴 un oggetto nato UN’ORA fa non si tocca, qualunque cosa dica la costante', async () => {
        // La seconda metà della difesa contro la mutazione sopravvissuta, e non è un
        // doppione della prova qui sopra: quella sorveglia il NUMERO, questa sorveglia
        // il COMPORTAMENTO con un fixture ASSOLUTO — un'ora, scritta a mano e non
        // derivata dalla costante. Con la grazia a zero questa diventa rossa da sola,
        // senza che nessuno debba ricordarsi di guardare un intero.
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [
            { name: 'in-corso.jpg', id: 'og-in-corso', created_at: oreFa(1) },
        ]
        const corpo = await (await chiama()).json()
        expect(
            corpo.orfani_esaminati,
            'un file caricato un’ora fa è di qualcuno che sta ancora compilando: non è un orfano',
        ).toBe(0)
        expect(percorsiRimossi()).toEqual([])
    })

    it('🔴 gli oggetti più GIOVANI della grazia non si toccano', async () => {
        // Il file si carica PRIMA che la riga esista: portarlo via mentre
        // un'insegnante sta finendo di caricare su rete mobile la costringerebbe a
        // ricominciare.
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [
            oggetto('appena-caricato.jpg', ORE_GRAZIA - 1),
            oggetto('vecchio.jpg', ORE_GRAZIA + 1),
        ]
        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esaminati).toBe(1)
        expect(percorsiRimossi()).toEqual([percorso(UTENTE, 'vecchio.jpg')])
    })

    it('una data illeggibile vale «non toccare»', async () => {
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [{ name: 'senza-data.jpg', id: 'og-x', created_at: null }]
        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esaminati).toBe(0)
        expect(percorsiRimossi()).toEqual([])
    })

    it('🔴 un percorso reclamato da una riga NEL CESTINO non è un orfano', async () => {
        // È la ragione per cui la domanda usa `ancheNelCestino`: una riga cestinata
        // reclama ancora il suo file — è la condizione stessa del «Ripristina» che il
        // prodotto promette per trenta giorni. Filtrando le sole vive, ogni foto
        // cestinata perderebbe il file a ventiquattro ore.
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('cestinata.jpg'), oggetto('orfana.jpg')]
        h.reclamati = [percorso(UTENTE, 'cestinata.jpg')]

        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esaminati).toBe(2)
        expect(corpo.orfani_rimossi).toBe(1)
        expect(percorsiRimossi()).toEqual([percorso(UTENTE, 'orfana.jpg')])
    })

    it('🔴 FAIL-CLOSED: se la lettura dei reclami fallisce, NESSUN orfano si tocca', async () => {
        // Con una parte dei reclami sconosciuta, gli orfani calcolati sui lotti
        // riusciti comprenderebbero file che una riga nomina davvero. «Non so quali
        // file siano reclamati» vale «sono tutti reclamati».
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('x.jpg')]
        h.erroreReclamati = { code: '57014', message: 'canceling statement' }

        const corpo = await (await chiama()).json()
        expect(corpo.ok, 'un guasto della spazzata NON fa fallire la purga del cestino').toBe(true)
        expect(corpo.orfani_esito).toBe('verifica-non-riuscita')
        expect(percorsiRimossi()).toEqual([])
    })

    it('🔴 FAIL-CLOSED: un `file_url` non confrontabile ferma la spazzata', async () => {
        // Se una riga VIVA portasse un URL completo invece del percorso nudo, il
        // confronto per uguaglianza non la troverebbe: il suo file risulterebbe «non
        // reclamato» e verrebbe portato via. La foto di un bambino distrutta mentre
        // la sua riga è viva. Prima di fidarsi del confronto si CONTA quante righe
        // non sono confrontabili.
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('x.jpg')]
        h.nonConfrontabili = 1

        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esito).toBe('reclami-non-leggibili')
        expect(percorsiRimossi()).toEqual([])
        expect(
            eventiDi('error').some((e) => e.campi.esito === 'orfani-forma-reclami-non-confrontabile'),
        ).toBe(true)
    })

    it('se il CONTEGGIO dei non confrontabili non si legge, la spazzata non parte', async () => {
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('x.jpg')]
        h.erroreConfronto = { message: 'timeout' }
        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esito).toBe('reclami-non-leggibili')
        expect(percorsiRimossi()).toEqual([])
    })

    it('le voci-CARTELLA e il segnaposto non sono oggetti da cancellare', async () => {
        // Una voce-cartella ha `id === null`: non si può rimuovere, e trattarla come
        // percorso farebbe cercare al database righe che non esistono.
        // `.emptyFolderPlaceholder` lo crea lo Storage: toglierlo farebbe sparire la
        // cartella.
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [
            { name: '.emptyFolderPlaceholder', id: 'og-ph', created_at: oreFa(ORE_GRAZIA + 10) },
            { name: 'sotto-cartella', id: null, created_at: null },
            oggetto('vero.jpg'),
        ]
        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esaminati).toBe(1)
        expect(percorsiRimossi()).toEqual([percorso(UTENTE, 'vero.jpg')])
    })

    it('una cartella che non si elenca SALTA, e l’esito lo dichiara', async () => {
        // L'orfanità la decide il DATABASE, non l'elenco: una cartella non letta
        // produce MENO rimozioni e mai una rimozione sbagliata. Ma l'esito non può
        // restare `ok`: chi legge il battito deve sapere che non si è guardato tutto.
        h.radice = [cartella(UTENTE), cartella(ALTRO_UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('a.jpg')]
        h.cartelleRotte.add(`uploads/${ALTRO_UTENTE}`)

        const corpo = await (await chiama()).json()
        expect(corpo.orfani_esito).toBe('elenco-non-letto')
        expect(percorsiRimossi()).toEqual([percorso(UTENTE, 'a.jpg')])
    })

    it('se il PREFISSO non si elenca, la spazzata non parte e lo dice', async () => {
        h.erroreRadice = { message: 'storage non risponde' }
        const corpo = await (await chiama()).json()
        expect(corpo.ok).toBe(true)
        expect(corpo.orfani_esito).toBe('elenco-non-letto')
        expect(corpo.orfani_esaminati).toBe(0)
    })

    it('la domanda ai reclami si spezza in LOTTI, e ogni lotto sta nel tetto', async () => {
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = Array.from({ length: LOTTO_RECLAMI + 5 }, (_, i) =>
            oggetto(`f${i}.jpg`),
        )
        await chiama()
        const lotti = h.clausole
            .filter((c) => c.metodo === 'in' && c.argomenti[0] === 'file_url')
            .map((c) => (c.argomenti[1] as string[]).length)
        expect(lotti.length).toBeGreaterThan(1)
        for (const n of lotti) expect(n).toBeLessThanOrEqual(LOTTO_RECLAMI)
        expect(lotti.reduce((a, b) => a + b, 0)).toBe(LOTTO_RECLAMI + 5)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — il battito', () => {
    it('🔴 c’è anche a ZERO, e porta tutti i conteggi', async () => {
        // Con i soli errori, «nessun log» non distingue «cestino vuoto» da «la purga
        // non parte più» — ed è l'ambiguità che ha nascosto per mesi il guasto delle
        // email in questo stesso progetto.
        await chiama()
        expect(battiti()).toHaveLength(1)
        const c = battiti()[0].campi
        expect(c.esito).toBe('ok')
        expect(c.operazione).toBe('galleria-retention')
        for (const chiave of [
            'n_cestino_scaduti',
            'n_file_rimossi',
            'n_file_gia_assenti',
            'n_righe_trattenute',
            'n_orfani_rimossi',
            'n_segnalazioni_orfane',
            'lotto_pieno',
        ]) {
            expect(c, `il battito non porta \`${chiave}\``).toHaveProperty(chiave)
        }
    })

    it('🔴 il battito è su `evento: cron`, l’unico che `controlloBattitoCron` legge', async () => {
        // `/api/health` legge `app_log` con `.eq('evento','cron')` e conta solo i
        // battiti con `esito: 'ok'`. Un battito scritto guardando alla NATURA DEL DATO
        // (`gdpr`) invece che alla natura del SEGNALE non lo trova nessuno: è il
        // difetto misurato in produzione il 2026-08-02 su
        // `presenze-giustificazioni-retention`, muto a chi lo cercava mentre girava.
        await chiama()
        expect(battiti()).toHaveLength(1)
        expect(battiti()[0].evento).toBe('cron')
        expect(battiti()[0].livello).toBe('info')
    })

    it('il nome del job combacia CARATTERE PER CARATTERE con quello del cron e di `/api/health`', () => {
        // Due grafie che si somigliano producono un «job senza battito» permanente su
        // un lavoro che gira benissimo — cioè un allarme che suona da solo, e che
        // qualcuno spegnerà.
        expect(SORGENTE_ROUTE).toMatch(/const JOB = 'galleria-retention'/)
        const migrazione = readFileSync(
            join(process.cwd(), 'supabase/migrations/20260912024500_galleria_retention_cron.sql'),
            'utf8',
        )
        expect(migrazione).toMatch(/cron\.schedule\(\s*\n?\s*'galleria-retention'/)
        expect(migrazione).toMatch(/\/api\/gdpr\/retention-galleria/)
    })

    it('un lotto PIENO si dichiara, nella risposta e nel battito', async () => {
        h.righeConFile = Array.from({ length: TETTO_LOTTO }, (_, i) => riga(`m${i}`, `f${i}.jpg`))
        const corpo = await (await chiama()).json()
        expect(corpo.lotto_pieno).toBe(true)
        expect(battiti()[0].campi.lotto_pieno).toBe(true)
        expect(eventiDi('warn').some((e) => e.campi.esito === 'lotto-pieno')).toBe(true)
    })

    it('`conteggio_verificato` distingue la MISURA dall’intenzione', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.countAssente = true
        await chiama()
        expect(battiti()[0].campi.conteggio_verificato).toBe(false)
    })

    it('un conteggio DISCORDE si dichiara col numero vero, e resta un `warn`', async () => {
        h.righeConFile = [riga('m1', 'a.jpg'), riga('m2', 'b.jpg')]
        h.countDelete = 1
        const corpo = await (await chiama()).json()
        expect(corpo.righe).toBe(1)
        expect(eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde')).toBe(true)
        expect(corpo.ok, 'il fine del job è raggiunto: chiamare «errore» una purga riuscita fa spegnere l’allarme').toBe(true)
    })

    it('una `segnalazioni` che non si ripulisce NON fa fallire il giro, ma si vede', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.erroreSegnalazioni = { code: '42501', message: 'permission denied' }
        const res = await chiama()
        const corpo = await res.json()
        expect(res.status).toBe(200)
        expect(corpo.segnalazioni_esito).toBe('non-riuscita')
        expect(battiti()[0].campi.segnalazioni_esito).toBe('non-riuscita')
        expect(
            eventiDi('error').some((e) => e.campi.esito === 'segnalazioni-orfane-non-rimosse'),
        ).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — il degrado sul DB non migrato', () => {
    it('colonne del cestino assenti (42703) ⇒ 503 DICHIARATO, non un 200 bugiardo', async () => {
        // Il DB E2E della CI è un progetto separato e non migrato: là le tre colonne
        // non esistono, quindi non esiste nemmeno un cestino da purgare. «Non ho
        // cancellato niente perché le colonne non ci sono» e «non c'era niente da
        // cancellare» sono due fatti diversi, e confonderli è il guasto invisibile.
        h.erroreLottoA = { code: '42703', message: 'column galleria_media_v2.eliminato_il does not exist' }
        const res = await chiama()
        expect(res.status).toBe(503)
        expect((await res.json()).motivo).toBe('colonne-cestino-assenti')
        expect(soloDi('remove')).toHaveLength(0)
        expect(soloDi('delete')).toHaveLength(0)
        expect(eventiDi('warn').some((e) => e.campi.esito === 'colonne-cestino-assenti')).toBe(true)
        expect(battiti()[0].campi.esito).toBe('colonne-cestino-assenti')
    })

    it('tabella assente ⇒ 503 col codice; un altro errore di lettura ⇒ 500', async () => {
        h.erroreLottoA = { code: 'PGRST205', message: 'Could not find the table' }
        expect((await chiama()).status).toBe(503)

        h.eventi = []
        h.erroreLottoA = { code: '57014', message: 'canceling statement' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('lettura-fallita')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-galleria — nei log non finisce nessun dato di un minore', () => {
    /**
     * Il percorso nel bucket è `uploads/<uuid utente>/<nome>`: è la chiave con cui si
     * firma la foto di un bambino in un bucket PRIVATO, cioè una credenziale. E il
     * nome del file, come la didascalia, è spessissimo il nome del bambino.
     * `app_log` è interrogabile in SQL per 30 giorni.
     */
    const NOMI_PARLANTI = ['sofia-al-mare.jpg', 'compleanno-di-luca.mp4']

    it('🔴 nessun percorso e nessun nome di file, in NESSUN evento, su NESSUNA strada', async () => {
        h.righeConFile = [
            riga('m1', NOMI_PARLANTI[0]),
            { id: 'm2', file_url: percorso(UTENTE, NOMI_PARLANTI[1]), eliminato_il: giorniFa(40) },
        ]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket.add(percorso(UTENTE, NOMI_PARLANTI[0]))
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('nonna-e-mia.jpg')]

        await chiama()

        const testo = JSON.stringify(h.eventi)
        for (const nome of [...NOMI_PARLANTI, 'nonna-e-mia.jpg']) {
            expect(testo, `il nome del file «${nome}» è finito in un log`).not.toContain(nome)
        }
        expect(testo, 'un percorso del bucket è finito in un log: è una credenziale').not.toContain('uploads/')
    })

    it('nessun evento porta l’uuid di chi ha caricato dentro un percorso', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        h.radice = [cartella(UTENTE)]
        h.dentro[`uploads/${UTENTE}`] = [oggetto('b.jpg')]
        await chiama()
        expect(JSON.stringify(h.eventi)).not.toContain(UTENTE)
    })

    it('la route non nomina mai `caption`: la didascalia non si legge nemmeno', async () => {
        // Non è una prova sui log: è una prova sulla QUERY. Una `select('*')` avrebbe
        // portato la didascalia — cioè quasi sempre il nome di un bambino — dentro il
        // contesto della route, dove poi basta un campo in più in un log.
        expect(SORGENTE_ROUTE).not.toMatch(/\bcaption\b/)
        expect(
            h.select.every((c) => c !== '*'),
            'una `select(*)` su `galleria_media_v2` porta con sé didascalia e tag: qui servono ' +
                '`id`, `file_url` e `eliminato_il`',
        ).toBe(true)
    })

    it('le colonne chieste sono le minime che servono', async () => {
        h.righeConFile = [riga('m1', 'a.jpg')]
        await chiama()
        expect(h.select).toEqual([
            'id, file_url, eliminato_il', // LOTTO A
            'id, eliminato_il', //          LOTTO B (la ripresa)
            'id, file_url', //              «chi ALTRO nomina questi percorsi?»
        ])
        expect(
            h.select.every((c) => !c.includes('caption') && !c.includes('tag_students')),
            'la didascalia è spesso il nome di un bambino: non si chiede nemmeno',
        ).toBe(true)
    })
})
