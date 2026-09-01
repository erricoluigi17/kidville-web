import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `PATCH`/`DELETE /api/locker/materials` — lo scope si risolve dalla SEZIONE, non
 * dal nome della classe.
 *
 * ─── IL DIFETTO, misurato sullo schema vero ─────────────────────────────────
 * I due handler leggevano `locker_config.classe_sezione` e lo passavano a
 * `assertClasseNomeInScope`. Due guasti in una riga sola:
 *
 *  1. `classe_sezione` è testo LIBERO e NULLABLE. Con `null` il gate non veniva
 *     nemmeno chiamato — `if (row?.classe_sezione)` — e la riga si modificava o
 *     si cancellava SENZA NESSUN CONTROLLO. Non sapere di chi è una riga non è
 *     un permesso: è la ragione per cui bisogna fermarsi.
 *  2. Il nome di classe non è una chiave univoca da quando le sedi sono tre.
 *     «2 ANNI» esiste sia ad Aversa sia a Cesa: la maestra di una sede passava
 *     il gate sul proprio omonimo e riscriveva la configurazione dell'altra.
 *     Lo dice il commento di `assertClasseNomeInScope` stesso — quel gate
 *     impedisce di NOMINARE una classe altrui, non di toccare una riga altrui.
 *
 * Dal 2026-07-30 la riga porta `section_id`, che è la chiave vera e ha la sua
 * `scuola_id`: `assertSezioneInScope` risolve la sede da lì.
 *
 * ─── Come è scritto questo test ─────────────────────────────────────────────
 * Il modulo `@/lib/auth/scope` NON è mockato: gira quello vero. Un gate mockato
 * proverebbe solo che la route chiama una funzione con un certo nome, cioè
 * esattamente ciò che il codice difettoso faceva già — chiamava un gate, solo
 * quello sbagliato, e su un valore che il più delle volte era `null`. Qui il
 * 403 lo produce `assertSezioneInScope` leggendo `sections.scuola_id` dal finto
 * database, che è il percorso vero.
 */

const SEDE_MIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_ALTRUI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEZIONE_MIA = '11111111-1111-4111-8111-111111111111'
/** «2 ANNI» di Cesa, per chi lavora ad Aversa: stesso nome, altra sede. */
const SEZIONE_ALTRUI = '22222222-2222-4222-8222-222222222222'
const RIGA = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    /** Risposta di `.maybeSingle()`/`.single()`, per tabella. */
    righe: {} as Record<string, unknown>,
    /** Risposta del thenable (le letture d'elenco), per tabella. */
    elenchi: {} as Record<string, unknown[]>,
    /** Ogni `(tabella, metodo)` toccato: è così che si prova che la DELETE NON è partita. */
    chiamate: [] as Array<{ tabella: string; metodo: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireDocente: h.requireDocente,
    requireUser: vi.fn(),
}))
// ⚠️ `@/lib/audit/scrittura`, al SINGOLARE. Un `vi.mock` con il percorso sbagliato non
// aggancia niente e non fallisce: il modulo vero resterebbe in gioco e il test misurerebbe
// un'altra cosa restando verde.
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: (tabella: string) => {
            const qb: Record<string, unknown> = {}
            const rec = (m: string) => () => {
                h.chiamate.push({ tabella, metodo: m })
                return qb
            }
            for (const m of ['select', 'eq', 'in', 'order', 'is', 'not', 'update', 'delete', 'insert']) {
                qb[m] = rec(m)
            }
            qb.maybeSingle = async () => ({ data: h.righe[tabella] ?? null, error: null })
            qb.single = async () => ({ data: h.righe[tabella] ?? null, error: null })
            ;(qb as { then: unknown }).then = (res: (v: unknown) => unknown) =>
                res({ data: h.elenchi[tabella] ?? [], error: null })
            return qb
        },
    }),
}))

import { PATCH, DELETE } from '@/app/api/locker/materials/route'
import { logScrittura } from '@/lib/audit/scrittura'

const delReq = (id: string) =>
    ({
        url: `http://test/api/locker/materials?id=${id}`,
        headers: new Headers(),
        cookies: { get: () => undefined },
    }) as never

const patchReq = (id: string, corpo: Record<string, unknown> = { attivo: false }) =>
    new Request('http://test/api/locker/materials', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ...corpo }),
    }) as never

/** Ha toccato la riga di configurazione? */
const haScritto = () =>
    h.chiamate.some((c) => c.tabella === 'locker_config' && (c.metodo === 'delete' || c.metodo === 'update'))

beforeEach(() => {
    vi.clearAllMocks()
    h.chiamate = []
    h.righe = {}
    h.elenchi = {}
    // `segreteria`: vede tutte le classi del PROPRIO plesso (`vedeTutteLeClassi`), quindi
    // l'unico ostacolo che può incontrare è la SEDE. È il ruolo che rende il test una prova
    // sull'isolamento fra plessi e non sull'assegnazione delle sezioni.
    h.requireDocente.mockResolvedValue({
        user: { id: 'staff-1', role: 'segreteria', scuola_id: SEDE_MIA },
    })
})

describe('DELETE /api/locker/materials — la riga di un\'altra sede non si cancella', () => {
    it('403 e NESSUNA delete: sezione di un altro plesso, `classe_sezione` a null', async () => {
        // La forma esatta del difetto: la riga PUNTA a una sezione di Cesa e non ha
        // nome-classe. Il vecchio codice, che leggeva `classe_sezione`, saltava il gate e
        // cancellava. Le due cose insieme non sono un caso limite: `section_id` è la chiave
        // dal 2026-07-30 e `classe_sezione` è rimasto un residuo che può benissimo essere nullo.
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_ALTRUI, classe_sezione: null },
            sections: { id: SEZIONE_ALTRUI, scuola_id: SEDE_ALTRUI },
        }

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBe(403)
        expect(haScritto(), 'la DELETE è partita lo stesso').toBe(false)
        expect(logScrittura).not.toHaveBeenCalled()
    })

    it('403 anche col nome-classe OMONIMO valorizzato («2 ANNI» esiste in due sedi)', async () => {
        // Il controllo che smaschera la vecchia difesa: qui `classe_sezione` c'è, e col
        // vecchio gate sarebbe bastata perché il nome esiste anche nel plesso di chi chiama.
        // La sede la decide la SEZIONE, non la stringa.
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_ALTRUI, classe_sezione: '2 ANNI' },
            sections: { id: SEZIONE_ALTRUI, scuola_id: SEDE_ALTRUI },
        }

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBe(403)
        expect(haScritto()).toBe(false)
    })

    it('la riga LEGACY senza `section_id` si rifiuta: non sapere di chi è non è un permesso', async () => {
        // Non esiste modo di dire a quale plesso appartenga questa riga. L'unica risposta
        // onesta è fermarsi — e soprattutto NON cancellare. Prima passava liscia.
        h.righe = { locker_config: { id: RIGA, section_id: null, classe_sezione: null } }

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(res.status).toBeLessThan(500)
        expect(haScritto(), 'una riga senza sezione è stata cancellata comunque').toBe(false)
    })

    it('la riga INESISTENTE non apre la strada: niente riga, niente cancellazione', async () => {
        // `maybeSingle()` a `null` è lo stesso stato di una lettura che non ha trovato nulla.
        // Col vecchio codice `row?.classe_sezione` era falsy e la DELETE partiva lo stesso —
        // su un id che non esiste è un no-op, ma il ramo è quello che lasciava passare tutto.
        h.righe = {}

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(haScritto()).toBe(false)
    })

    it('200 e delete eseguita quando la sezione È del proprio plesso (controllo positivo)', async () => {
        // Senza questo, «403 sempre» supererebbe tutte le prove qui sopra — e un gate che
        // nega tutto viene tolto dopo la prima segnalazione della segreteria.
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_MIA, classe_sezione: null },
            sections: { id: SEZIONE_MIA, scuola_id: SEDE_MIA },
        }

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBe(200)
        expect(h.chiamate.some((c) => c.tabella === 'locker_config' && c.metodo === 'delete')).toBe(true)
        expect(logScrittura).toHaveBeenCalled()
    })
})

describe('PATCH /api/locker/materials — la riga di un\'altra sede non si modifica', () => {
    it('403 e NESSUNA update: sezione di un altro plesso, `classe_sezione` a null', async () => {
        // Stesso difetto, stessa correzione: due handler nello stesso file sbagliavano la
        // stessa riga, ed è la forma con cui questa classe di guasti sopravvive.
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_ALTRUI, classe_sezione: null },
            sections: { id: SEZIONE_ALTRUI, scuola_id: SEDE_ALTRUI },
        }

        const res = await PATCH(patchReq(RIGA))

        expect(res.status).toBe(403)
        expect(haScritto(), 'la UPDATE è partita lo stesso').toBe(false)
        expect(logScrittura).not.toHaveBeenCalled()
    })

    it('200 e update eseguita nel proprio plesso (controllo positivo)', async () => {
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_MIA, classe_sezione: null },
            sections: { id: SEZIONE_MIA, scuola_id: SEDE_MIA },
        }

        const res = await PATCH(patchReq(RIGA))

        expect(res.status).toBe(200)
        expect(h.chiamate.some((c) => c.tabella === 'locker_config' && c.metodo === 'update')).toBe(true)
    })

    it('il 403 non racconta lo schema al chiamante', async () => {
        h.righe = {
            locker_config: { id: RIGA, section_id: SEZIONE_ALTRUI, classe_sezione: null },
            sections: { id: SEZIONE_ALTRUI, scuola_id: SEDE_ALTRUI },
        }
        const corpo = JSON.stringify(await (await PATCH(patchReq(RIGA))).json())
        expect(corpo).not.toContain('locker_config')
        expect(corpo).not.toContain('section_id')
        expect(corpo).not.toContain(SEZIONE_ALTRUI)
        expect(corpo).not.toContain(SEDE_ALTRUI)
    })
})

describe('il gate non è aggirabile spegnendo il ruolo', () => {
    it('401 prima di qualunque lettura: `requireDocente` resta il primo cancello', async () => {
        h.requireDocente.mockResolvedValue({
            response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
        })

        const res = await DELETE(delReq(RIGA))

        expect(res.status).toBe(401)
        expect(h.chiamate).toHaveLength(0)
    })
})
