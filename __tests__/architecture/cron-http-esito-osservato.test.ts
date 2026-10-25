import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    ASSENTI_IN_PRODUZIONE, INVOLUCRO, LETTORE, NON_SI_AVVOLGONO,
    contaChiamate, corpoOVuoto, mascheraSql, minimoAvvolte, ultimeDefinizioni,
} from '../../scripts/cron-esiti/involucro.mjs'
import { JOB_CRON, JOB_CRON_NON_SORVEGLIATI } from '@/lib/health/controlli'

/**
 * LOCK · ogni chiamata dei cron al server deve poter VEDERE il proprio esito.
 *
 * ─── LA STORIA, IN TRE GIORNI ────────────────────────────────────────────────
 *
 * 1° agosto, mattina. La regola dei 24 mesi sulle domande d'iscrizione è una
 * funzione SQL che cancella anche i file. Postgres lo vieta: la funzione fallisce
 * a ogni esecuzione, e fallisce PRIMA di scrivere la riga di log che avrebbe
 * dovuto segnalarlo. «La difesa che doveva accorgersi del guasto stava a valle del
 * guasto» — parole della migrazione che l'ha corretta.
 *
 * 1° agosto, pomeriggio. La correzione avvolge `net.http_post` in un
 * `EXCEPTION WHEN OTHERS` che lascia una riga `error`, e scrive nel commento della
 * funzione che quel lavoro «NON è muto sul fallimento».
 *
 * 2 agosto. Il collaudo misura che quella promessa il meccanismo non poteva
 * mantenerla: `net.http_post` è ASINCRONO — `pg_get_function_result` dice `bigint`,
 * cioè un numero d'ordine — e accoda soltanto. L'esito vero (4xx/5xx, timeout,
 * DNS, host irraggiungibile) lo scrive un altro processo in `net._http_response`,
 * fuori dalla transazione: quel blocco `EXCEPTION` non lo vedrà mai. Misurato lo
 * stesso giorno: 120 risposte in `net._http_response`, **nessuna** funzione del
 * database che le legga.
 *
 * ─── PERCHÉ UN LOCK, E NON SOLO UNA CORREZIONE ──────────────────────────────
 *
 * Perché il difetto non è stato un errore di battitura: è stata la REPLICA DELLA
 * FORMA di una difesa (try/catch + log) senza verificare che il punto di
 * osservazione vedesse il guasto. È una cosa che si rifà, e si rifà proprio
 * quando si va di fretta a correggere. Il gate era verde tutte e tre le volte.
 *
 * Questo lock guarda il MECCANISMO, non le parole: che il numero d'ordine venga
 * conservato, e che qualcuno legga la tabella dove l'esito arriva davvero.
 *
 * ─── PERIMETRO, DICHIARATO ──────────────────────────────────────────────────
 *
 * Fino al 2026-10-20 sorvegliava il solo job della conservazione delle iscrizioni:
 * gli altri lavori via `net.http_post` avevano la stessa cecità, ma girando ogni
 * 5-30 minuti un'esecuzione persa si riassorbiva alla successiva, mentre lì il giro
 * era MENSILE e i dati sanitari, di minori non iscritti. Questo blocco diceva che il
 * giorno in cui si fosse voluta estendere la sorveglianza agli altri, il posto per
 * scriverlo era qui.
 *
 * ─── 2026-10-20: ESTESO A TUTTI ─────────────────────────────────────────────
 *
 * Sessione 6 della seconda serie di robustezza. Ogni funzione che chiama il server
 * passa da `public.cron_http_post('<job>', …)`, che conserva il numero e lo scrive in
 * `cron_chiamate`; `cron_esiti()` legge `net._http_response` e `cron.job_run_details`
 * ogni 10 minuti e scrive l'esito in `app_log` col nome del job. Le funzioni sono
 * state riscritte partendo dai corpi della PRODUZIONE (`pg_get_functiondef`) da
 * `scripts/cron-esiti/involucro.mjs`, che cambia solo la chiamata. Le eccezioni
 * stanno in `NON_SI_AVVOLGONO` e `ASSENTI_IN_PRODUZIONE` dello stesso file, ciascuna
 * con la sua ragione; questo lock pretende che restino vere.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()
const ULTIME = ultimeDefinizioni(MIGRAZIONI)
const ESCLUSE: Record<string, string> = { ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE }

const definizione = (funzione: string): string => ULTIME.get(funzione)?.definizione ?? ''
/** Il corpo senza commenti; le stringhe restano (servono i nomi delle tabelle e dei job). */
const corpoSenzaCommenti = (funzione: string): string =>
    mascheraSql(corpoOVuoto(definizione(funzione)), { stringhe: false })
const chiamate = (funzione: string) => contaChiamate(corpoOVuoto(definizione(funzione)))

describe('lock architettura · ogni chiamata dei cron al server vede il proprio esito', () => {
    it('le fonti sono piene (se cade questa, tutto il resto sta controllando il vuoto)', () => {
        expect(FILE.length, 'nessun file .sql sotto supabase/migrations').toBeGreaterThan(60)
        expect(ULTIME.size, 'lo scanner non trova le funzioni delle migrazioni').toBeGreaterThan(100)
        expect(ULTIME.has(INVOLUCRO), `manca public.${INVOLUCRO}()`).toBe(true)
        expect(ULTIME.has(LETTORE), `manca public.${LETTORE}()`).toBe(true)
    })

    it('nessuna funzione chiama net.http_post da sola: passa dall’involucro, salvo le escluse dichiarate', () => {
        const dirette = [...ULTIME.keys()].filter(
            (nome) => nome !== INVOLUCRO && !Object.hasOwn(ESCLUSE, nome) && chiamate(nome).dirette > 0,
        )
        expect(
            dirette,
            'Queste funzioni chiamano `net.http_post` direttamente e buttano via il numero della ' +
            'richiesta: il loro esito non arriverà a nessuno. Si avvolgono con ' +
            '`node scripts/cron-esiti/involucro.mjs genera`, partendo dal corpo della PRODUZIONE; ' +
            'oppure si dichiarano in `NON_SI_AVVOLGONO`, con la ragione.',
        ).toEqual([])
    })

    it('ogni esclusione è ancora vera e porta una ragione', () => {
        for (const [nome, ragione] of Object.entries(ESCLUSE)) {
            expect(ragione.length, `${nome}: ragione troppo corta`).toBeGreaterThan(30)
            expect(chiamate(nome).dirette, `${nome}: non chiama più net.http_post, si toglie l’esclusione`).toBe(1)
        }
    })

    it('l’involucro conserva il numero, lo registra, ed è chiuso ai ruoli client', () => {
        const corpo = corpoSenzaCommenti(INVOLUCRO)
        expect(/\w+\s*:=\s*net\.http_post\s*\(/i.test(corpo), 'il numero di net.http_post non è raccolto').toBe(true)
        expect(/PERFORM\s+net\.http_post/i.test(corpo), '`PERFORM net.http_post` butta via il numero').toBe(false)
        expect(/INSERT\s+INTO\s+public\.cron_chiamate/i.test(corpo), 'il numero non viene registrato').toBe(true)
        expect(definizione(INVOLUCRO)).toMatch(/SECURITY\s+DEFINER/i)
        expect(definizione(INVOLUCRO)).toMatch(/SET\s+search_path\s+TO\s+'public',\s*'pg_temp'/i)
        const file = readFileSync(join(MIGRAZIONI, ULTIME.get(INVOLUCRO)!.file), 'utf8')
        expect(mascheraSql(file)).toMatch(
            /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.cron_http_post\([^)]*\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
        )
    })

    it('le funzioni avvolte sono almeno quelle attese, e ogni etichetta è di una funzione sola', () => {
        const etichette = new Map<string, string>()
        let avvolte = 0
        for (const nome of ULTIME.keys()) {
            if (nome === INVOLUCRO || chiamate(nome).avvolte === 0) continue
            avvolte++
            const job = /public\.cron_http_post\(\s*'([a-z0-9][a-z0-9-]*)'/i.exec(corpoSenzaCommenti(nome))?.[1]
            expect(job, `${nome}: l’involucro si chiama col nome del job, fra apici, come primo argomento`).toBeTruthy()
            expect(etichette.get(job!), `etichetta «${job}» usata anche da ${etichette.get(job!)}`).toBeUndefined()
            etichette.set(job!, nome)
        }
        expect(avvolte).toBeGreaterThanOrEqual(minimoAvvolte())
    })

    it('la conservazione delle iscrizioni conserva ancora il numero, lo registra, e aspetta più di 5 secondi', () => {
        const nome = 'iscrizioni_retention_http'
        const corpo = corpoSenzaCommenti(nome)
        expect(corpo, `manca ${nome}()`).not.toBe('')
        expect(chiamate(nome)).toEqual({ dirette: 0, avvolte: 1 })
        expect(/PERFORM\s+public\.cron_http_post/i.test(corpo), '`PERFORM` butta via il numero d’ordine').toBe(false)
        expect(
            /(\w+\s*:=\s*public\.cron_http_post\s*\(|SELECT\s+public\.cron_http_post\s*\([\s\S]*?\)\s*INTO\s+\w+)/i.test(corpo),
            'il numero restituito dall’involucro non è raccolto in una variabile',
        ).toBe(true)
        expect(/iscrizioni_retention_esecuzioni/i.test(corpo), 'il numero non viene registrato').toBe(true)
        const t = /timeout_milliseconds\s*(?::=|=>)\s*(\d+)/i.exec(corpo)
        expect(t !== null && Number(t[1]) > 5000, 'timeout di fabbrica (5 s): la route non finisce in cinque secondi').toBe(true)
    })

    it('qualcuno LEGGE net._http_response e cron.job_run_details, e ne scrive l’esito in app_log', () => {
        const corpo = corpoSenzaCommenti(LETTORE)
        expect(corpo).toMatch(/to_regclass\('net\._http_response'\)/)
        expect(corpo).toMatch(/to_regclass\('cron\.job_run_details'\)/)
        expect(corpo).toMatch(/FROM\s+net\._http_response/i)
        expect(corpo).toMatch(/FROM\s+cron\.job_run_details/i)
        expect(corpo).toMatch(/'cron-http:'/)
        expect(corpo).toMatch(/'cron-http-timeout:'/)
        expect(corpo).toMatch(/'cron-esiti:fallito'/)
        expect(corpo).toMatch(/INSERT\s+INTO\s+public\.app_log/i)
    })

    it('la sorveglianza delle iscrizioni si accorge anche del SILENZIO', () => {
        const corpo = corpoSenzaCommenti('iscrizioni_retention_sorveglia')
        expect(corpo, 'manca `iscrizioni_retention_sorveglia()`').not.toBe('')
        expect(/interval\s+'(\d+)\s+days'/i.test(corpo), 'non misura da quanto il lavoro non arriva').toBe(true)
        expect(/app_log/i.test(corpo), 'non lascia traccia in app_log').toBe(true)
    })

    it('il job cron-esiti è installato e dichiarato in una delle due liste della salute', () => {
        const installano = FILE.filter((f) => /cron\.schedule\(\s*'cron-esiti'/.test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
        expect(installano, 'nessuna migrazione installa cron-esiti').not.toEqual([])
        const nomi = [...JOB_CRON, ...JOB_CRON_NON_SORVEGLIATI].map((j) => j.nome)
        expect(nomi).toContain('cron-esiti')
    })

    it('controllo positivo: il contatore vede la chiamata vera e ignora commento e stringa', () => {
        expect(contaChiamate("-- net.http_post(\n RAISE LOG 'net.http_post('; PERFORM net.http_post(url := 'x');"))
            .toEqual({ dirette: 1, avvolte: 0 })
    })
})
