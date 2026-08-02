import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// PANIC ALERT — l'allarme «ritiro non autorizzato» deve ARRIVARE.
//
// Audit 2026-07-31 (F6, terza delle quattro risoluzioni staff senza il ponte).
// La route cercava chi avvisare con `from('utenti').eq('scuola_id', …)`: per un
// bambino delle sedi aperte il 29/07 la lista è vuota, `if (staffIds.length > 0)`
// non scatta e — poiché «zero destinatari» non è un'eccezione — il `catch` non
// vede niente e NON viene emessa nessuna riga di log. I genitori vengono avvisati
// lo stesso, quindi da fuori l'allarme sembra funzionare: in segreteria non
// arriva nulla e nessuno lo sa.
//
// Secondo difetto, stessa scrittura: l'upsert su `presenze` non dichiarava la
// sede (12 righe su 49 in produzione hanno `scuola_id` NULL). La sede del dato
// è quella dell'ALUNNO, ed è già in mano al codice.
// =============================================================================

const logEvento = vi.fn()
const logErrore = vi.fn()
const enqueueNotifiche = vi.fn()
const enqueueNotifichePerAlunni = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))
// Gate concessivi di proposito: l'oggetto del file sono i DESTINATARI e la
// scrittura, non l'isolamento in ingresso (che ha i suoi test).
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })),
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn(async () => null) }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => enqueueNotifiche(...a) }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: (...a: unknown[]) => enqueueNotifichePerAlunni(...a),
}))

const stato = vi.hoisted(() => ({ db: {} as DBFinto, scritture: [] as Scrittura[] }))
vi.mock('@/lib/supabase/server-client', () => {
  const client = () => {
    const finto = creaFintoSupabase(stato.db, [], { scritture: stato.scritture })
    return {
      from: (t: string) => finto.from(t),
      auth: { getUser: async () => ({ data: { user: { id: 'ed1' } }, error: null }) },
    }
  }
  return { createClient: async () => client(), createAdminClient: async () => client() }
})

import { POST } from '@/app/api/panic-alert/route'

const ALUNNO = 'a1a1a1a1-0000-4000-8000-00000000000a'

/** L'alunno vive nella sede B (aperta il 29/07): lì lo staff arriva dal ponte. */
function dbBase(): DBFinto {
  return {
    alunni: [{ id: ALUNNO, nome: 'Bambino', scuola_id: SEDE_B, section_id: 'sez-b' }],
    presenze: [],
    utenti: [
      { id: 'segr-a', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'admin-x', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    ],
    utenti_scuole: [{ utente_id: 'admin-x', scuola_id: SEDE_B }],
  }
}

const post = () =>
  POST(new Request('http://localhost/api/panic-alert', {
    method: 'POST',
    body: JSON.stringify({ alunnoId: ALUNNO }),
  }))

beforeEach(() => {
  vi.clearAllMocks()
  stato.db = dbBase()
  stato.scritture = []
})

describe('POST /api/panic-alert — destinatari e sede della scrittura', () => {
  it('avvisa lo staff che copre quella sede DAL PONTE (prima: nessuno)', async () => {
    const res = await post()
    expect(res.status).toBe(200)

    expect(enqueueNotifiche).toHaveBeenCalledTimes(1)
    const args = enqueueNotifiche.mock.calls[0][1] as { utenteIds: string[]; tipo: string; scuolaId: string }
    // `segr-a` è di un'ALTRA sede: non deve entrare. `admin-x` copre la B dal ponte.
    expect(args.utenteIds).toEqual(['admin-x'])
    expect(args.tipo).toBe('panic_alert')
    expect(args.scuolaId).toBe(SEDE_B)
    // I genitori restano avvisati in ogni caso.
    expect(enqueueNotifichePerAlunni).toHaveBeenCalledTimes(1)
  })

  it('la presenza salvata DICHIARA la sede dell\'alunno (prima: scuola_id NULL)', async () => {
    await post()
    const upsert = stato.scritture.find((s) => s.tabella === 'presenze')
    expect(upsert?.operazione).toBe('upsert')
    expect(upsert?.valori[0]).toMatchObject({
      alunno_id: ALUNNO,
      panic_alert: true,
      scuola_id: SEDE_B,
    })
    // E nel «database» la riga c'è, con la sua sede.
    expect(stato.db.presenze[0]).toMatchObject({ alunno_id: ALUNNO, scuola_id: SEDE_B })
  })

  it('NESSUNO staff su quella sede ⇒ log `error`: è un allarme di sicurezza senza destinatari', async () => {
    stato.db.utenti_scuole = []
    const res = await post()
    expect(res.status).toBe(200)

    expect(enqueueNotifiche).not.toHaveBeenCalled()
    // I genitori vanno avvisati comunque: è l'unico canale rimasto.
    expect(enqueueNotifichePerAlunni).toHaveBeenCalledTimes(1)
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'nessun-destinatario-staff',
    )
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('error')
    expect(JSON.stringify(riga?.[2])).not.toMatch(/Bambino/)
  })

  it('alunno illeggibile ⇒ la presenza si salva lo stesso, ma la sede mancante si logga', async () => {
    stato.db.alunni = []
    const res = await post()
    expect(res.status).toBe(200)

    const upsert = stato.scritture.find((s) => s.tabella === 'presenze')
    expect(upsert?.valori[0]).not.toHaveProperty('scuola_id')
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-non-risolta',
    )
    expect(riga?.[1]).toBe('error')
  })
})
