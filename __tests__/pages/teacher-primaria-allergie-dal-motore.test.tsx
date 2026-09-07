import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// =============================================================================
// LA QUINTA SUPERFICIE OPERATIVA, RIMASTA SULLA REGOLA VECCHIA.
//
// /teacher/primaria/<sectionId> accende un badge rosso e colora di rosso il nome
// del bambino a partire da:
//     (a.allergeni?.length ? a.allergeni.join(', ') : (a.allergies || null))
// cioè esattamente il difetto già corretto in `mensa/report` — una fonte VINCE
// sull'altra invece di sommarsi — più due che il motore risolve da solo:
//  · stampa le CHIAVI GREZZE senza etichetta («latte» invece di «Latte /
//    lattosio»);
//  · non toglie la NEGAZIONE, quindi accende un badge rosso che dice «NESSUNA».
//
// Misurato in produzione il 2026-09-07 (sola lettura, soli conteggi): 11 sezioni
// di primaria, 132 bambini, 15 con un testo in `allergies` di cui **1 è una
// negazione** ⇒ oggi un bambino di primaria ha un badge rosso che dice
// «NESSUNA». E 0 hanno allergeni strutturati: il giorno in cui la segreteria
// spunta la prima casella, quel bambino perde il testo libero.
//
// Fixture SINTETICHE: nomi inventati, nessun dato reale di minori.
// =============================================================================

const stub = vi.hoisted(() => ({
  params: { sectionId: 'sez-1' } as Record<string, string>,
  search: new URLSearchParams(),
  alunni: [] as Record<string, unknown>[],
}))

vi.mock('next/navigation', () => ({
  useParams: () => stub.params,
  useSearchParams: () => stub.search,
  usePathname: () => '/teacher/primaria/sez-1',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => 'd-1' }))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  stub.alunni = [
    // 1. Chiave strutturata E testo libero: si SOMMANO. Col vecchio criterio
    //    «fragole» spariva, perché l'array vinceva sul testo.
    { id: 'a1', nome: 'Alfa', cognome: 'Uno', allergeni: ['latte'], allergies: 'fragole' },
    // 2. Negazione: non è un'allergia, e un badge rosso che dice «NESSUNA» è
    //    peggio di nessun badge.
    { id: 'a2', nome: 'Beta', cognome: 'Due', allergeni: [], allergies: 'Nessuna' },
    // 3. Nessuna registrazione: nessun badge.
    { id: 'a3', nome: 'Gamma', cognome: 'Tre', allergeni: [], allergies: null },
  ]
  fetchMock.mockImplementation(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/api/primaria/classe/')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { alunni: stub.alunni, materie: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

import ClasseOverviewPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/page'

/** La riga dell'alunno, dal nome che ci si legge accanto. */
async function riga(nomeVisualizzato: string): Promise<HTMLElement> {
  const nome = await screen.findByText(nomeVisualizzato)
  return nome.closest('div[class*="rounded-2xl"]') as HTMLElement
}

describe('/teacher/primaria/[sectionId] — le allergie passano dal motore', () => {
  it('🔴 «NESSUNA» NON ACCENDE PIÙ UN BADGE ROSSO', async () => {
    // È il caso vero in produzione: un bambino di primaria oggi ha un badge
    // rosso, e la parola che ci si legge dentro è una negazione.
    render(<ClasseOverviewPage />)
    const r = await riga('Due Beta')
    expect(r.textContent).not.toMatch(/nessuna/i)
  })

  it('il nome di chi non ha allergie non è colorato di rosso', async () => {
    render(<ClasseOverviewPage />)
    const r = await riga('Due Beta')
    expect(r.querySelector('.text-kidville-error')).toBeNull()
    const g = await riga('Tre Gamma')
    expect(g.querySelector('.text-kidville-error')).toBeNull()
  })

  it('🔴 LE DUE FONTI SI SOMMANO: la chiave non copre il testo libero', async () => {
    // Col criterio vecchio l'array vinceva e «fragole» — che fra i 14 UE non c'è
    // — spariva dalla schermata di chi sta in classe con quel bambino.
    render(<ClasseOverviewPage />)
    const r = await riga('Uno Alfa')
    expect(r.textContent).toContain('fragole')
  })

  it('la chiave si legge con la sua ETICHETTA, non grezza', async () => {
    render(<ClasseOverviewPage />)
    const r = await riga('Uno Alfa')
    // `useAllergeneLabel` traduce; il mock di next-intl risolve sui cataloghi
    // italiani veri, quindi qui esce l'etichetta e non la chiave `latte`.
    expect(r.textContent).toMatch(/Latte/)
  })

  it("chi ha un'allergia vera resta in rosso: il badge non è stato spento", async () => {
    render(<ClasseOverviewPage />)
    const r = await riga('Uno Alfa')
    expect(r.querySelector('.text-kidville-error')).not.toBeNull()
  })
})
