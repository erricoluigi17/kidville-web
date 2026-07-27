import { describe, it, expect, vi } from 'vitest'
import { assertConversazioneNonSospesa } from '@/lib/chat/sospensione-conversazione'

// C5 · Sospensione di una CONVERSAZIONE 1:1 (chat scuola↔famiglia), granularità
// THREAD. La guardia legge la SOLA sospensione attiva (indice parziale
// riaperta_il IS NULL) e blocca chi è `sospesa_verso`; chi ha sospeso può ancora
// scrivere. Su tabella assente (DB E2E non migrato) degrada a "non sospesa".

const SENDER = 'aaaaaaaa-0000-4000-8000-000000000001'
const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000002'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'

// Fake supabase: programma { data, error } per la singola query puntuale.
function fakeSupabase(resp: { data?: unknown; error?: unknown }) {
  return {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.maybeSingle = async () => ({ data: resp.data ?? null, error: resp.error ?? null })
      return b
    },
  } as never
}

describe('assertConversazioneNonSospesa', () => {
  it('null se non esiste una sospensione attiva sul thread', async () => {
    expect(await assertConversazioneNonSospesa(fakeSupabase({ data: null }), THREAD, SENDER)).toBeNull()
  })

  it('403 motivo conversazione_sospesa se il mittente è chi è stato sospeso (sospesa_verso)', async () => {
    const res = await assertConversazioneNonSospesa(
      fakeSupabase({ data: { sospesa_verso: SENDER } }),
      THREAD,
      SENDER,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.motivo).toBe('conversazione_sospesa')
  })

  it('null se il mittente è chi HA sospeso (può ancora scrivere)', async () => {
    // La sospensione è attiva ma verso l'ALTRO partecipante: il sospendente scrive.
    const res = await assertConversazioneNonSospesa(
      fakeSupabase({ data: { sospesa_verso: ALTRO } }),
      THREAD,
      SENDER,
    )
    expect(res).toBeNull()
  })

  it('degrada a null se la tabella non esiste (DB E2E non migrato, 42P01)', async () => {
    const res = await assertConversazioneNonSospesa(
      fakeSupabase({ error: { code: '42P01' } }),
      THREAD,
      SENDER,
    )
    expect(res).toBeNull()
  })

  it('non fa mai transitare il MOTIVO in un log in chiaro (criterio 6)', async () => {
    const logger = await import('@/lib/logging/logger')
    const spia = vi.spyOn(logger, 'logEvento')
    await assertConversazioneNonSospesa(
      fakeSupabase({ data: { sospesa_verso: SENDER, motivo: 'MOTIVO_SEGRETO_XYZ' } }),
      THREAD,
      SENDER,
    )
    const dump = JSON.stringify(spia.mock.calls)
    expect(dump).not.toContain('MOTIVO_SEGRETO_XYZ')
    spia.mockRestore()
  })
})
