import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

/**
 * LA CARD DEL MODULO «Lavora con noi» dentro «Moduli inviabili».
 *
 * Due cose sole, ed entrambe sono state pagate altrove in questo repo:
 *
 *  1. NIENTE «Modifica» e niente «Reimposta», e la descrizione DICE perché.
 *     Questo modulo non passa dal costruttore: i suoi campi finiscono in colonne
 *     tipizzate di `candidature_insegnanti` e le fasce in un enum del database.
 *     Senza scriverlo, qualcuno lo cerca nel builder, non lo trova e conclude
 *     che manchi — e la segreteria intanto non condivide nessun link.
 *
 *  2. IL LINK È UNO SOLO. Con tre plessi, la tentazione è inventarne tre: è
 *     esattamente ciò che `inviabiliStandardSediNota` esiste per impedire sul
 *     modulo d'iscrizione, e vale identico qui — la sede la sceglie chi si
 *     candida, dentro il modulo.
 */

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [], selezionate: [], effettive: [], sedeCorrente: null,
    reFetchKey: '', epocaSede: 0, loading: false,
    toggle: vi.fn(), soloSede: vi.fn(), tutte: vi.fn(),
  }),
}))

const scrivi = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => [] })))
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: scrivi },
    configurable: true,
  })
})

import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili'

describe('ModuliInviabili — card delle candidature insegnanti', () => {
  it('la card c’è, e copia il link pubblico `/lavora-con-noi`', async () => {
    render(<ModuliInviabili />)
    await waitFor(() => expect(screen.getByText('Candidature insegnanti')).toBeInTheDocument())

    // Il pulsante si prende DENTRO la sua card, non per posizione nell'elenco.
    //
    // ⚠️ Prima questa riga contava i «Copia link» a schermo e cliccava il SECONDO: una
    // premessa sul numero di card, non sulla card. Il 12/08/2026 ne è nata una terza
    // (l'anagrafica del personale) e il test è diventato rosso senza che il
    // comportamento sorvegliato — «questa card copia `/lavora-con-noi`» — fosse
    // cambiato di un carattere. Un controllo che si rompe quando qualcosa di
    // ADIACENTE cambia non sta misurando ciò che dichiara.
    const card = screen.getByText('Candidature insegnanti').closest('div.rounded-card') as HTMLElement
    fireEvent.click(within(card).getByText('Copia link'))

    await waitFor(() => expect(scrivi).toHaveBeenCalledWith(`${window.location.origin}/lavora-con-noi`))
  })

  it('nessun «Modifica» e nessun «Reimposta» sulla card, e la descrizione spiega perché', async () => {
    render(<ModuliInviabili />)
    await waitFor(() => expect(screen.getByText('Candidature insegnanti')).toBeInTheDocument())

    // Il modulo d'iscrizione standard ha ancora i suoi due comandi: se sparissero
    // questo controllo diventerebbe verde per il motivo sbagliato.
    expect(screen.getAllByText('Modifica').length).toBeGreaterThan(0)
    expect(screen.getByText('Reimposta')).toBeInTheDocument()

    const card = screen.getByText('Candidature insegnanti').closest('div.rounded-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.textContent).not.toMatch(/Modifica/)
    expect(card.textContent).not.toMatch(/Reimposta/)
    expect(card.textContent).toMatch(/costruttore di moduli/i)
    expect(card.textContent).toMatch(/colonne tipizzate/i)
  })

  it('dice che il link è UNO per tutte le sedi e che la sede la sceglie chi si candida', async () => {
    render(<ModuliInviabili />)
    const nota = await screen.findByText(/Link unico per tutte le sedi: è chi si candida/)
    expect(nota).toBeInTheDocument()
  })

  it('le tre chiavi nuove esistono in entrambi i cataloghi', () => {
    for (const k of ['inviabiliCandidatureTitolo', 'inviabiliCandidatureDesc', 'inviabiliCandidatureSediNota']) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
  })
})
