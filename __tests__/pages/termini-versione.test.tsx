import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// C5 — La pagina /termini mostra un piè di pagina "Versione: <VERSIONE_TERMINI>".
// La costante è la FONTE UNICA condivisa con l'INSERT in consensi_accettazioni:
// testo mostrato e testo accettato non possono divergere nel tempo.
import TerminiPage from '@/app/termini/page'
import { VERSIONE_TERMINI } from '@/lib/legal/versioni'

// La riga di testa è un COMPONENTE SERVER ASYNC (`PublicPageHeader`, R13):
// legge il catalogo e la lingua con `next-intl/server`, e React DOM non sa
// rendere un componente async fuori dal renderer RSC. Qui si sostituisce con un
// segnaposto perché questa prova riguarda il piè di pagina della VERSIONE, non
// la testata — che ha il suo lock in `__tests__/i18n/skip-link-nel-catalogo`
// (monta il comando, legge la chiave dal catalogo, porta il proprio `lang`).
vi.mock('@/components/ui/PublicPageHeader', () => ({
  PublicPageHeader: () => null,
}))

describe('/termini — piè di pagina Versione', () => {
  it('mostra la versione corrente dei Termini importata dalla fonte unica', async () => {
    render(await TerminiPage({}))
    const el = screen.getByText(new RegExp(`Versione:?\\s*${VERSIONE_TERMINI}`))
    expect(el).toBeInTheDocument()
  })
})
