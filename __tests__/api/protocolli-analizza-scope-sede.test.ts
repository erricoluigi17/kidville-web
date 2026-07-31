import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'
import { sha256Impronta } from '@/lib/protocolli/store'

// =============================================================================
// X3 — `admin/protocolli/analizza:POST` con perimetro vuoto.
//
// IL DIFETTO. Il controllo duplicati stava tutto dentro `if (sedi.length > 0)`.
// Non era una perdita di dati — l'unica query è già filtrata `.in('scuola_id',
// sedi)` — ma era un SILENZIO: con lo scope vuoto la route scaricava comunque il
// file dallo staging, ne calcolava l'impronta, ne estraeva i campi suggeriti e
// rispondeva 200 `duplicato: null`. Cioè: «nessun duplicato», detto da chi non
// ha guardato. Su un registro di protocollo (DPR 445) l'avviso di duplicato è
// l'unico presidio contro la doppia registrazione dello stesso atto, e un «no»
// indistinguibile da «non ho controllato» è peggio di un errore.
//
// LA CORREZIONE. Scope vuoto ⇒ 403 in testa, PRIMA di toccare lo storage: chi
// non ha nessuna sede in perimetro non sta registrando un protocollo da nessuna
// parte. Stessa forma già adottata da `admin/protocolli/export:GET`.
//
// Il finto storage LANCIA se qualcuno lo chiama: il 403 è provato anche dal
// fatto che il file non è mai stato scaricato.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-0000000000c3'
const STAGING = 'staging/prova-analisi.pdf'
/** Non è un PDF (nessun magic `%PDF-`): l'estrazione testo non parte. */
const BYTES = new TextEncoder().encode('contenuto di prova per il registro protocolli')
const IMPRONTA = sha256Impronta(BYTES)

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scaricati: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: (...a: unknown[]) => h.requireStaff(...a) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const client = creaFintoSupabase(h.db, h.tabelle)
      // Il finto client di serie LANCIA su `storage`: qui lo si sostituisce con
      // uno che registra gli accessi, così «il file non è stato scaricato» è
      // un'asserzione e non una speranza.
      ;(client as unknown as { storage: unknown }).storage = {
        from: () => ({
          download: async (path: string) => {
            h.scaricati.push(path)
            return { data: { arrayBuffer: async () => BYTES.slice().buffer }, error: null }
          },
        }),
      }
      return client
    },
  }
})

import { POST } from '@/app/api/admin/protocolli/analizza/route'

const protocollo = (id: string, scuolaId: string, numero: number) => ({
  id,
  scuola_id: scuolaId,
  anno: 2026,
  numero,
  data_registrazione: `2026-03-0${numero}T09:30:00`,
  oggetto: `Atto ${numero}`,
  impronta_sha256: IMPRONTA,
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  protocolli: [],
})

function postReq(cookie?: string): NextRequest {
  return {
    url: 'http://localhost/api/admin/protocolli/analizza',
    method: 'POST',
    headers: new Headers(),
    json: async () => ({ stagingPath: STAGING, mime: 'application/pdf' }),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scaricati = []
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/admin/protocolli/analizza — duplicati dentro il perimetro', () => {
  it('lo stesso atto già protocollato NELLA sede selezionata viene segnalato', async () => {
    h.db.protocolli = [protocollo('prot-a', SEDE_A, 7)]

    const res = await POST(postReq(SEDE_A))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.impronta).toBe(IMPRONTA)
    expect(j.data.duplicato).toMatchObject({ id: 'prot-a', numeroFormattato: '0000007/2026' })
  })

  it('lo stesso atto protocollato in UN\'ALTRA sede non è un duplicato qui', async () => {
    // La numerazione riparte da 1 in ogni sede: segnalare il n. 3 di Beta come
    // duplicato mentre si registra ad Alfa indicherebbe un atto che ad Alfa non esiste.
    h.db.protocolli = [protocollo('prot-b', SEDE_B, 3)]

    const res = await POST(postReq(SEDE_A))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.duplicato).toBeNull()
    expect(j.data.impronta).toBe(IMPRONTA)
  })
})

describe('POST /api/admin/protocolli/analizza — perimetro vuoto', () => {
  it('cookie su una sede non accessibile ⇒ 403: niente download, niente lettura, nessun «non è un duplicato» detto a vuoto', async () => {
    h.db.protocolli = [protocollo('prot-a', SEDE_A, 7)]

    const res = await POST(postReq(SEDE_C))

    expect(res.status).toBe(403)
    const j = await res.json()
    expect(j.error).toMatch(/sede/i)
    // Il gate viene PRIMA del lavoro: il file di staging non è stato scaricato…
    expect(h.scaricati).toEqual([])
    // …e il registro non è stato nemmeno interrogato.
    expect(h.tabelle).not.toContain('protocolli')
  })
})
