import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// V5 — UNA ROTTA ANONIMA, SENZA TETTO, CHE SCRIVEVA COL SERVICE-ROLE.
//
// `GET /api/iscrizione/model` è pubblica per una ragione buona: il wizard
// `/iscrizione` deve riflettere le modifiche che la segreteria fa al modulo. Ma:
//
//  · chiamava `ensureStandardEnrollmentModel(supabase)` con un client
//    **service-role**, che fa un `SELECT` e, se non trova il modello, un `INSERT`.
//    Cioè un anonimo, senza credenziali, innescava una scrittura;
//  · non aveva **nessun tetto per IP**, mentre le altre porte pubbliche di questo
//    repo ce l'hanno (`public/cancellazione-account`, `forms/send-otp`).
//
// Misurato in produzione il 2026-08-03: il modello standard ESISTE
// (`f0000000-…-0001`, attivo, con schema). Quel ramo di creazione non è mai servito
// a niente in produzione — restava lì solo come superficie di scrittura raggiungibile
// da chiunque.
//
// Chi crea il modello, quando serve: `POST /api/admin/form-models/reset`, che è dietro
// il gate dello staff. La porta pubblica LEGGE e basta; se il modello non c'è ancora,
// risponde con lo schema di default — che è già il comportamento del ramo di ripiego.
//
// «Idempotente» non vuol dire «innocua»: la scrittura non è l'unico danno. È il
// perimetro che cambia — una rotta senza autenticazione che può inserire righe è una
// superficie diversa da una che può solo leggere.
// =============================================================================

const h = vi.hoisted(() => ({
  scritture: [] as { tabella: string; metodo: string }[],
  letture: [] as string[],
  schema: null as unknown,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => {
        h.letture.push(tabella)
        return b
      }
      b.eq = () => b
      b.insert = () => {
        h.scritture.push({ tabella, metodo: 'insert' })
        return Promise.resolve({ data: null, error: null })
      }
      b.upsert = () => {
        h.scritture.push({ tabella, metodo: 'upsert' })
        return Promise.resolve({ data: null, error: null })
      }
      b.update = () => {
        h.scritture.push({ tabella, metodo: 'update' })
        return b
      }
      b.maybeSingle = async () => ({ data: h.schema, error: null })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: h.schema, error: null }).then(res)
      return b
    },
  }),
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { GET } from '@/app/api/iscrizione/model/route'
import { resetRateLimit } from '@/lib/security/rate-limit'

const chiama = (ip = '203.0.113.9') =>
  GET(
    new Request('http://localhost/api/iscrizione/model', {
      headers: { 'x-forwarded-for': ip },
    }) as never,
  )

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimit()
  h.scritture = []
  h.letture = []
  h.schema = { schema: { pages: [] } }
})

describe('GET /api/iscrizione/model — pubblica, quindi legge e basta (V5)', () => {
  it('non innesca NESSUNA scrittura, nemmeno quando il modello non c’è', async () => {
    h.schema = null // il modello non esiste: è il caso in cui prima faceva l'INSERT
    const res = await chiama()

    expect(res.status).toBe(200)
    expect(
      h.scritture,
      'una richiesta anonima e senza credenziali ha innescato una scrittura con il client ' +
        'service-role: la porta pubblica del modulo d’iscrizione deve solo leggere',
    ).toEqual([])
  })

  it('e in quel caso risponde comunque con uno schema utilizzabile', async () => {
    // Il degrado deve restare quello di prima: il wizard riceve lo schema di
    // default, non un errore. Togliere la scrittura non deve rompere il modulo.
    h.schema = null
    const res = await chiama()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.schema).toBeDefined()
    expect(Array.isArray(body.schema.pages)).toBe(true)
  })

  it('CONTROLLO POSITIVO — quando il modello c’è, torna quello della segreteria', async () => {
    h.schema = { schema: { pages: [{ id: 'pagina-della-segreteria', fields: [] }] } }
    const res = await chiama()
    const body = await res.json()
    expect(body.schema.pages[0].id).toBe('pagina-della-segreteria')
  })

  it('ha un tetto per IP, come le altre porte pubbliche', async () => {
    // Il numero esatto non è il punto: il punto è che oltre una certa frequenza si
    // risponda 429 invece di continuare a servire all'infinito.
    let visto429 = false
    for (let i = 0; i < 200; i++) {
      const res = await chiama('198.51.100.4')
      if (res.status === 429) {
        visto429 = true
        expect(res.headers.get('Retry-After')).toBeTruthy()
        break
      }
    }
    expect(
      visto429,
      'nessun tetto per IP su una rotta pubblica che apre un client service-role',
    ).toBe(true)
  })

  it('il tetto è PER IP: un altro indirizzo non paga per il primo', async () => {
    for (let i = 0; i < 200; i++) {
      const res = await chiama('198.51.100.5')
      if (res.status === 429) break
    }
    const altro = await chiama('198.51.100.6')
    expect(altro.status).toBe(200)
  })
})
