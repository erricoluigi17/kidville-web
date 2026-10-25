// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// T4 (robustezza, seconda serie, sessione 3): la rettifica che SOSTITUISCE il documento copia
// quello di prima in `<sede>/<anno>/<numero>-versioni/` PRIMA di sovrascriverlo. Se la copia non
// riesce, la rettifica non parte e niente è cambiato. Nessun logScrittura e nessuna riga di log
// nuova sul successo: le decisioni #6 e #26 restano. Solo dati finti.

const h = vi.hoisted(() => ({
  record: {
    id: '11111111-2222-3333-4444-555555555555',
    scuola_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    anno: 2026,
    numero: 3,
    tipo: 'ingresso',
    data_registrazione: '2026-07-12T08:00:00Z',
    annullata_at: null as string | null,
    file_originale: 'aaaaaaaa-0000-4000-8000-00000000000a/2026/0000003-originale.pdf',
    file_timbrato: 'aaaaaaaa-0000-4000-8000-00000000000a/2026/0000003-timbrato.pdf',
  },
  operazioni: [] as { op: 'copy' | 'upload' | 'remove'; bucket: string; da?: string; a?: string; percorso?: string }[],
  erroreCopia: null as { message: string } | null,
  rpc: vi.fn(),
  logScrittura: vi.fn(),
  errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => ({
    user: { id: 'u-1', role: 'admin', scuola_id: 'aaaaaaaa-0000-4000-8000-00000000000a' },
  })),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/protocolli/timbro', () => ({
  applicaSegnatura: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
  immagineInPdf: vi.fn(async (b: Uint8Array) => b),
}))
vi.mock('@/lib/protocolli/assets', () => ({ logoLightBytes: () => new Uint8Array() }))
vi.mock('@/lib/protocolli/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/protocolli/server')>()),
  scaricaProtocolloBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])),
  denominazioneScuola: vi.fn(async () => 'Sede di prova'),
  eliminaStagingBestEffort: vi.fn(async () => undefined),
  firmaDownload: vi.fn(async () => 'https://firmato.test'),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: (contesto: Record<string, unknown>, err: unknown) => {
    h.errori.push({ contesto, err })
  },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from: (tabella: string) => {
      const esito = () =>
        tabella === 'protocolli'
          ? { data: h.record, error: null }
          : tabella === 'utenti_scuole'
            ? { data: [], error: null }
            : { data: null, error: null }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'or', 'order', 'range', 'limit']) {
        b[m] = () => b
      }
      b.maybeSingle = async () => esito()
      b.single = async () => esito()
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito()).then(ok, ko)
      return b
    },
    rpc: h.rpc,
    storage: {
      from: (bucket: string) => ({
        copy: async (da: string, a: string) => {
          h.operazioni.push({ op: 'copy', bucket, da, a })
          return h.erroreCopia ? { data: null, error: h.erroreCopia } : { data: { path: a }, error: null }
        },
        upload: async (percorso: string) => {
          h.operazioni.push({ op: 'upload', bucket, percorso })
          return { data: { path: percorso }, error: null }
        },
        remove: async (percorsi: string[]) => {
          h.operazioni.push({ op: 'remove', bucket, percorso: percorsi.join(',') })
          return { data: [], error: null }
        },
      }),
    },
  })),
}))

import { POST } from '@/app/api/admin/protocolli/rettifica/route'

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ORIGINALE = `${SEDE}/2026/0000003-originale.pdf`
const TIMBRATO = `${SEDE}/2026/0000003-timbrato.pdf`
const SOSTITUZIONE = {
  id: '11111111-2222-3333-4444-555555555555',
  stagingPath: 'staging/0f0f0f0f-lettera.pdf',
  nomeFile: 'lettera.pdf',
  mime: 'application/pdf',
}

const richiesta = (body: unknown) =>
  new Request('http://localhost/api/admin/protocolli/rettifica', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  h.operazioni = []
  h.erroreCopia = null
  h.errori = []
  h.eventi = []
  h.logScrittura.mockClear()
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({ data: { ...h.record }, error: null })
})

describe('POST /api/admin/protocolli/rettifica — il documento di prima resta in versioni (T4)', () => {
  it('sostituendo il documento, copia l’originale di prima in «-versioni/» PRIMA di caricare il nuovo', async () => {
    const res = await POST(richiesta(SOSTITUZIONE) as never)

    expect(res.status).toBe(200)
    const copie = h.operazioni.filter((o) => o.op === 'copy')
    expect(copie).toHaveLength(1)
    expect(copie[0].bucket).toBe('protocollo')
    expect(copie[0].da).toBe(ORIGINALE)
    expect(copie[0].a).toMatch(new RegExp(`^${SEDE}/2026/0000003-versioni/\\d{17}-0000003-originale\\.pdf$`))
    const copia = h.operazioni.findIndex((o) => o.op === 'copy')
    const primoUpload = h.operazioni.findIndex((o) => o.op === 'upload')
    expect(primoUpload).toBeGreaterThan(copia)
    // Controllo positivo: il documento nuovo è caricato davvero, originale e timbrato.
    expect(h.operazioni.filter((o) => o.op === 'upload').map((o) => o.percorso)).toEqual([ORIGINALE, TIMBRATO])
  })

  it('copia non riuscita → 500, nessun caricamento, nessuna rpc: la rettifica non parte', async () => {
    h.erroreCopia = { message: 'The resource was not found' }
    const res = await POST(richiesta(SOSTITUZIONE) as never)

    expect(res.status).toBe(500)
    expect(h.operazioni.filter((o) => o.op === 'upload')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect((await res.json()).error).toContain('la rettifica non è stata applicata')
    // Il guasto si registra dal catch che c'era già, senza percorsi né numeri della registrazione.
    const riga = h.errori.find((e) => e.contesto.operazione === 'admin/protocolli/rettifica:POST')
    expect(riga).toBeDefined()
    for (const e of h.errori) {
      expect(String((e.err as Error | null)?.message ?? '')).not.toContain('0000003')
    }
  })

  it('rettifica solo testuale: nessuna copia nello Storage (la versione di prima la tiene il database)', async () => {
    const res = await POST(richiesta({ id: SOSTITUZIONE.id, oggetto: 'Oggetto corretto' }) as never)

    expect(res.status).toBe(200)
    expect(h.operazioni.filter((o) => o.op === 'copy')).toHaveLength(0)
  })

  it('decisione #26: nessun logScrittura e nessuna riga «protocolli» sul successo', async () => {
    await POST(richiesta(SOSTITUZIONE) as never)

    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.eventi.filter((e) => e.evento === 'protocolli')).toHaveLength(0)
  })
})
