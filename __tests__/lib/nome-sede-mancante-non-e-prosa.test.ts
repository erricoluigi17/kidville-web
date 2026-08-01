import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Il server non inventa testo per l'utente: se il nome di una sede (o di una
 * classe) manca, ritorna il vuoto — non la parola italiana «Sede».
 *
 * Il collaudo del 2026-07-31: `nomi.get(scuolaId) || 'Sede'` in
 * `api/admin/sections/scoped/route.ts:71` e `…?.nome || 'Sede'` in
 * `lib/presenze/aggregate.ts:100` producono una stringa di INTERFACCIA dove non
 * esistono né il locale né il catalogo. Con l'app in inglese quel badge scrive
 * «Sede» in mezzo a un'interfaccia inglese, e nessun `t()` può più intercettarlo:
 * il testo è già stato deciso dal server.
 *
 * Perché il vuoto è la risposta giusta e non un ripiego: la route sorella
 * `api/educator-sections/route.ts:240` fa già `nomiSedi.get(s.scuola_id) ?? ''`, e
 * il client è già scritto su quel contratto — `teacher/page.tsx:212` mostra la
 * sede solo se `Boolean(s.scuolaNome)`. Le due route dicevano due cose diverse
 * per lo stesso dato: qui si allineano.
 *
 * `schools.nome` è NOT NULL, quindi il ramo scatta solo quando la riga non è
 * raggiungibile (id orfano, filtro di scope) o il nome è vuoto: è codice
 * difensivo, e deve restare difensivo senza parlare italiano.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  sezioniDiUtente: vi.fn(),
  sections: [
    { id: 's1', name: 'Girasoli', school_type: 'infanzia', scuola_id: 'sc-1' },
    { id: 's2', name: 'Margherite', school_type: 'infanzia', scuola_id: 'sc-2' },
  ],
  // `sc-2` non compare fra le scuole leggibili: è il caso che accendeva il fallback.
  schools: [{ id: 'sc-1', nome: 'Kidville Giugliano' }],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...args: unknown[]) => h.scuoleDiUtente(...args) }))
vi.mock('@/lib/sezioni/docenti', () => ({ sezioniDiUtente: (...args: unknown[]) => h.sezioniDiUtente(...args) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const data = table === 'sections' ? h.sections : table === 'schools' ? h.schools : []
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data, error: null }),
      }
      b.select = () => b; b.in = () => b; b.order = () => b; b.eq = () => b
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/sections/scoped/route'
import { aggregaPresenze } from '@/lib/presenze/aggregate'

const req = () => ({
  url: 'http://test/api/admin/sections/scoped',
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'adm', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1', 'sc-2'])
  h.sezioniDiUtente.mockResolvedValue([])
})

describe('GET /api/admin/sections/scoped — nome sede mancante', () => {
  it('la sede senza nome torna col nome VUOTO, non con la parola «Sede»', async () => {
    const res = await GET(req())
    const j = await res.json()
    const senzaNome = j.data.find((g: { scuolaId: string }) => g.scuolaId === 'sc-2')
    expect(senzaNome).toBeTruthy()
    expect(senzaNome.scuolaNome).toBe('')
  })

  it('e la sede che il nome ce l\'ha lo riporta intatto (il vuoto non è la risposta a tutto)', async () => {
    const res = await GET(req())
    const j = await res.json()
    const conNome = j.data.find((g: { scuolaId: string }) => g.scuolaId === 'sc-1')
    expect(conNome.scuolaNome).toBe('Kidville Giugliano')
  })
})

describe('aggregaPresenze — nomi mancanti', () => {
  const alunni = [
    { id: 'a1', section_id: 'sez-1', scuola_id: 'sc-1' },
    { id: 'a2', section_id: 'sez-2', scuola_id: 'sc-2' },
  ]
  const presenze = [{ alunno_id: 'a1', stato: 'presente' }]

  it('sede e classe senza nome tornano vuote, non «Sede» e «Classe»', () => {
    const esito = aggregaPresenze(
      alunni,
      presenze,
      [
        { id: 'sez-1', name: 'Girasoli', scuola_id: 'sc-1' },
        { id: 'sez-2', name: null, scuola_id: 'sc-2' }, // classe senza nome
      ],
      [{ id: 'sc-1', nome: 'Kidville Giugliano' }], // sc-2 non leggibile
    )
    const orfana = esito.sedi.find((s) => s.scuola_id === 'sc-2')!
    expect(orfana.scuola).toBe('')
    expect(orfana.classi[0].classe).toBe('')
  })

  it('e i nomi che ci sono restano quelli (controllo positivo)', () => {
    const esito = aggregaPresenze(
      alunni,
      presenze,
      [
        { id: 'sez-1', name: 'Girasoli', scuola_id: 'sc-1' },
        { id: 'sez-2', name: 'Margherite', scuola_id: 'sc-2' },
      ],
      [
        { id: 'sc-1', nome: 'Kidville Giugliano' },
        { id: 'sc-2', nome: 'Kidville Aversa' },
      ],
    )
    const giugliano = esito.sedi.find((s) => s.scuola_id === 'sc-1')!
    expect(giugliano.scuola).toBe('Kidville Giugliano')
    expect(giugliano.classi[0].classe).toBe('Girasoli')
  })
})
