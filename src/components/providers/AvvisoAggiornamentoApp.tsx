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
 * `@/lib/native/aggiornamento-app` (versione del binario sotto la minima dello store, per tutti;
 * dal 2026-10-02 anche sotto la minima del PERSONALE, per chi lavora con l'app, spenta finché la 1.2
 * non è sullo store); qui c'è la finestra. Montato in `RootProviders` DENTRO il gate biometrico, così
 * copre ogni area (genitore, docente, segreteria) e la pagina di login. Sul web, sul server e sulla
 * versione aggiornata non rende niente. Il testo è uno solo, per tutti.
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
 * ⚠️ PER IL PERSONALE LA DECISIONE INCLUDE IL RUOLO, e una decisione di sessione lo legge una volta
 * sola. Chi apre l'app GIÀ DENTRO (il caso normale: la sessione resta sul telefono) ha il ruolo al
 * primo colpo. Chi parte dalla schermata di accesso non ce l'ha ancora: per lui la decisione è
 * «niente» per tutta la sessione (nel dubbio non si disturba), e il pop-up della minima del personale
 * compare dall'avvio a freddo successivo. Il login non rimonta questo componente, e rifare la
 * decisione a ogni cambio di pagina sarebbe un'altra macchina a stati: si è scelto di non farlo.
 * Sotto la minima dello store non cambia niente, perché lì il ruolo non serve.
 *
 * IL GATE BIOMETRICO. La `Modal` rende `inert` tutto ciò che sta fuori da lei risalendo fino al
 * `body`: aperta sopra l'overlay di sblocco già a schermo lo renderebbe intoccabile. Si apre solo
 * quando `useBloccoBiometrico()` è falso; se il gate scatta con la finestra aperta, la finestra si
 * toglie e torna allo sblocco.
 *
 * I LOG. Il canale del client accetta solo `warn` ed `error`: comparsa e tocchi escono `warn`, con
 * la piattaforma e l'esito; `versione_app` la aggiunge il logger. Nessun dato personale: il ruolo
 * non entra nei log, e per il personale i messaggi sono gli stessi di tutti (la fascia si legge
 * dalla versione: finché la minima dello store resta sotto quella del personale, una comparsa a una
 * versione che la minima dello store già accetta è per forza del personale).
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

/**
 * PIATTAFORMA E VERSIONE STANNO NEL MESSAGGIO, oltre che nei `campi`. `app_log` accorpa le righe
 * per impronta (`impronta()` in `@/lib/logging/app-log`), e l'impronta contiene il messaggio ma
 * NON la piattaforma né i `campi`: con un messaggio fisso, senza utente (la pagina di login), tutte
 * le comparse del giorno cadevano in UNA riga con piattaforma e versione della PRIMA — e una
 * comparsa sulla 1.1 sarebbe stata sommata alla riga «1.0» senza lasciare traccia (misurato il
 * 29/09 dopo il deploy della #174). Le versioni in circolazione sono poche: la deduplica regge.
 * La versione è quella di `getInfo`, già passata da `confrontaVersioni` (solo cifre e punti).
 */
function logAvviso(azione: string, decisione: NonNullable<Decisione>, esito?: string): void {
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `avviso-aggiorna-app-${azione}: ${decisione.piattaforma} ${decisione.versione}`,
    campi: { piattaforma: decisione.piattaforma, ...(esito ? { esito } : {}) },
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
    logAvviso('mostrato', decisione)
  }, [visibile, decisione])

  if (!decisione) return null

  const rimanda = () => {
    logAvviso('rimandato', decisione)
    chiusoInSessione = true
    setAperto(false)
  }

  const aggiorna = () => {
    const url = apriSchedaStore()
    // «navigazione-richiesta», non «aperto»: il codice chiede al sistema di aprire la scheda, ma
    // non sa se lo store si è aperto davvero. Il log dice solo questo.
    logAvviso('tocco-store', decisione, url ? 'navigazione-richiesta' : 'piattaforma-sconosciuta')
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
