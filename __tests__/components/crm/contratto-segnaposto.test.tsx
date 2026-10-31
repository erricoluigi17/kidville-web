import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import type { AppuntamentoRow, BambinoRow, SchedaRow } from '@/lib/crm/tipi'
import { ElencoSchede } from '@/components/features/crm/schede/ElencoSchede'
import { DettaglioScheda } from '@/components/features/crm/schede/DettaglioScheda'
import { NuovaScheda } from '@/components/features/crm/schede/NuovaScheda'
import { AgendaSettimana } from '@/components/features/crm/agenda/AgendaSettimana'
import { FissaVisita } from '@/components/features/crm/agenda/FissaVisita'
import { DisponibilitaPersona } from '@/components/features/crm/disponibilita/DisponibilitaPersona'
import { BadgeCollegamento } from '@/components/features/crm/collegamento/BadgeCollegamento'
import { AssociaDomanda } from '@/components/features/crm/collegamento/AssociaDomanda'
import { AvvisoDomandaDaAssociare } from '@/components/features/crm/collegamento/AvvisoDomandaDaAssociare'
import { DaRichiamare } from '@/components/features/crm/follow-up/DaRichiamare'
import { AzioniScheda } from '@/components/features/crm/follow-up/AzioniScheda'
import { StatisticheCrm } from '@/components/features/crm/statistiche/StatisticheCrm'

/**
 * CRM della segreteria · Compito 1.6 — IL CONTRATTO dei dodici segnaposto.
 *
 * Le firme sono ciò che le sei sessioni si sono promesse: la Sessione 2 monta `BadgeCollegamento`
 * senza averlo scritto, la 3 monta `AzioniScheda`, la cornice monta `AgendaSettimana`. Una props
 * rinominata o resa obbligatoria in un file rompe la sessione che lo consuma, che sta lavorando su
 * un altro ramo e se ne accorgerebbe solo al merge.
 *
 * Le due metà:
 *  · i test di TIPO (`expectTypeOf`) sono controllati da `tsc --noEmit`, non da vitest: a
 *    runtime non fanno niente. Il gate li vede perché `tsconfig.json` include `**\/*.tsx`;
 *  · i test di RENDER verificano che ogni segnaposto si monti con quelle props e dica «in
 *    costruzione» finché non c'è la schermata vera.
 *
 * Una sessione che sostituisce un segnaposto tiene queste firme; se ne serve una diversa lo dice
 * nel rapporto, non la cambia di nascosto.
 */

const noop = () => {}

describe('i dodici segnaposto · le firme del contratto', () => {
  it('ElencoSchede', () => {
    expectTypeOf<Parameters<typeof ElencoSchede>[0]>().toEqualTypeOf<{
      scuolaId: string
      onApri: (schedaId: string) => void
    }>()
  })
  it('DettaglioScheda', () => {
    expectTypeOf<Parameters<typeof DettaglioScheda>[0]>().toEqualTypeOf<{
      schedaId: string
      onChiudi: () => void
    }>()
  })
  it('NuovaScheda', () => {
    expectTypeOf<Parameters<typeof NuovaScheda>[0]>().toEqualTypeOf<{
      scuolaId: string
      onCreata: (schedaId: string) => void
      onAnnulla: () => void
    }>()
  })
  it('AgendaSettimana', () => {
    expectTypeOf<Parameters<typeof AgendaSettimana>[0]>().toEqualTypeOf<{
      scuolaId: string
      onApriScheda: (schedaId: string) => void
    }>()
  })
  it('FissaVisita', () => {
    expectTypeOf<Parameters<typeof FissaVisita>[0]>().toEqualTypeOf<{
      scuolaId: string
      schedaId?: string
      appuntamento?: AppuntamentoRow
      inizioProposto?: string
      assegnataProposta?: string
      onFatto: () => void
      onAnnulla: () => void
    }>()
  })
  it('DisponibilitaPersona', () => {
    expectTypeOf<Parameters<typeof DisponibilitaPersona>[0]>().toEqualTypeOf<{ scuolaId: string }>()
  })
  it('BadgeCollegamento', () => {
    expectTypeOf<Parameters<typeof BadgeCollegamento>[0]>().toEqualTypeOf<{ bambino: BambinoRow }>()
  })
  it('AssociaDomanda', () => {
    expectTypeOf<Parameters<typeof AssociaDomanda>[0]>().toEqualTypeOf<{
      scuolaId: string
      schedaId: string
      bambino: BambinoRow
      onCollegato: () => void
    }>()
  })
  it('AvvisoDomandaDaAssociare', () => {
    expectTypeOf<Parameters<typeof AvvisoDomandaDaAssociare>[0]>().toEqualTypeOf<{
      scheda: SchedaRow
      onAggiornata: () => void
    }>()
  })
  it('DaRichiamare', () => {
    expectTypeOf<Parameters<typeof DaRichiamare>[0]>().toEqualTypeOf<{
      scuolaId: string
      onApriScheda: (schedaId: string) => void
    }>()
  })
  it('AzioniScheda', () => {
    expectTypeOf<Parameters<typeof AzioniScheda>[0]>().toEqualTypeOf<{
      scuolaId: string
      schedaId: string
      onAggiornata: () => void
    }>()
  })
  it('StatisticheCrm', () => {
    expectTypeOf<Parameters<typeof StatisticheCrm>[0]>().toEqualTypeOf<{ scuolaId: string }>()
  })
})

describe('i segnaposto ancora in costruzione · si montano con quelle props e lo dicono', () => {
  const bambino = { id: 'bambino-1' } as BambinoRow
  const scheda = { id: 'scheda-1' } as SchedaRow

  const CASI: [string, () => React.ReactElement][] = [
    ['AgendaSettimana', () => <AgendaSettimana scuolaId={SEDE_A} onApriScheda={noop} />],
    ['FissaVisita', () => <FissaVisita scuolaId={SEDE_A} onFatto={noop} onAnnulla={noop} />],
    ['DisponibilitaPersona', () => <DisponibilitaPersona scuolaId={SEDE_A} />],
    ['BadgeCollegamento', () => <BadgeCollegamento bambino={bambino} />],
    ['AssociaDomanda', () => <AssociaDomanda scuolaId={SEDE_A} schedaId="scheda-1" bambino={bambino} onCollegato={noop} />],
    ['AvvisoDomandaDaAssociare', () => <AvvisoDomandaDaAssociare scheda={scheda} onAggiornata={noop} />],
    ['DaRichiamare', () => <DaRichiamare scuolaId={SEDE_A} onApriScheda={noop} />],
    ['AzioniScheda', () => <AzioniScheda scuolaId={SEDE_A} schedaId="scheda-1" onAggiornata={noop} />],
    ['StatisticheCrm', () => <StatisticheCrm scuolaId={SEDE_A} />],
  ]

  // Dodici meno i tre della Sessione 2 (elenco, scheda, nuova famiglia), che non sono più segnaposto:
  // la loro prova è `schede.test.tsx`. Le tre firme restano verificate sopra, a livello di tipo.
  it('sono nove', () => {
    expect(CASI).toHaveLength(9)
  })

  it.each(CASI)('%s', (nome, el) => {
    render(el())
    const riquadro = screen.getByRole('status')
    expect(riquadro.getAttribute('data-crm-segnaposto')).toBe(nome)
    expect(riquadro.textContent).toContain('In costruzione')
  })

  it('FissaVisita passa la scheda quando c’è', () => {
    render(<FissaVisita scuolaId={SEDE_A} schedaId="scheda-9" onFatto={vi.fn()} onAnnulla={vi.fn()} />)
    expect(screen.getByRole('status').getAttribute('data-scheda-id')).toBe('scheda-9')
  })
})
