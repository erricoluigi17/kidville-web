// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * UN CONTENT-TYPE SBAGLIATO È UN 400, NON UN 500 (collaudo del 2026-08-02, backend F2).
 *
 * MISURATO sul server di produzione:
 *   curl -X POST -H 'Content-Type: application/json' -d '{}' …/api/chat/upload
 *   → HTTP 500 {"error":"Content-Type was not one of \"multipart/form-data\" or …"}
 *   curl -X POST -H 'Content-Type: application/json' -d '{}' …/api/iscrizione/upload   # ANONIMO
 *   → HTTP 500, stesso corpo
 *   avvisi/tasks → 500 «Non è stato possibile caricare il file…» · gallery/news → 500 «Internal Server Error»
 *
 * LA CAUSA. `await request.formData()` LANCIA quando il Content-Type non è multipart: non
 * ritorna un errore, quindi la validazione zod non viene mai raggiunta e il controllo
 * finisce nel `catch` generico, che è tarato sui guasti del server.
 *
 * PERCHÉ IL NUMERO CONTA. Non è una questione di eleganza: il 500 dice «ho un guasto io», e
 * ogni richiesta malformata scrive una riga `error` in `app_log` — cioè il canale in cui si
 * cercano i guasti veri si riempie di rumore prodotto dai client. È la stessa dinamica che
 * AGENTS.md §3 esiste per impedire. E su due di queste sei rotte usciva anche il messaggio
 * interno del runtime, su una PUBBLICA e anonima.
 *
 * PERCHÉ UN SOLO FILE PER SEI ROTTE. Perché la regola è una sola e da oggi vive in un posto
 * solo (`parseMultipart`, in `@/lib/validation/http`, accanto a `parseBody`/`parseQuery`):
 * sei `catch` che imparano la stessa lezione ciascuno per conto suo divergono al primo
 * ritocco — è la forma di difetto che questo ciclo ha già corretto tre volte.
 */

const h = vi.hoisted(() => ({
  uploads: [] as string[],
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: async () => ({ user: { id: 'u-1', role: 'segreteria', scuola_id: 's-1' } }),
  requireUser: async () => ({ user: { id: 'u-1', role: 'genitore' } }),
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      listBuckets: async () => ({ data: [], error: null }),
      createBucket: async () => ({ error: null }),
      updateBucket: async () => ({ error: null }),
      from: () => ({
        upload: async (path: string) => {
          h.uploads.push(path)
          return { error: null }
        },
        createSignedUrl: async () => ({ data: { signedUrl: 'https://x/s' }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/p' } }),
      }),
    },
  }),
}))

import { POST as ISCRIZIONE } from '@/app/api/iscrizione/upload/route'
import { POST as CHAT } from '@/app/api/chat/upload/route'
import { POST as AVVISI } from '@/app/api/avvisi/upload/route'
import { POST as TASKS } from '@/app/api/tasks/upload/route'
import { POST as GALLERY } from '@/app/api/gallery/upload/route'
import { POST as NEWS } from '@/app/api/news/upload/route'
import { resetRateLimit } from '@/lib/security/rate-limit'

type Handler = (r: Request) => Promise<Response>

const ROTTE: [string, Handler][] = [
  ['/api/iscrizione/upload', ISCRIZIONE as unknown as Handler],
  ['/api/chat/upload', CHAT as unknown as Handler],
  ['/api/avvisi/upload', AVVISI as unknown as Handler],
  ['/api/tasks/upload', TASKS as unknown as Handler],
  ['/api/gallery/upload', GALLERY as unknown as Handler],
  ['/api/news/upload', NEWS as unknown as Handler],
]

const richiestaJson = (rotta: string): Request =>
  new Request(`http://localhost${rotta}`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.2.3' },
  })

/** Senza alcun Content-Type: l'altra forma in cui `formData()` lancia. */
const richiestaSenzaTipo = (rotta: string): Request =>
  new Request(`http://localhost${rotta}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.1.2.4' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.uploads = []
  resetRateLimit()
})

describe.each(ROTTE)('POST %s · una richiesta malformata è colpa del client', (rotta, ROUTE) => {
  it('Content-Type JSON → 400, non 500', async () => {
    const res = await ROUTE(richiestaJson(rotta))
    expect(
      res.status,
      'Il 500 dice «ho un guasto io»: sporca ogni misura di salute del servizio e riempie di ' +
        'rumore il canale in cui si cercano i guasti veri.',
    ).toBe(400)
  })

  it('nessun Content-Type → 400', async () => {
    const res = await ROUTE(richiestaSenzaTipo(rotta))
    expect(res.status).toBe(400)
  })

  it('il messaggio interno del runtime non esce al chiamante', async () => {
    const res = await ROUTE(richiestaJson(rotta))
    const testo = JSON.stringify(await res.json())
    expect(
      testo,
      'Oggi ne esce una stringa di Next; domani ne uscirà quello che ci finisce dentro.',
    ).not.toMatch(/multipart\/form-data|x-www-form-urlencoded/i)
  })

  it('una richiesta malformata non scrive niente nel bucket', async () => {
    await ROUTE(richiestaJson(rotta))
    expect(h.uploads).toHaveLength(0)
  })

  it('e non lascia una riga `error`: il canale dei guasti resta pulito', async () => {
    await ROUTE(richiestaJson(rotta))
    expect(
      h.logErrore,
      'Un client che sbaglia la richiesta non è un incidente del server: se ogni POST ' +
        'malformata scrive `error` in `app_log`, il giorno del guasto vero nessuno lo vede.',
    ).not.toHaveBeenCalled()
  })
})
