/**
 * T26 — il prospetto mensile del docente contava come già avvenute le assenze
 * comunicate per giorni FUTURI.
 *
 * Il sintomo misurato dal collaudo: «2 A» e «10 ORE» per un alunno di cui UNA
 * sola assenza era di oggi e l'altra del 20/08 — dodici giorni nel futuro — e il
 * monte ore restituiva 5,25 ore perse per quel solo giorno futuro. Gli stessi
 * numeri finivano nel PDF esportabile, e il monte ore della primaria è il numero
 * con cui si valuta la validità dell'anno scolastico (frequenza minima).
 *
 * Il calendario continua a MOSTRARE i giorni futuri comunicati: è il motivo per
 * cui il genitore li comunica. A fermarsi a oggi sono i CONTEGGI, perché quelli
 * affermano un fatto avvenuto.
 */
import { describe, it, expect } from 'vitest'
import { calcSummary } from '@/components/features/teacher/attendance/MonthlyAttendanceTable'
import type { MonthlyAttendanceRecord } from '@/app/api/attendance/monthly/route'

const riga = (date: string, futura: boolean): MonthlyAttendanceRecord => ({
  student_id: 'a-1',
  student_nome: 'Bimbo',
  student_cognome: 'Test',
  section_name: 'TEST 1A',
  date,
  stato: 'assente',
  orario_entrata: null,
  orario_uscita: null,
  futura,
})

const alunno = (righe: MonthlyAttendanceRecord[]) => ({
  student_id: 'a-1',
  student_nome: 'Bimbo',
  student_cognome: 'Test',
  section_name: 'TEST 1A',
  byDate: Object.fromEntries(righe.map((r) => [r.date, r])),
})

describe('calcSummary — si conta ciò che è già accaduto', () => {
  it('un’assenza avvenuta e una comunicata per il futuro contano UNA', () => {
    const s = calcSummary(alunno([riga('2026-08-08', false), riga('2026-08-20', true)]))
    expect(s.assenze, 'il collaudo misurava «2 A» con una sola assenza avvenuta').toBe(1)
  })

  it('il monte ore non include il giorno futuro', () => {
    const soloFutura = calcSummary(alunno([riga('2026-08-20', true)]))
    expect(
      soloFutura.oreAssenza,
      'un genitore poteva gonfiare il monte ore con sessanta giorni di anticipo',
    ).toBe(0)
  })

  it('senza righe future il conteggio è quello di sempre', () => {
    const s = calcSummary(alunno([riga('2026-08-06', false), riga('2026-08-07', false)]))
    expect(s.assenze).toBe(2)
    expect(s.oreAssenza).toBeGreaterThan(0)
  })

  it('gli altri stati seguono la stessa regola', () => {
    const s = calcSummary(
      alunno([
        { ...riga('2026-08-06', false), stato: 'presente' },
        { ...riga('2026-08-07', false), stato: 'ritardo' },
        { ...riga('2026-08-21', true), stato: 'ritardo' },
        { ...riga('2026-08-22', true), stato: 'presente' },
      ]),
    )
    expect([s.presenze, s.ritardi]).toEqual([1, 1])
  })
})
