import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * DUE GIRI DELL'IMPORT NON POSSONO SOVRAPPORSI — e questo è un vincolo, non una
 * convenzione.
 *
 * ─── PERCHÉ I GIRI SONO PIÙ D'UNO ───────────────────────────────────────────
 * Il 2026-08-22 il cron ha lavorato 60 domande in 244 secondi e si è fermato per
 * `tempo-scaduto` con 50 domande in coda, a un tetto di 300 email che non aveva
 * nemmeno sfiorato. L'intervallo mediano fra un'email e l'altra era 3,35 s: ~27-29
 * andate-e-ritorni in serie per domanda. Con 352 domande residue servono ~20 minuti
 * di lavoro, cioè più di quanto un `maxDuration` di 300 s possa contenere. La cura è
 * far ripartire il giro più volte.
 *
 * ─── PERCHÉ LA DISTANZA FRA I GIRI È UN LOCK ────────────────────────────────
 * `riprendiInvitiSospesi` **non ha un claim**: legge le righe `da_inviare`/`fallita`
 * e comincia a spedire. Due invocazioni contemporanee leggerebbero LE STESSE righe e
 * spedirebbero due volte alla stessa persona — e `spedisci`, quando la password è
 * nulla, la RIGENERA: la seconda email invaliderebbe la password appena consegnata
 * dalla prima. Un genitore chiuso fuori da una corsa fra due cron, con in mano una
 * password che non è più valida e nessun modo di saperlo.
 *
 * Finché il cron era uno solo il problema non esisteva. Dal momento in cui i giri
 * diventano più d'uno, l'unica cosa che lo tiene chiuso è che **due accensioni
 * distino più di quanto un giro possa durare**. Quella distanza smette di essere una
 * scelta di comodo e diventa il vincolo: qui viene misurata, non ricordata.
 */

const MIGRAZIONI_DIR = join(process.cwd(), 'supabase', 'migrations')
const ROUTE = join(process.cwd(), 'src', 'app', 'api', 'iscrizione', 'import-massivo', 'route.ts')
const JOB = 'iscrizioni-import-invio'

/** L'ultima migrazione che installa il job: è quella che vince in produzione. */
function ultimoSchedule(): string | null {
    const file = readdirSync(MIGRAZIONI_DIR).filter((f) => f.endsWith('.sql')).sort()
    let trovato: string | null = null
    const re = new RegExp(`cron\\.schedule\\s*\\(\\s*'${JOB}'\\s*,\\s*'([^']+)'`, 'i')
    for (const f of file) {
        const m = readFileSync(join(MIGRAZIONI_DIR, f), 'utf8').match(re)
        if (m) trovato = m[1]
    }
    return trovato
}

/** I minuti dell'ora a cui il job si accende, dal campo `minute` del cron. */
function minutiDiAccensione(schedule: string): number[] {
    const campoMinuti = schedule.trim().split(/\s+/)[0]
    return campoMinuti.split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n)).sort((a, b) => a - b)
}

function maxDurationSecondi(): number | null {
    const m = readFileSync(ROUTE, 'utf8').match(/export const maxDuration\s*=\s*(\d+)/)
    return m ? Number(m[1]) : null
}

describe('lock architettura · i giri dell\'import iscrizioni non si sovrappongono', () => {
    const schedule = ultimoSchedule()
    const maxDuration = maxDurationSecondi()

    it('lo schedule e il `maxDuration` si leggono (sanity: senza, tutto il resto sarebbe verde sul vuoto)', () => {
        // Se questo `it` cade, i due qui sotto starebbero guardando `null` e direbbero
        // verde su niente. È la stessa prova di sanità di `ritmo-email-un-posto-solo`.
        expect(schedule, `nessun cron.schedule('${JOB}', …) trovato nelle migrazioni`).toBeTruthy()
        expect(maxDuration, 'nessun `export const maxDuration` nella route dell\'import').toBeTruthy()
    })

    it('fra due accensioni passa PIÙ di quanto un giro possa durare', () => {
        const minuti = minutiDiAccensione(String(schedule))
        expect(minuti.length, `campo minuti non interpretabile: "${schedule}"`).toBeGreaterThan(0)
        if (minuti.length === 1) return // un giro solo: non c'è niente da sovrapporre

        const distanze = minuti.slice(1).map((m, i) => m - minuti[i])
        const minimaMs = Math.min(...distanze) * 60_000
        expect(
            minimaMs,
            `due accensioni distano ${minimaMs / 1000}s ma un giro può durare ${maxDuration}s: ` +
            'possono sovrapporsi, e `riprendiInvitiSospesi` non ha un claim che lo impedisca — ' +
            'due giri spedirebbero alla stessa persona e il secondo invaliderebbe la password del primo',
        ).toBeGreaterThan(Number(maxDuration) * 1000)
    })

    it('le accensioni stanno in un\'ora ragionevole per una famiglia', () => {
        // Una password non arriva alle tre di notte: il campo ORE resta un valore
        // solo, e questo test è ciò che impedisce a un `*/10` distratto di
        // trasformare il giro in un lavoro notturno.
        const campoOre = String(schedule).trim().split(/\s+/)[1]
        expect(campoOre, `il campo ore è "${campoOre}": deve restare un orario unico`).toMatch(/^\d+$/)
    })
})
