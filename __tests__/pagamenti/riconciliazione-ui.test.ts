import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  classiChipFatturazione,
  FRASE_FATTURAZIONE,
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
 * ─── LA FUSIONE DELLE DUE FONTI (2026-09-05) ─────────────────────────────────
 *
 * Sulla stessa riga arrivano due dati che parlano della stessa fattura:
 *  · `fattura` — i DOCUMENTI registrati in `fatture_emesse`, col loro NUMERO;
 *  · `fattura_stato` — il riassunto che l'emissione scrive su `pagamenti`.
 *
 * Il chip deve dire il NUMERO quando c'è, perché è ciò con cui si cerca il documento:
 * «Fatturata» è vero e inutile, «Fattura FPR 1947/26» si va a prendere. Questo blocco
 * esiste perché le due fonti convivono: prima della fusione la riga aveva una fonte sola
 * e queste asserzioni non erano nemmeno esprimibili.
 */
describe('chipFatturazione — due fonti sulla stessa riga', () => {
  const mov = (extra: Partial<MovimentoUi>): MovimentoUi => ({
    id: 'm1', data_operazione: '2026-10-05', importo: 150, causale: 'Bonifico',
    stato: 'confermato', pagamento_id: 'pg1', ...extra,
  })

  it('documento emesso → «Fattura FPR 1947/26», MAI il generico «Fatturata»', () => {
    const c = chipFatturazione(mov({
      fattura: { stato: 'emessa', numeri: ['FPR 1947/26'] },
      fattura_stato: 'emessa',
      pagamento_stato: 'pagato',
    }))
    expect(c?.tono).toBe('fatturata')
    expect(c?.labelKey).toBe('reconFatturaEmessa')
    // `n` è il conteggio per il plurale ICU («Fattura»/«Fatture»): un chip con un solo
    // documento dice «Fattura», con due dice «Fatture» — tester localizzazione, 2026-09-05.
    expect(c?.params).toEqual({ n: 1, numeri: 'FPR 1947/26' })
    // la chiave secca perde: con un numero in mano, «Fatturata» è vero e inutile
    expect(c?.labelKey).not.toBe('reconChipFatturata')
  })

  it('due quote → i due numeri nello stesso chip, uniti da « · »', () => {
    const c = chipFatturazione(mov({
      fattura: { stato: 'emessa', numeri: ['FPR 7/26', 'Asilo 2328/2026'] },
      fattura_stato: 'emessa',
    }))
    expect(c?.params).toEqual({ n: 2, numeri: 'FPR 7/26 · Asilo 2328/2026' })
  })

  it('documento emesso ma nessun numero leggibile → si ripiega su «Fatturata», mai su «Fattura »', () => {
    const c = chipFatturazione(mov({ fattura: { stato: 'emessa', numeri: [] }, fattura_stato: 'emessa' }))
    expect(c?.tono).toBe('fatturata')
    expect(c?.labelKey).toBe('reconChipFatturata')
    expect(c?.params).toBeUndefined()
  })

  it('documento SCARTATO → «Scartata, da riemettere» anche se il pagamento dice «emessa»', () => {
    // È il caso che il solo `fattura_stato` sbagliava: il riassunto resta a `emessa`
    // mentre lo SdI ha respinto il documento, e «Fatturata» direbbe «fatto» di un
    // lavoro da rifare.
    const c = chipFatturazione(mov({
      fattura: { stato: 'scartata', numeri: [] },
      fattura_stato: 'emessa',
      pagamento_stato: 'pagato',
    }))
    expect(c?.tono).toBe('scartata')
    expect(c?.labelKey).toBe('reconFatturaScartata')
  })

  it('nessun documento (`da_fatturare`) non basta a chiedere di agire: decidono i due campi del pagamento', () => {
    const senzaDocumenti = { stato: 'da_fatturare' as const, numeri: [] }
    // saldato e mai fatturato → invito ad agire
    expect(chipFatturazione(mov({ fattura: senzaDocumenti, fattura_stato: 'non_richiesta', pagamento_stato: 'pagato' }))?.tono)
      .toBe('da_fatturare')
    // pagamento parziale → nessun chip: l'emissione rifiuterebbe
    expect(chipFatturazione(mov({ fattura: senzaDocumenti, fattura_stato: 'non_richiesta', pagamento_stato: 'parziale' })))
      .toBeNull()
    // documento partito e in viaggio verso lo SdI: lo dice solo il riassunto
    expect(chipFatturazione(mov({ fattura: senzaDocumenti, fattura_stato: 'in_attesa', pagamento_stato: 'pagato' }))?.tono)
      .toBe('attesa')
  })

  it('lettura dei documenti fallita (`fattura: null`) → si ripiega sul riassunto, non si tace', () => {
    const c = chipFatturazione(mov({ fattura: null, fattura_stato: 'emessa', pagamento_stato: 'pagato' }))
    expect(c?.tono).toBe('fatturata')
    expect(c?.labelKey).toBe('reconChipFatturata')
  })

  it('senza `pagamento_id` il documento non conta: nessun chip col numero di roba d’altri', () => {
    const c = chipFatturazione(mov({
      pagamento_id: null,
      stato: 'suggerito',
      fattura: { stato: 'emessa', numeri: ['FPR 1/26'] },
    }))
    expect(c).toBeNull()
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

/**
 * ─── UN SOLO VESTITO PER LO STESSO STATO (2026-09-05) ────────────────────────
 *
 * Fino a oggi «Fatturata» aveva DUE facce: sulla riga era carta bianca con
 * inchiostro verde e un glifo; dentro il popup era un `Badge tone="success"`,
 * cioè oliva su verde tenue, senza glifo. E «Da fatturare», che sulla riga è
 * giallo pieno — l'unico chip che chiede di agire — nel popup era grigio.
 * Lo stesso dato, letto in due punti della stessa schermata, diceva due cose.
 *
 * `classiChipFatturazione` è l'unico posto in cui quel vestito esiste. L'unica
 * differenza ammessa è il FILETTO: sulla riga il chip sta su un fondo pieno e si
 * stacca da sé; sulla carta bianca del popup «Fatturata» (fondo bianco) sparirebbe
 * dentro la card — quindi prende `border-current`, cioè l'inchiostro del tono
 * stesso, che resta a norma senza una seconda tabella di colori da tenere allineata.
 */
describe('classiChipFatturazione — un vestito solo, riga e popup', () => {
  const toni = ['fatturata', 'attesa', 'scartata', 'da_fatturare'] as const

  it('porta sempre l’àncora `kv-recon-chip`, la pelle del tono e la sua classe HC', () => {
    for (const tono of toni) {
      const c = CHIP_FATTURAZIONE[tono]
      const classi = classiChipFatturazione(c)
      expect(classi).toContain('kv-recon-chip')
      expect(classi).toContain(c.bg)
      expect(classi).toContain(c.testo)
      expect(classi).toContain(c.hcClass)
      expect(classi).toContain('rounded-pill')
      expect(classi).toContain('font-barlow')
    }
  })

  /**
   * ⚠️ SULLA CARTA CAMBIA LA FORMA, MAI LA PELLE — ed è una correzione del
   * 2026-09-05, non il contratto di sempre. Fino a ieri il chip sulla carta era
   * la stessa identica pillola della riga più un filetto: accanto ai due pulsanti
   * del riquadro «Documenti» (stessa pillola, stesso filetto verde, stessa
   * altezza) diventava il terzo di tre oggetti uguali, e l'unico che non si preme.
   *
   * Cambia SOLO la geometria — angoli quadri, padding stretto — perché il colore
   * è l'informazione (a che punto è la fattura) e va tenuto identico nei due posti.
   */
  it('su CARTA cambia la FORMA (etichetta, non pillola) ma non la pelle', () => {
    for (const tono of toni) {
      const c = CHIP_FATTURAZIONE[tono]
      const riga = classiChipFatturazione(c).split(' ')
      const carta = classiChipFatturazione(c, true).split(' ')
      // la pelle — fondo, inchiostro, àncora HC, carattere — è la stessa
      for (const invariante of [c.bg, c.testo, c.hcClass, 'kv-recon-chip', 'font-barlow', 'text-[11px]']) {
        expect(riga, `sulla riga manca ${invariante}`).toContain(invariante)
        expect(carta, `sulla carta manca ${invariante}`).toContain(invariante)
      }
      // …e la differenza è tutta e sola di geometria
      const inPiu = carta.filter((x) => !riga.includes(x)).sort()
      const inMeno = riga.filter((x) => !carta.includes(x)).sort()
      expect(inPiu).toEqual(['border-[1.5px]', 'border-current', 'px-2', 'py-1', 'rounded-md'])
      expect(inMeno).toEqual(['px-3', 'py-1.5', 'rounded-pill'])
    }
  })

  it('sulla riga NON c’è filetto (il fondo pieno lo stacca già da sé)', () => {
    expect(classiChipFatturazione(CHIP_FATTURAZIONE.fatturata)).not.toContain('border-')
  })

  it('nessuna opacità e nessun grigio `muted`, in nessuna delle due forme', () => {
    for (const tono of toni) {
      const forme = [classiChipFatturazione(CHIP_FATTURAZIONE[tono]), classiChipFatturazione(CHIP_FATTURAZIONE[tono], true)]
      for (const classi of forme) {
        expect(classi).not.toContain('text-kidville-muted')
        expect(classi).not.toMatch(/(?:bg|text|border)-kidville-[a-z-]+\//)
      }
    }
  })
})

/**
 * ─── LA FRASE È PARTE DELLO STATO, NON UN DI PIÙ ─────────────────────────────
 *
 * Il popup diceva «Fattura già emessa per questo pagamento» anche quando la
 * fattura era «in attesa SDI» — che è FALSO: il documento è partito, la risposta
 * dello SdI non è arrivata, e finché non arriva non è emesso niente. E su
 * «scartata» — l'unico stato che pretende che qualcuno rifaccia il lavoro — non
 * diceva NULLA: un chip rosso e nessuna istruzione.
 *
 * Quattro toni, quattro frasi: una tabella TOTALE, così un tono nuovo non può
 * nascere muto né ereditare per sbaglio la frase di un altro.
 */
describe('FRASE_FATTURAZIONE — una frase per ogni tono, nessuna muta', () => {
  it('copre tutti e quattro i toni con chiavi di catalogo distinte', () => {
    const toni = ['fatturata', 'attesa', 'scartata', 'da_fatturare'] as const
    const chiavi = toni.map((t) => FRASE_FATTURAZIONE[t])
    expect(chiavi.every((k) => typeof k === 'string' && k.length > 0)).toBe(true)
    expect(new Set(chiavi).size, 'quattro stati, quattro frasi diverse').toBe(4)
  })

  it('«in attesa» NON riusa la frase di «emessa» (era il testo falso)', () => {
    expect(FRASE_FATTURAZIONE.attesa).not.toBe(FRASE_FATTURAZIONE.fatturata)
  })
})

/**
 * ─── IL VOCABOLARIO DEI FILTRI È QUELLO DEI CHIP (2026-09-05) ────────────────
 *
 * Il gruppo «Fatturazione» parlava TRE parole — Tutte · Da fatturare · Fatturate —
 * mentre i chip delle righe ne parlano QUATTRO: Da fatturare, Fatturata, In attesa
 * SDI, Scartata. Non è un dettaglio di lessico: premendo «Da fatturare» la lista
 * restituiva una riga col chip «SCARTATA», cioè un'etichetta diversa da quella
 * chiesta, e un filtro che risponde un'altra parola si legge come rotto.
 *
 * I due tagli del server sono e restano due (`z.enum(['da_fatturare','fatturate'])`
 * in `api/pagamenti/riconciliazione`): «da fatturare» comprende le SCARTATE (una
 * fattura respinta va rifatta) e «fatturate» comprende le IN ATTESA (il documento
 * è partito). Non potendo spaccare i tagli senza toccare la rotta, si dicono per
 * intero: l'etichetta nomina tutti gli stati che il suo bidone contiene.
 */
describe('FILTRI_FATTURA — l’etichetta nomina gli stati che contiene', () => {
  const catalogo = (lingua: 'it' | 'en'): Record<string, string> =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'messages', lingua, 'adminContabilita.json'), 'utf8'),
    ) as Record<string, string>

  it('«da fatturare» dice anche le SCARTATE (sono nel suo bidone, e vanno rifatte)', () => {
    const etichetta = catalogo('it')[FILTRI_FATTURA[1].labelKey]
    expect(etichetta.toLowerCase()).toContain('da fatturare')
    expect(
      etichetta.toLowerCase(),
      'il filtro restituisce anche le scartate: se non lo dice, l’etichetta mente',
    ).toContain('scartat')
  })

  it('«fatturate» dice anche le IN ATTESA (il documento è partito, non è tornato)', () => {
    const etichetta = catalogo('it')[FILTRI_FATTURA[2].labelKey]
    expect(etichetta.toLowerCase()).toContain('fatturate')
    expect(etichetta.toLowerCase()).toContain('attesa')
  })

  it('l’etichetta dell’ordinante è quella delle email di sollecito, senza due punti', () => {
    // «Ordinante», non «Intestato a»: nel popup quella riga è CHI HA FATTO il bonifico, mentre
    // «Intestato a» nel resto del prodotto (card del genitore, email) è il BENEFICIARIO del conto.
    // Il tester localizzazione (2026-09-05, sera) ha trovato l'inglese invertito («Payable to»).
    expect(catalogo('it').movdlgOrdinante).toBe('Ordinante')
    // gli altri occhielli non portano i due punti: neanche questo
    expect(catalogo('it').movdlgOrdinante).not.toContain(':')
    expect(catalogo('en').movdlgOrdinante).toBe('Payer')
  })
})

/**
 * ─── LE CHIAVI CHE LA SCHERMATA CHIEDE DEVONO ESISTERE, IN TUTT'E DUE LE LINGUE
 *
 * Una chiave assente non esplode: next-intl scrive a schermo il suo NOME —
 * «adminContabilita.movdlgCausale» — e una schermata di contabilità si mette a
 * parlare in gergo di programmazione davanti alla segreteria. È successo, ed è
 * finito dentro le misure del collaudo (`"testo": "adminContabilita.movdlgCausale"`).
 *
 * Qui si raccolgono le chiavi dai TRE file dell'elemento — quelle chiamate come
 * `t('nome')` e quelle che viaggiano nelle tabelle (`labelKey`, `FRASE_FATTURAZIONE`)
 * — e si pretende che esistano in `it` E in `en`.
 */
describe('i testi della Riconciliazione esistono in italiano e in inglese', () => {
  const sorgenti = [
    'src/components/features/admin/pagamenti/riconciliazione-ui.ts',
    'src/components/features/admin/pagamenti/RiconciliazionePanel.tsx',
    'src/components/features/admin/pagamenti/MovimentoDialog.tsx',
  ]
  const chiaviUsate = (): string[] => {
    const out = new Set<string>()
    for (const f of sorgenti) {
      const testo = readFileSync(join(process.cwd(), f), 'utf8')
      for (const m of testo.matchAll(/\bt\(\s*'([a-zA-Z][A-Za-z0-9]*)'/g)) out.add(m[1])
    }
    // le chiavi che non compaiono come letterale dentro `t(...)`: viaggiano nelle tabelle
    for (const p of Object.values(CHIP_FATTURAZIONE)) out.add(p.labelKey)
    for (const k of Object.values(FRASE_FATTURAZIONE)) out.add(k)
    for (const f of FILTRI_FATTURA) out.add(f.labelKey)
    return [...out]
  }

  it('nessuna chiave orfana: tutte stanno in it e in en', () => {
    const usate = chiaviUsate()
    // CONTROLLO POSITIVO: se l'estrattore smettesse di pescare direbbe «tutto a posto»
    // su un elenco vuoto. Le chiavi di questa schermata sono decine, non tre.
    expect(usate.length, 'l’estrattore delle chiavi non sta più pescando niente').toBeGreaterThan(25)
    const it_ = JSON.parse(readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8')) as Record<string, string>
    const en_ = JSON.parse(readFileSync(join(process.cwd(), 'messages/en/adminContabilita.json'), 'utf8')) as Record<string, string>
    expect(usate.filter((k) => !(k in it_)), 'chiavi senza testo italiano').toEqual([])
    expect(usate.filter((k) => !(k in en_)), 'chiavi senza testo inglese').toEqual([])
  })
})

/**
 * ─── IL CHIP SULLA CARTA NON DEVE SEMBRARE UN PULSANTE ───────────────────────
 *
 * Nel popup «fatturata» il chip di stato era disegnato come i due pulsanti che
 * stanno sessanta pixel più sotto: stessa pillola, stesso filetto, stesso
 * inchiostro, stessa altezza. Uno dei tre non si preme e niente lo diceva.
 *
 * Sulla RIGA il chip resta una pillola — lì convive con l'etichetta di stato, non
 * con dei comandi. Sulla CARTA diventa un'etichetta: angoli quadri e più stretta.
 */
describe('classiChipFatturazione — sulla carta è un’etichetta, non un comando', () => {
  const toni = ['fatturata', 'attesa', 'scartata', 'da_fatturare'] as const

  it('sulla carta perde la forma della pillola (e quindi quella del pulsante)', () => {
    for (const tono of toni) {
      const carta = classiChipFatturazione(CHIP_FATTURAZIONE[tono], true)
      expect(carta).toContain('rounded-md')
      expect(carta, 'una pillola accanto a due pulsanti a pillola è un pulsante').not.toContain('rounded-pill')
      expect(carta).toContain('px-2')
      expect(carta).toContain('py-1')
      // il filetto resta: sulla carta bianca «Fatturata» (fondo bianco) sparirebbe
      expect(carta).toContain('border-current')
    }
  })

  it('sulla riga resta una pillola: lì non c’è nessun pulsante con cui confondersi', () => {
    for (const tono of toni) {
      const riga = classiChipFatturazione(CHIP_FATTURAZIONE[tono])
      expect(riga).toContain('rounded-pill')
      expect(riga).not.toContain('rounded-md')
    }
  })
})
