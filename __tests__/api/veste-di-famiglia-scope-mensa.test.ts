import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * `GET /api/mensa/menu` — LA VESTE DECIDE QUALE PERIMETRO SI APPLICA, E FINO A OGGI
 * NESSUN TEST LO VERIFICAVA.
 *
 * La rotta ha tre rami che parlano della stessa persona:
 *  · con `alunno_id`, chi guarda in veste di famiglia deve avere il LEGAME col
 *    bambino;
 *  · senza `alunno_id`, chi guarda in veste di famiglia riceve `400` (il menu si
 *    consulta attraverso un figlio);
 *  · chi NON guarda in veste di famiglia deve restare dentro i propri PLESSI.
 *
 * I tre devono usare lo stesso predicato: se divergono si aprono le forbici fra chi
 * entra nel primo ramo e chi salta il terzo, e il terzo è quello che impedisce a
 * un'operatrice di leggere il menu — e con esso la configurazione — di un plesso
 * che non è suo.
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE (2026-09-01). Convertendo le tre righe da
 * `user.role === 'genitore'` ad `agisceComeGenitore(user)` si è provato a
 * FALSIFICARE ogni conversione, cioè a invertirla apposta per vedere quale test
 * diventasse rosso. Sul terzo ramo — quello del perimetro di sede — non è diventato
 * rosso NIENTE: `mensa-config-scope-sede`, `mensa-cucina-sede` e
 * `MensaCalendar-auth` insieme, 30 test, tutti verdi con il controllo di plesso
 * INVERTITO. La riga c'era da mesi e nessuno l'aveva mai vista fallire, che è la
 * definizione di codice non coperto. Le due asserzioni qui sotto sono state
 * verificate contro quella mutazione: con la condizione invertita diventano rosse
 * entrambe.
 */

const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

// ⚠️ Niente `SEDE_A`/`SEDE_B` qui dentro: `vi.hoisted` è issato SOPRA gli import,
// e leggerli darebbe `Cannot access '__vi_import_1__' before initialization`. I
// valori veri li mette `beforeEach`, che gira dopo.
const h = vi.hoisted(() => ({
  utente: { id: 'u1', role: 'segreteria' as string, scuola_id: null as string | null },
  /** I plessi accessibili a chi bussa (`scuoleDiUtente`). */
  plessi: [] as string[],
  legame: true,
  /** La sede dell'alunno letto dal finto client. */
  sedeAlunno: null as string | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
  requireStaff: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: vi.fn().mockImplementation(async () => h.plessi),
  resolveScuolaScrittura: vi.fn().mockImplementation(async () => ({ scuolaId: h.plessi[0] ?? null })),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn().mockImplementation(async () => h.legame),
}))
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({}),
  loadResolveOptions: async () => ({}),
  resolveMenuConfigId: async () => null,
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuRange: () => [] }))
vi.mock('@/lib/mensa/scope', () => ({ assertConfigMensaInScope: async () => null }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order']) b[m] = () => b
      // L'unico record che serve: l'alunno, con la sua sede.
      b.maybeSingle = async () => ({ data: { classe_sezione: '2 ANNI', scuola_id: h.sedeAlunno }, error: null })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/menu/route'

const req = (qs: string) => new NextRequest(`http://localhost/api/mensa/menu?${qs}`)

beforeEach(() => {
  h.utente = { id: 'u1', role: 'segreteria', scuola_id: SEDE_A }
  h.plessi = [SEDE_A]
  h.legame = true
  h.sedeAlunno = SEDE_B
})

describe('GET /api/mensa/menu — chi NON agisce da famiglia resta nei propri plessi', () => {
  it('la segreteria del plesso A che chiede il menu del plesso B → 403 SEDE_NON_ACCESSIBILE', async () => {
    const res = await GET(req(`scuola_id=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('e nel proprio plesso passa, altrimenti il perimetro sarebbe solo un muro', async () => {
    const res = await GET(req(`scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
  })
})

describe('GET /api/mensa/menu — chi agisce da famiglia ha per perimetro i FIGLI', () => {
  it('il genitore col legame legge il menu del figlio anche in una sede che non è la sua', async () => {
    // La sede del bambino (B) non è fra i plessi di chi chiede: per la famiglia
    // non deve contare, perché la sua sede sono i figli. Con il controllo di
    // plesso applicato anche a lei, questa lettura diventerebbe un 403.
    h.utente = { id: 'gen1', role: 'genitore', scuola_id: null }
    h.plessi = []
    const res = await GET(req(`alunno_id=${ALU_B}`))
    expect(res.status).toBe(200)
  })

  it('senza legame col bambino → 403, anche se il ruolo attivo è genitore', async () => {
    h.utente = { id: 'gen1', role: 'genitore', scuola_id: null }
    h.legame = false
    const res = await GET(req(`alunno_id=${ALU_B}`))
    expect(res.status).toBe(403)
  })

  it('senza `alunno_id` la famiglia riceve 400: il menu si consulta da un figlio', async () => {
    h.utente = { id: 'gen1', role: 'genitore', scuola_id: null }
    const res = await GET(req('from=2026-09-01'))
    expect(res.status).toBe(400)
  })
})
