// ─── Quadratura della transazione unica di famiglia (Contabilità v2 S4) ────────
// Logica pura, condivisa fra UI (TransazioniPanel) e test. La quadratura vera è
// riverificata dalla RPC atomica lato DB; qui si guida la segreteria in tempo reale.

export const round2 = (n: number) => Math.round(n * 100) / 100

export interface VoceResiduo {
    id: string
    /** Residuo effettivo della voce (importo − sconto − già incassato), > 0. */
    residuo: number
}

/**
 * Proposta automatica: alloca `capienza` sulle voci **nell'ordine dato** (il server
 * le manda già più vecchie prima) senza mai sforare. Ritorna una mappa
 * `{ voce.id → importo (stringa) }` con le sole voci toccate; le voci successive
 * all'esaurimento della capienza restano fuori. Gli importi sono arrotondati a 2
 * decimali e la somma non supera mai la capienza.
 */
export function proponiAllocazione(voci: VoceResiduo[], capienza: number): Record<string, string> {
    let resto = round2(capienza)
    const out: Record<string, string> = {}
    for (const v of voci) {
        if (resto <= 0.005) break
        const quota = round2(Math.min(v.residuo, resto))
        if (quota > 0) {
            out[v.id] = String(quota)
            resto = round2(resto - quota)
        }
    }
    return out
}
