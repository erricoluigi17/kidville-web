import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

// =============================================================================
// L'AVVISO DELL'ANNO (PR 4.2.5): appare quando si guarda un anno che non è quello attivo, non si può
// chiudere, e il solo modo di farlo sparire è tornare all'anno in corso. Provider VERO; finti sono il
// calendario, le sedi attive e il ruolo.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  ruolo: 'admin',
  effettive: [] as string[],
}))

vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: false, errore: false, ricarica: vi.fn() }),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ effettive: h.effettive, loading: false, errore: false }),
}))
vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => h.ruolo }))

import { AnnoNotice, AnnoProvider, useAnno } from '@/lib/context/anno-context'

const A25 = '22222222-2222-4222-8222-222222222025'
const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'

function riga(anno: number, stato: StatoAnno, annoId: string): RigaCalendario {
  return {
    annoId,
    annoSedeId: `5ed00000-0000-4000-8000-000000${String(anno).padStart(6, '0')}`,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno}-03-01`,
    stato,
    domandeAperte: false,
  }
}

/** Un pulsante di prova per scegliere l'anno dal di fuori dell'avviso. */
function Scegli({ annoId }: { annoId: string }) {
  const { scegli } = useAnno()
  return (
    <button type="button" onClick={() => scegli(annoId)}>
      vai a {annoId.slice(-4)}
    </button>
  )
}

beforeEach(() => {
  document.cookie = 'anno_attivo=; path=/; max-age=0'
  h.ruolo = 'admin'
  h.effettive = [SEDE_A]
  h.perSede = {
    [SEDE_A]: [riga(2025, 'chiuso', A25), riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
  }
})

function monta() {
  return render(
    <AnnoProvider>
      <AnnoNotice />
      <Scegli annoId={A27} />
      <Scegli annoId={A25} />
    </AnnoProvider>,
  )
}

describe('AnnoNotice', () => {
  it('con l\'anno attivo non c\'è nulla nel DOM', () => {
    monta()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: /torna all.anno in corso/i })).toBeNull()
  })

  it('con un altro anno: role="status", il testo con lo stato in parole, e il pulsante per tornare', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))

    const avviso = screen.getByRole('status')
    expect(avviso).toHaveTextContent(/Stai guardando il 2027\/28 \(iscrizioni aperte\), non l.anno in corso/)
    expect(screen.getByRole('button', { name: /torna all.anno in corso/i })).toBeInTheDocument()
  })

  it('non si può chiudere: l\'unico pulsante è «Torna all\'anno in corso»', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const avviso = screen.getByRole('status')
    const pulsanti = Array.from(avviso.querySelectorAll('button'))
    expect(pulsanti).toHaveLength(1)
    expect(pulsanti[0]).toHaveTextContent(/torna all.anno in corso/i)
    expect(screen.queryByRole('button', { name: /chiudi|nascondi|ok/i })).toBeNull()
  })

  it('«Torna all\'anno in corso» toglie l\'avviso e cancella il cookie', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    expect(document.cookie).toContain(`anno_attivo=${A27}`)

    fireEvent.click(screen.getByRole('button', { name: /torna all.anno in corso/i }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.cookie).not.toContain('anno_attivo=2')
  })

  it('con l\'anno scelto chiuso dice che le modifiche si registrano come correzione', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2025' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      /Stai guardando il 2025\/26 \(chiuso: le modifiche si registrano come correzione\), non l.anno in corso/,
    )
  })

  it('con l\'anno scelto in chiusura dice «(in chiusura)»', () => {
    h.perSede = {
      [SEDE_A]: [riga(2025, 'in_chiusura', A25), riga(2026, 'corrente', A26), riga(2027, 'in_preparazione', A27)],
    }
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2025' }))
    expect(screen.getByRole('status')).toHaveTextContent(/Stai guardando il 2025\/26 \(in chiusura\), non l.anno in corso/)
  })

  it('con più sedi: stato comune → lo stato; stato diverso fra le sedi → dicitura neutra', () => {
    h.effettive = [SEDE_A, SEDE_B]
    h.perSede = {
      [SEDE_A]: [riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
      [SEDE_B]: [riga(2026, 'corrente', A26), riga(2027, 'in_preparazione', A27)],
    }
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const avviso = screen.getByRole('status')
    expect(avviso).toHaveTextContent(/Stai guardando il 2027\/28 \(stato diverso fra le sedi\), non l.anno in corso/)
    expect(avviso).not.toHaveTextContent('iscrizioni aperte')
    expect(avviso).not.toHaveTextContent('in preparazione')

    h.perSede = {
      [SEDE_A]: [riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
      [SEDE_B]: [riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
    }
    cleanup()
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    expect(screen.getByRole('status')).toHaveTextContent(/Stai guardando il 2027\/28 \(iscrizioni aperte\), non l.anno in corso/)
  })

  it('un docente o un genitore non lo vedono, e senza AnnoProvider non monta nulla', () => {
    h.ruolo = 'docente'
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('senza AnnoProvider non monta nulla e non lancia', () => {
    const { container } = render(<AnnoNotice />)
    expect(container).toBeEmptyDOMElement()
  })
})
