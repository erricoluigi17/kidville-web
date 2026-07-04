/**
 * Mappa lo stato numerico Aruba (1..10) sullo stato interno `fattura_stato`
 * e su flag operativi (terminale / scarto). Vedi DL-020.
 *
 * Filosofia: una fattura che ha superato i controlli SDI (consegnata/accettata/
 * recapito impossibile/decorrenza termini) è fiscalmente **emessa**; i soli
 * rifiuti (errore elaborazione Aruba / scarto SDI / rifiuto destinatario) sono
 * **scartata** e vanno notificati alla Segreteria; gli stati in volo restano
 * **in_attesa**.
 */

export type FatturaStato = 'non_richiesta' | 'in_attesa' | 'emessa' | 'scartata'

export interface StatoArubaMappato {
  fatturaStato: FatturaStato
  label: string
  isTerminal: boolean
  isScarto: boolean
}

const TABELLA: Record<number, StatoArubaMappato> = {
  1: { fatturaStato: 'in_attesa', label: 'Presa in carico', isTerminal: false, isScarto: false },
  2: { fatturaStato: 'scartata', label: 'Errore di elaborazione', isTerminal: true, isScarto: true },
  3: { fatturaStato: 'in_attesa', label: 'Inviata allo SDI', isTerminal: false, isScarto: false },
  4: { fatturaStato: 'scartata', label: 'Scartata dallo SDI', isTerminal: true, isScarto: true },
  5: { fatturaStato: 'in_attesa', label: 'Non consegnata (SDI ritenta)', isTerminal: false, isScarto: false },
  6: { fatturaStato: 'emessa', label: 'Recapito impossibile (depositata)', isTerminal: true, isScarto: false },
  7: { fatturaStato: 'emessa', label: 'Consegnata', isTerminal: true, isScarto: false },
  8: { fatturaStato: 'emessa', label: 'Accettata', isTerminal: true, isScarto: false },
  9: { fatturaStato: 'scartata', label: 'Rifiutata dal destinatario', isTerminal: true, isScarto: true },
  10: { fatturaStato: 'emessa', label: 'Decorrenza termini', isTerminal: true, isScarto: false },
}

export function mapStatoAruba(code: number): StatoArubaMappato {
  return (
    TABELLA[code] ?? {
      fatturaStato: 'in_attesa',
      label: `Stato sconosciuto (${code})`,
      isTerminal: false,
      isScarto: false,
    }
  )
}

export interface RigaFatturaAgg {
  sdi_stato: number | null
  numero?: number | null
  quota_adult_id?: string | null
}

/**
 * Aggrega lo stato del PAGAMENTO dalle sue righe `fatture_emesse` (una per quota).
 * Regola: uno scarto → `scartata`; tutte le quote emesse/consegnate → `emessa`;
 * altrimenti `in_attesa`. Per ogni quota considera solo la riga più recente
 * (numero massimo), così una quota scartata e poi RI-emessa non blocca l'aggregato.
 */
export function aggregaFatturaStato(righe: RigaFatturaAgg[]): FatturaStato {
  if (!righe || righe.length === 0) return 'in_attesa'
  const perQuota = new Map<string, RigaFatturaAgg>()
  for (const r of righe) {
    const key = r.quota_adult_id ?? '__single__'
    const cur = perQuota.get(key)
    if (!cur || (r.numero ?? 0) >= (cur.numero ?? 0)) perQuota.set(key, r)
  }
  const mapped = [...perQuota.values()].map((r) => mapStatoAruba(r.sdi_stato ?? 1))
  if (mapped.some((m) => m.isScarto)) return 'scartata'
  if (mapped.every((m) => m.fatturaStato === 'emessa')) return 'emessa'
  return 'in_attesa'
}
