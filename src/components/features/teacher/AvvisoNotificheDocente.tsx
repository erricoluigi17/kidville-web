'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BellOff } from 'lucide-react'
import { isNativeApp, registerNativePush, statoPermessoPush } from '@/lib/push/native-register'
import { apriImpostazioniNotifiche, impostazioniApribili } from '@/lib/native/avvisi-settimanali'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { esitoPushRitentabile } from '@/lib/push/esiti-ritentabili'
import { ascoltaPushRegistrata } from '@/lib/push/registrazione-riuscita'
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile'
import { Card } from '@/components/ui/Card'
import { Btn } from '@/components/ui/Btn'

/**
 * «LE NOTIFICHE SONO SPENTE» — l'avviso fisso nella home della docente (compito C1).
 *
 * ─── IL FATTO, misurato (segnalazione del 2026-09-29) ───────────────────────────
 *
 * «I messaggi dei genitori non arrivano alle maestre». Una docente su Android, che apre l'app
 * ogni giorno, ha ricevuto 137 messaggi in 30 giorni senza una sola push: permesso negato
 * (`push-nativa-permesso-negato: denied` nei log da inizio settembre), nessuna riga in
 * `push_subscriptions`, e nessuna schermata che lo dicesse. Questo riquadro lo dice.
 *
 * ─── SUL WEB NON SI ATTIVA NIENTE, SI RIMANDA ALL'APP ───────────────────────────
 *
 * ⚠️ È una decisione di PRIVACY, non di comodità (revisione di qualità, 2026-09-30). Sul web
 * il logout NON annulla l'iscrizione push (`src/lib/auth/logout.ts`), e i PC di segreteria e
 * di classe sono condivisi: chi si siede dopo riceverebbe le notifiche della docente
 * precedente. Fra quelle c'è `mensa_allergia`, che porta nome, sezione e allergeni di un
 * bambino (`src/lib/mensa/notify.ts`) — dati sanitari di un minore a chi passa di lì. In più
 * la POST fa upsert sull'endpoint, quindi il secondo accesso «ruba» il dispositivo al primo.
 * Un avviso che non si chiude spingerebbe a farlo, e su un browser qualunque.
 * Perciò sul web una sola variante, `web-usa-app`: testo, nessun pulsante.
 *
 * ─── NON SI CHIUDE, E TACE QUANDO NON SA ────────────────────────────────────────
 *
 * Nessuna X: finché le notifiche non ci sono, l'avviso resta. Ma in caricamento e su errore
 * non compare NULLA: «non lo so» non vale «non ne hai», e un avviso falso insegna a ignorare
 * quelli veri.
 *
 * ─── IL RAPPORTO CON `AvvisiSettimanaliApp` ─────────────────────────────────────
 *
 * Nell'app esiste già il riquadro settimanale «Notifiche disattivate» (flottante, chiudibile,
 * al massimo una volta a settimana). Condividono la rilevazione — `statoPermessoPush`,
 * `impostazioniApribili`, `apriImpostazioniNotifiche` — quindi partono dallo stesso stato;
 * ma quello NON ricontrolla, perché decide una volta per sessione: concesso il permesso, il
 * suo riquadro resta a schermo finché lo si chiude, mentre questo sparisce da sé. Le due cose
 * possono quindi dirsi diverse per qualche secondo, e la più aggiornata è questa.
 * ⚠️ Resta aperto per il titolare: quando questo avviso è visibile, nell'app quello
 * settimanale dice la stessa cosa una seconda volta. Spegnerlo lì tocca il layout del docente
 * (condiviso col genitore), fuori dal perimetro di C1.
 */

/**
 * Quanto si aspetta fra due controlli, al ritorno visibile della pagina.
 *
 * Il gesto tipico è: apri le Impostazioni, concedi, torni. Senza il ricontrollo l'avviso
 * resterebbe a schermo dopo che il problema è risolto. Senza la soglia, ogni rientro dal
 * background sarebbe una richiesta in più su una home che ne fa già molte (la `/parent` arrivò
 * a 13 endpoint per apertura). Nessun polling: non c'è nessun `setInterval`.
 */
export const INTERVALLO_RICONTROLLO_MS = 30_000

/**
 * Le strade vere, una per situazione. Il nome finisce nel log: dice QUANTE docenti sono in
 * ciascun caso, e quindi dove intervenire.
 *
 *  - `nativo-negato`: permesso `denied` e binario che sa aprire le impostazioni → pulsante;
 *  - `nativo-percorso-manuale`: permesso `denied` ma niente da premere (1.0 senza il plugin,
 *    o apertura fallita) → il percorso a parole;
 *  - `nativo-attiva`: permesso da chiedere, o concesso ma senza token sul server;
 *  - `nativo-non-disponibile`: il bridge non risponde o il plugin push manca dal binario. Non
 *    è una scelta dell'utente: è l'app da aggiornare, e dirgli «consenti le notifiche» lo
 *    manderebbe a cercare un interruttore che è già come deve essere;
 *  - `web-usa-app`: browser. Solo testo (vedi la testata).
 */
export type VarianteAvvisoNotifiche =
  | 'nativo-negato'
  | 'nativo-percorso-manuale'
  | 'nativo-attiva'
  | 'nativo-non-disponibile'
  | 'web-usa-app'

type Stato =
  | { fase: 'carico' }
  /** Dispositivi iscritti e permesso a posto, oppure conteggio illeggibile: niente a schermo. */
  | { fase: 'nascosto' }
  | { fase: 'mostro'; variante: VarianteAvvisoNotifiche }

/**
 * Il log della comparsa è UNO per sessione, e il flag sta nel MODULO: la home si rimonta (una
 * navigazione fuori da `(dashboard)/teacher` e il ritorno con Indietro), e con lo stato nel
 * componente il conteggio misurerebbe i rimontaggi invece delle persone. Stessa ragione di
 * `comparsaRegistrata` in `AvvisiSettimanaliApp`.
 */
let comparsaRegistrata = false

/** La strada da offrire, chiesta al dispositivo e non indovinata. */
async function varianteNativa(): Promise<VarianteAvvisoNotifiche> {
  const permesso = await statoPermessoPush()
  if (permesso === 'denied') return impostazioniApribili() ? 'nativo-negato' : 'nativo-percorso-manuale'
  // `granted` compreso: il permesso c'è ma la riga in tabella no — «Attiva» rifà la
  // registrazione del token, che è esattamente ciò che manca.
  if (permesso === 'granted' || permesso === 'prompt') return 'nativo-attiva'
  // `non-disponibile`: plugin assente o bridge muto. Un difetto dell'app, non dell'utente.
  return 'nativo-non-disponibile'
}

interface Props {
  /**
   * L'identità già risolta dalla pagina. Una seconda `useSessionIdentity` qui dentro
   * significherebbe un secondo giro di risoluzione (e `useSearchParams`/`useRouter` montati
   * due volte) per un dato che il chiamante ha già.
   *
   * Non serve alla lettura — la route usa l'identità del GATE — ma dice se la sessione è
   * pronta: finché non lo è, non si conta niente.
   */
  userId: string | null
}

export function AvvisoNotificheDocente({ userId }: Props) {
  const t = useTranslations('teacherNav')
  const [stato, setStato] = useState<Stato>({ fase: 'carico' })
  /** L'errore appartiene alla VARIANTE che l'ha prodotto: vedi `errorePerVariante`. */
  const [errore, setErrore] = useState<{ variante: VarianteAvvisoNotifiche; ritentabile: boolean } | null>(null)
  const [inAttesa, setInAttesa] = useState(false)
  /** L'ora dell'ultimo controllo partito: è ciò su cui si misura la soglia. */
  const ultimoControllo = useRef(0)
  /** Un controllo in volo non si duplica (StrictMode monta due volte l'effetto). */
  const inCorso = useRef(false)
  /** Un gesto esplicito arrivato mentre un controllo era in volo: si rifà appena finisce. */
  const daRifare = useRef(false)
  /**
   * ⚠️ IL RIENTRO DOPO LE IMPOSTAZIONI SALTA LA SOGLIA, UNA VOLTA. È il difetto di iOS
   * (revisione di qualità, 2026-09-30).
   *
   * `capacitor-native-settings` 8.2.0 risolve `open()` in due momenti diversi: su **Android**
   * al RITORNO (`startActivityForResult` + `@ActivityCallback`), su **iOS** alla PARTENZA
   * (`UIApplication.shared.open(url) { success in call.resolve(…) }`). Su iOS, quindi, il
   * ricontrollo chiesto dal gesto legge il permesso ANCORA negato e aggiorna l'orologio della
   * soglia: la maestra concede, rientra dopo dieci secondi, e trova «spente» con il permesso
   * appena dato — l'avviso che si smentisce da solo, che è tutto ciò che gli si chiede di non
   * fare. Un `ultimoControllo.current = 0` dopo il gesto non basterebbe: se un controllo è già
   * in volo, è quel giro a riscrivere l'orologio quando finisce.
   */
  const rientroDaControllare = useRef(false)
  const montato = useRef(true)
  const titolo = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    montato.current = true
    return () => {
      montato.current = false
    }
  }, [])

  /**
   * ⚠️ `try` + `finally`, MAI un `catch` qui dentro: è la forma che
   * `react-hooks/set-state-in-effect` accetta per una `useCallback` async chiamata da un
   * effetto (con un `catch` interno l'analizzatore vede il `setState` come sincrono e il lint
   * è rosso a parità di logica). Gli errori si raccolgono al punto di chiamata
   * (`riportaGuasto`). Stessa forma di `PagamentiSummary.tsx`.
   */
  const controlla = useCallback(async (perGesto = false) => {
    // Un controllo chiesto mentre un altro è in volo non parte due volte. Se lo ha chiesto un
    // GESTO (`perGesto`) non si perde: si segna, e lo rifà il giro che sta finendo (il
    // `do … while` qui sotto) — senza, «Apri Impostazioni» seguito da un rientro rapido
    // resterebbe senza il suo ricontrollo. I due effetti di StrictMode, invece, non sono due
    // gesti: il secondo esce e basta, altrimenti sarebbe un conteggio in più a ogni apertura.
    if (inCorso.current) {
      if (perGesto) daRifare.current = true
      return
    }
    inCorso.current = true
    try {
      do {
        daRifare.current = false
        ultimoControllo.current = Date.now()
        const res = await fetch('/api/push/subscribe')
        // Il 500 il server l'ha già loggato col suo codice (`PUSH_STATO_NON_LETTO`). Una
        // forma inattesa del corpo è un «non lo so», non uno zero.
        const corpo: unknown = res.ok ? await res.json() : null
        const dispositivi = (corpo as { dispositivi?: unknown } | null)?.dispositivi
        let variante: VarianteAvvisoNotifiche | null = null
        if (typeof dispositivi === 'number') {
          if (!isNativeApp()) {
            variante = dispositivi === 0 ? 'web-usa-app' : null
          } else if (dispositivi === 0) {
            variante = await varianteNativa()
          } else {
            // ⚠️ IL CONTEGGIO È PER PERSONA, IL PROBLEMA È PER DISPOSITIVO. Se la maestra
            // spegne le notifiche di Kidville dalle Impostazioni del telefono, la riga resta —
            // FCM e APNs accettano il token comunque, ed è il sistema a buttare la notifica.
            // Con il solo conteggio l'avviso tacerebbe proprio nel caso della segnalazione.
            // Il permesso si chiede solo qui: con zero dispositivi lo chiede `varianteNativa`.
            const permesso = await statoPermessoPush()
            if (permesso === 'denied') {
              variante = impostazioniApribili() ? 'nativo-negato' : 'nativo-percorso-manuale'
            }
          }
        }
        if (montato.current) setStato(variante === null ? { fase: 'nascosto' } : { fase: 'mostro', variante })
      } while (daRifare.current && montato.current)
    } finally {
      inCorso.current = false
      daRifare.current = false
    }
  }, [])

  /**
   * Il guasto della lettura, loggato: un `catch` che non logga è un bug, e questa è l'unica
   * traccia possibile di una fetch che non è mai partita — il server non la vede. Si nasconde:
   * «non lo so» non vale «non ne hai».
   */
  const riportaGuasto = useCallback((e: unknown) => {
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `avviso-notifiche-docente-stato-illeggibile: ${nomeErrore(e)}`,
    })
    if (montato.current) setStato({ fase: 'nascosto' })
  }, [])

  useEffect(() => {
    // Identità non ancora risolta: non si conta niente (e non si mostra niente).
    if (userId === null) return
    controlla().catch(riportaGuasto)
  }, [userId, controlla, riportaGuasto])

  /**
   * IL RITORNO IN PRIMO PIANO, DA ENTRAMBI I SEGNALI.
   *
   * `usePollingVisibile` con `intervalloMs: null` è «solo al ritorno, nessun orologio»: ascolta
   * `visibilitychange` **e** `appStateChange` del bridge nativo, e li coalesce (nell'app arrivano
   * entrambi, a distanza di pochi millisecondi). Con il solo `visibilitychange` il rientro
   * dall'app in background si perdeva su parte dei dispositivi — è la regola dei due segnali
   * che il repo applica già in `NativePushAutoRegister` e in tutto il polling.
   */
  const alRitorno = useCallback(() => {
    // Il rientro ATTESO (si è appena toccato «Apri Impostazioni») passa una volta sola e senza
    // guardare la soglia: è il solo momento in cui il permesso può essere cambiato fuori
    // dall'app, e su iOS il ricontrollo del gesto è arrivato troppo presto per vederlo.
    const atteso = rientroDaControllare.current
    if (atteso) rientroDaControllare.current = false
    else if (Date.now() - ultimoControllo.current < INTERVALLO_RICONTROLLO_MS) return
    controlla(atteso).catch(riportaGuasto)
  }, [controlla, riportaGuasto])

  usePollingVisibile(alRitorno, null)

  /**
   * LA REGISTRAZIONE RIUSCITA ALTROVE NELLA PAGINA.
   *
   * `NativePushAutoRegister` vive nel layout e registra il token al primo accesso, mentre
   * questo riquadro sta già leggendo il conteggio: la sua risposta arriva prima, dice «zero
   * dispositivi» e mostra «Attiva». Poi la maestra tocca «Consenti», la registrazione riesce, e
   * senza questo ascolto l'avviso resterebbe a dire il falso — la soglia scarterebbe anche un
   * `visibilitychange` immediato. Si ricontrolla come per un GESTO: niente soglia, e se un
   * controllo è in volo quello nuovo si accoda invece di perdersi.
   */
  useEffect(() => ascoltaPushRegistrata(() => {
    controlla(true).catch(riportaGuasto)
  }), [controlla, riportaGuasto])

  const variante = stato.fase === 'mostro' ? stato.variante : null

  useEffect(() => {
    if (variante === null || comparsaRegistrata) return
    comparsaRegistrata = true
    // `warn` perché il canale del client accetta solo `warn` ed `error`, ed è la misura che
    // serve: quante docenti non riceveranno niente, e per quale motivo. Nessun dato personale:
    // la variante e nient'altro (piattaforma e versione le aggiunge il canale al flush).
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `avviso-notifiche-docente-mostrato: ${variante}`,
    })
  }, [variante])

  /**
   * IL FUOCO NON SI PERDE AL CAMBIO DI STRADA. Quando il pulsante che si è appena premuto
   * scompare (da «Attiva» a «Apri Impostazioni», o al percorso a parole), il fuoco tornerebbe
   * su `<body>`: chi naviga da tastiera si ritroverebbe all'inizio della pagina senza sapere
   * che cosa è cambiato. Si porta sul titolo, che è anche il contesto dell'accaduto.
   *
   * ⚠️ MA SOLO SE ERA NOSTRO. Un ricontrollo automatico al rientro può cambiare la variante
   * mentre la maestra sta scrivendo altrove nella pagina: rubarle il fuoco lì sarebbe un
   * difetto peggiore di quello che si sta chiudendo. Si interviene se il fuoco è su `<body>`
   * (nessuno lo sta usando) o se è dentro questo riquadro (era su un pulsante che è appena
   * scomparso). E `preventScroll`, perché lo spostamento non deve far saltare la pagina.
   */
  const varianteVista = useRef<VarianteAvvisoNotifiche | null>(null)
  const riquadro = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const prima = varianteVista.current
    varianteVista.current = variante
    if (variante === null || prima === null || prima === variante) return
    const attivo = document.activeElement
    const nostro = attivo === null || attivo === document.body || riquadro.current?.contains(attivo) === true
    if (!nostro) return
    titolo.current?.focus({ preventScroll: true })
  }, [variante])

  if (variante === null) return null

  /**
   * L'errore si mostra solo se appartiene alla variante a schermo.
   *
   * Un rifiuto di «Attiva» seguito da un cambio di strada — anche deciso da un RICONTROLLO,
   * non solo dal rifiuto stesso — lascerebbe «riprova fra qualche istante» accanto a «Apri
   * Impostazioni»: due frasi che si contraddicono, e la seconda è un invito a ripetere un
   * gesto che non può più riuscire.
   */
  const errorePerVariante = errore !== null && errore.variante === variante ? errore : null

  const apri = async () => {
    // Si accende PRIMA di aprire: su iOS `open()` si risolve alla partenza, e fra quella
    // risoluzione e il rientro può non passare niente di nostro.
    rientroDaControllare.current = true
    const esito = await apriImpostazioniNotifiche()
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: 'avviso-notifiche-docente-tocco-impostazioni',
      campi: { esito },
    })
    if (esito !== 'aperte') {
      // Le impostazioni non si sono aperte: il pulsante lascia il posto al percorso a parole.
      // Restare con un pulsante che non apre niente farebbe credere alla maestra di aver
      // sbagliato lei. E il rientro non è più atteso: non si è aperto niente.
      rientroDaControllare.current = false
      setStato({ fase: 'mostro', variante: 'nativo-percorso-manuale' })
      return
    }
    // Il giro nelle Impostazioni dura meno di trenta secondi: al rientro la soglia bloccherebbe
    // il ricontrollo, e la maestra rivedrebbe «spente» col permesso appena concesso. Il
    // ricontrollo si chiede ADESSO, e `perGesto` fa sì che non si perda se ne trova uno in volo.
    await controlla(true).catch(riportaGuasto)
  }

  const attiva = async () => {
    if (inAttesa) return // `aria-disabled` non blocca il click: la guardia è qui
    setInAttesa(true)
    setErrore(null)
    try {
      const esito = await registerNativePush()
      if (!esito.ok) {
        // Il motivo preciso l'ha già scritto `registerNativePush`. Qui si ridetermina la
        // strada, perché il rifiuto può averla cambiata: se la maestra ha detto «no» al
        // dialogo il permesso è ora `denied`, e l'unica via che resta è «Apri Impostazioni».
        const dopo = await varianteNativa()
        if (!montato.current) return
        setStato({ fase: 'mostro', variante: dopo })
        // Il messaggio si mostra solo se la strada è RESTATA la stessa: quando cambia (il
        // «no» al dialogo porta a «Apri Impostazioni») la strada nuova è già il messaggio, e
        // due frasi insieme si contraddirebbero. «Riprova» solo per ciò che ha senso riprovare.
        if (dopo === variante) {
          // La classificazione è quella condivisa con `NativePushAutoRegister` e `PushOptIn`.
          setErrore({ variante: dopo, ritentabile: esitoPushRitentabile(esito.error) })
        }
        return
      }
      await controlla(true).catch(riportaGuasto)
    } finally {
      if (montato.current) setInAttesa(false)
    }
  }

  return (
    // Nessun bordo: `--color-kidville-line` su bianco vale 1,23:1 (lo dice `globals.css`) e
    // sarebbe decorazione invisibile. Il segnale è la pastiglia ambra, con la coppia
    // `warn-soft`/`warn-strong` già misurata (4,95:1), che in Alto Contrasto non si ribalta.
    <Card className="mt-4 p-4">
      {/* Il `ref` sta qui e non su `Card`: quel componente non inoltra il proprio (e
          aggiungerglielo toccherebbe ogni card dell'app per un bisogno di questa sola). Il
          contenitore interno racchiude tutto ciò che serve a `contains`. */}
      <div ref={riquadro} className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kidville-warn-soft text-kidville-warn-strong"
        >
          <BellOff size={18} />
        </span>
        <div className="min-w-0">
          {/* `text-kidville-green` come il riquadro settimanale (6,4:1 su bianco, già misurato
              in CI da `e2e/contrasto-schermate`). `tabIndex={-1}`: non entra nella tabulazione,
              ma può ricevere il fuoco quando la strada cambia. */}
          <h2
            ref={titolo}
            tabIndex={-1}
            className="font-barlow text-base font-extrabold uppercase text-kidville-green"
          >
            {t('avvisoNotificheDocenteTitolo')}
          </h2>
          <p className="mt-1 font-maven text-[14px] text-kidville-sub">
            {t(
              variante === 'nativo-negato' || variante === 'nativo-percorso-manuale'
                ? 'avvisoNotificheDocenteCorpoTelefono'
                : 'avvisoNotificheDocenteCorpo',
            )}
          </p>

          {variante === 'nativo-negato' && (
            <Btn size="sm" className="mt-3 min-h-[44px]" onClick={() => void apri()}>
              {t('avvisoNotificheDocenteApri')}
            </Btn>
          )}

          {variante === 'nativo-attiva' && (
            // ⚠️ `aria-disabled`, non `disabled`: mentre la richiesta è in volo il pulsante è
            // un MESSAGGIO, non un controllo spento, e `disabled` farebbe sfogare il fuoco su
            // `<body>` (vedi la testata di `Btn.tsx`). La guardia vera è dentro `attiva()`.
            <Btn
              size="sm"
              className="mt-3 min-h-[44px]"
              aria-disabled={inAttesa || undefined}
              onClick={() => void attiva()}
            >
              {t(inAttesa ? 'avvisoNotificheDocenteAttivazione' : 'avvisoNotificheDocenteAttiva')}
            </Btn>
          )}

          {variante === 'nativo-percorso-manuale' && (
            <p className="mt-2 font-maven text-[14px] font-bold text-kidville-sub">
              {t('avvisoNotificheDocentePercorso')}
            </p>
          )}

          {variante === 'nativo-non-disponibile' && (
            <p className="mt-2 font-maven text-[14px] font-bold text-kidville-sub">
              {t('avvisoNotificheDocenteAggiornaApp')}
            </p>
          )}

          {variante === 'web-usa-app' && (
            <p className="mt-2 font-maven text-[14px] font-bold text-kidville-sub">
              {t('avvisoNotificheDocenteUsaApp')}
            </p>
          )}

          {/* La regione è SEMPRE presente e si riempie: uno `role="status"` inserito già pieno
              non viene annunciato dagli screen reader, perché non c'è stato nessun cambiamento
              dentro una regione che esisteva. */}
          <p role="status" className="mt-2 font-maven text-[13px] text-kidville-error-strong empty:mt-0">
            {errorePerVariante === null
              ? ''
              : t(
                  errorePerVariante.ritentabile
                    ? 'avvisoNotificheDocenteErrore'
                    : 'avvisoNotificheDocenteErroreDefinitivo',
                )}
          </p>
        </div>
      </div>
    </Card>
  )
}
