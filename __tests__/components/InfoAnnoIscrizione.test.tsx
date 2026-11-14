import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InfoAnnoIscrizione } from '@/components/features/public/wizard/InfoAnnoIscrizione'

/**
 * Revisione sempl-B · rilievi 1 e 4. Una quota di UNA fascia non è «la quota»: è per tutti solo la riga con
 * `fascia: null`. Una fascia che il catalogo non conosce non diventa «Tutte le fasce»: si mostra il codice.
 */
const mostra = (quote: { fascia: string | null; importo: number }[]) => {
  render(<InfoAnnoIscrizione anno="2027/28" info={{ quote, moduli: [] }} />)
  return screen.getByRole('region', { name: /Anno, quota e documenti/ })
}

describe('InfoAnnoIscrizione · la quota', () => {
  it('rilievo 1 · UNA sola fascia (nido_1 = 150) non è presentata come la quota di tutti', () => {
    const p = mostra([{ fascia: 'nido_1', importo: 150 }])
    expect(p).toHaveTextContent(/Nido, primo anno/)
    expect(p).toHaveTextContent(/150,00/)
    // niente frase generica «Quota di nuova iscrizione: 150 €» che valga per ogni bambino
    expect(p).not.toHaveTextContent(/Quota di nuova iscrizione: .*150/)
  })

  it('più fasce con lo stesso importo, ma non per tutti, restano per fascia', () => {
    const p = mostra([{ fascia: 'nido_1', importo: 150 }, { fascia: 'nido_2', importo: 150 }])
    expect(p).toHaveTextContent(/Nido, primo anno/)
    expect(p).toHaveTextContent(/Nido, secondo anno/)
    expect(p).not.toHaveTextContent(/Quota di nuova iscrizione: .*150/)
  })

  it('è «per tutti» solo la riga con fascia null: una frase sola, senza fasce', () => {
    const p = mostra([{ fascia: null, importo: 120 }])
    expect(p).toHaveTextContent(/Quota di nuova iscrizione: .*120,00/)
    expect(p).not.toHaveTextContent(/fascia|Nido|Infanzia/i)
  })

  it('rilievo 4 · una fascia sconosciuta mostra il suo codice, non «Tutte le fasce»', () => {
    const p = mostra([{ fascia: 'fascia_nuova', importo: 80 }])
    expect(p).toHaveTextContent(/fascia_nuova/)
    expect(p).not.toHaveTextContent(/Tutte le fasce/)
  })

  it('la riga null insieme a fasce specifiche si legge come «Tutte le fasce» accanto alle altre', () => {
    const p = mostra([{ fascia: null, importo: 100 }, { fascia: 'nido_1', importo: 150 }])
    expect(p).toHaveTextContent(/Tutte le fasce.*100,00/)
    expect(p).toHaveTextContent(/Nido, primo anno.*150,00/)
  })
})
