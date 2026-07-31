import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAdminStudents from '../../messages/it/adminStudents.json'
import enAdminStudents from '../../messages/en/adminStudents.json'

/**
 * W3-B — La griglia delle sezioni con TRE plessi.
 *
 * Difetto 1 (conteggio): `countStudents` contava
 * `s.section_id === section.id || s.classe_sezione === section.name`. Il secondo
 * ramo non guarda la sede: dal 2026-07-29 «3 ANNI» esiste a Giugliano, ad Aversa
 * e a Cesa, quindi la card di ogni «3 ANNI» mostrava la SOMMA dei bambini di
 * tutte e tre. Un numero sbagliato su una card non fa rumore: si legge, ci si
 * fida, e si programmano turni mensa e uscite su un organico che non esiste.
 *
 * Difetto 2 (creazione): la sede della nuova sezione era preselezionata sul primo
 * gruppo dell'elenco (`groups[0].scuolaId`). Bastava non guardare la tendina per
 * creare la classe nel plesso sbagliato.
 *
 * Difetto 3 (esito muto): `if (res.ok) {...}` senza `else`. Dal 2026-07-31 il
 * server risponde 409 sul nome già usato nella sede: senza ramo d'errore il
 * modulo restava lì, identico, e l'operatore ricliccava.
 *
 * Il mock di next-intl è LOCALE (non quello globale di test/setup.ts) perché qui
 * il numero interpolato in `{n} alunni` È l'asserzione.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

vi.mock('next-intl', async () => {
  const it = (await import('../../messages/it/adminStudents.json')).default as Record<string, string>
  const interpola = (testo: string, valori?: Record<string, unknown>) =>
    testo.replace(/\{(\w+)\}/g, (intero, chiave) => (valori && chiave in valori ? String(valori[chiave]) : intero))
  const useTranslations = () => {
    const t = (key: string, valori?: Record<string, unknown>) => interpola(it[key] ?? key, valori)
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return { useTranslations, useLocale: () => 'it', NextIntlClientProvider: ({ children }: { children: unknown }) => children }
})

// Due plessi, ciascuno con la propria «3 ANNI»: nomi identici, sedi diverse.
const SCOPED = {
  success: true,
  data: [
    { scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, sezioni: [{ id: 'sez-a1', name: '3 ANNI', school_type: 'infanzia' }] },
    { scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B, sezioni: [{ id: 'sez-b1', name: '3 ANNI', school_type: 'infanzia' }] },
  ],
}

// SEDE_A: 1 bambino (con section_id). SEDE_B: 2 bambini, uno dei quali senza
// section_id (il trigger non l'ha ancora risolto) — deve contare comunque, ma
// SOLO nella sua sede.
const ALUNNI: Record<string, unknown[]> = {
  [SEDE_A]: [
    { id: 'al-a1', nome: 'Ada', cognome: 'Rossi', scuola_id: SEDE_A, section_id: 'sez-a1', classe_sezione: '3 ANNI' },
  ],
  [SEDE_B]: [
    { id: 'al-b1', nome: 'Bea', cognome: 'Bianchi', scuola_id: SEDE_B, section_id: 'sez-b1', classe_sezione: '3 ANNI' },
    { id: 'al-b2', nome: 'Bruno', cognome: 'Neri', scuola_id: SEDE_B, section_id: null, classe_sezione: '3 ANNI' },
  ],
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname.includes('/api/admin/sections/scoped')) {
      return Promise.resolve({ ok: true, json: async () => SCOPED })
    }
    if (u.pathname.includes('/api/admin/students')) {
      const sede = u.searchParams.get('scuola_id') ?? ''
      return Promise.resolve({ ok: true, json: async () => ALUNNI[sede] ?? [] })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { SectionsView } from '@/components/features/admin/SectionsView'

/** Testo della card della sezione della sede indicata (le card sono link per id). */
const card = (sezioneId: string) =>
  document.querySelector(`a[href="/admin/students/sezioni/${sezioneId}"]`) as HTMLElement

describe('SectionsView — sezioni omonime in sedi diverse', () => {
  it('il conteggio NON somma le omonime: ogni card conta i bambini della SUA sede', async () => {
    render(<SectionsView />)
    await waitFor(() => expect(card('sez-a1')).toBeTruthy())

    expect(within(card('sez-a1')).getByText('1 alunni')).toBeInTheDocument()
    expect(within(card('sez-b1')).getByText('2 alunni')).toBeInTheDocument()
  })

  it('con UNA sola sede accessibile non c\'è ambiguità: la sede è quella, e si crea', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname.includes('/api/admin/sections/scoped')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [SCOPED.data[0]] }) })
      }
      if (u.pathname.includes('/api/admin/students')) {
        return Promise.resolve({ ok: true, json: async () => ALUNNI[u.searchParams.get('scuola_id') ?? ''] ?? [] })
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'nuova' }) })
    })

    render(<SectionsView />)
    await waitFor(() => expect(card('sez-a1')).toBeTruthy())
    fireEvent.click(screen.getByText(itAdminStudents.secNuova))
    // Mono-sede: nessuna tendina da compilare.
    expect(document.querySelector('select[name="nuova-sezione-sede"]')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(itAdminStudents.secNomePlaceholder), { target: { value: '4 ANNI' } })
    fireEvent.click(screen.getByText(itAdminStudents.secCrea).closest('button')!)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1] && (c[1] as { method?: string }).method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse((post![1] as { body: string }).body)).toMatchObject({ name: '4 ANNI', scuola_id: SEDE_A })
    })
  })

  it('la sede della nuova sezione NON è preselezionata quando i plessi sono più d\'uno', async () => {
    render(<SectionsView />)
    await waitFor(() => expect(card('sez-a1')).toBeTruthy())
    fireEvent.click(screen.getByText(itAdminStudents.secNuova))

    const tendinaSede = document.querySelector('select[name="nuova-sezione-sede"]') as HTMLSelectElement
    expect(tendinaSede).toBeTruthy()
    expect(tendinaSede.value).toBe('')

    // E senza sede il pulsante «Crea» non parte, nemmeno col nome compilato.
    fireEvent.change(screen.getByPlaceholderText(itAdminStudents.secNomePlaceholder), { target: { value: '4 ANNI' } })
    const bottone = screen.getByText(itAdminStudents.secCrea).closest('button')!
    expect(bottone).toBeDisabled()
    fireEvent.click(bottone)
    expect(fetchMock.mock.calls.filter((c) => c[1] && (c[1] as { method?: string }).method === 'POST')).toHaveLength(0)
  })

  it('scelta la sede, la creazione parte con QUELLA sede nel corpo', async () => {
    render(<SectionsView />)
    await waitFor(() => expect(card('sez-a1')).toBeTruthy())
    fireEvent.click(screen.getByText(itAdminStudents.secNuova))

    fireEvent.change(document.querySelector('select[name="nuova-sezione-sede"]')!, { target: { value: SEDE_B } })
    fireEvent.change(screen.getByPlaceholderText(itAdminStudents.secNomePlaceholder), { target: { value: '4 ANNI' } })
    fireEvent.click(screen.getByText(itAdminStudents.secCrea).closest('button')!)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1] && (c[1] as { method?: string }).method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse((post![1] as { body: string }).body)).toMatchObject({ name: '4 ANNI', scuola_id: SEDE_B })
    })
  })

  it('nome già usato nella sede (409): l\'errore del server è VISIBILE, il modulo resta aperto', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'Esiste già una classe con questo nome in questa sede' }) })
      }
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname.includes('/api/admin/sections/scoped')) return Promise.resolve({ ok: true, json: async () => SCOPED })
      return Promise.resolve({ ok: true, json: async () => ALUNNI[u.searchParams.get('scuola_id') ?? ''] ?? [] })
    })

    render(<SectionsView />)
    await waitFor(() => expect(card('sez-a1')).toBeTruthy())
    fireEvent.click(screen.getByText(itAdminStudents.secNuova))
    fireEvent.change(document.querySelector('select[name="nuova-sezione-sede"]')!, { target: { value: SEDE_B } })
    fireEvent.change(screen.getByPlaceholderText(itAdminStudents.secNomePlaceholder), { target: { value: '3 ANNI' } })
    fireEvent.click(screen.getByText(itAdminStudents.secCrea).closest('button')!)

    await waitFor(() =>
      expect(screen.getByText(/Esiste già una classe con questo nome in questa sede/)).toBeInTheDocument(),
    )
    // Il nome digitato non è stato buttato via e il modulo è ancora lì.
    expect((screen.getByPlaceholderText(itAdminStudents.secNomePlaceholder) as HTMLInputElement).value).toBe('3 ANNI')
  })

  it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
    for (const k of ['secSelezionaSede', 'secErrCreazione']) {
      expect(itAdminStudents).toHaveProperty(k)
      expect(enAdminStudents).toHaveProperty(k)
    }
  })
})
