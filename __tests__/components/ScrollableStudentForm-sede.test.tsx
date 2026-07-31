import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRef } from 'react'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAdminStudents from '../../messages/it/adminStudents.json'
import enAdminStudents from '../../messages/en/adminStudents.json'

/**
 * W3-B — «Nuova anagrafica»: la sede si sceglie, le sezioni la seguono.
 *
 * Il difetto: `scuolaSelezionata = formData.scuola_id || sedeCorrente || sedi[0].id`.
 * Con tre plessi e nessuna sede scelta nel selettore, l'ultimo ripiego indovinava
 * la PRIMA sede accessibile in ordine di elenco — e il form la mandava al server
 * come se l'operatore l'avesse dichiarata. `resolveScuolaScrittura` non poteva
 * accorgersene: riceveva una `preferita` valida. Il bambino nasceva nel plesso
 * sbagliato, in silenzio, e nessun 400 lo fermava.
 *
 * Il secondo difetto vive nella tendina accanto: le sezioni erano caricate UNA
 * VOLTA da `/api/admin/sections` (tutte le sedi attive), senza `scuola_id` e
 * senza ricaricarsi al cambio sede. Con i nomi che si ripetono fra plessi
 * («3 ANNI» esiste ovunque) la segreteria sceglieva una «3 ANNI» che nella sede
 * dell'alunno non esisteva: il trigger `sync_alunno_section_id` non la trovava e
 * lasciava `section_id` NULL — bambino invisibile a registro, appello e mensa.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@/lib/utils/fiscalCodeApi', () => ({ fetchFiscalCode: vi.fn(async () => '') }))

// Stato del contesto sedi, riscrivibile per test (il mock legge la variabile).
let sediAttive: {
  sedi: { id: string; nome: string }[]
  effettive?: string[]
  sedeCorrente: string | null
} = { sedi: [], sedeCorrente: null }

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => {
    const effettive = sediAttive.effettive ?? sediAttive.sedi.map((s) => s.id)
    return {
      sedi: sediAttive.sedi,
      selezionate: [],
      effettive,
      sedeCorrente: sediAttive.sedeCorrente,
      reFetchKey: effettive.join(','),
      epocaSede: 0,
      loading: false,
      toggle: vi.fn(),
      soloSede: vi.fn(),
      tutte: vi.fn(),
    }
  },
}))

const SEZIONI: Record<string, { id: string; name: string; school_type: string; scuola_id: string }[]> = {
  [SEDE_A]: [{ id: 'sez-a1', name: '3 ANNI', school_type: 'infanzia', scuola_id: SEDE_A }],
  [SEDE_B]: [
    { id: 'sez-b1', name: '3 ANNI', school_type: 'infanzia', scuola_id: SEDE_B },
    { id: 'sez-b2', name: 'PRIMAVERA', school_type: 'nido', scuola_id: SEDE_B },
  ],
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  sediAttive = {
    sedi: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ],
    sedeCorrente: null,
  }
  fetchMock.mockImplementation((url: string) => {
    const sede = new URL(String(url), 'http://t.test').searchParams.get('scuola_id')
    return Promise.resolve({
      ok: true,
      // Senza `scuola_id` il vero server risponde con TUTTE le sedi attive: è
      // esattamente lo scenario che il fix deve rendere impossibile da chiedere.
      json: async () => (sede ? (SEZIONI[sede] ?? []) : Object.values(SEZIONI).flat()),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { ScrollableStudentForm, type StudentFormHandle } from '@/components/features/admin/ScrollableStudentForm'

/** Compila i campi minimi che lo schema zod richiede (tutti tranne la sede). */
function compilaAnagrafica() {
  fireEvent.change(document.querySelector('input[name="nome"]')!, { target: { name: 'nome', value: 'Ada' } })
  fireEvent.change(document.querySelector('input[name="cognome"]')!, { target: { name: 'cognome', value: 'Verdi' } })
  fireEvent.change(document.querySelector('input[name="data_nascita"]')!, { target: { value: '01/01/2022' } })
  fireEvent.change(document.querySelector('input[name="comune_nascita"]')!, { target: { name: 'comune_nascita', value: 'Napoli' } })
  fireEvent.change(document.querySelector('input[name="provincia_nascita"]')!, { target: { name: 'provincia_nascita', value: 'NA' } })
}

const selectSede = () => document.querySelector('select[name="scuola_id"]') as HTMLSelectElement
const selectSezione = () => document.querySelector('select[name="classe_sezione"]') as HTMLSelectElement
const opzioniSezione = () => Array.from(selectSezione().options).map((o) => o.textContent)
const urlChiamate = () => fetchMock.mock.calls.map((c) => String(c[0]))

describe('ScrollableStudentForm — la sede si dichiara, non si indovina', () => {
  it('con due sedi accessibili e nessuna scelta, il campo Sede parte VUOTO', () => {
    render(<ScrollableStudentForm />)
    expect(selectSede().value).toBe('')
  })

  it('senza sede scelta il salvataggio è BLOCCATO e nessun payload esce dal form', () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    compilaAnagrafica()

    let esito: ReturnType<StudentFormHandle['validate']> | undefined
    act(() => {
      esito = ref.current!.validate()
    })

    expect(esito).toEqual({ ok: false })
    expect(screen.getByText(itAdminStudents.valSedeObbligatoria)).toBeInTheDocument()
  })

  it('finché la sede non è scelta NON si chiedono sezioni (una tendina di sezioni senza sede è una trappola)', () => {
    render(<ScrollableStudentForm />)
    expect(urlChiamate().filter((u) => u.includes('/api/admin/sections'))).toHaveLength(0)
    // Nessuna opzione oltre al segnaposto.
    expect(opzioniSezione()).toHaveLength(1)
  })

  it('scelta la sede, le sezioni si chiedono PER QUELLA SEDE e la tendina mostra solo le sue', async () => {
    render(<ScrollableStudentForm />)
    fireEvent.change(selectSede(), { target: { name: 'scuola_id', value: SEDE_B } })

    await waitFor(() => expect(opzioniSezione()).toContain('PRIMAVERA (nido)'))
    expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_B}`)
    expect(opzioniSezione()).toHaveLength(3) // segnaposto + 2 sezioni di SEDE_B
  })

  it('cambiando sede la tendina si RICARICA: le sezioni della sede di prima spariscono subito', async () => {
    render(<ScrollableStudentForm />)
    fireEvent.change(selectSede(), { target: { name: 'scuola_id', value: SEDE_B } })
    await waitFor(() => expect(opzioniSezione()).toContain('PRIMAVERA (nido)'))
    fireEvent.change(selectSezione(), { target: { name: 'classe_sezione', value: 'PRIMAVERA' } })

    fireEvent.change(selectSede(), { target: { name: 'scuola_id', value: SEDE_A } })
    // Nemmeno per un istante la sezione dell'altra sede resta selezionabile.
    expect(opzioniSezione()).not.toContain('PRIMAVERA (nido)')
    expect(selectSezione().value).toBe('')

    await waitFor(() => expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_A}`))
    await waitFor(() => expect(opzioniSezione()).toHaveLength(2)) // segnaposto + «3 ANNI» di SEDE_A
  })

  it('con UNA sola sede accessibile non c\'è ambiguità: preselezionata e salvataggio libero', async () => {
    sediAttive = { sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }], sedeCorrente: SEDE_A }
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    expect(selectSede().value).toBe(SEDE_A)
    await waitFor(() => expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_A}`))

    compilaAnagrafica()
    let esito: ReturnType<StudentFormHandle['validate']> | undefined
    act(() => {
      esito = ref.current!.validate()
    })
    expect(esito?.ok).toBe(true)
    expect(esito && esito.ok && esito.data.scuola_id).toBe(SEDE_A)
  })

  it('la sede scelta a mano arriva nel payload insieme alla sezione di QUELLA sede', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    fireEvent.change(selectSede(), { target: { name: 'scuola_id', value: SEDE_B } })
    await waitFor(() => expect(opzioniSezione()).toContain('PRIMAVERA (nido)'))
    fireEvent.change(selectSezione(), { target: { name: 'classe_sezione', value: 'PRIMAVERA' } })
    compilaAnagrafica()

    let esito: ReturnType<StudentFormHandle['validate']> | undefined
    act(() => {
      esito = ref.current!.validate()
    })
    expect(esito?.ok).toBe(true)
    expect(esito && esito.ok && esito.data).toMatchObject({ scuola_id: SEDE_B, classe_sezione: 'PRIMAVERA' })
  })

  it('la sede attiva scelta nel selettore vale come dichiarazione (non è un ripiego)', async () => {
    sediAttive = {
      sedi: [
        { id: SEDE_A, nome: NOME_SEDE_A },
        { id: SEDE_B, nome: NOME_SEDE_B },
      ],
      sedeCorrente: SEDE_B,
    }
    render(<ScrollableStudentForm />)
    expect(selectSede().value).toBe(SEDE_B)
    await waitFor(() => expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_B}`))
  })

  // `GET /api/admin/sections?scuola_id=X` interseca SEMPRE con le sedi ATTIVE
  // (`resolveScuoleAttive`): chiedere le sezioni di una sede accessibile ma
  // deselezionata torna un elenco VUOTO. Offrirla nella tendina significherebbe
  // promettere una scelta che poi non ha classi — e salvare il bambino senza
  // sezione. Si offre solo ciò su cui il cockpit sta davvero operando.
  it('la tendina Sede offre solo le sedi ATTIVE, non tutte le accessibili', async () => {
    sediAttive = {
      sedi: [
        { id: SEDE_A, nome: NOME_SEDE_A },
        { id: SEDE_B, nome: NOME_SEDE_B },
      ],
      effettive: [SEDE_B],
      sedeCorrente: SEDE_B,
    }
    render(<ScrollableStudentForm />)
    const valori = Array.from(selectSede().options).map((o) => o.value)
    expect(valori).toEqual([SEDE_B])
    await waitFor(() => expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_B}`))
  })

  it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
    for (const k of ['valSedeObbligatoria', 'sFormSelezionaSede', 'sFormSezioneScegliSede']) {
      expect(itAdminStudents).toHaveProperty(k)
      expect(enAdminStudents).toHaveProperty(k)
    }
  })
})
