import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * Comunicazioni dei docenti con la classe in chiusura (PR 4.9): i soli due punti, fra avvisi / news / video, in cui un
 * `educator` scrive DAVVERO su una classe senza che nessun altro gate guardi l'anno.
 *
 *  · `DELETE /api/avvisi/[id]` — l'autore cancella il proprio avviso: la cancellazione porta via in CASCADE le risposte
 *    dei genitori (adesioni, autorizzazioni). Su una classe di un anno in chiusura è storia, non si tocca.
 *  · `POST /api/video-uploads` (canale gallery) — `destinatari.classi` mette il video nella galleria di una classe.
 *
 * Il gate è quello VERO (`assertClasseNomeScrivibile`); cambia solo l'esito della funzione SQL `sezioni_visibili_docente`.
 */

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEGRETERIA = '44444444-4444-4444-8444-444444444444'
const SEDE = '22222222-2222-4222-8222-222222222222'
const S_CHIUSURA = '55555555-5555-4555-8555-555555555551'
const AVVISO = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  db: {} as unknown,
  solaLettura: true,
  requireDocente: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () =>
      crea(h.db as DBFinto, [], {
        rpc: {
          sezioni_visibili_docente: () => ({ data: [{ section_id: S_CHIUSURA, sola_lettura: h.solaLettura }], error: null }),
        } as never,
      }),
  }
})
vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: async () => null }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => ({ ok: true }),
  clientIp: () => '1.2.3.4',
}))
vi.mock('@/lib/gallery/cancelli-destinatari', () => ({
  cancelliDestinatariGalleria: async (_s: unknown, i: { tagAlunni?: string[]; broadcast?: boolean; classi?: string[] }) => ({
    ok: true,
    destinatari: { tagAlunni: i.tagAlunni ?? [], broadcast: !!i.broadcast, classi: i.classi ?? [] },
  }),
}))

import { DELETE } from '@/app/api/avvisi/[id]/route'
import { POST } from '@/app/api/video-uploads/route'

function utente(id: string, role: 'educator' | 'segreteria') {
  return { user: { id, role, scuola_id: SEDE, scuole_ids: [SEDE] } }
}

beforeEach(() => {
  h.solaLettura = true
  h.db = {
    utenti: [
      { id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' },
      { id: SEGRETERIA, scuola_id: SEDE, scuole_ids: [SEDE], role: 'segreteria' },
    ],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: S_CHIUSURA }],
    sections: [{ id: S_CHIUSURA, name: 'Girasoli', school_type: 'primaria', scuola_id: SEDE }],
    avvisi: [{ id: AVVISO, author_id: DOCENTE, scuola_id: SEDE, target_scope: 'classe', target_classes: ['Girasoli'] }],
  }
  h.requireDocente.mockResolvedValue(utente(DOCENTE, 'educator'))
})

const richiestaDelete = () => new NextRequest(`http://localhost/api/avvisi/${AVVISO}`, { method: 'DELETE' })
const ctx = { params: Promise.resolve({ id: AVVISO }) }

describe('DELETE /api/avvisi/[id] con la classe in chiusura', () => {
  it('educator autore, classe in sola lettura → 403 SEZIONE_*', async () => {
    const res = await DELETE(richiestaDelete(), ctx)
    expect(res.status).toBe(403)
    expect(['SEZIONE_IN_CHIUSURA', 'SEZIONE_SOLA_LETTURA']).toContain((await res.json()).codice)
  })

  it('educator autore, classe dell’anno corrente → non fermato dal gate', async () => {
    h.solaLettura = false
    const res = await DELETE(richiestaDelete(), ctx)
    expect(res.status).not.toBe(403)
  })

  it('segreteria → non fermata dal gate', async () => {
    h.requireDocente.mockResolvedValue(utente(SEGRETERIA, 'segreteria'))
    const res = await DELETE(richiestaDelete(), ctx)
    expect(res.status).not.toBe(403)
  })
})

const ALUNNO = '11111111-1111-4111-8111-111111111112'
const FILE = {
  chiaveIdempotenza: 'recita-1',
  nome: 'recita.mov',
  byte: 812_345_678,
  mime: 'video/quicktime',
  durataSecondi: 96,
}
function richiestaVideo(classi: string[]) {
  return new NextRequest('http://localhost/api/video-uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      canale: 'gallery',
      azione: 'publish',
      scuolaId: SEDE,
      ambitoGlobale: false,
      targetId: null,
      versioneTargetAttesa: null,
      file: [FILE],
      destinatari: { tagAlunni: [ALUNNO], broadcast: false, classi },
    }),
  })
}

describe('POST /api/video-uploads (gallery) con la classe in chiusura', () => {
  it('educator che destina il video a una classe in sola lettura → 403 SEZIONE_*', async () => {
    const res = await POST(richiestaVideo(['Girasoli']))
    expect(res.status).toBe(403)
    expect(['SEZIONE_IN_CHIUSURA', 'SEZIONE_SOLA_LETTURA']).toContain((await res.json()).codice)
  })

  it('educator con la classe dell’anno corrente → non fermato dal gate', async () => {
    h.solaLettura = false
    const res = await POST(richiestaVideo(['Girasoli']))
    expect(res.status).not.toBe(403)
  })

  it('segreteria → non fermata dal gate', async () => {
    h.requireDocente.mockResolvedValue(utente(SEGRETERIA, 'segreteria'))
    const res = await POST(richiestaVideo(['Girasoli']))
    expect(res.status).not.toBe(403)
  })
})
