import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { AppUser } from '@/lib/auth/require-staff'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E } from '../../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

// =============================================================================
// I DUE DINIEGHI DI SEDE VIAGGIANO CON UN CODICE, NON SOLO CON UNA FRASE.
//
// Perché un file a parte e non `scope.test.ts`: lì si prova COSA decide
// `resolveScuolaScrittura` (chi passa, chi no, su quale sede si scrive). Qui si
// prova COME lo dice a chi legge — che è il difetto trovato al collaudo del
// 2026-07-31 (localizzazione F1 e F2): la decisione era giusta, il messaggio
// arrivava in italiano dentro un'interfaccia inglese e nominava una colonna del
// database.
//
// L'asserzione forte non è «c'è un campo `codice`»: è che il corpo, dato in
// pasto a `messaggioErrore` con l'interfaccia in inglese, produce INGLESE. È
// l'unico modo di dimostrare che i due pezzi (server e client) si parlano
// davvero, invece di essere due metà giuste che non si incontrano.
// =============================================================================

vi.mock('@/lib/logging/logger', () => ({
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
}))

import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { messaggioErrore } from '@/lib/ui/esito-fetch'

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_SEGRETERIA = 'd0000000-0000-4000-8000-00000000e600'

const utente = (id: string, role: AppUser['role'], scuola_id: string | null): AppUser => ({
    id,
    role,
    scuola_id,
})

/** La Direzione: tre plessi. È l'unica figura multi-sede del modello. */
const ADMIN_TRE_SEDI = utente(ID_ADMIN, 'admin', SEDE_A)
/** Segreteria: un plesso solo. */
const SEGRETERIA_A = utente(ID_SEGRETERIA, 'segreteria', SEDE_A)

function db(): DBFinto {
    return {
        utenti_scuole: [
            { utente_id: ID_ADMIN, scuola_id: SEDE_A },
            { utente_id: ID_ADMIN, scuola_id: SEDE_B },
            { utente_id: ID_ADMIN, scuola_id: SEDE_C },
        ],
    }
}

function client() {
    const lette: string[] = []
    const scritture: Scrittura[] = []
    return { supabase: creaFintoSupabase(db(), lette, { scritture }), lette, scritture }
}

function richiesta(cookie?: string): NextRequest {
    return {
        cookies: {
            get: (nome: string) =>
                cookie !== undefined && nome === 'sedi_attive' ? { value: cookie } : undefined,
        },
    } as unknown as NextRequest
}

type Corpo = { error?: string; codice?: string }

async function corpo(res: unknown): Promise<{ status: number } & Corpo> {
    const r = res as { status: number; json: () => Promise<Corpo> }
    const b = await r.json()
    return { status: r.status, ...b }
}

/**
 * Ciò che l'utente legge davvero: il corpo — letto UNA volta sola, come da
 * `Response` vera — ridato in pasto al canale del client.
 */
async function aSchermo(b: Corpo, lingua: 'it' | 'en'): Promise<string> {
    document.documentElement.setAttribute('lang', lingua)
    return messaggioErrore({ json: async () => b } as unknown as Response, 'fallback')
}

beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.setAttribute('lang', 'it')
})

describe('resolveScuolaScrittura — il diniego porta un codice traducibile', () => {
    it('403 sede dichiarata fuori scope: `codice` SEDE_NON_ACCESSIBILE e testo INGLESE a schermo', async () => {
        const c = client()
        const r = await resolveScuolaScrittura(richiesta(), c.supabase, ADMIN_TRE_SEDI, SEDE_E2E)

        const b = await corpo(r.response)
        expect(b).toMatchObject({ status: 403, codice: 'SEDE_NON_ACCESSIBILE' })
        expect(await aSchermo(b, 'en')).toBe('Site not accessible')
        // Controllo POSITIVO: in italiano il testo resta quello di sempre, cioè
        // la correzione non ha cambiato ciò che legge una segretaria di Aversa.
        expect(await aSchermo(b, 'it')).toBe('Sede non accessibile')
        // E la scrittura resta negata: il codice è un'aggiunta, non uno sconto.
        expect(r.scuolaId).toBeUndefined()
    })

    it('403 cookie con sole sedi altrui: stesso codice (è lo stesso rifiuto)', async () => {
        const c = client()
        const r = await resolveScuolaScrittura(richiesta(SEDE_E2E), c.supabase, ADMIN_TRE_SEDI)

        const b = await corpo(r.response)
        expect(b).toMatchObject({ status: 403, codice: 'SEDE_NON_ACCESSIBILE' })
        expect(await aSchermo(b, 'en')).toBe('Site not accessible')
    })

    it('400 ambiguità: `codice` SEDE_DA_SPECIFICARE, e `scuola_id` NON è più nel testo', async () => {
        const c = client()
        const r = await resolveScuolaScrittura(richiesta(), c.supabase, ADMIN_TRE_SEDI)

        const b = await corpo(r.response)
        expect(b).toMatchObject({ status: 400, codice: 'SEDE_DA_SPECIFICARE' })
        expect(b.error).not.toMatch(/scuola_id/)
        expect(await aSchermo(b, 'en')).toBe('Please specify which site this applies to')
        expect(await aSchermo(b, 'it')).toBe('Specificare la sede a cui si riferisce questa operazione')
    })

    it('chi ha UNA sola sede passa e non vede nessun diniego (controllo positivo)', async () => {
        const c = client()
        const r = await resolveScuolaScrittura(richiesta(), c.supabase, SEGRETERIA_A)

        expect(r.response).toBeUndefined()
        expect(r.scuolaId).toBe(SEDE_A)
    })

    it('i due codici usati qui sono DICHIARATI nel canale del client', () => {
        // Senza questo, un refuso nel codice (`SEDE_NON_ACCESIBILE`) passerebbe i
        // test qui sopra solo cambiando la stringa attesa, e a schermo tornerebbe
        // l'italiano — cioè il difetto di partenza, con l'aria di essere chiuso.
        expect(Object.keys(CODICI_ERRORE)).toEqual(
            expect.arrayContaining(['SEDE_NON_ACCESSIBILE', 'SEDE_DA_SPECIFICARE']),
        )
    })
})
