import { describe, it, expect } from 'vitest'
import {
  suggerimentoPrincipaleCf,
  movimentoMultiCf,
  labelPagamentoAperto,
  testoRicercaPagamento,
  riepilogoImport,
  SEMAFORO,
  FILTRI,
  type SuggerimentoUi,
  type EsitoImport,
} from '@/components/features/admin/pagamenti/riconciliazione-ui'

// Logica PURA della lista a semaforo (Riconciliazione v2, lato UI). Contano tre
// cose: quando accendere il badge «CF», quando un movimento è «multi-CF» (aggancio
// «Incasso unico» che UI-2 collega), e che ogni stato abbia una pelle a semaforo.

const cf = (pagamento_id: string, alunno_id: string | null): SuggerimentoUi => ({
  pagamento_id, score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id,
})
const debole = (pagamento_id: string): SuggerimentoUi => ({
  pagamento_id, score: 50, motivi: ['importo esatto'], alunno_id: null,
})

describe('suggerimentoPrincipaleCf', () => {
  it('vero solo se il PRIMO suggerimento è un aggancio per CF', () => {
    expect(suggerimentoPrincipaleCf([cf('p1', 'a1'), debole('p2')])).toBe(true)
  })
  it('falso se il primo suggerimento non è CF (anche con un CF più in basso)', () => {
    expect(suggerimentoPrincipaleCf([debole('p2'), cf('p1', 'a1')])).toBe(false)
  })
  it('falso su lista vuota/assente', () => {
    expect(suggerimentoPrincipaleCf([])).toBe(false)
    expect(suggerimentoPrincipaleCf(null)).toBe(false)
    expect(suggerimentoPrincipaleCf(undefined)).toBe(false)
  })
})

describe('movimentoMultiCf', () => {
  it('vero con ≥2 CF-match su alunni DISTINTI (bonifico di famiglia)', () => {
    expect(movimentoMultiCf([cf('p1', 'a1'), cf('p2', 'a2')])).toBe(true)
  })
  it('falso con un solo CF-match', () => {
    expect(movimentoMultiCf([cf('p1', 'a1'), debole('p2')])).toBe(false)
  })
  it('falso con 2 CF-match sullo STESSO alunno (due voci di un figlio solo)', () => {
    expect(movimentoMultiCf([cf('p1', 'a1'), cf('p2', 'a1')])).toBe(false)
  })
  it('un CF-match senza alunno_id non conta (non raggruppabile)', () => {
    expect(movimentoMultiCf([cf('p1', null), cf('p2', null)])).toBe(false)
  })
  it('falso su lista vuota/assente', () => {
    expect(movimentoMultiCf([])).toBe(false)
    expect(movimentoMultiCf(null)).toBe(false)
  })
})

describe('labelPagamentoAperto / testoRicercaPagamento', () => {
  const p = { id: 'x', descrizione: 'Retta Ottobre', importo: 150, importo_pagato: 30, tipo: 'singolo', alunni: { nome: 'Mara', cognome: 'Bianchi' } }
  it('la label mostra nome, descrizione e residuo formattato', () => {
    const l = labelPagamentoAperto(p)
    expect(l).toContain('Mara Bianchi')
    expect(l).toContain('Retta Ottobre')
    expect(l).toContain('120') // residuo = 150 - 30
  })
  it('il testo di ricerca è minuscolo e contiene nome + descrizione', () => {
    const t = testoRicercaPagamento(p)
    expect(t).toContain('mara bianchi')
    expect(t).toContain('retta ottobre')
  })
})

describe('riepilogoImport — plurale/singolare del toast di import (E2)', () => {
  const base: EsitoImport = { nuovi: 0, duplicati: 0, scartate: 0, suggeriti: 0, da_abbinare: 0 }

  it('con conteggi = 1 usa il SINGOLARE (nessun «1 nuovi movimenti»)', () => {
    const t = riepilogoImport({ ...base, nuovi: 1, suggeriti: 1, duplicati: 1, scartate: 1 })
    expect(t).toContain('1 nuovo movimento')
    expect(t).not.toContain('1 nuovi movimenti')
    expect(t).toContain('1 con suggerimento')
    expect(t).not.toContain('1 con suggerimenti')
    expect(t).toContain('1 già visto')
    expect(t).not.toContain('1 già visti')
    expect(t).toContain('1 riga scartata')
    expect(t).not.toContain('1 righe scartate')
  })

  it('con conteggi > 1 (o 0) usa il PLURALE', () => {
    const t = riepilogoImport({ ...base, nuovi: 3, suggeriti: 2, duplicati: 5, scartate: 0 })
    expect(t).toContain('3 nuovi movimenti')
    expect(t).toContain('2 con suggerimenti')
    expect(t).toContain('5 già visti')
    expect(t).toContain('0 righe scartate')
  })

  it('mostra il dettaglio «per codice fiscale» solo quando con_cf > 0', () => {
    expect(riepilogoImport({ ...base, nuovi: 2, suggeriti: 2, con_cf: 1 })).toContain('1 per codice fiscale')
    expect(riepilogoImport({ ...base, nuovi: 2, suggeriti: 2, con_cf: 0 })).not.toContain('per codice fiscale')
    expect(riepilogoImport({ ...base, nuovi: 2, suggeriti: 2 })).not.toContain('per codice fiscale')
  })
})

describe('SEMAFORO / FILTRI', () => {
  it('ogni stato ha una pelle a semaforo con sfondo PIENO (nessuna opacità Tailwind)', () => {
    for (const stato of ['confermato', 'suggerito', 'da_abbinare', 'ignorato'] as const) {
      const s = SEMAFORO[stato]
      expect(s).toBeDefined()
      expect(s.bg).toMatch(/^bg-kidville-/)
      // niente modificatori di opacità sui fondi colorati (lezione a11y: sotto AA)
      expect(s.bg).not.toMatch(/\//)
      expect(s.testo).not.toMatch(/\//)
      expect(s.hcClass).toContain('kv-recon-row--')
    }
  })
  it('confermato è verde, suggerito giallo, da abbinare rosso, ignorato neutro', () => {
    expect(SEMAFORO.confermato.bg).toBe('bg-kidville-green')
    expect(SEMAFORO.suggerito.bg).toBe('bg-kidville-yellow')
    expect(SEMAFORO.da_abbinare.bg).toContain('error')
    expect(SEMAFORO.ignorato.bg).toContain('neutral')
  })
  it('i filtri coprono tutti gli stati più «Tutti» (id vuoto)', () => {
    expect(FILTRI[0].id).toBe('')
    const ids = FILTRI.map((f) => f.id)
    expect(ids).toEqual(expect.arrayContaining(['', 'da_abbinare', 'suggerito', 'confermato', 'ignorato']))
  })
})
