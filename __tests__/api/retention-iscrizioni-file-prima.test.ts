import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// La conservazione a 24 mesi — PRIMA i file, POI le righe. E «prima» va provato.
//
// ─── DUE DIFETTI, LO STESSO INVARIANTE ──────────────────────────────────────
//
// 1. La versione SQL di questo lavoro (migrazione `20260801081423`) cancellava i
//    file con `DELETE FROM storage.objects`. Postgres lo vieta — trigger
//    `protect_objects_delete`, FOR EACH STATEMENT, scatta anche a zero righe — e la
//    funzione falliva con `42501` a ogni esecuzione, PRIMA di scrivere la riga di
//    log che avrebbe dovuto segnalarlo.
//
// 2. La route che l'ha sostituita dichiarava `ok: true` anche quando i file NON
//    erano stati rimossi. `supabase.storage.remove()` non fallisce sui percorsi che
//    non esistono: restituisce `data: []` con `error: null`. La route guardava solo
//    `error`, quindi «zero file rimossi su tre attesi» passava per un successo — e
//    le righe venivano cancellate lo stesso.
//
// Il secondo è peggiore del primo. Il primo non cancellava niente e si sarebbe
// scoperto; il secondo cancella la RIGA e lascia il DOCUMENTO D'IDENTITÀ di un
// minore nell'archivio, senza più nessun dato che lo nomini: invisibile, non
// cancellato. È l'esatto contrario di ciò che una regola di conservazione promette,
// ed è il modo peggiore di conservare un dato personale.
//
// ─── COSA PROVA QUESTO FILE ─────────────────────────────────────────────────
//
// L'ORDINE e la RINUNCIA, non lo status: che i file siano tolti prima delle righe,
// e che quando la rimozione non riesce — per errore o per silenzio — le righe
// restino dove sono. Con il controllo positivo accanto, perché una route che non
// cancella mai niente passerebbe un test fatto di sole rinunce.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
  /** La sequenza REALE delle operazioni: è l'ordine la cosa da provare. */
  sequenza: [] as { tipo: 'remove' | 'delete'; valore: unknown }[],
  /** Le domande scadute che la lettura restituisce. */
  scadute: [] as Record<string, unknown>[],
  /** Cosa risponde `storage.remove()`: il cuore del secondo difetto. */
  removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
  erroreLettura: null as unknown,
  erroreDelete: null as unknown,
  eventi: [] as { livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (_evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'lt', 'eq']) qb[m] = () => qb
      qb.delete = () => ({
        in: (_c: string, ids: unknown) => {
          h.sequenza.push({ tipo: 'delete', valore: ids })
          return Promise.resolve({ error: h.erroreDelete })
        },
      })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.scadute, error: h.erroreLettura }).then(res)
      return qb
    },
    storage: {
      from: () => ({
        remove: (percorsi: string[]) => {
          h.sequenza.push({ tipo: 'remove', valore: percorsi })
          return Promise.resolve(
            h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
          )
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

const chiama = () =>
  POST(
    new Request('http://localhost/api/gdpr/retention-iscrizioni', {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }),
  )

/** Una domanda scaduta con due documenti allegati. */
const domandaConAllegati = (id: string) => ({
  id,
  data: {
    children: [{ documento_path: `${id}/minore.pdf` }],
    adults: [{ documento_path: `${id}/adulto.pdf` }],
  },
})

const soloDelete = () => h.sequenza.filter((c) => c.tipo === 'delete')
const soloRemove = () => h.sequenza.filter((c) => c.tipo === 'remove')

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.scadute = []
  h.removeRisposta = null
  h.erroreLettura = null
  h.erroreDelete = null
  h.eventi = []
  process.env.CRON_SECRET = CRON_SECRET
})

describe('POST /api/gdpr/retention-iscrizioni — i file prima delle righe', () => {
  it('CONTROLLO POSITIVO: con tutto a posto cancella file E righe, in quest’ordine', async () => {
    // Senza questo, l'intero file certificherebbe una route che non cancella mai
    // niente — cioè una conservazione che non conserva e non cancella.
    h.scadute = [domandaConAllegati('d1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 2 })
    expect(h.sequenza.map((c) => c.tipo), 'prima remove, poi delete').toEqual(['remove', 'delete'])
  })

  it('🔴 se lo Storage rimuove MENO file di quelli attesi, le righe NON si toccano', async () => {
    // Il difetto misurato: `remove()` su un percorso inesistente risponde
    // `data: []`, `error: null`. Guardando solo `error` la route proseguiva, e il
    // documento restava nell'archivio mentre la riga che lo nominava spariva.
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [], error: null }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'allegati-non-rimossi' })
    expect(soloDelete(), 'nessuna riga cancellata').toHaveLength(0)
  })

  it('🔴 …e lo dice come ERRORE, con quanti ne mancano', async () => {
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [{ name: 'd1/minore.pdf' }], error: null }
    await chiama()
    const errore = h.eventi.find((e) => e.livello === 'error')
    expect(errore, 'un fallimento silenzioso è il difetto, non la conseguenza').toBeTruthy()
    expect(errore?.campi.n_file_falliti).toBe(1)
  })

  it('se lo Storage risponde con un errore vero, le righe NON si toccano', async () => {
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: null, error: { message: 'storage giù' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDelete()).toHaveLength(0)
  })

  it('nessuna domanda scaduta ⇒ nessuna operazione, e il conteggio si scrive LO STESSO', async () => {
    // «Nessuna riga» non può voler dire insieme «tutto a posto» e «non è mai
    // partito»: è la riga che nella versione SQL non veniva scritta MAI, perché
    // stava dopo la DELETE che faceva fallire tutto.
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 0, file: 0 })
    expect(soloRemove(), 'niente da togliere, nessuna chiamata allo Storage').toHaveLength(0)
    const info = h.eventi.find((e) => e.livello === 'info')
    expect(info?.campi.esito).toBe('retention-iscrizioni')
    expect(info?.campi.n_domande).toBe(0)
  })

  it('una domanda SENZA allegati si cancella comunque', async () => {
    h.scadute = [{ id: 'd2', data: { children: [{}], adults: [] } }]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 0 })
    expect(soloDelete()).toHaveLength(1)
  })

  it('un guasto di LETTURA non passa per «nessuna domanda scaduta»', async () => {
    // PostgREST non lancia: senza controllare `error`, un guasto diventerebbe un
    // giro a vuoto che si dichiara riuscito.
    h.erroreLettura = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDelete()).toHaveLength(0)
    expect(soloRemove()).toHaveLength(0)
  })

  it('senza il segreto del cron si passa dal gate dello staff', async () => {
    const { requireStaff } = await import('@/lib/auth/require-staff')
    await POST(new Request('http://localhost/api/gdpr/retention-iscrizioni', { method: 'POST' }))
    expect(requireStaff).toHaveBeenCalled()
  })
})
