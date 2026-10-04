'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TriangleAlert } from 'lucide-react'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { logClient } from '@/lib/logging/client'
import type { ElencoAlunniRisposta } from '@/lib/anagrafiche/docente/tipi'
import { PannelloAlunni } from './PannelloAlunni'

/**
 * Carica l'elenco e solo dopo monta il pannello coi filtri. Una lettura fallita è
 * un errore con «Riprova», mai «nessun bambino»: manderebbe a chiedere alla
 * segreteria una classe che c'è già.
 */

type Lettura = { tipo: 'pronta'; dati: ElencoAlunniRisposta } | { tipo: 'errore' | 'sessione' }

const ROTTA = '/teacher/alunni'

/** La lettura, fuori dal componente: restituisce un esito e logga, non tocca lo stato. */
async function leggiElenco(): Promise<Lettura> {
  // Il fallimento della rete è un VALORE (`null`), non un'eccezione da rincorrere.
  const res = await fetch('/api/teacher/alunni', { cache: 'no-store' }).catch(() => null)
  if (!res) {
    // Senza rete il telefono lo sa già: nessun log (come nella scheda).
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    if (!offline) logClient({ livello: 'error', evento: 'fetch', messaggio: 'elenco anagrafiche docente non raggiunto', route: ROTTA })
    return { tipo: 'errore' }
  }
  // 401 è una risposta di merito: il server l'ha già registrata.
  if (res.status === 401) return { tipo: 'sessione' }
  const corpo = res.ok ? ((await res.json().catch(() => null)) as ElencoAlunniRisposta | null) : null
  if (!corpo || !Array.isArray(corpo.alunni) || !Array.isArray(corpo.sezioni)) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: 'elenco anagrafiche docente non letto', route: ROTTA, stato: res.status })
    return { tipo: 'errore' }
  }
  return { tipo: 'pronta', dati: corpo }
}

export function ElencoAlunniDocente() {
  const t = useTranslations('teacherServizi')
  const ts = useTranslations('shared')
  const [lettura, setLettura] = useState<Lettura | null>(null)
  const [tentativo, setTentativo] = useState(0)
  const esitoRef = useRef<HTMLDivElement>(null)

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
    // Il pulsante sta per sparire: il fuoco va sul contenitore che mostrerà l'esito,
    // non su `<body>` (WCAG 2.4.3).
    esitoRef.current?.focus()
  }

  const testi = testiStatoElenco(ts)

  return (
    <>
      {/* Sempre montato, così dopo «Riprova» il fuoco ha dove stare. Non è una regione
          live: il caricamento ha già il suo `role="status"`, e due regioni annidate
          annuncerebbero due volte. L'anello di fuoco lo disegna la regola globale
          `:focus-visible` di `globals.css`. */}
      <div ref={esitoRef} tabIndex={-1} className="rounded-card">
        {!lettura && <StatoElenco stato="caricamento" testi={testi} />}
        {/* L'esito negativo si annuncia da qui: regione montata DA PRIMA (una regione che
            nasce col proprio testo non annuncia niente), accanto al `role="status"`, non attorno. */}
        <div aria-live="polite">
          {lettura?.tipo === 'errore' && <StatoElenco stato="errore" testi={testi} onRiprova={riprova} />}
          {lettura?.tipo === 'sessione' && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <TriangleAlert size={34} aria-hidden="true" className="text-kidville-error-strong" />
              <p className="max-w-md font-maven text-sm text-kidville-ink">{t('anagraficaErroreSessione')}</p>
              {/* Navigazione piena e non `Link`: il login riparte da zero, senza lo stato della sessione scaduta. */}
              <a
                href="/auth/login"
                className="inline-flex min-h-[44px] items-center rounded-pill bg-kidville-green px-4 font-maven text-sm font-semibold text-white"
              >
                {t('anagraficaAccedi')}
              </a>
            </div>
          )}
        </div>
      </div>
      {lettura?.tipo === 'pronta' && <PannelloAlunni dati={lettura.dati} />}
    </>
  )
}
