import { describe, it, expect } from 'vitest'
import {
  suggerimentoPrincipaleCf,
  movimentoMultiCf,
  labelPagamentoAperto,
  testoRicercaPagamento,
  riepilogoImport,
  SEMAFORO,
  FILTRI,
  chipFatturazione,
  CHIP_FATTURAZIONE,
  FILTRI_FATTURA,
  type SuggerimentoUi,
  type EsitoImport,
  type MovimentoUi,
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

/**
 * I CONTATORI ONESTI ARRIVANO FINO AL TOAST.
 *
 * Sull'estratto annuale le USCITE sono 2.225 righe: finite dentro «scartate» avrebbero
 * detto all'operatore «2.225 righe scartate» su un import perfettamente riuscito — e un
 * numero che allarma su un esito corretto è un numero che si impara a ignorare.
 * Le RIGHE TRONCATE sono l'opposto: sono una perdita vera, e vanno IN EVIDENZA.
 */
describe('riepilogoImport — uscite ignorate e righe non lette', () => {
  const base: EsitoImport = { nuovi: 0, duplicati: 0, scartate: 0, suggeriti: 0, da_abbinare: 0 }

  it('le uscite compaiono solo quando ce ne sono', () => {
    expect(riepilogoImport({ ...base, nuovi: 2, uscite: 3 })).toContain('3 uscite ignorate')
    expect(riepilogoImport({ ...base, nuovi: 2, uscite: 0 })).not.toContain('uscite')
    expect(riepilogoImport({ ...base, nuovi: 2 })).not.toContain('uscite')
  })

  it('una sola uscita si dice al singolare', () => {
    expect(riepilogoImport({ ...base, nuovi: 2, uscite: 1 })).toContain('1 uscita ignorata')
  })

  it('le righe TRONCATE si dicono in evidenza, e solo quando ci sono', () => {
    const t = riepilogoImport({ ...base, nuovi: 20000, troncate: 4 })
    expect(t).toContain('4 righe NON lette')
    expect(riepilogoImport({ ...base, nuovi: 2, troncate: 0 })).not.toContain('NON lette')
  })
})

/**
 * ─── IL CHIP DI FATTURAZIONE, E PERCHÉ NON È UN QUINTO STATO ─────────────────
 *
 * Il registro ha quattro stati e SOLI quattro (`CHECK (stato IN (…))` sul DB):
 * la riga diventa verde alla conferma e resta identica per sempre, anche dopo
 * l'emissione della fattura — che scrive su `pagamenti.fattura_stato`, mai sul
 * movimento. Su un registro globale con centinaia di righe verdi indistinguibili
 * nessuno può dire quali restano da fatturare: SALTARE una fattura è il difetto
 * reale, e non è mitigato da niente (fatturare due volte lo ferma la guardia di
 * idempotenza dell'emissione, saltarla non la ferma nessuno).
 *
 * Il dato è DERIVATO — `movimento.pagamento_id → pagamenti.fattura_stato` — e
 * derivato resta: nessuna colonna nuova su un registro append-only. Qui si blocca
 * la tabella di verità della funzione che lo traduce in un chip.
 *
 * ⚠️ «Da fatturare» è l'UNICO caso che dipende da due campi insieme: la fattura
 * non richiesta su un pagamento NON saldato non è un invito ad agire, è rumore.
 */
describe('chipFatturazione — tabella di verità', () => {
  const mov = (extra: Partial<MovimentoUi>): MovimentoUi => ({
    id: 'm1', data_operazione: '2026-10-05', importo: 150, causale: 'Bonifico',
    stato: 'confermato', pagamento_id: 'pg1', ...extra,
  })

  it('in_attesa → «In attesa SDI» (a prescindere dallo stato del pagamento)', () => {
    const c = chipFatturazione(mov({ fattura_stato: 'in_attesa', pagamento_stato: 'pagato' }))
    expect(c?.tono).toBe('attesa')
    expect(c?.labelKey).toBe('reconChipAttesaSdi')
    expect(chipFatturazione(mov({ fattura_stato: 'in_attesa', pagamento_stato: 'parziale' }))?.tono).toBe('attesa')
  })

  it('emessa → «Fatturata»', () => {
    const c = chipFatturazione(mov({ fattura_stato: 'emessa', pagamento_stato: 'pagato' }))
    expect(c?.tono).toBe('fatturata')
    expect(c?.labelKey).toBe('reconChipFatturata')
  })

  it('scartata → «Scartata» (lo SdI ha rifiutato: va rifatta, non è un dettaglio)', () => {
    const c = chipFatturazione(mov({ fattura_stato: 'scartata', pagamento_stato: 'pagato' }))
    expect(c?.tono).toBe('scartata')
    expect(c?.labelKey).toBe('reconChipScartata')
  })

  it('non_richiesta + pagamento SALDATO → «Da fatturare» (l’unico chip che chiede di agire)', () => {
    const c = chipFatturazione(mov({ fattura_stato: 'non_richiesta', pagamento_stato: 'pagato' }))
    expect(c?.tono).toBe('da_fatturare')
    expect(c?.labelKey).toBe('reconChipDaFatturare')
  })

  it('non_richiesta + pagamento NON saldato → nessun chip (parziale/non_pagato/assente)', () => {
    for (const p of ['parziale', 'non_pagato', 'annullato', null, undefined]) {
      expect(chipFatturazione(mov({ fattura_stato: 'non_richiesta', pagamento_stato: p }))).toBeNull()
    }
  })

  it('senza campi di fatturazione → nessun chip (riga non confermata o di un’altra sede)', () => {
    expect(chipFatturazione(mov({ stato: 'suggerito', pagamento_id: null }))).toBeNull()
    expect(chipFatturazione(mov({ fattura_stato: null, pagamento_stato: null }))).toBeNull()
    expect(chipFatturazione(mov({ stato: 'da_abbinare' }))).toBeNull()
    expect(chipFatturazione(mov({ stato: 'ignorato' }))).toBeNull()
  })

  it('uno stato di fatturazione sconosciuto non inventa un chip', () => {
    expect(chipFatturazione(mov({ fattura_stato: 'boh' as never, pagamento_stato: 'pagato' }))).toBeNull()
  })
})

/**
 * La PELLE del chip vive sopra il fondo VERDE della riga confermata: qui gli
 * sfondi pieni non sono un vezzo, sono l'unica cosa che tiene il contrasto.
 * `bg-kidville-white/70` su verde scenderebbe sotto AA — la stessa lezione già
 * pagata dal semaforo (varianti PIENE, mai opacità Tailwind).
 */
describe('CHIP_FATTURAZIONE / FILTRI_FATTURA', () => {
  it('ogni tono ha fondo PIENO e ancora HC, nessuna opacità e nessun «muted»', () => {
    for (const tono of ['fatturata', 'attesa', 'scartata', 'da_fatturare'] as const) {
      const p = CHIP_FATTURAZIONE[tono]
      expect(p.bg).toMatch(/^bg-kidville-/)
      expect(p.bg).not.toMatch(/\//)
      expect(p.testo).not.toMatch(/\//)
      expect(p.testo).not.toContain('text-kidville-muted')
      expect(p.hcClass).toContain('kv-recon-chip--')
    }
  })

  it('i tre chip informativi sono su carta bianca; «Da fatturare» è giallo pieno su inchiostro (7,3:1)', () => {
    expect(CHIP_FATTURAZIONE.fatturata.bg).toBe('bg-kidville-white')
    expect(CHIP_FATTURAZIONE.fatturata.testo).toBe('text-kidville-green')
    expect(CHIP_FATTURAZIONE.attesa.testo).toBe('text-kidville-warn-strong')
    expect(CHIP_FATTURAZIONE.scartata.testo).toBe('text-kidville-error-strong')
    expect(CHIP_FATTURAZIONE.da_fatturare.bg).toBe('bg-kidville-yellow')
    expect(CHIP_FATTURAZIONE.da_fatturare.testo).toBe('text-kidville-ink')
  })

  it('il sottofiltro di fatturazione ha «Tutte» (id vuoto) più i due tagli utili', () => {
    expect(FILTRI_FATTURA[0].id).toBe('')
    expect(FILTRI_FATTURA.map((f) => f.id)).toEqual(['', 'da_fatturare', 'fatturate'])
    // le etichette sono CHIAVI di catalogo, non testo cablato (a differenza di FILTRI,
    // gap pre-esistente annotato nello spec)
    expect(FILTRI_FATTURA.map((f) => f.labelKey)).toEqual([
      'reconFiltroTutte', 'reconFiltroDaFatturare', 'reconFiltroFatturate',
    ])
  })
})
