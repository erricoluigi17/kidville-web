import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

/**
 * F5 · seconda metà — «non tacere il residuo».
 *
 * Dal 2026-07-31 l'evasione di una richiesta di cancellazione anonimizza SOLO i
 * figli dei plessi accessibili a chi la evade. È la correzione giusta — prima si
 * anonimizzava irreversibilmente il minore di un'altra sede — ma da sola sposta
 * il problema: la richiesta si chiude comunque (`stato = 'evasa'`, e l'indice
 * unico parziale non ne ammette una seconda «pending»), quindi il pezzo di oblio
 * rimasto in un altro plesso sparirebbe dal mondo se nessuno lo dicesse.
 *
 * La route lo dichiara (`alunni_fuori_scope`) e lascia una riga persistita. Qui
 * si verifica l'ultimo anello: che la Direzione lo LEGGA, nel riquadro dove sta
 * per digitare ANONIMIZZA — non in un campo JSON che non guarda nessuno.
 */

const fetchMock = vi.fn()

interface Conteggi {
  alunni_non_iscritti: number
  alunni_iscritti: number
  alunni_fuori_scope: number
}

function montaCon(c: Conteggi) {
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          dryrun: true,
          parent: 1,
          alunni_non_iscritti: c.alunni_non_iscritti,
          alunni_iscritti_mantenuti: c.alunni_iscritti,
          alunni_fuori_scope: c.alunni_fuori_scope,
        }),
      })
    }
    return Promise.resolve({
      ok: true,
      json: async () => [
        {
          id: 'req-1',
          creata_il: '2026-07-31T08:00:00Z',
          parent_nome: 'Genitore Prova',
          alunni_iscritti: c.alunni_iscritti,
          alunni_non_iscritti: c.alunni_non_iscritti,
          alunni_fuori_scope: c.alunni_fuori_scope,
        },
      ],
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

async function apriRichiesta() {
  const { RichiesteCancellazionePanel } = await import(
    '@/components/features/admin/settings/RichiesteCancellazionePanel'
  )
  render(<RichiesteCancellazionePanel userId="dir-1" />)
  const riga = await screen.findByText('Genitore Prova')
  fireEvent.click(riga)
}

describe('RichiesteCancellazionePanel — figli in un altro plesso (F5)', () => {
  it('il riquadro di conferma dichiara i figli che questa Direzione NON toccherà', async () => {
    montaCon({ alunni_non_iscritti: 1, alunni_iscritti: 0, alunni_fuori_scope: 2 })
    await apriRichiesta()
    // Il mock next-intl di `test/setup.ts` risolve la chiave sul catalogo IT ma
    // NON interpola i valori: il conteggio arriva come segnaposto `{n}`. Che il
    // numero ci sia è verificato sul catalogo, più sotto.
    await waitFor(() => {
      expect(screen.getByText(/altro plesso/i)).toBeInTheDocument()
    })
  })

  it('nessun residuo → nessun avviso (non si spaventa chi non deve)', async () => {
    montaCon({ alunni_non_iscritti: 1, alunni_iscritti: 0, alunni_fuori_scope: 0 })
    await apriRichiesta()
    await waitFor(() => {
      expect(screen.getByText(/Figli non iscritti anonimizzati/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/altro plesso/i)).toBeNull()
  })
})

describe('i18n — la voce esiste in entrambe le lingue', () => {
  it('la chiave è presente in IT e in EN', () => {
    expect(itAdminAltro).toHaveProperty('richiesteFigliFuoriScope')
    expect(enAdminAltro).toHaveProperty('richiesteFigliFuoriScope')
  })

  it('il testo italiano nomina il plesso e riporta il conteggio', () => {
    const testo = (itAdminAltro as Record<string, string>).richiesteFigliFuoriScope ?? ''
    expect(testo.toLowerCase()).toContain('plesso')
    expect(testo).toContain('{n}')
  })
})
