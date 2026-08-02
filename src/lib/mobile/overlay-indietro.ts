'use client'

import { useEffect, useRef } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * REGISTRO DEGLI OVERLAY APERTI — cosa deve fare il tasto Indietro fisico di Android.
 *
 * IL DIFETTO (audit 2026-07-31). Il gestore di `backButton` in `native-shell.ts` navigava
 * indietro nella cronologia ANCHE con una modale aperta: con «Nuovo avviso» a schermo, un
 * Indietro distratto portava via la pagina e con lei l'avviso che si stava scrivendo. Su
 * Android è il comportamento sbagliato: la convenzione della piattaforma
 * (`OnBackPressedDispatcher`) è che Indietro chiude prima il livello più alto
 * dell'interfaccia — modale, bottom-sheet, pannello — e solo quando non ce n'è nessuno
 * torna indietro nella cronologia.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * COME SI AGGANCIA UNA MODALE (una riga, dentro il componente che la possiede):
 *
 *     import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro'
 *     …
 *     useOverlayIndietro(aperto, chiudi)   // `chiudi` è lo stesso onClose del bottone ✕
 *
 * `aperto` è il booleano che già governa il render dell'overlay; `chiudi` può essere un
 * handler inline (`() => setAperto(false)`) — si tiene sempre l'ULTIMO, quindi non chiude
 * mai usando uno stato vecchio, e un oggetto funzione nuovo a ogni render non fa
 * ri-registrare l'overlay (che ne cambierebbe la posizione nello stack).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * PERCHÉ NON SI TOGLIE DA SÉ L'OVERLAY CHE CHIUDE. `chiudiOverlayInCima()` INVOCA la
 * chiusura e basta: non fa `pop`. È il componente che esce dal registro, quando `aperto`
 * diventa davvero `false`. La differenza conta nel caso che ha motivato tutto questo: un
 * overlay può decidere di NON chiudersi (un «vuoi davvero uscire? perderai la bozza»).
 * Se il registro lo togliesse d'ufficio, il secondo Indietro navigherebbe via — cioè
 * esattamente la bozza persa che si voleva evitare. È anche ciò che fa Android.
 *
 * PERCHÉ NON C'È NESSUNA GUARDIA `isNativeApp()` QUI DENTRO. Iscriversi è inerte per
 * costruzione: l'unico che legge questo registro è il gestore di `backButton`, che
 * `setupNativeShell` installa SOLO nella shell nativa (`NativeInit` lo chiama sotto
 * `isNativeApp()`). Nel browser lo stack si riempie e si svuota senza che nessuno lo
 * guardi: nessun tasto Indietro del browser passa di qui, e il comportamento del web
 * resta identico a prima. Una guardia in più darebbe solo un altro modo di sbagliare.
 *
 * LIMITE NOTO (lo stesso di `Modal.tsx` e per la stessa ragione): l'ordine dello stack è
 * l'ordine di ESECUZIONE degli effetti, non l'ordine visivo. Due overlay che si aprono
 * nello STESSO commit e sono annidati si registrano figlio-prima-del-padre. Non è il caso
 * reale — una modale annidata nasce da un gesto dell'utente, quindi in un commit
 * successivo, e finisce correttamente in cima.
 */

type Chiusura = () => void

interface Iscritto {
  readonly id: symbol
  readonly chiudi: Chiusura
}

/** Stack LIFO degli overlay aperti. Stato di modulo: nel browser è per-scheda. */
const aperti: Iscritto[] = []

/**
 * Iscrive un overlay al registro e restituisce la funzione che lo toglie.
 * La rimozione è per IDENTITÀ, non un `pop`: gli overlay possono smontarsi in ordine
 * qualsiasi (un `router.push` smonta l'intera pagina, padre e figlio insieme).
 * È idempotente: chiamarla due volte non toglie l'overlay di qualcun altro.
 */
export function registraOverlay(chiudi: Chiusura): () => void {
  const iscritto: Iscritto = { id: Symbol('overlay'), chiudi }
  aperti.push(iscritto)
  return () => {
    const i = aperti.findIndex((o) => o.id === iscritto.id)
    if (i !== -1) aperti.splice(i, 1)
  }
}

/**
 * Chiede all'overlay in cima di chiudersi. Restituisce `true` se ce n'era uno — cioè se
 * l'evento è stato CONSUMATO e il chiamante non deve navigare.
 *
 * Non lancia mai: la chiama un gestore di eventi nativo, e un'eccezione lì ucciderebbe il
 * listener del tasto Indietro per il resto della sessione. Se la chiusura fallisce l'evento
 * resta consumato lo stesso: ripiegare sulla navigazione perderebbe la bozza, che è il
 * difetto che questo modulo esiste per impedire.
 */
export function chiudiOverlayInCima(): boolean {
  const cima = aperti[aperti.length - 1]
  if (cima === undefined) return false
  try {
    cima.chiudi()
  } catch (err) {
    // Un catch che non logga è un bug (AGENTS.md). Qui si usa il logger del CLIENT e non
    // `@/lib/logging/logger`: questo codice gira nella WebView, dove il logger del server
    // non è nemmeno caricabile (trascina `node:crypto` via `redact`). Del guasto esce il
    // solo NOME della classe d'errore — mai il messaggio, che in un handler applicativo
    // può riecheggiare dati del bambino a schermo.
    logClient({
      livello: 'warn',
      evento: 'js',
      messaggio: `overlay: chiusura dal tasto Indietro fallita — ${nomeErrore(err)}`,
    })
  }
  return true
}

/**
 * Dichiara un overlay al tasto Indietro fisico finché è `aperto`.
 *
 * Non logga il caso normale di proposito: un tasto Indietro non è un evento critico ai
 * sensi di AGENTS.md §5 (email, push, cron, fattura, pagamento), e in una WebView può
 * essere premuto decine di volte al minuto — una riga per pressione accecherebbe il canale
 * dei log del client, che ha una coda di 20 eventi. Si logga solo ciò che va storto.
 */
export function useOverlayIndietro(aperto: boolean, onChiudi: () => void): void {
  // Indirezione via ref, come in `ui/Modal.tsx`: l'effetto dipende SOLO da `aperto`, così
  // un handler inline ricreato a ogni render non fa uscire e rientrare l'overlay dallo
  // stack (ne cambierebbe la posizione, e con due overlay aperti si chiuderebbe il
  // sbagliato) — e la chiusura invocata è comunque sempre l'ultima, mai una stantia.
  const onChiudiRef = useRef(onChiudi)
  useEffect(() => {
    onChiudiRef.current = onChiudi
  })

  useEffect(() => {
    if (!aperto) return
    return registraOverlay(() => onChiudiRef.current())
  }, [aperto])
}
