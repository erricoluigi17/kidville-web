'use client'

import { useEffect } from 'react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp, registerNativePush, statoPermessoPush } from '@/lib/push/native-register'

// Auto-registrazione della push NATIVA al primo accesso autenticato nella
// shell Capacitor: chiede il permesso di sistema e registra il token FCM/APNs
// (POST /api/push/subscribe). No-op sul web (il push web resta opt-in da
// PushOptIn) e no-op se il permesso è già stato negato (requestPermissions non
// ri-prompta). Montato nei layout parent/teacher dentro <Suspense>
// (useSessionIdentity usa useSearchParams). Non renderizza nulla.

/**
 * UN NUOVO TENTATIVO QUANDO L'APP TORNA IN PRIMO PIANO (2026-09-25, PC2).
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 * Il tentativo era UNO per vita della pagina (`attempted` di modulo). Se falliva — rete appena
 * accesa, APNs che non risponde, un deploy in corso mentre `registerNativePush` esauriva i suoi
 * ritentativi — il telefono restava fuori da `push_subscriptions` fino al prossimo AVVIO a freddo.
 * E chi l'app non la chiude mai (la mette in background e basta: quasi tutti) restava senza
 * notifiche per giorni, senza che niente lo dicesse all'utente.
 *
 * ─── LA REGOLA ──────────────────────────────────────────────────────────────
 * Al ritorno in primo piano si riprova SOLO se l'ultimo esito è stato un fallimento che può guarire:
 *  · `ritentabile` (errore del plugin, nessuna risposta da APNs/FCM, POST fallito, promise rifiutata);
 *  · `negato` → si riprova solo se il permesso ADESSO è `granted`: è il genitore che è andato nelle
 *    Impostazioni ad accendere le notifiche ed è tornato. Con il permesso ancora negato non si chiama
 *    `registerNativePush`, che farebbe una DELETE a ogni ritorno;
 *  · tutto il resto (`riuscito`, il plugin assente dal binario, la disattivazione scelta dall'utente)
 *    non si ritenta mai.
 *
 * ─── NIENTE RAFFICA ─────────────────────────────────────────────────────────
 * Un tentativo alla volta (`inCorso`), almeno `INTERVALLO_RIPRESA_MS` fra un tentativo e il
 * successivo (su Android `resume` e `visibilitychange` arrivano insieme, e un utente che passa fra
 * due app ne produce decine all'ora), al massimo `TENTATIVI_RIPRESA_MAX` per sessione.
 *
 * Lo stato è di MODULO, come prima `attempted`: il componente è montato sia nel layout genitore sia
 * in quello docente, e un utente con due profili non deve avere due registrazioni in parallelo.
 */
export const INTERVALLO_RIPRESA_MS = 60_000
export const TENTATIVI_RIPRESA_MAX = 5

/** Gli errori di `registerNativePush` che possono guarire da soli. Il resto è definitivo. */
const ERRORI_RITENTABILI = new Set(['plugin_error', 'registration_timeout', 'subscribe_failed'])

type UltimoEsito = 'mai' | 'riuscito' | 'ritentabile' | 'negato' | 'definitivo'

const stato: {
  avviato: boolean
  inCorso: boolean
  ultimoEsito: UltimoEsito
  ultimoTentativoAl: number
  tentativiRipresa: number
  ascoltoAgganciato: boolean
  userId: string | null
} = {
  avviato: false,
  inCorso: false,
  ultimoEsito: 'mai',
  ultimoTentativoAl: 0,
  tentativiRipresa: 0,
  ascoltoAgganciato: false,
  userId: null,
}

function classifica(esito: { ok: boolean; error?: string }): UltimoEsito {
  if (esito.ok) return 'riuscito'
  if (esito.error === 'permission_denied') return 'negato'
  if (esito.error !== undefined && ERRORI_RITENTABILI.has(esito.error)) return 'ritentabile'
  return 'definitivo'
}

/**
 * Un tentativo di registrazione. L'esito non tocca la UI — questo resta vero e voluto: un genitore
 * che apre l'app non deve vedere un errore perché la registrazione push è andata storta. Ma «non
 * mostrarlo» non è «non saperlo»: `registerNativePush` logga ogni ramo, e qui si chiude l'ultimo
 * buco, cioè un rifiuto della promise stessa.
 */
async function tenta(userId: string, daRipresa: boolean): Promise<UltimoEsito> {
  stato.inCorso = true
  stato.ultimoTentativoAl = Date.now()
  try {
    const esito = await registerNativePush(userId)
    stato.ultimoEsito = classifica(esito)
    if (daRipresa && esito.ok) {
      // Il SUCCESSO del recupero si scrive (regola 5 di AGENTS.md): è la prova che il tentativo al
      // ritorno in primo piano serve, e dopo quanti giri. `warn` perché il canale del client non ha
      // `info` — ed è comunque raro: nasce solo dopo un primo tentativo fallito.
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: 'push-nativa-ripresa: registrata al ritorno in primo piano',
        campi: { tentativi: stato.tentativiRipresa },
      })
    }
  } catch (e) {
    stato.ultimoEsito = 'ritentabile'
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-nativa-tentativo-fallito: ${nomeErrore(e)}`,
    })
  } finally {
    stato.inCorso = false
  }
  return stato.ultimoEsito
}

/**
 * Il ritorno in primo piano. Esportata per i test: è il punto in cui vive tutta la politica
 * anti-raffica, e provarla attraverso i due segnali veri la renderebbe un test sui segnali.
 */
export async function suRitornoInPrimoPiano(): Promise<void> {
  try {
    if (!stato.avviato || stato.inCorso) return
    if (stato.ultimoEsito !== 'ritentabile' && stato.ultimoEsito !== 'negato') return
    const userId = stato.userId
    // Dopo un logout non si registra niente: il token finirebbe su una sessione che non c'è.
    if (!userId) return
    if (stato.tentativiRipresa >= TENTATIVI_RIPRESA_MAX) return
    if (Date.now() - stato.ultimoTentativoAl < INTERVALLO_RIPRESA_MS) return

    if (stato.ultimoEsito === 'negato') {
      // Controllare il permesso non chiede niente all'utente e non tocca la rete. Si conta come
      // tentativo per l'intervallo, non per il tetto: il tetto è sui tentativi di REGISTRAZIONE.
      stato.inCorso = true
      stato.ultimoTentativoAl = Date.now()
      let permesso: Awaited<ReturnType<typeof statoPermessoPush>>
      try {
        permesso = await statoPermessoPush()
      } finally {
        stato.inCorso = false
      }
      if (permesso !== 'granted') return
    }

    stato.tentativiRipresa++
    const esito = await tenta(userId, true)
    if (stato.tentativiRipresa >= TENTATIVI_RIPRESA_MAX && esito !== 'riuscito') {
      // Una riga sola per sessione, scritta DOPO l'esito: dice che il telefono è rimasto davvero
      // senza push e che da qui in poi aspetta il prossimo avvio. Se l'ultimo tentativo riesce parte
      // solo «registrata al ritorno in primo piano», e le due righe non si contraddicono mai.
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: 'push-nativa-ripresa: tetto raggiunto senza registrazione, si riprova al prossimo avvio',
        campi: { tentativi: stato.tentativiRipresa },
      })
    }
  } catch (e) {
    // `statoPermessoPush` non lancia, ma questo gestore gira su un evento di sistema: nessuna
    // eccezione deve uscirne muta.
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-nativa-ripresa-fallita: ${nomeErrore(e)}`,
    })
  }
}

/**
 * Aggancia i due segnali di ritorno in primo piano, UNA volta per vita della pagina.
 *
 * `resume` di `@capacitor/app` è il segnale nativo; `visibilitychange` è la rete sotto: se il file del
 * plugin non arriva (rete assente all'avvio — è proprio il caso in cui la registrazione fallisce)
 * resta comunque un segnale. Arrivano spesso insieme: li separa `INTERVALLO_RIPRESA_MS`.
 */
let suVisibilita: (() => void) | null = null

function agganciaRipresa(): void {
  if (stato.ascoltoAgganciato) return
  stato.ascoltoAgganciato = true
  suVisibilita = () => {
    if (document.visibilityState === 'visible') void suRitornoInPrimoPiano()
  }
  document.addEventListener('visibilitychange', suVisibilita)
  void (async () => {
    try {
      const { App } = await import('@capacitor/app')
      await App.addListener('resume', () => {
        void suRitornoInPrimoPiano()
      })
    } catch (e) {
      // Resta `visibilitychange`, che basta: si scrive solo che il segnale nativo manca.
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: `push-nativa-ripresa: segnale resume non agganciato (${nomeErrore(e)})`,
      })
    }
  })()
}

/**
 * Solo per i test: lo stato di modulo torna com'era al caricamento, ascolto compreso — così ogni test
 * aggancia i propri segnali e può provare il ripiego su `visibilitychange` senza `resume`.
 */
export function __azzeraPerTest(): void {
  if (suVisibilita) document.removeEventListener('visibilitychange', suVisibilita)
  suVisibilita = null
  stato.ascoltoAgganciato = false
  stato.avviato = false
  stato.inCorso = false
  stato.ultimoEsito = 'mai'
  stato.ultimoTentativoAl = 0
  stato.tentativiRipresa = 0
  stato.userId = null
}

export function NativePushAutoRegister() {
  const { userId, ready } = useSessionIdentity()

  useEffect(() => {
    // L'identità corrente è quella che userà il prossimo tentativo. Allo smontaggio (il layout
    // dell'area se ne va: logout, login page) si azzera: un ritorno in primo piano sulla pagina di
    // login non deve registrare il token del genitore di prima.
    if (ready) stato.userId = userId ?? null
    return () => {
      stato.userId = null
    }
  }, [ready, userId])

  useEffect(() => {
    if (stato.avviato || !ready || !userId || !isNativeApp()) return
    stato.avviato = true
    stato.userId = userId
    agganciaRipresa()
    void tenta(userId, false)
  }, [ready, userId])

  return null
}
