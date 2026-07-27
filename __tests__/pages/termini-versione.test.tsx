import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

// C5 — La pagina /termini mostra un piè di pagina "Versione: <VERSIONE_TERMINI>".
// La costante è la FONTE UNICA condivisa con l'INSERT in consensi_accettazioni:
// testo mostrato e testo accettato non possono divergere nel tempo.
import TerminiPage from '@/app/termini/page'
import { VERSIONE_TERMINI } from '@/lib/legal/versioni'

describe('/termini — piè di pagina Versione', () => {
  it('mostra la versione corrente dei Termini importata dalla fonte unica', () => {
    render(<TerminiPage />)
    const el = screen.getByText(new RegExp(`Versione:?\\s*${VERSIONE_TERMINI}`))
    expect(el).toBeInTheDocument()
  })
})
