import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_DOMANDA, STATO_DOMANDA_IN_ATTESA } from '@/lib/iscrizioni/stati'

/**
 * Gli stati di una domanda d'iscrizione vivono in UN posto. Dalla sessione 1 della seconda
 * serie di robustezza la stessa lista è anche un CHECK in SQL
 * (`enrollment_submissions_status_ammesso`): il lock `stati-vincolati-in-sql` confronta il
 * vincolo con questa costante, e una copia privata nella route sarebbe una terza lista che
 * nessuno confronta.
 */
describe("gli stati di una domanda d'iscrizione", () => {
    it('sono tre, con i nomi che stanno in tabella', () => {
        expect([...STATI_DOMANDA]).toEqual(['pending', 'approved', 'rejected'])
        expect(STATO_DOMANDA_IN_ATTESA).toBe('pending')
    })

    it('la route delle iscrizioni non ne tiene una copia sua', () => {
        const route = readFileSync(join(process.cwd(), 'src/app/api/admin/iscrizioni/route.ts'), 'utf8')
        expect(route).not.toMatch(/const\s+STATI_DOMANDA\s*=/)
        expect(route).toMatch(/from '@\/lib\/iscrizioni\/stati'/)
    })
})
