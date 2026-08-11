import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LE SCHEDE DELL'ADULTO — L'ACCESSIBILITÀ MISURATA, non dichiarata.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE, detto senza giri di parole. `smoke.axe.test.tsx`
 * è verde, e su queste schermate NON GIRA: nessuno di questi componenti è fra
 * quelli che monta. Eseguendo axe su di loro l'11 agosto sono uscite violazioni
 * vere e banali — `label` ×8 su `ParentDetailPanel` (indirizzo, civico, città,
 * provincia, CAP, telefono, email, cittadinanza: `<label>` senza `htmlFor` e
 * `<input>` senza `id`), `label` ×4 più `select-name` ×1 su `ScrollableAdultForm`
 * (la tendina «Ruolo Familiare», nella stessa griglia del campo «Sesso» a cui
 * l'`htmlFor` era stato aggiunto).
 *
 * «Il gate è verde» e «qualcuno ha guardato» sono due frasi diverse, e questo file
 * esiste perché diventino la stessa. Da qui in avanti una casella senza nome su
 * una di queste schede fa rosso.
 *
 * ⚠️ ERANO TRE. `AdultRegistryForm` è stata cancellata il 2026-08-11 insieme alla
 * rotta che la serviva (`POST /api/admin/adults`, irraggiungibile e rotta: vedi
 * `src/app/api/admin/adults/route.ts`). Misurare l'accessibilità di una scheda
 * che nessuno può aprire è lavoro che sembra copertura e non lo è: restano le
 * due schede vive, e sono quelle su cui passa un'anagrafica vera.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona, nessun codice fiscale reale.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (il contrasto ha il suo
 * lock dedicato, `__tests__/a11y/contrasto-cascata.test.tsx`). Stesso insieme di
 * `smoke.axe.test.tsx`, così due file non divergono sulla stessa decisione.
 */
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

import { ScrollableAdultForm } from '@/components/features/admin/ScrollableAdultForm'
import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel'

const ID_GENITORE = '00000000-0000-4000-8000-000000000001'

/** Toponimi e codici catastali: dati aperti dell'Agenzia, non dati di persone. */
const NAPOLI = {
  comuni: [{ belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true }],
}

/** Un genitore a dati CARICATI: la scheda vuota non ha i campi da misurare. */
const GENITORE = {
  id: ID_GENITORE,
  first_name: 'Prova',
  last_name: 'Esempio',
  gender: 'F',
  birth_date: '1985-03-07',
  birth_city: 'NAPOLI',
  birth_province: 'NA',
  birth_nation: 'Italia',
  codice_belfiore_nascita: 'H501',
  fiscal_code: '',
  emails: ['segreteria@example.test'],
  phone_numbers: ['+39 333 000 0000'],
  residence_address: 'Via di Prova',
  residence_street_number: '12',
  residence_city: 'Giugliano in Campania',
  residence_province: 'NA',
  zip_code: '80014',
  citizenship: 'Italiana',
  student_parents: [],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/anagrafiche/comuni')) return new Response(JSON.stringify(NAPOLI), { status: 200 })
    if (url.includes('/api/admin/parents/')) return new Response(JSON.stringify(GENITORE), { status: 200 })
    if (url.includes('/api/admin/sedi')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    return new Response('{"error":"non previsto"}', { status: 500 })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('axe · le schede dell’adulto, zero violazioni', () => {
  it('ScrollableAdultForm — la scheda della famiglia (l’unica montata in pagina)', async () => {
    const { container } = render(<ScrollableAdultForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('ParentDetailPanel — la scheda aperta sui record veri, a dati CARICATI', async () => {
    const { container } = render(
      <ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} variant="page" />,
    )
    // A dati non ancora arrivati la scheda è uno spinner: misurarla lì non
    // direbbe niente sui campi, che sono il punto.
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })
})

describe('ogni campo ha un nome, e ogni `htmlFor` un bersaglio', () => {
  /**
   * axe guarda il singolo elemento; questa misura guarda l'INSIEME. Un `htmlFor`
   * che punta a un `id` inesistente non è una violazione per axe (il campo può
   * avere un nome per un'altra via), ma è un'etichetta che non porta il fuoco da
   * nessuna parte — ed è esattamente il difetto che nasce quando si copia un
   * blocco di JSX senza cambiargli l'`id`.
   */
  it('ScrollableAdultForm: nessun `for` orfano, nessun `id` duplicato', async () => {
    const { container } = render(<ScrollableAdultForm />)
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())

    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ParentDetailPanel: nessun `for` orfano, nessun `id` duplicato', async () => {
    const { container } = render(
      <ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} variant="page" />,
    )
    await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toBeInTheDocument())

    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
