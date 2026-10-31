import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento }
})

import { assertPersonaInScope, assertSchedaInScope, personeDellaSede, RUOLI_CRM } from '@/lib/crm/accesso'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * L'ACCESSO AL CRM, PROVATO CON UN DATABASE CHE FILTRA DAVVERO.
 *
 * Il finto client applica i filtri come PostgREST (`eq`, `in`, `is`): un mock piatto che risponde sempre
 * la stessa riga direbbe «sì» anche se la verifica di sede mancasse. Qui la scheda di un'altra sede
 * esiste davvero nel finto database, e a negarla deve essere il codice.
 *
 * Solo dati finti: «Famiglia Prova», uuid inventati.
 */

const SCHEDA_DI_A = '10000000-0000-4000-8000-000000000001'
const SCHEDA_DI_B = '10000000-0000-4000-8000-000000000002'
const SCHEDA_MANCANTE = '10000000-0000-4000-8000-0000000000ff'

const SEG_A = '20000000-0000-4000-8000-00000000000a'
const ADMIN_A = '20000000-0000-4000-8000-0000000000aa'
const ADMIN_MULTI = '20000000-0000-4000-8000-0000000000ab'
const SEG_B = '20000000-0000-4000-8000-00000000000b'
const DOCENTE_A = '20000000-0000-4000-8000-0000000000da'
const ARCHIVIATA_A = '20000000-0000-4000-8000-0000000000ca'
const SEG_A2 = '20000000-0000-4000-8000-0000000000a2'

beforeEach(() => {
    h.logEvento.mockClear()
})

const utente = (id: string, role: AppUser['role'], scuola_id: string): AppUser => ({ id, role, scuola_id })

function db(): DBFinto {
    return {
        crm_schede: [
            { id: SCHEDA_DI_A, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' },
            { id: SCHEDA_DI_B, scuola_id: SEDE_B, genitore_nome: 'Famiglia Prova Due' },
        ],
        utenti: [
            { id: SEG_A, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: SEG_A2, nome: 'Bruno', cognome: 'Abate', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: ADMIN_A, nome: 'Carla', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_A, archiviato_il: null },
            // admin della sede B che ha anche la sede A nel ponte `utenti_scuole`
            { id: ADMIN_MULTI, nome: 'Dario', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_B, archiviato_il: null },
            { id: SEG_B, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
            { id: DOCENTE_A, nome: 'Fabio', cognome: 'Prova', ruolo: 'educator', scuola_id: SEDE_A, archiviato_il: null },
            { id: ARCHIVIATA_A, nome: 'Gina', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: '2026-09-01T00:00:00Z' },
        ],
        utenti_scuole: [
            { utente_id: ADMIN_MULTI, scuola_id: SEDE_A },
            { utente_id: ADMIN_MULTI, scuola_id: SEDE_B },
        ],
    }
}

async function stato(r: { response: Response } | { scheda: unknown } | Response | null) {
    const res = r && 'response' in r ? r.response : (r as Response | null)
    if (!res || !('status' in res)) return null
    return { status: res.status, corpo: (await res.json()) as { codice?: string } }
}

describe('RUOLI_CRM', () => {
    it('sono la segreteria e la Direzione, non il coordinatore', () => {
        expect([...RUOLI_CRM]).toEqual(['segreteria', 'admin'])
    })
})

describe('assertSchedaInScope', () => {
    it('una scheda della propria sede → la scheda (id e sede)', async () => {
        const r = await assertSchedaInScope(creaFintoSupabase(db()), utente(SEG_A, 'segreteria', SEDE_A), SCHEDA_DI_A)
        expect(r).toEqual({ scheda: { id: SCHEDA_DI_A, scuola_id: SEDE_A } })
    })

    it('scheda di un’altra sede → 403 SEDE_NON_ACCESSIBILE', async () => {
        const r = await assertSchedaInScope(creaFintoSupabase(db()), utente(SEG_A, 'segreteria', SEDE_A), SCHEDA_DI_B)
        expect(await stato(r)).toEqual({ status: 403, corpo: expect.objectContaining({ codice: 'SEDE_NON_ACCESSIBILE' }) })
    })

    it('scheda inesistente → 404 SCHEDA_NON_TROVATA', async () => {
        const r = await assertSchedaInScope(creaFintoSupabase(db()), utente(SEG_A, 'segreteria', SEDE_A), SCHEDA_MANCANTE)
        expect(await stato(r)).toEqual({ status: 404, corpo: expect.objectContaining({ codice: 'SCHEDA_NON_TROVATA' }) })
    })

    it('la Direzione con la sede nel ponte utenti_scuole vede la scheda di quella sede', async () => {
        const r = await assertSchedaInScope(creaFintoSupabase(db()), utente(ADMIN_MULTI, 'admin', SEDE_B), SCHEDA_DI_A)
        expect(r).toEqual({ scheda: { id: SCHEDA_DI_A, scuola_id: SEDE_A } })
    })

    it('la segreteria NON eredita le sedi del ponte: solo la propria', async () => {
        // stesso ponte, ma il ruolo è segreteria: scuoleDiUtente dà il ponte solo alla Direzione
        const r = await assertSchedaInScope(creaFintoSupabase(db()), utente(ADMIN_MULTI, 'segreteria', SEDE_B), SCHEDA_DI_A)
        expect((await stato(r))?.status).toBe(403)
    })

    it('l’uuid della propria sede scritto in maiuscolo non è un diniego', async () => {
        const r = await assertSchedaInScope(
            creaFintoSupabase(db()),
            utente(SEG_A, 'segreteria', SEDE_A.toUpperCase()),
            SCHEDA_DI_A,
        )
        expect(r).toEqual({ scheda: { id: SCHEDA_DI_A, scuola_id: SEDE_A } })
    })

    it('tabelle crm assenti (schema non migrato) → 503 CRM_NON_INSTALLATO, non un 404', async () => {
        const supabase = creaFintoSupabase(db(), [], { errori: { 'crm_schede:select': { code: 'PGRST205', message: 'schema cache' } } })
        const r = await assertSchedaInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), SCHEDA_DI_A)
        expect(await stato(r)).toEqual({ status: 503, corpo: expect.objectContaining({ codice: 'CRM_NON_INSTALLATO' }) })
    })

    it('un guasto di lettura è un 500, non un «scheda non trovata»', async () => {
        const supabase = creaFintoSupabase(db(), [], { errori: { 'crm_schede:select': { code: '08006', message: 'connessione persa' } } })
        const r = await assertSchedaInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), SCHEDA_DI_A)
        expect(await stato(r)).toEqual({ status: 500, corpo: expect.objectContaining({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }) })
    })
})

describe('assertPersonaInScope', () => {
    it('segreteria della sede → null', async () => {
        expect(await assertPersonaInScope(creaFintoSupabase(db()), SEG_A, SEDE_A)).toBeNull()
    })

    it('persona docente → 422', async () => {
        const r = await assertPersonaInScope(creaFintoSupabase(db()), DOCENTE_A, SEDE_A)
        expect(await stato(r)).toEqual({ status: 422, corpo: expect.objectContaining({ codice: 'PERSONA_NON_DELLA_SEDE' }) })
    })

    it('persona segreteria di un’altra sede → 422', async () => {
        const r = await assertPersonaInScope(creaFintoSupabase(db()), SEG_B, SEDE_A)
        expect((await stato(r))?.status).toBe(422)
    })

    it('persona archiviata → 422', async () => {
        const r = await assertPersonaInScope(creaFintoSupabase(db()), ARCHIVIATA_A, SEDE_A)
        expect((await stato(r))?.status).toBe(422)
    })

    it('persona inesistente → 422 (senza dire che non esiste)', async () => {
        const r = await assertPersonaInScope(creaFintoSupabase(db()), SCHEDA_MANCANTE, SEDE_A)
        expect(await stato(r)).toEqual({ status: 422, corpo: expect.objectContaining({ codice: 'PERSONA_NON_DELLA_SEDE' }) })
    })

    it('admin con la sede in utenti_scuole → null', async () => {
        expect(await assertPersonaInScope(creaFintoSupabase(db()), ADMIN_MULTI, SEDE_A)).toBeNull()
    })

    it('admin senza quella sede (né propria né nel ponte) → 422', async () => {
        const base = db()
        base.utenti_scuole = [{ utente_id: ADMIN_MULTI, scuola_id: SEDE_B }]
        const r = await assertPersonaInScope(creaFintoSupabase(base), ADMIN_MULTI, SEDE_A)
        expect((await stato(r))?.status).toBe(422)
    })

    it('guasto di lettura → 500, non un «persona non della sede»', async () => {
        const supabase = creaFintoSupabase(db(), [], { errori: { 'utenti:select': { code: '08006', message: 'giù' } } })
        const r = await assertPersonaInScope(supabase, SEG_A, SEDE_A)
        expect((await stato(r))?.status).toBe(500)
    })
})

describe('personeDellaSede', () => {
    it('elenca segreteria e Direzione della sede, per cognome e nome; niente docenti, archiviati, altre sedi', async () => {
        const persone = await personeDellaSede(creaFintoSupabase(db()), SEDE_A)
        expect(persone.map((p) => p.id)).toEqual([SEG_A2, SEG_A, ADMIN_A, ADMIN_MULTI])
        expect(persone[0]).toEqual({ id: SEG_A2, nome: 'Bruno', cognome: 'Abate', ruolo: 'segreteria' })
    })

    it('la Direzione col ponte compare nell’elenco della sede del ponte, una volta sola', async () => {
        const base = db()
        // ora ADMIN_A è anche nel ponte della sede A: non deve comparire due volte
        base.utenti_scuole = [...(base.utenti_scuole ?? []), { utente_id: ADMIN_A, scuola_id: SEDE_A }]
        const persone = await personeDellaSede(creaFintoSupabase(base), SEDE_A)
        expect(persone.filter((p) => p.id === ADMIN_A)).toHaveLength(1)
    })

    it('un admin archiviato che sta nel ponte non compare', async () => {
        const base = db()
        const ARCHIVIATO = '20000000-0000-4000-8000-0000000000ac'
        base.utenti = [
            ...(base.utenti ?? []),
            { id: ARCHIVIATO, nome: 'Ugo', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_B, archiviato_il: '2026-09-01T00:00:00Z' },
        ]
        base.utenti_scuole = [...(base.utenti_scuole ?? []), { utente_id: ARCHIVIATO, scuola_id: SEDE_A }]
        const persone = await personeDellaSede(creaFintoSupabase(base), SEDE_A)
        expect(persone.map((p) => p.id)).not.toContain(ARCHIVIATO)
    })

    it('una segreteria nel ponte NON conta: il ponte vale per la Direzione', async () => {
        const base = db()
        base.utenti_scuole = [...(base.utenti_scuole ?? []), { utente_id: SEG_B, scuola_id: SEDE_A }]
        const persone = await personeDellaSede(creaFintoSupabase(base), SEDE_A)
        expect(persone.map((p) => p.id)).not.toContain(SEG_B)
    })

    it('una sede senza nessuno → elenco vuoto, e una riga warn crm perché non passi inosservato', async () => {
        expect(await personeDellaSede(creaFintoSupabase(db()), '30000000-0000-4000-8000-000000000003')).toEqual([])
        expect(h.logEvento).toHaveBeenCalledWith(
            'crm',
            'warn',
            expect.objectContaining({ esito: 'nessuna-persona-nella-sede', sede_id: '30000000-0000-4000-8000-000000000003' }),
        )
    })

    it('se anche la rilettura finale fallisce LANCIA: un elenco vuoto direbbe «nessuno è disponibile»', async () => {
        // Nessun ponte: le letture di `utenti` sono due, quella di `staffScuola` e la rilettura finale.
        // Si fa fallire la seconda.
        const base = db()
        base.utenti_scuole = []
        const sano = creaFintoSupabase(base)
        const guasto = creaFintoSupabase(base, [], { errori: { 'utenti:select': { code: '08006', message: 'giù' } } })
        let letture = 0
        const client = {
            from: (tabella: string) => (tabella === 'utenti' && ++letture === 2 ? guasto.from(tabella) : sano.from(tabella)),
        } as unknown as SupabaseClient
        await expect(personeDellaSede(client, SEDE_A)).rejects.toMatchObject({ code: '08006' })
        expect(letture).toBe(2)
    })
})
