// Il TIPO DI FILE è un'affermazione del client: qui si verifica.
//
// PERCHÉ ESISTE QUESTO FILE (collaudo del 2026-07-31, sicurezza W7 + backend).
//
//  · `task_allegati` era l'UNICO bucket con `allowed_mime_types = null`: accettava
//    qualunque tipo dichiarato dal browser. Il tester ha caricato un finto `.html`
//    con `type: text/html` e lo Storage l'ha memorizzato con quel mimetype. Oggi
//    lo SERVE `text/plain` + `nosniff`, quindi nessuna XSS — ma quella difesa è
//    del provider, non nostra, e il giorno in cui cambia non ce lo viene a dire
//    nessuno.
//  · `avvisi/upload` non aveva il gate applicativo che `news/upload` ha ricevuto
//    lo stesso giorno: un `.txt` usciva come
//    `500 {"error":"mime type text/plain is not supported"}` — il messaggio grezzo
//    del provider, col nome del vincolo, in faccia a chi lavora in segreteria,
//    dove serviva un 415. Stessa asimmetria sulla dimensione (`Payload too large`).
//
// PERCHÉ UNO SOLO. La forma del gate è quella di `news/upload:POST`
// (`MIME_AMMESSI` → 415 con messaggio comprensibile, log `warn` col solo mime e
// la dimensione, MAI il nome del file). Una seconda forma inventata qui sarebbe
// una seconda cosa da tenere allineata: in questo repo un upload si valida in un
// modo solo. `news` resta separato per una ragione dichiarata — è un bucket
// pubblico per media editoriali, con i suoi video e il suo sniff dei codec.
//
// LA LISTA È DICHIARATA ANCHE NEL BUCKET, e le due devono coincidere: se il
// bucket fosse più stretto, il file passerebbe il gate e verrebbe respinto dopo
// il caricamento (500 opaco); se fosse più largo, l'unica difesa resterebbe
// questa. Il lock `__tests__/architecture/allegati-mime-dichiarati.test.ts`
// confronta questo file con la migrazione.

import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'

/**
 * I tipi che si possono allegare a un avviso o a un incarico.
 *
 * È l'insieme che i moduli offrono davvero (`accept="image/*,.pdf,.doc,.docx"` in
 * `AvvisoForm`, `TaskCard`, `TaskResolutionModal`), ristretto ai formati immagine
 * che i telefoni producono per davvero. `image/jpg` non è uno standard ma alcuni
 * client lo dichiarano lo stesso, ed è già ammesso dal bucket `news`: rifiutarlo
 * vorrebbe dire respingere una foto valida per il nome del suo tipo.
 *
 * NON ci sono video: un allegato di avviso o di incarico è una circolare, un
 * modulo, una foto: il bucket ha un limite di 10 MB e i video vivono in `gallery`
 * (200 MB, con lo sniff dei codec).
 */
export const MIME_ALLEGATI_AMMESSI = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const

/**
 * Il limite di un allegato: 10 MB, cioè ESATTAMENTE il `file_size_limit` dei due
 * bucket (misurato in produzione il 2026-08-01: 10485760 su entrambi).
 *
 * Sta qui e non nelle route per la stessa ragione della lista: due dichiarazioni
 * dello stesso limite divergono, ed è già successo su `gallery` (50 MB nel bucket,
 * 200 MB nella route, per mesi).
 */
export const DIMENSIONE_MAX_ALLEGATO_BYTE = 10485760

/**
 * Il tipo dichiarato, senza il suffisso dei parametri (`image/jpeg; charset=…`),
 * in minuscolo. Un client che aggiunge un parametro non sta dichiarando un altro
 * formato, e lo Storage rifiuterebbe la stringa intera.
 */
export function normalizzaContentType(dichiarato: string | null | undefined): string {
  return (dichiarato ?? '').split(';')[0].trim().toLowerCase()
}

export type EsitoAllegato =
  /** Ammesso: `contentType` è il tipo NORMALIZZATO, quello da passare allo Storage. */
  | { ok: true; contentType: string }
  /** Rifiutato: la risposta è già pronta, col codice che il client sa tradurre. */
  | { ok: false; risposta: NextResponse }

/**
 * Verifica tipo e dimensione di un allegato PRIMA che tocchi lo Storage.
 *
 * Il rifiuto lascia una riga `warn` (non `error`: è un uso sbagliato, non un
 * guasto) con il solo `mime` e i `byte`. Il NOME del file non si logga mai:
 * «certificato-<cognome>.pdf» dice di quale bambino si tratta, e finirebbe in un
 * canale che si legge tutti i giorni.
 */
export function verificaAllegato(
  file: File,
  ctx: { operazione: string; bucket: string },
): EsitoAllegato {
  const contentType = normalizzaContentType(file.type)

  if (!(MIME_ALLEGATI_AMMESSI as readonly string[]).includes(contentType)) {
    logEvento('storage', 'warn', {
      operazione: ctx.operazione,
      esito: 'mime-non-ammesso',
      bucket: ctx.bucket,
      mime: contentType,
      byte: file.size,
    })
    return {
      ok: false,
      risposta: NextResponse.json(
        {
          error: 'Questo tipo di file non si può allegare: sono ammessi immagini, PDF e documenti Word.',
          codice: 'ALLEGATO_TIPO_NON_AMMESSO',
        },
        { status: 415 },
      ),
    }
  }

  if (file.size > DIMENSIONE_MAX_ALLEGATO_BYTE) {
    logEvento('storage', 'warn', {
      operazione: ctx.operazione,
      esito: 'allegato-troppo-grande',
      bucket: ctx.bucket,
      mime: contentType,
      byte: file.size,
    })
    return {
      ok: false,
      risposta: NextResponse.json(
        {
          error: 'Il file è troppo grande: un allegato può pesare al massimo 10 MB.',
          codice: 'ALLEGATO_TROPPO_GRANDE',
        },
        { status: 413 },
      ),
    }
  }

  return { ok: true, contentType }
}
