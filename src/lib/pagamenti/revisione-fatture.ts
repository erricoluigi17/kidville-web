export type StatoRevisioneFattura =
  | 'da_verificare'
  | 'ordinaria'
  | 'quote_separate'
  | 'irrisolta'

export type AnomaliaSedePagamento =
  | 'pagamento_non_trovato'
  | 'sede_pagamento_disallineata'

export interface CandidatoRevisioneFattura {
  id: string
  nome: string
  cognome: string
  codice_fiscale: string | null
  account_collegato: boolean
}

export interface FatturaRevisioneWire {
  id: string
  pagamento_id: string
  scuola_id: string
  numero: number
  anno: number
  intestatario: string
  sdi_stato: number | null
  /** Presenza del riferimento; l'API di apertura verifica poi l'oggetto Storage. */
  ha_pdf: boolean
  stato: StatoRevisioneFattura
  definitiva: boolean
  parent_registry_id: string | null
  verificata_il: string | null
  verificata_da: string | null
  candidati: CandidatoRevisioneFattura[]
  /** `null` significa che pagamento e fattura dichiarano la stessa sede. */
  anomalia: AnomaliaSedePagamento | null
}

export interface IrrisoltaRevisioneFattura {
  id: string
  numero: number
  anno: number
  intestatario: string
}

export interface ElencoRevisioneFattureWire {
  fatture: FatturaRevisioneWire[]
  pagina: number
  per_pagina: number
  totale: number
  attiva_il: string | null
  /** Storico con snapshot NULL e senza alcuna decisione esplicita. */
  da_verificare: number
  /** Numero di bozze esplicite, incluse quelle marcate `irrisolta`. */
  revisionate: number
  /** Insieme completo della sede, usato dalla futura attivazione come preview. */
  irrisolte: IrrisoltaRevisioneFattura[]
}

export interface RevisioneSalvata {
  modalita: 'ordinaria' | 'quote_separate' | 'irrisolta'
  parent_registry_id: string | null
  verificata_il: string | null
  verificata_da: string | null
}

function testo(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Nome già cristallizzato nel JSON fiscale: nessun confronto con anagrafiche vive. */
export function nomeIntestatarioDaSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'Intestatario'
  const riga = snapshot as Record<string, unknown>
  const nomePersona = [testo(riga.nome), testo(riga.cognome)].filter(Boolean).join(' ')
  if (nomePersona) return nomePersona
  return testo(riga.nome_completo)
    || testo(riga.denominazione)
    || testo(riga.ragione_sociale)
    || 'Intestatario'
}

/**
 * Lo snapshot fiscale vince sempre sulla bozza. Una bozza conta soltanto per lo
 * storico ancora NULL e non viene mai dedotta da numero, CF, quote o stato SDI.
 */
export function decisioneRevisione(
  snapshot: 'ordinaria' | 'quote_separate' | null,
  parentSnapshot: string | null,
  revisione: RevisioneSalvata | null,
): Pick<
  FatturaRevisioneWire,
  'stato' | 'definitiva' | 'parent_registry_id' | 'verificata_il' | 'verificata_da'
> {
  if (snapshot !== null) {
    return {
      stato: snapshot,
      definitiva: true,
      parent_registry_id: parentSnapshot,
      verificata_il: revisione?.verificata_il ?? null,
      verificata_da: revisione?.verificata_da ?? null,
    }
  }
  if (revisione) {
    return {
      stato: revisione.modalita,
      definitiva: false,
      parent_registry_id: revisione.modalita === 'quote_separate'
        ? revisione.parent_registry_id
        : null,
      verificata_il: revisione.verificata_il,
      verificata_da: revisione.verificata_da,
    }
  }
  return {
    stato: 'da_verificare',
    definitiva: false,
    parent_registry_id: null,
    verificata_il: null,
    verificata_da: null,
  }
}

export function ordinaCandidati(
  candidati: Iterable<CandidatoRevisioneFattura>,
): CandidatoRevisioneFattura[] {
  return [...candidati].sort((a, b) =>
    a.cognome.localeCompare(b.cognome, 'it-IT')
    || a.nome.localeCompare(b.nome, 'it-IT')
    || a.id.localeCompare(b.id),
  )
}
