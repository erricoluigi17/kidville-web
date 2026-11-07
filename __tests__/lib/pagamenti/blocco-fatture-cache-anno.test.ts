import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/require-staff'

/**
 * PR 3 · COMPITO 3.7-2b · la cache dell'anno attivo di `intestatari.ts` la passa davvero chi la possiede: UNA `Map`
 * per blocco di fatture (`eseguiBloccoFatture`). Con due bambini della stessa sede l'rpc `anno_attivo` parte UNA volta.
 * Si conta l'rpc vera (non la funzione `annoAttivoDiSede`), perché una cache non passata è verde su un mock piatto.
 */

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const A1 = 'c1c1c1c1-0000-4000-8000-000000000001'
const A2 = 'c2c2c2c2-0000-4000-8000-000000000002'
const ANNO = 'b1b1b1b1-0000-4000-8000-0000000000aa'

const h = vi.hoisted(() => ({
  emetti: vi.fn(),
  scriviFrequenza: vi.fn(),
  rpcAnno: vi.fn(),
}))

vi.mock('@/lib/aruba/emissione', async (orig) => ({
  ...(await orig<typeof import('@/lib/aruba/emissione')>()),
  emettiFatturaPagamento: h.emetti,
  creaSessioneAruba: () => ({}),
}))
vi.mock('@/lib/pagamenti/lotto-fatture', async (orig) => ({
  ...(await orig<typeof import('@/lib/pagamenti/lotto-fatture')>()),
  PAUSA_FRA_UPLOAD_MS: 0,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async () => [SEDE],
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
}))

import { eseguiBloccoFatture, type RigaBlocco } from '@/lib/pagamenti/esegui-blocco-fatture'

const attore = { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } as unknown as AppUser
const persona = {
  tipo: 'persona' as const, codice_fiscale: 'XQQYKV85H50Z999J', nome: 'Anna', cognome: 'Bianchi',
  indirizzo: 'Via Prova 1', cap: '80014', comune: 'Giugliano',
}
const riga = (pagamento_id: string): RigaBlocco => ({
  pagamento_id, attoreId: 'seg-1', attoreAudit: attore, intestatario: persona, ricordaSullaScheda: true,
})

let db: DBFinto
const client = () => {
  db = {
    alunni: [
      { id: A1, scuola_id: SEDE, intestatario_fatture: null },
      { id: A2, scuola_id: SEDE, intestatario_fatture: null },
    ],
  }
  return creaFintoSupabase(db, [], { rpc: { anno_attivo: async (a) => h.rpcAnno(a) } })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rpcAnno.mockResolvedValue({ data: ANNO, error: null })
  h.scriviFrequenza.mockResolvedValue({ ok: true })
  h.emetti.mockImplementation(async (_s: unknown, pagamentoId: string) => ({
    ok: true, gia: false, numero: 1, numeroFattura: 'F/1', alunnoId: pagamentoId === 'p1' ? A1 : A2,
  }))
})

describe('eseguiBloccoFatture — cache dell’anno attivo', () => {
  it('due bambini della stessa sede: l’rpc anno_attivo parte UNA volta, scriviFrequenza due', async () => {
    const esito = await eseguiBloccoFatture(client(), [riga('p1'), riga('p2')], { operazione: 'test' })
    expect(esito.emesse).toHaveLength(2)
    expect(h.rpcAnno).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(2)
    expect(h.scriviFrequenza.mock.calls.map((c) => c[1].alunnoId)).toEqual([A1, A2])
  })

  it('due blocchi diversi non condividono la cache: un rpc ciascuno', async () => {
    const c = client()
    await eseguiBloccoFatture(c, [riga('p1')], { operazione: 'test' })
    await eseguiBloccoFatture(c, [riga('p2')], { operazione: 'test' })
    expect(h.rpcAnno).toHaveBeenCalledTimes(2)
  })
})
