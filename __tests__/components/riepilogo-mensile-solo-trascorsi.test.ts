/**
 * T26 · Q4 — il prospetto mensile del docente contava come già avvenute assenze
 * che nessun appello aveva registrato.
 *
 * T26 (onda 3): «2 A» e «10 ORE» per un alunno di cui UNA sola assenza era di
 * oggi e l'altra del 20/08 — dodici giorni nel futuro. Chiuso guardando la DATA.
 *
 * Q4 (onda 4): la data non basta. L'assenza che il genitore comunica per il
 * giorno CORRENTE — il valore preimpostato del modulo, cioè il caso più
 * frequente — ha `data = oggi`, quindi la vecchia marca `futura` valeva `false`
 * e il prospetto la sommava lo stesso. Il nome della marca nascondeva proprio il
 * caso peggiore: ora si chiama `fattoDelRegistro` e dice ciò che deve decidere.
 *
 * Il calendario continua a MOSTRARE tutte le righe: è il motivo per cui il
 * genitore le comunica. A fermarsi sono i CONTEGGI, e il PDF che ne discende,
 * perché quelli affermano un fatto avvenuto. Il monte ore della primaria è il
 * numero con cui si valuta la validità dell'anno scolastico.
 */
import { describe, it, expect } from 'vitest'
import { calcSummary } from '@/components/features/teacher/attendance/MonthlyAttendanceTable'
import type { MonthlyAttendanceRecord } from '@/app/api/attendance/monthly/route'

const riga = (date: string, fattoDelRegistro: boolean): MonthlyAttendanceRecord => ({
  student_id: 'a-1',
  student_nome: 'Bimbo',
  student_cognome: 'Test',
  section_name: 'TEST 1A',
  date,
  stato: 'assente',
  orario_entrata: null,
  orario_uscita: null,
  fattoDelRegistro,
})

/** Registrata dall'appello: si conta. */
const fatto = (date: string) => riga(date, true)
/** Comunicata dal genitore e non ancora lavorata dall'appello: non si conta. */
const annuncio = (date: string) => riga(date, false)

const alunno = (righe: MonthlyAttendanceRecord[]) => ({
  student_id: 'a-1',
  student_nome: 'Bimbo',
  student_cognome: 'Test',
  section_name: 'TEST 1A',
  byDate: Object.fromEntries(righe.map((r) => [r.date, r])),
})

describe('calcSummary — si conta ciò che il registro ha davvero registrato', () => {
  it('un’assenza avvenuta e una comunicata per il futuro contano UNA', () => {
    const s = calcSummary(alunno([fatto('2026-08-08'), annuncio('2026-08-20')]))
    expect(s.assenze, 'il collaudo misurava «2 A» con una sola assenza avvenuta').toBe(1)
  })

  it('l’assenza annunciata per OGGI non conta, ed è il caso che il nome `futura` nascondeva', () => {
    // Sull'asse del tempo era indistinguibile da un appello di stamattina:
    // `oggi <= oggi` è vero per costruzione.
    const s = calcSummary(alunno([annuncio('2026-08-08')]))
    expect(s.assenze).toBe(0)
    expect(s.oreAssenza).toBe(0)
  })

  it('il monte ore non include il giorno futuro', () => {
    const soloFutura = calcSummary(alunno([annuncio('2026-08-20')]))
    expect(
      soloFutura.oreAssenza,
      'un genitore poteva gonfiare il monte ore con sessanta giorni di anticipo',
    ).toBe(0)
  })

  it('senza annunci il conteggio è quello di sempre', () => {
    const s = calcSummary(alunno([fatto('2026-08-06'), fatto('2026-08-07')]))
    expect(s.assenze).toBe(2)
    expect(s.oreAssenza).toBeGreaterThan(0)
  })

  it('gli altri stati seguono la stessa regola', () => {
    const s = calcSummary(
      alunno([
        { ...fatto('2026-08-06'), stato: 'presente' },
        { ...fatto('2026-08-07'), stato: 'ritardo' },
        { ...annuncio('2026-08-21'), stato: 'ritardo' },
        { ...annuncio('2026-08-22'), stato: 'presente' },
      ]),
    )
    expect([s.presenze, s.ritardi]).toEqual([1, 1])
  })
})
