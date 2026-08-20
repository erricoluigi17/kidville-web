import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// L'INOLTRO AI PLESSI DELLE COPIE MAI PARTITE.
//
// ─── LE QUATTRO COSE CHE QUESTO FILE DIFENDE ────────────────────────────────
//
//  1. IL GATE È QUELLO DELLA DIREZIONE, non quello dell'elenco. Questa rotta
//     spedisce decine di email con dati personali a caselle vere: chi non può
//     approvare una candidatura non può nemmeno riversarle tutte nella posta dei
//     plessi. Il finto `requireStaff` qui sotto LEGGE la lista `allowed` che la
//     route gli passa — senza, il test sarebbe verde anche con un gate nudo, che
//     è precisamente il difetto che vuole impedire.
//
//  2. `prova: true` NON SPEDISCE E NON SCRIVE. Un conteggio che manda un'email è
//     peggio di nessun conteggio, perché chi lo chiede sta ancora decidendo.
//
//  3. QUESTA ROTTA NON SEGNA PIÙ NIENTE. `copia_inviata_il` la scrive
//     `inviaCopiaAllaSede`, cioè il punto da cui passano ENTRAMBE le strade —
//     questa e il modulo pubblico — e il test che difende «si segna solo ciò che
//     è partito davvero» sta là, in `__tests__/lib/candidature/copia-alla-sede`.
//     Qui resta il verso: se qualcuno rimettesse l'`update` in questo file, la
//     regola tornerebbe ad avere due case, che è la condizione da cui il difetto
//     del 2026-08-20 è nato.
//
//  4. UN 429 FERMA IL GIRO. «Non oggi» non è «non si può»: insistere brucia
//     tentativi che falliscono tutti, e il resto dell'arretrato è ancora lì
//     domani.
// =============================================================================

type Riga = Record<string, unknown>

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const SEGRETERIA = { id: 'aaaaaaaa-1111-4000-8000-000000000003', role: 'segreteria', scuola_id: SEDE_A }
const EDUCATOR = { id: 'aaaaaaaa-1111-4000-8000-000000000004', role: 'educator', scuola_id: SEDE_A }

const h = vi.hoisted(() => ({
  state: {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    righe: [] as Riga[],
    aggiornamenti: [] as { id: unknown; patch: Riga }[],
  },
  requireStaff: vi.fn(),
  inviaCopiaAllaSede: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/candidature/copia-alla-sede', () => ({ inviaCopiaAllaSede: h.inviaCopiaAllaSede }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk,
}))
vi.mock('@/lib/logging/with-route', () => ({
  withRoute: (_n: string, fn: unknown) => fn,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      if (tabella === 'scuole') {
        return {
          select: async () => ({
            data: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
            error: null,
          }),
        }
      }
      // `candidature_insegnanti`
      const q = {
        _limite: 1000,
        select() { return q },
        is() { return q },
        order() { return q },
        limit(n: number) { q._limite = n; return q },
        then(risolvi: (v: { data: Riga[]; error: null }) => unknown) {
          return Promise.resolve(risolvi({ data: h.state.righe.slice(0, q._limite), error: null }))
        },
        update(patch: Riga) {
          return {
            eq: async (_col: string, id: unknown) => {
              h.state.aggiornamenti.push({ id, patch })
              return { error: null }
            },
          }
        },
      }
      return q
    },
  }),
}))

import { POST } from '@/app/api/admin/candidature-insegnanti/inoltro-arretrato/route'

/** Una candidatura come la restituisce la SELECT della rotta. */
function candidatura(id: string, sedi: string[], extra: Riga = {}): Riga {
  return {
    id,
    creata_il: '2026-08-12T10:00:00.000Z',
    cv_path: null,
    consents_log: { blocchi: [{ field_id: 'presa_visione_informativa', accepted: true }] },
    nome: 'Maria',
    cognome: 'Rossi',
    email: 'maria@example.test',
    candidature_sedi: sedi.map((s) => ({ scuola_id: s })),
    ...extra,
  }
}

function chiamata(corpo: Riga = {}): NextRequest {
  return new NextRequest('http://localhost/api/admin/candidature-insegnanti/inoltro-arretrato', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

beforeEach(() => {
  h.state.utente = ADMIN
  h.state.righe = []
  h.state.aggiornamenti = []
  h.logEvento.mockReset()
  h.inviaCopiaAllaSede.mockReset().mockResolvedValue({ ok: true, rinviabile: false, segnata: true })
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'non autenticato' }, { status: 401 }) }
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    if (!ammessi.includes(u.role)) {
      return { response: NextResponse.json({ error: 'vietato' }, { status: 403 }) }
    }
    return { response: null, user: u }
  })
})

describe('il gate è quello della Direzione, non quello dell’elenco', () => {
  it('admin passa', async () => {
    h.state.utente = ADMIN
    expect((await POST(chiamata({ prova: true }))).status).toBe(200)
  })

  it('la SEGRETERIA no, benché veda l’elenco delle candidature', async () => {
    // È la differenza che questo test esiste per tenere: leggere l'elenco e
    // riversarlo nelle caselle dei plessi non sono la stessa autorizzazione.
    h.state.utente = SEGRETERIA
    expect((await POST(chiamata({ prova: true }))).status).toBe(403)
  })

  it('una docente nemmeno', async () => {
    h.state.utente = EDUCATOR
    expect((await POST(chiamata({ prova: true }))).status).toBe(403)
  })

  it('senza sessione, 401', async () => {
    h.state.utente = null
    expect((await POST(chiamata({ prova: true }))).status).toBe(401)
  })
})

describe('prova: conta e basta', () => {
  it('non spedisce niente e non scrive niente', async () => {
    h.state.righe = [candidatura('c1', [SEDE_A]), candidatura('c2', [SEDE_A, SEDE_B])]
    const res = await POST(chiamata({ prova: true }))
    const json = await res.json()
    expect(json.da_inviare).toBe(2)
    expect(json.multi_sede).toBe(1)
    expect(h.inviaCopiaAllaSede).not.toHaveBeenCalled()
    expect(h.state.aggiornamenti).toEqual([])
  })
})

describe('l’invio vero', () => {
  it('manda una copia per candidatura', async () => {
    h.state.righe = [candidatura('c1', [SEDE_A]), candidatura('c2', [SEDE_B])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.inviate).toBe(2)
    expect(h.inviaCopiaAllaSede.mock.calls.map((c) => c[1].entitaId)).toEqual(['c1', 'c2'])
  })

  /**
   * ─── LA MEMORIA NON SI SCRIVE PIÙ QUI ──────────────────────────────────────
   *
   * `copia_inviata_il` la scrive `inviaCopiaAllaSede`, cioè il punto da cui
   * passano entrambe le strade. Finché stava soltanto in questa rotta, il modulo
   * pubblico spediva senza lasciare memoria: il 2026-08-20 quattro candidature
   * avevano la copia in casella e la colonna a NULL, e sette sedi hanno ricevuto
   * due volte la stessa candidata.
   *
   * Questo test è il guardiano di quella correzione: se un giorno qualcuno
   * rimettesse l'`update` qui dentro «per sicurezza», la riga verrebbe scritta
   * due volte e la regola tornerebbe ad avere due case — che è la condizione da
   * cui il difetto è nato.
   */
  it('la rotta NON scrive più la colonna: la memoria è appesa all’invio, non al chiamante', async () => {
    h.state.righe = [candidatura('c1', [SEDE_A]), candidatura('c2', [SEDE_B])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.inviate).toBe(2)
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('partita ma non segnata → si conta e si riporta, perché tornerà come doppione', async () => {
    // Non poterlo scrivere non è una perdita — l'email è in casella — ma se
    // succede su tutte le righe l'inoltro non finisce mai, e chi legge il
    // resoconto deve saperlo prima di rilanciarlo.
    h.inviaCopiaAllaSede.mockResolvedValue({ ok: true, rinviabile: false, segnata: false })
    h.state.righe = [candidatura('c1', [SEDE_A]), candidatura('c2', [SEDE_B])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.inviate).toBe(2)
    expect(json.partite_ma_non_segnate).toBe(2)
  })

  it('i plessi arrivano come ELENCO di uuid, e i nomi in chiaro accanto', async () => {
    h.state.righe = [candidatura('c1', [SEDE_A, SEDE_B])]
    await POST(chiamata({}))
    const arg = h.inviaCopiaAllaSede.mock.calls[0][1]
    expect(arg.scuoleIds).toEqual([SEDE_A, SEDE_B])
    expect(arg.sediScelte).toEqual(['Kidville Alfa', 'Kidville Beta'])
  })

  it('una copia NON partita non entra fra le inviate: altrimenti sparisce per sempre', async () => {
    h.inviaCopiaAllaSede.mockResolvedValue({ ok: false, rinviabile: false, segnata: false })
    h.state.righe = [candidatura('c1', [SEDE_A])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.inviate).toBe(0)
    expect(json.fallite).toBe(1)
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('un 429 FERMA il giro', async () => {
    h.inviaCopiaAllaSede
      .mockResolvedValueOnce({ ok: true, rinviabile: false, segnata: true })
      .mockResolvedValueOnce({ ok: false, rinviabile: true, segnata: false })
    h.state.righe = [candidatura('c1', [SEDE_A]), candidatura('c2', [SEDE_A]), candidatura('c3', [SEDE_A])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.inviate).toBe(1)
    expect(json.fermato).toBe('quota-del-provider-esaurita')
    // La terza non è stata nemmeno tentata: insistere dopo un «non oggi» brucia
    // tentativi che falliscono tutti.
    expect(h.inviaCopiaAllaSede).toHaveBeenCalledTimes(2)
  })

  it('una candidatura SENZA righe di sede non si spedisce «da qualche parte»: si conta e si logga error', async () => {
    h.state.righe = [candidatura('orfana', [])]
    const json = await (await POST(chiamata({}))).json()
    expect(json.senza_riga_di_sede).toBe(1)
    expect(h.inviaCopiaAllaSede).not.toHaveBeenCalled()
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori.length).toBeGreaterThan(0)
  })
})

describe('il curriculum assente: due frasi diverse per due cose diverse', () => {
  it('candidatura ANTERIORE al 15/08 → «non poteva caricarlo»', async () => {
    h.state.righe = [candidatura('vecchia', [SEDE_A], { creata_il: '2026-08-12T10:00:00.000Z' })]
    await POST(chiamata({}))
    expect(h.inviaCopiaAllaSede.mock.calls[0][1].curriculumNonPrevisto).toBe(true)
  })

  it('candidatura POSTERIORE → «non ne ha caricato uno», che è una scelta sua', async () => {
    // Dire «non ne ha caricato uno» a chi non poteva accusa una persona di una
    // negligenza che non ha commesso; dire «non poteva» a chi poteva scusa una
    // scelta che la sede ha il diritto di leggere per quello che è.
    h.state.righe = [candidatura('nuova', [SEDE_A], { creata_il: '2026-08-19T10:00:00.000Z' })]
    await POST(chiamata({}))
    expect(h.inviaCopiaAllaSede.mock.calls[0][1].curriculumNonPrevisto).toBe(false)
  })

  it('col curriculum presente la domanda non si pone', async () => {
    h.state.righe = [candidatura('conCv', [SEDE_A], { cv_path: 'candidature/x.pdf', creata_il: '2026-08-12T10:00:00.000Z' })]
    await POST(chiamata({}))
    expect(h.inviaCopiaAllaSede.mock.calls[0][1].cvPath).toBe('candidature/x.pdf')
  })
})

describe('il tetto per chiamata', () => {
  it('oltre il tetto assoluto la richiesta è respinta, non troncata in silenzio', async () => {
    expect((await POST(chiamata({ max: 500 }))).status).toBe(400)
  })

  it('il tetto chiesto arriva alla query', async () => {
    h.state.righe = Array.from({ length: 10 }, (_, i) => candidatura(`c${i}`, [SEDE_A]))
    const json = await (await POST(chiamata({ max: 3 }))).json()
    expect(json.esaminate).toBe(3)
  })
})
