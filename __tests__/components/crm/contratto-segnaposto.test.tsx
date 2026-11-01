import { describe, it, expectTypeOf } from 'vitest'
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
 *  · i test di RENDER, che verificavano «in costruzione», sono stati tolti all'integrazione: vedi in fondo.
 *
 * Una sessione che sostituisce un segnaposto tiene queste firme; se ne serve una diversa lo dice
 * nel rapporto, non la cambia di nascosto.
 */

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
      // Compito 8 (disponibilità per settimana): le persone libere di uno slot della sede, per il selettore.
      personeProposte?: string[]
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

// Il secondo blocco di questo file («si montano con quelle props e dicono "in costruzione"») è stato tolto
// all'integrazione (2026-10-31): le sessioni 2–6 hanno sostituito tutti i dodici segnaposto con le schermate
// vere, ognuna col proprio test di comportamento. Resta il contratto che conta, le FIRME qui sopra.
