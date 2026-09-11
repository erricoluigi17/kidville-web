import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { LezioniList, CompitiList, type Lezione } from '@/components/features/parent/LezioniCompitiSections'

// =============================================================================
// GLI ALLEGATI LATO FAMIGLIA — due difetti nella stessa schermata.
//
// 1. IN «COMPITI» NON COMPARIVANO AFFATTO. `LezioniList` rende `l.allegati`,
//    `CompitiList` no: il pulsante «Scatta foto» del registro produceva un dato
//    che la famiglia non vedeva mai. Non è un caso di scuola — è l'unico modo,
//    su un telefono, di allegare la pagina del libro a un compito.
//
// 2. UN'ANCORA SENZA INDIRIZZO RESTA UN'ANCORA. Quando la firma non riesce la
//    route risponde `file_url: null` (contratto di `firmaPercorsi`): con
//    `href={null}` React OMETTE l'attributo e in pagina resta un `<a>` che
//    sembra un link, non lo è, e non dice niente a chi lo tocca.
//
//    ⚠️ Ed è il motivo per cui QUI NON SI ASSERISCE con `queryByRole('link')`:
//    un `<a>` senza `href` non ha il ruolo `link`, quindi quell'asserzione
//    sarebbe verde CON e SENZA il rimedio. Si guarda l'elemento nel DOM.
//
// I testi passano dal mock globale di `next-intl` (`test/setup.ts`), che risolve
// sui cataloghi italiani veri: `lezioniAllegato` → «allegato».
// =============================================================================

const FIRMATO = 'https://progetto.supabase.co/storage/v1/object/sign/registro-allegati/registro/x/1.jpg?token=abc'

const lezione = (allegati: Lezione['allegati']): Lezione => ({
  id: 'r-1',
  data: '2026-09-08',
  ora_lezione: 1,
  materia: 'Matematica',
  argomento: 'Le frazioni',
  compiti: 'Esercizi 3 e 4',
  data_consegna_compiti: '2026-09-10',
  allegati,
  individualizzate: [],
})

const conAllegato = [{ id: 'al-1', tipo: 'immagine', file_url: FIRMATO, file_name: 'lavagna.jpg' }]
const senzaIndirizzo = [{ id: 'al-1', tipo: 'immagine', file_url: null, file_name: 'lavagna.jpg' }]

afterEach(cleanup)

describe('«Compiti»: l’allegato del compito arriva alla famiglia', () => {
  it('rende il link all’allegato, col nome del file', () => {
    render(<CompitiList lezioni={[lezione(conAllegato)]} />)
    const link = screen.getByRole('link', { name: /lavagna\.jpg/ })
    expect(link).toHaveAttribute('href', FIRMATO)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('la lezione senza compiti resta fuori: gli allegati non riaprono la sezione', () => {
    const { container } = render(
      <CompitiList lezioni={[{ ...lezione(conAllegato), compiti: null }]} />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})

describe('«Lezioni»: il link c’era già e non si tocca', () => {
  it('rende il link all’allegato firmato', () => {
    render(<LezioniList lezioni={[lezione(conAllegato)]} />)
    expect(screen.getByRole('link', { name: /lavagna\.jpg/ })).toHaveAttribute('href', FIRMATO)
  })
})

describe('firma non riuscita (`file_url: null`): nessuna ancora, in nessuna delle due sezioni', () => {
  it('«Lezioni» non rende nessun elemento `a`', () => {
    const { container } = render(<LezioniList lezioni={[lezione(senzaIndirizzo)]} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('«Compiti» non rende nessun elemento `a`', () => {
    const { container } = render(<CompitiList lezioni={[lezione(senzaIndirizzo)]} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('il resto della lezione resta visibile: si perde l’allegato, non il compito', () => {
    render(<CompitiList lezioni={[lezione(senzaIndirizzo)]} />)
    expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
  })
})
