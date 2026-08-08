/**
 * T26 e T27 — i tre lettori di `presenze` rimasti indietro, e il giorno che il
 * cockpit interrogava sbagliato.
 *
 * T26. «Comunica un'assenza» ha aperto una seconda sorgente di scrittura su
 * `presenze`, che scrive nel FUTURO. Due consumatori erano stati adeguati; gli
 * altri tre no:
 *  · `primaria/ore-assenza:GET` → 5,25 ore perse per un giorno che non è ancora
 *    arrivato, dentro il numero che decide la validità dell'anno scolastico;
 *  · `attendance/monthly:GET` → «2 A» e «10 ORE» nel prospetto del docente e nel
 *    PDF esportabile;
 *  · `parent/primaria:GET` → nessun tetto superiore (oggi latente: il suo unico
 *    consumatore non è montato da nessuna pagina, ma la porta resta aperta).
 *
 * T27. `admin/presenze/realtime:GET` calcolava «oggi» con
 * `new Date().toISOString().slice(0,10)`, che è UTC: fra mezzanotte e le due
 * italiane il cruscotto della segreteria interrogava IERI e rispondeva
 * «assenti: 0» con due bambini segnati assenti. Un guasto travestito da dato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

const SEDE = 'e1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const DOCENTE = 'd1111111-1111-4111-8111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  /** Filtri visti sulle query di `presenze`, per rotta. */
  filtri: [] as { tabella: string; metodo: string; colonna: string; valore: unknown }[],
  /** Righe restituite da `presenze` (una avvenuta, una nel futuro). */
  presenze: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: DOCENTE, role: 'educator' }, response: null })),
  requireStaff: vi.fn(async () => ({ user: { id: DOCENTE, role: 'admin' }, response: null })),
  requireUser: vi.fn(async () => ({ user: { id: DOCENTE, role: 'admin' }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
  assertClasseNomeInScope: vi.fn(async () => null),
  resolveScuoleAttive: vi.fn(async () => [SEDE]),
  scuoleDiUtente: vi.fn(async () => [SEDE]),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'not', 'is'] as const) qb[m] = () => qb
      for (const m of ['eq', 'lte', 'gte', 'in', 'limit'] as const) {
        qb[m] = (colonna: unknown, valore?: unknown) => {
          h.filtri.push({ tabella, metodo: m, colonna: String(colonna), valore })
          return qb
        }
      }
      qb.maybeSingle = async () => ({ data: null, error: null })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            tabella === 'presenze' ? h.presenze
            : tabella === 'alunni' ? [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Test', section_id: SEZIONE, scuola_id: SEDE, classe_sezione: 'TEST 1A' }]
            : tabella === 'schools' ? [{ id: SEDE, nome: 'Kidville Collaudo' }]
            : tabella === 'sections' ? [{ id: SEZIONE, name: 'TEST 1A', scuola_id: SEDE }]
            : [],
          error: null,
        }).then(res)
      return qb
    },
  })),
}))

import { GET as OreAssenza } from '@/app/api/primaria/ore-assenza/route'
import { GET as Mensile } from '@/app/api/attendance/monthly/route'
import { GET as Realtime } from '@/app/api/admin/presenze/realtime/route'

const OGGI = oggiFiscaleISO()
const FUTURO = `${Number(OGGI.slice(0, 4)) + 1}-01-15`

beforeEach(() => {
  vi.clearAllMocks()
  h.filtri = []
  h.presenze = [
    { id: 'p-1', alunno_id: ALUNNO, data: OGGI, stato: 'assente', orario_entrata: null, orario_uscita: null },
    { id: 'p-2', alunno_id: ALUNNO, data: FUTURO, stato: 'assente', orario_entrata: null, orario_uscita: null },
  ]
})

/** I `.lte` visti su `presenze`, con il valore. */
const tettiSuPresenze = () =>
  h.filtri.filter((f) => f.tabella === 'presenze' && f.metodo === 'lte' && f.colonna === 'data').map((f) => f.valore)

// ─────────────────────────────────────────────────────────────────────────────
describe('T26 — `primaria/ore-assenza`: il monte ore conta i giorni trascorsi', () => {
  it('la query di `presenze` porta il tetto a OGGI, anche con un `to` più lontano', async () => {
    await OreAssenza(
      new NextRequest(`http://localhost/api/primaria/ore-assenza?sectionId=${SEZIONE}&from=2026-01-01&to=2099-12-31`),
    )
    expect(
      tettiSuPresenze(),
      'senza tetto un genitore gonfia il monte ore con sessanta giorni di anticipo',
    ).toContain(OGGI)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T26 — `attendance/monthly`: il calendario mostra, il conteggio no', () => {
  it('le righe future arrivano al client MARCATE, così il conteggio può escluderle', async () => {
    const res = await Mensile(new NextRequest('http://localhost/api/attendance/monthly?sezione=TEST%201A&year=2026&month=8'))
    const righe = (await res.json()) as { date: string; futura?: boolean }[]
    const futura = righe.find((r) => r.date === FUTURO)
    const passata = righe.find((r) => r.date === OGGI)
    expect(futura?.futura, 'il calendario le mostra: a distinguerle deve essere una marca, non l’assenza della riga').toBe(true)
    expect(passata?.futura).toBe(false)
  })

  it('la marca la decide il SERVER, non l’orologio del tablet', async () => {
    // Se la decidesse il client, un tablet con la data sbagliata conterebbe
    // diversamente dallo stesso registro aperto da un altro dispositivo.
    const res = await Mensile(new NextRequest('http://localhost/api/attendance/monthly?sezione=TEST%201A&year=2026&month=8'))
    const righe = (await res.json()) as { futura?: boolean }[]
    expect(righe.every((r) => typeof r.futura === 'boolean')).toBe(true)
  })

  it('il `message` grezzo di PostgREST non esce verso il docente', async () => {
    // Regola già dichiarata dal gemello `comunica-assenza`: la prosa inglese con
    // dentro nomi di colonne e vincoli resta nel log.
    const sorgente = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/attendance/monthly/route.ts', 'utf8'),
    )
    expect(sorgente).not.toContain('details: presenzeError.message')
    expect(sorgente).not.toContain('details: alunniError.message')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T27 — `admin/presenze/realtime`: il giorno è quello ITALIANO', () => {
  it('interroga `presenze` sul giorno civile italiano, non su quello UTC', async () => {
    await Realtime(new NextRequest('http://localhost/api/admin/presenze/realtime'))
    const giorno = h.filtri.find((f) => f.tabella === 'presenze' && f.metodo === 'eq' && f.colonna === 'data')?.valore
    expect(
      giorno,
      'fra mezzanotte e le due italiane `toISOString()` restituisce ieri: il cockpit rispondeva «assenti: 0»',
    ).toBe(OGGI)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T26/T27 — la catena del registro non calcola più «oggi» in UTC', () => {
  it('nessuna rotta che legge `presenze` usa `toISOString().slice(0,10)`', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const file: string[] = []
    const cammina = (dir: string) => {
      for (const voce of readdirSync(dir)) {
        const p = join(dir, voce)
        if (statSync(p).isDirectory()) cammina(p)
        else if (p.endsWith('.ts')) file.push(p)
      }
    }
    cammina('src/app/api')
    /** I commenti non sono codice: qui dentro l'idioma è CITATO per spiegarlo. */
    const senzaCommenti = (src: string) =>
      src
        .split('\n')
        .filter((r) => {
          const t = r.trim()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        })
        .join('\n')
    const colpevoli = file.filter((f) => {
      const src = readFileSync(f, 'utf8')
      if (!src.includes("from('presenze')")) return false
      return /new Date\(\)\.toISOString\(\)\.(slice\(0, ?10\)|split\('T'\)\[0\])/.test(senzaCommenti(src))
    })
    expect(
      colpevoli,
      'l’idioma UTC su una rotta del registro è il difetto T27, che è già costato due schermate',
    ).toEqual([])
  })
})
