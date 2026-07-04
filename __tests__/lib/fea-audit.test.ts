import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logFeaEvent } from '@/lib/fea/audit'

describe('logFeaEvent', () => {
  it('inserisce su fea_audit_log con i campi mappati', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await logFeaEvent(supabase, {
      entitaTipo: 'pagella',
      entitaId: 'e-1',
      signerUserId: 'u-1',
      email: 'e@x.it',
      evento: 'signed',
      hash: 'SHA256-X',
      ip: '1.2.3.4',
      userAgent: 'UA',
    })

    expect(from).toHaveBeenCalledWith('fea_audit_log')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        entita_tipo: 'pagella',
        entita_id: 'e-1',
        signer_user_id: 'u-1',
        email: 'e@x.it',
        evento: 'signed',
        hash: 'SHA256-X',
        ip: '1.2.3.4',
        user_agent: 'UA',
      })
    )
  })

  it('best-effort: non lancia se insert fallisce', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('boom'))
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await expect(logFeaEvent(supabase, { entitaTipo: 'pagella', evento: 'verify_failed' })).resolves.toBeUndefined()
  })
})
