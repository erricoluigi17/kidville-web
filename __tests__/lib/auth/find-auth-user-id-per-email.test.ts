import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findAuthUserIdByEmail } from '@/lib/auth/parent-identity'

/**
 * «ESISTE GIÀ UN ACCOUNT CON QUESTA EMAIL?» — la domanda più cara del giro.
 *
 * ─── LA MISURA ──────────────────────────────────────────────────────────────
 * Il 2026-08-22 il cron delle iscrizioni ha lavorato 60 domande in 244 secondi e si
 * è fermato per `tempo-scaduto` con 50 domande in coda — a un tetto di 300 email che
 * non ha nemmeno sfiorato. L'intervallo fra un'email e l'altra, letto dai timestamp
 * di `iscrizioni_inviti_credenziali`: mediano **3,35 s**, minimo 2,25, massimo 5,32.
 * Costante, senza coda lunga: non è «una query ogni tanto lenta», è un numero fisso
 * di andate-e-ritorni in serie. Resend ne pesa ~350 ms (il 10%), la pausa fra le
 * email 150 ms (il 4,5%). Il resto sono ~27-29 chiamate di rete una dietro l'altra.
 *
 * ─── PERCHÉ PROPRIO QUESTA FUNZIONE ─────────────────────────────────────────
 * L'admin API di GoTrue non ha un `getUserByEmail`, e questa funzione ripiegava su
 * `listUsers` **paginata a 100**, scandendo l'INTERA `auth.users` e confrontando le
 * email in JavaScript. Il commento diceva «accettabile alla scala attuale (decine di
 * account)», ed era vero quando è stato scritto.
 *
 * Alla scala attuale sono 166 account, cioè 2 pagine. Ma è l'unico pezzo del giro
 * **che peggiora con ciò che il giro stesso produce**: ogni account creato allunga
 * la scansione del successivo, e a fine finestra saranno ~570 account, cioè 6 pagine.
 * La 201ª e la 301ª pagina cadono dentro questa finestra di iscrizioni. Il costo per
 * domanda crescerà mentre la coda si smaltisce — che è il momento peggiore.
 *
 * La tabella `utenti` in `public` ha la colonna `email`, ha `id` uguale all'auth user
 * id, ed è tenuta allineata **dalla stessa** `ensureParentIdentity` che chiama questa
 * funzione. Una SELECT indicizzata al posto di N pagine di GoTrue.
 *
 * ⚠️ IL RIPIEGO RESTA, E NON È PRUDENZA GENERICA: esiste davvero il caso «account in
 * `auth.users` senza riga in `utenti`» — è precisamente quello che `ensureUtentiRow`
 * ripara. Degradarlo a «non esiste» creerebbe un SECONDO account per la stessa
 * persona, cioè un registro diviso in due: il danno che questa funzione esiste per
 * impedire.
 */

function fintoAdmin(opzioni: {
    utentiRiga?: { id: string } | null
    erroreUtenti?: { code: string; message: string } | null
    authUsers?: Array<{ id: string; email: string }>
}): { admin: SupabaseClient; listUsers: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> } {
    const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => ({
        data: { users: page === 1 ? (opzioni.authUsers ?? []) : [] },
        error: null,
    }))
    const select = vi.fn()
    const admin = {
        auth: { admin: { listUsers } },
        from: (tabella: string) => {
            select(tabella)
            return {
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({
                            data: opzioni.utentiRiga ?? null,
                            error: opzioni.erroreUtenti ?? null,
                        }),
                    }),
                }),
            }
        },
    } as unknown as SupabaseClient
    return { admin, listUsers, select }
}

describe('findAuthUserIdByEmail', () => {
    it('se l\'email è in `utenti`, NON scandisce auth.users', async () => {
        // È l'asserzione che conta: non «restituisce l'id giusto» (lo faceva anche
        // prima), ma «non paga N pagine di GoTrue per saperlo».
        const { admin, listUsers } = fintoAdmin({ utentiRiga: { id: 'auth-1' } })

        expect(await findAuthUserIdByEmail(admin, 'mario@esempio.it')).toBe('auth-1')
        expect(listUsers).not.toHaveBeenCalled()
    })

    it('confronta senza distinguere maiuscole e minuscole', async () => {
        const { admin, listUsers } = fintoAdmin({ utentiRiga: { id: 'auth-1' } })

        expect(await findAuthUserIdByEmail(admin, 'Mario@Esempio.IT')).toBe('auth-1')
        expect(listUsers).not.toHaveBeenCalled()
    })

    it('se in `utenti` non c\'è, ripiega sulla scansione e lo trova lo stesso', async () => {
        // Il caso «auth user senza riga utenti», che `ensureUtentiRow` ripara.
        const { admin, listUsers } = fintoAdmin({
            utentiRiga: null,
            authUsers: [{ id: 'auth-9', email: 'Mario@Esempio.it' }],
        })

        expect(await findAuthUserIdByEmail(admin, 'mario@esempio.it')).toBe('auth-9')
        expect(listUsers).toHaveBeenCalled()
    })

    it('se la lettura di `utenti` FALLISCE, ripiega: non degrada in «non esiste»', async () => {
        // Un errore PostgREST non è una risposta negativa. Confonderli qui vorrebbe
        // dire creare un doppione dell'account di una famiglia perché per un istante
        // il database non ha risposto.
        const { admin, listUsers } = fintoAdmin({
            utentiRiga: null,
            erroreUtenti: { code: '42P01', message: 'relation "utenti" does not exist' },
            authUsers: [{ id: 'auth-9', email: 'mario@esempio.it' }],
        })

        expect(await findAuthUserIdByEmail(admin, 'mario@esempio.it')).toBe('auth-9')
        expect(listUsers).toHaveBeenCalled()
    })

    it('se non c\'è né in `utenti` né in auth.users, dice null', async () => {
        const { admin } = fintoAdmin({ utentiRiga: null, authUsers: [] })
        expect(await findAuthUserIdByEmail(admin, 'nuova@esempio.it')).toBeNull()
    })
})
