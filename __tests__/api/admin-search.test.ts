import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M7.1 — /api/admin/search: gate staff, validazione q (min 2 char),
// shape { id, label, sub, href } per gruppo, scoping ai plessi.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; method: string; args: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente, resolveAnnoLetturaElenco: async () => null }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      // Il banco finto APPLICA i filtri di nome: ogni `or('nome.ilike.%x%,cognome.ilike.%x%,…')` tiene le righe in cui ALMENO
      // UNA colonna contiene x, e più `or` si sommano in AND (come PostgREST). Gli altri filtri (plesso, ruolo) non si valutano.
      const orDiNome: Array<(r: Record<string, unknown>) => boolean> = []
      const rows = () => (h.rows[table] ?? []).filter((r) => orDiNome.every((f) => f(r)))
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows(), error: null }),
      }
      const track = (method: string) => (...args: unknown[]) => {
        h.filters.push({ table, method, args })
        return b
      }
      b.select = track('select')
      b.in = track('in')
      b.or = (...args: unknown[]) => {
        track('or')(...args)
        const parti = String(args[0]).split(',')
        if (parti.every((x) => /^(nome|cognome|codice_fiscale)\.ilike\./.test(x))) {
          orDiNome.push((r) => parti.some((x) => {
            const [col, , ...resto] = x.split('.')
            const pezzo = resto.join('.').replace(/%/g, '').toLowerCase()
            return String(r[col] ?? '').toLowerCase().includes(pezzo)
          }))
        }
        return b
      }
      b.ilike = track('ilike')
      b.limit = track('limit')
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/search/route'

const req = (qs: string) =>
  ({ url: `http://test/api/admin/search${qs ? `?${qs}` : ''}`, headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.filters = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
})

describe('GET /api/admin/search', () => {
  it('401 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req('q=ross'))).status).toBe(401)
  })

  it('un bambino IN ARRIVO si trova e porta alla SUA scheda, con «In arrivo» al posto della classe che non ha (4.5.15, C2)', async () => {
    h.rows['alunni'] = [
      { id: 'al-arr', nome: 'Piccolo', cognome: 'Prova', classe_sezione: null, stato: 'in_arrivo' },
      { id: 'al-isc', nome: 'Grande', cognome: 'Prova', classe_sezione: null, stato: 'iscritto' },
    ]
    const res = await GET(req('q=prova'))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.alunni).toEqual([
      { id: 'al-arr', label: 'Piccolo Prova', sub: 'In arrivo', href: '/admin/students/al-arr?kind=child' },
      { id: 'al-isc', label: 'Grande Prova', sub: 'Alunno', href: '/admin/students/al-isc?kind=child' },
    ])
  })

  it('400 senza q (schema zod)', async () => {
    expect((await GET(req(''))).status).toBe(400)
  })

  it('400 con q di 1 carattere (schema zod)', async () => {
    expect((await GET(req('q=r'))).status).toBe(400)
  })

  it('gruppi vuoti senza query se lo staff non ha plessi', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await GET(req('q=ross'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual({ alunni: [], utenti: [], sezioni: [], moduli: [] })
    expect(h.filters).toHaveLength(0)
  })

  it('200 con shape { id, label, sub, href } per ogni gruppo', async () => {
    h.rows['alunni'] = [{ id: 'al-1', nome: 'Rosa', cognome: 'Rossi', classe_sezione: 'Girasoli' }]
    h.rows['utenti'] = [{ id: 'ut-1', nome: 'Remo', cognome: 'Rossini', role: 'educator', ruolo: null }]
    h.rows['sections'] = [{ id: 'sez-1', name: 'Rose', school_type: 'infanzia' }]
    h.rows['form_models'] = [{ id: 'fm-1', title: 'Rientro anticipato', is_active: true }]
    const res = await GET(req('q=ros'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.alunni).toEqual([
      { id: 'al-1', label: 'Rosa Rossi', sub: 'Girasoli', href: '/admin/students/al-1?kind=child' },
    ])
    expect(j.data.utenti).toEqual([
      { id: 'ut-1', label: 'Remo Rossini', sub: 'Docente', href: '/admin/staff' },
    ])
    expect(j.data.sezioni).toEqual([
      { id: 'sez-1', label: 'Rose', sub: 'infanzia', href: '/admin/students' },
    ])
    expect(j.data.moduli).toEqual([
      { id: 'fm-1', label: 'Rientro anticipato', sub: 'Attivo', href: '/admin/modulistica' },
    ])
  })

  it('scopa alunni/utenti/sezioni sui plessi dello staff (moduli globali)', async () => {
    await GET(req('q=ros'))
    const inCalls = h.filters.filter((f) => f.method === 'in')
    expect(inCalls.map((f) => f.table).sort()).toEqual(['alunni', 'sections', 'utenti'])
    for (const f of inCalls) expect(f.args).toEqual(['scuola_id', ['sc-1']])
  })

  it('filtra gli utenti come staff su ENTRAMBE le colonne role/ruolo', async () => {
    await GET(req('q=ros'))
    const orUtenti = h.filters.filter((f) => f.table === 'utenti' && f.method === 'or')
    expect(orUtenti.some((f) => String(f.args[0]).includes('role.in.') && String(f.args[0]).includes('ruolo.in.'))).toBe(true)
  })

  it('sanifica i metacaratteri ilike/or dal termine di ricerca', async () => {
    await GET(req(`q=${encodeURIComponent('ro,ss(i%_)')}`))
    const orAlunni = h.filters.find((f) => f.table === 'alunni' && f.method === 'or')
    // Il termine ripulito è «ro ss i» (la «i» di una lettera si scarta): ogni parola ha il suo `or` (nome o cognome o codice fiscale), tutte in AND.
    expect(String(orAlunni?.args[0])).toContain('nome.ilike.%ro%')
    const orAlunniTutti = h.filters.filter((f) => f.table === 'alunni' && f.method === 'or').map((f) => String(f.args[0]))
    expect(orAlunniTutti).toHaveLength(2) // «i» è di una lettera e ci sono altre parole: scartata
    expect(orAlunniTutti.every((x) => x.split(',').length === 3)).toBe(true) // ogni `or` ha le sue tre colonne
    expect(orAlunniTutti.some((x) => x.includes('%ss%'))).toBe(true)
  })

  // Prova di facilità d'uso del 14/11: «Test INF Alunno1» (cognome nome) non trovava niente, «Alunno1» sì.
  // La ricerca trova il bambino con le parole del nome e del cognome in QUALUNQUE ordine, e anche a pezzi.
  describe('nome e cognome in qualunque ordine', () => {
    const BAMBINI = [
      { id: 'al-1', nome: 'Alunno1', cognome: 'Test INF', classe_sezione: 'Infanzia', stato: 'iscritto', codice_fiscale: null },
      { id: 'al-2', nome: 'Alunno2', cognome: 'Test INF', classe_sezione: 'Infanzia', stato: 'iscritto', codice_fiscale: null },
      { id: 'al-3', nome: 'Rosa', cognome: 'Altra Famiglia', classe_sezione: 'Girasoli', stato: 'iscritto', codice_fiscale: null },
    ]
    const ids = async (q: string) => {
      const { data } = await (await GET(req(`q=${encodeURIComponent(q)}`))).json()
      return data.alunni.map((a: { id: string }) => a.id)
    }
    beforeEach(() => { h.rows['alunni'] = BAMBINI })

    it('«cognome nome» trova il bambino', async () => { expect(await ids('Test INF Alunno1')).toEqual(['al-1']) })
    it('«nome cognome» trova lo stesso bambino', async () => { expect(await ids('Alunno1 Test INF')).toEqual(['al-1']) })
    it('un ordine misto e le maiuscole non contano', async () => { expect(await ids('inf alunno1 test')).toEqual(['al-1']) })
    it('una parola sola funziona come prima: il solo cognome trova i fratelli', async () => { expect(await ids('Test')).toEqual(['al-1', 'al-2']) })
    it('tutte le parole devono corrispondere: una parola estranea non trova nessuno', async () => { expect(await ids('Alunno1 Rossi')).toEqual([]) })
    const orDi = (tabella: string) => h.filters.filter((f) => f.table === tabella && f.method === 'or').map((f) => String(f.args[0]))
    it('il jolly `*` non conta come parola: «Alunno1 *» si comporta come «Alunno1»', async () => {
      expect(await ids('Alunno1 *')).toEqual(['al-1'])
      expect(orDi('alunni')).toHaveLength(1)
      expect(orDi('alunni').join('')).not.toContain('*')
    })
    it('le parole di UNA lettera si scartano se ce ne sono altre: «Alunno1 T» cerca solo «Alunno1»', async () => {
      await ids('Alunno1 T')
      expect(orDi('alunni')).toHaveLength(1)
    })
    it('se restano solo parole di una lettera («a b») non si cerca niente', async () => {
      const res = await GET(req('q=a%20b'))
      expect((await res.json()).data).toEqual({ alunni: [], utenti: [], sezioni: [], moduli: [] })
      expect(h.filters).toHaveLength(0)
    })
    it('lo stesso vale per lo staff', async () => {
      h.rows['utenti'] = [{ id: 'ut-1', nome: 'Remo', cognome: 'Rossini', role: 'educator', ruolo: null }]
      const { data } = await (await GET(req('q=Rossini%20Remo'))).json()
      expect(data.utenti.map((u: { id: string }) => u.id)).toEqual(['ut-1'])
    })
  })

  it('gruppi vuoti se il termine sanificato resta sotto i 2 caratteri', async () => {
    const res = await GET(req(`q=${encodeURIComponent('%%')}`))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ alunni: [], utenti: [], sezioni: [], moduli: [] })
    expect(h.filters).toHaveLength(0)
  })
})
