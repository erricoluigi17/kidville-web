import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MealDetailInline } from '@/components/features/teacher/diary/MealDetailInline'

// =============================================================================
// L'ALERT DEL PRANZO HA DUE GRUPPI, E IL SECONDO ERA SPARITO SENZA CHE NESSUNO
// LO MISURASSE.
//
// Fino al 2026-09-07 questo riquadro mostrava `note_mediche` spezzata sulle
// virgole sotto la parola «Allergie»: etichetta sbagliata, dato giusto. La
// correzione ha portato le allergie dalle allergie — e ha tolto la nota senza
// rimetterla da nessuna parte.
//
// Misurato in produzione il 2026-09-07 (sola lettura, soli conteggi): 657
// iscritti non archiviati, 44 con nota medica, 29 dei quali hanno `allergies`
// vuota o negata. Sono 29 bambini che comparivano in questo riquadro e che, con
// la sola composizione `etichetteAllergie`, non ci comparivano più — e in quella
// casella la segreteria scrive cose come una terapia salvavita.
//
// Quindi due gruppi, come nella card della home docente: «Allergie» (rosso, il
// piatto) e «Note mediche» (ambra, la persona). Nessuno dei due copre l'altro.
//
// Fixture SINTETICHE: nomi inventati, nessun dato reale di minori.
// =============================================================================

const NOTA = 'Epilessia, terapia sintetica di prova in borsa'

const STUDENTI = [
  // 1. Solo allergia: nel gruppo rosso, e in nessun altro.
  { id: 's1', firstName: 'Alfa', lastName: 'Uno', allergie: ['Arachidi'], notaMedica: null },
  // 2. SOLO nota medica: è il bambino che spariva.
  { id: 's2', firstName: 'Beta', lastName: 'Due', allergie: [], notaMedica: NOTA },
  // 3. Niente di niente: non deve comparire in nessuno dei due riquadri.
  { id: 's3', firstName: 'Gamma', lastName: 'Tre', allergie: [], notaMedica: null },
]

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

beforeEach(() => {
  // Il menu del giorno non c'entra con questo test: risponde vuoto.
  vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: true, data: [] })))
})
afterEach(() => { vi.unstubAllGlobals() })

function montaPranzo(studenti = STUDENTI) {
  render(
    <MealDetailInline
      students={studenti}
      studentStates={Object.fromEntries(studenti.map((s) => [s.id, { corsi: {} }]))}
      onMealSelect={vi.fn()}
      date="2026-09-07"
      classId="sez-1"
      savedStudentIds={new Set<string>()}
    />,
  )
}

/** Il riquadro d'avviso che porta questa etichetta, per intero. */
function riquadro(etichetta: string): HTMLElement {
  return screen.getByText(etichetta).closest('div[class*="rounded-2xl"]') as HTMLElement
}

describe('MealDetailInline — allergie e note mediche sono due riquadri distinti', () => {
  it('l\'allergia sta nel riquadro ALLERGIE, con il nome del bambino', () => {
    montaPranzo()
    const r = riquadro('Allergie')
    expect(within(r).getByText(/Alfa: Arachidi/)).toBeInTheDocument()
  })

  it('🔴 IL BAMBINO CON LA SOLA NOTA MEDICA C\'È ANCORA, nel suo riquadro', () => {
    // È la perdita misurata: 29 bambini su 657. Senza questo gruppo, Beta non
    // compare da nessuna parte nella schermata del pranzo.
    montaPranzo()
    const r = riquadro('Note mediche')
    expect(within(r).getByText(new RegExp(`Beta: ${NOTA}`))).toBeInTheDocument()
  })

  it('i due gruppi non si mescolano: la nota non finisce sotto «Allergie»', () => {
    montaPranzo()
    const allergie = riquadro('Allergie')
    expect(within(allergie).queryByText(/Beta/)).toBeNull()
    expect(within(allergie).queryByText(new RegExp(NOTA))).toBeNull()
    const note = riquadro('Note mediche')
    expect(within(note).queryByText(/Arachidi/)).toBeNull()
  })

  it('chi non ha né allergie né nota non compare in nessuno dei due riquadri', () => {
    montaPranzo()
    expect(within(riquadro('Allergie')).queryByText(/Gamma/)).toBeNull()
    expect(within(riquadro('Note mediche')).queryByText(/Gamma/)).toBeNull()
  })

  it('senza note mediche il riquadro non esiste: non un riquadro vuoto', () => {
    montaPranzo([STUDENTI[0], STUDENTI[2]])
    expect(screen.queryByText('Note mediche')).toBeNull()
    expect(screen.getByText('Allergie')).toBeInTheDocument()
  })

  it('senza allergie il riquadro rosso non esiste, e quello delle note sì', () => {
    montaPranzo([STUDENTI[1], STUDENTI[2]])
    expect(screen.queryByText('Allergie')).toBeNull()
    expect(screen.getByText('Note mediche')).toBeInTheDocument()
  })
})
