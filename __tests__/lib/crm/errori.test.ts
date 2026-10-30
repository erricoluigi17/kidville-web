import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { rispostaErroreDb } from '@/lib/crm/errori'

beforeEach(() => {
    h.logEvento.mockClear()
    h.logErrore.mockClear()
})

async function leggi(res: Response) {
    return { status: res.status, corpo: (await res.json()) as { error: string; codice: string } }
}

describe('rispostaErroreDb', () => {
    it('23P01 (EXCLUDE degli appuntamenti) → 409 SLOT_OCCUPATO', async () => {
        const r = await leggi(rispostaErroreDb({ code: '23P01', message: 'conflicting key value violates exclusion constraint' }, 'crm/appuntamenti:POST'))
        expect(r.status).toBe(409)
        expect(r.corpo.codice).toBe('SLOT_OCCUPATO')
        expect(r.corpo.error).toBeTruthy()
    })

    it('23505 (UNIQUE su domanda_id, domanda_figlio) → 409 GIA_COLLEGATO', async () => {
        const r = await leggi(rispostaErroreDb({ code: '23505' }, 'crm/collegamento:POST'))
        expect(r.status).toBe(409)
        expect(r.corpo.codice).toBe('GIA_COLLEGATO')
    })

    it('PGRST205 e 42P01 (tabella assente) → 503 CRM_NON_INSTALLATO, con un warn', async () => {
        for (const code of ['PGRST205', '42P01']) {
            h.logEvento.mockClear()
            const r = await leggi(rispostaErroreDb({ code, message: 'relation does not exist' }, 'crm/schede:GET'))
            expect(r.status).toBe(503)
            expect(r.corpo.codice).toBe('CRM_NON_INSTALLATO')
            expect(h.logEvento).toHaveBeenCalledWith('crm', 'warn', expect.objectContaining({ operazione: 'crm/schede:GET' }), expect.anything())
        }
    })

    it('ogni altro errore → 500 CRM_OPERAZIONE_NON_RIUSCITA, con logErrore e senza il testo del database nel corpo', async () => {
        const r = await leggi(rispostaErroreDb({ code: '08006', message: 'password per l’utente postgres non valida' }, 'crm/schede:POST'))
        expect(r.status).toBe(500)
        expect(r.corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
        expect(JSON.stringify(r.corpo)).not.toContain('password')
        expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/schede:POST', stato: 500 }), expect.anything())
    })

    it('un errore senza codice (un’eccezione qualunque) → 500', async () => {
        const r = await leggi(rispostaErroreDb(new Error('boom'), 'crm/schede:GET'))
        expect(r.status).toBe(500)
        expect(r.corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    })
})
