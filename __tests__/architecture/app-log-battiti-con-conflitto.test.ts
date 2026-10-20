// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK — UN EVENTO SCRITTO IN `app_log` DA UNA FUNZIONE SQL CONTA, NON SI PERDE (2026-10-19).
 *
 * `app_log` ha un indice UNICO su (fingerprint, giorno): una riga per evento per giorno, e
 * `occorrenze` che conta. Una funzione che scrive con un'impronta fissa SENZA
 * `ON CONFLICT (fingerprint, giorno) DO UPDATE` salva il primo evento del giorno e dal secondo
 * fallisce con 23505 — e siccome il log sta dentro un `begin … exception when others`, il
 * fallimento lo inghiotte e resta solo una riga nei log del server.
 *
 * È successo davvero: «galleria: logging accodamento non riuscito [23505]», 156 volte il 19/10,
 * in cinque funzioni (galleria e stampe storiche). Il battito diceva «un accodamento» in un
 * giorno in cui la funzione era girata 157 volte. Correzione: migrazione
 * `20261019223123_battiti_app_log_che_contano.sql`.
 *
 * Il lock guarda l'ULTIMA definizione di ogni funzione nelle migrazioni (è quella che vale) e
 * pretende che ogni `INSERT INTO public.app_log` del corpo abbia il suo `ON CONFLICT`.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
const CONTENUTO = FILE.map((f) => ({ file: f, sql: readFileSync(join(MIGRAZIONI, f), 'utf8') }))

const DEFINIZIONE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(public|scatola_nera)\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
const INSERT_APP_LOG = /insert\s+into\s+(?:public\.)?app_log\b/gi
const SCRIVE_APP_LOG = /insert\s+into\s+(?:public\.)?app_log\b/i

/** Il corpo fra i due delimitatori `$tag$` che seguono la definizione, senza i commenti `--`. */
function corpoDa(sql: string, da: number): string {
    const resto = sql.slice(da)
    const apertura = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(resto)
    if (!apertura) return ''
    const tag = apertura[1]
    const inizio = apertura.index + apertura[0].length
    const fine = resto.indexOf(tag, inizio)
    if (fine < 0) return ''
    return resto
        .slice(inizio, fine)
        .split('\n')
        .map((r) => r.replace(/--.*$/, ''))
        .join('\n')
}

/** Ultima definizione di ogni funzione: nome qualificato → { file, corpo }. */
function ultimeDefinizioni(): Map<string, { file: string; corpo: string }> {
    const ultime = new Map<string, { file: string; corpo: string }>()
    for (const { file, sql } of CONTENUTO) {
        for (const m of sql.matchAll(DEFINIZIONE)) {
            const nome = `${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`
            ultime.set(nome, { file, corpo: corpoDa(sql, m.index ?? 0) })
        }
    }
    return ultime
}

/** Le INSERT in app_log del corpo che arrivano al `;` senza un `ON CONFLICT`. */
function insertSenzaConflitto(corpo: string): number {
    let n = 0
    for (const m of corpo.matchAll(INSERT_APP_LOG)) {
        const da = m.index ?? 0
        const fine = corpo.indexOf(';', da)
        const istruzione = corpo.slice(da, fine < 0 ? undefined : fine)
        if (!/\bon\s+conflict\b/i.test(istruzione)) n++
    }
    return n
}

describe('lock architettura · i battiti di app_log scritti dal database contano', () => {
    const ultime = ultimeDefinizioni()
    const conLog = [...ultime].filter(([, d]) => SCRIVE_APP_LOG.test(d.corpo))

    it('lo scanner vede le funzioni che scrivono in app_log (senza, il resto sarebbe verde sul vuoto)', () => {
        // Misurato in produzione il 19/10: 29 funzioni scrivono in app_log.
        expect(ultime.size, 'nessuna funzione trovata nelle migrazioni').toBeGreaterThan(100)
        expect(conLog.length, 'troppo poche funzioni con un INSERT in app_log: lo scanner è cieco?').toBeGreaterThanOrEqual(20)
    })

    it('🔴 ogni INSERT INTO public.app_log di una funzione ha il suo ON CONFLICT (fingerprint, giorno)', () => {
        const senza = conLog
            .map(([nome, d]) => ({ nome, file: d.file, n: insertSenzaConflitto(d.corpo) }))
            .filter((x) => x.n > 0)
            .map((x) => `${x.nome} (${x.file}): ${x.n}`)
        expect(
            senza,
            'Queste funzioni scrivono in app_log senza `ON CONFLICT (fingerprint, giorno) DO UPDATE SET ' +
                'occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), …`: dal secondo evento ' +
                'del giorno l\'INSERT fallisce con 23505 e il battito smette di contare.',
        ).toEqual([])
    })
})
