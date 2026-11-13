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
    expect(avviso).toHaveTextContent(/Stai lavorando sul 2027\/28 \(iscrizioni aperte\): le nuove classi, le votazioni e gli elenchi caricati vanno in quell.anno\. Anche gli elenchi delle classi sul video mostrano quell.anno\./)
    expect(screen.getByRole('button', { name: /torna all.anno in corso/i })).toBeInTheDocument()
  })

  it('(PR 4.9) con l\'anno in corso e con un altro anno aperto la riga «si sta chiudendo» non c\'è', () => {
    monta()
    expect(screen.queryByRole('note')).toBeNull() // l'anno attivo è `corrente`
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' })) // `iscrizioni_aperte`
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('(PR 4.9) se l\'anno ATTIVO è `in_chiusura` la riga c\'è anche senza l\'avviso «anno diverso»', () => {
    h.perSede = { [SEDE_A]: [riga(2026, 'in_chiusura', A26), riga(2027, 'iscrizioni_aperte', A27)] }
    monta()
    const nota = screen.getByRole('note')
    expect(nota).toBeInTheDocument()
    expect(nota.className).not.toMatch(/\b(fixed|absolute|sticky)\b/) // in flusso: non copre il menu né altri pulsanti
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('(PR 4.9) i docenti (che non scelgono l\'anno) non vedono la riga, nemmeno con l\'anno in chiusura', () => {
    h.perSede = { [SEDE_A]: [riga(2026, 'in_chiusura', A26), riga(2027, 'iscrizioni_aperte', A27)] }
    h.ruolo = 'educator'
    monta()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('sta in flusso, sotto la barra: sticky (telefono: --kv-appbar-h; da 744 px: top-16), mai fixed né absolute', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const cls = screen.getByRole('status').className.split(/\s+/)
    expect(cls).toContain('sticky')
    expect(cls).toContain('top-[var(--kv-appbar-h)]')
    expect(cls).toContain('tablet:top-16')
    expect(cls).toContain('flex-wrap') // il testo va a capo, non si tronca
    expect(cls).not.toContain('fixed')
    expect(cls).not.toContain('absolute')
    expect(cls.some((c) => /truncate|line-clamp|overflow-hidden/.test(c))).toBe(false)
  })

  it('non si può chiudere: i soli pulsanti sono «Torna all\'anno in corso» e «Perché?» (che apre un testo, non chiude l\'avviso)', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const avviso = screen.getByRole('status')
    const pulsanti = Array.from(avviso.querySelectorAll('button'))
    expect(pulsanti.map((b) => b.textContent)).toEqual(['Perché?', 'Torna all’anno in corso'])
    expect(screen.queryByRole('button', { name: /chiudi|nascondi|ok/i })).toBeNull()
  })

  it('schermo stretto: la riga corta dice anno e stato, il testo lungo sta dietro «Perché?» e si apre e si chiude', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const avviso = screen.getByRole('status')
    // La versione corta c'è e, per CSS, è l'unica visibile sotto i 640px; quella lunga è `hidden` fino a 640px.
    const corta = screen.getByText('Stai guardando il 2027/28 (iscrizioni aperte)')
    expect(corta.className).toContain('min-[640px]:hidden')
    const lunga = screen.getByText(/^Stai lavorando sul 2027\/28/)
    expect(lunga.className).toContain('hidden')
    expect(lunga.className).toContain('min-[640px]:inline')

    const perche = screen.getByRole('button', { name: 'Perché?' })
    expect(perche.className).toContain('min-[640px]:hidden')
    expect(perche).toHaveAttribute('aria-expanded', 'false')
    expect(avviso.querySelectorAll('#kv-anno-avviso-perche')).toHaveLength(0)

    fireEvent.click(perche)
    expect(perche).toHaveAttribute('aria-expanded', 'true')
    expect(avviso.querySelector('#kv-anno-avviso-perche')).toHaveTextContent(/va nel 2027\/28, non nell’anno in corso/)

    fireEvent.click(perche)
    expect(perche).toHaveAttribute('aria-expanded', 'false')
    expect(avviso.querySelectorAll('#kv-anno-avviso-perche')).toHaveLength(0)
    // «Torna» resta sempre al suo posto, aperto o chiuso il «Perché?»
    expect(screen.getByRole('button', { name: /torna all.anno in corso/i })).toBeInTheDocument()
  })

  // Contratto di classi, NON una misura: jsdom non calcola il layout e non vede quanto spazio resta davvero.
  // La prova vera è la misura in Chrome a 320/390/1280 (agente1-schermate/, rapporto). Qui si impedisce solo che
  // torni la forma che a 390 lasciava ~106px al testo e a 320 ~36px: il testo `flex-1` senza base piena,
  // oppure `truncate`/`whitespace-nowrap` dentro l'avviso.
  it('schermo stretto: il blocco di testo ha base piena (il pulsante va a capo), nessun nowrap/truncate nell\'avviso', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    const avviso = screen.getByRole('status')
    const blocco = screen.getByText('Stai guardando il 2027/28 (iscrizioni aperte)').closest('div') as HTMLElement
    expect(blocco.parentElement).toBe(avviso)
    const cls = blocco.className.split(/\s+/)
    expect(cls).toContain('basis-full')
    expect(cls).not.toContain('flex-1') // solo `min-[640px]:flex-1`
    expect(cls).toContain('min-[640px]:flex-1')
    for (const el of [avviso, ...Array.from(avviso.querySelectorAll('*'))]) {
      expect(el.className.toString()).not.toMatch(/whitespace-nowrap|truncate|line-clamp|overflow-hidden/)
    }
  })

  it('«Torna all\'anno in corso» toglie l\'avviso e cancella il cookie', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    expect(document.cookie).toContain(`anno_attivo=${A27}`)

    fireEvent.click(screen.getByRole('button', { name: /torna all.anno in corso/i }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.cookie).not.toContain('anno_attivo=2')
  })

  it('un anno chiuso non compare fra le scelte: scegliere il 2025 non fa niente (nessun avviso, nessun cookie)', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2025' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.cookie).not.toContain('anno_attivo=2')
  })

  it('un cookie rimasto su un anno chiuso viene potato come un anno che non c\'è più', () => {
    document.cookie = `anno_attivo=${A25}; path=/`
    monta()
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.cookie).not.toContain('anno_attivo=2')
  })

  it('con più sedi, un anno chiuso anche in una sola sede esce dalle scelte comuni', () => {
    h.effettive = [SEDE_A, SEDE_B]
    h.perSede = {
      [SEDE_A]: [riga(2025, 'chiuso', A25), riga(2026, 'corrente', A26), riga(2027, 'in_preparazione', A27)],
      [SEDE_B]: [riga(2025, 'in_chiusura', A25), riga(2026, 'corrente', A26), riga(2027, 'in_preparazione', A27)],
    }
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2025' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('con l\'anno scelto in chiusura dice «(in chiusura)»', () => {
    h.perSede = {
      [SEDE_A]: [riga(2025, 'in_chiusura', A25), riga(2026, 'corrente', A26), riga(2027, 'in_preparazione', A27)],
    }
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2025' }))
    expect(screen.getByRole('status')).toHaveTextContent(/Stai lavorando sul 2025\/26 \(in chiusura\): le nuove classi/)
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
    expect(avviso).toHaveTextContent(/Stai lavorando sul 2027\/28 \(stato diverso fra le sedi\): le nuove classi/)
    expect(avviso).not.toHaveTextContent('iscrizioni aperte')
    expect(avviso).not.toHaveTextContent('in preparazione')

    h.perSede = {
      [SEDE_A]: [riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
      [SEDE_B]: [riga(2026, 'corrente', A26), riga(2027, 'iscrizioni_aperte', A27)],
    }
    cleanup()
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'vai a 2027' }))
    expect(screen.getByRole('status')).toHaveTextContent(/Stai lavorando sul 2027\/28 \(iscrizioni aperte\): le nuove classi, le votazioni e gli elenchi caricati vanno in quell.anno\. Anche gli elenchi delle classi sul video mostrano quell.anno\./)
  })

  it('un docente non lo vede, anche se sceglie un altro anno', () => {
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
