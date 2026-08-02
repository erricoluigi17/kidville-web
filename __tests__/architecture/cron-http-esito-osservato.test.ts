import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · il lavoro notturno della conservazione deve poter VEDERE il proprio esito.
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
 * Sorveglia il solo job della conservazione delle iscrizioni. Gli altri quattro
 * lavori via `net.http_post` hanno la stessa cecità ma girano ogni 5-30 minuti:
 * un'esecuzione persa si riassorbe alla successiva. Qui il giro è MENSILE e i dati
 * sono sanitari, di minori non iscritti: un buco si scopre trentun giorni dopo.
 * Il giorno in cui si vorrà estendere la sorveglianza agli altri, questo lock è il
 * posto dove scriverlo.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const FILE = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()

const CONTENUTO = new Map(FILE.map((f) => [f, readFileSync(join(MIGRAZIONI, f), 'utf8')]))

/** L'ultima migrazione che (ri)definisce una funzione: è quella che vale. */
function ultimaDefinizione(funzione: string): { file: string; sql: string } | null {
    const forma = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${funzione}\\s*\\(`, 'i')
    for (let i = FILE.length - 1; i >= 0; i--) {
        const sql = CONTENUTO.get(FILE[i]) ?? ''
        if (forma.test(sql)) return { file: FILE[i], sql }
    }
    return null
}

/** Il corpo `AS $$ … $$` della funzione, senza i commenti `--`. */
function corpo(sql: string, funzione: string): string {
    const da = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${funzione}\\s*\\(`, 'i'))
    if (da < 0) return ''
    const apre = sql.indexOf('$$', da)
    const chiude = sql.indexOf('$$', apre + 2)
    if (apre < 0 || chiude < 0) return ''
    return sql
        .slice(apre + 2, chiude)
        .split('\n')
        .map((r) => r.replace(/--.*$/, ''))
        .join('\n')
}

describe('lock architettura · il cron della conservazione vede il proprio esito', () => {
    it('le fonti sono piene (se cade questa, tutto il resto sta controllando il vuoto)', () => {
        expect(FILE.length, 'nessun file .sql sotto supabase/migrations').toBeGreaterThan(60)
        const conHttpPost = FILE.filter((f) => (CONTENUTO.get(f) ?? '').includes('net.http_post'))
        expect(
            conHttpPost.length,
            'Lo scanner non trova nessuna chiamata a net.http_post: il lock non sta guardando niente.',
        ).toBeGreaterThan(0)
    })

    it('l’invio CONSERVA il numero d’ordine restituito da net.http_post', () => {
        const def = ultimaDefinizione('iscrizioni_retention_http')
        expect(def, 'manca `iscrizioni_retention_http()` in supabase/migrations/').toBeTruthy()
        const body = corpo(def!.sql, 'iscrizioni_retention_http')

        expect(
            /PERFORM\s+net\.http_post/i.test(body),
            `${def!.file}: \`PERFORM net.http_post(…)\` BUTTA VIA il numero d'ordine. pg_net è ` +
            `asincrono: senza quel numero l'esito che arriva dopo in net._http_response non è ` +
            `riconducibile a niente, e il fallimento della chiamata resta invisibile per un mese.`,
        ).toBe(false)

        expect(
            /INTO\s+\w+\s*;?/i.test(body) && /net\.http_post/i.test(body),
            `${def!.file}: il valore restituito da net.http_post non viene raccolto in una ` +
            `variabile. È l'unico aggancio fra la richiesta e la sua risposta.`,
        ).toBe(true)

        expect(
            /iscrizioni_retention_esecuzioni/i.test(body),
            `${def!.file}: il numero d'ordine non viene registrato da nessuna parte. Una ` +
            `sorveglianza che non sa quali richieste aspettare non sorveglia niente.`,
        ).toBe(true)

        expect(
            /timeout_milliseconds\s*:=\s*(\d+)/i.test(body) &&
            Number(/timeout_milliseconds\s*:=\s*(\d+)/i.exec(body)![1]) > 5000,
            `${def!.file}: il tempo massimo è quello di fabbrica di pg_net (5 secondi). Una route ` +
            `che toglie file dall'archivio e righe dal database non finisce in cinque secondi: la ` +
            `sorveglianza segnalerebbe come guasto un lavoro riuscito.`,
        ).toBe(true)
    })

    it('qualcuno LEGGE net._http_response e ne scrive l’esito in app_log', () => {
        const lettori = FILE.filter((f) => {
            const sql = CONTENUTO.get(f) ?? ''
            return /net\._http_response/i.test(sql) && /app_log/i.test(sql)
        })
        expect(
            lettori,
            `Nessuna migrazione legge \`net._http_response\`. È la tabella dove pg_net scrive ` +
            `l'esito vero delle chiamate — status, timeout, errore di rete — e senza nessuno che ` +
            `la legga il lavoro notturno non può accorgersi di NON essere arrivato a destinazione. ` +
            `È il difetto misurato il 2026-08-02: un EXCEPTION attorno all'accodamento vede solo ` +
            `ciò che rompe l'accodamento.`,
        ).not.toEqual([])
    })

    it('la sorveglianza si accorge anche del SILENZIO (il caso che nessun trasporto segnala)', () => {
        const def = ultimaDefinizione('iscrizioni_retention_sorveglia')
        expect(
            def,
            'manca `iscrizioni_retention_sorveglia()`: senza, un job spento o cancellato non ' +
            'produce nessun segnale, perché non c\'è nessuna chiamata che possa fallire.',
        ).toBeTruthy()
        const body = corpo(def!.sql, 'iscrizioni_retention_sorveglia')
        expect(
            /interval\s+'(\d+)\s+days'/i.test(body),
            `${def!.file}: la sorveglianza non misura da quanto tempo il lavoro non arriva a ` +
            `destinazione. È l'unico controllo che non dipende dal trasporto che deve sorvegliare.`,
        ).toBe(true)
        expect(
            /app_log/i.test(body),
            `${def!.file}: la sorveglianza non scrive in app_log. Un controllo che non lascia ` +
            `traccia è esattamente il guasto che deve trovare.`,
        ).toBe(true)
    })
})
