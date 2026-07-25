'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { Fingerprint, Lock, Loader2 } from 'lucide-react'
import { isNativeApp } from '@/lib/push/native-register'
import {
  ANNULLAMENTI_BIOMETRIA,
  biometriaAttiva,
  impostaBiometria,
  statoBiometria,
  verificaBiometria,
  type TestiBiometria,
} from '@/lib/native/biometric'
import { doLogout } from '@/lib/auth/logout'
import { isPublicPath } from '@/lib/auth/middleware-rules'
import { haIdentitaLocale } from '@/lib/auth/current-user'
import { logClient } from '@/lib/logging/client'

// Gate di sblocco biometrico OPT-IN. Su web è un passthrough puro. Su nativo,
// SOLO se l'opt-in è attivo E c'è una sessione, mostra un overlay bloccante
// all'avvio e a ogni ritorno in foreground finché la verifica non passa.
//
// Hydration-safe: lo stato iniziale è "sbloccato" (server e primo render client
// mostrano i children identici); il blocco scatta esclusivamente in useEffect
// (lato client), quindi non c'è mismatch. Nessun setState sincrono nel corpo
// dell'effetto: il blocco passa da richiediSblocco() (pattern del repo).
//
// ─── PERCHÉ LE GUARDIE SU pause/resume ──────────────────────────────────────
// L'AuthActivity del plugin biometrico è dichiarata TRASLUCIDA
// (windowIsTranslucent), quindi la MainActivity riceve onPause/onResume ma non
// onStop/onStart. `@capacitor/app` emette `pause`/`resume` dal ciclo di vita
// dell'Activity → scattavano OGNI VOLTA che il prompt si apriva e si chiudeva,
// anche dopo uno sblocco RIUSCITO: il listener richiamava richiediSblocco(),
// che rifaceva setBloccato(true) e riapriva il prompt. Risultato: chi attivava
// lo sblocco restava chiuso fuori dall'app, e l'unico recupero era il
// force-stop, perché l'Activity nativa copriva perfino il bottone «Esci».
//
// Passare ad `appStateChange` NON risolve: su Android arriverebbe comunque un
// `isActive:true` spurio (la traslucenza fa sì che `isActive:false` non venga
// mai emesso), e su iOS quell'evento scatta persino per il Centro di Controllo.
// La soluzione non è cambiare evento, è PRETENDERE DI AVER VISTO UN'USCITA VERA
// prima di ri-bloccare. Tre guardie, in ordine di forza:
//   1. `inCorsoRef`  — nessun prompt concorrente;
//   2. `uscitaAlRef` — si ri-blocca solo dopo un `pause` ACCETTATO, e un
//      `pause` che arriva mentre una verifica è in volo viene rifiutato perché
//      è la nostra AuthActivity. È strutturale, non una stima temporale;
//   3. `GRAZIA_MS`   — seconda rete per le ROM che consegnano il ciclo di vita
//      fuori ordine, cioè dopo che `inCorsoRef` è già tornato falso.
//
// Il re-lock LEGITTIMO continua a funzionare: se l'utente manda l'app in
// background davvero, nessuna verifica è in volo → il `pause` viene accettato →
// al ritorno si ri-blocca.

/**
 * Finestra di grazia dopo la chiusura del prompt nativo. Le guardie che
 * decidono sono la 1 e la 2; questa copre solo la consegna FUORI ORDINE di
 * onPause, che si misura in decine/centinaia di millisecondi anche su un
 * dispositivo lento, con l'animazione di chiusura del BiometricPrompt. 1500 ms
 * è il doppio abbondante di quel fenomeno e resta molto sotto qualunque «sono
 * uscito dall'app e sono tornato» reale, che si misura in secondi. Sbagliare in
 * questa direzione è sicuro: il caso peggiore è saltare un re-lock per 1,5 s su
 * un telefono ancora in mano all'utente.
 */
const GRAZIA_MS = 1500

/** Oltre questa soglia i `resume` senza `pause` diventano un canarino loggato. */
const RESUME_ANOMALI_SOGLIA = 3

export function BiometricGate({
  autenticato,
  children,
}: {
  /** Sessione presente secondo i cookie, calcolata nel root layout server. */
  autenticato: boolean
  children: React.ReactNode
}) {
  const t = useTranslations('shared')
  const pathname = usePathname()
  const [bloccato, setBloccato] = useState(false)
  const [verificaInCorso, setVerificaInCorso] = useState(false)

  // I testi del prompt nativo sono localizzati, ma vanno letti da
  // `richiediSblocco` senza entrare nelle sue deps `[]` (altrimenti il gate si
  // ri-armerebbe ad ogni render). Il ref tiene sempre l'ultima traduzione.
  const leggiTesti = useCallback(
    (): TestiBiometria => ({
      motivo: t('bioMotivo'),
      annulla: t('bioAnnulla'),
      titoloAndroid: t('bioTitoloAndroid'),
      sottotitoloAndroid: t('bioSottotitoloAndroid'),
      fallbackIos: t('bioFallbackIos'),
    }),
    [t],
  )
  const testiRef = useRef<TestiBiometria>(leggiTesti())
  useEffect(() => {
    testiRef.current = leggiTesti()
  }, [leggiTesti])

  const inCorsoRef = useRef(false) // guardia 1: verifica in volo
  const uscitaAlRef = useRef<number | null>(null) // guardia 2: uscita VERA osservata
  const fineVerificaAlRef = useRef(0) // guardia 3: chiusura ultimo prompt
  const resumeIgnoratiRef = useRef(0)

  const richiediSblocco = useCallback(async () => {
    if (inCorsoRef.current) return // GUARDIA 1: niente prompt concorrenti
    inCorsoRef.current = true
    // `await` prima del primo setState + try/finally: è il boundary async che
    // la regola react-hooks/set-state-in-effect accetta anche quando la funzione
    // è invocata dal corpo dell'effetto (il microtask precede il paint → nessun
    // flash del contenuto sotto l'overlay).
    try {
      await Promise.resolve()
      // Si blocca PRIMA di qualunque round-trip nativo: farlo dopo lascerebbe i
      // dati del bambino visibili per qualche frame, cioè una regressione di
      // privacy dentro un fix di privacy.
      setBloccato(true)
      setVerificaInCorso(true)

      // Biometria sparita dopo l'opt-in (dito ri-registrato, Face ID rimosso,
      // codice del dispositivo tolto): nessuno deve restare chiuso fuori dai
      // dati del proprio figlio per una convenienza. `biometryLockout` è invece
      // TEMPORANEO (troppi tentativi): lì il blocco resta e l'opt-in non si tocca.
      const stato = await statoBiometria()
      if (!stato.disponibile && stato.codice !== 'biometryLockout') {
        impostaBiometria(false)
        setBloccato(false)
        logClient({
          livello: 'warn',
          evento: 'biometria',
          messaggio: `gate-biometria-non-disponibile ${stato.codice || 'ignoto'}`,
        })
        return
      }

      const esito = await verificaBiometria(testiRef.current)
      if (esito.ok) {
        setBloccato(false)
      } else if (esito.codice && !ANNULLAMENTI_BIOMETRIA.has(esito.codice)) {
        // Solo i motivi di SISTEMA. Un annullamento dell'utente non è un guasto.
        logClient({
          livello: 'error',
          evento: 'biometria',
          messaggio: `sblocco-fallito ${esito.codice}`,
        })
      }
    } finally {
      inCorsoRef.current = false
      fineVerificaAlRef.current = Date.now() // apre la finestra di grazia
      setVerificaInCorso(false)
    }
  }, [])

  // Il gate NON si arma senza sessione, e `!isPublicPath` non è ridondante: è
  // ciò che rende IMPOSSIBILE coprire /auth/*, qualunque cosa dicano le altre
  // due condizioni. `usePathname()` è reattivo, quindi appena il middleware
  // manda l'utente al login l'overlay sparisce da solo. Il ramo
  // `haIdentitaLocale()` copre la finestra fra il login (che naviga con
  // router.replace, senza ri-renderizzare il root layout server) e il
  // successivo avvio a freddo.
  const armato =
    isNativeApp() &&
    biometriaAttiva() &&
    !isPublicPath(pathname ?? '/') &&
    (autenticato || haIdentitaLocale())

  // Il blocco visibile è la CONGIUNZIONE dei due: così il disarmo (logout, o
  // arrivo su una rotta pubblica) è immediato e si ottiene in fase di render,
  // senza un setState dentro l'effetto — che oltre a essere vietato dalla regola
  // react-hooks/set-state-in-effect costerebbe un render in più proprio mentre
  // l'utente sta cercando di uscire.
  const mostraBlocco = armato && bloccato

  useEffect(() => {
    if (!armato) return
    let disposed = false
    const rimuovi: Array<() => void> = []

    // Blocca subito all'avvio e tenta lo sblocco.
    void richiediSblocco()

    // Ri-blocca al ritorno in foreground (setState nel callback della
    // subscription → esente dalla regola set-state-in-effect).
    void (async () => {
      try {
        const { App } = await import('@capacitor/app')

        const hPause = await App.addListener('pause', () => {
          // GUARDIA 1: il pause è della NOSTRA AuthActivity → non è un'uscita.
          if (inCorsoRef.current) return
          // GUARDIA 3: consegna fuori ordine della stessa AuthActivity.
          if (Date.now() - fineVerificaAlRef.current < GRAZIA_MS) return
          uscitaAlRef.current = Date.now()
        })

        const hResume = await App.addListener('resume', () => {
          // GUARDIA 2: rientro senza uscita osservata = chiusura del prompt.
          if (uscitaAlRef.current === null) {
            resumeIgnoratiRef.current++
            if (resumeIgnoratiRef.current === RESUME_ANOMALI_SOGLIA) {
              // Canarino: col fix questa riga non deve MAI comparire. Se compare,
              // una ROM consegna il ciclo di vita diversamente e lo scopriamo noi
              // invece degli utenti.
              logClient({
                livello: 'warn',
                evento: 'biometria',
                messaggio: 'gate-resume-anomalo',
              })
            }
            return
          }
          uscitaAlRef.current = null
          resumeIgnoratiRef.current = 0
          void richiediSblocco()
        })

        if (disposed) {
          void hPause.remove()
          void hResume.remove()
        } else {
          rimuovi.push(
            () => void hPause.remove(),
            () => void hResume.remove(),
          )
        }
      } catch {
        // Plugin App assente: nessun re-lock in foreground. Si logga, non si
        // ignora in silenzio (AGENTS.md, regola 6: un catch muto è un bug).
        logClient({ livello: 'warn', evento: 'biometria', messaggio: 'plugin-app-assente' })
      }
    })()

    return () => {
      disposed = true
      for (const r of rimuovi) r()
    }
  }, [armato, richiediSblocco])

  return (
    <>
      {/* I children restano MONTATI sotto l'overlay: smontarli spegnerebbe il
          motore di sincronizzazione offline, i poll e i form non salvati, e
          provocherebbe una tempesta di refetch a ogni resume. `inert` risolve
          il problema vero, cioè l'accesso da tastiera e screen reader al
          contenuto coperto. `|| undefined` e non `false`: l'attributo non deve
          finire nel DOM quando il gate è sbloccato. */}
      <div inert={mostraBlocco || undefined}>{children}</div>
      {mostraBlocco && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('bioBloccatoAria')}
          // z-[9999] e non «un po' sopra i 120 attuali»: questo overlay è
          // l'unico elemento la cui CORRETTEZZA dipende dal coprire tutto, e un
          // valore appena sopra la concorrenza è una bomba a orologeria — il
          // prossimo toast nasce a 130 e il difetto torna in silenzio. Il lock
          // in __tests__/architecture/biometric-gate-zindex.test.ts lo difende.
          // Se un domani comparisse uno stacking context sopra il gate, la via
          // d'uscita è createPortal su document.body: costa poco ed è reversibile.
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-8 bg-kidville-green px-8 text-center"
        >
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-white">
            <Lock size={34} strokeWidth={2} />
          </div>
          <div className="space-y-2">
            <h2 className="font-barlow text-2xl font-black uppercase tracking-wide text-white">
              {t('bioBloccatoTitolo')}
            </h2>
            <p className="max-w-xs font-maven text-sm text-white/80">
              {t('bioBloccatoCorpo')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void richiediSblocco()}
            disabled={verificaInCorso}
            className="inline-flex items-center gap-2 rounded-pill bg-kidville-yellow px-6 py-3 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green active:scale-95 disabled:opacity-60"
          >
            {verificaInCorso ? (
              <Loader2 size={17} strokeWidth={2.4} className="animate-spin" />
            ) : (
              <Fingerprint size={17} strokeWidth={2.4} />
            )}
            {t('bioSblocca')}
          </button>

          {/* Anti-lockout: consente sempre l'uscita se la biometria non passa.
              MAI disabilitato, nemmeno durante la verifica: è l'ultima via. */}
          <button
            type="button"
            onClick={() => void doLogout()}
            className="font-barlow text-xs font-extrabold uppercase tracking-wide text-white/70 underline active:scale-95"
          >
            {t('bioEsci')}
          </button>
        </div>
      )}
    </>
  )
}
