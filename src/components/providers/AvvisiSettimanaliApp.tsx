'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
import {
  apriImpostazioniNotifiche,
  apriSchedaStore,
  avvisoDaMostrare,
  impostazioniApribili,
  type AvvisoSettimanale,
} from '@/lib/native/avvisi-settimanali'

/**
 * Gli avvisi settimanali dell'app nativa (compito AV1): «Notifiche disattivate — Apri
 * Impostazioni» e «È disponibile una nuova versione di Kidville». La decisione (quale, e se
 * questa settimana è già comparso) sta in `@/lib/native/avvisi-settimanali`; qui c'è solo il
 * riquadro. Montato accanto a `NativePushAutoRegister` nei layout del genitore e del docente.
 * Sul web e sul server non rende niente.
 *
 * LA DECISIONE È UNA PER SESSIONE, di modulo come `attempted` in `NativePushAutoRegister`. Con
 * lo stato nel componente, il doppio montaggio di React (StrictMode, o un layout che si rimonta)
 * rifarebbe il controllo: il primo giro segna la comparsa, il secondo trova la data di oggi e
 * non mostra niente — l'avviso consumerebbe la sua settimana senza essere mai visto.
 *
 * ANCHE LA CHIUSURA E LA COMPARSA SONO DI SESSIONE. La decisione di modulo sopravvive a un
 * rimontaggio del layout (Profilo → «Privacy» fuori da `(dashboard)/parent` → Indietro): se la
 * chiusura stesse solo nello stato del componente, il rimontaggio riceverebbe la stessa promise
 * già risolta e rimostrerebbe un riquadro che il genitore aveva chiuso — e il log «mostrato»
 * conterebbe due volte. Per questo `chiusoInSessione` (X, impostazioni aperte, store richiesto)
 * e `comparsaRegistrata` (un solo log «mostrato» anche se il riquadro aperto si rimonta).
 *
 * I LOG. Il canale del client accetta solo `warn` ed `error`: la comparsa e i tocchi escono
 * `warn`, e sono al massimo uno per settimana per telefono. Nessun dato personale: il nome
 * dell'avviso, la piattaforma, l'esito.
 */
let decisioneSessione: Promise<AvvisoSettimanale | null> | null = null
let chiusoInSessione = false
let comparsaRegistrata = false

function decidiUnaVolta(): Promise<AvvisoSettimanale | null> {
  if (!decisioneSessione) {
    decisioneSessione = avvisoDaMostrare().catch((e: unknown) => {
      logClient({
        livello: 'error',
        evento: 'avvio',
        messaggio: `avviso-settimanale-decisione-fallita: ${nomeErrore(e)}`,
      })
      return null
    })
  }
  return decisioneSessione
}

function piattaforma(): string {
  try {
    return Capacitor.getPlatform()
  } catch (e) {
    // Solo per i campi del log: il riquadro non ne dipende.
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: `avviso-settimanale-piattaforma-illeggibile: ${nomeErrore(e)}`,
    })
    return 'sconosciuta'
  }
}

const EVENTO: Record<AvvisoSettimanale, 'push' | 'avvio'> = {
  'notifiche-disattivate': 'push',
  'aggiorna-app': 'avvio',
}

function logAvviso(avviso: AvvisoSettimanale, azione: string, esito?: string): void {
  logClient({
    livello: 'warn',
    evento: EVENTO[avviso],
    messaggio: `avviso-${avviso}-${azione}`,
    campi: { piattaforma: piattaforma(), ...(esito ? { esito } : {}) },
  })
}

export function AvvisiSettimanaliApp() {
  const t = useTranslations('shared')
  const [avviso, setAvviso] = useState<AvvisoSettimanale | null>(null)
  // Sulla 1.0 (o se l'apertura fallisce) il bottone lascia il posto al percorso a parole.
  const [percorsoManuale, setPercorsoManuale] = useState(false)

  useEffect(() => {
    let attivo = true
    void decidiUnaVolta().then((deciso) => {
      if (!attivo || !deciso || chiusoInSessione) return
      const manuale = deciso === 'notifiche-disattivate' && !impostazioniApribili()
      setPercorsoManuale(manuale)
      setAvviso(deciso)
      if (!comparsaRegistrata) {
        comparsaRegistrata = true
        logAvviso(deciso, 'mostrato', manuale ? 'percorso-manuale' : 'bottone')
      }
    })
    return () => {
      attivo = false
    }
  }, [])

  if (!avviso) return null

  const chiudi = () => {
    logAvviso(avviso, 'chiuso')
    chiusoInSessione = true
    setAvviso(null)
  }

  const apriImpostazioni = async () => {
    const esito = await apriImpostazioniNotifiche()
    logAvviso('notifiche-disattivate', 'tocco-impostazioni', esito)
    if (esito === 'aperte') {
      chiusoInSessione = true
      setAvviso(null)
    } else setPercorsoManuale(true)
  }

  const apriStore = () => {
    const url = apriSchedaStore()
    // «navigazione-richiesta», non «aperto»: il codice chiede al sistema di aprire la scheda, ma
    // non sa se lo store si è aperto davvero (né se la scheda risponde). Il log dice solo questo.
    logAvviso('aggiorna-app', 'tocco-store', url ? 'navigazione-richiesta' : 'piattaforma-sconosciuta')
    if (url) {
      chiusoInSessione = true
      setAvviso(null)
    }
  }

  const titolo = avviso === 'aggiorna-app' ? t('avvisoAggiornaTitolo') : t('avvisoNotificheTitolo')
  const corpo = avviso === 'aggiorna-app' ? t('avvisoAggiornaCorpo') : t('avvisoNotificheCorpo')

  return (
    <div
      className="fixed inset-x-0 z-40 px-4"
      style={{ bottom: 'calc(var(--kv-bottomnav-h, 72px) + 8px)' }}
    >
      <div
        role="status"
        data-avviso-settimanale={avviso}
        className="relative mx-auto max-w-[430px] rounded-2xl border border-kidville-line bg-kidville-white p-4 pr-12 shadow-lg"
      >
        <button
          type="button"
          onClick={chiudi}
          aria-label={t('avvisoChiudiAria')}
          className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-kidville-sub hover:bg-kidville-cream"
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
        <p className="font-barlow text-base font-extrabold uppercase text-kidville-green">{titolo}</p>
        <p className="mt-1 font-maven text-[14px] text-kidville-sub">{corpo}</p>
        {avviso === 'notifiche-disattivate' && percorsoManuale ? (
          <p className="mt-2 font-maven text-[14px] font-bold text-kidville-sub">{t('avvisoNotifichePercorso')}</p>
        ) : (
          <button
            type="button"
            onClick={avviso === 'aggiorna-app' ? apriStore : () => void apriImpostazioni()}
            className="mt-3 min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
          >
            {avviso === 'aggiorna-app' ? t('avvisoAggiornaBottone') : t('avvisoNotificheApri')}
          </button>
        )}
      </div>
    </div>
  )
}
