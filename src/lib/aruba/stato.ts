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
