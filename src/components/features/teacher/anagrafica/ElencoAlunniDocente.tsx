'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { logClient } from '@/lib/logging/client'
import type { ElencoAlunniRisposta } from '@/lib/anagrafiche/docente/tipi'
import { PannelloAlunni } from './PannelloAlunni'

/**
 * Carica l'elenco e solo dopo monta il pannello coi filtri. Una lettura fallita è
 * un errore con «Riprova», mai «nessun bambino»: manderebbe a chiedere alla
 * segreteria una classe che c'è già.
 */

type Lettura = { ok: true; dati: ElencoAlunniRisposta } | { ok: false }

/** La lettura, fuori dal componente: restituisce un esito e logga, non tocca lo stato. */
async function leggiElenco(): Promise<Lettura> {
  const res = await fetch('/api/teacher/alunni', { cache: 'no-store' }).catch(() => null)
  const corpo = res?.ok ? ((await res.json().catch(() => null)) as ElencoAlunniRisposta | null) : null
  if (!corpo || !Array.isArray(corpo.alunni) || !Array.isArray(corpo.sezioni)) {
    logClient({
      livello: res ? 'warn' : 'error',
      evento: 'fetch',
      messaggio: 'elenco anagrafiche docente non letto',
      route: '/teacher/alunni',
      ...(res ? { stato: res.status } : null),
    })
    return { ok: false }
  }
  return { ok: true, dati: corpo }
}

export function ElencoAlunniDocente() {
  const ts = useTranslations('shared')
  const [lettura, setLettura] = useState<Lettura | null>(null)
  const [tentativo, setTentativo] = useState(0)

  // Il `setState` sta nel `.then`: è la forma che `react-hooks/set-state-in-effect`
  // accetta (la stessa di `parent/primaria/valutazioni`). `vivo` scarta una risposta
  // arrivata dopo lo smontaggio o dopo un «Riprova».
  useEffect(() => {
    let vivo = true
    void leggiElenco().then((esito) => {
      if (vivo) setLettura(esito)
    })
    return () => {
      vivo = false
    }
  }, [tentativo])

  const riprova = () => {
    setLettura(null)
    setTentativo((n) => n + 1)
  }

  if (lettura && !lettura.ok) return <StatoElenco stato="errore" testi={testiStatoElenco(ts)} onRiprova={riprova} />
  if (!lettura) return <StatoElenco stato="caricamento" testi={testiStatoElenco(ts)} />
  return <PannelloAlunni dati={lettura.dati} />
}
