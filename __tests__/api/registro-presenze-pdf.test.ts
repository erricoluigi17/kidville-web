// @vitest-environment node
/**
 * Il registro presenze mensile, ora generato dal SERVER.
 *
 * Fino al 2026-08-16 questo PDF nasceva nel browser, dentro `MonthlyAttendanceTable.tsx`:
 * niente carta intestata (l'asset pesa 1,1 MB e non può entrare in un bundle client) e
 * nessun gate, perché i dati erano già in memoria. Spostarlo qui non è un trasloco: è il
 * momento in cui il registro di una classe smette di poter essere stampato da chi quella
 * classe non ce l'ha.
 *
 * Nessun dato reale: uuid, nomi e sezioni sono inventati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { immaginiDisegnate, ingombriPercorsi } from '../fixtures/misure-pdf'

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const DOCENTE = 'e0e0e0e0-1111-4111-8111-eeeeeeeeeeee'
const SEZIONE = '3 ANNI'
const SEC = 'c1c1c1c1-1111-4111-8111-cccccccccccc'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertClasseNomeInScope: vi.fn(),
  // Il gemello per UUID: da quando la classe si identifica con `section_id`
  // (2026-09-02) `risolviSezione` sceglie fra i due gate.
  assertSezioneInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
}))

/**
 * `test/setup.ts` sostituisce `next-intl` con uno stub che risolve le chiavi contro i soli
 * messaggi ITALIANI e **non interpola i segnaposto**: serve ai componenti, che senza
 * provider lancerebbero. Qui no. Questa rotta traduce sul serio — è l'unica che produce un
 * documento in due lingue senza passare da React — e con lo stub il titolo del registro
 * uscirebbe stampato «REGISTRO PRESENZE — {mese} {anno}». Si ripristina il modulo vero.
 */
vi.mock('next-intl', async (originale) => await originale())

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertClasseNomeInScope: h.assertClasseNomeInScope,
  assertSezioneInScope: h.assertSezioneInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, []) }
})

import { GET } from '@/app/api/admin/registro-presenze/pdf/route'

const OGGI = oggiFiscaleISO()
const [ANNO, MESE] = OGGI.split('-').map(Number)

const richiesta = (query = `year=${ANNO}&month=${MESE}&sezione=${encodeURIComponent(SEZIONE)}`) =>
  new NextRequest(`http://localhost/api/admin/registro-presenze/pdf?${query}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    // `sections` è la traduzione nome→uuid che la rotta fa prima di leggere gli
    // alunni: senza questa riga uscirebbe un 404 e il test proverebbe il vuoto.
    sections: [{ id: SEC, scuola_id: SEDE, name: SEZIONE }],
    alunni: [
      { id: ALU_1, nome: 'Anna', cognome: 'Bianchi', section_id: SEC, classe_sezione: SEZIONE, scuola_id: SEDE },
      { id: ALU_2, nome: 'Bruno', cognome: 'Verdi', section_id: SEC, classe_sezione: SEZIONE, scuola_id: SEDE },
    ],
    presenze: [
      // Un fatto del registro: l'appello di oggi, scritto dal docente.
      {
        id: 'p1',
        alunno_id: ALU_1,
        data: OGGI,
        stato: 'presente',
        registrato_da: DOCENTE,
        giustificata_da: null,
      },
      // Un ANNUNCIO del genitore per oggi: si vede nel calendario, non si conta.
      {
        id: 'p2',
        alunno_id: ALU_2,
        data: OGGI,
        stato: 'assente',
        registrato_da: null,
        giustificata_da: 'genitore',
      },
    ],
  }
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertClasseNomeInScope.mockResolvedValue(null)
  h.assertSezioneInScope.mockResolvedValue(null)
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
})

describe('GET /api/admin/registro-presenze/pdf — il foglio', () => {
  it('restituisce un PDF sulla carta intestata reale, in allegato', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="[\w.\-]+\.pdf"$/)

    const pdf = new Uint8Array(await res.arrayBuffer())
    // Senza la carta il registro pesa qualche decina di KB: l'asset ne pesa 1.097.589.
    expect(pdf.byteLength).toBeGreaterThan(500_000)
    expect((await ingombriPercorsi(pdf)).length).toBeGreaterThan(50)
    // La carta è vettoriale pura: un'immagine sul foglio vorrebbe dire che qualcuno ha
    // ridisegnato un logo sopra quello stampato.
    expect(await immaginiDisegnate(pdf)).toEqual([])
  })

  it('porta i nomi degli alunni e il titolo del mese', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const res = await GET(richiesta())
    const testo = (await estraiTesto(new Uint8Array(await res.arrayBuffer()))).replace(/\s+/g, ' ')
    expect(testo).toContain('Bianchi Anna')
    expect(testo).toContain('Verdi Bruno')
    expect(testo).toContain('REGISTRO PRESENZE')
    expect(testo).toContain(SEZIONE)
  })

  it('in inglese cambia lingua senza cambiare foglio', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const res = await GET(
      richiesta(`year=${ANNO}&month=${MESE}&sezione=${encodeURIComponent(SEZIONE)}&locale=en`)
    )
    expect(res.status).toBe(200)
    const testo = (await estraiTesto(new Uint8Array(await res.arrayBuffer()))).replace(/\s+/g, ' ')
    expect(testo).toContain('ATTENDANCE REGISTER')
    expect(testo).toContain('Student')
  })
})

describe('GET /api/admin/registro-presenze/pdf — i gate', () => {
  it('senza ruolo docente non si stampa niente', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    const res = await GET(richiesta())
    expect(res.status).toBe(401)
  })

  it('su una classe non assegnata risponde con il rifiuto del gate di sezione', async () => {
    // È il gate che il PDF nel browser non poteva avere: lì i dati erano già in memoria.
    h.assertClasseNomeInScope.mockResolvedValue(
      NextResponse.json({ error: 'Classe non assegnata' }, { status: 403 })
    )
    const res = await GET(richiesta())
    expect(res.status).toBe(403)
  })

  it('senza sedi attive non stampa il registro di nessuno', async () => {
    h.resolveScuoleAttive.mockResolvedValue([])
    const res = await GET(richiesta())
    expect(res.status).toBe(403)
  })

  it('sezione senza alunni: 404, non un foglio vuoto spacciato per registro', async () => {
    h.db.alunni = []
    const res = await GET(richiesta())
    expect(res.status).toBe(404)
  })

  it('un mese fuori scala è un 400, non un PDF di 8.000 colonne', async () => {
    const res = await GET(richiesta(`year=${ANNO}&month=13&sezione=${encodeURIComponent(SEZIONE)}`))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/admin/registro-presenze/pdf — i conteggi', () => {
  it("l'assenza soltanto ANNUNCIATA per oggi non entra nei totali", async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const res = await GET(richiesta())
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))
    // Bruno Verdi ha una sola riga, un annuncio del genitore per oggi: nel riepilogo
    // deve avere 0 assenze. La riga del PDF finisce con i tre conteggi P/A/R.
    const riga = testo.split('\n').find((r) => r.includes('Verdi Bruno'))
    expect(riga, 'riga di Verdi Bruno assente dal PDF').toBeTruthy()
    expect(riga!.replace(/\s+/g, ' ')).toMatch(/Verdi Bruno.*\b0 0 0\b/)
  })

  it('una classe OMONIMA di un’altra sede non finisce nel registro', async () => {
    // Con tre plessi «3 ANNI» esiste a Giugliano, ad Aversa e a Cesa: senza il filtro per
    // sede il registro di una sezione mescolerebbe i bambini di due scuole diverse — e la
    // maestra firmerebbe un foglio con dentro nomi di minori che non ha mai visto.
    const ALTRA_SEDE = 'cccccccc-0000-4000-8000-00000000000c'
    // La sezione OMONIMA dell'altra sede esiste davvero in anagrafica: è ciò che
    // rende il caso reale. La rotta risolve il nome DENTRO le sedi attive, e
    // questa non lo è — quindi il suo uuid non entra nel filtro.
    h.db.sections.push({ id: 'sec-altra', scuola_id: ALTRA_SEDE, name: SEZIONE })
    h.db.alunni.push({
      id: 'c3c3c3c3-3333-4333-8333-cccccccccccc',
      nome: 'Carla',
      cognome: 'Neri',
      section_id: 'sec-altra',
      classe_sezione: SEZIONE,
      scuola_id: ALTRA_SEDE,
    })
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))
    expect(testo).toContain('Bianchi Anna')
    expect(testo).not.toContain('Neri Carla')
  })
})
