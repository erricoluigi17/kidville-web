import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// -----------------------------------------------------------------------------
// DEGRADAZIONE CI — schema «cassa» assente (test di CONTRATTO, step E4.1).
//
// Il DB E2E della CI è un progetto separato NON migrato: le tabelle
// `cassa_movimenti`/`cassa_categorie`/`cassa_chiusure`, la colonna
// `admin_settings.cassa_config` e la RPC `registra_chiusura_cassa` NON esistono.
// PostgREST NON lancia: ritorna `{ error: { code } }`. Ogni route della cassa
// DEVE degradare in modo pulito — `{ disponibile: false }`, MAI un 500 — e NON
// deve farlo in silenzio (§3.5 del piano: «logEvento('cassa',…)/logErrore»;
// E4.1: «il silenzio è vietato»).
//
// I codici coperti sono quelli di `CASSA_SCHEMA_ASSENTE` (src/lib/cassa/saldo.ts):
//   42P01     relazione inesistente (SELECT su tabella assente)
//   42703     colonna inesistente (SELECT)
//   PGRST202  funzione RPC non trovata (chiusura)
//   PGRST204  colonna assente su INSERT/UPDATE
//   PGRST205  tabella non nel cache dello schema
//
// ⚠️ TDD DI CONTRATTO: le route sotto le scrivono in parallelo esecutore-opus-1
// (movimenti/storno) ed esecutore-opus-2 (saldo/chiusura/report/categorie).
// Finché quei moduli non esistono, questo file è ROSSO all'import: è il RED
// atteso, il join lo porta al VERDE se le route rispettano il contratto.
// -----------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  // Codice d'errore che il client Supabase mockato restituisce a OGNI query/RPC.
  code: '42P01' as string,
  // Spie sul logger: contano SOLO logEvento/logErrore (non logOk), per verificare
  // che il ramo degradato abbia loggato attivamente e non si sia limitato al
  // successo osservato da withRoute.
  logOk: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  SC: '11111111-1111-4111-8111-111111111111',
  ADMIN: '99999999-9999-4999-8999-999999999999',
}))

// Client service-role che risponde SEMPRE `{ error: { code } }`, comunque venga
// concatenato. Un Proxy copre qualunque catena (`.select().eq().gte().order()…`)
// e i terminali awaitable (`then`/`maybeSingle`/`single`).
vi.mock('@/lib/supabase/server-client', () => {
  const risultato = () => ({ data: null, error: { code: h.code, message: `schema cassa assente (${h.code})` } })
  const builder = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(risultato())
          if (prop === 'maybeSingle' || prop === 'single' || prop === 'csv') return async () => risultato()
          if (typeof prop === 'symbol') return undefined
          // Qualunque metodo di query (select/eq/in/gte/lte/order/limit/…) è chainable.
          return () => builder()
        },
      },
    )
  const client = {
    rpc: () => builder(),
    from: () => builder(),
    storage: { from: () => ({ createSignedUrl: async () => risultato(), upload: async () => risultato() }) },
  }
  return { createAdminClient: async () => client, createClient: async () => client }
})

// Gate: sempre admin, così ogni route (incluse quelle `['admin']`) raggiunge il
// ramo di degradazione invece di fermarsi a 401/403.
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: h.ADMIN, role: 'admin', scuola_id: h.SC } }),
}))

// Scoping deterministico su un'unica sede.
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => [h.SC],
  resolveScuolaScrittura: async () => h.SC,
}))

// Logger: si tiene tutto il modulo reale (EVENTI_PERSISTITI, vaPersistito, … che
// altri moduli importano) e si spiano solo le tre funzioni di emissione.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logOk: h.logOk, logErrore: h.logErrore, logEvento: h.logEvento }
})

// Route sotto test (E1: movimenti/storno · E2: saldo/chiusura/report/categorie).
import { GET as movimentiGET, POST as movimentiPOST } from '@/app/api/pagamenti/cassa/movimenti/route'
import { POST as stornoPOST } from '@/app/api/pagamenti/cassa/movimenti/storno/route'
import { GET as saldoGET } from '@/app/api/pagamenti/cassa/saldo/route'
import { GET as chiusuraGET, POST as chiusuraPOST } from '@/app/api/pagamenti/cassa/chiusura/route'
import { GET as reportGET } from '@/app/api/pagamenti/cassa/report/route'
import { GET as categorieGET } from '@/app/api/pagamenti/cassa/categorie/route'

const CAT = '22222222-2222-4222-8222-222222222222'
const MOV = '33333333-3333-4333-8333-333333333333'
const CODICI = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'] as const

// NextRequest: le route E2 sono tipate `(request: NextRequest)`, quelle E1
// accettano `Request` — il sottotipo soddisfa entrambe (gate tsc della CI).
function reqGet(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: { 'x-user-id': h.ADMIN } })
}
function reqPost(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': h.ADMIN },
    body: JSON.stringify(body),
  })
}

// Ogni descrittore invoca la sua route con un payload VALIDO (che supera zod):
// così il 500/degrade dipende dallo schema assente, non da un 400 di validazione.
const ROTTE: { nome: string; chiama: () => Promise<Response> }[] = [
  {
    nome: 'movimenti:GET',
    chiama: () => movimentiGET(reqGet(`/api/pagamenti/cassa/movimenti?scuola_id=${h.SC}`)),
  },
  {
    nome: 'movimenti:POST',
    chiama: () =>
      movimentiPOST(
        reqPost('/api/pagamenti/cassa/movimenti', {
          scuola_id: h.SC,
          tipo: 'uscita',
          importo: 12.5,
          metodo: 'contanti',
          categoria_id: CAT,
          descrizione: 'Test degradazione',
        }),
      ),
  },
  {
    nome: 'movimenti/storno:POST',
    chiama: () =>
      stornoPOST(reqPost('/api/pagamenti/cassa/movimenti/storno', { movimento_id: MOV, motivo: 'errore di cassa' })),
  },
  {
    nome: 'saldo:GET',
    chiama: () => saldoGET(reqGet(`/api/pagamenti/cassa/saldo?scuola_id=${h.SC}`)),
  },
  {
    nome: 'chiusura:GET',
    chiama: () => chiusuraGET(reqGet(`/api/pagamenti/cassa/chiusura?scuola_id=${h.SC}`)),
  },
  {
    nome: 'chiusura:POST',
    chiama: () =>
      chiusuraPOST(reqPost('/api/pagamenti/cassa/chiusura', { scuola_id: h.SC, contato: 100, note: 'chiusura test' })),
  },
  {
    nome: 'report:GET',
    chiama: () => reportGET(reqGet(`/api/pagamenti/cassa/report?scuola_id=${h.SC}`)),
  },
  {
    nome: 'categorie:GET',
    chiama: () => categorieGET(reqGet(`/api/pagamenti/cassa/categorie?scuola_id=${h.SC}`)),
  },
]

describe('Cassa · degradazione CI (schema assente)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.code = '42P01'
  })

  for (const rotta of ROTTE) {
    describe(rotta.nome, () => {
      for (const code of CODICI) {
        it(`${code} → mai 500, risponde { disponibile: false }`, async () => {
          h.code = code
          const res = await rotta.chiama()
          // Il contratto CI: nessun crash (5xx a parte 503), corpo che dichiara
          // il modulo non disponibile.
          expect(res.status).not.toBe(500)
          expect([200, 503]).toContain(res.status)
          const body = (await res.json()) as { disponibile?: unknown }
          expect(body.disponibile).toBe(false)
        })
      }

      it('il ramo degradato NON è muto (logEvento/logErrore)', async () => {
        h.code = '42P01'
        await rotta.chiama()
        const emessi = h.logEvento.mock.calls.length + h.logErrore.mock.calls.length
        expect(emessi).toBeGreaterThan(0)
      })
    })
  }
})
