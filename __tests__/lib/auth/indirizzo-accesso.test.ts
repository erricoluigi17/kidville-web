/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'indirizzo che si scrive in anagrafica e l'indirizzo con cui si entra erano
 * due cose diverse, e nessuno le confrontava mai.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MISURATO IN PRODUZIONE (2026-09-04): **4 anagrafiche genitore** hanno
 * `parents.emails[1]` diverso da `auth.users.email`. Tutte e quattro con
 * `last_sign_in_at` mai valorizzato. Una di loro ha ricevuto **13 rigenerazioni
 * di credenziali in un solo giorno**.
 *
 * Il meccanismo, per intero: `POST /api/admin/regenerate-credentials` prende
 * l'indirizzo da `parents.emails` e ci manda l'email — che quindi ARRIVA — con
 * dentro la riga «Email di accesso: <quell'indirizzo>». La password però viene
 * scritta sull'account risolto da `parents.auth_user_id`, che vive su un altro
 * indirizzo. La famiglia digita quello che ha letto, GoTrue non lo conosce, e
 * risponde «credenziali non valide». Si rigenera: cambia la password, non
 * l'indirizzo. **Nessun numero di rigenerazioni potrà mai ripararlo.**
 *
 * La causa è a `parent-identity.ts`: `if (!authUserId) { …risolvi per email… }`.
 * Se il ponte esiste già, l'intero blocco viene saltato, e non c'è un solo punto
 * del repo in cui i due indirizzi vengano confrontati.
 *
 * ─── PERCHÉ L'ANAGRAFICA VINCE ──────────────────────────────────────────────
 *
 * Decisione del titolare del 2026-09-04. Due dei quattro casi la confermano da
 * soli: i domini degli ACCOUNT sono `gmali.com` e `gmailm.com` — refusi di
 * domini che non esistono — mentre le anagrafiche portano l'indirizzo giusto.
 * L'anagrafica è la cosa che la Segreteria mantiene; l'account è dove il refuso
 * si è fossilizzato il giorno in cui è nato.
 *
 * ⚠️ Il rovescio va detto: se il refuso sta nell'anagrafica, l'accesso si sposta
 * su un indirizzo sbagliato. Per questo ogni spostamento viene loggato e
 * dichiarato al chiamante — visibile e rifacibile, non silenzioso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...actual, logEvento: h.logEvento }
})

import { normalizzaIndirizzo, allineaIndirizzoAccesso } from '@/lib/auth/indirizzo-accesso'

const UID = '11111111-1111-4111-8111-111111111111'
const ALTRO = '22222222-2222-4222-8222-222222222222'

interface Stato {
    emailAccount?: string | null
    erroreLettura?: unknown
    erroreScrittura?: unknown
    erroreUtenti?: { message: string } | null
    /** Righe di `utenti` per email, per il controllo preventivo di collisione. */
    utentiPerEmail?: Record<string, string>
}

function admin(stato: Stato) {
    const calls = {
        update: [] as Array<{ uid: string; attrs: Record<string, unknown> }>,
        utentiUpdate: [] as Array<Record<string, unknown>>,
    }
    const client = {
        auth: {
            admin: {
                getUserById: async () =>
                    stato.erroreLettura
                        ? { data: { user: null }, error: stato.erroreLettura }
                        : { data: { user: { id: UID, email: stato.emailAccount ?? null } }, error: null },
                updateUserById: async (uid: string, attrs: Record<string, unknown>) => {
                    calls.update.push({ uid, attrs })
                    return stato.erroreScrittura
                        ? { data: { user: null }, error: stato.erroreScrittura }
                        : { data: { user: { id: uid } }, error: null }
                },
            },
        },
        from(tabella: string) {
            if (tabella !== 'utenti') throw new Error('tabella inattesa: ' + tabella)
            return {
                select: () => ({
                    eq: (_c: string, v: string) => ({
                        maybeSingle: async () => {
                            const id = (stato.utentiPerEmail ?? {})[v]
                            return { data: id ? { id } : null, error: null }
                        },
                    }),
                }),
                update: (vals: Record<string, unknown>) => ({
                    eq: async () => {
                        calls.utentiUpdate.push(vals)
                        return { error: stato.erroreUtenti ?? null }
                    },
                }),
            }
        },
    }
    return { client: client as unknown as SupabaseClient, calls }
}

beforeEach(() => h.logEvento.mockClear())

describe('normalizzaIndirizzo', () => {
    it('toglie gli spazi e abbassa le maiuscole', () => {
        expect(normalizzaIndirizzo('  Elena.Rossi@Libero.IT ')).toBe('elena.rossi@libero.it')
    })
    it('è null per tutto ciò che non è un indirizzo', () => {
        expect(normalizzaIndirizzo(null)).toBeNull()
        expect(normalizzaIndirizzo('   ')).toBeNull()
        expect(normalizzaIndirizzo(42)).toBeNull()
        expect(normalizzaIndirizzo('senza-chiocciola')).toBeNull()
    })
})

describe('allineaIndirizzoAccesso', () => {
    it('non scrive niente quando i due indirizzi differiscono solo per maiuscole o spazi', async () => {
        // Una scrittura inutile a ogni rigenerazione di ogni genitore: rumore su
        // GoTrue e una riga di audit che dice che è cambiato qualcosa quando non è
        // cambiato niente.
        const a = admin({ emailAccount: 'Mario.Rossi@Libero.it' })
        const esito = await allineaIndirizzoAccesso(a.client, UID, '  mario.rossi@libero.it  ')
        expect(esito.stato).toBe('gia-allineato')
        expect(a.calls.update).toHaveLength(0)
        expect(a.calls.utentiUpdate).toHaveLength(0)
    })

    it('IL CASO REALE: account su un dominio, anagrafica su un altro → si sposta l’account', async () => {
        const a = admin({ emailAccount: 'elenaschettino93@gmail.com' })
        const esito = await allineaIndirizzoAccesso(a.client, UID, 'elena.schettino93@libero.it')

        expect(esito.stato).toBe('allineato')
        expect(a.calls.update).toEqual([
            // `email_confirm: true` insieme all'indirizzo: senza, GoTrue metterebbe
            // il nuovo indirizzo in attesa di conferma e il login resterebbe chiuso
            // — cioè si sarebbe spostato il muro invece di toglierlo.
            { uid: UID, attrs: { email: 'elena.schettino93@libero.it', email_confirm: true } },
        ])
        // `utenti.email` è la copia applicativa: se resta indietro, la strada veloce
        // di `findAuthUserIdByEmail` smette di trovare questa persona.
        expect(a.calls.utentiUpdate).toEqual([{ email: 'elena.schettino93@libero.it' }])
    })

    it('rifiuta senza scrivere se quell’indirizzo è già di un ALTRO account', async () => {
        // Due anagrafiche per la stessa persona, oppure due persone sulla stessa
        // casella. Il codice non può scegliere: si ferma e lo dice.
        const a = admin({
            emailAccount: 'vecchio@x.it',
            utentiPerEmail: { 'nuovo@x.it': ALTRO },
        })
        const esito = await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')
        expect(esito.stato).toBe('in-uso-da-altri')
        expect(a.calls.update, 'nessuna scrittura parziale').toHaveLength(0)
    })

    it('riconosce anche il rifiuto di GoTrue quando la collisione sfugge al controllo preventivo', async () => {
        // `utenti` può non avere la riga dell'altro account: la verità finale ce
        // l'ha GoTrue, e il suo `email_exists` non va confuso con un guasto.
        const a = admin({ emailAccount: 'vecchio@x.it', erroreScrittura: { status: 422, code: 'email_exists' } })
        expect((await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')).stato).toBe('in-uso-da-altri')
    })

    it('un guasto in scrittura NON lascia credere che l’allineamento sia avvenuto', async () => {
        const a = admin({ emailAccount: 'vecchio@x.it', erroreScrittura: { status: 500, message: 'boom' } })
        const esito = await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')
        expect(esito.stato).toBe('non-riuscito')
        expect(a.calls.utentiUpdate, 'utenti non si tocca se auth non è cambiato').toHaveLength(0)
    })

    it('se `utenti` non si aggiorna l’accesso funziona lo stesso, ma il difetto si dichiara', async () => {
        // GoTrue è la fonte del login: l'accesso è già riparato. Ma `utenti.email`
        // disallineato spegne una strada di ricerca, e tacerlo lo renderebbe
        // invisibile finché non serve.
        const a = admin({ emailAccount: 'vecchio@x.it', erroreUtenti: { message: 'duplicate key' } })
        const esito = await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')
        expect(esito.stato).toBe('allineato')
        expect(esito.stato === 'allineato' && esito.copiaApplicativaIndietro).toBe(true)
        expect(h.logEvento.mock.calls.some(([, livello]) => livello === 'error')).toBe(true)
    })

    it('se non si riesce a LEGGERE l’indirizzo dell’account non si scrive niente', async () => {
        // Un errore di lettura non è «gli indirizzi sono diversi». Scrivere qui
        // vorrebbe dire riscrivere il login di qualcuno sulla base di un'ipotesi.
        const a = admin({ erroreLettura: { status: 500, message: 'giù' } })
        const esito = await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')
        expect(esito.stato).toBe('sconosciuto')
        expect(a.calls.update).toHaveLength(0)
    })

    it('un account SENZA indirizzo non è «diverso»: è ignoto, e non si tocca', async () => {
        const a = admin({ emailAccount: null })
        expect((await allineaIndirizzoAccesso(a.client, UID, 'nuovo@x.it')).stato).toBe('sconosciuto')
        expect(a.calls.update).toHaveLength(0)
    })

    it('NESSUN INDIRIZZO NEI LOG: escono uuid, esiti e booleani, mai una casella', async () => {
        // `email` uscirebbe hashato, ma `email_account` non è in lista bianca e
        // cadrebbe nel ramo generico `[redatto:str/N]`, che regala la LUNGHEZZA
        // dell'indirizzo. Sono dati di famiglie: si logga il fatto, non il dato.
        const a = admin({ emailAccount: 'elenaschettino93@gmail.com' })
        await allineaIndirizzoAccesso(a.client, UID, 'elena.schettino93@libero.it')
        const scritto = JSON.stringify(h.logEvento.mock.calls)
        expect(scritto).not.toContain('@')
        expect(scritto).toContain(UID)
    })

    it('non lancia mai, qualunque cosa faccia il client', async () => {
        const rotto = { auth: { admin: { getUserById: async () => { throw new Error('boom') } } } } as unknown as SupabaseClient
        await expect(allineaIndirizzoAccesso(rotto, UID, 'x@y.it')).resolves.toMatchObject({ stato: 'sconosciuto' })
    })
})
