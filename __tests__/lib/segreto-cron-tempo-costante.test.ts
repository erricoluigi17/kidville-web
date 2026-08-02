import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { segretoCronValido } from '@/lib/security/segreto-cron'

/**
 * IL SEGRETO DEI CRON ERA L'UNICA CREDENZIALE DEL REPO CONFRONTATA CON `!==`.
 *
 * Il sigillo degli allegati (`lib/allegati/sigillo.ts:73`) e i ticket OTP
 * (`lib/auth/otp-ticket.ts:33`) usano entrambi `timingSafeEqual`; le sette route
 * di cron confrontavano `secret !== process.env.CRON_SECRET`, cioè con un
 * confronto che esce al primo byte diverso.
 *
 * Onestà sulla gravità: contro un segreto casuale, su HTTP, attraverso la rete e
 * un runtime serverless, un attacco a tempo non è praticabile. Il motivo per cui
 * si chiude lo stesso non è l'attacco: è che la regola «le credenziali si
 * confrontano in tempo costante» esisteva già in questo repo, applicata a due
 * strade su tre. Una regola con un'eccezione non dichiarata non è una regola —
 * ed è la firma di difetto che questo progetto ha già pagato più volte.
 *
 * Il fail-closed conta più del tempo costante, ed è la parte che qui si verifica
 * davvero: senza `CRON_SECRET` configurato NESSUNA chiamata deve passare. Il
 * `!==` di prima aveva la stessa proprietà solo per caso — `undefined !== ''` è
 * vero — e bastava un `secret` vuoto in arrivo e una variabile vuota in ambiente
 * per aprirla.
 */

const ORIGINALE = process.env.CRON_SECRET
afterEach(() => {
    if (ORIGINALE === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = ORIGINALE
})

describe('segretoCronValido — fail-closed prima di tutto', () => {
    it('segreto giusto ⇒ passa', () => {
        process.env.CRON_SECRET = 'un-segreto-lungo-e-casuale'
        expect(segretoCronValido('un-segreto-lungo-e-casuale')).toBe(true)
    })

    it('segreto sbagliato ⇒ non passa', () => {
        process.env.CRON_SECRET = 'un-segreto-lungo-e-casuale'
        expect(segretoCronValido('un-segreto-lungo-e-casualF')).toBe(false)
    })

    it('lunghezza diversa ⇒ non passa (e non lancia)', () => {
        process.env.CRON_SECRET = 'un-segreto-lungo-e-casuale'
        expect(segretoCronValido('corto')).toBe(false)
        expect(segretoCronValido('un-segreto-lungo-e-casuale-piu-lungo')).toBe(false)
    })

    it('header assente ⇒ non passa', () => {
        process.env.CRON_SECRET = 'un-segreto-lungo-e-casuale'
        expect(segretoCronValido(null)).toBe(false)
        expect(segretoCronValido(undefined)).toBe(false)
        expect(segretoCronValido('')).toBe(false)
    })

    it('VARIABILE NON CONFIGURATA ⇒ non passa NIENTE, nemmeno la stringa vuota', () => {
        // È il caso che conta: se `CRON_SECRET` manca in un ambiente, la porta
        // dei cron non deve diventare aperta. Vale anche con la variabile
        // presente ma vuota, che è il modo in cui una configurazione sbagliata si
        // presenta più spesso (una riga senza valore nel pannello).
        delete process.env.CRON_SECRET
        expect(segretoCronValido('')).toBe(false)
        expect(segretoCronValido('qualunque')).toBe(false)
        process.env.CRON_SECRET = ''
        expect(segretoCronValido('')).toBe(false)
    })
})

describe('lock — nessuna route confronta CRON_SECRET a mano', () => {
    const RADICE = process.cwd()

    /** Ogni `route.ts` sotto src/app/api. */
    function routes(dir = path.join(RADICE, 'src/app/api')): string[] {
        const out: string[] = []
        for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, v.name)
            if (v.isDirectory()) out.push(...routes(p))
            else if (v.name === 'route.ts') out.push(p)
        }
        return out
    }

    /**
     * DEBITO DICHIARATO. `news/cron/run` è in lavorazione da un altro intervento
     * nello stesso ciclo (il ricontrollo del consenso fotografico sui post
     * pubblicati): toccarlo qui avrebbe sovrascritto quel lavoro. Va portato alla
     * funzione condivisa appena quel lavoro è dentro. Questa mappa può solo
     * accorciarsi.
     */
    const DEBITO = new Set(['src/app/api/news/cron/run/route.ts'])

    it('il confronto vive in un posto solo (`lib/security/segreto-cron`)', () => {
        const aMano: string[] = []
        for (const f of routes()) {
            const rel = path.relative(RADICE, f)
            const src = fs.readFileSync(f, 'utf8')
            if (!src.includes('CRON_SECRET')) continue
            if (DEBITO.has(rel)) continue
            // Il confronto diretto: `=== process.env.CRON_SECRET` o `!==`.
            if (/[!=]==\s*process\.env\.CRON_SECRET/.test(src)) aMano.push(rel)
        }
        expect(
            aMano.sort(),
            'confronto a mano del segreto dei cron: usa `segretoCronValido()` da ' +
            '`@/lib/security/segreto-cron`. Il sigillo degli allegati e i ticket OTP ' +
            'usano già `timingSafeEqual`: una regola con un\'eccezione non dichiarata ' +
            'non è una regola.',
        ).toEqual([])
    })

    it('CONTROLLO POSITIVO: la scansione vede davvero delle route con CRON_SECRET', () => {
        const conSegreto = routes().filter((f) => fs.readFileSync(f, 'utf8').includes('CRON_SECRET'))
        expect(conSegreto.length, 'nessuna route trovata: la scansione è rotta').toBeGreaterThan(3)
    })
})
