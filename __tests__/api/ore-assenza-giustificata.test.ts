/**
 * A2 (26/09) — Primaria: le ore di un ritardo / di un'uscita anticipata
 * GIUSTIFICATI (`presenze.assenza_oraria_giustificata`, es. terapia) non contano
 * nel monte ore. Il calcolo sta in `@/lib/primaria/oreAssenza` (test unitari in
 * `__tests__/lib/oreAssenza.test.ts`); qui si verifica che le DUE rotte che lo
 * consumano chiedano davvero la colonna al DB e la PASSINO al calcolo.
 *
 * È il punto dove la correzione si perde senza che nessun test unitario se ne
 * accorga: la funzione pura esclude la riga, ma se la rotta ricostruisce
 * l'oggetto di input campo per campo (come fa) e dimentica il flag, il monte ore
 * resta quello di prima. Per questo ogni caso mette una riga giustificata ACCANTO
 * a una non giustificata e guarda il NUMERO, non solo la `select`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const SEZIONE = 'c2222222-2222-4222-8222-222222222222'
const ALUNNO = 'a2222222-2222-4222-8222-222222222222'
// Un lunedì di giugno (CEST): le ore sono ancorate a Roma con `+02:00` esplicito,
// come in `__tests__/lib/oreAssenza.test.ts`.
const LUNEDI = '2026-06-08'
const ts = (hhmm: string) => `${LUNEDI}T${hhmm}:00+02:00`

const h = vi.hoisted(() => ({
  /** Colonne chieste con `.select()`, per tabella. */
  select: {} as Record<string, string[]>,
  /** Risposte in coda, per tabella (una per query, nell'ordine in cui partono). */
  code: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
  usate: {} as Record<string, number>,
}))

function prendi(tabella: string) {
  const i = h.usate[tabella] ?? 0
  h.usate[tabella] = i + 1
  return h.code[tabella]?.[i] ?? { data: null, error: null }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      qb.select = (colonne: string) => {
        ;(h.select[tabella] ??= []).push(colonne)
        return qb
      }
      for (const m of ['eq', 'gte', 'lte', 'in', 'or', 'not', 'is', 'order', 'limit'])
        qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve(prendi(tabella))
      qb.single = () => Promise.resolve(prendi(tabella))
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(prendi(tabella)).then(res, rej)
      return qb
    },
  })),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'd-1', role: 'educator' }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: vi.fn(async () => ({ user: { id: 'g-1', role: 'genitore' }, response: null })),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

import { GET as OreAssenza } from '@/app/api/primaria/ore-assenza/route'
import { GET as PresenzeGenitore } from '@/app/api/parent/presenze/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.select = {}
  h.code = {}
  h.usate = {}
})

// Tre ore di lezione il lunedì, una materia per ora.
const CAMPANELLE = [
  { id: 'c1', giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
  { id: 'c2', giorno_settimana: 1, ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
  { id: 'c3', giorno_settimana: 1, ordine: 3, ora_inizio: '10:30:00', ora_fine: '11:30:00', tipo: 'lezione' },
]

// ─────────────────────────────────────────────────────────────────────────────
describe('A2 — GET /api/primaria/ore-assenza esclude le ore giustificate', () => {
  function preparaSezione() {
    h.code = {
      campanelle: [{ data: CAMPANELLE, error: null }],
      alunni: [{ data: [{ id: ALUNNO, nome: 'N', cognome: 'C' }], error: null }],
      presenze: [
        {
          data: [
            // Giustificato (terapia): entra alle 10:30 → 2 ore che NON contano.
            { alunno_id: ALUNNO, data: LUNEDI, stato: 'ritardo', orario_entrata: ts('10:30'), orario_uscita: null, assenza_oraria_giustificata: true },
            // Non giustificato: esce alle 11:00 → 30 minuti che contano.
            { alunno_id: ALUNNO, data: LUNEDI, stato: 'uscita_anticipata', orario_entrata: null, orario_uscita: ts('11:00'), assenza_oraria_giustificata: false },
          ],
          error: null,
        },
      ],
      orario_settimanale: [
        {
          data: [
            { campanella_id: 'c1', giorno_settimana: 1, materia_id: 'ita' },
            { campanella_id: 'c2', giorno_settimana: 1, materia_id: 'mat' },
            { campanella_id: 'c3', giorno_settimana: 1, materia_id: 'sto' },
          ],
          error: null,
        },
      ],
      materie: [
        { data: [{ id: 'ita', nome: 'Italiano' }, { id: 'mat', nome: 'Matematica' }, { id: 'sto', nome: 'Storia' }], error: null },
      ],
    }
  }

  it('chiede la colonna `assenza_oraria_giustificata` a `presenze`', async () => {
    preparaSezione()
    const res = await OreAssenza(new NextRequest(`http://localhost/api/primaria/ore-assenza?sectionId=${SEZIONE}`))
    expect(res.status).toBe(200)
    expect(h.select.presenze?.join(' | ')).toMatch(/\bassenza_oraria_giustificata\b/)
  })

  it('monte ore: il ritardo giustificato pesa 0, l\'uscita non giustificata conta', async () => {
    preparaSezione()
    const res = await OreAssenza(new NextRequest(`http://localhost/api/primaria/ore-assenza?sectionId=${SEZIONE}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    const riga = body.data[0]
    expect(riga.alunnoId).toBe(ALUNNO)
    expect(riga.oreRitardo).toBe(0) // sarebbe 2 senza l'esclusione
    expect(riga.orePermesso).toBe(0.5) // 11:00 → 11:30
    expect(riga.oreTotali).toBe(0.5)
  })

  it('per materia: nessun minuto perso sulle ore del ritardo giustificato', async () => {
    preparaSezione()
    const res = await OreAssenza(
      new NextRequest(`http://localhost/api/primaria/ore-assenza?sectionId=${SEZIONE}&includiMaterie=true`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // Solo l'uscita non giustificata: 30 minuti di Storia. Senza l'esclusione
    // comparirebbero Italiano (60) e Matematica (60).
    expect(body.data[0].perMateria).toEqual({ sto: { nome: 'Storia', minutiMancati: 30, oreMancate: 0.5 } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A2 — GET /api/parent/presenze: ore giustificate e nota di oggi', () => {
  function prepara(schoolType: string, oggi: Record<string, unknown> | null) {
    h.code = {
      alunni: [{ data: { id: ALUNNO, section_id: SEZIONE, scuola_id: 's-1' }, error: null }],
      sections: [{ data: { school_type: schoolType }, error: null }],
      presenze: [
        // 1) oggi (maybeSingle)
        { data: oggi, error: null },
        // 2) periodo 30 giorni
        {
          data: [
            { stato: 'ritardo', orario_entrata: ts('10:30'), orario_uscita: null, data: LUNEDI, assenza_oraria_giustificata: true },
            { stato: 'ritardo', orario_entrata: ts('09:30'), orario_uscita: null, data: LUNEDI, assenza_oraria_giustificata: false },
          ],
          error: null,
        },
        // 3) assenze comunicate ancora annullabili
        { data: [], error: null },
      ],
      campanelle: [{ data: CAMPANELLE.map(({ ora_inizio, ora_fine, tipo }) => ({ ora_inizio, ora_fine, tipo })), error: null }],
    }
  }
  const req = () => new NextRequest(`http://localhost/api/parent/presenze?studentId=${ALUNNO}`)

  const OGGI_GIUSTIFICATO = {
    stato: 'ritardo',
    orario_entrata: ts('10:30'),
    orario_uscita: null,
    registrato_da: 'd-1',
    giustificata_da: null,
    assenza_oraria_giustificata: true,
    note_appello: 'terapia',
  }

  it('chiede la colonna sia per OGGI sia per il riepilogo (e la nota per oggi)', async () => {
    prepara('primaria', OGGI_GIUSTIFICATO)
    const res = await PresenzeGenitore(req())
    expect(res.status).toBe(200)
    const [selOggi, selPeriodo] = h.select.presenze ?? []
    expect(selOggi).toMatch(/\bassenza_oraria_giustificata\b/)
    expect(selOggi).toMatch(/\bnote_appello\b/)
    expect(selPeriodo).toMatch(/\bassenza_oraria_giustificata\b/)
    // Il riepilogo di 30 giorni non ha bisogno del testo libero del docente.
    expect(selPeriodo).not.toMatch(/\bnote_appello\b/)
  })

  it('primaria: il monte ore dei 30 giorni esclude il ritardo giustificato', async () => {
    prepara('primaria', OGGI_GIUSTIFICATO)
    const res = await PresenzeGenitore(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    // Il CONTEGGIO dei ritardi non cambia: l'alunno non era in classe.
    expect(body.data.riepilogo.ritardi).toBe(2)
    // Le ORE sì: solo il ritardo non giustificato (09:30 − 08:30).
    expect(body.data.riepilogo.ore.oreRitardo).toBe(1)
    expect(body.data.riepilogo.ore.oreTotali).toBe(1)
  })

  it('primaria: `oggi` restituisce flag e nota, e lo stato resta `ritardo`', async () => {
    prepara('primaria', OGGI_GIUSTIFICATO)
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(body.data.oggi).toEqual({
      stato: 'ritardo',
      orario_entrata: ts('10:30'),
      orario_uscita: null,
      assenza_oraria_giustificata: true,
      note_appello: 'terapia',
    })
  })

  it('oggi senza riga: flag false e nota null (la forma non cambia)', async () => {
    prepara('primaria', null)
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(body.data.oggi.stato).toBeNull()
    expect(body.data.oggi.assenza_oraria_giustificata).toBe(false)
    expect(body.data.oggi.note_appello).toBeNull()
  })

  it('nido/infanzia: la nota interna del docente NON esce verso il genitore', async () => {
    // Su 0-6 `note_appello` è la nota interna del docente (vedi
    // `attendance/daily`): il genitore la vede solo sulla primaria, dove
    // `parent/primaria/assenze` gliela mostra già.
    prepara('infanzia', { ...OGGI_GIUSTIFICATO, stato: 'presente', assenza_oraria_giustificata: false, note_appello: 'nota interna' })
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.oggi.stato).toBe('presente')
    expect(body.data.oggi.note_appello).toBeNull()
    expect(body.data.oggi.assenza_oraria_giustificata).toBe(false)
  })

  it('primaria + `presente`: la nota del docente NON esce (il genitore non l\'ha mai vista)', async () => {
    // `parent/primaria/assenze` mostra le note solo delle righe
    // assente/ritardo/uscita_anticipata: una nota su una riga `presente` è
    // testo libero del docente che al genitore non è mai arrivato.
    prepara('primaria', { ...OGGI_GIUSTIFICATO, stato: 'presente', orario_entrata: null, assenza_oraria_giustificata: false, note_appello: 'nota interna' })
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.oggi.stato).toBe('presente')
    expect(body.data.oggi.note_appello).toBeNull()
    expect(body.data.oggi.assenza_oraria_giustificata).toBe(false)
  })

  it('primaria + riga solo ANNUNCIATA dal genitore: niente stato, niente nota, flag spento', async () => {
    // Annuncio = `assente` + `giustificata_da` valorizzato + `registrato_da`
    // nullo, per oggi. Non è l'appello: anche se la riga porta una nota e il
    // flag (valori che il trigger non ammetterebbe, messi qui apposta perché
    // solo il ramo dell'annuncio li possa spegnere), la home non li mostra.
    prepara('primaria', {
      stato: 'assente',
      orario_entrata: null,
      orario_uscita: null,
      registrato_da: null,
      giustificata_da: 'g-1',
      assenza_oraria_giustificata: true,
      note_appello: 'nota della riga annunciata',
    })
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.oggi.stato).toBeNull()
    expect(body.data.oggi.note_appello).toBeNull()
    expect(body.data.oggi.assenza_oraria_giustificata).toBe(false)
  })

  it('primaria + `assente` registrato dal docente: la nota esce (come in `parent/primaria/assenze`)', async () => {
    prepara('primaria', { ...OGGI_GIUSTIFICATO, stato: 'assente', orario_entrata: null, assenza_oraria_giustificata: false, note_appello: 'febbre' })
    const res = await PresenzeGenitore(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.oggi.stato).toBe('assente')
    expect(body.data.oggi.note_appello).toBe('febbre')
    expect(body.data.oggi.assenza_oraria_giustificata).toBe(false)
  })
})
