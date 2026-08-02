import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itContab from '../../messages/it/adminContabilita.json'
import enContab from '../../messages/en/adminContabilita.json'
import { QuickAcquistoModal } from '@/components/features/admin/pagamenti/QuickAcquistoModal'

// =============================================================================
// `QuickAcquistoModal` — I QUATTRO CAMPI MUTI DELLA SEGRETERIA (a11y #5, #3).
//
// «Nuovo acquisto» è la finestra con cui la segreteria mette a carico di una
// famiglia una somma di denaro. Al collaudo del 2026-08-02, montata in jsdom,
// axe restituiva `label` ×3, `select-name` ×1 e `button-name` ×1, tutte di
// impatto CRITICAL: descrizione, importo, data e metodo di pagamento si
// annunciavano «casella di testo», «campo numerico», «menu» — l'operatore che
// usa uno screen reader doveva indovinare in quale campo stava scrivendo
// l'IMPORTO. Le etichette c'erano, a schermo: erano `<label>` senza `htmlFor`,
// cioè un legame soltanto visivo.
//
// E il contenitore non era un dialogo: nessun `role="dialog"`, nessun Esc,
// nessun focus-trap — lo stesso difetto del modale della firma, dall'altra
// parte del prodotto. La correzione non reinventa niente: usa `ui/Modal`, come
// il gemello `RegistraIncassoModal` che vive nella stessa cartella e registra
// l'incasso dello stesso pagamento.
//
// CONTRASTI MISURATI (WCAG 2.x, sRGB) — le etichette e i glifi erano dipinti col
// token che il design system dichiara DECORATIVO:
//   · `muted` #9AA6A2 su bianco  = 2,51:1  → `sub` #55615C = 6,46:1  (1.4.3)
//   · `warn`  #E6720A su warn-soft #FBEFE2 = 2,74:1 → `warn-strong` #A64F09 = 4,95:1
//   · `error` #E53935 su bianco  = 4,23:1  → `error-strong` #C62828 = 5,62:1
//   · il ✕ a 2,51:1 è un COMPONENTE d'interfaccia: soglia 3:1 (1.4.11), non 4,5.
// =============================================================================

expect.extend(toHaveNoViolations)

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}))

const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

/** Dati inventati: nessuna PII reale, il repo è pubblico. */
const ALUNNO = { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' }
const CATEGORIA = { id: 'c1', nome: 'Gita', slug: 'gita' }

/** Il fetch felice: nessun duplicato, creazione e incasso a buon fine. */
function fetchOk() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST' && u === '/api/pagamenti') {
      return { ok: true, json: async () => ({ success: true, data: { id: 'nuovo', fattura_stato: 'non_richiesta' } }) }
    }
    if (init?.method === 'POST' && u === '/api/pagamenti/incassi') {
      return { ok: true, json: async () => ({ success: true }) }
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) }
  })
}

function monta(props: Partial<React.ComponentProps<typeof QuickAcquistoModal>> = {}) {
  return render(
    <QuickAcquistoModal
      alunno={ALUNNO}
      categoria={CATEGORIA}
      userId="u1"
      onClose={props.onClose ?? vi.fn()}
      onDone={props.onDone ?? vi.fn()}
      {...props}
    />,
  )
}

beforeEach(() => vi.stubGlobal('fetch', fetchOk()))
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. È un dialogo
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickAcquistoModal — «Nuovo acquisto» è un dialogo', () => {
  it('espone `role="dialog"` + `aria-modal`, col nome preso dal titolo visibile', () => {
    monta()
    const dialogo = screen.getByRole('dialog', { name: itContab.quickNuovoAcquisto })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    const titolo = screen.getByRole('heading', { name: new RegExp(itContab.quickNuovoAcquisto, 'i') })
    expect(dialogo.getAttribute('aria-labelledby')).toBe(titolo.id)
    expect(titolo.id).not.toBe('')
  })

  it('Esc chiude la finestra', () => {
    const onClose = vi.fn()
    monta({ onClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('il Tab non esce dalla finestra, nemmeno se il focus è già scappato su `<body>`', () => {
    monta()
    const dialogo = screen.getByRole('dialog')
    ;(document.activeElement as HTMLElement)?.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialogo.contains(document.activeElement)).toBe(true)
  })

  it('mentre è aperta la pagina sotto è inerte, e alla chiusura torna raggiungibile', () => {
    function Pagina() {
      const [aperta, setAperta] = useState(false)
      return (
        <div>
          <button onClick={() => setAperta(true)}>Nuovo</button>
          <button>Controllo di sfondo</button>
          {aperta && (
            <QuickAcquistoModal
              alunno={ALUNNO}
              categoria={CATEGORIA}
              userId="u1"
              onClose={() => setAperta(false)}
              onDone={vi.fn()}
            />
          )}
        </div>
      )
    }
    render(<Pagina />)
    const sfondo = screen.getByRole('button', { name: 'Controllo di sfondo' })
    const apri = screen.getByRole('button', { name: 'Nuovo' })
    sfondo.focus()
    expect(document.activeElement).toBe(sfondo) // controllo positivo

    // `fireEvent.click` NON sposta il focus in jsdom, il browser sì: senza
    // questa riga si misurerebbe il ripristino verso lo sfondo e non verso il
    // comando che ha aperto la finestra.
    apri.focus()
    fireEvent.click(apri)
    expect(sfondo.closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelectorAll('[inert]').length).toBe(0)
    expect(document.activeElement).toBe(apri)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ogni campo ha un'etichetta ASSOCIATA (non solo disegnata sopra)
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickAcquistoModal — le etichette sono legate ai campi', () => {
  it.each([
    ['descrizione', itContab.quickDescrizione, 'INPUT', 'text'],
    ['importo', itContab.quickImportoLabel, 'INPUT', 'number'],
    ['data', itContab.quickData, 'INPUT', 'date'],
    ['metodo di pagamento', itContab.quickMetodo, 'SELECT', ''],
  ])('il campo «%s» si raggiunge dalla sua etichetta visibile', (_nome, etichetta, tag, tipo) => {
    monta()
    const campo = screen.getByLabelText(etichetta) as HTMLInputElement
    expect(campo.tagName).toBe(tag)
    if (tipo) expect(campo.type).toBe(tipo)
  })

  it('l’associazione è vera nei DUE versi: dal campo si risale al `<label>` visibile', () => {
    monta()
    for (const etichetta of [
      itContab.quickDescrizione,
      itContab.quickImportoLabel,
      itContab.quickData,
      itContab.quickMetodo,
    ]) {
      const campo = screen.getByLabelText(etichetta) as HTMLInputElement
      // `element.labels` è la lettura che fa il browser: un `aria-label` messo
      // per far passare `getByLabelText` non basterebbe. Qui si pretende il
      // `<label>` vero, quello già disegnato a schermo.
      expect(campo.labels?.length, `«${etichetta}» non ha un <label> associato`).toBe(1)
      expect(campo.labels?.[0].textContent).toContain(etichetta)
    }
  })

  it('due istanze montate insieme non si rubano gli id', () => {
    render(
      <>
        <QuickAcquistoModal alunno={ALUNNO} categoria={CATEGORIA} userId="u1" onClose={vi.fn()} onDone={vi.fn()} />
        <QuickAcquistoModal alunno={ALUNNO} categoria={CATEGORIA} userId="u1" onClose={vi.fn()} onDone={vi.fn()} />
      </>,
    )
    const campi = screen.getAllByLabelText(itContab.quickImportoLabel)
    expect(campi).toHaveLength(2)
    expect(campi[0].id).not.toBe(campi[1].id)
  })

  it('il ✕ ha un nome accessibile, un bersaglio 44×44 e chiude davvero', () => {
    const onClose = vi.fn()
    monta({ onClose })
    const chiudi = screen.getByRole('button', { name: itContab.quickChiudi })
    expect(chiudi.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
    expect(chiudi.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
    expect(chiudi.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(chiudi)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. L'esito si annuncia
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickAcquistoModal — errore ed esito vengono annunciati', () => {
  it('controllo positivo: all’apertura non c’è nessun errore e la regione di stato è VUOTA', () => {
    monta()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('l’importo mancante è un `role="alert"`', async () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContab.quickRegistraAcquisto, 'i') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itContab.quickErrImporto)
  })

  it('il possibile duplicato — che BLOCCA la registrazione — è un `role="alert"`', async () => {
    const oggi = new Date().toISOString().slice(0, 10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.startsWith('/api/pagamenti?')) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: [{ id: 'vecchio', importo: 25, scadenza: oggi, descrizione: 'Gita Zoo', stato: 'da_pagare' }],
            }),
          }
        }
        return { ok: true, json: async () => ({ success: true, data: [] }) }
      }),
    )
    monta()
    fireEvent.change(screen.getByLabelText(itContab.quickImportoLabel), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContab.quickRegistraAcquisto, 'i') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(itContab.quickDupPre, 'i'))
  })

  it('la conferma «Acquisto registrato» arriva nella regione di stato', async () => {
    monta()
    fireEvent.change(screen.getByLabelText(itContab.quickImportoLabel), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContab.quickRegistraAcquisto, 'i') }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(new RegExp(itContab.quickAcquistoRegistrato, 'i')),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Il piano rate non resta sotto la finestra, né intrappola la tastiera
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickAcquistoModal — il passaggio al piano rate', () => {
  it('aprendo «Configura acconti» resta UNA sola finestra a schermo', async () => {
    monta()
    fireEvent.change(screen.getByLabelText(itContab.quickImportoLabel), { target: { value: '90' } })
    fireEvent.click(screen.getByLabelText(itContab.quickDividiAcconti))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContab.quickConfiguraAcconti, 'i') }))

    // `RateizzaModal` è ancora un overlay scritto a mano (z-50) e NON è un
    // dialogo: lasciarlo aperto sotto la primitiva `Modal` (z-120) lo
    // seppellirebbe, e il focus-trap della finestra sopra gli ruberebbe ogni
    // Tab. Una finestra per volta: l'acquisto si chiude, il piano rate resta.
    await screen.findByText(new RegExp(itContab.rateTitolo, 'i'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. axe, contrasti e cataloghi
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickAcquistoModal — axe, contrasti e cataloghi', () => {
  it('nessuna violazione axe sulla finestra aperta', async () => {
    const { container } = monta()
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessuna violazione axe con l’errore a schermo', async () => {
    const { container } = monta()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContab.quickRegistraAcquisto, 'i') }))
    await screen.findByRole('alert')
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessun testo del modale è dipinto con i token sotto soglia', () => {
    const { container } = monta()
    // `muted` (2,51:1), `warn` (2,74:1 su warn-soft) ed `error` (4,23:1) non
    // dipingono più inchiostro qui: al loro posto ci sono `sub`, `warn-strong`
    // ed `error-strong`. Si misura sull'ALBERO RESO, non sul sorgente: una
    // classe applicata da una costante importata sfuggirebbe al grep.
    const sotto = Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) =>
      /(^|\s)(text-kidville-muted|text-kidville-warn|text-kidville-error)(\s|$)/.test(el.className || ''),
    )
    expect(sotto.map((el) => el.className)).toEqual([])
  })

  it('la chiave del nome accessibile del ✕ esiste in ENTRAMBE le lingue', () => {
    expect(itContab).toHaveProperty('quickChiudi')
    expect(enContab).toHaveProperty('quickChiudi')
    expect(String(enContab.quickChiudi).trim()).not.toBe('')
  })
})
