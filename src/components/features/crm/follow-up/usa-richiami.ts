'use client'

import { useCallback, useEffect, useState } from 'react'
import { leggiAzioni, leggiPersone, type AzioneElenco, type Lettura, type PersonaRichiamo } from './azioni-client'

/**
 * CRM della segreteria · le due letture che i componenti dei richiami condividono.
 *
 * Il `setState` sta nel `.then` e non nel corpo dell'effetto: è la forma che
 * `react-hooks/set-state-in-effect` accetta (la stessa di `ElencoAlunniDocente`). `vivo` scarta una
 * risposta arrivata dopo lo smontaggio o dopo un cambio di filtro.
 *
 * ⚠️ UNA LETTURA VECCHIA NON SI MOSTRA SOTTO UN FILTRO NUOVO. Lo stato porta con sé la CHIAVE per cui
 * è stato letto: se la chiave attuale è un'altra (altra sede, altra persona) la lettura vale `null`,
 * cioè «sto caricando». Senza questo, cambiare persona mostrerebbe per un istante i richiami della
 * precedente sotto il nome della nuova — e uno di quei richiami si può già premere.
 */

type LetturaAzioni = Lettura<AzioneElenco[]>

export function useAzioni(p: { scuolaId: string; responsabile: string | null; schedaId?: string; attiva: boolean }) {
  const { scuolaId, responsabile, schedaId, attiva } = p
  const chiave = `${scuolaId}|${responsabile ?? ''}|${schedaId ?? ''}`
  const [stato, setStato] = useState<{ chiave: string; lettura: LetturaAzioni } | null>(null)
  const [tentativo, setTentativo] = useState(0)

  useEffect(() => {
    if (!attiva) return
    let vivo = true
    void leggiAzioni({ scuolaId, responsabile, schedaId }).then((lettura) => {
      if (vivo) setStato({ chiave, lettura })
    })
    return () => {
      vivo = false
    }
  }, [scuolaId, responsabile, schedaId, attiva, chiave, tentativo])

  const lettura = stato && stato.chiave === chiave ? stato.lettura : null

  /** `silenziosa`: rilegge senza svuotare la lista (dopo un'azione, per non far saltare la pagina). */
  const ricarica = useCallback((silenziosa = false) => {
    if (!silenziosa) setStato(null)
    setTentativo((n) => n + 1)
  }, [])

  return { lettura, ricarica }
}

export function usePersone(scuolaId: string) {
  const [stato, setStato] = useState<{ scuolaId: string; lettura: Lettura<PersonaRichiamo[]> } | null>(null)

  useEffect(() => {
    let vivo = true
    void leggiPersone(scuolaId).then((lettura) => {
      if (vivo) setStato({ scuolaId, lettura })
    })
    return () => {
      vivo = false
    }
  }, [scuolaId])

  const corrente = stato && stato.scuolaId === scuolaId ? stato.lettura : null
  return {
    /** `true` appena la lettura è finita, bene o male: serve a non far partire l'elenco col filtro sbagliato. */
    pronte: corrente !== null,
    persone: corrente?.tipo === 'pronta' ? corrente.dati : [],
    nonLette: corrente?.tipo === 'errore',
  }
}
