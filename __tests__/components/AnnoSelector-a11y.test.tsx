import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

expect.extend(toHaveNoViolations)

// =============================================================================
// IL SELETTORE DELL'ANNO (PR 4.2.5) — stessa a11y di `SedeSelector`: nome accessibile che dice cosa fa e
// su quale anno si lavora, `aria-expanded`/`aria-controls`, pannello `group` con una riga per anno e
// `aria-pressed` sulla riga attiva, Escape che riporta il focus, stato in PAROLE. Il provider è quello
// VERO (`AnnoProvider`); finti sono solo il calendario, le sedi attive e il ruolo.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  effettive: [] as string[],
  ruolo: 'admin',
}))

vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: false, errore: false, ricarica: vi.fn() }),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ effettive: h.effettive, loading: false, errore: false }),
}))
vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => h.ruolo }))

import { AnnoProvider, useAnno } from '@/lib/context/anno-context'
import { AnnoSelector } from '@/components/ui/cockpit'

const A25 = '22222222-2222-4222-8222-222222222025'
const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'

function riga(sede: string, anno: number, stato: StatoAnno, annoId: string): RigaCalendario {
  return {
    annoId,
    annoSedeId: `5ed00000-0000-4000-8000-${sede.slice(-6)}${String(anno).padStart(6, '0')}`,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno}-03-01`,
    stato,
    domandeAperte: false,
  }
}

function treAnni(sede: string, stato27: StatoAnno = 'in_preparazione'): RigaCalendario[] {
  return [riga(sede, 2025, 'chiuso', A25), riga(sede, 2026, 'corrente', A26), riga(sede, 2027, stato27, A27)]
}

beforeEach(() => {
  document.cookie = 'anno_attivo=; path=/; max-age=0'
  h.perSede = { [SEDE_A]: treAnni(SEDE_A) }
  h.effettive = [SEDE_A]
  h.ruolo = 'admin'
})

function monta(compatto = false) {
  return render(
    <AnnoProvider>
      <AnnoSelector compatto={compatto} />
    </AnnoProvider>,
  )
}

function apri() {
  const utils = monta()
  const trigger = screen.getByRole('button', { name: /cambia anno scolastico/i })
  fireEvent.click(trigger)
  const gruppo = screen.getByRole('group', { name: /cambia anno scolastico/i })
  return { ...utils, trigger, gruppo }
}

describe('AnnoSelector — su quale anno sto lavorando', () => {
  it('il trigger ha il nome accessibile «Cambia anno scolastico: 2026/27», aria-expanded e aria-controls', () => {
    monta()
    const trigger = screen.getByRole('button', { name: /cambia anno scolastico/i })
    expect(trigger).toHaveAccessibleName('Cambia anno scolastico: 2026/27')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('aria-controls')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const pannello = document.getElementById(trigger.getAttribute('aria-controls')!)
    expect(pannello).toBe(screen.getByRole('group', { name: /cambia anno scolastico/i }))
  })

  it('il pannello ha una riga per anno e UNA sola con aria-pressed (l\'anno su cui si lavora)', () => {
    const { gruppo } = apri()
    const righe = within(gruppo).getAllByRole('button')
    expect(righe).toHaveLength(3)

    const attive = within(gruppo).getAllByRole('button', { pressed: true })
    expect(attive).toHaveLength(1)
    expect(attive[0]).toHaveTextContent('2026/27')
    expect(within(gruppo).getAllByRole('button', { pressed: false })).toHaveLength(2)
  })

  it('ogni riga dice lo stato in parole, non solo col colore', () => {
    const { gruppo } = apri()
    const testo = (anno: string) =>
      within(gruppo).getByRole('button', { name: new RegExp(anno) }).textContent ?? ''
    expect(testo('2025/26')).toContain('chiuso')
    expect(testo('2026/27')).toContain('in corso')
    expect(testo('2027/28')).toContain('in preparazione')
  })

  it('«iscrizioni aperte» e «in chiusura» sono in parole', () => {
    h.perSede = {
      [SEDE_A]: [
        riga(SEDE_A, 2025, 'chiuso', A25),
        riga(SEDE_A, 2026, 'in_chiusura', A26),
        riga(SEDE_A, 2027, 'iscrizioni_aperte', A27),
      ],
    }
    const { gruppo } = apri()
    const testo = (anno: string) =>
      within(gruppo).getByRole('button', { name: new RegExp(anno) }).textContent ?? ''
    expect(testo('2026/27')).toContain('in chiusura')
    expect(testo('2027/28')).toContain('iscrizioni aperte')
  })

  it('scegliere una riga scrive la scelta, chiude il pannello e riporta il focus al trigger', () => {
    const { trigger, gruppo } = apri()
    fireEvent.click(within(gruppo).getByRole('button', { name: /2027\/28/ }))

    expect(screen.queryByRole('group', { name: /cambia anno scolastico/i })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger).toHaveAccessibleName('Cambia anno scolastico: 2027/28')
    expect(document.cookie).toContain('anno_attivo=' + A27)
  })

  it('Escape chiude il pannello e riporta il focus al trigger', () => {
    const { trigger, gruppo } = apri()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const riga = within(gruppo).getAllByRole('button')[0]
    riga.focus()
    expect(document.activeElement).toBe(riga)

    fireEvent.keyDown(riga, { key: 'Escape' })

    expect(screen.queryByRole('group', { name: /cambia anno scolastico/i })).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('compatto mostra 26/27', () => {
    monta(true)
    const trigger = screen.getByRole('button', { name: /cambia anno scolastico/i })
    expect(trigger).toHaveAccessibleName('Cambia anno scolastico: 26/27')
    expect(trigger.textContent).not.toContain('2026')
  })

  it('con più sedi e nessuna scelta nessuna riga è premuta (ogni sede usa il proprio anno attivo)', () => {
    h.effettive = [SEDE_A, SEDE_B]
    h.perSede = { [SEDE_A]: treAnni(SEDE_A), [SEDE_B]: treAnni(SEDE_B) }
    const { gruppo } = apri()
    expect(within(gruppo).queryAllByRole('button', { pressed: true })).toHaveLength(0)
    expect(within(gruppo).getAllByRole('button', { pressed: false })).toHaveLength(3)
  })

  it('le icone sono decorative e jest-axe non trova violazioni col pannello aperto', async () => {
    const { container, gruppo } = apri()
    for (const svg of Array.from(gruppo.querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    }
    expect(
      await axe(container, { rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})

describe('AnnoSelector — la riga dell\'anno attivo è «torna al predefinito», non una scelta', () => {
  let scritture: string[]
  let spia: ReturnType<typeof vi.spyOn>

  function Sonda() {
    const { epocaAnno, eAttivo } = useAnno()
    return <output data-testid="sonda">{`${epocaAnno}|${eAttivo}`}</output>
  }

  function montaConSonda() {
    return render(
      <AnnoProvider>
        <AnnoSelector />
        <Sonda />
      </AnnoProvider>,
    )
  }

  function sulCookie() {
    scritture = []
    spia = vi.spyOn(document, 'cookie', 'set')
    spia.mockImplementation(((v: string) => {
      scritture.push(v)
    }) as never)
  }

  afterEach(() => {
    spia?.mockRestore()
    document.cookie = 'anno_attivo=; path=/; max-age=0'
  })

  it('con il cookie su un altro anno, il clic sulla riga attiva lo cancella, eAttivo torna true e l\'epoca avanza', () => {
    document.cookie = `anno_attivo=${A27}; path=/` // cookie vero, prima della spia
    sulCookie()
    montaConSonda()
    expect(screen.getByTestId('sonda')).toHaveTextContent('0|false')

    fireEvent.click(screen.getByRole('button', { name: /cambia anno scolastico/i }))
    fireEvent.click(screen.getByRole('button', { name: /2026\/27/, pressed: false }))

    expect(scritture).toEqual(['anno_attivo=; path=/; samesite=lax; max-age=0'])
    expect(screen.getByTestId('sonda')).toHaveTextContent('1|true')
    expect(screen.getByRole('button', { name: /cambia anno scolastico/i })).toHaveAccessibleName(
      'Cambia anno scolastico: 2026/27',
    )
  })

  it('senza cookie, il clic sulla riga attiva non scrive niente e non fa avanzare l\'epoca (ma chiude il pannello)', () => {
    sulCookie()
    montaConSonda()
    const trigger = screen.getByRole('button', { name: /cambia anno scolastico/i })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: /2026\/27/, pressed: true }))

    expect(scritture).toEqual([])
    expect(screen.getByTestId('sonda')).toHaveTextContent('0|true')
    expect(screen.queryByRole('group', { name: /cambia anno scolastico/i })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('un anno NON attivo resta una scelta: scrive il cookie', () => {
    sulCookie()
    montaConSonda()
    fireEvent.click(screen.getByRole('button', { name: /cambia anno scolastico/i }))
    fireEvent.click(screen.getByRole('button', { name: /2027\/28/ }))
    expect(scritture).toEqual([`anno_attivo=${A27}; path=/; samesite=lax; max-age=604800`])
    expect(screen.getByTestId('sonda')).toHaveTextContent('1|false')
  })
})

describe('AnnoSelector — più sedi: lo stato è quello comune, altrimenti dicitura neutra', () => {
  it('stato uguale nelle due sedi → lo stato; stato diverso → «stato diverso fra le sedi»', () => {
    h.effettive = [SEDE_A, SEDE_B]
    h.perSede = {
      [SEDE_A]: [riga(SEDE_A, 2026, 'corrente', A26), riga(SEDE_A, 2027, 'iscrizioni_aperte', A27)],
      [SEDE_B]: [riga(SEDE_B, 2026, 'in_chiusura', A26), riga(SEDE_B, 2027, 'iscrizioni_aperte', A27)],
    }
    const { gruppo } = apri()
    const testo = (anno: string) => within(gruppo).getByRole('button', { name: new RegExp(anno) }).textContent ?? ''
    expect(testo('2027/28')).toContain('iscrizioni aperte')
    expect(testo('2026/27')).toContain('stato diverso fra le sedi')
    expect(testo('2026/27')).not.toContain('in corso')
    expect(testo('2026/27')).not.toContain('in chiusura')
  })
})

describe('AnnoSelector — quando NON si monta', () => {
  it('con meno di due anni da scegliere', () => {
    h.perSede = { [SEDE_A]: [riga(SEDE_A, 2026, 'corrente', A26)] }
    const { container } = monta()
    expect(container).toBeEmptyDOMElement()
  })

  it('senza anni (database E2E: calendario non disponibile, la sede non compare)', () => {
    h.perSede = {}
    const { container } = monta()
    expect(container).toBeEmptyDOMElement()
  })

  it('per un docente, un genitore o un ruolo non ancora noto', () => {
    for (const ruolo of ['docente', 'genitore', '']) {
      h.ruolo = ruolo
      const { container, unmount } = monta()
      expect(container, `ruolo «${ruolo}»`).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('senza AnnoProvider (le shell di docenti e genitori) non monta nulla e non lancia', () => {
    const { container } = render(<AnnoSelector />)
    expect(container).toBeEmptyDOMElement()
  })

  it('la segreteria e il coordinatore lo vedono, come la Direzione', () => {
    for (const ruolo of ['segreteria', 'coordinator', 'admin']) {
      h.ruolo = ruolo
      const { unmount } = monta()
      expect(screen.getByRole('button', { name: /cambia anno scolastico/i }), ruolo).toBeInTheDocument()
      unmount()
    }
  })
})
