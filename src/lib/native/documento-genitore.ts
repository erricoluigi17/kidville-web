'use client'

import type { MouseEvent } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import {
  apriDocumento,
  fileConsegnato,
  nomeFileDocumento,
  scaricaDocumento,
  type DocumentoInput,
  type RisultatoScarico,
  type RisultatoScaricoNativo,
} from './scarica'

/**
 * I DOCUMENTI DEL GENITORE NELL'APP 1.1 — il ponte fra un `<a href target="_blank">` e
 * l'helper unico di `./scarica` (spec 2026-09-24, compito NAT3c).
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────────
 * Nella WebView Capacitor un'ancora `target="_blank"` e un `window.open` non aprono
 * niente (`capacitor.config.ts` non abilita finestre multiple), e un `<a download>` su un
 * `blob:` non scarica: allegati di lezioni, avvisi e chat, il certificato delle
 * competenze e il PDF appena firmato erano pulsanti muti nell'app.
 *
 * ─── IL CRITERIO (spec, «Download: tutti i ~37 punti») ─────────────────────────────
 *  - documento da SALVARE (ricevuta, prestampato, certificato) → `scaricaDocumento`:
 *    nell'app il foglio di condivisione con il FILE («Salva su File»);
 *  - documento da GUARDARE (allegati, pagella da consultare) → `apriDocumento`:
 *    nell'app l'anteprima di sistema DENTRO l'app;
 *  - sul WEB resta tutto com'è. Per questo `suNativo` non tocca l'ancora fuori dall'app:
 *    niente `preventDefault`, e il browser fa quello che faceva ieri (scheda nuova,
 *    clic centrale, «copia indirizzo»).
 *
 * I log li scrive l'helper (successo compreso): chi chiama NON rilogga.
 */

export type GestoDocumento = 'apri' | 'salva'

/**
 * Il gestore di clic per un'ancora che esiste già. Sul web ritorna senza fare nulla;
 * nell'app ferma la navigazione (che nella WebView non porterebbe da nessuna parte) e
 * passa dall'helper. L'input si costruisce AL CLIC, non al render: un indirizzo firmato
 * letto al momento del gesto è quello più fresco.
 */
export function suNativo(
  gesto: GestoDocumento,
  input: () => DocumentoInput,
  onEsito?: (risultato: RisultatoScaricoNativo) => void,
): (evento: MouseEvent<HTMLElement>) => void {
  return (evento) => {
    if (!isNativeApp()) return
    evento.preventDefault()
    const dati = input()
    // L'helper non lancia mai e registra da sé l'esito: chi chiama riceve il verdetto
    // solo per decidere che cosa dire a schermo.
    void (gesto === 'apri' ? apriDocumento(dati) : scaricaDocumento(dati)).then((risultato) =>
      onEsito?.(risultato),
    )
  }
}

/** Un'estensione plausibile in coda a un percorso: 1–5 caratteri alfanumerici. */
const ESTENSIONE_RX = /\.([a-z0-9]{1,5})$/i

/**
 * L'ultimo pezzo del percorso di un indirizzo, decodificato. Il nome dentro lo Storage
 * è spesso `…/1727000000-scheda%20compiti.pdf`: al dispositivo serve almeno l'estensione,
 * senza la quale iOS non sa che anteprima usare e Android non sa con che app aprirlo.
 */
function ultimoPezzo(url: string): string {
  const percorso = (url ?? '').split(/[?#]/)[0]
  const pezzo = percorso.slice(percorso.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(pezzo)
  } catch (e) {
    // Una sequenza `%` malformata: il pezzo resta com'è, e il nome del file ne esce solo
    // meno leggibile. Si registra perché un indirizzo così non dovrebbe esistere.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `documento-nome-non-decodificabile:${nomeErrore(e)}`,
    })
    return pezzo
  }
}

/**
 * Il nome porta già un'estensione della lista CHIUSA di `./scarica` (`ESTENSIONI_DOCUMENTO`,
 * non esportata)? La si interroga attraverso `nomeFileDocumento`, che quella lista la usa:
 * con un `mime` di ripiego, un'estensione riconosciuta resta com'è (`x.jpg` → `x.jpg`),
 * una che non lo è riceve quella del `mime` (`x.09` → `x.09.pdf`). Così la lista resta
 * UNA, e non una copia qui che invecchia per conto suo.
 */
function estensioneRiconosciuta(nome: string): boolean {
  const punto = nome.lastIndexOf('.')
  if (punto < 0) return false
  const campione = `x.${nome.slice(punto + 1).toLowerCase()}`
  return nomeFileDocumento(campione, 'application/pdf') === campione
}

/**
 * Il nome del file da consegnare: quello mostrato, se c'è, con l'estensione presa
 * dall'indirizzo quando il nome non ne porta una; altrimenti l'ultimo pezzo
 * dell'indirizzo; altrimenti `predefinito`. La pulizia (barre, `..`, lunghezza) la fa
 * `nomeFileDocumento` dentro l'helper: qui si decide solo DA DOVE viene il nome.
 */
export function nomeDocumentoDa(
  nomeMostrato: string | null | undefined,
  url: string,
  predefinito: string,
): string {
  const dallUrl = ultimoPezzo(url)
  const estensioneUrl = ESTENSIONE_RX.exec(dallUrl)?.[1]?.toLowerCase()
  const nome = (nomeMostrato ?? '').trim()
  if (nome) {
    // Il nome resta com'è se finisce con QUELLA estensione o con una della lista chiusa
    // di `./scarica` — non con «un punto e qualche carattere»: in «Compiti 24.09» il `09`
    // non è un'estensione, e senza il `.jpg` dell'indirizzo il file resterebbe senza tipo
    // (l'anteprima iOS fallisce con OS-PLUG-FLVW-0013).
    if (!estensioneUrl || nome.toLowerCase().endsWith(`.${estensioneUrl}`)) return nome
    if (estensioneRiconosciuta(nome)) return nome
    return `${nome}.${estensioneUrl}`
  }
  if (dallUrl.trim()) return dallUrl
  // Un pezzo d'indirizzo vuoto non può portare un'estensione.
  return predefinito
}

/** Il PDF che arriva dentro una risposta (`pdfBase64`), come `Blob`. */
export function pdfDaBase64(base64: string): Blob {
  const binario = atob(base64)
  const byte = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) byte[i] = binario.charCodeAt(i)
  return new Blob([byte], { type: 'application/pdf' })
}

/**
 * Il gesto va segnalato a chi l'ha fatto? Sì quando non ha ottenuto NIENTE che si veda:
 * né il file, né l'anteprima, né il foglio col link. Il gesto annullato non si segnala.
 * La copia negli appunti conta come «niente»: è muta (vedi `ripiego-appunti`).
 */
export function esitoDaSegnalare(risultato: RisultatoScarico): boolean {
  if (fileConsegnato(risultato)) return false
  if (risultato.esito === 'ripiego-condivisione') return false
  return risultato.motivo !== 'annullato'
}

/** Quale avviso: l'app installata va aggiornata, oppure il documento non è arrivato e si riprova. */
export type AvvisoDocumento = 'aggiorna' | 'riprova'

/**
 * Il testo dell'avviso segue il verdetto dell'helper, come `tipoAvviso` di `LinkDocumento`.
 * «Aggiorna» SOLO quando l'helper ha visto mancare i plugin della 1.1
 * (`binarioDaAggiornare: true`, il binario 1.0): lì riprovare non riuscirà MAI, e dire
 * «riprova fra qualche minuto» manderebbe il genitore dalla parte sbagliata. Ogni altro
 * esito da segnalare (sessione scaduta, 500, foglio che non si apre) è «riprova».
 * `null` quando non c'è niente da dire (file consegnato, foglio col link, annullato).
 */
export function avvisoDocumento(
  risultato: RisultatoScarico & { binarioDaAggiornare?: boolean },
): AvvisoDocumento | null {
  if (!esitoDaSegnalare(risultato)) return null
  return risultato.binarioDaAggiornare === true ? 'aggiorna' : 'riprova'
}
