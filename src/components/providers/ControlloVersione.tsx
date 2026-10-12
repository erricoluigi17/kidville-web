'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { osservaVisibilita } from '@/lib/hooks/visibilita-pagina'
import { VERSIONE_BUNDLE } from '@/lib/versione/deploy'

/**
 * «QUESTA APP È FERMA A TRE DEPLOY FA» — il controllo della versione al ritorno in primo piano.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IL FATTO. Un'app aperta sul telefono resta in memoria per giorni: nessuna navigazione dentro
 * una SPA sostituisce il bundle, e il codice che gira resta quello del deploy in cui la pagina è
 * stata caricata. Il genitore che riapre l'app lunedì mattina esegue il venerdì — con i suoi
 * difetti già corretti, e con i chunk che un deploy nuovo può non servire più (è la famiglia di
 * guasti per cui esiste `ChunkErrorBoundary`).
 *
 * Non è il pop-up «Aggiorna l'app» (`AvvisoAggiornamentoApp`, PR #174): quello riguarda il
 * BINARIO installato dallo store, chiede all'utente di andare a prenderlo, e sta sotto la minima
 * dello store. Questo riguarda il BUNDLE WEB dentro la WebView, non chiede niente a nessuno e si
 * risolve con una ricarica. Le due cose convivono: un binario vecchio può servire un bundle
 * nuovo e viceversa.
 *
 * ─── LE QUATTRO REGOLE, e il danno che ciascuna evita ───────────────────────────
 *
 *  1. SI CONTROLLA DI RADO. Solo al ritorno dopo un'assenza di almeno `ASSENZA_MINIMA_MS`, e mai
 *     più di una volta ogni `NON_PRIMA_DI_MS`. Questo componente nasce dentro un lavoro di
 *     robustezza il cui punto di partenza è un picco misurato (lunedì 12/10: in due ore 11.327
 *     richieste su `/rest/v1/pagamenti`, il p95 del database salito da 25 ms a 350-470 ms su
 *     `/auth/v1/user`): un controllo a ogni cambio di scheda sarebbe esattamente il difetto che
 *     il lavoro viene a chiudere. Un passaggio a WhatsApp e ritorno sono decine di riprese al
 *     giorno per famiglia; un quarto d'ora in tasca sono poche.
 *
 *  2. NON SI RICARICA SOTTO LE DITA DI NESSUNO. `location.reload()` butta via quello che c'è
 *     nei campi: una nota di una maestra a metà, un importo digitato in segreteria. Con un campo
 *     modificabile a fuoco la ricarica si RINVIA alla prossima navigazione — il momento in cui
 *     l'utente ha già lasciato quel modulo e la pagina viene comunque sostituita.
 *
 *  3. MAI UN CICLO. Se la ricarica non porta il bundle nuovo — una cache del Service Worker che
 *     non si sposta, un intermediario che serve il vecchio — ricaricare di nuovo sarebbe un'app
 *     che lampeggia per sempre, su un telefono che non abbiamo in mano. La versione per cui si è
 *     già ricaricato si annota in `sessionStorage` PRIMA di ricaricare (dopo il reload lo stato
 *     di modulo non esiste più, quindi è l'unica memoria possibile) e non si riprova.
 *
 *  4. IN SVILUPPO NON FA NIENTE. Senza una versione cotta nel bundle (`VERSIONE_BUNDLE` è
 *     `null` fuori da Vercel) non c'è niente da confrontare — e un'applicazione che si ricarica
 *     da sola mentre la stai scrivendo è insopportabile.
 *
 * ─── I LOG, e perché il successo NON si logga ───────────────────────────────────
 *
 * Il canale del client persiste `warn` ed `error` e non ha altri livelli (`/api/logs` li valida
 * con `z.enum(['warn','error'])`): la decisione di ricaricare esce `warn`, che è il livello di
 * un evento da CONTARE e non di un guasto.
 *
 * Il controllo andato bene — «la versione è la stessa» — non lascia nessuna riga, ed è una
 * scelta contro la lettera di AGENTS §5. La ragione è la stessa che il 12/10 ha fatto tacere la
 * sonda dei segnali di visibilità (S7-D): una riga per ogni controllo riuscito sarebbe un evento
 * al giorno per famiglia per riconfermare che tutto è come prima, cioè volume dentro il lavoro
 * che sta togliendo volume. E la classe di eventi di §5 — email, push, cron, fatture — è quella
 * in cui «non è partito niente» significa che una famiglia non riceve qualcosa: qui significa
 * che l'app non si ricarica da sola, cioè lo stato in cui l'applicazione è vissuta fino a oggi.
 *
 * Ciò che si logga è la decisione (le tre forme di `Esito`) e la domanda rimasta senza risposta.
 * Per quest'ultima si DICHIARA lo `stato` e si lascia decidere il livello a `logClient`
 * (`livelloEvento`): una lettura caduta a `stato: 0` nei secondi dopo il ritorno è la richiesta
 * troncata dal periodo in background e non si spedisce (S7-C), un 500 della nostra route invece
 * sì. Cablare qui un livello sarebbe la terza copia di una politica che vive in un posto solo.
 *
 * Nei campi vanno solo un numero e un enumerato chiuso. La VERSIONE sta nel MESSAGGIO, ed è la
 * lezione della #174: l'impronta con cui `app_log` accorpa le righe guarda il messaggio e non i
 * campi, quindi una versione messa nei soli campi sparirebbe dentro la riga della prima
 * occorrenza del giorno. Uno sha di commit di un repository pubblico non è un dato personale.
 * ════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Quanto deve essere stata nascosta la pagina perché valga la pena chiedere.
 *
 * Quindici minuti: sotto, la probabilità che nel frattempo sia uscito un deploy è trascurabile e
 * il costo (una richiesta per ogni ripresa, per ogni famiglia) non lo è.
 */
export const ASSENZA_MINIMA_MS = 15 * 60 * 1000

/**
 * Due controlli non si fanno mai a meno di questa distanza, qualunque sia l'assenza.
 *
 * ⚠️ A che serve, dato che l'assenza minima è di quindici minuti e quindi due riprese utili
 * distano già più di cinque: non a distanziare nel TEMPO, ma a far valere UNA la stessa ripresa
 * vista da più MONTAGGI. Il doppio giro degli effetti di StrictMode, un layout che si rimonta,
 * un secondo albero: ognuno monta il suo osservatore, e ognuno vedrebbe la stessa ripresa.
 * Insieme a `controlloInVolo` è ciò che trasforma N osservatori in una richiesta sola.
 */
export const NON_PRIMA_DI_MS = 5 * 60 * 1000

/**
 * La versione per cui si è GIÀ ricaricato, in `sessionStorage` (per scheda, e non oltre la
 * sessione: una versione di ieri non deve impedire la ricarica di domani).
 */
const CHIAVE_RICARICATA = 'kv_versione_ricaricata'

/**
 * Gli esiti che si loggano. Insieme CHIUSO e senza spazi: il valore finisce sotto la chiave
 * `esito`, che `redact.ts` lascia in chiaro solo se ha la forma di un enumerato.
 */
type Esito = 'ricaricata' | 'rinviata' | 'rinvio-eseguito'

/**
 * LA DECISIONE È UNA PER PAGINA, e lo stato sta nel MODULO.
 *
 * Con lo stato nel componente, il doppio montaggio di StrictMode o un layout che si rimonta
 * rifarebbero il controllo e raddoppierebbero le richieste. È la stessa scelta, per la stessa
 * ragione, di `AvvisoAggiornamentoApp` e `AvvisiSettimanaliApp`.
 */
let ultimoControllo = 0
let controlloInVolo = false
let ricaricaInSospeso: string | null = null

function giaRicaricatoPer(versione: string): boolean {
    try {
        return sessionStorage.getItem(CHIAVE_RICARICATA) === versione
    } catch {
        // Storage negato (Safari in privata, cookie di terze parti bloccati): si perde la
        // memoria dell'anti-ciclo, non il controllo. Vale come «non ho mai ricaricato»: il
        // verso giusto, perché il ciclo è comunque limitato dai due tetti di tempo qui sopra.
        return false
    }
}

/**
 * Scrive la memoria dell'anti-ciclo. Risponde `false` se non ci è riuscita.
 *
 * Quota piena o storage negato: si ricarica comunque — una ricarica in più è un fastidio, una
 * ricarica mancata è un'app ferma a tre deploy fa. Ma il fatto NON si butta via: senza
 * sessionStorage l'anti-ciclo non c'è più, e due ricariche di fila per la stessa versione
 * diventerebbero indistinguibili da un difetto nostro. Per questo l'esito finisce nella riga
 * che `ricarica` scrive già, come booleano: alle tre di notte è la differenza fra «Safari in
 * navigazione privata» e «abbiamo un ciclo».
 *
 * ⚠️ Un `catch` con dentro soltanto un commento è la forma che AGENTS.md regola 6 cita fra le
 * vietate, e il lock `__tests__/architecture/catch-muti-allowlist.test.ts` la conta: qui era
 * proprio quella, ed è il lock ad averlo detto. Sul canale del client non esiste il livello
 * `info` (`logClient` prende `warn` o `error`, e tutto ciò che riceve viene persistito),
 * quindi «loggarlo a info» significherebbe spedire una riga per ogni browser in privata: il
 * posto giusto per questo fatto è la riga che si scrive comunque.
 */
function segnaRicaricatoPer(versione: string): boolean {
    try {
        sessionStorage.setItem(CHIAVE_RICARICATA, versione)
        return true
    } catch {
        return false
    }
}

/**
 * C'è un campo modificabile a fuoco? Se sì la ricarica aspetta.
 *
 * Larga di proposito: qualunque `input` che non sia un bottone travestito, le `textarea`, le
 * `select` e i contenitori `contenteditable`. Un falso positivo costa un rinvio (la ricarica
 * avviene alla navigazione dopo); un falso negativo costa il testo che qualcuno stava scrivendo.
 */
function campoModificabileAFuoco(): boolean {
    try {
        const a = document.activeElement
        if (!(a instanceof HTMLElement)) return false
        if (a.isContentEditable) return true
        const tag = a.tagName
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true
        if (tag !== 'INPUT') return false
        const tipo = (a as HTMLInputElement).type
        return !['button', 'submit', 'reset', 'image', 'hidden'].includes(tipo)
    } catch {
        // `document` o `activeElement` indisponibili: nel dubbio si RINVIA, che è la decisione
        // che non porta via niente a nessuno.
        return true
    }
}

/**
 * `antiCiclo` è il solo campo che non descrive la decisione ma la sua MEMORIA: `false` dice
 * che il browser non ha accettato di ricordare questa versione, quindi un'altra ricarica per
 * la stessa versione è attesa e non è un difetto. Booleani e numeri passano in chiaro nella
 * redazione (lista bianca per tipo); `esito` è fra le chiavi ammesse. Nessun dato personale:
 * la versione è lo sha di un commit di un repository pubblico, e sta nel MESSAGGIO perché
 * l'impronta di `app_log` guarda lì (lezione della #174).
 */
function logDecisione(
    esito: Esito,
    servita: string,
    minutiNascosta: number,
    antiCiclo?: boolean,
): void {
    // `anti_ciclo` è ASSENTE sulla riga `rinviata`: lì non si è ancora scritto niente, e un
    // booleano inventato direbbe il falso in SQL. La ricarica rinviata porta il campo quando
    // parte davvero, come `rinvio-eseguito`.
    //
    // Si costruisce in due passi e non con un ternario: `logClient` deduce il tipo dei campi
    // dall'oggetto che riceve, e un'unione di due forme non è deducibile (`tsc` la rifiuta).
    const campi: { esito: Esito; minuti_nascosta: number; anti_ciclo?: boolean } = {
        esito,
        minuti_nascosta: minutiNascosta,
    }
    if (antiCiclo !== undefined) campi.anti_ciclo = antiCiclo

    logClient({
        livello: 'warn',
        evento: 'avvio',
        messaggio: `bundle-vecchio-${esito}: ${servita}`,
        campi,
    })
}

function ricarica(servita: string, esito: Esito, minutiNascosta: number): void {
    // PRIMA la memoria, POI il log, POI la ricarica: dopo `reload()` questo modulo non esiste
    // più, e una riga accodata senza essere spedita si perde — `logClient` la deposita comunque
    // in `localStorage`, da cui il prossimo avvio la ripesca (vedi `riprendiCoda`).
    const antiCiclo = segnaRicaricatoPer(servita)
    ricaricaInSospeso = null
    logDecisione(esito, servita, minutiNascosta, antiCiclo)
    window.location.reload()
}

/**
 * Chiede al server quale rilascio stia servendo. `null` = «non lo so», e non si fa niente.
 *
 * `cache: 'no-store'` oltre all'intestazione della route: l'intestazione governa le cache
 * condivise, questo governa la cache del browser e il Service Worker di questa app — che una
 * risposta già vista la servirebbe volentieri, ed è esattamente la risposta che non deve
 * riusare.
 */
async function versioneServita(): Promise<string | null> {
    let res: Response
    try {
        res = await fetch('/api/versione', { cache: 'no-store' })
    } catch (e) {
        logClient({
            livello: 'warn',
            evento: 'avvio',
            messaggio: `versione-non-letta: ${nomeErrore(e)}`,
            // Il livello lo decide `logClient` dallo stato dichiarato: vedi la testata.
            stato: 0,
        })
        return null
    }
    if (!res.ok) {
        logClient({
            livello: 'warn',
            evento: 'avvio',
            messaggio: `versione-non-letta: http-${res.status}`,
            stato: res.status,
        })
        return null
    }
    try {
        const corpo = (await res.json()) as { versione?: unknown } | null
        return typeof corpo?.versione === 'string' && corpo.versione !== '' ? corpo.versione : null
    } catch (e) {
        // Il corpo della NOSTRA route illeggibile è un'anomalia vera, e non ha uno stato da far
        // giudicare: la risposta era 2xx. Resta `warn` perché non impedisce niente a nessuno.
        logClient({
            livello: 'warn',
            evento: 'avvio',
            messaggio: `versione-corpo-illeggibile: ${nomeErrore(e)}`,
        })
        return null
    }
}

interface Props {
    /**
     * Acceso solo dove serve: le pagine di chi è già dentro.
     *
     * Sulla schermata di accesso non c'è nessun dato da tenere fresco, e una ricarica lì
     * rischierebbe di portare via le credenziali appena digitate per guadagnare niente. Il
     * pop-up dello store (`AvvisoAggiornamentoApp`) invece copre anche il login, perché lì il
     * suo compito — dire «vai a scaricare la versione nuova» — ha senso comunque.
     */
    attivo: boolean
}

/**
 * Non rende niente: è un osservatore. Montato una volta in `RootProviders`, dentro il gate
 * biometrico come il pop-up dello store, così copre genitore, docente e segreteria — e la
 * WebView nativa, che di quel guscio è lo stesso.
 */
export function ControlloVersione({ attivo }: Props) {
    const pathname = usePathname()
    /**
     * Il pathname dell'ultimo giro. Serve a distinguere una NAVIGAZIONE dal doppio giro degli
     * effetti di StrictMode, che arriva con lo stesso valore: un contatore «è il primo?» lì
     * direbbe di no al secondo giro e ricaricherebbe la pagina a freddo.
     */
    const pathnameVisto = useRef<string | null>(null)

    useEffect(() => {
        if (!attivo || VERSIONE_BUNDLE === null) return

        let smontato = false

        const controlla = (nascostaDaMs: number) => {
            void (async () => {
                const servita = await versioneServita()
                if (smontato || servita === null || servita === VERSIONE_BUNDLE) return
                if (giaRicaricatoPer(servita)) return
                const minuti = Math.round(nascostaDaMs / 60_000)
                if (campoModificabileAFuoco()) {
                    ricaricaInSospeso = servita
                    logDecisione('rinviata', servita, minuti)
                    return
                }
                ricarica(servita, 'ricaricata', minuti)
            })().finally(() => {
                controlloInVolo = false
            })
        }

        const stacca = osservaVisibilita(({ ripresa, nascostaDaMs }) => {
            if (!ripresa || nascostaDaMs < ASSENZA_MINIMA_MS) return
            const ora = Date.now()
            if (controlloInVolo || ora - ultimoControllo < NON_PRIMA_DI_MS) return
            ultimoControllo = ora
            controlloInVolo = true
            controlla(nascostaDaMs)
        })

        /**
         * ⚠️ `smontato = true` VA QUI, e non è un vezzo: la guardia dentro `controlla` è l'unica
         * cosa che impedisce a una risposta ancora in volo di ricaricare una pagina che non
         * esiste più. Il caso concreto è l'uscita dall'account — `attivo` passa a `false`
         * mentre la richiesta è partita: una ricarica in quel momento interromperebbe la
         * navigazione di logout. Fino al primo passaggio di eslint questa riga mancava, la
         * guardia era codice morto e `prefer-const` lo ha detto per primo.
         */
        return () => {
            smontato = true
            stacca()
        }
    }, [attivo])

    useEffect(() => {
        const precedente = pathnameVisto.current
        pathnameVisto.current = pathname
        // Primo giro, o lo stesso percorso (StrictMode): non è una navigazione.
        if (precedente === null || precedente === pathname) return
        const servita = ricaricaInSospeso
        if (servita === null || !attivo) return
        // Il tempo di assenza non c'entra più: la ricarica era già stata decisa, e qui si
        // riprende quella decisione. Zero minuti dichiarati è la verità di QUESTO momento.
        ricarica(servita, 'rinvio-eseguito', 0)
    }, [pathname, attivo])

    return null
}
