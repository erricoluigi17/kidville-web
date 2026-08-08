/**
 * T26 — «si conta ciò che è già accaduto», in un posto solo.
 *
 * L'assunzione infranta è scritta per esteso in `parent/primaria/assenze:GET`:
 * fino al 2026-08-07 `presenze` aveva UNA sola sorgente di scrittura — il
 * docente, sul giorno corrente — quindi «una riga di presenze è un giorno già
 * trascorso» era vero per COSTRUZIONE, e tutti i consumatori sono stati scritti
 * su quel presupposto. «Comunica un'assenza» ne ha introdotta una seconda, che
 * scrive `data >= oggi`.
 *
 * La correzione del ciclo precedente è andata sui DUE consumatori su cui era
 * stato scritto il rilievo, non sulla regola: il registro del docente contava
 * ancora «2 A» e «10 ORE» per un alunno con una sola assenza avvenuta e una
 * comunicata per dodici giorni nel futuro, e gli stessi numeri finivano nel PDF.
 * Il monte ore della primaria è il numero con cui si valuta la validità
 * dell'anno scolastico: un genitore poteva gonfiarlo con sessanta giorni di
 * anticipo.
 *
 * «una regola valida per due strade deve vivere in un posto solo» — la lezione
 * è già scritta in `src/lib/presenze/limiti-testo.ts`.
 */
import { describe, it, expect } from 'vitest'
import { eGiornoTrascorso, limitaAOggi, soloTrascorsi } from '@/lib/presenze/finestra-trascorsa'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

describe('eGiornoTrascorso', () => {
  it('oggi CONTA (`lte`, non `lt`)', () => {
    // Con `lt` l'appello fatto stamattina resterebbe invisibile fino a domani:
    // si toglierebbe un dato VERO per nascondere un dato futuro. È la stessa
    // definizione già scelta dalle due rotte corrette nel ciclo precedente.
    expect(eGiornoTrascorso('2026-08-08', '2026-08-08')).toBe(true)
  })

  it('ieri conta, domani no', () => {
    expect(eGiornoTrascorso('2026-08-07', '2026-08-08')).toBe(true)
    expect(eGiornoTrascorso('2026-08-09', '2026-08-08')).toBe(false)
    expect(eGiornoTrascorso('2026-12-31', '2026-08-08')).toBe(false)
  })

  it('senza il secondo argomento usa OGGI in Europe/Rome, non UTC', () => {
    // `new Date().toISOString()` fra mezzanotte e le due italiane restituisce
    // ancora ieri: è il difetto per cui esiste `oggiFiscaleISO()`.
    expect(eGiornoTrascorso(oggiFiscaleISO())).toBe(true)
  })

  it('una data illeggibile NON viene contata (in dubbio non si somma)', () => {
    expect(eGiornoTrascorso('', '2026-08-08')).toBe(false)
    expect(eGiornoTrascorso('non-una-data', '2026-08-08')).toBe(false)
  })
})

describe('soloTrascorsi', () => {
  it('tiene solo le righe già avvenute, qualunque sia il nome del campo data', () => {
    const righe = [
      { data: '2026-08-01', stato: 'assente' },
      { data: '2026-08-08', stato: 'assente' },
      { data: '2026-08-20', stato: 'assente' },
    ]
    expect(soloTrascorsi(righe, (r) => r.data, '2026-08-08')).toHaveLength(2)
  })
})

describe('limitaAOggi', () => {
  it('appende `.lte(colonna, oggi)` alla query', () => {
    const visti: { colonna: string; valore: string }[] = []
    const finta = { lte(colonna: string, valore: string) { visti.push({ colonna, valore }); return this } }
    limitaAOggi(finta, 'data')
    expect(visti).toEqual([{ colonna: 'data', valore: oggiFiscaleISO() }])
  })

  it('il nome della colonna è dichiarato dal chiamante (`data` è solo il default)', () => {
    const visti: string[] = []
    const finta = { lte(colonna: string) { visti.push(colonna); return this } }
    limitaAOggi(finta)
    limitaAOggi(finta, 'giorno')
    expect(visti).toEqual(['data', 'giorno'])
  })
})
