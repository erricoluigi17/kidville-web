import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import {
  CODICI_SCHEMA_VOTAZIONI_ASSENTE,
  rispostaErroreDbVotazioni,
  rispostaVotazioniNonDisponibili,
  schemaVotazioniAssente,
} from '@/lib/votazioni/errori'
import catalogoIt from '../../../messages/it/shared.json'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

/**
 * DA UN ERRORE DEL DATABASE ALLA RISPOSTA GIUSTA, PER LE VOTAZIONI.
 *
 * PostgREST non lancia: ritorna `{ error }`, e il suo `code` dice se manca lo schema (la finestra fra il
 * deploy e la migrazione, o il DB E2E della CI, che non ha le tabelle `votazioni*`) oppure se è un
 * guasto vero. I due casi hanno risposte opposte: 503 «non disponibile» contro 500, e il primo non deve
 * far suonare nessun allarme da guasto.
 */

const CATALOGO = catalogoIt as Record<string, string>

beforeEach(() => {
  h.logEvento.mockClear()
  h.logErrore.mockClear()
})

async function leggi(res: Response) {
  return { status: res.status, corpo: (await res.json()) as { error: string; codice: string } }
}

describe('schemaVotazioniAssente', () => {
  it('i sei codici dello schema assente, e nessun altro', () => {
    expect([...CODICI_SCHEMA_VOTAZIONI_ASSENTE].sort()).toEqual(
      ['42703', '42883', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'].sort(),
    )
  })

  it('riconosce ognuno dei sei', () => {
    for (const code of CODICI_SCHEMA_VOTAZIONI_ASSENTE) {
      expect(schemaVotazioniAssente({ code }), code).toBe(true)
    }
  })

  it('NON scambia per «schema assente» un guasto vero né un conflitto', () => {
    for (const code of ['XX000', '23505', '23503', '23514', '08006', '57P03', '42501', 'PGRST116', '']) {
      expect(schemaVotazioniAssente({ code }), code).toBe(false)
    }
  })

  it('un errore senza codice, null, undefined o non-oggetto non è «schema assente»', () => {
    expect(schemaVotazioniAssente(new Error('boom'))).toBe(false)
    expect(schemaVotazioniAssente(null)).toBe(false)
    expect(schemaVotazioniAssente(undefined)).toBe(false)
    expect(schemaVotazioniAssente('PGRST205')).toBe(false)
    expect(schemaVotazioniAssente({ code: 42703 })).toBe(false)
  })
})

describe('rispostaVotazioniNonDisponibili', () => {
  it('503 VOTAZIONI_NON_DISPONIBILI, senza scrivere nel log', async () => {
    const r = await leggi(rispostaVotazioniNonDisponibili())
    expect(r.status).toBe(503)
    expect(r.corpo.codice).toBe('VOTAZIONI_NON_DISPONIBILI')
    expect(r.corpo.error).toBeTruthy()
    expect(h.logEvento).not.toHaveBeenCalled()
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('la prosa è la frase italiana del catalogo: il client che non traduce legge la stessa cosa', async () => {
    const r = await leggi(rispostaVotazioniNonDisponibili())
    expect(r.corpo.error).toBe(CATALOGO[CODICI_ERRORE.VOTAZIONI_NON_DISPONIBILI])
  })
})

describe('rispostaErroreDbVotazioni', () => {
  it('PGRST205 → 503 VOTAZIONI_NON_DISPONIBILI, con un warn persistito', async () => {
    const errore = { code: 'PGRST205', message: 'Could not find the table public.votazioni' }
    const r = await leggi(rispostaErroreDbVotazioni(errore, 'votazioni/elenco:GET'))
    expect(r.status).toBe(503)
    expect(r.corpo.codice).toBe('VOTAZIONI_NON_DISPONIBILI')
    expect(h.logEvento).toHaveBeenCalledWith(
      'votazioni',
      'warn',
      expect.objectContaining({ operazione: 'votazioni/elenco:GET' }),
      errore,
    )
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('tutti e sei i codici di schema assente → 503', async () => {
    for (const code of CODICI_SCHEMA_VOTAZIONI_ASSENTE) {
      const r = await leggi(rispostaErroreDbVotazioni({ code, message: 'manca qualcosa' }, 'votazioni/crea:POST'))
      expect(r.status, code).toBe(503)
      expect(r.corpo.codice, code).toBe('VOTAZIONI_NON_DISPONIBILI')
    }
  })

  it('XX000 → 500 VOTAZIONE_OPERAZIONE_NON_RIUSCITA, con logErrore e senza il testo del database nel corpo', async () => {
    const errore = { code: 'XX000', message: 'la password dell’utente postgres non è valida' }
    const r = await leggi(rispostaErroreDbVotazioni(errore, 'votazioni/crea:POST'))
    expect(r.status).toBe(500)
    expect(r.corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(r.corpo)).not.toContain('password')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'votazioni/crea:POST', stato: 500 }),
      errore,
    )
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('un errore senza codice (un’eccezione qualunque) → 500', async () => {
    const r = await leggi(rispostaErroreDbVotazioni(new Error('boom'), 'votazioni/elenco:GET'))
    expect(r.status).toBe(500)
    expect(r.corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
  })

  it('un conflitto di chiave (23505) NON è tradotto qui: ogni route sa che cosa significa nel suo caso', async () => {
    // Una UNIQUE violata sul voto è una corsa da risolvere con un update; sulla testata è un guasto. Il
    // dizionario generico non può sapere quale: lo lascia a 500 e lo registra.
    const r = await leggi(rispostaErroreDbVotazioni({ code: '23505' }, 'votazioni/voto:POST'))
    expect(r.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('la prosa dei due esiti è quella del catalogo italiano', async () => {
    const nd = await leggi(rispostaErroreDbVotazioni({ code: 'PGRST205' }, 'x:GET'))
    const ko = await leggi(rispostaErroreDbVotazioni({ code: 'XX000' }, 'x:GET'))
    expect(nd.corpo.error).toBe(CATALOGO[CODICI_ERRORE.VOTAZIONI_NON_DISPONIBILI])
    expect(ko.corpo.error).toBe(CATALOGO[CODICI_ERRORE.VOTAZIONE_OPERAZIONE_NON_RIUSCITA])
  })
})
