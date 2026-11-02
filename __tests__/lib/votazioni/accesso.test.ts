import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUser } from '@/lib/auth/require-staff'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), requireStaff: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

vi.mock('@/lib/auth/require-staff', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/require-staff')>()
  return { ...vero, requireStaff: h.requireStaff }
})

import { caricaVotazioneInScope, requireVotazioni, RUOLI_VOTAZIONI } from '@/lib/votazioni/accesso'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * L’ACCESSO ALLE VOTAZIONI, PROVATO CON UN DATABASE CHE FILTRA DAVVERO.
 *
 * Il gate di ruolo non basta: le route lavorano col client service-role, che scavalca la RLS. La sede si
 * controlla in applicazione. Qui la votazione di un’altra sede esiste davvero nel finto database, e a
 * negarla deve essere il codice: un mock che risponde sempre la stessa riga direbbe «sì» anche senza il
 * controllo.
 *
 * Solo dati finti: uuid inventati, titoli di prova.
 */

const VOT_A = '10000000-0000-4000-8000-000000000001'
const VOT_B = '10000000-0000-4000-8000-000000000002'
const VOT_MANCANTE = '10000000-0000-4000-8000-0000000000ff'

const SEG_A = '20000000-0000-4000-8000-00000000000a'
const ADMIN_A = '20000000-0000-4000-8000-0000000000aa'
const ADMIN_MULTI = '20000000-0000-4000-8000-0000000000ab'
const COORD_B = '20000000-0000-4000-8000-0000000000cb'

const utente = (id: string, role: AppUser['role'], scuola_id: string): AppUser => ({ id, role, scuola_id })

function riga(id: string, scuola_id: string) {
  return {
    id,
    scuola_id,
    titolo: 'Elezione di prova',
    scadenza: '2026-11-20T17:00:00.000Z',
    chiusa_il: null,
    rappresentante_istituto: false,
    creata_da: SEG_A,
    creata_il: '2026-11-02T09:00:00.000Z',
    aggiornata_da: null,
    aggiornata_il: null,
  }
}

function db(): DBFinto {
  return {
    votazioni: [riga(VOT_A, SEDE_A), riga(VOT_B, SEDE_B)],
    utenti_scuole: [
      { utente_id: ADMIN_A, scuola_id: SEDE_A },
      { utente_id: ADMIN_MULTI, scuola_id: SEDE_A },
      { utente_id: ADMIN_MULTI, scuola_id: SEDE_B },
    ],
  }
}

async function leggi(res: Response) {
  return { status: res.status, corpo: (await res.json()) as { error: string; codice: string } }
}

beforeEach(() => {
  h.logEvento.mockClear()
  h.logErrore.mockClear()
  h.requireStaff.mockReset()
})

describe('RUOLI_VOTAZIONI e requireVotazioni', () => {
  it('sono i ruoli di default dello staff: admin, coordinator, segreteria', () => {
    expect([...RUOLI_VOTAZIONI]).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('requireVotazioni passa da requireStaff con quei ruoli e ne restituisce l’esito tale e quale', async () => {
    const richiesta = new Request('http://localhost/api/admin/votazioni')
    const diniego = { response: new Response('no', { status: 403 }) }
    h.requireStaff.mockResolvedValueOnce(diniego)
    const r = await requireVotazioni(richiesta)
    expect(r).toBe(diniego)
    expect(h.requireStaff).toHaveBeenCalledTimes(1)
    expect(h.requireStaff).toHaveBeenCalledWith(richiesta, RUOLI_VOTAZIONI)

    const ok = { user: utente(SEG_A, 'segreteria', SEDE_A) }
    h.requireStaff.mockResolvedValueOnce(ok)
    expect(await requireVotazioni(richiesta)).toBe(ok)
  })
})

describe('caricaVotazioneInScope', () => {
  it('la votazione della propria sede → { votazione }, con la riga intera', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_A)
    expect('response' in r).toBe(false)
    if ('votazione' in r) {
      expect(r.votazione.id).toBe(VOT_A)
      expect(r.votazione.scuola_id).toBe(SEDE_A)
      expect(r.votazione.titolo).toBe('Elezione di prova')
      expect(r.votazione.chiusa_il).toBeNull()
    }
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('la votazione di un’ALTRA sede → 403 SEDE_NON_ACCESSIBILE (la stessa risposta di rifiutoSede), e un warn', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_B)
    expect('votazione' in r).toBe(false)
    if ('response' in r) {
      const { status, corpo } = await leggi(r.response)
      expect(status).toBe(403)
      expect(corpo.codice).toBe('SEDE_NON_ACCESSIBILE')
      expect(corpo.error).toBeTruthy()
    } else {
      throw new Error('attesa una risposta di diniego')
    }
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'warn',
      expect.objectContaining({ operazione: 'votazioni/accesso:caricaVotazioneInScope', esito: 'votazione-fuori-sede' }),
    )
  })

  it('il diniego non porta nel log né nel corpo il titolo della votazione altrui', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_B)
    if (!('response' in r)) throw new Error('attesa una risposta di diniego')
    const corpo = JSON.stringify(await r.response.json())
    expect(corpo).not.toContain('Elezione di prova')
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('Elezione di prova')
  })

  it('un coordinatore di un’altra sede è fuori scope, e un admin con una sola sede nel ponte pure', async () => {
    const supabase = creaFintoSupabase(db())
    const coord = await caricaVotazioneInScope(supabase, utente(COORD_B, 'coordinator', SEDE_B), VOT_A)
    expect('response' in coord && coord.response.status).toBe(403)
    const admin = await caricaVotazioneInScope(supabase, utente(ADMIN_A, 'admin', SEDE_A), VOT_B)
    expect('response' in admin && admin.response.status).toBe(403)
  })

  it('l’admin multi-sede (ponte utenti_scuole) apre la votazione di entrambe le sue sedi', async () => {
    const supabase = creaFintoSupabase(db())
    const a = await caricaVotazioneInScope(supabase, utente(ADMIN_MULTI, 'admin', SEDE_A), VOT_A)
    const b = await caricaVotazioneInScope(supabase, utente(ADMIN_MULTI, 'admin', SEDE_A), VOT_B)
    expect('votazione' in a).toBe(true)
    expect('votazione' in b).toBe(true)
  })

  it('il confronto fra sedi ignora le maiuscole (in Postgres un uuid è un tipo, non una stringa)', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A.toUpperCase()), VOT_A)
    expect('votazione' in r).toBe(true)
    // …ma una sede ALTRUI in maiuscolo resta negata: il controllo negativo accanto al positivo.
    const altrui = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A.toUpperCase()), VOT_B)
    expect('response' in altrui && altrui.response.status).toBe(403)
  })

  it('una votazione che non esiste → 404 VOTAZIONE_NON_TROVATA', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_MANCANTE)
    if (!('response' in r)) throw new Error('attesa una risposta')
    const { status, corpo } = await leggi(r.response)
    expect(status).toBe(404)
    expect(corpo.codice).toBe('VOTAZIONE_NON_TROVATA')
  })

  it('schema assente (PGRST205) → 503 VOTAZIONI_NON_DISPONIBILI, non un 404', async () => {
    const supabase = creaFintoSupabase(db(), [], { errori: { votazioni: { code: 'PGRST205' } } })
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_A)
    if (!('response' in r)) throw new Error('attesa una risposta')
    const { status, corpo } = await leggi(r.response)
    expect(status).toBe(503)
    expect(corpo.codice).toBe('VOTAZIONI_NON_DISPONIBILI')
  })

  it('un guasto di lettura → 500, mai un 404 «non trovata» né un 403 «fuori sede»', async () => {
    const supabase = creaFintoSupabase(db(), [], { errori: { votazioni: { code: 'XX000' } } })
    const r = await caricaVotazioneInScope(supabase, utente(SEG_A, 'segreteria', SEDE_A), VOT_A)
    if (!('response' in r)) throw new Error('attesa una risposta')
    const { status, corpo } = await leggi(r.response)
    expect(status).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('cerca per id: con due votazioni nel database restituisce quella chiesta', async () => {
    const supabase = creaFintoSupabase(db())
    const r = await caricaVotazioneInScope(supabase, utente(ADMIN_MULTI, 'admin', SEDE_A), VOT_B)
    if (!('votazione' in r)) throw new Error('attesa la votazione')
    expect(r.votazione.id).toBe(VOT_B)
    expect(r.votazione.scuola_id).toBe(SEDE_B)
  })
})
