import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { ALFA, OGGI, reteFinta, passoSede } from '../fixtures/anagrafica-personale'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * L'INVARIANTE: nessun modulo pubblico mostra un asterisco senza spiegarlo.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
 *
 * L'asterisco dell'obbligatorietà lo stampa `FieldRenderer`, che è di TUTTI i
 * moduli; la legenda che lo traduce nasceva dentro `CandidaturaInsegnanteWizard`
 * ed era di UNO solo. MISURATO nella pagina viva il 2026-08-25, con le rotte
 * intercettate, a 390×844:
 *
 *   /iscrizione            · passo «Bambino 1»   10 asterischi · 10 `aria-required` · legenda ASSENTE
 *   /anagrafica-personale  · passo «I tuoi dati» 10 asterischi ·  8 `aria-required` · legenda ASSENTE
 *   /lavora-con-noi        · passo «I tuoi dati»  3 asterischi ·  3 `aria-required` · legenda presente
 *
 * Due moduli su tre chiedevano di indovinare un carattere. Un asterisco senza
 * legenda non è un'informazione: è un rebus, e lo si incontra proprio dove si
 * consegnano i dati di un bambino.
 *
 * ── PERCHÉ È SCRITTO COME UN'INVARIANTE E NON COME QUATTRO ASSERZIONI ───────
 *
 * La regola non è «questi moduli mostrano questa riga», che invecchia al modulo
 * successivo: è «se in pagina c'è il glifo, in pagina c'è la sua traduzione». Il
 * predicato non nomina nessun campo e nessun passo, quindi vale su qualunque
 * schermata gli si dia da guardare.
 *
 * ⚠️ MA IL PRODOTTO NON LA EREDITA DA SOLO, e fino al 25/08 questa testata diceva
 * il contrario: sosteneva che «un wizard pubblico nuovo, o un passo nuovo di uno
 * esistente, la eredita senza che nessuno debba ricordarsi di aggiungerlo a un
 * elenco». È falso, e si conta invece di dedurlo — `grep -rn LegendaObbligatori
 * src` trova le chiamate scritte A MANO: tre nei passi di `EnrollmentWizard`, una
 * in `AnagraficaPersonaleWizard`, una in `CandidaturaInsegnanteWizard`. Un passo
 * nuovo di uno di quei tre nasce SENZA legenda finché qualcuno non ce la scrive.
 * A ereditarla davvero è solo chi passa da `StepRenderer`.
 *
 * ⚠️ E LA QUARTA PORTA ESISTEVA GIÀ, SENZA LEGENDA. `/m/[token]` è pubblica e
 * anonima (`/m` sta in `PUBLIC_PREFIXES`, `src/lib/auth/middleware-rules.ts`):
 * monta `WizardContainer → StepRenderer → FieldRenderer` e stampava gli asterischi
 * di un modello pubblicato senza dire da nessuna parte che cosa fossero — cioè il
 * «quarto modulo» contro cui la regola non doveva invecchiare c'era già il giorno
 * in cui la regola è stata scritta. Dal 25/08 la legenda la rende `StepRenderer`,
 * una volta sola, e da lì la ereditano sia `/m/[token]` (anonima) sia
 * `/parent/forms/[id]` (in-app). Il quarto caso qui sotto misura quella riga: è la
 * ragione per cui questo file è un presidio e non un elenco di tre nomi.
 *
 * ⚠️ IL CONTROLLO NEGATIVO CHE APPROVEREBBE TUTTO. Un'implicazione «se ci sono
 * asterischi allora c'è la legenda» è VERA A VUOTO su una pagina senza
 * asterischi: sarebbe un test che non può fallire, cioè il difetto capitale di
 * questo repo. Perciò ogni caso pretende PRIMA di aver trovato almeno un glifo,
 * e solo dopo che sia spiegato. Se un giorno un passo smette di avere campi
 * obbligatori, questo file diventa rosso e va aggiornato: è il verso giusto in
 * cui può sbagliare.
 *
 * ⚠️ E IL GLIFO DELLA LEGENDA NON CONTA COME GLIFO DA SPIEGARE: la legenda rende
 * l'asterisco in uno `<span>` suo per dargli la tinta di quello che spiega (vedi
 * `LegendaObbligatori`), quindi si conta ciò che sta FUORI dal suo paragrafo.
 * Senza questa esclusione il test resterebbe verde su una pagina in cui l'unica
 * cosa rimasta è la legenda.
 */

const LEGENDA = itPublic.wizardCampiObbligatori

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const {
      initial, animate, exit, variants, transition, custom,
      whileHover, whileTap, layout, layoutId, ...rest
    } = props
    void initial; void animate; void exit; void variants; void transition
    void custom; void whileHover; void whileTap; void layout; void layoutId
    return rest
  }
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M(
          { children, ...props }: { children?: React.ReactNode },
          ref: React.Ref<HTMLElement>,
        ) {
          return React.createElement(tag, { ...strip(props), ref }, children)
        }),
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

// `WizardContainer` chiama `useRouter` al montaggio: senza questo mock il quarto
// caso cadrebbe per l'assenza del router, cioè per una ragione che non c'entra
// niente con la legenda.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/m/tok',
  useSearchParams: () => new URLSearchParams(),
}))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'
import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'
import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'
import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'
import type { FormSchemaConfig } from '@/types/database.types'

/**
 * Un modello pubblicato qualunque, con un campo obbligatorio e uno no.
 *
 * Il facoltativo non è decorazione: senza, la pagina avrebbe solo campi
 * obbligatori e non si vedrebbe la differenza fra «la legenda c'è» e «la legenda
 * ci sarebbe comunque». Con entrambi, il caso misura ciò che misura anche negli
 * altri tre moduli — glifi accanto ad alcune etichette, e la loro traduzione.
 */
const MODELLO_PUBBLICATO: FormSchemaConfig = {
  version: '1',
  pages: [
    {
      id: 'p1',
      title: 'Pagina Uno',
      fields: [
        { id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Es. Marco' },
        { id: 'note', type: 'textarea', label: 'Note' },
      ],
    },
  ],
}

/**
 * I glifi che CHIEDONO una spiegazione: gli asterischi resi da `FieldRenderer`
 * accanto all'etichetta di un campo obbligatorio, meno quello della legenda.
 *
 * Si cerca lo `<span>` foglia col solo asterisco perché è così che il glifo è
 * reso — in un nodo suo, per riceverne la tinta — e non si cerca nel testo della
 * pagina: `textContent` includerebbe l'asterisco di qualunque frase.
 */
function glifiDaSpiegare(): Element[] {
  return [...document.querySelectorAll('span')].filter(
    (s) =>
      s.children.length === 0 &&
      s.textContent?.trim() === '*' &&
      s.closest('p')?.textContent !== LEGENDA,
  )
}

/** La legenda come la legge una persona: un paragrafo il cui testo è quello. */
function legendaInPagina(): boolean {
  return [...document.querySelectorAll('p')].some((p) => p.textContent === LEGENDA)
}

/** L'invariante, con il controllo positivo davanti. */
function pretendiCheOgniAsteriscoSiaSpiegato(dove: string): void {
  const glifi = glifiDaSpiegare()
  expect(
    glifi.length,
    `${dove}: nessun asterisco in pagina — questo caso non sta più misurando niente ` +
      '(un\'implicazione senza premessa è verde comunque). Se il passo è cambiato, cambia il caso.',
  ).toBeGreaterThan(0)
  expect(
    legendaInPagina(),
    `${dove}: ${glifi.length} campi portano l'asterisco e in pagina non c'è nessun testo che dica ` +
      `che cosa significhi. La legenda attesa è «${LEGENDA}».`,
  ).toBe(true)
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  // Nessuno schema personalizzato dal builder: i wizard usano i template veri,
  // che sono quelli che le famiglie compilano davvero.
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/iscrizione/sedi')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [{ id: ALFA.id, nome: ALFA.nome }] }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('la legenda dell’asterisco è di ogni modulo pubblico, non di uno solo', () => {
  it('/iscrizione · passo «Bambino 1»: dieci asterischi, e la loro traduzione', async () => {
    render(<EnrollmentWizard scuolaId={ALFA.id} />)
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Es. Marco')).toBeInTheDocument(),
    )
    pretendiCheOgniAsteriscoSiaSpiegato('/iscrizione · Bambino 1')
  })

  it('/anagrafica-personale · passo «I tuoi dati»: idem', async () => {
    const rete = reteFinta()
    vi.stubGlobal('fetch', rete.fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toBeInTheDocument())
    pretendiCheOgniAsteriscoSiaSpiegato('/anagrafica-personale · I tuoi dati')
  })

  it('/lavora-con-noi · passo «I tuoi dati»: era già così, e resta così', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={ALFA.id} />)
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument(),
    )
    pretendiCheOgniAsteriscoSiaSpiegato('/lavora-con-noi · I tuoi dati')
  })

  /**
   * LA QUARTA PORTA, quella che non è un wizard scritto a mano: un modello
   * pubblicato dalla Segreteria, reso da `WizardContainer → StepRenderer`.
   *
   * È il caso che tiene onesta la testata. Gli altri tre montano wizard che la
   * legenda la chiamano per nome; questo monta il componente GENERICO, quello che
   * rende qualunque schema — e che fino al 25/08 stampava asterischi e basta.
   * `publicToken` valorizzato = la modalità pubblica di `/m/[token]`: nessuna
   * sessione, nessun account, chiunque abbia il collegamento.
   */
  it('/m/[token] · un modello pubblicato: la legenda la eredita `StepRenderer`', async () => {
    render(
      <WizardContainer
        modelId="mod-1"
        title="Modulo pubblicato"
        description={null}
        schema={MODELLO_PUBBLICATO}
        requiresSignature={false}
        userId={null}
        parentEmail={null}
        publicToken="tok"
      />,
    )
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Es. Marco')).toBeInTheDocument(),
    )
    pretendiCheOgniAsteriscoSiaSpiegato('/m/[token] · Pagina Uno')
  })
})
