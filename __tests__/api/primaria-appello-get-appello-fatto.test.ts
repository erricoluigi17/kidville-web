/**
 * `GET /api/primaria/appello` — il booleano `appello_fatto` (compito A4, giro 2).
 *
 * La schermata dell'appello primaria mostra «Annulla» solo dove l'appello l'ha fatto
 * la scuola: una riga con la sola comunicazione del genitore ha uno stato
 * («assente») ma niente da annullare, e il server risponderebbe sempre
 * `NIENTE_DA_ANNULLARE`. Il criterio è quello di `@/lib/presenze/annulla-appello`:
 * `registrato_da` non NULL.
 *
 * Che cosa lega questo file:
 *  (a) la GET chiede `registrato_da` a PostgREST (senza, il booleano sarebbe sempre falso);
 *  (b) espone `appello_fatto` vero/falso secondo `registrato_da`, e falso senza riga;
 *  (c) lo uuid di chi ha scritto la riga NON esce: né come campo, né da nessuna parte
 *      nel corpo della risposta;
 *  (d) una lettura fallita (PostgREST non lancia: ritorna `{ error }`) è un 500 col
 *      codice, MAI un 200 con tutti gli alunni «da registrare» e `appello_fatto: false`
 *      — il docente rifarebbe un appello che sul server c'è già.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  presenze: [] as Array<Record<string, unknown>>,
  colonnePresenze: '' as string,
  filtriPresenze: [] as unknown[][],
  /** Se valorizzato, quella tabella risponde come PostgREST in errore: `{ data: null, error }`. */
  erroreSu: null as null | { tabella: string; error: { message: string; code: string } },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
// `vedeTutteLeClassi` resta VERO: è la regola che decide se il motivo esce
// (`colonneConMotivo`), e il test la attraversa invece di fingerla.
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
      qb.eq = (...a: unknown[]) => { if (tabella === 'presenze') h.filtriPresenze.push(['eq', ...a]); return qb }
      qb.order = () => qb
      // Come PostgREST, `presenze` restituisce SOLO le colonne chieste: una colonna
      // non letta non può far diventare vero il booleano.
      const proietta = (r: Record<string, unknown>) => {
        const chieste = h.colonnePresenze.split(',').map((c) => c.trim())
        return Object.fromEntries(Object.entries(r).filter(([k]) => chieste.includes(k)))
      }
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          h.erroreSu?.tabella === tabella
            ? { data: null, error: h.erroreSu.error }
            : { data: tabella === 'alunni' ? h.alunni : h.presenze.map(proietta), error: null },
        ).then(res)
      return qb
    },
  })),
}))

import { GET } from '@/app/api/primaria/appello/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const CHI_HA_SCRITTO = 'f0000000-0000-4000-8000-0000000000f9'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
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
  registrato_da: null,
  ...extra,
})

const richiesta = () =>
  new NextRequest(`http://localhost/api/primaria/appello?sectionId=${SEZIONE}&data=${GIORNO}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.colonnePresenze = ''
  h.filtriPresenze = []
  h.erroreSu = null
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertSezioneInScope.mockResolvedValue(null)
  h.alunni = [
    { id: A, nome: 'Primo', cognome: 'Alunno' },
    { id: B, nome: 'Secondo', cognome: 'Bambino' },
    { id: C, nome: 'Terzo', cognome: 'Caso' },
  ]
  h.presenze = [
    // A: la sola comunicazione del genitore.
    presenza(A),
    // B: stessa riga, ma l'appello l'ha fatto la scuola.
    presenza(B, { registrato_da: CHI_HA_SCRITTO }),
    // C: nessuna riga.
  ]
})

describe('GET /api/primaria/appello — `appello_fatto`', () => {
  it('chiede `registrato_da` a PostgREST, sulla sezione e sul giorno chiesti', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(h.colonnePresenze.split(',').map((c) => c.trim())).toContain('registrato_da')
    expect(h.filtriPresenze).toEqual(expect.arrayContaining([['eq', 'section_id', SEZIONE], ['eq', 'data', GIORNO]]))
  })

  it('vero solo dove `registrato_da` c\'è: comunicazione del genitore → falso, nessuna riga → falso', async () => {
    const res = await GET(richiesta())
    const corpo = (await res.json()) as { data: Array<{ id: string; stato: string | null; appello_fatto: boolean }> }
    const per = new Map(corpo.data.map((r) => [r.id, r]))
    expect(per.get(A)).toMatchObject({ stato: 'assente', appello_fatto: false })
    expect(per.get(B)).toMatchObject({ stato: 'assente', appello_fatto: true })
    expect(per.get(C)).toMatchObject({ stato: null, appello_fatto: false })
  })

  it('lo uuid di chi ha scritto la riga NON esce dalla risposta', async () => {
    const res = await GET(richiesta())
    const testo = await res.text()
    expect(testo).not.toContain(CHI_HA_SCRITTO)
    expect(testo).not.toContain('registrato_da')
  })

  it.each([
    ['presenze'],
    ['alunni'],
  ])('lettura di `%s` in errore: 500 con `PRESENZE_NON_LETTE`, non un 200 con l\'appello «mai fatto»', async (tabella) => {
    h.erroreSu = { tabella, error: { message: 'dettaglio tecnico del database', code: '57014' } }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    const corpo = (await res.json()) as { codice?: string; error?: string; data?: unknown }
    expect(corpo.codice).toBe('PRESENZE_NON_LETTE')
    expect(corpo.data).toBeUndefined()
    // Il motivo tecnico resta nel log, non va al client.
    expect(JSON.stringify(corpo)).not.toContain('dettaglio tecnico')
  })

  it('un\'eccezione imprevista: 500 col codice, e il suo `message` NON esce', async () => {
    h.requireDocente.mockRejectedValue(new Error('segreto interno del server'))
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    const testo = await res.text()
    expect(testo).not.toContain('segreto interno')
    expect(JSON.parse(testo)).toMatchObject({ codice: 'PRESENZE_NON_LETTE' })
  })
})
