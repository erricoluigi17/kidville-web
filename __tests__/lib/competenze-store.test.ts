import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  recordSignerSlot: vi.fn(async () => ({ error: null })),
  logFeaEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/fea/slots', () => ({ recordSignerSlot: h.recordSignerSlot }))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: h.logFeaEvent }))

import {
  validaScrutinioFinaleClasseQuinta,
  generaCertificato,
} from '@/lib/competenze/certificato-store'

interface MockOpts {
  single?: Record<string, unknown>
  list?: Record<string, unknown[]>
  upsertId?: Record<string, string>
  /** Guasto PostgREST per tabella: letture e scritture di quella tabella rispondono `{ data: null, error }`. */
  errori?: Record<string, { code: string; message: string }>
}
function makeSupabase(opts: MockOpts) {
  const captures = { updates: [] as { table: string; payload: Record<string, unknown> }[] }
  const client = {
    storage: {
      listBuckets: async () => ({ data: [{ name: 'certificati-competenze' }], error: null }),
      from: () => ({
        upload: async () => ({ data: { path: 'x' }, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }),
      }),
      createBucket: async () => ({ data: null, error: null }),
    },
    from(table: string) {
      const single = opts.single?.[table] ?? null
      const list = opts.list?.[table] ?? []
      const err = opts.errori?.[table] ?? null
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.limit = () => q
      q.maybeSingle = async () => (err ? { data: null, error: err } : { data: single, error: null })
      q.single = async () => (err ? { data: null, error: err } : { data: single, error: null })
      q.then = (res: (v: { data: unknown; error: unknown }) => unknown) =>
        res(err ? { data: null, error: err } : { data: list, error: null })
      q.update = (payload: Record<string, unknown>) => {
        captures.updates.push({ table, payload })
        return { eq: async () => ({ data: null, error: err }) }
      }
      q.upsert = () => ({
        select: () => ({ single: async () => ({ data: { id: opts.upsertId?.[table] ?? `${table}-id` }, error: null }) }),
        then: (r: (v: { data: unknown; error: null }) => unknown) => r({ data: null, error: null }),
      })
      return q
    },
  }
  return { client: client as unknown as SupabaseClient, captures }
}

beforeEach(() => vi.clearAllMocks())

describe('validaScrutinioFinaleClasseQuinta', () => {
  it('422 se la sezione non è classe quinta primaria', async () => {
    const { client } = makeSupabase({ single: { sections: { id: 's', name: '3A', school_type: 'primaria', scuola_id: 'sc1' } } })
    const out = await validaScrutinioFinaleClasseQuinta(client, 's')
    expect(out.ok).toBeFalsy()
    expect(out.status).toBe(422)
  })

  it('409 se non esiste uno scrutinio finale chiuso', async () => {
    const { client } = makeSupabase({
      single: { sections: { id: 's', name: '5A', school_type: 'primaria', scuola_id: 'sc1' }, scrutini: null },
    })
    const out = await validaScrutinioFinaleClasseQuinta(client, 's')
    expect(out.status).toBe(409)
  })

  it('ok per classe quinta con scrutinio chiuso', async () => {
    const { client } = makeSupabase({
      single: {
        sections: { id: 's', name: '5A', school_type: 'primaria', scuola_id: 'sc1' },
        scrutini: { id: 'scr1', stato: 'chiuso', periodo_id: 'p1' },
        scrutinio_periodi: { anno_scolastico: '2025/2026' },
      },
    })
    const out = await validaScrutinioFinaleClasseQuinta(client, 's')
    expect(out.ok).toBe(true)
    expect(out.scrutinioId).toBe('scr1')
    expect(out.annoScolastico).toBe('2025/2026')
  })

  it('un guasto sulla sezione è 500, non il 404 «Sezione non trovata»', async () => {
    const { client } = makeSupabase({ errori: { sections: { code: '57014', message: 'timeout' } } })
    const out = await validaScrutinioFinaleClasseQuinta(client, 's')
    expect(out.ok).toBeFalsy()
    expect(out.status).toBe(500)
  })

  it('un guasto sul periodo è 500, non un anno scolastico vuoto nella chiave del certificato', async () => {
    const { client } = makeSupabase({
      single: {
        sections: { id: 's', name: '5A', school_type: 'primaria', scuola_id: 'sc1' },
        scrutini: { id: 'scr1', stato: 'chiuso', periodo_id: 'p1' },
      },
      errori: { scrutinio_periodi: { code: '57014', message: 'timeout' } },
    })
    const out = await validaScrutinioFinaleClasseQuinta(client, 's')
    expect(out.ok).toBeFalsy()
    expect(out.status).toBe(500)
  })
})

describe('generaCertificato', () => {
  const baseCert = {
    id: 'cert1', scuola_id: 'sc1', alunno_id: 'al1', section_id: 'sec1',
    scrutinio_id: 'scr1', anno_scolastico: '2025/2026', stato: 'bozza', generato_il: null,
  }
  it('genera+firma: stato "firmato", firma_applicativa scritta, slot FEA registrato', async () => {
    const { client, captures } = makeSupabase({
      single: {
        certificati_competenze: baseCert,
        alunni: { nome: 'Marco', cognome: 'Rossi', data_nascita: '2015-03-01', codice_fiscale: 'CF' },
        sections: { name: '5A', scuola_id: 'sc1' },
        schools: { nome: 'Kidville' },
        utenti: { nome: 'Anna', cognome: 'Bianchi' },
      },
      list: {
        certificato_competenza_livelli: [
          { competenza_codice: 'comunicazione_alfabetica_funzionale', livello: 'A', note: null, ordine: 0 },
        ],
      },
    })
    const out = await generaCertificato(client, 'cert1', 'dir1', true)
    expect(out.pdf).toBeInstanceOf(Buffer)
    expect(out.error).toBeUndefined()
    const upd = captures.updates.find((u) => u.table === 'certificati_competenze')
    expect(upd?.payload.stato).toBe('firmato')
    expect(upd?.payload.firma_applicativa).toBeTruthy()
    expect(upd?.payload.generato_da).toBe('dir1')
    expect(h.recordSignerSlot).toHaveBeenCalledTimes(1)
    expect((h.recordSignerSlot.mock.calls[0] as unknown as [unknown, { entitaTipo: string }])[1].entitaTipo).toBe('certificato_competenze')
    expect(h.logFeaEvent).toHaveBeenCalledTimes(1)
  })

  it('il nome del dirigente non letto è 500: nessun certificato firmato da nessuno', async () => {
    const { client, captures } = makeSupabase({
      single: {
        certificati_competenze: baseCert,
        alunni: { nome: 'Marco', cognome: 'Rossi', data_nascita: '2015-03-01', codice_fiscale: 'CF' },
        sections: { name: '5A', scuola_id: 'sc1' },
        schools: { nome: 'Kidville' },
      },
      errori: { utenti: { code: '57014', message: 'timeout' } },
    })
    const out = await generaCertificato(client, 'cert1', 'dir1', true)
    expect(out.status).toBe(500)
    expect(out.pdf).toBeUndefined()
    expect(captures.updates).toEqual([])
    expect(h.recordSignerSlot).not.toHaveBeenCalled()
  })

  it('la marcatura «firmato» non scritta NON registra lo slot FEA né l’evento signed', async () => {
    const { client } = makeSupabase({
      single: {
        alunni: { nome: 'Marco', cognome: 'Rossi', data_nascita: '2015-03-01', codice_fiscale: 'CF' },
        sections: { name: '5A', scuola_id: 'sc1' },
        schools: { nome: 'Kidville' },
        utenti: { nome: 'Anna', cognome: 'Bianchi' },
      },
    })
    // Lettura del certificato riuscita, update respinto: un client con l'errore solo in scrittura.
    const base = client as unknown as { from: (t: string) => Record<string, unknown> }
    const daOriginale = base.from.bind(base)
    base.from = (t: string) => {
      const q = daOriginale(t)
      if (t !== 'certificati_competenze') return q
      q.maybeSingle = async () => ({ data: baseCert, error: null })
      q.update = () => ({ eq: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) })
      return q
    }
    const out = await generaCertificato(client, 'cert1', 'dir1', true)
    // Il PDF torna comunque (contratto di oggi: archiviazione non bloccante), ma senza firma a sistema.
    expect(out.pdf).toBeInstanceOf(Buffer)
    expect(h.recordSignerSlot).not.toHaveBeenCalled()
    expect(h.logFeaEvent).not.toHaveBeenCalled()
  })

  it('404 se il certificato non esiste', async () => {
    const { client } = makeSupabase({ single: { certificati_competenze: null } })
    const out = await generaCertificato(client, 'nope', 'dir1', true)
    expect(out.status).toBe(404)
    expect(out.pdf).toBeUndefined()
  })
})
