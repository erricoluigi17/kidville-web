'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { useBloccoBiometrico } from '@/components/providers/BiometricGate'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { apriSchedaStore, appDaAggiornare, type PiattaformaStore } from '@/lib/native/aggiornamento-app'

/**
 * IL POP-UP «AGGIORNA L'APP» (spec 2026-09-29). Chi deve aggiornare lo decide
 * `@/lib/native/aggiornamento-app` (versione del binario sotto la minima dello store); qui c'è la
 * finestra. Montato in `RootProviders` DENTRO il gate biometrico, così copre ogni area (genitore,
 * docente, segreteria) e la pagina di login. Sul web, sul server e sulla versione aggiornata non
 * rende niente.
 *
 * «A OGNI APERTURA» (scelta del titolare, 29/09): compare a ogni avvio a freddo e, se era stato
 * chiuso, di nuovo al ritorno in primo piano dopo almeno `RIPROPONI_DOPO_MS` in background. Un
 * passaggio lampo a un'altra app non lo ripropone. Non è bloccante: «Più tardi» (ed Esc, e
 * Indietro su Android, che la `Modal` gira a `onClose`) chiude. Dopo l'aggiornamento il binario
 * nuovo riparte con la versione nuova e il pop-up sparisce da solo.
 *
 * LA DECISIONE È UNA PER SESSIONE, di modulo come in `AvvisiSettimanaliApp`: con lo stato nel
 * componente, il doppio montaggio di StrictMode o un layout che si rimonta rileggerebbero la
 * versione e raddoppierebbero il log. Per lo stesso motivo sono di modulo la chiusura
 * (`chiusoInSessione`) e la comparsa già registrata.
 *
 * IL GATE BIOMETRICO. La `Modal` rende `inert` tutto ciò che sta fuori da lei risalendo fino al
 * `body`: aperta sopra l'overlay di sblocco già a schermo lo renderebbe intoccabile. Si apre solo
 * quando `useBloccoBiometrico()` è falso; se il gate scatta con la finestra aperta, la finestra si
 * toglie e torna allo sblocco.
 *
 * I LOG. Il canale del client accetta solo `warn` ed `error`: comparsa e tocchi escono `warn`, con
 * la piattaforma e l'esito; `versione_app` la aggiunge il logger. Nessun dato personale.
 */

/** Il background oltre il quale il ritorno in primo piano vale come una nuova apertura. */
export const RIPROPONI_DOPO_MS = 30 * 60 * 1000

type Decisione = { piattaforma: PiattaformaStore; versione: string } | null

let decisioneSessione: Promise<Decisione> | null = null
let chiusoInSessione = false
let comparsaRegistrata = false
let nascostaDal: number | null = null

function decidiUnaVolta(): Promise<Decisione> {
  if (!decisioneSessione) {
    decisioneSessione = appDaAggiornare().catch((e: unknown) => {
      logClient({
        livello: 'error',
        evento: 'avvio',
        messaggio: `avviso-aggiorna-app-decisione-fallita: ${nomeErrore(e)}`,
      })
      return null
    })
  }
  return decisioneSessione
}

function logAvviso(azione: string, piattaforma: PiattaformaStore, esito?: string): void {
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `avviso-aggiorna-app-${azione}`,
    campi: { piattaforma, ...(esito ? { esito } : {}) },
  })
}

export function AvvisoAggiornamentoApp() {
  const t = useTranslations('shared')
  const bloccato = useBloccoBiometrico()
  const [decisione, setDecisione] = useState<Decisione>(null)
  const [aperto, setAperto] = useState(false)

  useEffect(() => {
    let attivo = true
    void decidiUnaVolta().then((d) => {
      if (!attivo || !d) return
      setDecisione(d)
      if (!chiusoInSessione) setAperto(true)
    })

    const alCambioVisibilita = () => {
      if (document.visibilityState === 'hidden') {
        nascostaDal = Date.now()
        return
      }
      const dal = nascostaDal
      nascostaDal = null
      if (dal === null || Date.now() - dal < RIPROPONI_DOPO_MS) return
      void decidiUnaVolta().then((d) => {
        // Ancora aperto (mai chiuso): è la stessa comparsa, niente da riproporre.
        if (!attivo || !d || !chiusoInSessione) return
        // Una nuova apertura: una nuova comparsa, e il suo log.
        chiusoInSessione = false
        comparsaRegistrata = false
        setAperto(true)
      })
    }
    document.addEventListener('visibilitychange', alCambioVisibilita)
    return () => {
      attivo = false
      document.removeEventListener('visibilitychange', alCambioVisibilita)
    }
  }, [])

  const visibile = aperto && !bloccato && decisione !== null

  useEffect(() => {
    if (!visibile || !decisione || comparsaRegistrata) return
    comparsaRegistrata = true
    logAvviso('mostrato', decisione.piattaforma)
  }, [visibile, decisione])

  if (!decisione) return null

  const rimanda = () => {
    logAvviso('rimandato', decisione.piattaforma)
    chiusoInSessione = true
    setAperto(false)
  }

  const aggiorna = () => {
    const url = apriSchedaStore()
    // «navigazione-richiesta», non «aperto»: il codice chiede al sistema di aprire la scheda, ma
    // non sa se lo store si è aperto davvero. Il log dice solo questo.
    logAvviso('tocco-store', decisione.piattaforma, url ? 'navigazione-richiesta' : 'piattaforma-sconosciuta')
    if (url) {
      chiusoInSessione = true
      setAperto(false)
    }
  }

  return (
    <Modal
      open={visibile}
      onClose={rimanda}
      title={t('avvisoAggiornaTitolo')}
      labelledBy="avviso-aggiorna-app-titolo"
      closeOnBackdrop={false}
      safeArea
      className="w-full max-w-sm rounded-card bg-kidville-white p-6 text-center shadow-xl"
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-kidville-cream text-kidville-green">
        <Download aria-hidden="true" className="h-7 w-7" />
      </div>
      <h2
        id="avviso-aggiorna-app-titolo"
        className="mt-4 font-barlow text-xl font-extrabold uppercase text-kidville-green"
      >
        {t('avvisoAggiornaTitolo')}
      </h2>
      <p className="mt-2 font-maven text-[15px] text-kidville-sub">{t('avvisoAggiornaCorpo')}</p>
      <button
        type="button"
        onClick={aggiorna}
        className="mt-5 min-h-[44px] w-full rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
      >
        {t('avvisoAggiornaBottone')}
      </button>
      <button
        type="button"
        onClick={rimanda}
        className="mt-2 min-h-[44px] w-full rounded-full px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-sub hover:bg-kidville-cream"
      >
        {t('avvisoAggiornaPiuTardi')}
      </button>
    </Modal>
  )
}
