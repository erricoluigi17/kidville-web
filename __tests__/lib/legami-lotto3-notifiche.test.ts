import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// A6 · LOTTO 3 — verso INVERSO (alunno → genitori destinatari). È il più grave:
// qui non si tratta di una lista vuota che il genitore vede, ma di una notifica
// che NON gli arriva mai — e nessuno se ne accorge, perché "zero destinatari" e
// "nessun tutore a sistema" sono indistinguibili dall'esterno.
//
// Sorgenti: runtime `legame_genitori_alunni` + anagrafica `student_parents` via
// ponte `parents.auth_user_id`. Qui la runtime è VUOTA di proposito.

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  enqueueNotifiche: vi.fn(),
  isNotificaAbilitata: vi.fn(),
}))

vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/notifiche/config', () => ({
  isNotificaAbilitata: h.isNotificaAbilitata,
  invalidateNotificheConfigCache: () => {},
}))

import { genitoriDiAlunni } from '@/lib/notifiche/destinatari'
import { notificaMerchArrivato } from '@/lib/merch/notify'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'

function makeSupabase(righePerTabella: Record<string, Record<string, unknown>[]>): SupabaseClient {
  return {
    from(tabella: string) {
      const righe = () => righePerTabella[tabella] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.is = chain; b.order = chain
      b.insert = chain; b.delete = chain
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: righe(), error: null })
      return b
    },
  } as unknown as SupabaseClient
}

/** Legame presente SOLO in anagrafica; il ponte porta all'account `acc9`. */
const soloAnagrafica = (): Record<string, Record<string, unknown>[]> => ({
  legame_genitori_alunni: [],
  student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
  parents: [{ id: 'p1', auth_user_id: 'acc9' }],
  alunni: [{ id: ALUNNO, scuola_id: 'sc-1' }],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.isNotificaAbilitata.mockResolvedValue(true)
})

describe('genitoriDiAlunni (lib/notifiche/destinatari)', () => {
  it('include il genitore legato SOLO via student_parents', async () => {
    const sb = makeSupabase(soloAnagrafica())
    expect(await genitoriDiAlunni(sb, [ALUNNO])).toEqual(['acc9'])
  })

  it('un parents senza account non produce destinatari', async () => {
    const righe = soloAnagrafica()
    righe.parents = [{ id: 'p1', auth_user_id: null }]
    expect(await genitoriDiAlunni(makeSupabase(righe), [ALUNNO])).toEqual([])
  })

  it('dedup fra runtime e anagrafica (stesso account da due sorgenti)', async () => {
    const righe = soloAnagrafica()
    righe.legame_genitori_alunni = [{ alunno_id: ALUNNO, genitore_id: 'acc9' }]
    expect(await genitoriDiAlunni(makeSupabase(righe), [ALUNNO])).toEqual(['acc9'])
  })

  it('lista vuota in ingresso: nessun destinatario', async () => {
    expect(await genitoriDiAlunni(makeSupabase({}), [])).toEqual([])
  })
})

describe('merch/notify — notifica arrivo materiale', () => {
  it('accoda al genitore legato SOLO via student_parents', async () => {
    await notificaMerchArrivato(makeSupabase(soloAnagrafica()), {
      alunnoId: ALUNNO,
      articoli: ['Grembiule'],
      ordineId: 'ord-1',
    })
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
    expect(h.enqueueNotifiche.mock.calls[0][1]).toMatchObject({
      utenteIds: ['acc9'],
      tipo: 'merch_arrivato',
    })
  })

  it('nessun destinatario → nessuna coda', async () => {
    const righe = soloAnagrafica()
    righe.student_parents = []
    await notificaMerchArrivato(makeSupabase(righe), { alunnoId: ALUNNO, articoli: [] })
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })
})

describe('primaria/notifiche — enqueueNotifichePerAlunni', () => {
  it('accoda al genitore legato SOLO via student_parents', async () => {
    await enqueueNotifichePerAlunni(makeSupabase(soloAnagrafica()), {
      alunnoIds: [ALUNNO],
      tipo: 'nota_disciplinare',
      titolo: 'Nuova nota',
    })
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
    expect(h.enqueueNotifiche.mock.calls[0][1]).toMatchObject({ utenteIds: ['acc9'] })
  })

  it('nessun destinatario → nessuna coda', async () => {
    const righe = soloAnagrafica()
    righe.student_parents = []
    await enqueueNotifichePerAlunni(makeSupabase(righe), {
      alunnoIds: [ALUNNO],
      tipo: 'nota_disciplinare',
      titolo: 'Nuova nota',
    })
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })
})
