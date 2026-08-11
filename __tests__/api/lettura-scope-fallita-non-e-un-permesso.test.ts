import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { dataCivile } from '@/i18n/config'

// =============================================================================
// F3 — LA PROVA DI CAPO: un errore di LETTURA non diventa un PERMESSO.
//
// Il difetto non stava in una route, stava nel primitivo che tutte le route
// usano. `scuoleDiUtente` leggeva `utenti_scuole` senza guardare `{ error }` —
// e PostgREST non lancia. Bastava che quel ponte non si leggesse (permessi
// revocati, timeout, rete) perché `data` fosse null, `extra` restasse `[]` e
// l'admin di TRE sedi diventasse di UNA: la primaria. Da lì
// `resolveScuolaScrittura` imboccava il ramo «una sola sede accessibile» e
// l'evento veniva archiviato a Giugliano — 201, nessun 400, nessun warn.
// Cioè: il difetto che l'audit del 30/07 aveva appena chiuso rientrava da una
// porta laterale, e l'unica traccia era una riga `db error` del fetch
// strumentato che dice «PostgREST ha risposto male su utenti_scuole» — non
// «una scrittura è finita nel plesso sbagliato».
//
// Qui si prova la catena INTERA su una route vera che scrive davvero
// (`POST /api/agenda`, evento di plesso), con il finto client che i filtri li
// applica e le scritture le esegue: si asserisce lo stato ESATTO e il contenuto
// di `eventi_agenda`, mai una negazione generica.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'

/**
 * Il giorno degli eventi di prova è OGGI, con la stessa funzione che usa la route
 * (`dataCivile`, nel fuso della scuola) — non una data scritta a mano.
 *
 * ⚠️ QUI IL DANNO SAREBBE STATO SILENZIOSO, ed è peggio di un rosso. `GET /api/agenda`
 * senza `from` filtra `.gte('data', dataCivile())`: con la costante `'2026-09-10'`,
 * **dall'11 settembre 2026** l'elenco sarebbe uscito vuoto per la DATA e non per lo
 * scope — e l'asserzione `toEqual([])` sarebbe rimasta verde senza più provare niente.
 * Nessun test si sarebbe acceso: il file avrebbe continuato a dichiarare che un ponte
 * `utenti_scuole` illeggibile non allarga la lettura, senza più misurarlo.
 *
 * È la gemella del difetto trovato l'11 agosto 2026 in `agenda-sede-scrittura.test.ts`,
 * che invece si era manifestato come rosso a mezzanotte. Quello si vedeva; questo no.
 */
const GIORNO = dataCivile()

/** Non è un codice di «CI non migrata»: è il ponte che c'è e non si legge. */
const PONTE_ILLEGGIBILE = { code: '42501', message: 'permission denied for table utenti_scuole' }

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  enqueue: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: (...a: unknown[]) => h.enqueue(...a),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => 'test',
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }),
  }
})

import { GET, POST } from '@/app/api/agenda/route'

const dbBase = (): DBFinto => ({
  sections: [],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  eventi_agenda: [
    { id: 'ev-a', scuola_id: SEDE_A, section_id: null, titolo: 'FESTA-SEDE-A', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
    { id: 'ev-b', scuola_id: SEDE_B, section_id: null, titolo: 'FESTA-SEDE-B', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
  ],
  alunni: [],
})

function richiesta(url: string, body?: Record<string, unknown>, cookie?: string): NextRequest {
  return {
    url,
    method: body ? 'POST' : 'GET',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body ?? {},
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const eventoDiPlesso = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Chiusura estiva',
  tipo: 'evento',
  data: GIORNO,
  ...extra,
})

const scritti = () => h.scritture.filter((s) => s.tabella === 'eventi_agenda')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.enqueue.mockResolvedValue(undefined)
  // La Direzione: sede primaria A, ponte verso A e B. È il caso reale — l'unico
  // admin del deployment ha Giugliano come primaria ed è l'unico che gestisce
  // anche Aversa e Cesa.
  const utente = { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A }
  h.requireDocente.mockResolvedValue({ user: utente })
  h.requireUser.mockResolvedValue({ user: utente })
})

describe('POST /api/agenda con il ponte utenti_scuole illeggibile', () => {
  it('NON scrive nella sede primaria: 403 e zero eventi creati', async () => {
    h.errori = { utenti_scuole: PONTE_ILLEGGIBILE }

    const res = await POST(richiesta('http://localhost/api/agenda', eventoDiPlesso()))

    expect(res.status).toBe(403)
    expect(scritti()).toEqual([])
    // Le due righe di partenza e nient'altro: nessun evento è comparso a SEDE_A.
    expect(h.db.eventi_agenda).toHaveLength(2)
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('nemmeno con la sede DICHIARATA: una sede non verificabile non si autorizza', async () => {
    h.errori = { utenti_scuole: PONTE_ILLEGGIBILE }

    const res = await POST(
      richiesta('http://localhost/api/agenda', eventoDiPlesso({ scuola_id: SEDE_B })),
    )

    expect(res.status).toBe(403)
    expect(scritti()).toEqual([])
  })

  it('nemmeno con il SedeSelector su una sede sola', async () => {
    h.errori = { utenti_scuole: PONTE_ILLEGGIBILE }

    const res = await POST(
      richiesta('http://localhost/api/agenda', eventoDiPlesso(), SEDE_B),
    )

    expect(res.status).toBe(403)
    expect(scritti()).toEqual([])
  })

  it('la LETTURA non allarga: nessun evento, non «tutti quelli di tutte le sedi»', async () => {
    h.errori = { utenti_scuole: PONTE_ILLEGGIBILE }

    const res = await GET(richiesta('http://localhost/api/agenda'))

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  // ── Contro-prova: il verde qui sopra non viene da «tutto rotto» ────────────
  it('col ponte leggibile la stessa richiesta passa, e scrive nella sede DICHIARATA', async () => {
    const res = await POST(
      richiesta('http://localhost/api/agenda', eventoDiPlesso({ scuola_id: SEDE_B })),
    )

    expect(res.status).toBe(201)
    expect(scritti()).toHaveLength(1)
    expect(scritti()[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      section_id: null,
      titolo: 'Chiusura estiva',
    })
  })

  it('col ponte leggibile e la sede NON dichiarata resta il 400 dell\'audit (mai la primaria)', async () => {
    const res = await POST(richiesta('http://localhost/api/agenda', eventoDiPlesso()))

    expect(res.status).toBe(400)
    expect(scritti()).toEqual([])
  })
})
