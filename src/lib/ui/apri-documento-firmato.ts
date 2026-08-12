import { logClient, nomeErrore } from '@/lib/logging/client'
import { conTetto } from '@/lib/logging/tetto'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  APRIRE UN DOCUMENTO FIRMATO — la parte non ovvia, scritta una volta     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Tre pannelli della segreteria aprono un file custodito in un bucket privato: il
 * curriculum di una candidatura, la scansione allegata a una domanda d'iscrizione
 * e — dall'11/08/2026 — la copia del documento d'identità di chi lavora qui. Il
 * gesto è lo stesso in tutti e tre: si chiede al server una URL firmata e la si
 * apre in una scheda nuova.
 *
 * Sembra una riga di codice. Sono quattro fatti, e ciascuno è stato pagato:
 *
 * ── 1. LA FINESTRA SI APRE PRIMA DELLA FETCH, DENTRO IL GESTO ───────────────
 *
 * `window.open` chiamata in continuazione di promise — cioè dopo un `await` — è
 * bloccata da Safari e dalla WebView Capacitor (l'app è spedita nativa): per
 * quei motori il gesto dell'utente è finito quando la microtask riprende. Il
 * risultato non è un errore: è un pulsante che non fa niente e non dice niente.
 * Perciò la scheda si apre VUOTA e SUBITO, e riceve la URL solo dopo, con
 * `location.replace` — che non aggiunge una voce alla cronologia della scheda
 * nuova, così «indietro» non riporta su una pagina bianca.
 *
 * Questa funzione è `async`, ma tutto ciò che precede il primo `await` gira
 * nello stesso task del clic: l'apertura è ancora dentro il gesto. Chi la chiama
 * deve chiamarla DAL gestore dell'evento, non da un effetto o da un timer.
 *
 * ── 2. `opener = null` ──────────────────────────────────────────────────────
 *
 * La scheda del documento non deve poter toccare il cockpit da cui è nata. Su
 * alcune WebView la proprietà non è scrivibile e l'assegnazione lancia: si
 * ingoia, perché l'apertura vale comunque e un documento non aperto è un danno
 * certo mentre un `opener` vivo è un rischio residuo su una URL nostra.
 *
 * ── 3. LA FINESTRA BLOCCATA NON È UN GUASTO, ED È IL CASO PIÙ FREQUENTE ─────
 *
 * Un blocco popup del browser fa tornare `null` da `window.open`. Il valore di
 * ritorno, prima, non lo guardava nessuno: la segreteria premeva e non succedeva
 * niente. Qui torna `{ esito: 'bloccato', url }`, e il chiamante mostra la URL
 * firmata come link da aprire a mano — in `warn-soft`, con la classe qui sotto,
 * perché quel riquadro dice «devi fare tu una cosa», non «è andata male».
 *
 * ── 4. NIENTE PERCORSI DI STORAGE NEI LOG ───────────────────────────────────
 *
 * `path` non entra MAI in un messaggio di log: è il percorso della scansione di
 * un documento d'identità dentro un bucket privato, e AGENTS.md lo vieta insieme
 * a nomi, email e codici fiscali. Nei log finisce solo l'etichetta del chiamante
 * e lo stato HTTP.
 *
 * ⚠️ QUESTA FUNZIONE NON DECIDE IL TESTO DELL'ERRORE, e non è una dimenticanza.
 * I codici che le tre rotte restituiscono su questo ramo parlano dell'ENTITÀ
 * («candidatura non trovata», «anagrafica non trovata»), non del file: la frase
 * giusta la conosce solo il pannello, ed è già tradotta nel suo catalogo. Qui si
 * torna un esito, non una prosa.
 */

/** L'esito dell'apertura. Tre casi, e ognuno ha un rimedio diverso a schermo. */
export type EsitoDocumentoFirmato =
  /** La scheda è aperta sul documento: non c'è niente da mostrare. */
  | { esito: 'aperto' }
  /** Il browser ha bloccato la scheda: si offre la URL come link (vedi la classe sotto). */
  | { esito: 'bloccato'; url: string }
  /** Il server non ha firmato niente. `stato` è `null` quando la rete è caduta. */
  | { esito: 'errore'; stato: number | null }

/**
 * Il riquadro del ripiego, in un posto solo.
 *
 * È una costante e non un componente perché questo modulo è un `.ts` condiviso da
 * pannelli che disegnano l'avviso in punti diversi del proprio albero (dentro una
 * sezione, sotto un pulsante, in coda a una card). Quello che NON deve divergere
 * sono i toni: `warn-soft` con inchiostro `warn-strong` è la coppia misurata a
 * 4,95:1, l'unica che regge l'AA su quel fondo.
 */
export const AVVISO_FINESTRA_BLOCCATA =
  'mt-2 flex flex-wrap items-start gap-1.5 rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong'

/**
 * ⚠️ IL TETTO, e perché QUI non vale «il tetto sta nella route».
 *
 * `fetch` non ha nessun timeout di suo: un bersaglio che accetta la connessione e
 * tace tiene la chiamata appesa senza eccezione (misurato in questo repo: 150
 * secondi, `src/lib/logging/tetto.ts`). Per gli altri otto chiamanti dal browser
 * verso una nostra route la convenzione è dichiararsi in `FETCH_SENZA_TETTO` —
 * «il tetto vive dall'altra parte, dentro la route» — e per un hook che riempie
 * uno stato è vero: al massimo un pannello resta in caricamento.
 *
 * Qui no, ed è la ragione per cui questo modulo esiste. Prima della fetch è già
 * stata aperta una SCHEDA VUOTA dentro il gesto (punto 1 in testa): senza tetto,
 * una rete che non risponde lascia la segreteria davanti a una pagina bianca che
 * non diventerà mai niente e non dirà mai niente — cioè lo stesso «pulsante che
 * non fa niente e non dice niente» che questa funzione è nata per eliminare,
 * rientrato da un'altra porta. Col tetto la scadenza scatta, il `catch` CHIUDE la
 * scheda e il pannello mostra il suo errore; `nomeErrore(e)` finisce nel log come
 * `TimeoutError`, che è il nome che la specifica dà a `AbortSignal.timeout`.
 *
 * ── PERCHÉ 30 SECONDI, e non 5 ─────────────────────────────────────────────
 * Il tetto d'AREA di `storage` lato server è 20 s (`TETTI_MS_AREA`), e la firma
 * di una URL ci passa. Un tetto cliente PIÙ CORTO di quello del server taglia la
 * chiamata mentre il server sta ancora per rispondere: si perderebbe il suo
 * errore — quello che sa dire «anagrafica non trovata» — sostituito da un
 * generico guasto di rete. 30 s sta sopra i 20 del server e lontanissimo da
 * «per sempre».
 *
 * `conTetto` non lancia mai e restituisce l'`init` intatto se `AbortSignal.timeout`
 * non esiste (WebView vecchie): il peggio che può succedere è tornare al
 * comportamento di prima, mai rompere l'apertura.
 */
const TETTO_FIRMA_MS = 30_000

export interface RichiestaDocumentoFirmato {
  /**
   * La rotta che firma. Ci si aggiunge `?doc=<path>` (o `&doc=` se una query c'è
   * già): la convenzione è la stessa per tutte e tre le rotte del repo.
   */
  endpoint: string
  /** Il percorso nel bucket privato. Non entra mai in un log. */
  path: string
  /** Intestazioni della richiesta: lo scope di sede (`x-sedi`), l'identità (`x-user-id`). */
  headers?: Record<string, string>
  /** La rotta della PAGINA, per il log: è il luogo dell'incidente, non la fetch. */
  route: string
  /**
   * Il prefisso degli eventi di log (`candidatura-cv`, `anagrafica-documento`).
   * Serve a distinguere in SQL quale dei tre pannelli non è riuscito ad aprire.
   */
  etichetta: string
}

export async function apriDocumentoFirmato({
  endpoint,
  path,
  headers,
  route,
  etichetta,
}: RichiestaDocumentoFirmato): Promise<EsitoDocumentoFirmato> {
  // ── Dentro il gesto, prima di qualunque `await`. Vedi il punto 1 in testa. ──
  const finestra = typeof window !== 'undefined' ? window.open('', '_blank') : null

  try {
    const separatore = endpoint.includes('?') ? '&' : '?'
    const richiesta = `${endpoint}${separatore}doc=${encodeURIComponent(path)}`
    const res = await fetch(richiesta, conTetto(richiesta, { headers }, TETTO_FIRMA_MS))
    const json = await res.json().catch(() => null)

    if (!res.ok || !json?.url) {
      finestra?.close()
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: `${etichetta}-non-firmato: http ${res.status}`,
        route,
        stato: res.status,
      })
      return { esito: 'errore', stato: res.status }
    }

    const url = String(json.url)
    if (finestra && !finestra.closed) {
      try {
        finestra.opener = null
      } catch {
        /* Alcune WebView rendono `opener` non scrivibile: l'apertura vale comunque. */
      }
      finestra.location.replace(url)
      return { esito: 'aperto' }
    }

    logClient({
      livello: 'warn',
      evento: 'react',
      messaggio: `${etichetta}-finestra-bloccata: window.open ha ritornato null`,
      route,
    })
    return { esito: 'bloccato', url }
  } catch (e) {
    finestra?.close()
    logClient({
      livello: 'error',
      evento: 'react',
      messaggio: `${etichetta}-fallito: ${nomeErrore(e)}`,
      route,
    })
    return { esito: 'errore', stato: null }
  }
}
