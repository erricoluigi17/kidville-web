import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * L'INTESTATARIO DI FAMIGLIA NON SALVATO NON RESTA A SCHERMO COME SALVATO.
 *
 * Fase 11 della roadmap di robustezza («errori non ignorati», 2026-10-19). La scelta si scrive in
 * modo ottimistico e poi parte un PATCH per tutore; ogni PATCH aveva un `.catch(() => {})` e
 * nessuno guardava `res.ok`. Un rifiuto lasciava la tendina sulla scelta nuova — e la fattura
 * successiva sarebbe andata all'intestatario VECCHIO, quello che il database ha davvero.
 *
 * Adesso un PATCH non riuscito si logga e la scelta si RILEGGE dal server: lo schermo torna a
 * dire la verità. Nomi di fantasia: il repository è pubblico.
 */

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>()
  return { ...vero, logClient }
})

import { StudentEconomicSection } from '@/components/features/admin/StudentEconomicSection'

const AL = '11111111-1111-4111-8111-111111111111'
const P1 = '22222222-2222-4222-8222-222222222222'
const P2 = '33333333-3333-4333-8333-333333333333'
const UTENTE = '44444444-4444-4444-8444-444444444444'

const PARENTS = [
  { relation_type: 'mother', parents: { id: P1, first_name: 'Aurora', last_name: 'Verdi' } },
  { relation_type: 'father', parents: { id: P2, first_name: 'Bruno', last_name: 'Verdi' } },
]

const risposta = (stato: number, corpo: unknown) => ({
  ok: stato >= 200 && stato < 300,
  status: stato,
  json: async () => corpo,
})

let letture = 0
const patch = vi.fn()

function montaConPatch(esitoPatch: () => Promise<unknown>) {
  letture = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patch()
      return esitoPatch()
    }
    if (url.startsWith('/api/admin/parents?student_id=')) {
      letture++
      // La verità del server: l'intestatario è P1, prima e dopo il tentativo fallito.
      return Promise.resolve(risposta(200, [
        { id: P1, intestatario_default: true },
        { id: P2, intestatario_default: false },
      ]))
    }
    return Promise.resolve(risposta(200, { success: true, data: [] }))
  }))
  render(
    <StudentEconomicSection
      alunnoId={AL}
      form={{ importo_retta_mensile: 150 }}
      updateForm={() => undefined}
      parents={PARENTS}
    />,
  )
}

/** La tendina dell'intestatario di famiglia: è l'unica il cui valore iniziale è un genitore. */
async function tendinaFamiglia(): Promise<HTMLSelectElement> {
  let trovata: HTMLSelectElement | undefined
  await waitFor(() => {
    trovata = screen.getAllByRole('combobox').find((s) => (s as HTMLSelectElement).value === P1) as HTMLSelectElement | undefined
    expect(trovata).toBeDefined()
  })
  return trovata!
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem('kv_user_id', UTENTE)
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.removeItem('kv_user_id')
})

describe('StudentEconomicSection · intestatario di famiglia', () => {
  it('un PATCH rifiutato (500) si logga e la tendina torna alla scelta del server', async () => {
    montaConPatch(() => Promise.resolve(risposta(500, { error: 'x' })))
    const tendina = await tendinaFamiglia()

    fireEvent.change(tendina, { target: { value: P2 } })

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(letture).toBe(2))
    await waitFor(() => expect(tendina.value).toBe(P1))
    const evento = logClient.mock.calls.map((c) => c[0] as { livello: string; messaggio: string; stato?: number })
      .find((e) => e.messaggio === 'intestatario-famiglia-non-salvato')
    expect(evento).toMatchObject({ livello: 'error', stato: 500 })
  })

  it('la rete giù sul PATCH lascia la riga col solo nome della classe, e rilegge', async () => {
    montaConPatch(() => Promise.reject(new TypeError('Failed to fetch')))
    const tendina = await tendinaFamiglia()

    fireEvent.change(tendina, { target: { value: P2 } })

    await waitFor(() => expect(letture).toBe(2))
    await waitFor(() => expect(tendina.value).toBe(P1))
    const messaggi = logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
    expect(messaggi).toContain('intestatario-famiglia-non-salvato: TypeError')
  })

  it('un salvataggio riuscito NON rilegge: il comportamento di successo resta quello di prima', async () => {
    montaConPatch(() => Promise.resolve(risposta(200, { success: true })))
    const tendina = await tendinaFamiglia()

    fireEvent.change(tendina, { target: { value: P2 } })

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    // Si aspetta che il salvataggio sia finito (la tendina si riabilita), poi si conta.
    await waitFor(() => expect(tendina.disabled).toBe(false))
    expect(tendina.value).toBe(P2)
    expect(letture).toBe(1)
    expect(logClient).not.toHaveBeenCalled()
  })
})
