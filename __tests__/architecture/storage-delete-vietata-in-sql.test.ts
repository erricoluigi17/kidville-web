import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lock — DA SQL NON SI CANCELLANO I FILE. MAI.
 *
 * ─── IL CASO VERO, 2026-08-01 ───────────────────────────────────────────────
 *
 * La regola di conservazione a 24 mesi sulle domande d'iscrizione è stata scritta
 * come funzione SQL e agganciata a pg_cron. La migrazione è passata, il job
 * risultava creato e attivo, e per mezza giornata è sembrato tutto a posto. Il
 * collaudo finale ha poi fatto l'unica cosa che nessuno aveva fatto — **invocare la
 * funzione** — e ha trovato questo:
 *
 *     ERROR 42501: Direct deletion from storage tables is not allowed.
 *                  Use the Storage API instead.
 *
 * Su Supabase `storage.objects` ha il trigger `protect_objects_delete`, ed è
 * **FOR EACH STATEMENT**: scatta a ogni `DELETE` anche quando le righe da
 * cancellare sono ZERO. Il job sarebbe fallito la prima notte utile e ogni volta
 * dopo, portandosi dietro le 92 domande con allergie e note mediche di minori.
 *
 * ─── PERCHÉ IL LOCK GUARDA IL SQL E NON L'ESITO ─────────────────────────────
 *
 * Perché l'esito, in questo caso, non si può guardare: i test girano offline, senza
 * database, e una funzione che fallisce solo quando viene ESEGUITA è invisibile a
 * qualunque prova statica sul suo effetto. L'unica cosa verificabile a costo zero è
 * la forma: **una `DELETE` su `storage.objects` dentro una migrazione è sempre un
 * errore**, indipendentemente da quando verrà eseguita.
 *
 * E c'è un secondo motivo, indipendente dal trigger: cancellare la riga di
 * `storage.objects` **non toglie il binario** dall'object store — toglie l'indice.
 * Anche il giorno in cui Supabase togliesse quel trigger, il codice resterebbe
 * sbagliato: dichiarerebbe di aver cancellato un documento d'identità che è ancora
 * lì. Per questo la regola non ha eccezioni tecniche, e non è «finché c'è il
 * trigger».
 *
 * ─── DOVE VA FATTO, INVECE ──────────────────────────────────────────────────
 *
 * Dalla Storage API, cioè dal programma: `supabase.storage.from(b).remove([...])`.
 * È ciò che l'oblio su richiesta (`src/lib/gdpr/esegui.ts`) fa correttamente da
 * mesi, e che ora fa anche la retention
 * (`src/app/api/gdpr/retention-iscrizioni/route.ts`).
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

/** Sostituisce i commenti SQL con spazi, lasciando intatte le stringhe. */
function senzaCommenti(sql: string): string {
    let out = ''
    let i = 0
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code'
    while (i < sql.length) {
        const c = sql[i]
        const d = sql[i + 1]
        if (stato === 'code') {
            if (c === '-' && d === '-') { stato = 'riga'; out += '  '; i += 2; continue }
            if (c === '/' && d === '*') { stato = 'blocco'; out += '  '; i += 2; continue }
            if (c === "'") { stato = 'str'; out += c; i++; continue }
            out += c; i++; continue
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n' } else out += ' '
            i++; continue
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += '  '; i += 2; continue }
            out += c === '\n' ? '\n' : ' '; i++; continue
        }
        if (c === "'") stato = 'code'
        out += c; i++
    }
    return out
}

const FILE = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()

/**
 * La migrazione che ha introdotto il difetto e quella che l'ha riparato restano nel
 * repo (lo storico non si riscrive), e la prima CONTIENE la `DELETE` incriminata.
 * L'esenzione è nominale e per una riga sola: se qualcuno scrivesse una migrazione
 * nuova con lo stesso errore, il lock la vedrebbe.
 */
const STORICHE_CON_IL_DIFETTO = new Set([
    '20260801081423_retention_iscrizioni_e_audit.sql',
])

describe('lock architettura · i file non si cancellano da SQL', () => {
    it('le fonti sono piene: se cade questa, il resto controllerebbe il vuoto', () => {
        expect(FILE.length, 'nessuna migrazione trovata').toBeGreaterThan(60)
        // Controllo positivo del rilevatore: la migrazione storica CONTIENE davvero
        // la forma vietata. Se un domani smettesse di contenerla, il pattern qui
        // sotto non starebbe più cercando ciò che crede.
        const storica = senzaCommenti(
            readFileSync(join(MIGRAZIONI, '20260801081423_retention_iscrizioni_e_audit.sql'), 'utf8'),
        )
        expect(
            /DELETE\s+FROM\s+storage\.objects/i.test(storica),
            'la migrazione storica non contiene più la DELETE: il rilevatore non è più tarato su niente',
        ).toBe(true)
    })

    it('nessuna migrazione cancella da `storage.objects`', () => {
        const colpevoli: string[] = []
        for (const f of FILE) {
            if (STORICHE_CON_IL_DIFETTO.has(f)) continue
            const sql = senzaCommenti(readFileSync(join(MIGRAZIONI, f), 'utf8'))
            sql.split('\n').forEach((riga, i) => {
                if (/DELETE\s+FROM\s+(?:only\s+)?storage\.objects/i.test(riga)) {
                    colpevoli.push(`${f}:${i + 1}`)
                }
            })
            // Anche la forma con USING/CTE finisce su più righe: si guarda il testo intero.
            // Niente flag `s`: il pattern non contiene `.`, e il `replace` qui sotto
            // appiattisce già i ritorni a capo. (Con `target: ES2017` non compila — TS1501.)
            if (/DELETE\s+FROM\s+(?:only\s+)?storage\.objects/i.test(sql.replace(/\n/g, ' '))
                && !colpevoli.some((c) => c.startsWith(f))) {
                colpevoli.push(`${f}:(su più righe)`)
            }
        }
        expect(
            colpevoli,
            `Una \`DELETE FROM storage.objects\` in una migrazione fallisce SEMPRE: il trigger ` +
            `\`protect_objects_delete\` è FOR EACH STATEMENT e scatta anche a zero righe (42501). ` +
            `E anche se non ci fosse, cancellerebbe l'indice lasciando il file sul disco. ` +
            `I file si tolgono dalla Storage API — vedi ` +
            `\`src/app/api/gdpr/retention-iscrizioni/route.ts\` e \`src/lib/gdpr/esegui.ts\`.`,
        ).toEqual([])
    })

    it('il lavoro notturno della retention passa dal programma, non da una funzione SQL', () => {
        // Controllo positivo dell'esito: non basta che la DELETE sia sparita, deve
        // esserci la strada nuova — altrimenti il lock resterebbe verde su una
        // conservazione che non viene più fatta da nessuno.
        const riparazione = FILE.find((f) => f.endsWith('_retention_iscrizioni_via_storage_api.sql'))
        expect(riparazione, 'manca la migrazione che sposta la retention sulla route').toBeTruthy()
        const sql = readFileSync(join(MIGRAZIONI, riparazione!), 'utf8')
        expect(sql, 'il job deve chiamare la route via net.http_post').toMatch(/net\.http_post/)
        expect(sql, 'il job deve puntare a `iscrizioni_retention_http`').toMatch(/iscrizioni_retention_http/)
        // E l'URL mancante deve essere un ERRORE, non una nota: senza, l'assenza del
        // lavoro tornerebbe a essere invisibile — che è il difetto vero di questa storia.
        // `[\s\S]` e non `.`: le due cose stanno su righe diverse, e il flag `s` non
        // compila con `target: ES2017` (TS1501).
        expect(sql, "l'URL non configurato deve loggare a livello `error`").toMatch(/'error'[\s\S]{0,400}url-assente/)
    })
})
