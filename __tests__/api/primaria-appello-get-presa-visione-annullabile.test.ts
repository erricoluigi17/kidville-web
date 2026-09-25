/**
 * `GET /api/primaria/appello` — il booleano `presa_visione_annullabile` (compito A5, giro 2).
 *
 * In primaria una classe ha più docenti. «Annulla presa visione» lo può usare chi
 * l'ha presa (`giust_vista_da`), oppure Segreteria e Direzione: a ogni altro docente
 * il server risponde sempre 403 `PRESA_VISIONE_NON_TUA`, quindi la schermata non
 * deve nemmeno offrirlo. Lo decide la GET con la STESSA regola della DELETE
 * (`puoAnnullarePresaVisione` in `@/lib/presenze/presa-visione`).
 *
 * Che cosa lega questo file:
 *  (a) la GET chiede `giust_vista_da` a PostgREST (senza, il booleano sarebbe vero
 *      solo per lo staff e mai per l'autore);
 *  (b) vero per l'autore e per segreteria/admin/coordinator — sui ruoli REALI;
 *  (c) falso per un altro docente della classe, falso senza presa visione, falso
 *      senza riga;
 *  (d) lo uuid di chi ha preso visione NON esce: né come campo né nel corpo;
 *  (e) la regola è quella della DELETE: stessa risposta per gli stessi input.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  presenze: [] as Array<Record<string, unknown>>,
  colonnePresenze: '' as string,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  assertSezioneInScope: h.assertSezioneInScope,
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      qb.select = (c: string) => { if (tabella === 'presenze') h.colonnePresenze = c; return qb }
      qb.eq = () => qb
      qb.order = () => qb
      // Come PostgREST, `presenze` restituisce SOLO le colonne chieste: una colonna
      // non letta non può decidere il booleano.
      const proietta = (r: Record<string, unknown>) => {
        const chieste = h.colonnePresenze.split(',').map((c) => c.trim())
        return Object.fromEntries(Object.entries(r).filter(([k]) => chieste.includes(k)))
      }
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: tabella === 'alunni' ? h.alunni : h.presenze.map(proietta), error: null }).then(res)
      return qb
    },
  })),
}))

import { GET } from '@/app/api/primaria/appello/route'
import { puoAnnullarePresaVisione } from '@/lib/presenze/presa-visione'

const DOCENTE_CHE_HA_LETTO = 'd0000000-0000-4000-8000-0000000000d1'
const ALTRO_DOCENTE = 'd0000000-0000-4000-8000-0000000000d2'
const STAFF = 'e0000000-0000-4000-8000-0000000000e1'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const GIORNO = '2026-09-25'

const presenza = (alunno_id: string, extra: Record<string, unknown> = {}) => ({
  id: `cccc0000-0000-4000-8000-${alunno_id.slice(0, 12)}`,
  alunno_id,
  stato: 'assente',
  note_appello: null,
  orario_entrata: null,
  orario_uscita: null,
  giustificata: true,
  giust_vista_il: null,
  giust_vista_da: null,
  registrato_da: null,
  ...extra,
})

const richiesta = () =>
  new NextRequest(`http://localhost/api/primaria/appello?sectionId=${SEZIONE}&data=${GIORNO}`)

const come = (user: AppUser) => h.requireDocente.mockResolvedValue({ user })

async function leggi(): Promise<Map<string, Record<string, unknown>>> {
  const res = await GET(richiesta())
  expect(res.status).toBe(200)
  const corpo = (await res.json()) as { data: Array<Record<string, unknown>> }
  return new Map(corpo.data.map((r) => [String(r.id), r]))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.colonnePresenze = ''
  h.assertSezioneInScope.mockResolvedValue(null)
  come({ id: DOCENTE_CHE_HA_LETTO, role: 'educator', scuola_id: SEDE })
  h.alunni = [
    { id: A, nome: 'Primo', cognome: 'Alunno' },
    { id: B, nome: 'Secondo', cognome: 'Bambino' },
    { id: C, nome: 'Terzo', cognome: 'Caso' },
    { id: D, nome: 'Quarto', cognome: 'Dato' },
  ]
  h.presenze = [
    // A: presa visione data dal docente che guarda.
    presenza(A, { giust_vista_il: '2026-09-25T07:30:00+00:00', giust_vista_da: DOCENTE_CHE_HA_LETTO }),
    // B: presa visione data da un ALTRO docente della classe.
    presenza(B, { giust_vista_il: '2026-09-25T07:31:00+00:00', giust_vista_da: ALTRO_DOCENTE }),
    // C: giustificata, presa visione non ancora data.
    presenza(C),
    // D: nessuna riga.
  ]
})

describe('GET /api/primaria/appello — `presa_visione_annullabile`', () => {
  it('chiede `giust_vista_da` a PostgREST', async () => {
    await leggi()
    expect(h.colonnePresenze.split(',').map((c) => c.trim())).toContain('giust_vista_da')
  })

  it('docente che ha preso visione: vero sulla SUA, falso su quella di un collega, falso senza presa visione o senza riga', async () => {
    const per = await leggi()
    expect(per.get(A)).toMatchObject({ presa_visione_annullabile: true })
    expect(per.get(B)).toMatchObject({ presa_visione_annullabile: false })
    expect(per.get(C)).toMatchObject({ presa_visione_annullabile: false })
    expect(per.get(D)).toMatchObject({ presa_visione_annullabile: false })
  })

  it('un altro docente della classe: falso anche sulla presa visione del collega', async () => {
    come({ id: 'd0000000-0000-4000-8000-0000000000d3', role: 'educator', scuola_id: SEDE })
    const per = await leggi()
    expect(per.get(A)).toMatchObject({ presa_visione_annullabile: false })
    expect(per.get(B)).toMatchObject({ presa_visione_annullabile: false })
  })

  it.each([['segreteria'], ['admin'], ['coordinator']] as const)(
    '%s: vero su ogni presa visione (anche di altri), falso dove non c’è',
    async (ruolo) => {
      come({ id: STAFF, role: ruolo, scuola_id: SEDE })
      const per = await leggi()
      expect(per.get(A)).toMatchObject({ presa_visione_annullabile: true })
      expect(per.get(B)).toMatchObject({ presa_visione_annullabile: true })
      expect(per.get(C)).toMatchObject({ presa_visione_annullabile: false })
      expect(per.get(D)).toMatchObject({ presa_visione_annullabile: false })
    },
  )

  it('i ruoli REALI decidono, non il ruolo attivo: un docente che è anche segreteria vede vero', async () => {
    come({ id: STAFF, role: 'educator', ruoli: ['educator', 'segreteria'], scuola_id: SEDE })
    const per = await leggi()
    expect(per.get(B)).toMatchObject({ presa_visione_annullabile: true })
  })

  it('lo uuid di chi ha preso visione NON esce dalla risposta', async () => {
    const res = await GET(richiesta())
    const testo = await res.text()
    expect(testo).not.toContain(DOCENTE_CHE_HA_LETTO)
    expect(testo).not.toContain(ALTRO_DOCENTE)
    expect(testo).not.toContain('giust_vista_da')
  })

  it('presa visione senza autore (`giust_vista_da` nullo): solo Segreteria e Direzione', async () => {
    h.presenze = [presenza(A, { giust_vista_il: '2026-09-25T07:30:00+00:00', giust_vista_da: null })]
    expect((await leggi()).get(A)).toMatchObject({ presa_visione_annullabile: false })
    come({ id: STAFF, role: 'coordinator', scuola_id: SEDE })
    expect((await leggi()).get(A)).toMatchObject({ presa_visione_annullabile: true })
  })

  it('stessa regola della DELETE: la GET dice ciò che `puoAnnullarePresaVisione` decide', async () => {
    const utenti: AppUser[] = [
      { id: DOCENTE_CHE_HA_LETTO, role: 'educator', scuola_id: SEDE },
      { id: ALTRO_DOCENTE, role: 'educator', scuola_id: SEDE },
      { id: STAFF, role: 'segreteria', scuola_id: SEDE },
    ]
    for (const u of utenti) {
      come(u)
      const per = await leggi()
      for (const p of h.presenze) {
        expect(per.get(String(p.alunno_id))?.presa_visione_annullabile).toBe(
          puoAnnullarePresaVisione(u, p as { giust_vista_il: string | null; giust_vista_da: string | null }),
        )
      }
    }
  })
})
