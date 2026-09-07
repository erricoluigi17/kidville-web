import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SelettoreAlunni } from '@/components/ui/SelettoreAlunni'
import { SELEZIONE_TUTTI, type SelezioneAlunni } from '@/lib/pagamenti/selezione-alunni'

// I testi arrivano per prop (disciplina di `components/ui`): qui sono finti e
// riconoscibili, così il test misura il COMPORTAMENTO e non il catalogo.
const T = {
  legenda: 'Per chi',
  modoTutti: 'Tutti',
  modoClasse: 'Classe',
  modoScelti: 'Scelti',
  classeEtichetta: 'Classe',
  classeTutte: '— scegli —',
  cercaEtichetta: 'Cerca',
  cercaSegnaposto: 'cognome',
  selezionaMostrati: 'Spunta quelli mostrati',
  svuota: 'Svuota',
  vuoto: 'Nessun bambino corrisponde',
  conteggio: (n: number) => `mostrati: ${n}`,
  bersaglio: (n: number) => `bersaglio: ${n}`,
}

const ALUNNI = [
  { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' },
  { id: 'a2', nome: 'Lia', cognome: 'Bianchi', classe_sezione: '1A' },
  { id: 'a3', nome: 'Nicolò', cognome: 'Esposito', classe_sezione: '2B' },
]

function Banco({ alunni = ALUNNI }: { alunni?: typeof ALUNNI }) {
  const [v, setV] = useState<SelezioneAlunni>(SELEZIONE_TUTTI)
  return <SelettoreAlunni id="x" alunni={alunni} valore={v} onChange={setV} testi={T} />
}

const modo = (nome: string) => screen.getByRole('button', { name: nome })

describe('SelettoreAlunni — le tre modalità', () => {
  it('parte da «tutti», e il bersaglio è tutto l’elenco', () => {
    render(<Banco />)
    expect(modo('Tutti').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('bersaglio: 3')).toBeTruthy()
  })

  it('«classe» senza classe scelta non genera per nessuno: non è «tutti»', () => {
    render(<Banco />)
    fireEvent.click(modo('Classe'))
    expect(screen.getByText('bersaglio: 0')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1A' } })
    expect(screen.getByText('bersaglio: 2')).toBeTruthy()
  })

  it('cambiando modalità non resta appeso ciò che apparteneva all’altra', () => {
    render(<Banco />)
    fireEvent.click(modo('Classe'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2B' } })
    fireEvent.click(modo('Scelti'))
    fireEvent.click(modo('Classe'))
    // la classe è stata dimenticata: lasciarla farebbe credere che valga ancora
    expect(screen.getByText('bersaglio: 0')).toBeTruthy()
  })
})

describe('SelettoreAlunni — la ricerca', () => {
  it('trova un cognome scritto in minuscolo', () => {
    // ⚠️ IL DIFETTO CHE QUESTO CASO BLOCCA. La prima stesura usava `rangoDiMatch`,
    // che pretende testo GIÀ normalizzato e confronta con `indexOf`: cercare
    // «bianchi» su «Bianchi Lia» non trovava niente, e l'elenco restava vuoto.
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bianchi' } })
    expect(screen.getByText('mostrati: 1')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Bianchi Lia/ })).toBeTruthy()
  })

  it('trova anche senza accento', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nicolo' } })
    expect(screen.getByText('mostrati: 1')).toBeTruthy()
  })

  it('si può cercare per classe', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '2B' } })
    expect(screen.getByText('mostrati: 1')).toBeTruthy()
  })

  it('una ricerca che non trova niente lo dice, invece di mostrare una lista vuota', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.getByText('Nessun bambino corrisponde')).toBeTruthy()
  })

  it('il conteggio dei mostrati sta in una regione annunciata', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    expect(screen.getByRole('status').textContent).toBe('mostrati: 3')
  })
})

describe('SelettoreAlunni — le spunte', () => {
  it('«spunta quelli mostrati» agisce SOLO su ciò che la ricerca mostra', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bianchi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Spunta quelli mostrati' }))
    expect(screen.getByText('bersaglio: 1')).toBeTruthy()
  })

  it('le spunte fatte prima non si perdono cambiando ricerca', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Rossi Mario/ }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bianchi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Spunta quelli mostrati' }))
    // Rossi non è più a schermo, ma resta selezionato: «mostrati» aggiunge, non
    // sostituisce
    expect(screen.getByText('bersaglio: 2')).toBeTruthy()
  })

  it('«svuota» toglie tutto, anche ciò che la ricerca nasconde', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    fireEvent.click(screen.getByRole('button', { name: 'Spunta quelli mostrati' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bianchi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Svuota' }))
    expect(screen.getByText('bersaglio: 0')).toBeTruthy()
  })

  it('spuntare due volte lo stesso bambino lo toglie', () => {
    render(<Banco />)
    fireEvent.click(modo('Scelti'))
    const c = screen.getByRole('checkbox', { name: /Rossi Mario/ })
    fireEvent.click(c)
    expect(screen.getByText('bersaglio: 1')).toBeTruthy()
    fireEvent.click(c)
    expect(screen.getByText('bersaglio: 0')).toBeTruthy()
  })
})
