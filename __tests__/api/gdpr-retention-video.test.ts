import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { senzaCommenti } from '../architecture/soglia-fotografia'

// =============================================================================
// LA CONSERVAZIONE DEGLI ORIGINALI VIDEO — e le cinque cose che i tre gemelli
// (`retention-galleria`, `retention-candidature`, `retention-personale`) hanno
// già pagato al posto nostro.
//
// 1. PRIMA IL FILE, POI LA RIGA — e per riga, non per lotto. Al contrario, un
//    errore a metà lascerebbe il video nel bucket con la riga che lo dichiara già
//    rimosso: irraggiungibile, non cancellato, e nemmeno identificabile per
//    cancellarlo se una famiglia lo chiedesse.
// 2. IL TIMBRO NON È UN `update` DELLA ROUTE. È `video_retention_originale_rimosso`,
//    che rilegge la scadenza sotto lock: fra la lettura dell'elenco e la chiamata
//    allo Storage passano secondi, e in quei secondi la riga può cambiare.
// 3. IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO, dentro un `finally`. Con i soli
//    errori, «nessun log» non distingue «niente da togliere» da «il giro non parte
//    più» — ed è l'ambiguità che ha nascosto per mesi il guasto delle email.
// 4. RIGHE TRATTENUTE ⇒ 500. Un 200 direbbe «fatto» a chi sorveglia, e resterebbero
//    originali di video di minori nell'archivio oltre il termine.
// 5. UN OGGETTO CHE UNA RIGA NOMINA ANCORA NON È UN ORFANO. La spazzata parte dal
//    bucket e chiede al database chi reclama: senza la domanda, cancellerebbe
//    l'originale di un job vivo.
//
// E una sesta, che è di questa consegna e non dei gemelli: **un evento di
// `video_outbox` che nessuno sa consegnare non si dichiara inviato.** La testata di
// `video_outbox_fail` racconta la misura che l'ha scritta — venticinque tentativi
// bruciati in sedici millisecondi — e la conseguenza: l'evento che aggancia il video
// alla sua News non riprovato mai più.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-video-non-usato-altrove'

// ── I TIPI CHE QUALCUNO SCRIVE IN `video_outbox` (per il lock di famiglia, D14) ──
// Raccolti a livello di modulo perché `it.each` ne ha bisogno prima dei test.
const RADICE = join(__dirname, '..', '..')

function fileSorgente(cartella: string): string[] {
    const fuori: string[] = []
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
        const percorso = join(cartella, voce.name)
        if (voce.isDirectory()) fuori.push(...fileSorgente(percorso))
        else if (/\.(ts|tsx)$/.test(voce.name)) fuori.push(percorso)
    }
    return fuori
}

/** Il gruppo `( … )` che si apre a `inizio`, con le parentesi bilanciate e gli apici rispettati. */
function gruppoBilanciato(sql: string, inizio: number): string {
    let profondita = 0
    let inApice = false
    for (let i = inizio; i < sql.length; i++) {
        const c = sql[i]
        if (inApice) {
            if (c === "'") inApice = false
            continue
        }
        if (c === "'") inApice = true
        else if (c === '(') profondita += 1
        else if (c === ')') {
            profondita -= 1
            if (profondita === 0) return sql.slice(inizio, i + 1)
        }
    }
    return sql.slice(inizio)
}

/**
 * Un sorgente TS senza commenti `//…` e `/*…*\/`, rispettando stringhe ('…', "…",
 * `…`) e letterali regex: `'http://…'` non è un commento, e `/['"]/` non apre una
 * stringa. Ogni commento diventa uno spazio (o l'a capo resta), così le righe e le
 * parole restano separate. È un'approssimazione (nessun `${…}` annidato con un
 * backtick dentro): se sbaglia, di norma raccoglie un tipo di troppo e il test del suo
 * destinatario diventa ROSSO, che è la direzione giusta in cui sbagliare. (Fino al 2026-10-02
 * l'anti-cecità copriva anche questa forma, perché `POST /api/gallery` scriveva
 * `gallery.published` da `src/`. Da allora quel tipo lo scrive solo una migrazione, e la prova
 * che la forma (i) legge davvero il codice e non i commenti sta nel caso in memoria qui sotto.)
 */
function senzaCommentiTs(testo: string): string {
    let fuori = ''
    let i = 0
    // L'ultimo carattere significativo del CODICE: decide se `/` apre una regex.
    let precedente = ''
    while (i < testo.length) {
        const c = testo[i]
        const due = testo.slice(i, i + 2)
        if (due === '//') {
            const fine = testo.indexOf('\n', i)
            i = fine < 0 ? testo.length : fine
            continue
        }
        if (due === '/*') {
            const fine = testo.indexOf('*/', i + 2)
            i = fine < 0 ? testo.length : fine + 2
            fuori += ' '
            continue
        }
        const apreRegex = c === '/' && (precedente === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(precedente))
        if (c === "'" || c === '"' || c === '`' || apreRegex) {
            let j = i + 1
            let inClasse = false
            while (j < testo.length) {
                const d = testo[j]
                if (d === '\\') {
                    j += 2
                    continue
                }
                if (apreRegex) {
                    if (d === '[') inClasse = true
                    else if (d === ']') inClasse = false
                    else if (d === '/' && !inClasse) break
                    else if (d === '\n') break
                } else if (d === c) break
                j += 1
            }
            fuori += testo.slice(i, j + 1)
            precedente = 'x'
            i = j + 1
            continue
        }
        fuori += c
        if (!/\s/.test(c)) precedente = c
        i += 1
    }
    return fuori
}

type Scrittura = { tipo: string; percorso: string }

/**
 * Forma (i), PURA: chi passa un letterale come `p_event_type:` a una RPC. Riceve i
 * sorgenti già letti, così un caso in memoria prova il filtro dei commenti senza
 * toccare file che questo compito non possiede.
 */
function scrittureDaSorgenti(sorgenti: { percorso: string; testo: string }[]): Scrittura[] {
    const fuori: Scrittura[] = []
    for (const { percorso, testo } of sorgenti) {
        for (const m of senzaCommentiTs(testo).matchAll(/p_event_type:\s*['"]([a-z][a-z0-9_.-]*)['"]/g)) {
            fuori.push({ tipo: m[1], percorso })
        }
    }
    return fuori
}

/**
 * Gli argomenti di PRIMO LIVELLO di un gruppo `( … )` SQL: si divide alle virgole che stanno
 * subito dentro la parentesi che apre, rispettando gli apici e le parentesi annidate. Un
 * letterale dentro `jsonb_build_object(…)` o dentro un'altra funzione NON è un argomento del
 * gruppo: è un nome di chiave, e non un tipo di evento.
 */
function argomentiDiPrimoLivello(gruppo: string): string[] {
    const fuori: string[] = []
    let profondita = 0
    let inApice = false
    let corrente = ''
    for (const c of gruppo) {
        if (inApice) {
            corrente += c
            if (c === "'") inApice = false
            continue
        }
        if (c === "'") {
            inApice = true
            corrente += c
            continue
        }
        if (c === '(') {
            profondita += 1
            // La parentesi che apre il gruppo non è parte di nessun argomento.
            if (profondita === 1) continue
        } else if (c === ')') {
            profondita -= 1
            if (profondita === 0) {
                fuori.push(corrente)
                return fuori
            }
        } else if (c === ',' && profondita === 1) {
            fuori.push(corrente)
            corrente = ''
            continue
        }
        corrente += c
    }
    return fuori
}

/**
 * Forme (ii) e (iii), PURE: chi scrive un tipo in `video_outbox` DENTRO una migrazione. Riceve i
 * sorgenti già letti (come la forma (i)), così un caso in memoria prova ciascuna forma — e prova
 * che il lock diventa rosso — senza toccare file che questo compito non possiede.
 *
 *  · (ii) il letterale col punto dentro il VALUES di un `INSERT INTO [public.]video_outbox`;
 *  · (iii) il letterale col punto passato come argomento a `video_intent_finalize(…)`: dal
 *    2026-10-02 è l'UNICO scrittore di `gallery.published`. Prima lo scriveva `POST /api/gallery`
 *    (forma (i), `p_event_type: 'gallery.published'`); tolto quel ramo, il tipo lo passa come
 *    letterale la RPC `video_galleria_pubblica`, che è SQL — e `video_intent_finalize` lo
 *    inserisce in `video_outbox` da una VARIABILE, quindi la forma (ii) non lo vede. Senza la
 *    terza forma `gallery.published` uscirebbe dall'elenco dei tipi scritti, il test che lo
 *    esercita (`it.each`) non nascerebbe più, e il lock resterebbe VERDE: l'esatta cecità che
 *    questo lock esiste per impedire. Solo gli argomenti di primo livello contano: un letterale
 *    col punto dentro un `jsonb_build_object` è una chiave.
 *
 * Tutte e due leggono SQL senza commenti: una frase esplicativa che cita la forma immunizzerebbe
 * il lock. Forma NON coperta: un tipo passato da una VARIABILE o da una costante (`v_tipo`) invece
 * che da un letterale — chi la introduce aggiunga qui la quarta forma.
 */
function scrittureDaMigrazioni(migrazioni: { percorso: string; testo: string }[]): Scrittura[] {
    const fuori: Scrittura[] = []
    for (const { percorso, testo } of migrazioni) {
        const sql = senzaCommenti(testo)
        // (ii) il VALUES di un `INSERT INTO video_outbox`.
        for (const m of sql.matchAll(/insert\s+into\s+(?:public\.)?video_outbox\b[^;]*?\bvalues\s*\(/gi)) {
            const valori = gruppoBilanciato(sql, (m.index ?? 0) + m[0].length - 1)
            for (const l of valori.matchAll(/'([a-z][a-z0-9_]*\.[a-z0-9_.-]+)'/g)) {
                fuori.push({ tipo: l[1], percorso })
            }
        }
        // (iii) gli argomenti di primo livello di una chiamata a `video_intent_finalize(…)`. Anche la
        // sua definizione e i suoi `REVOKE`/`GRANT` hanno un gruppo con lo stesso nome davanti, ma
        // lì ci sono nomi di parametro e tipi: nessuno è un letterale con un punto dentro.
        for (const m of sql.matchAll(/\bvideo_intent_finalize\s*\(/gi)) {
            const argomenti = gruppoBilanciato(sql, (m.index ?? 0) + m[0].length - 1)
            for (const argomento of argomentiDiPrimoLivello(argomenti)) {
                const l = argomento.trim().match(/^'([a-z][a-z0-9_]*\.[a-z0-9_.-]+)'$/)
                if (l) fuori.push({ tipo: l[1], percorso })
            }
        }
    }
    return fuori
}

/** Le migrazioni lette dal disco, col percorso relativo alla radice. */
function migrazioniSuDisco(): { percorso: string; testo: string }[] {
    const cartella = join(RADICE, 'supabase', 'migrations')
    return readdirSync(cartella)
        .filter((f) => f.endsWith('.sql'))
        .map((nome) => ({
            percorso: `supabase/migrations/${nome}`,
            testo: readFileSync(join(cartella, nome), 'utf8'),
        }))
}

function scrittureInOutbox(): Scrittura[] {
    // (i) `src/**/*.{ts,tsx}`, percorso relativo alla radice con `/`.
    const fuori = scrittureDaSorgenti(
        fileSorgente(join(RADICE, 'src')).map((file) => ({
            percorso: relative(RADICE, file).split(sep).join('/'),
            testo: readFileSync(file, 'utf8'),
        })),
    )
    // (ii) e (iii) le migrazioni, senza commenti.
    fuori.push(...scrittureDaMigrazioni(migrazioniSuDisco()))
    return fuori
}

const SCRITTURE_IN_OUTBOX = scrittureInOutbox()
const TIPI_SCRITTI_IN_OUTBOX = [...new Set(SCRITTURE_IN_OUTBOX.map((s) => s.tipo))].sort()

const JOB_A = '40000000-0000-4000-8000-00000000000a'
const JOB_B = '40000000-0000-4000-8000-00000000000b'
const JOB_C = '40000000-0000-4000-8000-00000000000c'
const JOB_D = '40000000-0000-4000-8000-00000000000d'
const INTENT = '30000000-0000-4000-8000-000000000003'
const PATH_A = 'originals/40000000-0000-4000-8000-00000000000a/source.mov'
const PATH_B = 'originals/40000000-0000-4000-8000-00000000000b/source.mov'
/** Le USCITE convertite: `<chi carica>/<job>/<tentativo>.mp4`, nel bucket `video_processing`. */
const USCITA_C = '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000c/1.mp4'
const USCITA_D = '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000d/2.mp4'

const BUCKET_ORIGINALI = 'video_originals'
const BUCKET_USCITE = 'video_processing'

const h = vi.hoisted(() => ({
    /**
     * LA SEQUENZA REALE DELLE OPERAZIONI: è l'ORDINE la cosa da provare.
     * `remove` → `rpc:video_retention_originale_rimosso`. Un doppio che non
     * registrasse l'ordine renderebbe verde una route che timbra la riga e poi prova
     * a togliere il file — cioè il difetto che tutta la famiglia esiste per impedire.
     * Le `remove` portano anche il bucket: i magazzini sono due e l'ordine vale per entrambi.
     */
    sequenza: [] as { tipo: string; valore: unknown; bucket?: string }[],
    /** Ogni `rpc()` con i suoi argomenti: le soglie si verificano da qui. */
    rpc: [] as { nome: string; argomenti: Record<string, unknown> }[],
    /** Ogni query con le sue clausole, per poterle asserire PER QUERY. */
    query: [] as {
        ordinale: number
        tabella: string
        operazione: string
        colonne?: string
        opzioni?: unknown
        clausole: { metodo: string; argomenti: unknown[] }[]
    }[],
    nQuery: 0,

    // ── LE RISPOSTE DELLE RPC ──
    flussoVecchio: { ok: true, revocati: 0, rifiutati: 0 } as unknown,
    erroreFlussoVecchio: null as unknown,
    nonPubblicati: { ok: true, scaduti: 0, rifiutati: 0 } as unknown,
    erroreNonPubblicati: null as unknown,
    scadenze: {
        ok: true,
        abbandonati: 0,
        incagliati: 0,
        senza_scadenza: 0,
        uscite_senza_scadenza: 0,
    } as unknown,
    erroreScadenze: null as unknown,
    timbro: { ok: true } as unknown,
    erroreTimbro: null as unknown,
    /** Fa LANCIARE la RPC del timbro: è l'unico modo di raggiungere il `catch` finale. */
    eccezioneTimbro: null as unknown,
    timbroUscita: { ok: true } as unknown,
    erroreTimbroUscita: null as unknown,
    /** Come `eccezioneTimbro`, per il timbro delle uscite. */
    eccezioneTimbroUscita: null as unknown,
    minimizza: { ok: true, minimizzati: 0 } as unknown,
    erroreMinimizza: null as unknown,
    riconciliazione: {
        ok: true,
        conclusi_senza_scadenza: 0,
        outbox_in_quarantena: 0,
    } as unknown,
    erroreRiconciliazione: null as unknown,
    outboxClaim: { ok: true, eventi: [] as unknown[] } as unknown,
    erroreClaim: null as unknown,
    /**
     * Il claim che IGNORA il filtro per tipo: lo scenario che col claim filtrato non può succedere —
     * un database che non applica `p_tipi` —, per provare che il consumo non lo lascia passare in silenzio.
     * Di default il doppio fa quello che fa il database: con `p_tipi` restituisce solo i tipi richiesti.
     */
    claimIgnoraFiltro: false,
    outboxChiusura: { ok: true } as unknown,

    // ── IL DATABASE ──
    /** Le righe scadute: `id` + `original_path`. */
    scaduti: [] as { id: string; original_path: string }[],
    erroreScaduti: null as unknown,
    /** Le USCITE scadute: `id` + `output_path`. */
    usciteScadute: [] as { id: string; output_path: string }[],
    erroreUscite: null as unknown,
    /** I percorsi che UNA riga di `video_jobs` reclama ancora (originali) / (uscite). */
    reclamati: [] as string[],
    reclamatiUscite: [] as string[],
    /** Fra i reclamati, quelli la cui riga è GIÀ TIMBRATA come tolta: il file è risorto. */
    risorti: [] as string[],
    risorteUscite: [] as string[],
    erroreReclamati: null as unknown,
    erroreReclamatiUscite: null as unknown,
    /** Quanti job dell'intent sono ancora senza scadenza: > 0 ⇒ ricevuta negata. */
    senzaScadenzaPerIntent: 0,
    erroreRicevuta: null as unknown,

    // ── LO STORAGE ──
    removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
    removeRispostaUscite: null as { data: unknown[] | null; error: unknown } | null,
    /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket (di qualunque magazzino). */
    ancoraNelBucket: new Set<string>(),
    erroreVerifica: null as unknown,
    /** L'albero del bucket degli originali: cartella → voci. `''` è la radice. */
    albero: {} as Record<
        string,
        { name?: string | null; id?: string | null; created_at?: string | null }[]
    >,
    /** L'albero del bucket delle uscite (`video_processing`). */
    alberoUscite: {} as Record<
        string,
        { name?: string | null; id?: string | null; created_at?: string | null }[]
    >,
    /** Le elencazioni fatte: cartella e opzioni, come le riceve la Storage API. Una lista per magazzino. */
    elencazioni: [] as { cartella: string; opzioni: unknown }[],
    elencazioniUscite: [] as { cartella: string; opzioni: unknown }[],
    erroreElenco: null as unknown,
    erroreElencoUscite: null as unknown,

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
        // ⚠️ `rimuoviEVerifica` e `bloccanti` NON sono mockati: arrivano dal modulo
        // vero (`src/lib/storage/rimozione-verificata.ts`). È lì che sta la regola
        // «uscito adesso / non c'è più / c'è ancora / non so», e mockarla renderebbe
        // verde una route che tratta «non so» come «non c'è».
        const builder = (tabella: string) => {
            const ordinale = ++h.nQuery
            const clausole: { metodo: string; argomenti: unknown[] }[] = []
            let versato = false
            const qb: Record<string, unknown> = { __tabella: tabella, __op: 'select' }
            qb.select = (colonne: string, opzioni?: { count?: string; head?: boolean }) => {
                qb.__colonne = colonne
                qb.__opzioni = opzioni
                return qb
            }
            for (const m of ['not', 'is', 'lt', 'lte', 'gt', 'eq', 'order', 'limit']) {
                qb[m] = (...argomenti: unknown[]) => {
                    clausole.push({ metodo: m, argomenti })
                    return qb
                }
            }
            qb.in = (...argomenti: unknown[]) => {
                clausole.push({ metodo: 'in', argomenti })
                qb.__in = argomenti[1]
                return qb
            }
            const versa = () => {
                if (versato) return
                versato = true
                h.query.push({
                    ordinale,
                    tabella,
                    operazione: qb.__op as string,
                    colonne: qb.__colonne as string | undefined,
                    opzioni: qb.__opzioni,
                    clausole,
                })
            }
            qb.then = (res: (v: unknown) => unknown) => {
                versa()
                const colonne = qb.__colonne as string
                const ids = (qb.__in as string[] | undefined) ?? []

                if (colonne === 'id, original_path') {
                    h.sequenza.push({ tipo: 'leggi-scaduti', valore: null })
                    return Promise.resolve({ data: h.scaduti, error: h.erroreScaduti }).then(res)
                }
                if (colonne === 'id, output_path') {
                    h.sequenza.push({ tipo: 'leggi-uscite-scadute', valore: null })
                    return Promise.resolve({ data: h.usciteScadute, error: h.erroreUscite }).then(res)
                }
                // «Chi reclama questi percorsi, e quella riga li dichiara già tolti?». I due magazzini
                // hanno le loro colonne, e il doppio le distingue dalla SELECT: una route che chiedesse
                // le colonne degli originali per le uscite (o viceversa) non troverebbe mai niente.
                if (colonne === 'original_path, original_deleted_at' || colonne === 'output_path, output_deleted_at') {
                    const uscite = colonne === 'output_path, output_deleted_at'
                    const percorso = uscite ? 'output_path' : 'original_path'
                    const timbro = uscite ? 'output_deleted_at' : 'original_deleted_at'
                    const errore = uscite ? h.erroreReclamatiUscite : h.erroreReclamati
                    const reclamati = uscite ? h.reclamatiUscite : h.reclamati
                    const risorti = new Set(uscite ? h.risorteUscite : h.risorti)
                    // Il doppio risponde SOLO per i percorsi chiesti, come PostgREST: uno
                    // che restituisse tutti i reclamati a ogni lotto renderebbe verde una
                    // route che sbaglia a spezzare i lotti.
                    const lotto = new Set(ids)
                    return Promise.resolve(
                        errore
                            ? { data: null, error: errore }
                            : {
                                  data: reclamati
                                      .filter((p) => lotto.has(p))
                                      .map((p) => ({
                                          [percorso]: p,
                                          [timbro]: risorti.has(p) ? '2026-09-20T10:00:00.000Z' : null,
                                      })),
                                  error: null,
                              },
                    ).then(res)
                }
                if (colonne === 'id') {
                    // La ricevuta dell'outbox: un CONTEGGIO, non delle righe.
                    return Promise.resolve({
                        data: null,
                        error: h.erroreRicevuta,
                        count: h.senzaScadenzaPerIntent,
                    }).then(res)
                }
                return Promise.resolve({ data: [], error: null }).then(res)
            }
            return qb
        }

        return {
            from: builder,
            rpc: (nome: string, argomenti: Record<string, unknown>) => {
                h.rpc.push({ nome, argomenti })
                h.sequenza.push({ tipo: `rpc:${nome}`, valore: argomenti })
                if (nome === 'video_galleria_flusso_vecchio_revoca') {
                    return Promise.resolve({ data: h.flussoVecchio, error: h.erroreFlussoVecchio })
                }
                if (nome === 'video_intent_scadi_non_pubblicato') {
                    return Promise.resolve({ data: h.nonPubblicati, error: h.erroreNonPubblicati })
                }
                if (nome === 'video_retention_scadenze') {
                    return Promise.resolve({ data: h.scadenze, error: h.erroreScadenze })
                }
                if (nome === 'video_retention_originale_rimosso') {
                    if (h.eccezioneTimbro) throw h.eccezioneTimbro
                    return Promise.resolve({ data: h.timbro, error: h.erroreTimbro })
                }
                if (nome === 'video_retention_uscita_rimossa') {
                    if (h.eccezioneTimbroUscita) throw h.eccezioneTimbroUscita
                    return Promise.resolve({ data: h.timbroUscita, error: h.erroreTimbroUscita })
                }
                if (nome === 'video_intenti_minimizza') {
                    return Promise.resolve({ data: h.minimizza, error: h.erroreMinimizza })
                }
                if (nome === 'video_riconciliazione') {
                    return Promise.resolve({ data: h.riconciliazione, error: h.erroreRiconciliazione })
                }
                if (nome === 'video_outbox_claim') {
                    // Come il database: con `p_tipi` prende SOLO i tipi richiesti. Un doppio che restituisse
                    // sempre tutto renderebbe verde una route che non passa il filtro, e muta una prova
                    // sulla DIVISIONE dei tipi (retention / runner) in una prova sul doppio.
                    const risposta = h.outboxClaim as { ok?: boolean; eventi?: { event_type: string }[] } | null
                    const tipi = argomenti.p_tipi
                    if (Array.isArray(tipi) && !h.claimIgnoraFiltro && risposta?.ok === true) {
                        return Promise.resolve({
                            data: {
                                ...risposta,
                                eventi: (risposta.eventi ?? []).filter((e) => tipi.includes(e.event_type)),
                            },
                            error: h.erroreClaim,
                        })
                    }
                    return Promise.resolve({ data: h.outboxClaim, error: h.erroreClaim })
                }
                return Promise.resolve({ data: h.outboxChiusura, error: null })
            },
            storage: {
                // Due magazzini, due alberi: un doppio che servisse lo stesso albero a entrambi
                // renderebbe ogni orfano doppio, e una spazzata che guarda il bucket sbagliato verde.
                from: (bucket: string) => ({
                    remove: (percorsi: string[]) => {
                        h.sequenza.push({ tipo: 'remove', valore: percorsi, bucket })
                        const risposta = bucket === BUCKET_USCITE ? h.removeRispostaUscite : h.removeRisposta
                        return Promise.resolve(
                            risposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
                        )
                    },
                    // ⚠️ `list()` serve DUE scopi, e confonderli è il modo più facile di
                    // rendere verde una spazzata cieca: `rimuoviEVerifica` chiede di UN
                    // percorso passando `search`; la traversata elenca una CARTELLA.
                    list: (cartella: string, opzioni?: { search?: string }) => {
                        if (typeof opzioni?.search === 'string') {
                            const nome = opzioni.search
                            if (h.erroreVerifica) {
                                return Promise.resolve({ data: null, error: h.erroreVerifica })
                            }
                            const completo = cartella ? `${cartella}/${nome}` : nome
                            return Promise.resolve({
                                data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
                                error: null,
                            })
                        }
                        const uscite = bucket === BUCKET_USCITE
                        ;(uscite ? h.elencazioniUscite : h.elencazioni).push({ cartella, opzioni })
                        const errore = uscite ? h.erroreElencoUscite : h.erroreElenco
                        if (errore) return Promise.resolve({ data: null, error: errore })
                        return Promise.resolve({
                            data: (uscite ? h.alberoUscite : h.albero)[cartella] ?? [],
                            error: null,
                        })
                    },
                }),
            },
        }
    },
}))

import { POST } from '@/app/api/gdpr/retention-video/route'
import { DESTINATARI, destinatarioDi, TIPI_SOLO_DEL_RUNNER } from '@/lib/media/video/outbox'

/** Un istante abbastanza vecchio da superare la grazia di 24 ore. */
const VECCHIO = new Date(Date.now() - 72 * 3_600_000).toISOString()
/** Un istante dentro la grazia: un caricamento che potrebbe essere in corso. */
const GIOVANE = new Date(Date.now() - 3 * 3_600_000).toISOString()

function chiamata(headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) {
    return new Request('http://localhost/api/gdpr/retention-video', {
        method: 'POST',
        headers,
    }) as unknown as Parameters<typeof POST>[0]
}

const battito = () =>
    h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'ms' in e.campi)

beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    h.sequenza = []
    h.rpc = []
    h.query = []
    h.nQuery = 0
    h.flussoVecchio = { ok: true, revocati: 0, rifiutati: 0 }
    h.erroreFlussoVecchio = null
    h.nonPubblicati = { ok: true, scaduti: 0, rifiutati: 0 }
    h.erroreNonPubblicati = null
    h.scadenze = { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0, uscite_senza_scadenza: 0 }
    h.erroreScadenze = null
    h.timbro = { ok: true }
    h.erroreTimbro = null
    h.eccezioneTimbro = null
    h.timbroUscita = { ok: true }
    h.erroreTimbroUscita = null
    h.eccezioneTimbroUscita = null
    h.minimizza = { ok: true, minimizzati: 0 }
    h.erroreMinimizza = null
    h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0 }
    h.erroreRiconciliazione = null
    h.outboxClaim = { ok: true, eventi: [] }
    h.erroreClaim = null
    h.claimIgnoraFiltro = false
    h.outboxChiusura = { ok: true }
    h.scaduti = []
    h.erroreScaduti = null
    h.usciteScadute = []
    h.erroreUscite = null
    h.reclamati = []
    h.reclamatiUscite = []
    h.risorti = []
    h.risorteUscite = []
    h.erroreReclamati = null
    h.erroreReclamatiUscite = null
    h.senzaScadenzaPerIntent = 0
    h.erroreRicevuta = null
    h.removeRisposta = null
    h.removeRispostaUscite = null
    h.ancoraNelBucket = new Set()
    h.erroreVerifica = null
    h.albero = {}
    h.alberoUscite = {}
    h.elencazioni = []
    h.elencazioniUscite = []
    h.erroreElenco = null
    h.erroreElencoUscite = null
    h.eventi = []
    h.staffNegato = null
})

describe('il gate, e il cron che bussa con la chiave sbagliata', () => {
    it('senza cron secret passa da requireStaff, e se lo staff nega non tocca niente', async () => {
        h.staffNegato = new Response('no', { status: 403 })
        const res = await POST(chiamata({}))

        expect(res.status).toBe(403)
        // Nessuna query, nessuna RPC, nessun file: il gate viene PRIMA di tutto.
        expect(h.rpc).toEqual([])
        expect(h.sequenza).toEqual([])
        expect(battito()[0].campi.esito).toBe('non-autorizzato')
    })

    it('un header presente e sbagliato è un GUASTO e si grida, non si degrada in silenzio', async () => {
        // È il guasto invisibile: il cron smette di conservare e nessuno lo sa,
        // perché dal lato del prodotto non succede niente.
        await POST(chiamata({ 'x-cron-secret': 'chiave-sbagliata' }))
        const grido = h.eventi.find((e) => e.campi.esito === 'secret-errato')
        expect(grido?.livello).toBe('error')
    })

    it('lo staff può lanciare il giro a mano, e il battito dichiara il canale', async () => {
        await POST(chiamata({}))
        expect(battito()[0].campi.canale).toBe('manuale')
    })
})

describe('lo schema video non applicato: si dichiara, non si finge', () => {
    it('PGRST202 sulla prima RPC ⇒ 503 e battito `schema-assente`, non un 200 che dice «niente da fare»', async () => {
        // Il database E2E della CI è un progetto separato e NON migrato, e le quattro
        // migrazioni video sono in `IN_CODA`. Un `200` qui direbbe «non c'era niente
        // da togliere», che è un altro fatto. La prima RPC del giro è la revoca del flusso vecchio.
        h.erroreFlussoVecchio = { code: 'PGRST202', message: 'function not found' }
        const res = await POST(chiamata())

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'schema-assente' })
        expect(battito()[0].campi.esito).toBe('schema-assente')
        // Nessun file toccato: non si spazza un bucket che non esiste. E nessun altro passo è partito.
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
        expect(h.rpc.map((r) => r.nome)).toEqual(['video_galleria_flusso_vecchio_revoca'])
    })

    it.each([
        ['video_intent_scadi_non_pubblicato', 'erroreNonPubblicati'],
        ['video_retention_scadenze', 'erroreScadenze'],
    ] as const)('PGRST202 su `%s` è lo stesso 503, e i passi dopo di lui non partono', async (rpc, campo) => {
        // La funzione che manca non è per forza la prima: uno schema applicato a metà non deve
        // diventare un 200 né un giro che tocca i file.
        h[campo] = { code: 'PGRST202', message: 'function not found' }
        const res = await POST(chiamata())

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'schema-assente' })
        expect(battito()[0].campi.esito).toBe('schema-assente')
        expect(h.rpc.map((r) => r.nome).at(-1)).toBe(rpc)
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
    })

    it('un errore VERO della stessa RPC è un 500, non un 503: i due casi non si confondono', async () => {
        h.erroreScadenze = { code: '57014', message: 'canceled' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(battito()[0].campi.esito).toBe('scadenze-fallite')
    })
})

describe('le scadenze: le soglie applicate sono quelle dichiarate', () => {
    it('chiama `video_retention_scadenze` con 48 ore di upload e 168 di incaglio', async () => {
        await POST(chiamata())
        const chiamataRpc = h.rpc.find((r) => r.nome === 'video_retention_scadenze')
        expect(chiamataRpc?.argomenti).toMatchObject({
            p_ore_upload: 48,
            p_ore_incaglio: 7 * 24,
        })
        // Il tetto del lotto c'è: senza, una coda arretrata terrebbe lock su
        // migliaia di righe dentro una richiesta con un tempo massimo.
        expect(typeof chiamataRpc?.argomenti.p_limite).toBe('number')
    })

    it('viene PRIMA di ogni rimozione: un originale (o un’uscita) senza scadenza non comparirebbe nell’elenco', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        await POST(chiamata())

        const iScadenze = h.sequenza.findIndex((s) => s.tipo === 'rpc:video_retention_scadenze')
        const iElenco = h.sequenza.findIndex((s) => s.tipo === 'leggi-scaduti')
        const iElencoUscite = h.sequenza.findIndex((s) => s.tipo === 'leggi-uscite-scadute')
        expect(iScadenze).toBeGreaterThanOrEqual(0)
        expect(iScadenze).toBeLessThan(iElenco)
        expect(iScadenze).toBeLessThan(iElencoUscite)
    })

    it('se la RETE ha pescato, lo grida: un cammino nuovo chiude i job senza scadenza', async () => {
        h.scadenze = { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 3 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'conclusi-senza-scadenza')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.n_righe).toBe(3)
    })

    it('le USCITE a cui la rete ha dato la scadenza NON sono un guasto: si dicono a livello `info` (#81)', async () => {
        // A differenza dei conclusi senza scadenza dell'originale. Le RPC che annullano, revocano o
        // sostituiscono un intento non scrivono la scadenza dell'uscita, e la rete è proprio il loro
        // meccanismo: «ne ho pescate 50» è lavoro trovato da fare, non un cammino che si è dimenticato.
        h.scadenze = { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0, uscite_senza_scadenza: 50 }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.campi.esito === 'uscite-dichiarate')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi.n_righe).toBe(50)
        expect(await res.json()).toMatchObject({ ok: true, uscite_dichiarate: 50 })
        expect(battito()[0].campi).toMatchObject({ esito: 'ok', n_uscite_dichiarate: 50 })
        // E nessuna riga di errore, né con quel nome né con quello dei conclusi senza scadenza.
        expect(h.eventi.filter((e) => e.livello === 'error')).toEqual([])
    })

    it('a zero la rete delle uscite non scrive niente: il battito basta', async () => {
        await POST(chiamata())
        expect(h.eventi.some((e) => e.campi.esito === 'uscite-dichiarate')).toBe(false)
        expect(battito()[0].campi.n_uscite_dichiarate).toBe(0)
    })

    it('un rifiuto della RPC (argomenti sbagliati) non passa per un giro riuscito', async () => {
        h.scadenze = { ok: false, code: 'BAD_INPUT' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(battito()[0].campi.esito).toBe('scadenze-rifiutate')
    })
})

describe('gli originali scaduti: prima il file, poi la riga', () => {
    it('l’elenco esce dall’indice PARZIALE della retention, e non da una scansione', async () => {
        await POST(chiamata())
        const lettura = h.query.find((q) => q.colonne === 'id, original_path')
        expect(lettura).toBeDefined()

        const metodi = lettura!.clausole.map((c) => `${c.metodo}:${JSON.stringify(c.argomenti)}`)
        // Le tre condizioni dell'indice `video_jobs_retention_originali_idx`, più il
        // bucket. Senza la `lte` sulla scadenza si distruggerebbe l'originale di un
        // video che deve ancora essere convertito.
        expect(metodi).toContain('is:["original_deleted_at",null]')
        expect(metodi).toContain('not:["original_delete_after","is",null]')
        expect(metodi.some((m) => m.startsWith('lte:["original_delete_after"'))).toBe(true)
        expect(metodi).toContain('eq:["original_bucket","video_originals"]')
    })

    it('PRIMA il `remove` sull’archivio, POI il timbro sulla riga', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        await POST(chiamata())

        const iRemove = h.sequenza.findIndex((s) => s.tipo === 'remove')
        const iTimbro = h.sequenza.findIndex(
            (s) => s.tipo === 'rpc:video_retention_originale_rimosso',
        )
        expect(iRemove).toBeGreaterThanOrEqual(0)
        expect(iTimbro).toBeGreaterThan(iRemove)
    })

    it('il timbro passa dalla RPC che rilegge la scadenza, non da un `update` della route', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        await POST(chiamata())

        expect(h.rpc.map((r) => r.nome)).toContain('video_retention_originale_rimosso')
        expect(h.query.filter((q) => q.operazione === 'update')).toEqual([])
        expect(
            h.rpc.find((r) => r.nome === 'video_retention_originale_rimosso')?.argomenti,
        ).toEqual({ p_job_id: JOB_A })
    })

    it('un file che RESTA nel bucket trattiene LA SUA riga, non quelle degli altri', async () => {
        h.scaduti = [
            { id: JOB_A, original_path: PATH_A },
            { id: JOB_B, original_path: PATH_B },
        ]
        // `remove` dice di aver tolto solo B; A risulta ancora nel bucket.
        h.removeRisposta = { data: [{ name: PATH_B }], error: null }
        h.ancoraNelBucket = new Set([PATH_A])

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({
            ok: false,
            motivo: 'file-non-rimossi',
            originali_rimossi: 1,
            originali_trattenuti: 1,
        })
        // B è stato timbrato, A no: il guasto di uno non blocca l'altro.
        const timbrati = h.rpc
            .filter((r) => r.nome === 'video_retention_originale_rimosso')
            .map((r) => r.argomenti.p_job_id)
        expect(timbrati).toEqual([JOB_B])
    })

    it('«non so» vale come «c’è ancora»: una verifica che non risponde trattiene la riga', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.removeRisposta = { data: [], error: null }
        h.erroreVerifica = { code: 'X', message: 'lo storage non risponde' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ motivo: 'verifica-non-riuscita' })
        expect(h.rpc.filter((r) => r.nome === 'video_retention_originale_rimosso')).toEqual([])
    })

    it('un file GIÀ assente NON è un guasto: l’esito voluto era già raggiunto', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket = new Set()

        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ originali_rimossi: 1, originali_gia_assenti: 1 })
    })

    it('il file è uscito ma la RPC rifiuta il timbro: si grida e la riga resta trattenuta', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.timbro = { ok: false, code: 'NON_ANCORA_SCADUTO' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        const grido = h.eventi.find((e) => e.campi.esito === 'timbro-rifiutato')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.error_code).toBe('NON_ANCORA_SCADUTO')
    })
})

describe('il flusso vecchio e i convertiti che nessuno ha pubblicato (§15 passi 1 e 2)', () => {
    it('chiama le due RPC col tetto del lotto e con SETTE giorni, nell’ordine della testata del file C', async () => {
        await POST(chiamata())

        const flusso = h.rpc.find((r) => r.nome === 'video_galleria_flusso_vecchio_revoca')
        const nonPubblicati = h.rpc.find((r) => r.nome === 'video_intent_scadi_non_pubblicato')
        expect(flusso?.argomenti).toEqual({ p_limite: 200 })
        // Il termine è la decisione del titolare (02/10): un convertito non pubblicato si tiene 7 giorni.
        expect(nonPubblicati?.argomenti).toEqual({ p_giorni: 7, p_limite: 200 })
        const nomi = h.rpc.map((r) => r.nome)
        expect(nomi.indexOf('video_galleria_flusso_vecchio_revoca')).toBe(0)
        expect(nomi.indexOf('video_intent_scadi_non_pubblicato')).toBe(1)
        expect(nomi.indexOf('video_retention_scadenze')).toBe(2)
    })

    it('un flusso vecchio revocato si DICE (`info`, solo conteggi), e finisce nel battito e nella risposta', async () => {
        h.flussoVecchio = { ok: true, revocati: 11, rifiutati: 1 }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.campi.esito === 'flusso-vecchio-revocato')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi).toMatchObject({ n_righe: 11, n_righe_rifiutate: 1, operazione: 'video-retention' })
        expect(await res.json()).toMatchObject({ flusso_vecchio_revocati: 11, flusso_vecchio_rifiutati: 1 })
        expect(battito()[0].campi).toMatchObject({ n_flusso_vecchio_revocati: 11, n_flusso_vecchio_rifiutati: 1 })
    })

    it('i convertiti scaduti si dicono (`info`), con i giorni, e finiscono nel battito e nella risposta', async () => {
        h.nonPubblicati = { ok: true, scaduti: 4, rifiutati: 0 }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.campi.esito === 'non-pubblicati-scaduti')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi).toMatchObject({ n_righe: 4, giorni: 7 })
        expect(await res.json()).toMatchObject({ non_pubblicati_scaduti: 4, giorni_convertito_non_pubblicato: 7 })
        expect(battito()[0].campi).toMatchObject({ n_non_pubblicati_scaduti: 4 })
    })

    it('a zero NON scrivono righe (il battito porta già i conteggi) e non cambiano l’esito', async () => {
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(h.eventi.some((e) => e.campi.esito === 'flusso-vecchio-revocato')).toBe(false)
        expect(h.eventi.some((e) => e.campi.esito === 'non-pubblicati-scaduti')).toBe(false)
        expect(battito()[0].campi).toMatchObject({
            esito: 'ok',
            n_flusso_vecchio_revocati: 0,
            n_non_pubblicati_scaduti: 0,
        })
    })

    it.each([
        ['flusso vecchio', 'erroreFlussoVecchio', 'flusso-vecchio-fallito'],
        ['non pubblicati', 'erroreNonPubblicati', 'non-pubblicati-fallito'],
    ] as const)(
        'se il passo «%s» NON risponde è un guasto (500, battito non `ok`) ma il resto del giro gira lo stesso',
        async (_nome, campo, esito) => {
            // Un passo che non regge gli altri non li ferma: la conservazione degli originali, delle uscite e
            // la minimizzazione dei bambini non dipendono da lui.
            h[campo] = { code: '57014', message: 'canceled' }
            h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
            const res = await POST(chiamata())

            expect(res.status).toBe(500)
            expect(await res.json()).toMatchObject({ ok: false, motivo: esito, error_code: '57014' })
            expect(battito()[0].campi.esito).toBe(esito)
            expect(h.rpc.map((r) => r.nome)).toEqual(
                expect.arrayContaining([
                    'video_retention_scadenze',
                    'video_retention_originale_rimosso',
                    'video_intenti_minimizza',
                    'video_outbox_claim',
                    'video_riconciliazione',
                ]),
            )
            const grido = h.eventi.find((e) => e.campi.esito === esito)
            expect(grido?.livello).toBe('error')
            expect(grido?.campi.error_code).toBe('57014')
        },
    )

    it('una RPC che RIFIUTA (`ok: false`) non passa per un passo riuscito: PostgREST non lancia', async () => {
        h.flussoVecchio = { ok: false, code: 'BAD_INPUT' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'flusso-vecchio-fallito', error_code: 'BAD_INPUT' })
        const grido = h.eventi.find((e) => e.campi.esito === 'flusso-vecchio-rifiutato')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.error_code).toBe('BAD_INPUT')
    })

    it('con due guasti il battito dice il PRIMO, e la risposta li conta tutti nei suoi numeri', async () => {
        h.erroreFlussoVecchio = { code: '57014', message: 'canceled' }
        h.erroreMinimizza = { code: '57014', message: 'canceled' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(battito()[0].campi.esito).toBe('flusso-vecchio-fallito')
        expect(h.eventi.find((e) => e.campi.esito === 'minimizzazione-fallito')?.livello).toBe('error')
    })
})

describe('un originale trattenuto non ferma i passi che non dipendono dallo Storage', () => {
    it('la minimizzazione, la coda e la riconciliazione girano anche se un originale non esce (500 in fondo)', async () => {
        // Prima la route usciva QUI: con un solo file che lo Storage non rilascia, i bambini restavano
        // sugli intenti, la coda non si drenava e la riconciliazione non contava, a ogni giro, per sempre.
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket = new Set([PATH_A])

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({
            ok: false,
            motivo: 'file-non-rimossi',
            originali_trattenuti: 1,
        })
        expect(battito()[0].campi.esito).toBe('originali-trattenuti')
        const nomi = h.rpc.map((r) => r.nome)
        expect(nomi).toContain('video_intenti_minimizza')
        expect(nomi).toContain('video_outbox_claim')
        expect(nomi).toContain('video_riconciliazione')
    })
})

describe('le uscite scadute: `video_processing`, prima il file e poi la riga (§15 passo 3)', () => {
    it('l’elenco esce dall’indice PARZIALE delle uscite e chiede SOLO righe che nominano un file (#77)', async () => {
        await POST(chiamata())
        const lettura = h.query.find((q) => q.colonne === 'id, output_path')
        expect(lettura, 'la route non legge le uscite scadute').toBeDefined()

        const metodi = lettura!.clausole.map((c) => `${c.metodo}:${JSON.stringify(c.argomenti)}`)
        // Le condizioni dell'indice `video_jobs_uscite_da_togliere_idx`, più il bucket. Senza la `lte`
        // sulla scadenza si distruggerebbe l'uscita di un video che deve ancora essere pubblicato.
        expect(metodi).toContain('eq:["output_bucket","video_processing"]')
        expect(metodi).toContain('is:["output_deleted_at",null]')
        expect(metodi).toContain('not:["output_delete_after","is",null]')
        expect(metodi.some((m) => m.startsWith('lte:["output_delete_after"'))).toBe(true)
        // #77: `video_retention_uscita_rimossa` non verifica `output_path IS NOT NULL`, quindi si passano
        // solo le righe che hanno un file da togliere.
        expect(metodi).toContain('not:["output_path","is",null]')
        // Per scadenza crescente: se il tetto taglia, taglia i meno in ritardo.
        expect(metodi).toContain('order:["output_delete_after",{"ascending":true}]')
        expect(metodi).toContain('limit:[200]')
    })

    it('una riga che NON nomina un file e passa lo stesso la lettura non si timbra mai: niente da togliere, niente timbro (#77)', async () => {
        // Doppia cintura: la lettura esclude `output_path` nullo, ma se un giorno non lo facesse la RPC del
        // timbro (che non verifica il percorso) dichiarerebbe «tolta» un'uscita che non è mai esistita.
        h.usciteScadute = [
            { id: JOB_C, output_path: null as unknown as string },
            { id: JOB_D, output_path: USCITA_D },
        ]
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const timbrati = h.rpc.filter((r) => r.nome === 'video_retention_uscita_rimossa').map((r) => r.argomenti.p_job_id)
        expect(timbrati, 'una riga senza percorso è stata timbrata').toEqual([JOB_D])
        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove' && s.bucket === BUCKET_USCITE)
        expect(rimozioni.map((r) => r.valore)).toEqual([[USCITA_D]])
        expect(await res.json()).toMatchObject({ uscite_scadute: 1, uscite_rimosse: 1 })
    })

    it('PRIMA il `remove` su `video_processing`, POI il timbro `video_retention_uscita_rimossa`, per riga', async () => {
        h.usciteScadute = [
            { id: JOB_C, output_path: USCITA_C },
            { id: JOB_D, output_path: USCITA_D },
        ]
        await POST(chiamata())

        const iRemove = h.sequenza.findIndex((s) => s.tipo === 'remove' && s.bucket === BUCKET_USCITE)
        const timbri = h.sequenza
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.tipo === 'rpc:video_retention_uscita_rimossa')
        expect(iRemove).toBeGreaterThanOrEqual(0)
        expect(timbri).toHaveLength(2)
        // Il file esce PRIMA di ogni timbro: la riga non può dichiarare tolto un file che c'è.
        expect(timbri.every(({ i }) => i > iRemove)).toBe(true)
        expect(h.sequenza[iRemove].valore).toEqual([USCITA_C, USCITA_D])
        expect(timbri.map(({ s }) => s.valore)).toEqual([{ p_job_id: JOB_C }, { p_job_id: JOB_D }])
        // Il timbro passa dalla RPC che rilegge la scadenza sotto lock, non da un `update` della route.
        expect(h.query.filter((q) => q.operazione === 'update')).toEqual([])
    })

    it('un’uscita rimossa e timbrata si dice (`info`, conteggio) e finisce nella risposta e nel battito', async () => {
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ uscite_scadute: 1, uscite_rimosse: 1, uscite_trattenute: 0 })
        const riga = h.eventi.find((e) => e.campi.esito === 'uscite-rimosse')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi.n_righe).toBe(1)
        expect(battito()[0].campi).toMatchObject({ esito: 'ok', n_uscite_scadute: 1, n_uscite_rimosse: 1, n_uscite_trattenute: 0 })
    })

    it('un’uscita che RESTA nel bucket trattiene LA SUA riga: 500, e le altre uscite si timbrano', async () => {
        h.usciteScadute = [
            { id: JOB_C, output_path: USCITA_C },
            { id: JOB_D, output_path: USCITA_D },
        ]
        // `remove` dice di aver tolto solo D; C risulta ancora nel bucket.
        h.removeRispostaUscite = { data: [{ name: USCITA_D }], error: null }
        h.ancoraNelBucket = new Set([USCITA_C])

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({
            ok: false,
            motivo: 'file-non-rimossi',
            uscite_rimosse: 1,
            uscite_trattenute: 1,
        })
        expect(battito()[0].campi).toMatchObject({ esito: 'uscite-trattenute', n_uscite_rimosse: 1, n_uscite_trattenute: 1 })
        // D è stato timbrato, C no: il guasto di una non blocca l'altra.
        const timbrati = h.rpc
            .filter((r) => r.nome === 'video_retention_uscita_rimossa')
            .map((r) => r.argomenti.p_job_id)
        expect(timbrati).toEqual([JOB_D])
        const grido = h.eventi.find((e) => e.campi.esito === 'uscite-trattenute')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi).toMatchObject({ n_righe_trattenute: 1, n_file_ancora_presenti: 1 })
    })

    it('«non so» vale come «c’è ancora»: una verifica che non risponde trattiene la riga dell’uscita', async () => {
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.removeRispostaUscite = { data: [], error: null }
        h.erroreVerifica = { code: 'X', message: 'lo storage non risponde' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ motivo: 'verifica-non-riuscita', uscite_trattenute: 1 })
        expect(h.rpc.filter((r) => r.nome === 'video_retention_uscita_rimossa')).toEqual([])
    })

    it('un file GIÀ assente NON è un guasto: l’esito voluto era già raggiunto', async () => {
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.removeRispostaUscite = { data: [], error: null }
        h.ancoraNelBucket = new Set()

        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ uscite_rimosse: 1, uscite_gia_assenti: 1 })
    })

    it('il file è uscito ma la RPC rifiuta il timbro: si grida e la riga resta trattenuta', async () => {
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.timbroUscita = { ok: false, code: 'NON_ANCORA_SCADUTO' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        const grido = h.eventi.find((e) => e.campi.esito === 'uscita-timbro-rifiutato')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.error_code).toBe('NON_ANCORA_SCADUTO')
        expect(grido?.campi.job_id).toBe(JOB_C)
    })

    it('il timbro che non RISPONDE trattiene la riga e si grida col suo codice (PostgREST non lancia)', async () => {
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.erroreTimbroUscita = { code: '57014', message: 'canceled' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        const grido = h.eventi.find((e) => e.campi.esito === 'uscita-timbro-fallito')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.error_code).toBe('57014')
    })

    it('se la LETTURA delle uscite fallisce non si finge «zero scadute»: guasto dichiarato, il giro prosegue', async () => {
        h.erroreUscite = { code: '57014', message: 'canceled' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'uscite-lettura-fallita', error_code: '57014' })
        expect(battito()[0].campi.esito).toBe('uscite-lettura-fallita')
        expect(h.eventi.find((e) => e.campi.esito === 'uscite-lettura-fallita')?.livello).toBe('error')
        // I passi che non dipendono dalla lettura sono girati.
        expect(h.rpc.map((r) => r.nome)).toContain('video_intenti_minimizza')
    })

    it('le uscite trattenute NON fermano gli originali (né viceversa): ciascun magazzino ha i suoi numeri', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.removeRisposta = { data: [{ name: PATH_A }], error: null }
        h.removeRispostaUscite = { data: [], error: null }
        h.ancoraNelBucket = new Set([USCITA_C])

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({
            originali_rimossi: 1,
            originali_trattenuti: 0,
            uscite_trattenute: 1,
        })
    })

    it('a zero NON scrive righe di rimozione (il battito porta i conteggi)', async () => {
        await POST(chiamata())
        expect(h.eventi.some((e) => e.campi.esito === 'uscite-rimosse')).toBe(false)
        expect(h.eventi.some((e) => e.campi.esito === 'uscite-trattenute')).toBe(false)
        expect(battito()[0].campi).toMatchObject({ n_uscite_scadute: 0, n_uscite_rimosse: 0, n_uscite_trattenute: 0 })
    })
})

describe('gli orfani del bucket: dal magazzino al database, che è la direzione opposta', () => {
    it('scende nelle CARTELLE (`id: null`) invece di trattarle come oggetti', async () => {
        // Il difetto che la galleria ha pagato: `list()` su un prefisso restituisce
        // le cartelle, non i file. Una traversata che le contasse come oggetti
        // riferirebbe «zero orfani» a ogni giro — verde, e cieca.
        h.albero = {
            '': [{ name: 'originals', id: null }],
            originals: [{ name: JOB_A, id: null }],
            [`originals/${JOB_A}`]: [
                { name: 'source.mov', id: 'oggetto-1', created_at: VECCHIO },
            ],
        }
        const res = await POST(chiamata())
        const corpo = await res.json()

        expect(h.elencazioni.map((e) => e.cartella)).toEqual(['', 'originals', `originals/${JOB_A}`])
        expect(corpo.orfani_esaminati).toBe(1)
        expect(corpo.orfani_rimossi).toBe(1)
    })

    it('un oggetto RECLAMATO da una riga non si tocca, e uno solo va via', async () => {
        h.albero = {
            '': [
                { name: 'reclamato.mov', id: 'o1', created_at: VECCHIO },
                { name: 'orfano.mov', id: 'o2', created_at: VECCHIO },
            ],
        }
        h.reclamati = ['reclamato.mov']

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esaminati: 2, orfani_rimossi: 1 })

        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect(rimozioni[0].valore).toEqual(['orfano.mov'])
    })

    it('la GRAZIA di 24 ore protegge un caricamento la cui riga sta ancora nascendo', async () => {
        h.albero = { '': [{ name: 'appena-caricato.mov', id: 'o1', created_at: GIOVANE }] }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esaminati: 0, orfani_rimossi: 0 })
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
    })

    it('una data illeggibile vale come «giovane»: nel dubbio non si distrugge', async () => {
        h.albero = { '': [{ name: 'senza-data.mov', id: 'o1', created_at: null }] }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_rimossi: 0 })
    })

    it('se la domanda «chi lo reclama?» FALLISCE, non si cancella niente', async () => {
        // È il ramo che, senza il controllo sul valore di ritorno di PostgREST,
        // proseguirebbe con «nessuno lo reclama» e distruggerebbe il video di un
        // bambino il cui job è vivo. PostgREST non lancia: ritorna `{ error }`.
        h.albero = { '': [{ name: 'orfano.mov', id: 'o1', created_at: VECCHIO }] }
        h.erroreReclamati = { code: '42P01', message: 'relation does not exist' }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esito: 'reclami-falliti', orfani_rimossi: 0 })
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-reclami-falliti')?.livello).toBe('error')
    })

    it('una cartella troppo in fondo non viene esplorata, e il fatto si DICHIARA', async () => {
        // Un troncamento silenzioso racconterebbe una pulizia che non è avvenuta.
        h.albero = {
            '': [{ name: 'a', id: null }],
            a: [{ name: 'b', id: null }],
            'a/b': [{ name: 'c', id: null }],
        }
        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_profondita_troncata: true })
    })

    // ── LA SPAZZATA ESTESA A `video_processing` (§15 passo 4) ────────────────────
    // Il bucket delle uscite conserva il file di OGNI tentativo, ma la riga nomina solo l'ultimo: gli
    // altri, e ciò che un Sandbox morto ha lasciato, non li reclama nessuno e restano per sempre.

    it('spazza ANCHE `video_processing`: un’uscita che nessuna riga nomina esce, con la sua grazia di 24 ore', async () => {
        h.alberoUscite = {
            '': [{ name: '20000000-0000-4000-8000-000000000002', id: null }],
            '20000000-0000-4000-8000-000000000002': [{ name: '40000000-0000-4000-8000-00000000000c', id: null }],
            '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000c': [
                { name: '1.mp4', id: 'u1', created_at: VECCHIO },
                { name: '2.mp4', id: 'u2', created_at: GIOVANE },
            ],
        }

        const res = await POST(chiamata())

        // Scende fino al terzo livello (`<chi carica>/<job>/<tentativo>.mp4`), come i percorsi veri.
        expect(h.elencazioniUscite.map((e) => e.cartella)).toEqual([
            '',
            '20000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000c',
        ])
        // Una sola esce: la giovane è dentro la grazia.
        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect(rimozioni[0].bucket).toBe(BUCKET_USCITE)
        expect(rimozioni[0].valore).toEqual([
            '20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-00000000000c/1.mp4',
        ])
        const corpo = await res.json()
        expect(corpo).toMatchObject({
            orfani_uscite_esito: 'ok',
            orfani_uscite_esaminati: 1,
            orfani_uscite_rimossi: 1,
            // I due magazzini sono contati a parte: l'orfano delle uscite non è un orfano degli originali.
            orfani_rimossi: 0,
        })
        expect(battito()[0].campi.n_orfani_uscite_rimossi).toBe(1)
    })

    it('un’uscita che una riga NOMINA non si tocca, e la domanda al database usa le colonne delle USCITE', async () => {
        h.alberoUscite = {
            '': [
                { name: 'reclamata.mp4', id: 'u1', created_at: VECCHIO },
                { name: 'orfana.mp4', id: 'u2', created_at: VECCHIO },
            ],
        }
        h.reclamatiUscite = ['reclamata.mp4']

        await POST(chiamata())

        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect(rimozioni[0]).toMatchObject({ bucket: BUCKET_USCITE, valore: ['orfana.mp4'] })
        // Non basta che il doppio sappia rispondere: la route deve CHIEDERE le colonne giuste.
        const domanda = h.query.find((q) => q.colonne === 'output_path, output_deleted_at')
        expect(domanda, 'la route non ha chiesto chi reclama le uscite').toBeDefined()
        const metodi = domanda!.clausole.map((c) => c.metodo + ':' + JSON.stringify(c.argomenti[0]))
        expect(metodi).toContain('eq:"output_bucket"')
        expect(metodi).toContain('in:"output_path"')
    })

    it('se la domanda «chi reclama le uscite?» FALLISCE, non si cancella niente da `video_processing`', async () => {
        h.alberoUscite = { '': [{ name: 'orfana.mp4', id: 'u1', created_at: VECCHIO }] }
        h.erroreReclamatiUscite = { code: '42P01', message: 'relation does not exist' }

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ orfani_uscite_esito: 'reclami-falliti', orfani_uscite_rimossi: 0 })
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-uscite-reclami-falliti')?.livello).toBe('error')
    })

    it('se l’ELENCO delle uscite fallisce si dichiara, e la spazzata degli originali gira lo stesso', async () => {
        h.erroreElencoUscite = { code: '500', message: 'storage' }
        h.albero = { '': [{ name: 'orfano.mov', id: 'o1', created_at: VECCHIO }] }

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ orfani_uscite_esito: 'elenco-fallito', orfani_rimossi: 1 })
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-uscite-elenco-fallito')?.livello).toBe('error')
    })

    it('un’uscita orfana che non esce dall’archivio si grida, e la spazzata si dichiara PARZIALE (non `ok`)', async () => {
        h.alberoUscite = { '': [{ name: 'orfana.mp4', id: 'u1', created_at: VECCHIO }] }
        h.removeRispostaUscite = { data: [], error: null }
        h.ancoraNelBucket = new Set(['orfana.mp4'])

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ orfani_uscite_esito: 'parziale', orfani_uscite_rimossi: 0 })
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-uscite-non-rimossi')?.livello).toBe('error')
    })

    // ── GLI ORIGINALI RISORTI (§15 passo 4) ──────────────────────────────────────
    // Due casi misurati il 01/10: il file è ricomparso DOPO il timbro di cancellazione. La riga lo nomina, e
    // quindi non è un orfano: ma dichiara di averlo già tolto. Si toglie il file, mai la riga.

    it('un originale RISORTO (la riga lo nomina ma è già timbrata) si toglie, e si dice a livello `warn`', async () => {
        h.albero = {
            '': [
                { name: 'risorto.mov', id: 'o1', created_at: VECCHIO },
                { name: 'vivo.mov', id: 'o2', created_at: VECCHIO },
            ],
        }
        h.reclamati = ['risorto.mov', 'vivo.mov']
        h.risorti = ['risorto.mov']

        const res = await POST(chiamata())

        // Esce SOLO il risorto: l'originale di un job vivo non si tocca.
        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect(rimozioni[0]).toMatchObject({ bucket: BUCKET_ORIGINALI, valore: ['risorto.mov'] })
        expect(await res.json()).toMatchObject({
            originali_risorti_rimossi: 1,
            orfani_rimossi: 0,
            orfani_esaminati: 2,
        })
        expect(battito()[0].campi.n_originali_risorti_rimossi).toBe(1)
        const riga = h.eventi.find((e) => e.campi.esito === 'originali-risorti-rimossi')
        expect(riga?.livello).toBe('warn')
        expect(riga?.campi.n_file).toBe(1)
        // La riga è già a posto: nessun timbro, nessun `update`.
        expect(h.rpc.filter((r) => r.nome === 'video_retention_originale_rimosso')).toEqual([])
        expect(h.query.filter((q) => q.operazione === 'update')).toEqual([])
    })

    it('orfani e risorti escono INSIEME, e i due conteggi restano distinti', async () => {
        h.albero = {
            '': [
                { name: 'risorto.mov', id: 'o1', created_at: VECCHIO },
                { name: 'orfano.mov', id: 'o2', created_at: VECCHIO },
            ],
        }
        h.reclamati = ['risorto.mov']
        h.risorti = ['risorto.mov']

        const res = await POST(chiamata())

        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect([...(rimozioni[0].valore as string[])].sort()).toEqual(['orfano.mov', 'risorto.mov'])
        expect(await res.json()).toMatchObject({ orfani_rimossi: 1, originali_risorti_rimossi: 1 })
    })

    it('un originale che la riga NOMINA e non ha timbrato è vivo: non è un risorto, e non si tocca', async () => {
        h.albero = { '': [{ name: 'vivo.mov', id: 'o1', created_at: VECCHIO }] }
        h.reclamati = ['vivo.mov']
        h.risorti = []

        const res = await POST(chiamata())

        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
        expect(await res.json()).toMatchObject({ originali_risorti_rimossi: 0, orfani_rimossi: 0 })
        expect(h.eventi.some((e) => e.campi.esito === 'originali-risorti-rimossi')).toBe(false)
    })

    it('un risorto che non esce dall’archivio non conta come tolto', async () => {
        h.albero = { '': [{ name: 'risorto.mov', id: 'o1', created_at: VECCHIO }] }
        h.reclamati = ['risorto.mov']
        h.risorti = ['risorto.mov']
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket = new Set(['risorto.mov'])

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ orfani_esito: 'parziale', originali_risorti_rimossi: 0 })
        expect(h.eventi.some((e) => e.campi.esito === 'originali-risorti-rimossi')).toBe(false)
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-non-rimossi')?.livello).toBe('error')
    })

    it('la grazia di 24 ore vale anche per un risorto: un file giovane può essere un caricamento in corso', async () => {
        h.albero = { '': [{ name: 'risorto.mov', id: 'o1', created_at: GIOVANE }] }
        h.reclamati = ['risorto.mov']
        h.risorti = ['risorto.mov']

        await POST(chiamata())

        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
    })

    it('anche un’uscita RISORTA (riga timbrata, file presente) si toglie, con il suo evento', async () => {
        h.alberoUscite = { '': [{ name: 'risorta.mp4', id: 'u1', created_at: VECCHIO }] }
        h.reclamatiUscite = ['risorta.mp4']
        h.risorteUscite = ['risorta.mp4']

        const res = await POST(chiamata())

        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([
            { tipo: 'remove', valore: ['risorta.mp4'], bucket: BUCKET_USCITE },
        ])
        expect(await res.json()).toMatchObject({ uscite_risorte_rimosse: 1, orfani_uscite_rimossi: 0 })
        expect(h.eventi.find((e) => e.campi.esito === 'uscite-risorte-rimosse')?.livello).toBe('warn')
    })
})

describe('la minimizzazione dei bambini sugli intenti (§15 passo 5)', () => {
    it('chiama `video_intenti_minimizza` con SETTE giorni e il tetto del lotto', async () => {
        await POST(chiamata())

        const chiamataRpc = h.rpc.find((r) => r.nome === 'video_intenti_minimizza')
        expect(chiamataRpc?.argomenti).toEqual({ p_giorni: 7, p_limite: 200 })
    })

    it('gli intenti minimizzati si dicono (`info`, solo il numero) e finiscono nel battito e nella risposta', async () => {
        h.minimizza = { ok: true, minimizzati: 6 }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const riga = h.eventi.find((e) => e.campi.esito === 'intenti-minimizzati')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi).toMatchObject({ n_righe: 6, giorni: 7 })
        expect(await res.json()).toMatchObject({ intenti_minimizzati: 6 })
        expect(battito()[0].campi.n_intenti_minimizzati).toBe(6)
    })

    it('a zero non scrive righe; il battito dice zero', async () => {
        await POST(chiamata())
        expect(h.eventi.some((e) => e.campi.esito === 'intenti-minimizzati')).toBe(false)
        expect(battito()[0].campi.n_intenti_minimizzati).toBe(0)
    })

    it('gira DOPO le rimozioni e PRIMA della coda: i bambini lasciano la tabella anche se lo Storage è in difficoltà', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        await POST(chiamata())

        const passi = h.sequenza.map((s) => s.tipo)
        const iMinimizza = passi.indexOf('rpc:video_intenti_minimizza')
        expect(iMinimizza).toBeGreaterThan(passi.lastIndexOf('rpc:video_retention_uscita_rimossa'))
        expect(iMinimizza).toBeGreaterThan(passi.lastIndexOf('rpc:video_retention_originale_rimosso'))
        expect(iMinimizza).toBeLessThan(passi.indexOf('rpc:video_outbox_claim'))
    })

    it('se NON risponde è un guasto (`minimizzazione-fallito`, 500) e il battito non è `ok`: i bambini restano sugli intenti', async () => {
        h.erroreMinimizza = { code: '57014', message: 'canceled' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'minimizzazione-fallito', error_code: '57014' })
        expect(battito()[0].campi.esito).toBe('minimizzazione-fallito')
        expect(h.eventi.find((e) => e.campi.esito === 'minimizzazione-fallito')?.livello).toBe('error')
        // La coda e la riconciliazione sono girate lo stesso.
        expect(h.rpc.map((r) => r.nome)).toEqual(expect.arrayContaining(['video_outbox_claim', 'video_riconciliazione']))
    })

    it('lo schema che non c’è (PGRST202) lo dice a livello `warn`, ma è comunque un guasto: non si tace', async () => {
        h.erroreMinimizza = { code: 'PGRST202', message: 'function not found' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(h.eventi.find((e) => e.campi.esito === 'minimizzazione-schema-assente')?.livello).toBe('warn')
        expect(battito()[0].campi.esito).toBe('minimizzazione-fallito')
    })
})

describe('la coda delle notifiche: svuotata con le RPC che esistono già', () => {
    const evento = (event_type: string) => ({
        id: '60000000-0000-4000-8000-000000000001',
        intent_id: INTENT,
        revision: 1,
        event_type,
        attempts: 1,
    })

    it('un evento NOTO la cui ricevuta torna si dichiara inviato', async () => {
        h.outboxClaim = { ok: true, eventi: [evento('intent.superseded')] }
        h.senzaScadenzaPerIntent = 0

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ outbox_presi: 1, outbox_inviati: 1 })
        expect(h.rpc.map((r) => r.nome)).toContain('video_outbox_sent')
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_fail')
    })

    it('un evento NOTO i cui job sono ancora senza scadenza NON si dichiara inviato', async () => {
        // La ricevuta è il punto: l'evento dice «questa revisione è morta, la
        // retention deve saperlo». Se quei job sono invisibili all'indice, la
        // retention NON lo sa, e dichiarare l'evento consegnato sarebbe una bugia.
        h.outboxClaim = { ok: true, eventi: [evento('intent.revoked')] }
        h.senzaScadenzaPerIntent = 2

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ outbox_presi: 1, outbox_inviati: 0, outbox_falliti: 1 })
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_sent')
        const fallimento = h.rpc.find((r) => r.nome === 'video_outbox_fail')
        expect(fallimento?.argomenti.p_error_code).toBe('ORIGINALI_SENZA_SCADENZA')
        expect(h.eventi.find((e) => e.campi.esito === 'outbox-originali-senza-scadenza')?.livello).toBe(
            'error',
        )
    })

    it('un tipo che NESSUNO ha registrato non lo prende la retention (il filtro è nel claim): resta nella coda, intatto', async () => {
        // Prima lo prendeva, lo gridava e lo rimetteva in attesa a ogni giro, bruciando i suoi 25
        // tentativi. Con il filtro nel claim non lo vede: `tipo.inesistente` e non `intent.published`,
        // perché un nome plausibile diventerebbe falso il giorno in cui arriva un `*.published` vero (è
        // successo con `gallery.published`, 2b D14). Che nessuno lo consegni non è più un grido per ogni
        // giro: è il ritardo che la riconciliazione conta (`outbox-in-ritardo`, qui sotto) — e il lock di
        // famiglia più in basso impedisce che il codice lo scriva senza averlo registrato.
        h.outboxClaim = { ok: true, eventi: [evento('tipo.inesistente')] }

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ outbox_presi: 0, outbox_inviati: 0, outbox_senza_destinatario: 0 })
        const nomi = h.rpc.map((r) => r.nome)
        expect(nomi).not.toContain('video_outbox_sent')
        expect(nomi).not.toContain('video_outbox_fail')
        expect(h.eventi.some((e) => e.campi.esito === 'outbox-senza-destinatario')).toBe(false)
    })

    it('il ritardo della coda si grida a livello `warn`: è il sintomo di un tipo che nessuno consuma', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0, outbox_in_ritardo: 3 }
        await POST(chiamata())

        const riga = h.eventi.find((e) => e.campi.esito === 'outbox-in-ritardo')
        expect(riga?.livello).toBe('warn')
        expect(riga?.campi.n_righe).toBe(3)
        expect(battito()[0].campi.n_outbox_in_ritardo).toBe(3)
    })

    it('a zero il ritardo non scrive niente', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0, outbox_in_ritardo: 0 }
        await POST(chiamata())
        expect(h.eventi.some((e) => e.campi.esito === 'outbox-in-ritardo')).toBe(false)
    })

    it('la retention prende i tipi REGISTRATI tranne quelli del runner, e li passa NEL claim', async () => {
        await POST(chiamata())

        const claim = h.rpc.filter((r) => r.nome === 'video_outbox_claim')
        expect(claim).toHaveLength(1)
        const tipi = claim[0].argomenti.p_tipi as string[]
        expect(Array.isArray(tipi), 'il claim non porta il filtro per tipo (`p_tipi`): è la versione a tre argomenti').toBe(true)
        // I tre tipi che esistono dal 2026-09 ci sono: la retention li consegna.
        expect(tipi).toEqual(expect.arrayContaining(['intent.superseded', 'intent.revoked', 'gallery.published']))
        // E quello delle pubblicazioni NON c'è, comunque sia registrato: lo consuma solo il runner (§8.1).
        expect(tipi).not.toContain('gallery.auto_publish')
        // Sono ricavati dal registro, non scritti a mano: tutti e soli i registrati meno quelli del runner.
        expect([...tipi].sort()).toEqual(
            Object.keys(DESTINATARI)
                .filter((t) => !TIPI_SOLO_DEL_RUNNER.includes(t))
                .sort(),
        )
        // Il tetto del database: da 1 a 20 tipi.
        expect(tipi.length).toBeGreaterThanOrEqual(1)
        expect(tipi.length).toBeLessThanOrEqual(20)
    })

    it('un evento delle PUBBLICAZIONI non lo prende la retention nemmeno se è il primo della coda', async () => {
        // Il doppio fa ciò che fa il database con `p_tipi`: l'evento del runner non esce dal claim, quindi
        // nessuna lease, nessun tentativo e nessun destinatario chiamato da qui.
        h.outboxClaim = { ok: true, eventi: [evento('gallery.auto_publish'), evento('intent.revoked')] }

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ outbox_presi: 1, outbox_inviati: 1, outbox_saltati: 0 })
        const chiusi = h.rpc.filter((r) => r.nome === 'video_outbox_sent')
        expect(chiusi).toHaveLength(1)
    })

    it('un claim che IGNORA il filtro non fa consegnare nulla fuori dai tipi: si grida e non si chiude l’evento', async () => {
        // Lo scenario che col claim filtrato non può succedere — un overload sbagliato, una versione
        // vecchia della funzione —: l'evento è già in lease con un tentativo in più. Non si consegna e non
        // si fallisce, ma NON si tace: senza questa riga il vecchio difetto tornerebbe invisibile.
        h.claimIgnoraFiltro = true
        h.outboxClaim = { ok: true, eventi: [evento('gallery.auto_publish'), evento('intent.revoked')] }

        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ outbox_presi: 2, outbox_inviati: 1, outbox_saltati: 1 })
        const grido = h.eventi.find((e) => e.campi.esito === 'outbox-evento-fuori-filtro')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.operazione).toBe('video-retention')
        // Un solo evento chiuso (quello dei suoi tipi); l'altro non si tocca.
        expect(h.rpc.filter((r) => r.nome === 'video_outbox_sent')).toHaveLength(1)
        expect(h.rpc.filter((r) => r.nome === 'video_outbox_fail')).toEqual([])
    })

    // ── D14 (consegna 2b): `gallery.published` ──────────────────────────────────
    // Dal 18 al 23/09/2026 tredici eventi `gallery.published` sono finiti in
    // quarantena (`attempts` 25) con `DESTINATARIO_ASSENTE`: `POST /api/gallery` li
    // scriveva, e qui nessuno li sapeva consegnare. Il destinatario è la RICEVUTA
    // della retention, non una seconda notifica: quella ai genitori parte già
    // sincrona nella richiesta che pubblica.
    it('`gallery.published` ha un destinatario: la ricevuta della retention', async () => {
        h.outboxClaim = { ok: true, eventi: [evento('gallery.published')] }
        h.senzaScadenzaPerIntent = 0

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({
            outbox_presi: 1,
            outbox_inviati: 1,
            outbox_senza_destinatario: 0,
        })
        const nomi = h.rpc.map((r) => r.nome)
        expect(nomi).toContain('video_outbox_sent')
        expect(nomi).not.toContain('video_outbox_fail')

        // La consegna È la ricevuta: la query di conteggio su `video_jobs`, con le
        // tre clausole che la rendono una verifica e non un «inviato» cieco.
        const ricevuta = h.query.find((q) => q.tabella === 'video_jobs' && q.colonne === 'id')
        expect(ricevuta, 'la ricevuta non è stata letta').toBeDefined()
        expect(ricevuta?.clausole).toEqual(
            expect.arrayContaining([
                { metodo: 'eq', argomenti: ['intent_id', INTENT] },
                { metodo: 'is', argomenti: ['original_delete_after', null] },
                { metodo: 'is', argomenti: ['original_deleted_at', null] },
            ]),
        )
    })

    it('`gallery.published` con job senza scadenza NON si dichiara inviato', async () => {
        // Un destinatario che rispondesse `{ consegnato: true }` senza leggere niente
        // passerebbe il caso precedente: questo no.
        h.outboxClaim = { ok: true, eventi: [evento('gallery.published')] }
        h.senzaScadenzaPerIntent = 1

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({
            outbox_presi: 1,
            outbox_inviati: 0,
            outbox_senza_destinatario: 0,
        })
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_sent')
        expect(h.rpc.find((r) => r.nome === 'video_outbox_fail')?.argomenti.p_error_code).toBe(
            'ORIGINALI_SENZA_SCADENZA',
        )
    })

    // ── LOCK DI FAMIGLIA: ogni tipo che qualcuno scrive in `video_outbox` ha un
    // destinatario. I tipi si raccolgono dal CODICE, non da un elenco scritto qui,
    // in TRE forme: (i) il letterale passato come `p_event_type:` in `src/`; (ii) il
    // letterale dentro `INSERT INTO [public.]video_outbox … VALUES (…)` nelle
    // migrazioni; (iii) il letterale passato come argomento a `video_intent_finalize(…)`
    // nelle migrazioni (dal 2026-10-02 l'unico scrittore di `gallery.published`: vedi
    // `scrittureDaMigrazioni`). Tutte le forme leggono il codice senza commenti: una
    // frase esplicativa che cita la forma (la route della retention lo fa) immunizzerebbe
    // il lock. Forma NON coperta: un tipo passato da una VARIABILE o da una costante
    // invece che da un letterale — chi la introduce aggiunga qui la quarta forma;
    // l'anti-cecità qui sotto diventa rossa appena lo scrittore di un tipo noto smette di
    // usare il letterale, perché pretende anche il FILE da cui il tipo arriva.
    it('il lock di famiglia vede i tre tipi noti, ciascuno dal suo scrittore (anti-cecità)', () => {
        expect(TIPI_SCRITTI_IN_OUTBOX).toEqual(
            expect.arrayContaining(['gallery.published', 'intent.revoked', 'intent.superseded']),
        )
        // `gallery.published`: dal 2026-10-02 `POST /api/gallery` non lo scrive più (il ramo
        // video è stato tolto), e lo scrive SOLO la RPC `video_galleria_pubblica`, cioè una
        // migrazione. Il nome del file non si cabla: la migrazione si rinomina all'istante vero
        // del rilascio. Si pretende invece che gli scrittori siano TUTTI migrazioni e che ce ne
        // sia almeno uno: un tipo con nessuno scrittore visibile esce dall'elenco, il test che lo
        // esercita non nasce più, e il lock resterebbe verde senza guardare niente.
        const scrittoriDiPubblicato = SCRITTURE_IN_OUTBOX.filter((s) => s.tipo === 'gallery.published').map(
            (s) => s.percorso,
        )
        expect(scrittoriDiPubblicato.length).toBeGreaterThan(0)
        expect(
            scrittoriDiPubblicato.every((p) => p.startsWith('supabase/migrations/')),
            `qualcosa in src/ scrive di nuovo \`gallery.published\`: ${scrittoriDiPubblicato.join(', ')}`,
        ).toBe(true)
        for (const tipo of ['intent.revoked', 'intent.superseded']) {
            const percorsi = SCRITTURE_IN_OUTBOX.filter((s) => s.tipo === tipo).map((s) => s.percorso)
            expect(percorsi.length).toBeGreaterThan(0)
            expect(percorsi.every((p) => p.startsWith('supabase/migrations/'))).toBe(true)
        }
    })

    it('la forma (iii) raccoglie il letterale passato a `video_intent_finalize`, e NON commenti, chiavi o tipi', () => {
        const scritture = scrittureDaMigrazioni([
            {
                percorso: 'finto/chiamata.sql',
                testo: [
                    'v_esito := public.video_intent_finalize(',
                    "  p_intent_id, p_owner_id, p_revision, p_scuola_id, 'gallery', v_media_id,",
                    "  'gallery.published',",
                    // Una chiave col punto DENTRO un argomento annidato non è un tipo di evento.
                    "  pg_catalog.jsonb_build_object('media_id', v_media_id, 'a.chiave', 1)",
                    ');',
                    // Un apice raddoppiato dentro un argomento non rompe la divisione.
                    "PERFORM public.video_intent_finalize(a, b, c, d, 'it''s', e, 'x.dopo_apice', f);",
                ].join('\n'),
            },
            {
                percorso: 'finto/commenti_definizione_e_grant.sql',
                testo: [
                    "-- v_x := public.video_intent_finalize(a, b, c, d, e, f, 'x.riga', g);",
                    "/* public.video_intent_finalize(a, b, c, d, e, f, 'x.blocco', g) */",
                    // La DEFINIZIONE e i `REVOKE`/`GRANT` hanno lo stesso nome davanti, ma dentro il
                    // gruppo ci sono nomi di parametro e tipi, e un valore di default senza punto.
                    "CREATE OR REPLACE FUNCTION public.video_intent_finalize(p_event_type text, p_payload jsonb DEFAULT '{}'::jsonb)",
                    'REVOKE ALL ON FUNCTION public.video_intent_finalize(uuid, uuid, integer, uuid, text, uuid, text, jsonb) FROM PUBLIC;',
                ].join('\n'),
            },
            {
                // La FORMA NON COPERTA, dichiarata: un tipo che arriva da una variabile non si vede.
                percorso: 'finto/variabile.sql',
                testo: 'PERFORM public.video_intent_finalize(a, b, c, d, e, f, v_tipo, g);',
            },
        ])
        expect(scritture).toEqual([
            { tipo: 'gallery.published', percorso: 'finto/chiamata.sql' },
            { tipo: 'x.dopo_apice', percorso: 'finto/chiamata.sql' },
        ])
    })

    it('la forma (iii) vede lo scrittore REALE di `gallery.published`, e senza il letterale diventa cieca (l’anti-cecità può diventare rossa)', () => {
        // La prova che la terza forma non è decorazione. CONTROLLO POSITIVO: sulle migrazioni vere,
        // la raccolta trova `gallery.published` dall'unico file che lo scrive. MUTAZIONE IN
        // MEMORIA: se in quel file il letterale diventasse una variabile — la forma non coperta —
        // la raccolta non lo vedrebbe più, e l'asserzione dell'anti-cecità qui sopra (che pretende
        // almeno uno scrittore) diventerebbe rossa invece di tacere.
        const scrittori = [
            ...new Set(SCRITTURE_IN_OUTBOX.filter((s) => s.tipo === 'gallery.published').map((s) => s.percorso)),
        ]
        expect(scrittori.length).toBeGreaterThan(0)
        const migrazioni = migrazioniSuDisco().filter((m) => scrittori.includes(m.percorso))
        expect(migrazioni).toHaveLength(scrittori.length)

        expect(scrittureDaMigrazioni(migrazioni).filter((s) => s.tipo === 'gallery.published')).not.toHaveLength(0)

        const cieche = migrazioni.map((m) => ({
            ...m,
            testo: m.testo.replace(/'gallery\.published'/g, 'v_tipo_evento'),
        }))
        expect(
            cieche.some((m, i) => m.testo !== migrazioni[i].testo),
            'la mutazione non ha cambiato niente: il letterale non c’era',
        ).toBe(true)
        expect(scrittureDaMigrazioni(cieche).filter((s) => s.tipo === 'gallery.published')).toHaveLength(0)
    })

    it('la forma (i) raccoglie il codice e NON i commenti che la citano', () => {
        const scritture = scrittureDaSorgenti([
            {
                percorso: 'finto/codice.ts',
                testo: [
                    "await supabase.rpc('video_outbox_enqueue', {",
                    "    p_event_type: 'a.codice',",
                    "    p_nota: 'http://non-e-un-commento', p_event_type: \"b.dopo_url\",",
                    '})',
                    'const re = /[\'"]/ // regex con un apice',
                    "rpc({ p_event_type: 'c.dopo_regex' })",
                ].join('\n'),
            },
            {
                percorso: 'finto/commenti.ts',
                testo: [
                    "// V08 (`p_event_type: 'x.riga'`)",
                    "const a = 1 // p_event_type: 'x.coda'",
                    '/**',
                    " * p_event_type: 'x.blocco'",
                    " p_event_type: 'x.blocco_senza_stella'",
                    ' */',
                    "const b = /* p_event_type: 'x.in_linea' */ 2",
                ].join('\n'),
            },
        ])
        expect(scritture).toEqual([
            { tipo: 'a.codice', percorso: 'finto/codice.ts' },
            { tipo: 'b.dopo_url', percorso: 'finto/codice.ts' },
            { tipo: 'c.dopo_regex', percorso: 'finto/codice.ts' },
        ])
    })

    it.each(TIPI_SCRITTI_IN_OUTBOX)(
        'il tipo `%s`, che qualcuno scrive in `video_outbox`, ha un destinatario',
        async (tipo) => {
            // 1. IL REGISTRO LO CONOSCE — vale per OGNI tipo, anche per quelli che consuma solo il runner
            //    (§8.1). Da quando la retention non prende più `gallery.auto_publish` questa è la forma che
            //    il lock ha per quel tipo, e NON si aggira: resta rosso finché la sua riga non c'è in
            //    `destinatari.ts` (T7), e torna verde da solo quando c'è. Un tipo scritto nella coda e che
            //    nessun consumatore sa consegnare è esattamente ciò che questo lock esiste per impedire.
            expect(
                destinatarioDi(DESTINATARI, tipo),
                `il tipo \`${tipo}\` viene scritto in video_outbox ma il registro dei destinatari non lo conosce: ` +
                    `nessun consumatore saprebbe consegnarlo. Aggiungi la sua riga in ` +
                    `src/lib/media/video/outbox/destinatari.ts.`,
            ).toBeDefined()

            // 2. Se è dei tipi della retention, la route lo consegna davvero (la prova di sempre). Quelli del
            //    runner non passano da qui per costruzione: la loro consegna la prova la suite del runner.
            if (TIPI_SOLO_DEL_RUNNER.includes(tipo)) return

            h.outboxClaim = { ok: true, eventi: [evento(tipo)] }
            h.senzaScadenzaPerIntent = 0

            const res = await POST(chiamata())
            const corpo = await res.json()
            // Prima una PRESENZA (l'evento è stato preso e chiuso), poi le assenze.
            expect(corpo).toMatchObject({ outbox_presi: 1 })
            expect(h.eventi.some((e) => e.campi.esito === 'outbox-svuotato')).toBe(true)
            expect(corpo.outbox_senza_destinatario).toBe(0)
            expect(
                h.rpc.filter(
                    (r) => r.nome === 'video_outbox_fail' && r.argomenti.p_error_code === 'DESTINATARIO_ASSENTE',
                ),
            ).toHaveLength(0)
            expect(h.eventi.some((e) => e.campi.esito === 'outbox-senza-destinatario')).toBe(false)
        },
    )

    it('la lease del claim è la STESSA che chiude l’evento, altrimenti il database rifiuta', async () => {
        h.outboxClaim = { ok: true, eventi: [evento('intent.superseded')] }
        await POST(chiamata())

        const claim = h.rpc.find((r) => r.nome === 'video_outbox_claim')
        const sent = h.rpc.find((r) => r.nome === 'video_outbox_sent')
        expect(sent?.argomenti.p_lease_owner).toBe(claim?.argomenti.p_lease_owner)
        expect(typeof claim?.argomenti.p_lease_owner).toBe('string')
    })

    it('lo svuotamento logga anche il SUCCESSO, e a zero: «nessun log» non è «coda vuota»', async () => {
        await POST(chiamata())
        const riga = h.eventi.find((e) => e.campi.esito === 'outbox-svuotato')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi.n_righe).toBe(0)
    })
})

describe('la riconciliazione: i due numeri che devono valere zero', () => {
    it('la quarantena dell’outbox si grida: nessuno riprenderà più quegli eventi', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 4 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'outbox-in-quarantena')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.n_righe).toBe(4)
    })

    it('invisibili RESIDUI dopo la rete: il tetto del lotto non basta, e si dice', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 7, outbox_in_quarantena: 0 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'invisibili-residui')
        expect(grido?.livello).toBe('error')
    })

    it('i sei conteggi nuovi della riconciliazione finiscono NEL BATTITO, non solo nella risposta', async () => {
        // La risposta la legge chi lancia il giro a mano; il battito resta interrogabile in SQL per
        // trenta giorni, ed è l'unico posto da cui si può sapere se le uscite scendono, se gli arrivi
        // mancano e se le pubblicazioni aspettano. Il «buco dichiarato» del 18/09 (uscite senza termine) è
        // chiuso: il suo contatore (`n_output_di_job_conclusi`, che contava le righe e non il peso morto)
        // non c'è più, e al suo posto ci sono i numeri che dicono se la conservazione lavora.
        h.riconciliazione = {
            ok: true,
            conclusi_senza_scadenza: 0,
            outbox_in_quarantena: 0,
            output_di_job_conclusi: 12,
            uscite_da_togliere: 4,
            uscite_senza_scadenza: 2,
            pubblicazioni_in_attesa: 5,
            esiti_da_notificare: 1,
            arrivi_mancati: 3,
            flusso_vecchio_in_volo: 7,
            outbox_in_ritardo: 0,
        }
        await POST(chiamata())

        expect(battito()[0].campi).toMatchObject({
            n_uscite_da_togliere: 4,
            n_uscite_senza_scadenza: 2,
            n_pubblicazioni_in_attesa: 5,
            n_esiti_da_notificare: 1,
            n_arrivi_mancati: 3,
            n_flusso_vecchio_in_volo: 7,
            n_outbox_in_ritardo: 0,
        })
        expect('n_output_di_job_conclusi' in battito()[0].campi).toBe(false)
    })

    it('`arrivi_mancati` NULL resta NULL nel battito: «non so» non è zero (#81)', async () => {
        // Il conteggio legge `storage.objects`, uno schema gestito: se il proprietario della funzione non
        // lo può leggere risponde NULL, e la rete degli arrivi non vede niente. Un `0` direbbe «nessun
        // arrivo mancato» a chi sorveglia una rete cieca.
        h.riconciliazione = {
            ok: true,
            conclusi_senza_scadenza: 0,
            outbox_in_quarantena: 0,
            arrivi_mancati: null,
            uscite_da_togliere: 0,
        }
        await POST(chiamata())

        const campi = battito()[0].campi
        expect(campi.n_arrivi_mancati).toBeNull()
        // Un zero VERO resta zero: i due casi non si confondono nemmeno nell'altro verso.
        expect(campi.n_uscite_da_togliere).toBe(0)
    })

    it('se la riconciliazione NON gira i conteggi sono NULL, non zero: il battito non inventa misure', async () => {
        h.erroreRiconciliazione = { code: '57014', message: 'canceled' }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        const campi = battito()[0].campi
        for (const chiave of [
            'n_uscite_da_togliere',
            'n_uscite_senza_scadenza',
            'n_pubblicazioni_in_attesa',
            'n_esiti_da_notificare',
            'n_arrivi_mancati',
            'n_flusso_vecchio_in_volo',
            'n_outbox_in_ritardo',
        ]) {
            expect(campi[chiave], chiave).toBeNull()
        }
        expect(h.eventi.find((e) => e.campi.esito === 'riconciliazione-fallita')?.livello).toBe('error')
    })

    it('`uscite_senza_scadenza` della riconciliazione NON è un guasto: nessuna riga di errore, nemmeno se vale più di zero', async () => {
        // Dopo il giro deve tendere a zero, ma con più di un lotto di arretrato vale di più per un po':
        // è il lavoro che aspetta, non un cammino che si è dimenticato di dare la scadenza.
        h.riconciliazione = {
            ok: true,
            conclusi_senza_scadenza: 0,
            outbox_in_quarantena: 0,
            uscite_senza_scadenza: 250,
            uscite_da_togliere: 250,
        }
        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(h.eventi.filter((e) => e.livello === 'error')).toEqual([])
        expect(battito()[0].campi).toMatchObject({ esito: 'ok', n_uscite_senza_scadenza: 250 })
    })

    it('i conteggi tornano nella risposta: chi lancia il giro a mano deve poterli leggere', async () => {
        h.riconciliazione = { ok: true, in_coda: 9, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0 }
        const res = await POST(chiamata())
        expect((await res.json()).riconciliazione).toMatchObject({ in_coda: 9 })
    })
})

describe('il battito, e cosa NON esce dai log', () => {
    it('si scrive SEMPRE, anche a zero righe, con `evento: cron` e `esito: ok`', async () => {
        await POST(chiamata())
        const b = battito()
        expect(b).toHaveLength(1)
        expect(b[0].campi).toMatchObject({ operazione: 'video-retention', esito: 'ok', canale: 'cron' })
        expect(b[0].campi.n_originali_rimossi).toBe(0)
    })

    it('si scrive anche quando TUTTO è fallito, perché sta in un `finally`', async () => {
        h.erroreScaduti = { code: '57014', message: 'canceled' }
        await POST(chiamata())
        expect(battito()[0].campi.esito).toBe('lettura-fallita')
    })

    /**
     * ⚠️ QUESTA PROVA VALE QUANTO I RAMI CHE ATTRAVERSA, e la prima stesura ne
     * attraversava troppo pochi.
     *
     * Misurato il 2026-09-18 su questo stesso file: infilando `original_path` nel
     * `msg` del `catch` finale della route, le 33 prove restavano **tutte verdi** —
     * nessuna faceva lanciare niente, quindi quel `logEvento` non veniva mai
     * eseguito e il percorso di un video di un minore sarebbe finito in `app_log`
     * col gate verde. È la forma di difetto che questo repo chiama «un test mai
     * visto fallire non è un test».
     *
     * Perciò i rami si elencano e si percorrono tutti: il percorso felice, il
     * trattenimento, l'orfano non rimosso, e l'eccezione. `it.each` con un fixture
     * per ramo, così aggiungerne uno è una riga e dimenticarsene è visibile.
     */
    const RAMI: { nome: string; prepara: () => void }[] = [
        {
            nome: 'percorso felice (tutto esce, e c’è un orfano)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.albero = {
                    '': [{ name: 'orfano-di-un-bambino.mov', id: 'o1', created_at: VECCHIO }],
                }
                h.outboxClaim = {
                    ok: true,
                    eventi: [
                        { id: 'e1', intent_id: INTENT, revision: 1, event_type: 'x.y', attempts: 1 },
                    ],
                }
            },
        },
        {
            nome: 'riga trattenuta (il file è ancora nel bucket)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.removeRisposta = { data: [], error: null }
                h.ancoraNelBucket = new Set([PATH_A])
            },
        },
        {
            nome: 'orfano che non esce dall’archivio',
            prepara: () => {
                h.albero = {
                    '': [{ name: 'orfano-di-un-bambino.mov', id: 'o1', created_at: VECCHIO }],
                }
                h.removeRisposta = { data: [], error: null }
                h.ancoraNelBucket = new Set(['orfano-di-un-bambino.mov'])
            },
        },
        {
            nome: 'eccezione non prevista (il `catch` finale)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.eccezioneTimbro = new Error('la RPC è esplosa')
            },
        },
        {
            nome: 'uscite: rimossa, trattenuta, orfana e risorta (video_processing)',
            prepara: () => {
                h.usciteScadute = [
                    { id: JOB_C, output_path: USCITA_C },
                    { id: JOB_D, output_path: USCITA_D },
                ]
                h.removeRispostaUscite = { data: [{ name: USCITA_D }], error: null }
                h.ancoraNelBucket = new Set([USCITA_C])
                h.alberoUscite = {
                    '': [
                        { name: 'orfana-di-un-bambino.mp4', id: 'u1', created_at: VECCHIO },
                        { name: 'risorta-di-un-bambino.mp4', id: 'u2', created_at: VECCHIO },
                    ],
                }
                h.reclamatiUscite = ['risorta-di-un-bambino.mp4']
                h.risorteUscite = ['risorta-di-un-bambino.mp4']
            },
        },
        {
            nome: 'originale risorto (la riga lo dichiara già tolto)',
            prepara: () => {
                h.albero = { '': [{ name: 'risorto-di-un-bambino.mov', id: 'o1', created_at: VECCHIO }] }
                h.reclamati = ['risorto-di-un-bambino.mov']
                h.risorti = ['risorto-di-un-bambino.mov']
            },
        },
        {
            nome: 'eccezione sul timbro di un’uscita (il `catch` finale)',
            prepara: () => {
                h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
                h.eccezioneTimbroUscita = new Error('la RPC delle uscite è esplosa')
            },
        },
        // I quattro rami che dicono «il file è uscito e la riga no» — misurato il 2026-10-02 mutando la route:
        // un percorso infilato nel `msg` di questi log lasciava tutte le prove verdi, perché nessuna le faceva
        // passare di qui. Sono i log che portano `job_id` e stanno accanto al percorso nel codice.
        {
            nome: 'timbro di un originale che non risponde (`timbro-fallito`)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.erroreTimbro = { code: '57014', message: 'canceled' }
            },
        },
        {
            nome: 'timbro di un originale rifiutato (`timbro-rifiutato`)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.timbro = { ok: false, code: 'NON_ANCORA_SCADUTO' }
            },
        },
        {
            nome: 'timbro di un’uscita che non risponde (`uscita-timbro-fallito`)',
            prepara: () => {
                h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
                h.erroreTimbroUscita = { code: '57014', message: 'canceled' }
            },
        },
        {
            nome: 'timbro di un’uscita rifiutato (`uscita-timbro-rifiutato`)',
            prepara: () => {
                h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
                h.timbroUscita = { ok: false, code: 'NON_ANCORA_SCADUTO' }
            },
        },
    ]

    it.each(RAMI)(
        'NESSUN percorso e NESSUN nome di file finisce in un log — ramo: $nome',
        async ({ prepara }) => {
            // Il percorso dentro `video_originals` è la chiave con cui si firma il
            // video di un bambino in un bucket privato: è una credenziale. `app_log`
            // è interrogabile in SQL per trenta giorni.
            prepara()
            await POST(chiamata()).catch(() => {
                // Il ramo dell'eccezione RILANCIA di proposito, perché `withRoute`
                // veda il guasto. Qui interessa solo ciò che è finito nei log, e
                // ingoiare l'eccezione dopo averlo dichiarato non nasconde niente:
                // le asserzioni sono tutte sotto.
            })

            expect(h.eventi.length, 'nessun log emesso: questo ramo non prova niente').toBeGreaterThan(0)
            const testo = JSON.stringify(h.eventi)
            expect(testo).not.toContain(PATH_A)
            expect(testo).not.toContain('source.mov')
            expect(testo).not.toContain('orfano-di-un-bambino')
            // Lo stesso per le USCITE: il percorso dentro `video_processing` è la chiave con cui si firma il
            // video convertito di un bambino, e `<chi carica>/<job>/<tentativo>.mp4` non esce mai.
            expect(testo).not.toContain(USCITA_C)
            expect(testo).not.toContain(USCITA_D)
            expect(testo).not.toContain('.mp4')
            expect(testo).not.toContain('orfana-di-un-bambino')
            expect(testo).not.toContain('risorta-di-un-bambino')
            expect(testo).not.toContain('risorto-di-un-bambino')
        },
    )
})

describe('il punto d’aggancio della scansione degli esiti di conversione (§8.5, T7)', () => {
    // La scansione è dell'altra consegna della PR (`src/lib/media/video/esiti.ts`): qui c'è solo il POSTO in
    // cui si collega, dichiarato in `scansionaEsitiConversione`. Queste prove fissano il valore «non
    // collegata» apposta: chi collega la libreria DEVE cambiarle, e cambiandole prova il collegamento invece
    // di dimenticarsene — un passo che tutti credono attivo e non lo è mai stato è esattamente ciò che la
    // spec vuole evitare per gli esiti (un video fallito che nessuno notifica).

    it('la risposta e il battito dichiarano `non-collegata`: nessuno può credere che gli esiti si notifichino', async () => {
        const res = await POST(chiamata())

        expect(await res.json()).toMatchObject({ ok: true, esiti_esito: 'non-collegata', esiti_notificati: 0 })
        // Nel battito un booleano: la redazione dei log è a lista bianca e una stringa sotto una chiave
        // fuori elenco uscirebbe come «[redatto:str/13]».
        expect(battito()[0].campi).toMatchObject({ esiti_collegata: false, n_esiti_notificati: 0 })
        expect('esiti_esito' in battito()[0].campi).toBe(false)
    })

    it('finché non è collegata non fa NIENTE: nessuna RPC e nessuna query oltre a quelle degli altri passi', async () => {
        await POST(chiamata())

        // Le RPC del giro, e basta: la scansione non ne aggiunge una (marcare un esito è una RPC, e farlo
        // dal punto d'aggancio vuoto sarebbe implementarla senza la libreria).
        expect(h.rpc.map((r) => r.nome)).toEqual([
            'video_galleria_flusso_vecchio_revoca',
            'video_intent_scadi_non_pubblicato',
            'video_retention_scadenze',
            'video_intenti_minimizza',
            'video_outbox_claim',
            'video_riconciliazione',
        ])
        // E nessun log suo: a ogni giro, ogni dieci minuti, sarebbe rumore.
        expect(h.eventi.some((e) => String(e.campi.esito).startsWith('esiti-'))).toBe(false)
    })

    it('`esiti_da_notificare` della riconciliazione è il segnale che nessuno li notifica: sta nel battito', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0, esiti_da_notificare: 2 }
        await POST(chiamata())

        expect(battito()[0].campi).toMatchObject({ esiti_collegata: false, n_esiti_da_notificare: 2 })
    })
})

describe('il giro, in ordine (testata del file C, §15)', () => {
    it('flusso vecchio → non pubblicati → scadenze → originali → uscite → orfani → minimizzazione → coda → riconciliazione', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.usciteScadute = [{ id: JOB_C, output_path: USCITA_C }]
        h.albero = { '': [{ name: 'orfano.mov', id: 'o1', created_at: VECCHIO }] }
        h.alberoUscite = { '': [{ name: 'orfana.mp4', id: 'u1', created_at: VECCHIO }] }

        await POST(chiamata())

        // Ogni passo con la sua firma, e con il magazzino quando c'è: l'ordine DEI PASSI è la cosa da provare.
        const passi = h.sequenza.map((s) => (s.bucket ? `${s.tipo}:${s.bucket}` : s.tipo))
        expect(passi).toEqual([
            'rpc:video_galleria_flusso_vecchio_revoca',
            'rpc:video_intent_scadi_non_pubblicato',
            'rpc:video_retention_scadenze',
            'leggi-scaduti',
            `remove:${BUCKET_ORIGINALI}`,
            'rpc:video_retention_originale_rimosso',
            'leggi-uscite-scadute',
            `remove:${BUCKET_USCITE}`,
            'rpc:video_retention_uscita_rimossa',
            `remove:${BUCKET_ORIGINALI}`,
            `remove:${BUCKET_USCITE}`,
            'rpc:video_intenti_minimizza',
            'rpc:video_outbox_claim',
            'rpc:video_riconciliazione',
        ])
    })

    it('un giro sano risponde 200 con TUTTI i contatori (nuovi e vecchi), e il battito è `ok`', async () => {
        const res = await POST(chiamata())
        const corpo = await res.json()

        expect(res.status).toBe(200)
        expect(corpo).toMatchObject({
            ok: true,
            giorni_ttl: 7,
            giorni_convertito_non_pubblicato: 7,
            flusso_vecchio_revocati: 0,
            non_pubblicati_scaduti: 0,
            uscite_dichiarate: 0,
            originali_scaduti: 0,
            uscite_scadute: 0,
            uscite_rimosse: 0,
            uscite_trattenute: 0,
            orfani_uscite_esito: 'ok',
            intenti_minimizzati: 0,
            outbox_esito: 'ok',
            esiti_esito: 'non-collegata',
        })
        expect(battito()[0].campi.esito).toBe('ok')
    })
})
