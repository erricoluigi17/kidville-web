import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: vi.fn(),
}))

import { risolviSedeRichiestaCancellazione } from '@/lib/gdpr/sede-richiesta'

// =============================================================================
// W1 — la sede di una richiesta di cancellazione si RICAVA DAI FIGLI.
//
// Fino al 2026-07-31 la sede era `auth.user.scuola_id ?? scuolaUnicaReale(admin)`,
// e `scuolaUnicaReale` è deprecata: con TRE sedi reali ritorna sempre `null`.
// Una richiesta con `scuola_id NULL` è invisibile al GET della Direzione
// (`.in('scuola_id', plessi)` scarta i NULL) e la POST di evasione la nega per
// sempre (sede nulla ⇒ 403); l'indice unico parziale su stato='pending' impedisce
// pure di ripresentarla. Il diritto all'oblio si blocca in silenzio, con l'app che
// continua a mostrare «richiesta in corso».
//
// Qui si blocca il contratto del sostituto: la sede viene dal DATO che ce l'ha —
// i figli del genitore — e quando resta indeterminabile si DICHIARA, non si
// inventa un NULL.
// =============================================================================

const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'

type Legame = { student_id: string; alunni: { scuola_id: string | null } | null }

interface Interrogazione {
  table: string
  filtri: Array<{ col: string; val: unknown }>
}

function fakeAdmin(opts: {
  legami?: Legame[]
  errore?: { code?: string; message?: string } | null
  interrogazioni?: Interrogazione[]
}): SupabaseClient {
  return {
    from(table: string) {
      const filtri: Array<{ col: string; val: unknown }> = []
      opts.interrogazioni?.push({ table, filtri })
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        filtri.push({ col, val })
        return b
      }
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          opts.errore
            ? { data: null, error: opts.errore }
            : { data: opts.legami ?? [], error: null },
        ).then(res)
      return b
    },
  } as unknown as SupabaseClient
}

const figlioIn = (sede: string | null, id = `al-${sede}`): Legame => ({
  student_id: id,
  alunni: sede === null ? null : { scuola_id: sede },
})

describe('risolviSedeRichiestaCancellazione', () => {
  it('un figlio in una sola sede → quella sede, anche senza preferita', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_B)] }),
      PARENT_ID,
      null,
      'test',
    )
    expect(esito).toEqual({ scuolaId: SEDE_B, sedi: [SEDE_B] })
  })

  it('interroga i legami del genitore, non un elenco globale', async () => {
    const interrogazioni: Interrogazione[] = []
    await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_A)], interrogazioni }),
      PARENT_ID,
      null,
      'test',
    )
    const q = interrogazioni.find((i) => i.table === 'student_parents')
    expect(q).toBeTruthy()
    expect(q!.filtri).toContainEqual({ col: 'parent_id', val: PARENT_ID })
  })

  it('preferita compresa fra le sedi dei figli → vince la preferita', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_A), figlioIn(SEDE_B)] }),
      PARENT_ID,
      SEDE_B,
      'test',
    )
    expect(esito).toMatchObject({ scuolaId: SEDE_B })
    expect((esito as { sedi: string[] }).sedi.sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('preferita ESTRANEA ai figli → vince la sede di un figlio (è lì che sta il minore)', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_B)] }),
      PARENT_ID,
      SEDE_C,
      'test',
    )
    expect(esito).toMatchObject({ scuolaId: SEDE_B })
  })

  it('figli in due sedi e nessuna preferita → una sede DETERMINISTICA, mai null', async () => {
    const legami = [figlioIn(SEDE_C), figlioIn(SEDE_A), figlioIn(SEDE_B)]
    const primo = await risolviSedeRichiestaCancellazione(fakeAdmin({ legami }), PARENT_ID, null, 'test')
    const secondo = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [...legami].reverse() }),
      PARENT_ID,
      null,
      'test',
    )
    expect(primo).toMatchObject({ scuolaId: SEDE_A })
    expect(secondo).toMatchObject({ scuolaId: SEDE_A })
  })

  it('genitore senza figli ma con sede propria → la sede propria', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [] }),
      PARENT_ID,
      SEDE_A,
      'test',
    )
    expect(esito).toEqual({ scuolaId: SEDE_A, sedi: [] })
  })

  it('figli senza sede sulla riga → non contano (fail-closed, niente sede inventata)', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(null, 'al-orfano')] }),
      PARENT_ID,
      null,
      'test',
    )
    expect(esito).toEqual({ scuolaId: null, motivo: 'indeterminabile', sedi: [] })
  })

  it('nessun figlio e nessuna sede propria → INDETERMINABILE, non NULL silenzioso', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [] }),
      PARENT_ID,
      null,
      'test',
    )
    expect(esito).toEqual({ scuolaId: null, motivo: 'indeterminabile', sedi: [] })
  })

  it('errore di lettura INATTESO → motivo "lettura" (non si confonde con "nessun figlio")', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ errore: { code: '08006', message: 'connessione persa' } }),
      PARENT_ID,
      SEDE_A,
      'test',
    )
    expect(esito).toEqual({ scuolaId: null, motivo: 'lettura', sedi: [] })
  })

  it('schema assente (DB E2E CI non migrato) → degrada sulla sede propria', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ errore: { code: '42703' } }),
      PARENT_ID,
      SEDE_A,
      'test',
    )
    expect(esito).toEqual({ scuolaId: SEDE_A, sedi: [] })
  })

  it('schema assente e nessuna sede propria → indeterminabile', async () => {
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ errore: { code: '42P01' } }),
      PARENT_ID,
      null,
      'test',
    )
    expect(esito).toEqual({ scuolaId: null, motivo: 'indeterminabile', sedi: [] })
  })

  it('non lancia mai: un client che esplode diventa motivo "lettura"', async () => {
    const rotto = {
      from() {
        throw new Error('client esploso')
      },
    } as unknown as SupabaseClient
    const esito = await risolviSedeRichiestaCancellazione(rotto, PARENT_ID, SEDE_A, 'test')
    expect(esito).toEqual({ scuolaId: null, motivo: 'lettura', sedi: [] })
  })

  it('parentId vuoto → indeterminabile senza toccare il database', async () => {
    const interrogazioni: Interrogazione[] = []
    const esito = await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_A)], interrogazioni }),
      '',
      null,
      'test',
    )
    expect(esito).toEqual({ scuolaId: null, motivo: 'indeterminabile', sedi: [] })
    expect(interrogazioni).toHaveLength(0)
  })
})

describe('risolviSedeRichiestaCancellazione — osservabilità', () => {
  beforeEach(() => {
    h.logEvento.mockClear()
    h.logErrore.mockClear()
  })

  it('una richiesta che tocca PIÙ sedi lascia una riga persistita (canale gdpr, warn)', async () => {
    await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_A), figlioIn(SEDE_B)] }),
      PARENT_ID,
      null,
      'test',
    )
    const riga = h.logEvento.mock.calls.find(
      (c) => c[0] === 'gdpr' && (c[2] as { esito?: string })?.esito === 'sede-richiesta-multipla',
    )
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ n: 2 })
  })

  it('una sola sede NON produce rumore', async () => {
    await risolviSedeRichiestaCancellazione(fakeAdmin({ legami: [figlioIn(SEDE_A)] }), PARENT_ID, null, 'test')
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-richiesta-multipla',
    )
    expect(riga).toBeUndefined()
  })

  it('nessuna PII nella riga: solo conteggi, esito e operazione', async () => {
    await risolviSedeRichiestaCancellazione(
      fakeAdmin({ legami: [figlioIn(SEDE_A), figlioIn(SEDE_B)] }),
      PARENT_ID,
      null,
      'test',
    )
    for (const c of h.logEvento.mock.calls) {
      const campi = c[2] as Record<string, unknown>
      expect(Object.keys(campi).sort()).toEqual(['esito', 'n', 'operazione'])
    }
  })

  it('errore di lettura inatteso → logErrore (mai un catch muto)', async () => {
    await risolviSedeRichiestaCancellazione(
      fakeAdmin({ errore: { code: '08006', message: 'connessione persa' } }),
      PARENT_ID,
      null,
      'test',
    )
    expect(h.logErrore).toHaveBeenCalledTimes(1)
  })
})
