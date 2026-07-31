// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma'

/**
 * IL LIMITE DICHIARATO DEVE ESSERE QUELLO VERO.
 *
 * La route prometteva 8 MB. La piattaforma ne accetta 4,5: sopra quella soglia il corpo
 * viene rifiutato con 413 `FUNCTION_PAYLOAD_TOO_LARGE` e questo handler non parte nemmeno
 * (misurato dal vivo su produzione: 4.000.000 byte → la route risponde, 5.000.000 → 413
 * della piattaforma). Un limite che non si può onorare non è un limite: è un errore che
 * arriva più tardi e da qualcun altro, in un formato che il client non sa leggere.
 *
 * Resta una finestra in cui il controllo di questa route è l'unico possibile — i file fra
 * il nostro tetto e quello della piattaforma — ed è quella che si collauda qui.
 */

const h = vi.hoisted(() => ({ uploads: [] as string[] }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: () => ({
        upload: async (path: string) => { h.uploads.push(path); return { error: null } },
      }),
    },
  }),
}))

import { POST } from '@/app/api/iscrizione/upload/route'

function richiesta(file: File): Request {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('folder', 'modulo-iscrizione')
  return new Request('http://localhost/api/iscrizione/upload', { method: 'POST', body: fd })
}

/**
 * Un file di byte VERI, e non un `size` sovrascritto con `defineProperty`: la richiesta
 * viene serializzata in multipart e `request.formData()` ricostruisce il `File` dal corpo,
 * quindi qualunque taglia finta verrebbe persa per strada — e il test passerebbe per il
 * motivo sbagliato. (Provato: con `size` finto la route vede 1 byte e risponde 200.)
 */
function fileDa(byte: number): File {
  return new File([Buffer.alloc(byte, 0x78)], 'documento.pdf', { type: 'application/pdf' })
}

beforeEach(() => {
  h.uploads = []
})

describe('POST /api/iscrizione/upload — la taglia', () => {
  it('un file oltre il tetto è 413, non 400: è lo stesso codice della piattaforma', async () => {
    const res = await POST(richiesta(fileDa(LIMITE_UPLOAD_BYTE + 1)) as never)
    expect(res.status).toBe(413)
    // E il corpo è JSON, a differenza del 413 della piattaforma: il client lo può leggere.
    expect(String((await res.json()).error)).toContain('4')
    expect(h.uploads).toHaveLength(0)
  })

  it('un file sotto il tetto sale', async () => {
    const res = await POST(richiesta(fileDa(1024)) as never)
    expect(res.status).toBe(200)
    expect(h.uploads).toHaveLength(1)
  })
})
