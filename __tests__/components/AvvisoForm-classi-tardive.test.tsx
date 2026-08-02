import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// =============================================================================
// `AvvisoForm` — le classi che arrivano DOPO l'apertura del modulo.
//
// IL DIFETTO, misurato in CI il 2026-08-02 (e2e/isolamento-sedi.spec.ts). Una
// maestra apre «Nuovo avviso», scrive titolo e contenuto, e il bottone
// «Pubblica Avviso» resta SPENTO. Non c'è nessun messaggio: il bottone è
// `aria-disabled` e basta. Nel dump dell'albero il gruppo «Le tue classi»
// conteneva il bottone «Girasoli» NON premuto — cioè nessuna classe
// destinataria, e senza destinatari il modulo non è inviabile.
//
// La causa non è nel form ma nel TEMPO. Le classi della docente arrivano da una
// `fetch` (`/api/educator-sections`); la preselezione vive in un blocco
// «adjust state during render» che scatta quando `open` passa a `true`, e legge
// `availableClasses` IN QUELL'ISTANTE. Se il modulo si apre prima che la
// risposta arrivi — cioè se la maestra è veloce, o la rete è lenta — la
// preselezione lavora su un elenco vuoto e non viene più ricalcolata quando le
// classi arrivano. Il modulo resta bloccato finché non lo si chiude e riapre, e
// nessuno dice perché.
//
// In CI si vedeva solo in `isolamento-sedi`, dove il test apre il modulo subito
// dopo il login; in `teacher-avvisi` l'attesa di un avviso in lista dava alla
// fetch il tempo di arrivare, e il difetto restava invisibile. È la differenza
// fra un test che aspetta e uno che non aspetta — non fra due codici diversi.
//
// METODO. Il controllo positivo viene per primo: con le classi presenti FIN
// DALL'INIZIO il bottone deve essere attivo. Senza, un test che verifica «si
// attiva quando le classi arrivano» passerebbe anche su un modulo che si attiva
// sempre, per qualunque ragione.
// =============================================================================

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
  useLocale: () => 'it',
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn() }))

import { AvvisoForm } from '@/components/features/avvisi/AvvisoForm'

const GIRASOLI = { id: 'sec-girasoli', nome: 'Girasoli', scuolaId: 'scuola-1', scuolaNome: 'Sede 1' }

/** Il bottone d'invio non usa `disabled`: la verità sta in `aria-disabled`. */
function bottoneInvio(): HTMLElement {
  const bottoni = screen.getAllByRole('button')
  const b = bottoni.find((x) => (x.className || '').includes('rounded-2xl') && x.getAttribute('aria-disabled') !== null)
  if (!b) throw new Error('bottone d\'invio non trovato')
  return b
}

function compila() {
  const campi = screen.getAllByRole('textbox')
  fireEvent.change(campi[0], { target: { value: 'Titolo di prova' } })
  fireEvent.change(campi[1], { target: { value: 'Contenuto di prova' } })
}

/** Il modulo aperto SUBITO, con le classi che arrivano solo dopo un click. */
function Ospite({ classiSubito }: { classiSubito: boolean }) {
  const [classi, setClassi] = useState(classiSubito ? [GIRASOLI] : [])
  return (
    <>
      <button type="button" onClick={() => setClassi([GIRASOLI])}>
        arriva la risposta
      </button>
      <AvvisoForm
        open
        onClose={() => {}}
        onSubmit={async () => ({ ok: true })}
        availableClasses={classi}
        soloClassiProprie
      />
    </>
  )
}

describe('AvvisoForm — le classi che arrivano dopo l\'apertura', () => {
  it('CONTROLLO POSITIVO: con le classi già presenti, compilato il modulo si può pubblicare', () => {
    render(<Ospite classiSubito />)
    compila()
    expect(
      bottoneInvio().getAttribute('aria-disabled'),
      'con la classe preselezionata e i campi pieni il modulo deve essere inviabile: ' +
        'se fosse spento anche qui, il test sotto non proverebbe niente',
    ).toBe('false')
  })

  it('se le classi arrivano DOPO, il modulo si sblocca da sé', () => {
    render(<Ospite classiSubito={false} />)
    compila()

    // Prima che la risposta arrivi il modulo è giustamente bloccato: non c'è
    // ancora nessuna classe destinataria da mettere sull'avviso.
    expect(bottoneInvio().getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(screen.getByText('arriva la risposta'))

    expect(
      bottoneInvio().getAttribute('aria-disabled'),
      'arrivate le classi, la preselezione va rifatta: altrimenti la maestra resta ' +
        'con il bottone spento e nessuna spiegazione, finché non chiude e riapre',
    ).toBe('false')
  })

  it('se la maestra ha già scelto lei, l\'arrivo delle classi NON le sovrascrive la scelta', () => {
    // Il rimedio non deve diventare un secondo difetto: chi toglie di proposito
    // una classe non se la deve ritrovare rimessa dalla risposta di una fetch.
    render(<Ospite classiSubito />)
    compila()
    const girasoli = screen.getByRole('button', { name: 'Girasoli' })
    fireEvent.click(girasoli) // la toglie

    expect(bottoneInvio().getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(screen.getByText('arriva la risposta'))

    expect(
      bottoneInvio().getAttribute('aria-disabled'),
      'la scelta esplicita della maestra vince sulla preselezione automatica',
    ).toBe('true')
  })
})
