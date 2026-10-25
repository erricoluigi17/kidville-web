import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { finestraDaCadenza } from '@/lib/health/cron-esiti'

/**
 * LOCK · OGNI CADENZA DI `pg_cron` SCRITTA NEL REPO HA UNA FINESTRA.
 *
 * Il controllo `cron-esiti` di `/api/health` (sessione 7 della seconda serie) giudica ogni job
 * attivo con la finestra della sua cadenza (`finestraDaCadenza`). Una cadenza che quella funzione
 * non sa leggere finisce nel dettaglio come «cadenza non letta» e il job resta SENZA sorveglianza:
 * un allarme che non può suonare. Se questo lock è rosso, o si insegna la forma nuova a
 * `finestraDaCadenza` (con il suo test di numeri letterali), o si sceglie una cadenza che sa già
 * leggere. Il 20/10 le cadenze nel repo erano 31, tutte leggibili.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

const CADENZE = readdirSync(CARTELLA)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
        [...readFileSync(join(CARTELLA, file), 'utf8').matchAll(/cron\.schedule\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/gi)].map(
            (m) => ({ file, job: m[1], cadenza: m[2] }),
        ),
    )

describe('lock · le cadenze dei cron si leggono', () => {
    it('le trova (senza, questo lock sarebbe verde sul vuoto)', () => {
        expect(CADENZE.length).toBeGreaterThanOrEqual(31)
    })

    it('🔴 ogni cadenza ha una finestra', () => {
        const illeggibili = CADENZE.filter((c) => finestraDaCadenza(c.cadenza) === null).map(
            (c) => `${c.job} «${c.cadenza}» (${c.file})`,
        )
        expect(
            illeggibili,
            `Queste cadenze non hanno una finestra in finestraDaCadenza (src/lib/health/cron-esiti.ts): ` +
                `il controllo cron-esiti non potrebbe mai dire che il job è fermo.\n${illeggibili.join('\n')}`,
        ).toEqual([])
    })
})
