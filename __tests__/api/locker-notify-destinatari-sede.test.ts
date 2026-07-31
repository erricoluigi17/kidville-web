import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// ARMADIETTO «Avvisa» — la QUARTA risoluzione staff senza il ponte, e l'unica
// delle quattro che una famiglia reale poteva già percorrere oggi.
//
// Audit 2026-07-31 (F6, R84). La route cercava chi avvisare con
// `from('utenti').select(…).eq('scuola_id', alunno.scuola_id)`: per la famiglia
// di una sede aperta il 2026-07-29 — dove nessuno ha ancora quel plesso come
// PRIMARIO — quella query torna zero righe. `if (destinatari.size > 0)` non
// scatta, la route risponde comunque `{ success: true, destinatari: 0 }` e non
// resta NESSUNA riga di log: la richiesta di materiale non arriva a nessuno e
// il genitore vede una conferma.
// =============================================================================

const logEvento = vi.fn()
const enqueueNotifiche = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: { id: 'gen-1', role: 'genitore' } })),
}))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => enqueueNotifiche(...a) }))

const stato = vi.hoisted(() => ({ db: {} as DBFinto }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(stato.db),
}))

import { POST } from '@/app/api/locker/notify/route'

const ALUNNO = 'a1a1a1a1-0000-4000-8000-00000000000a'

/** Il bambino sta nella sede B: lì lo staff esiste SOLO attraverso il ponte. */
function dbBase(): DBFinto {
  return {
    legame_genitori_alunni: [{ genitore_id: 'gen-1', alunno_id: ALUNNO }],
    alunni: [{ id: ALUNNO, nome: 'Bambino', scuola_id: SEDE_B, section_id: 'sez-b' }],
    utenti: [
      { id: 'segr-a', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'admin-x', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
      { id: 'edu-b', ruolo: 'educator', role: 'educator', scuola_id: SEDE_B },
    ],
    utenti_scuole: [{ utente_id: 'admin-x', scuola_id: SEDE_B }],
    utenti_sezioni: [{ utente_id: 'edu-b', section_id: 'sez-b' }],
  }
}

const post = () =>
  POST(new Request('http://localhost/api/locker/notify', {
    method: 'POST',
    body: JSON.stringify({ alunno_id: ALUNNO, materiale: 'Pannolini' }),
  }))

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  stato.db = dbBase()
})

describe('POST /api/locker/notify — destinatari di sede', () => {
  it('avvisa lo staff che copre la sede DAL PONTE, più i docenti della sezione', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, destinatari: 2 })

    expect(enqueueNotifiche).toHaveBeenCalledTimes(1)
    const args = enqueueNotifiche.mock.calls[0][1] as { utenteIds: string[]; scuolaId: string; tipo: string }
    // `segr-a` è di un'ALTRA sede: fuori. `admin-x` copre la B dal ponte.
    expect([...args.utenteIds].sort()).toEqual(['admin-x', 'edu-b'])
    expect(args.scuolaId).toBe(SEDE_B)
    expect(args.tipo).toBe('locker_scorte')
  })

  it('NESSUN destinatario ⇒ la risposta lo dice E resta una riga di log', async () => {
    stato.db.utenti_scuole = []
    stato.db.utenti_sezioni = []
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, destinatari: 0 })

    expect(enqueueNotifiche).not.toHaveBeenCalled()
    const riga = logDi('nessun-destinatario')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('warn')
    // Mai il nome del bambino nei log.
    expect(JSON.stringify(riga?.[2])).not.toMatch(/Bambino/)
  })
})
