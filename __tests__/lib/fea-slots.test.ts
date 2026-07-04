import { describe, it, expect, vi } from 'vitest'
import { isComplete, recordSignerSlot, getSlots } from '@/lib/fea/slots'
import type { SignerSlot } from '@/lib/fea/types'

function slot(over: Partial<SignerSlot>): SignerSlot {
  return {
    entita_tipo: 'pagella',
    entita_id: 'e-1',
    slot_index: 0,
    signer_user_id: 'u-1',
    stato: 'signed',
    completion_policy: 'any-one',
    signature_log: null,
    firmato_il: null,
    ...over,
  }
}

describe('isComplete', () => {
  it('false senza slot firmati', () => {
    expect(isComplete([], 'any-one')).toBe(false)
    expect(isComplete([slot({ stato: 'pending' })], 'any-one')).toBe(false)
  })

  it("any-one: true se almeno uno è firmato", () => {
    expect(isComplete([slot({ stato: 'signed' }), slot({ slot_index: 1, stato: 'pending' })], 'any-one')).toBe(true)
  })

  it('all-required: true solo se tutti gli slot sono firmati', () => {
    expect(isComplete([slot({ stato: 'signed' }), slot({ slot_index: 1, stato: 'pending' })], 'all-required')).toBe(false)
    expect(isComplete([slot({ stato: 'signed' }), slot({ slot_index: 1, stato: 'signed' })], 'all-required')).toBe(true)
  })

  it('all-required: false con array vuoto', () => {
    expect(isComplete([], 'all-required')).toBe(false)
  })
})

describe('recordSignerSlot', () => {
  it('upsert su fea_signatures con onConflict slot e stato signed', async () => {
    const upsert = vi.fn().mockReturnValue({ select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 's' }, error: null }) }) })
    const supabase = { from: vi.fn().mockReturnValue({ upsert }) } as never

    await recordSignerSlot(supabase, {
      entitaTipo: 'pagella',
      entitaId: 'e-1',
      signerUserId: 'u-1',
      signatureLog: { method: 'OTP_EMAIL', provider: 'p', email: 'e', ip: 'i', user_agent: 'ua', signed_at: '2026-06-25T00:00:00.000Z', timestamp: '2026-06-25T00:00:00.000Z', compliance: 'c' },
    })

    expect((supabase as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledWith('fea_signatures')
    const payload = upsert.mock.calls[0][0]
    const opts = upsert.mock.calls[0][1]
    expect(payload).toMatchObject({
      entita_tipo: 'pagella',
      entita_id: 'e-1',
      slot_index: 0,
      signer_user_id: 'u-1',
      stato: 'signed',
      completion_policy: 'any-one',
      firmato_il: '2026-06-25T00:00:00.000Z',
    })
    expect(opts).toMatchObject({ onConflict: 'entita_tipo,entita_id,slot_index' })
  })
})

describe('getSlots', () => {
  it('seleziona da fea_signatures filtrando per entità, ordinato per slot_index', async () => {
    const order = vi.fn().mockResolvedValue({ data: [slot({})], error: null })
    const eq2 = vi.fn().mockReturnValue({ order })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const select = vi.fn().mockReturnValue({ eq: eq1 })
    const supabase = { from: vi.fn().mockReturnValue({ select }) } as never

    const slots = await getSlots(supabase, 'pagella', 'e-1')
    expect(slots).toHaveLength(1)
    expect(eq1).toHaveBeenCalledWith('entita_tipo', 'pagella')
    expect(eq2).toHaveBeenCalledWith('entita_id', 'e-1')
  })
})
