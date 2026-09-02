import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

/**
 * Il link che la segreteria copia e manda ai genitori è `/iscrizione`, senza
 * parametro: con tre plessi è ESATTAMENTE il link che si romperebbe se il wizard
 * non chiedesse la sede. Accanto al bottone deve esserci scritto che il link è
 * unico e che la sede la sceglie il genitore — altrimenti la segreteria comincia
 * a inventarsi tre link diversi.
 */

/**
 * Il contesto delle sedi serve al pannello dal 2026-09-01: la barra filtri dei modelli del
 * costruttore mostra il NOME del plesso accanto a `scuola_id`, e un uuid in una tendina non
 * si legge. Qui è un finto minimo — quello che questo file misura è la nota accanto a «Copia
 * link», non la barra — e l'elenco è vuoto di proposito: senza sedi il campo si nasconde da
 * sé, quindi il finto non può cambiare l'esito di ciò che il file dichiara di provare.
 */
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [],
    selezionate: [],
    effettive: [],
    sedeCorrente: null,
    reFetchKey: '',
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href }: { children?: React.ReactNode; href: string }) =>
      React.createElement('a', { href }, children),
  }
})

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] }))
  vi.stubGlobal('fetch', fetchMock)
})

import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili'

const NOTA_IT = 'Link unico per tutte le sedi: è il genitore a scegliere il plesso nel primo passo del modulo.'

describe('ModuliInviabili — nota sul link unico', () => {
  it('mostra la nota accanto al bottone «Copia link»', async () => {
    render(<ModuliInviabili />)
    await waitFor(() => expect(screen.getByText(NOTA_IT)).toBeInTheDocument())
    // Nessun testo cablato: la stringa arriva dal catalogo (il mock di next-intl
    // risolve sui messaggi IT reali; una chiave mancante uscirebbe come
    // "adminAltro.inviabiliStandardSediNota").
    expect(screen.queryByText(/^adminAltro\./)).not.toBeInTheDocument()
  })

  it('la chiave esiste in ENTRAMBI i cataloghi', () => {
    expect(itAdminAltro).toHaveProperty('inviabiliStandardSediNota')
    expect(enAdminAltro).toHaveProperty('inviabiliStandardSediNota')
  })

  it('adminAltro: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
  })
})
