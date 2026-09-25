'use client'

import {
  apriDocumento,
  scaricaDocumento,
  type DocumentoInput,
  type RisultatoScaricoNativo,
} from '@/lib/native/scarica'
import { isNativeApp } from '@/lib/push/native-register'

/**
 * I documenti della Segreteria (protocolli, merchandise, competenze) nell'app.
 *
 * Prima ogni punto faceva `window.open(url, '_blank')`: nella WebView Capacitor
 * le finestre multiple non sono abilitate, e la chiamata ritorna `null` senza
 * lanciare — il bottone non faceva niente e nessun log lo diceva. Ora passano
 * dall'helper unico di `@/lib/native/scarica`, che logga da sé l'esito.
 *
 * Due gesti, due funzioni dell'helper:
 *  - «apri» un documento (PDF timbrato, ordine al fornitore, certificato) →
 *    `apriDocumento`: nell'app l'anteprima di sistema DENTRO l'app; sul web la
 *    scheda nuova, come prima.
 *  - «esporta» (XLSX, PDF del registro: risposte `attachment`) → nell'app il foglio
 *    di condivisione con il file («Salva su File»), cioè `scaricaDocumento`; sul
 *    web resta la scheda nuova di prima (`apriDocumento`, che sul web è
 *    `window.open` aperto dentro il gesto), e il browser scarica il file col nome
 *    del server come ha sempre fatto.
 */
export function esportaDocumento(input: DocumentoInput): Promise<RisultatoScaricoNativo> {
  // NIENTE `await` prima della scelta: sul web la scheda va aperta nello stesso
  // task del clic, o il browser la blocca.
  return isNativeApp() ? scaricaDocumento(input) : apriDocumento(input)
}

/**
 * La base del nome dei file di un protocollo, senza estensione, dal numero
 * formattato («0000042/2026» → «Prot-0000042-2026»). È l'UNICA copia lato
 * client della convenzione `Prot-<numero>-<anno>`: la usano `nomeFileProtocollo`
 * (drawer Registra/Genera, Competenze, timbrato della riga e del dettaglio) e i
 * ripieghi `-originale`/`-allegato` del dettaglio. La barra si toglie perché in
 * un nome di file è una cartella. Numero vuoto → `null`: il chiamante sceglie
 * il suo ripiego.
 */
export function baseNomeProtocollo(numeroFormattato: string): string | null {
  const numero = numeroFormattato.trim()
  return numero ? `Prot-${numero.replace(/\//g, '-')}` : null
}

/**
 * Il nome sul dispositivo del PDF timbrato di un protocollo, dal numero
 * formattato che le route restituiscono: «0000042/2026» → «Prot-0000042-2026.pdf».
 * È lo STESSO nome che le route del registro mettono nel download firmato
 * (`api/admin/protocolli/file`, `da-documento`, `genera-documento`…).
 * Numero vuoto (la route non l'ha restituito) → «protocollo-timbrato.pdf».
 */
export function nomeFileProtocollo(numeroFormattato: string): string {
  const base = baseNomeProtocollo(numeroFormattato)
  return base ? `${base}.pdf` : 'protocollo-timbrato.pdf'
}

/**
 * Il verdetto sul gesto: UNA sola regola in tutto il ramo, quella di
 * `avvisoDocumento` (`@/lib/native/documento-genitore`, la stessa di `tipoAvviso`
 * in `LinkDocumento`). Tre valori:
 *  - `null`: niente da dire (file consegnato, foglio di condivisione visto, annullato);
 *  - `'aggiorna'`: l'helper ha visto mancare i plugin della 1.1
 *    (`binarioDaAggiornare: true`, il binario 1.0): riprovare non riuscirà MAI, il
 *    testo deve dire «aggiorna l'app»;
 *  - `'riprova'`: ogni altro esito da segnalare (`non-riuscito`, `ripiego-appunti`,
 *    esiti nuovi) — un bottone che non dice niente è il difetto di partenza.
 */
export { avvisoDocumento, type AvvisoDocumento } from '@/lib/native/documento-genitore'

/**
 * Il vecchio verdetto a due valori («va segnalato?»), tenuto SOLO come nome per
 * chi lo importa già (personale/ScadenzeDocumenti, `apri-documento-firmato`): è la
 * stessa regola `esitoDaSegnalare`, non una copia. Chi scrive un avviso nuovo usi
 * `avvisoDocumento`, che distingue anche «aggiorna l'app».
 */
export { esitoDaSegnalare as documentoNonConsegnato } from '@/lib/native/documento-genitore'
