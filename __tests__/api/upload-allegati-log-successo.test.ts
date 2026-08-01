import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * L'ALLEGATO CARICATO LASCIA UNA RIGA (W7 del collaudo 2026-07-31).
 *
 * `avvisi/upload:POST` e `tasks/upload:POST` sono passati il 2026-07-31 da bucket PUBBLICO a
 * bucket privato con link firmato. Da quel giorno «l'allegato non si apre» è un guasto nuovo e
 * plausibile — un TTL scaduto, una firma che fallisce, un percorso salvato male — e su successo
 * le due route non lasciavano niente in tabella: solo il `KV_OK` di `withRoute`, che vive su
 * Vercel e non arriva in `app_log`.
 *
 * Con i soli errori, «nessun log di upload» non distingue «nessuno ha caricato niente» da «gli
 * upload non partono più». È alla lettera l'ambiguità che ha tenuto invisibile per mesi il
 * guasto delle email di credenziali (AGENTS.md, Logging obbligatorio, regola 5) — l'unica
 * ragione per cui tutto questo apparato esiste.
 *
 * La riga da sola non basterebbe: `logEvento(…, 'info', …)` arriva in tabella solo se l'evento
 * è in `EVENTI_PERSISTITI`. Perciò l'ultimo test qui sotto non guarda la chiamata: guarda
 * `vaPersistito`, cioè la funzione che decide davvero.
 */

const SEDE = 'aaaaaaaa-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  uploadPath: null as string | null,
  uploadErrore: null as unknown,
  rispostaFirma: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

const storage = {
  from: (bucket: string) => ({
    upload: async (path: string) => {
      h.uploadPath = path
      return { error: h.uploadErrore }
    },
    createSignedUrl: async () => h.rispostaFirma,
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://x/public/${bucket}/${path}` } }),
  }),
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ storage }),
}))

import { POST as AVVISI_UPLOAD } from '@/app/api/avvisi/upload/route'
import { POST as TASKS_UPLOAD } from '@/app/api/tasks/upload/route'
import { vaPersistito } from '@/lib/logging/logger'

/** Request multipart minimale: la route legge solo `formData().get('file')`. */
const uploadReq = (file: File): Request =>
  ({
    headers: new Headers(),
    url: 'http://test/api/upload',
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as unknown as Request

/** Il nome del file NON è un dettaglio innocuo: «certificato-<cognome>.pdf» è un dato personale. */
const NOME_FILE = 'certificato-medico-bruna.pdf'
const pdf = () =>
  new File([new Uint8Array([1, 2, 3, 4, 5]) as unknown as BlobPart], NOME_FILE, {
    type: 'application/pdf',
  })

const eventiStorage = (livello: string) =>
  h.logEvento.mock.calls.filter((c) => c[0] === 'storage' && c[1] === livello)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.uploadPath = null
  h.uploadErrore = null
  h.rispostaFirma = { data: { signedUrl: 'https://x/object/sign/avvisi_allegati/k?token=T' }, error: null }
})

describe('POST /api/avvisi/upload — il caricamento riuscito lascia una riga', () => {
  it('emette `storage:info allegato-caricato` col bucket, il tipo e la dimensione', async () => {
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)

    const ok = eventiStorage('info')
    expect(ok).toHaveLength(1)
    expect(ok[0][2]).toMatchObject({
      operazione: 'avvisi/upload:POST',
      esito: 'allegato-caricato',
      bucket: 'avvisi_allegati',
      mime: 'application/pdf',
      byte: 5,
    })
    // CONTROLLO POSITIVO/NEGATIVO: nessun `error` sul percorso felice, altrimenti la riga di
    // successo sarebbe indistinguibile da un guasto.
    expect(eventiStorage('error')).toHaveLength(0)
  })

  it('NON scrive il nome del file: «certificato-<cognome>.pdf» dice chi è il bambino', async () => {
    await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('certificato')
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('bruna')
  })

  it('caricamento FALLITO: nessuna riga di successo (il log direbbe il falso)', async () => {
    h.uploadErrore = { message: 'mime type text/plain is not supported' }
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(500)
    expect(eventiStorage('info')).toHaveLength(0)
  })

  it('firma dell\'anteprima fallita: il file È salvo, quindi il successo resta — e accanto c\'è l\'errore', async () => {
    h.rispostaFirma = { data: null, error: { message: 'Object not found', status: 404 } }
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)
    expect(eventiStorage('info')).toHaveLength(1)
    expect(eventiStorage('error')).toHaveLength(1)
    expect(eventiStorage('error')[0][2]).toMatchObject({ esito: 'anteprima-non-firmata' })
  })
})

describe('POST /api/tasks/upload — il caricamento riuscito lascia una riga', () => {
  it('emette `storage:info allegato-caricato` sul bucket degli incarichi', async () => {
    const res = await TASKS_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)

    const ok = eventiStorage('info')
    expect(ok).toHaveLength(1)
    expect(ok[0][2]).toMatchObject({
      operazione: 'tasks/upload:POST',
      esito: 'allegato-caricato',
      bucket: 'task_allegati',
      mime: 'application/pdf',
      byte: 5,
    })
  })

  it('caricamento FALLITO: nessuna riga di successo', async () => {
    h.uploadErrore = { message: 'Payload too large' }
    const res = await TASKS_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(500)
    expect(eventiStorage('info')).toHaveLength(0)
  })
})

describe('e la riga arriva davvero in tabella', () => {
  it('`vaPersistito(\'info\', \'storage\')` è vero: senza allowlist la riga muore su Vercel', () => {
    // È il difetto F1 nella sua forma generale: un log di successo emesso e mai persistito non
    // è un log, è una consolazione. Qui si asserisce sulla funzione VERA, non sul mock.
    expect(vaPersistito('info', 'storage')).toBe(true)
    // CONTROLLO NEGATIVO: l'allowlist non è diventata «tutto passa».
    expect(vaPersistito('info', 'route')).toBe(false)
  })
})
