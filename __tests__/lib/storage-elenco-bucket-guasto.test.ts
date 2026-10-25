// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * `listBuckets()` non lancia: risponde `{ data: null, error }`. Fino al 20/10 quel `null` voleva dire «il bucket
 * non c'è», e lo si creava alla cieca senza una riga che dicesse che l'elenco non era arrivato.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

import { ensureCassaBucket, CASSA_BUCKET } from '@/lib/cassa/store'
import { ensureBucket, PROTOCOLLO_BUCKET } from '@/lib/protocolli/store'

function client(elenco: { data: { name: string }[] | null; error: unknown }) {
  const listBuckets = vi.fn(async () => elenco)
  const createBucket = vi.fn(async () => ({ data: null, error: null }))
  return { sb: { storage: { listBuckets, createBucket } } as unknown as SupabaseClient, createBucket }
}

beforeEach(() => vi.clearAllMocks())

describe.each([
  { nome: 'ensureCassaBucket', garantisci: ensureCassaBucket, bucket: CASSA_BUCKET, operazione: 'ensureCassaBucket' },
  { nome: 'ensureBucket dei protocolli', garantisci: ensureBucket, bucket: PROTOCOLLO_BUCKET, operazione: 'protocolli/store:ensureBucket' },
])('$nome — l’elenco non riuscito non diventa «bucket assente»', ({ garantisci, bucket, operazione }) => {
  it('elenco in errore: nessuna creazione alla cieca, una riga `warn` col motivo', async () => {
    const guasto = { name: 'StorageApiError', message: 'Gateway Timeout', status: 504 }
    const { sb, createBucket } = client({ data: null, error: guasto })
    await garantisci(sb)
    expect(createBucket).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'warn', {
      operazione,
      bucket,
      esito: 'bucket_non_verificato',
    }, guasto)
  })

  it('bucket presente: niente da fare, nessuna riga', async () => {
    const { sb, createBucket } = client({ data: [{ name: bucket }], error: null })
    await garantisci(sb)
    expect(createBucket).not.toHaveBeenCalled()
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('bucket assente: lo crea privato', async () => {
    const { sb, createBucket } = client({ data: [{ name: 'altro' }], error: null })
    await garantisci(sb)
    expect(createBucket).toHaveBeenCalledWith(bucket, expect.objectContaining({ public: false }))
  })
})
