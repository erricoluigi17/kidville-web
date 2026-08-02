import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// X3 — «scope vuoto ⇒ NEGA» sulle due liste delle news.
//
// IL DIFETTO. Entrambe le route filtravano la sede così:
//
//     if (sedi.length > 0) query = query.or('scuola_id.in.(…),scuola_id.is.null')
//     else                 query = query.is('scuola_id', null)
//
// Il ramo `else` non è un filtro: è una SCAPPATOIA. Quando lo scope è vuoto —
// cioè quando il cookie `sedi_attive` seleziona una sede che l'utente non ha (o
// non ha PIÙ: revoca di `utenti_scuole`, cookie manomesso, sede disattivata) —
// la risposta non era «niente», era «tutti i contenuti globali». Fino al
// 2026-07-31 lo scope vuoto non era nemmeno raggiungibile, perché
// `resolveScuoleAttive` col cookie fuori scope ripiegava sull'insieme intero;
// ora quel ripiego è stato tolto (W2-A) e `[]` è un esito reale.
//
// LA SEMANTICA DEL NULL RESTA. In `news_posts`/`news_categorie` una riga con
// `scuola_id NULL` vale «per tutte le sedi» ed è voluta: la si continua a
// leggere, ma DENTRO il filtro (`.or(sede oppure globale)`), non come ripiego
// quando il filtro manca. «Vale per tutte le sedi» presuppone che una sede ce
// l'abbia, chi legge.
//
// Il finto client applica DAVVERO `.or()` e `.is()` (fixture W1-A): questi test
// sarebbero stati verdi con e senza filtro sul mock vecchio.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-0000000000a1'
const ID_GENITORE = 'd0000000-0000-4000-8000-0000000000b2'
/** Una sede che esiste ma NON è dell'utente: è ciò che può finire nel cookie. */
const SEDE_NON_ACCESSIBILE = SEDE_C

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET as GET_NEWS } from '@/app/api/news/route'
import { GET as GET_CATEGORIE } from '@/app/api/news/categorie/route'

const dbBase = (): DBFinto => ({
  // L'admin ha DUE sedi; SEDE_C non è sua.
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  news_posts: [
    { id: 'post-a', titolo: 'Alfa', scuola_id: SEDE_A, stato: 'pubblicata', tipo: 'blog', author_id: ID_ADMIN, created_at: '2026-07-03T10:00:00Z' },
    { id: 'post-b', titolo: 'Beta', scuola_id: SEDE_B, stato: 'pubblicata', tipo: 'blog', author_id: ID_ADMIN, created_at: '2026-07-02T10:00:00Z' },
    { id: 'post-globale', titolo: 'Tutte le sedi', scuola_id: null, stato: 'pubblicata', tipo: 'comunicato', author_id: ID_ADMIN, created_at: '2026-07-01T10:00:00Z' },
  ],
  news_categorie: [
    { id: 'cat-a', nome: 'Alfa', slug: 'alfa', scuola_id: SEDE_A, attivo: true, is_sistema: false, ordine: 1 },
    { id: 'cat-a-spenta', nome: 'Alfa spenta', slug: 'alfa-spenta', scuola_id: SEDE_A, attivo: false, is_sistema: false, ordine: 2 },
    { id: 'cat-b', nome: 'Beta', slug: 'beta', scuola_id: SEDE_B, attivo: true, is_sistema: false, ordine: 3 },
    { id: 'cat-globale', nome: 'Avvisi', slug: 'avvisi', scuola_id: null, attivo: true, is_sistema: true, ordine: 4 },
  ],
})

function req(base: string, cookie?: string): NextRequest {
  return {
    url: `http://localhost${base}`,
    method: 'GET',
    headers: new Headers(),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  const admin = { user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } }
  h.requireDocente.mockResolvedValue(admin)
  h.requireUser.mockResolvedValue(admin)
  h.requireStaff.mockResolvedValue(admin)
})

describe('GET /api/news — elenco gestionale per sede', () => {
  it('senza cookie: le proprie sedi PIÙ i post globali', async () => {
    const res = await GET_NEWS(req('/api/news'))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.posts.map((p: { id: string }) => p.id)).toEqual(['post-a', 'post-b', 'post-globale'])
  })

  it('cookie su UNA sede: quella sede più i globali, mai l\'altra sede', async () => {
    const res = await GET_NEWS(req('/api/news', SEDE_A))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.posts.map((p: { id: string }) => p.id)).toEqual(['post-a', 'post-globale'])
  })

  it('scope VUOTO (cookie su sede non accessibile) ⇒ elenco vuoto, nemmeno i globali', async () => {
    const res = await GET_NEWS(req('/api/news', SEDE_NON_ACCESSIBILE))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ disponibile: true, posts: [] })
    // Deny PRIMA della query: `news_posts` non viene nemmeno interrogata.
    expect(h.tabelle).not.toContain('news_posts')
  })
})

describe('GET /api/news/categorie — categorie per sede', () => {
  it('senza cookie: le proprie sedi PIÙ le categorie globali', async () => {
    const res = await GET_CATEGORIE(req('/api/news/categorie'))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.categorie.map((c: { id: string }) => c.id)).toEqual([
      'cat-a',
      'cat-a-spenta',
      'cat-b',
      'cat-globale',
    ])
  })

  it('cookie su UNA sede: quella sede più le globali, mai l\'altra sede', async () => {
    const res = await GET_CATEGORIE(req('/api/news/categorie', SEDE_A))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.categorie.map((c: { id: string }) => c.id)).toEqual(['cat-a', 'cat-a-spenta', 'cat-globale'])
  })

  it('scope VUOTO (cookie su sede non accessibile) ⇒ elenco vuoto, nemmeno le globali', async () => {
    const res = await GET_CATEGORIE(req('/api/news/categorie', SEDE_NON_ACCESSIBILE))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ disponibile: true, categorie: [] })
    expect(h.tabelle).not.toContain('news_categorie')
  })

  it('il genitore continua a vedere solo le ATTIVE della sua sede più le globali', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ID_GENITORE, role: 'genitore', scuola_id: SEDE_A } })

    const res = await GET_CATEGORIE(req('/api/news/categorie'))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.categorie.map((c: { id: string }) => c.id)).toEqual(['cat-a', 'cat-globale'])
  })
})
