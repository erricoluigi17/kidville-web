import type { SupabaseClient } from '@supabase/supabase-js'
import { conTettoDiTempo } from '@/lib/auth/errore-accesso'

/**
 * I CONTROLLI DI SALUTE — la parte che MISURA. La route (`/api/health`) fa solo da porta.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * PERCHÉ ESISTE, DETTO UNA VOLTA E SENZA GIRI DI PAROLE
 *
 * Fino al 2026-08-04 in produzione l'unico rilevatore di guasti era la telefonata di un
 * genitore. Non è un modo di dire: `app_log` registra tutto, ma nessuno la interroga da
 * solo, e i cinque cron girano in fire-and-forget dentro un `EXCEPTION WHEN OTHERS THEN
 * null` — un job che smette di partire non lascia NESSUNA traccia, perché ciò che non
 * parte non logga.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * UN 200 FISSO NON È UN RILEVATORE
 *
 * `export const GET = () => Response.json({ ok: true })` è un file statico con un
 * content-type. Risponde 200 con il database irraggiungibile, con lo schema a metà
 * migrazione e con tutti i cron fermi da tre giorni. Un monitor puntato su un endpoint
 * così misura una cosa sola: che Vercel sa servire una funzione — che è precisamente
 * l'unica cosa che non si è mai rotta.
 *
 * Da qui la regola costruttiva di questo modulo: **ogni controllo deve poter dire di NO**,
 * e per ognuno esiste un test che lo forza a dirlo.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * LE CINQUE MISURE, E COSA VEDE CIASCUNA CHE LE ALTRE NON VEDONO
 *
 *  1. `db-lettura`   — il database risponde e il service role legge davvero.
 *  2. `schema-atteso`— le tabelle che il codice usa SENZA tollerarne l'assenza ci sono.
 *  3. `cron-battito` — ogni job critico ha lasciato un «ok» dentro la sua finestra.
 *  4. `tasso-errore` — quante impronte d'errore distinte sono ATTIVE adesso.
 *  5. `config`       — le variabili la cui assenza produce un guasto silenzioso.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NESSUN DATO PERSONALE, E LA TENSIONE CON LA REGOLA 3 DI AGENTS.md
 *
 * Questa rotta è PUBBLICA (un monitor esterno non ha sessione). Il suo corpo di risposta
 * quindi non porta MAI il `message` di un errore PostgREST: porta il `code` e basta. Un
 * messaggio di Postgres può contenere il VALORE che ha violato un vincolo — cioè, su
 * questo database, il codice fiscale di un minore — e su un endpoint pubblico quel
 * valore sarebbe leggibile da chiunque.
 *
 * Questo NON viola «il corpo dell'errore di un provider non si butta mai via» (AGENTS,
 * regola 3): il corpo intero va nel LOG, dove la redazione a lista bianca lo protegge e
 * dove lo legge solo chi ha accesso al database. Le due destinazioni hanno due pubblici
 * diversi, e solo una delle due è il mondo. Nel corpo HTTP escono soltanto: nomi di
 * controllo, nomi di job, nomi di tabella, nomi di variabile d'ambiente (mai i valori),
 * codici d'errore, booleani e millisecondi.
 * ════════════════════════════════════════════════════════════════════════════════
 */

const MIN = 60_000
const ORA = 60 * MIN

/** Esito di un singolo controllo. `giu` è l'unico che porta il servizio a 503. */
export type EsitoControllo = 'ok' | 'degradato' | 'giu'

/** Stato complessivo. I nomi sono in inglese perché li legge un monitor, non un umano. */
export type StatoSalute = 'ok' | 'degraded' | 'down'

export interface Controllo {
    nome: string
    esito: EsitoControllo
    /** Durata della misura. Un controllo lento è già un segnale, anche quando è `ok`. */
    ms: number
    /** Solo dati non personali: nomi, codici, numeri. Vedi la testata. */
    dettaglio?: string
}

export interface Salute {
    stato: StatoSalute
    ms: number
    controlli: Controllo[]
}

/**
 * IL TETTO DI TEMPO, che è la ragione per cui questo endpoint non può appendersi.
 *
 * Un health-check che si blocca è PEGGIO di nessun health-check: il monitor va in timeout,
 * segnala «giù» un'applicazione che sta servendo i genitori benissimo, e chi riceve la
 * chiamata impara a ignorarla. Ogni controllo ha quindi il suo tetto, e allo scadere non
 * aspetta: dichiara il proprio esito e va avanti.
 */
export const TETTO_CONTROLLO_MS = 2_000

/**
 * LE TABELLE DI CUI IL CODICE NON TOLLERA L'ASSENZA.
 *
 * Non è l'elenco di tutte le tabelle: è l'elenco di quelle che le route leggono senza
 * un ramo di degradazione. Dove il codice gestisce `PGRST205`/`42703` e degrada pulito
 * (è il caso del DB E2E della CI, non migrato) l'assenza non è un incidente e non va qui.
 *
 * È il controllo che avrebbe gridato IL GIORNO della migrazione mancante invece che tre
 * settimane dopo — e verificato in produzione il 2026-08-04: tutte e cinque presenti.
 */
export const TABELLE_ATTESE = ['utenti', 'alunni', 'avvisi', 'notifiche', 'pagamenti'] as const

/**
 * PERCHÉ NON `to_regclass()`, che sarebbe la via ovvia.
 *
 * `to_regclass()` è SQL: da PostgREST si raggiunge solo con una funzione RPC, che non
 * esiste e che richiederebbe una migrazione — cioè un endpoint di salute che nasce rotto
 * e resta rotto finché qualcuno non applica la migrazione, il che è un modo notevole di
 * fallire proprio nel compito di accorgersi che qualcosa non è stato applicato.
 *
 * La sonda `select(head)` è però anche PIÙ FORTE, e questa è la vera ragione: misura la
 * vista che l'APPLICAZIONE ha dello schema, non quella che ha il superuser. Una tabella
 * che esiste ma non è esposta, o che c'è nel catalogo ma non nella schema cache di
 * PostgREST, per il codice di questo repo NON esiste — risponde `PGRST205`, che è
 * esattamente ciò che produce una migrazione mancante. `to_regclass()` la direbbe
 * presente e il controllo sarebbe verde mentre l'app è rotta: un controllo che mente.
 *
 * `head: true` non trasporta righe: si misura l'esistenza, non il contenuto. Su un
 * database con 152 codici fiscali di minori la differenza non è di prestazioni.
 */
const CODICI_TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

export interface JobCron {
    /** Il valore di `contesto->campi->>operazione` in `app_log` — la costante `JOB` della route. */
    nome: string
    /** Ampiezza della finestra oltre la quale il silenzio è un guasto. */
    finestraMs: number
}

/**
 * I JOB SORVEGLIATI, e da dove vengono i numeri.
 *
 * MISURATO il 2026-08-04 su `cron.job` in produzione (schedule) e su `app_log` (che i
 * battiti arrivino davvero, con quale `esito` e con quale frequenza). Nessuno di questi
 * numeri è stato dedotto dal codice: la schedulazione vive nel database, non nel repo.
 *
 *   job                   cron.job (jobname)          cadenza      finestra
 *   push-dispatch         notifiche-dispatch  ogni 5 min       20 min
 *   news-cron             news-tick           ogni 10 min      40 min
 *   fattura-sync          fatture-sdi-sync    ogni 30 min      2 h
 *   notifiche-promemoria  notifiche-promemoria  0 6 ogni gg    26 h
 *   pagamenti-solleciti   pagamenti-solleciti-run  0 6 ogni gg 26 h
 *   mensa-allergie-check  mensa-check-allergie  0 7 ogni gg    26 h
 *
 * La finestra è ~3-4 volte la cadenza per i job frequenti e cadenza+2h per i giornalieri:
 * deve assorbire un giro saltato senza gridare, e non due. Un allarme che scatta al primo
 * ritardo viene disattivato entro una settimana, e allora non protegge più niente.
 *
 * CHI RESTA FUORI, E PERCHÉ, non è più un commento: è `JOB_CRON_NON_SORVEGLIATI`, qui sotto.
 */
export const JOB_CRON: readonly JobCron[] = [
    { nome: 'push-dispatch', finestraMs: 20 * MIN },
    { nome: 'news-cron', finestraMs: 40 * MIN },
    { nome: 'fattura-sync', finestraMs: 2 * ORA },
    { nome: 'notifiche-promemoria', finestraMs: 26 * ORA },
    { nome: 'pagamenti-solleciti', finestraMs: 26 * ORA },
    { nome: 'mensa-allergie-check', finestraMs: 26 * ORA },
    // `presenze-giustificazioni-retention` (`59 4 * * *`, OGNI NOTTE): fa scadere il motivo
    // dell'assenza, che è un dato sanitario di un minore, e l'informativa promette alle
    // famiglie che quella cancellazione è automatica. Una promessa mantenuta da un lavoro che
    // nessuno guarda è una promessa a scadenza. 26 h come gli altri giornalieri.
    { nome: 'presenze-giustificazioni-retention', finestraMs: 26 * ORA },
    // `candidature-retention` (`POST /api/gdpr/retention-candidature`): fa scadere la
    // candidatura spontanea di una persona adulta e il CURRICULUM che ha allegato.
    //
    // ⚠️ DEV'ESSERE SCHEDULATO GIORNALIERO, e la ragione non è di gusto: `app_log`
    // conserva 30 giorni, quindi un lavoro MENSILE non è sorvegliabile da qui — è
    // esattamente perché il gemello `iscrizioni-retention` gira il primo del mese che
    // sta in `JOB_CRON_NON_SORVEGLIATI` invece che qui. Con la cadenza giornaliera la
    // finestra è 26 h come gli altri: assorbe un giro saltato, non due.
    //
    // A differenza del gemello, il battito di questo lavoro dichiara `esito: 'ok'`
    // (lo scrive `logEvento` da una route, non un `jsonb_build_object` da SQL), quindi
    // `controlloBattitoCron` lo conta davvero.
    { nome: 'candidature-retention', finestraMs: 26 * ORA },
]

/**
 * I JOB CHE NON SI POSSONO SORVEGLIARE DA QUI — dichiarati, con la ragione.
 *
 * Era un commento, ed è diventato una costante il 2026-08-08 (rilievo Q3) per una ragione
 * pratica: un lock deve poter distinguere «questo job è stato lasciato fuori apposta» da
 * «questo job se lo sono dimenticato». Un commento non lo consente, e i due job di retention
 * introdotti dal ciclo erano finiti esattamente lì in mezzo — non comparivano né fra i vivi né
 * fra i muti di `/api/health`: invisibili.
 *
 * ⚠️ IL MOTIVO PER CUI UN MENSILE NON SI PUÒ SORVEGLIARE QUI È MISURATO, non stilistico.
 * `app_log` conserva **30 giorni** (`app_log_purge`, `creato_il < now() - interval '30 days'`),
 * e un job mensile richiederebbe una finestra di ~32. In un mese di 31 giorni il battito del
 * giorno 1 viene cancellato dalla purge il giorno 31 alle 3:30, e il successivo arriva il
 * giorno 1 alle 4:35: per **25 ore ogni mese** `/api/health` direbbe «degradato» su un lavoro
 * che gira perfettamente. Un allarme che suona da solo viene spento, e allora non protegge più
 * niente — che è la frase già scritta in testa a questo modulo.
 *
 * Questi job si seguono con una query su `app_log` (il battito c'è e si legge), non con un
 * endpoint interrogato ogni minuto.
 */
export const JOB_CRON_NON_SORVEGLIATI: readonly { nome: string; perche: string }[] = [
    {
        nome: 'notifiche-retention',
        perche:
            'MENSILE (`35 4 1 * *`): la finestra necessaria (~32 giorni) supera la conservazione ' +
            'di app_log (30 giorni), quindi il battito precedente sparisce prima che arrivi il ' +
            'successivo e l’allarme suonerebbe ogni mese su un lavoro sano.',
    },
    {
        nome: 'iscrizioni-retention',
        perche:
            'MENSILE (`41 4 1 * *`), stessa ragione del gemello; e il suo battito non dichiara ' +
            '`esito: ok`. Si segue con una query su app_log.',
    },
    {
        nome: 'app-log-purge',
        perche:
            'Job di sola SQL, non passa da una route HTTP: qui sarebbe sempre rosso. Vale anche ' +
            'per consensi-retention, audit-docente-retention e app-log-bonifica-pii.',
    },
]

/** La finestra più larga: quanto indietro serve leggere `app_log` per coprirle tutte. */
const FINESTRA_BATTITO_MAX = Math.max(...JOB_CRON.map((j) => j.finestraMs))

export const FINESTRA_ERRORI_MS = 15 * MIN

/**
 * LA SOGLIA D'ERRORE, e perché è un conteggio di IMPRONTE e non di errori.
 *
 * `app_log` DEDUPLICA per (fingerprint, giorno): mille occorrenze dello stesso errore
 * sono UNA riga con `occorrenze = 1000`, e `creato_il` è la prima della giornata. Contare
 * «gli errori degli ultimi 15 minuti» sommando `occorrenze` è quindi una misura falsa —
 * attribuisce all'alba di oggi tutto ciò che è successo fino ad ora. Ciò che lo storage
 * sostiene davvero è: **quante impronte d'errore DISTINTE sono state viste per l'ultima
 * volta dentro la finestra**, cioè quanti tipi di guasto sono attivi adesso.
 *
 * MISURATO in produzione il 2026-08-04, ultimi 7 giorni (672 finestre da 15 minuti):
 * solo 40 finestre hanno avuto un errore attivo; massimo 4 impronte, p99 = 4, media 2.
 * La soglia è quindi 5, cioè sopra il massimo osservato in una settimana: sotto, sarebbe
 * un allarme che suona da solo; molto sopra, un allarme che non suona mai.
 */
export const SOGLIA_IMPRONTE_ERRORE = 5

/**
 * LE VARIABILI CRITICHE — copia NOMINALE della lista di `src/instrumentation.ts`.
 *
 * La duplicazione è deliberata e sorvegliata: `variabiliCritiche()` non è esportata da
 * `instrumentation.ts` (è codice che il bundler deve poter eliminare dal bundle Edge, e
 * un export lo tratterrebbe), e importarla da qui trascinerebbe l'instrumentation dentro
 * una route. Contro la deriva c'è un lock in `__tests__/api/health.test.ts` che rilegge il
 * sorgente di `instrumentation.ts` e pretende che i due elenchi coincidano.
 *
 * Sono le variabili la cui assenza NON rompe niente subito — ed è tutto il punto: una
 * `RESEND_API_KEY` mancante non fa cadere l'app, fa solo sì che nessuna email parta più,
 * che è il guasto storico di questo progetto.
 *
 * SI LEGGE SE CI SONO, MAI QUANTO VALGONO. Nel corpo della risposta esce il NOME della
 * variabile assente, mai il valore di nessuna: un endpoint pubblico che stampasse anche
 * solo un prefisso di `SUPABASE_SERVICE_ROLE_KEY` sarebbe una consegna di chiavi.
 */
export const VARIABILI_CRITICHE = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'RESEND_API_KEY',
    'OTP_FROM_EMAIL',
    'CRON_SECRET',
    'LOG_HASH_SALT',
] as const

/* ════════════════════════════════════════════════════════════════════════════
 * Utilità
 * ════════════════════════════════════════════════════════════════════════════ */

/** Il solo `code` di un errore PostgREST. Il `message` NON esce da qui: vedi la testata. */
function codiceDi(err: unknown): string {
    try {
        const c = (err as { code?: unknown } | null)?.code
        if (typeof c === 'string' && c !== '') return c
        if (err instanceof Error && err.name !== '') return err.name
    } catch {
        // Un getter ostile su un oggetto d'errore non deve poter rompere l'health-check.
    }
    return 'sconosciuto'
}

/**
 * Esegue una misura con il suo tetto di tempo.
 *
 * ─── PERCHÉ UN ABBANDONO E NON UN `AbortSignal` ─────────────────────────────
 * Allo scadere si vuole una RISPOSTA, e la query che continua a girare in sottofondo è un
 * costo accettabile: è una lettura, e muore da sola quando la funzione termina. Aspettare
 * l'abort reintrodurrebbe esattamente l'attesa che il tetto esiste per evitare — e su un
 * health-check quell'attesa è il guasto: un endpoint di salute che si blocca fa scattare
 * il timeout del monitor, cioè dice «giù» per la ragione sbagliata.
 *
 * ─── PERCHÉ NON C'È UNA `Promise.race` QUI DENTRO ───────────────────────────
 * Il meccanismo è quello, ma la primitiva ESISTE GIÀ: `conTettoDiTempo` in
 * `@/lib/auth/errore-accesso`, scritta per il budget della sequenza di accesso. Fa
 * esattamente questo mestiere — abbandona invece di annullare — e con due accortezze che
 * riscrivendola a mano si perdono: incarta il valore (perché `T` può legittimamente essere
 * `null`, e senza incarto «ha risposto» e «è scaduto» sarebbero indistinguibili) e lascia
 * passare il rifiuto invece di inghiottirlo.
 *
 * La prima stesura di questo file la riscriveva. Il lock `__tests__/lib/logging-tetto.test.ts`
 * l'ha vista — «una corsa contro un timer in un file che non dichiara di essere una
 * primitiva di tetto» — ed è servito: la scelta giusta non era dichiarare la terza
 * primitiva, era usare la seconda. In questo repo una regola valida per due strade deve
 * vivere in un posto solo, ed è una lezione già pagata.
 *
 * Il modulo che la ospita si chiama `auth/errore-accesso` e da qui l'import si legge male:
 * è il posto dove la funzione è nata, non il suo perimetro. Spostarla in un modulo neutro
 * è la cosa giusta da fare, ma tocca la schermata di login e i suoi test, e non si fa nello
 * stesso lavoro in cui nasce un endpoint di salute.
 *
 * `fn()` non può rigettare fuori di qui: un rejection non gestito sarebbe un guasto del
 * processo causato dal codice che sorveglia i guasti. Si cattura prima della corsa, e
 * l'eccezione produce lo stesso esito della scadenza.
 */
async function misura(
    nome: string,
    esitoSuGuasto: EsitoControllo,
    fn: () => Promise<Pick<Controllo, 'esito' | 'dettaglio'>>,
    tettoMs: number = TETTO_CONTROLLO_MS,
): Promise<Controllo> {
    const t0 = Date.now()

    const lavoro = fn().catch((err: unknown) => ({
        esito: esitoSuGuasto,
        dettaglio: `eccezione ${codiceDi(err)}`,
    }))

    const esito = await conTettoDiTempo(lavoro, tettoMs)
    if (esito.scaduto) {
        return {
            nome,
            esito: esitoSuGuasto,
            dettaglio: `oltre il tetto di ${tettoMs} ms`,
            ms: Date.now() - t0,
        }
    }
    return { nome, ...esito.valore, ms: Date.now() - t0 }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. Il database risponde e il service role legge davvero
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * NON un `select 1`. Un `select 1` non tocca nessuna tabella, non passa da nessuna
 * policy e resta verde con la schema cache di PostgREST stantia: dice che c'è una
 * connessione TCP, che è la parte che non si rompe quasi mai.
 *
 * Si percorre invece la strada del codice vero: una lettura su `utenti` (la tabella da
 * cui passa ogni gate di ruolo) e una su `app_log` (il sink senza cui l'osservabilità
 * intera è cieca). Se una delle due non è leggibile, il servizio è GIÙ — non degradato:
 * senza `utenti` nessuno può nemmeno entrare.
 *
 * Le righe lette non escono e non si loggano: si guarda `error`, si conta, si butta.
 */
async function controlloDbLettura(supabase: SupabaseClient): Promise<Controllo> {
    return misura('db-lettura', 'giu', async () => {
        const rotte: string[] = []
        for (const tabella of ['utenti', 'app_log']) {
            // PostgREST NON lancia: ritorna `{ data, error }` (AGENTS, regola 7). Un
            // `try/catch` attorno a questa riga non scatterebbe mai, e un controllo di
            // salute che ignorasse `error` sarebbe il 200 fisso con più passaggi.
            const { error } = await supabase.from(tabella).select('id').limit(1)
            if (error) rotte.push(`${tabella}:${codiceDi(error)}`)
        }
        if (rotte.length > 0) return { esito: 'giu', dettaglio: rotte.join(' ') }
        return { esito: 'ok' }
    })
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2. Lo schema atteso è presente
 * ════════════════════════════════════════════════════════════════════════════ */

async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {
    return misura('schema-atteso', 'giu', async () => {
        const assenti: string[] = []
        const illeggibili: string[] = []
        for (const tabella of TABELLE_ATTESE) {
            const { error } = await supabase
                .from(tabella)
                .select('id', { head: true, count: 'exact' })
                .limit(1)
            if (!error) continue
            // Si distingue «la tabella non c'è» da «la tabella c'è ma la query è caduta».
            // Sono due incidenti diversi che si riparano in due posti diversi: una
            // migrazione da applicare contro un database in affanno. Un controllo che li
            // fondesse manderebbe chi risponde all'allarme a cercare nel posto sbagliato.
            if (CODICI_TABELLA_ASSENTE.has(codiceDi(error))) assenti.push(tabella)
            else illeggibili.push(`${tabella}:${codiceDi(error)}`)
        }
        if (assenti.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle assenti: ${assenti.join(',')}` }
        }
        if (illeggibili.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle illeggibili: ${illeggibili.join(' ')}` }
        }
        return { esito: 'ok', dettaglio: `${TABELLE_ATTESE.length} tabelle presenti` }
    })
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. Il battito dei cron
 * ════════════════════════════════════════════════════════════════════════════ */

interface RigaBattito {
    visto_l_ultima?: string | null
    contesto?: { campi?: { operazione?: unknown; esito?: unknown } | null } | null
}

/**
 * IL CONTROLLO CHE DISTINGUE «TUTTO TRANQUILLO» DA «NON È MAI PARTITO NIENTE».
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `visto_l_ultima`, NON `creato_il`. È la riga più facile da sbagliare del file.
 *
 * `app_log` deduplica per (fingerprint, giorno): il battito `push-dispatch: ok` produce
 * UNA riga al giorno, con `creato_il` fissato al primo giro dopo la mezzanotte e
 * `occorrenze` che sale a ogni giro successivo. Misurato in produzione il 2026-08-04:
 * 7 righe e 1848 occorrenze in sette giorni, cioè un giro ogni 5 minuti dentro 7 righe.
 *
 * Un controllo scritto su `creato_il` con finestra di 20 minuti sarebbe quindi verde
 * dalle 00:00 alle 00:20 e ROSSO per le restanti 23 ore e 40 di ogni giorno, con il job
 * perfettamente funzionante. Non è un bug sottile: è un allarme che suona sempre, e un
 * allarme che suona sempre viene spento — dopodiché il silenzio vero non lo sente più
 * nessuno. `visto_l_ultima` è l'ora dell'ULTIMA occorrenza, ed è l'unica colonna che
 * risponde alla domanda «questo job ha battuto di recente?».
 * ────────────────────────────────────────────────────────────────────────────
 *
 * L'esito è `degradato`, non `giu`: un cron fermo NON impedisce a un genitore di aprire
 * l'app. Rispondere 503 lo tratterebbe come un'interruzione di servizio e — dietro un
 * load balancer — potrebbe togliere dalla rotazione un'applicazione che sta servendo
 * benissimo. Trasformare un avviso in un guasto è un modo di causare il guasto.
 */
async function controlloBattitoCron(
    supabase: SupabaseClient,
    adesso: number,
    ambiente: string,
): Promise<Controllo> {
    return misura('cron-battito', 'degradato', async () => {
        const da = new Date(adesso - FINESTRA_BATTITO_MAX).toISOString()
        const { data, error } = await supabase
            .from('app_log')
            .select('visto_l_ultima, contesto')
            .eq('evento', 'cron')
            .eq('livello', 'info')
            .eq('ambiente', ambiente)
            .gte('visto_l_ultima', da)
            // Decrescente: se il tetto tagliasse, taglia le righe VECCHIE. Con l'ordine
            // opposto un troncamento farebbe sparire i battiti freschi e produrrebbe un
            // allarme dal nulla — il controllo mentirebbe proprio quando tutto va bene.
            .order('visto_l_ultima', { ascending: false })
            .limit(500)
        if (error) {
            return { esito: 'degradato', dettaglio: `lettura app_log ${codiceDi(error)}` }
        }

        /** Ultimo battito «ok» per job, in millisecondi. */
        const ultimo = new Map<string, number>()
        for (const riga of (data ?? []) as RigaBattito[]) {
            const campi = riga.contesto?.campi
            if (!campi || campi.esito !== 'ok') continue
            const job = campi.operazione
            if (typeof job !== 'string') continue
            const t = Date.parse(String(riga.visto_l_ultima ?? ''))
            if (Number.isNaN(t)) continue
            if (t > (ultimo.get(job) ?? -Infinity)) ultimo.set(job, t)
        }

        // Il nome del job DEVE finire nel dettaglio. «un cron è fermo» non è un allarme:
        // è un enigma. `push-dispatch` fermo significa nessuna notifica; `fattura-sync`
        // fermo significa fatture non riconciliate: due urgenze diverse e due persone
        // diverse da svegliare.
        const muti = JOB_CRON.filter((j) => {
            const t = ultimo.get(j.nome)
            return t === undefined || adesso - t > j.finestraMs
        }).map((j) => j.nome)

        if (muti.length > 0) {
            return { esito: 'degradato', dettaglio: `job senza battito: ${muti.join(',')}` }
        }
        return { esito: 'ok', dettaglio: `${JOB_CRON.length} job con battito nella finestra` }
    })
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. Tasso d'errore
 * ════════════════════════════════════════════════════════════════════════════ */

async function controlloTassoErrore(
    supabase: SupabaseClient,
    adesso: number,
    ambiente: string,
): Promise<Controllo> {
    return misura('tasso-errore', 'degradato', async () => {
        const da = new Date(adesso - FINESTRA_ERRORI_MS).toISOString()
        // `head: true`: si vuole il CONTEGGIO, non le righe. Le righe di `app_log`
        // portano `messaggio`, `stack` e `contesto` — cioè, su un endpoint pubblico,
        // esattamente ciò che non deve entrare nemmeno in memoria per sbaglio.
        const { count, error } = await supabase
            .from('app_log')
            .select('id', { head: true, count: 'exact' })
            .eq('livello', 'error')
            .eq('ambiente', ambiente)
            .gte('visto_l_ultima', da)
        if (error) {
            return { esito: 'degradato', dettaglio: `conteggio app_log ${codiceDi(error)}` }
        }
        const n = count ?? 0
        if (n > SOGLIA_IMPRONTE_ERRORE) {
            return {
                esito: 'degradato',
                dettaglio: `${n} impronte d'errore attive negli ultimi ${FINESTRA_ERRORI_MS / MIN} min (soglia ${SOGLIA_IMPRONTE_ERRORE})`,
            }
        }
        return { esito: 'ok', dettaglio: `${n} impronte d'errore attive` }
    })
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. Configurazione
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * `degradato` e non `giu`, ed è una scelta discutibile che vale la pena difendere:
 * `SUPABASE_SERVICE_ROLE_KEY` assente rende il servizio inservibile, `RESEND_API_KEY`
 * assente rende muto solo l'invio delle email. Ma il primo caso è già coperto — senza
 * quella chiave `db-lettura` fallisce e lo stato è `down` per la via che conta, cioè
 * misurando invece di dedurre. Questo controllo aggiunge il resto: i guasti che non si
 * vedono da nessun'altra parte, e nessuno di quelli impedisce all'app di servire.
 *
 * L'accesso è STATICO (`process.env.NOME`), mai `process.env[nome]`: le `NEXT_PUBLIC_*`
 * il bundler le sostituisce solo sulla forma statica, e con quella dinamica il controllo
 * griderebbe al lupo su una variabile che c'è.
 */
function valoriCritici(): ReadonlyArray<readonly [string, string | undefined]> {
    return [
        ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
        ['NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL],
        ['RESEND_API_KEY', process.env.RESEND_API_KEY],
        ['OTP_FROM_EMAIL', process.env.OTP_FROM_EMAIL],
        ['CRON_SECRET', process.env.CRON_SECRET],
        ['LOG_HASH_SALT', process.env.LOG_HASH_SALT],
    ]
}

async function controlloConfig(): Promise<Controllo> {
    return misura('config', 'degradato', async () => {
        // Una variabile impostata a stringa vuota è assente: `''` non configura niente.
        const assenti = valoriCritici()
            .filter(([, v]) => v === undefined || v.trim() === '')
            .map(([nome]) => nome)
        if (assenti.length > 0) {
            return { esito: 'degradato', dettaglio: `variabili assenti: ${assenti.join(',')}` }
        }
        return { esito: 'ok', dettaglio: `${VARIABILI_CRITICHE.length} variabili presenti` }
    })
}

/* ════════════════════════════════════════════════════════════════════════════
 * Aggregazione
 * ════════════════════════════════════════════════════════════════════════════ */

export function aggrega(controlli: Controllo[]): StatoSalute {
    if (controlli.some((c) => c.esito === 'giu')) return 'down'
    if (controlli.some((c) => c.esito === 'degradato')) return 'degraded'
    return 'ok'
}

export interface OpzioniSalute {
    /** Iniettabile per test deterministici. */
    adesso?: number
    /** L'ambiente su cui filtrare `app_log`: in preview i battiti di produzione non contano. */
    ambiente: string
}

/**
 * I cinque controlli girano IN PARALLELO.
 *
 * In serie il caso peggiore sarebbe 5 × il tetto = 10 secondi, cioè oltre il timeout di
 * ogni monitor ragionevole: l'endpoint verrebbe dichiarato giù proprio quando il suo
 * compito è dire in che modo è giù. In parallelo il caso peggiore resta il tetto singolo.
 */
export async function eseguiControlli(
    supabase: SupabaseClient,
    opzioni: OpzioniSalute,
): Promise<Salute> {
    const t0 = Date.now()
    const adesso = opzioni.adesso ?? Date.now()
    const controlli = await Promise.all([
        controlloDbLettura(supabase),
        controlloSchema(supabase),
        controlloBattitoCron(supabase, adesso, opzioni.ambiente),
        controlloTassoErrore(supabase, adesso, opzioni.ambiente),
        controlloConfig(),
    ])
    return { stato: aggrega(controlli), ms: Date.now() - t0, controlli }
}
