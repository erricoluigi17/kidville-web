'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Condivisione nativa (Capacitor Share) con degradazione pulita sul web:
//  1. Nativo  → foglio di condivisione di sistema (@capacitor/share)
//  2. Web con Web Share API → navigator.share (sheet di sistema mobile/desktop)
//  3. Web senza Web Share → copia negli appunti (clipboard.writeText)
// L'annullamento da parte dell'utente (AbortError) è normale, non un errore:
// non si logga, e per chi chiama conta come «il foglio si è aperto».

export interface CondivisioneInput {
  title?: string
  text?: string
  url?: string
}

/**
 * Che cosa è successo davvero.
 *
 * Esiste perché i tre rami NON sono equivalenti per l'utente: il foglio di
 * sistema si vede, la copia negli appunti è MUTA. Un pulsante che copia senza
 * dirlo si legge come un pulsante rotto — ed è lo stesso equivoco che ha tenuto
 * in piedi per mesi lo «Scarica» che non scaricava. Chi chiama decide se
 * avvisare; la condizione resta scritta qui una volta sola.
 */
export type EsitoCondivisione =
  /** Foglio di sistema aperto (anche se poi l'utente ha annullato: è UX, non guasto). */
  | 'foglio'
  /** Link copiato negli appunti: l'utente non vede niente, va avvisato. */
  | 'appunti'
  /** Niente di niente: nessun canale disponibile, o quello disponibile ha fallito. */
  | 'non-riuscita'

/**
 * Condivide un LINK, e dice per quale strada è passato.
 *
 * È l'implementazione vera; `condividi()` qui sotto ne è l'involucro `void` per
 * i chiamanti a cui l'esito non serve.
 */
export async function condividiLink(input: CondivisioneInput): Promise<EsitoCondivisione> {
  // 1. Nativo: plugin Capacitor.
  if (isNativeApp()) {
    try {
      const { Share } = await import('@capacitor/share')
      await Share.share(input)
      return 'foglio'
    } catch (e) {
      // Annullamento utente → il meccanismo ha funzionato. Plugin assente → no.
      return annullatoDallUtente(e) ? 'foglio' : 'non-riuscita'
    }
  }

  // 2. Web con Web Share API.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share(input)
      return 'foglio'
    } catch (e) {
      // NON si ricade sugli appunti: il foglio è stato offerto, e riproporre una
      // copia dopo che l'utente ha chiuso il pannello è un secondo gesto che lui
      // non ha chiesto. Era il comportamento di prima e resta.
      return annullatoDallUtente(e) ? 'foglio' : 'non-riuscita'
    }
  }

  // 3. Fallback: copia negli appunti l'URL (o, in mancanza, il testo).
  const testo = input.url || input.text || ''
  if (
    testo &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(testo)
      return 'appunti'
    } catch {
      // Appunti negati dal browser: chi chiama lo saprà dall'esito.
      return 'non-riuscita'
    }
  }
  return 'non-riuscita'
}

/**
 * Condivide un link senza riportare l'esito. Resta per i chiamanti che non hanno
 * niente da farci (una news, un avviso): non lancia mai.
 */
export async function condividi(input: CondivisioneInput): Promise<void> {
  await condividiLink(input)
}

/**
 * Passa al foglio di sistema un FILE GIÀ PRESENTE sul dispositivo (`file://…`).
 * Solo nativo: sul web non esiste un equivalente che valga la pena fingere
 * (`navigator.share` vuole oggetti `File`, non percorsi), e chi chiama ha già la
 * sua strada — l'ancora `download` su un `blob:`.
 *
 * PERCHÉ STA QUI e non dentro `scarica.ts`: `@capacitor/share` si importa in un
 * posto solo. Due import dello stesso plugin sono due comportamenti che
 * divergeranno, ed è il difetto che questo giro di lavoro è venuto a togliere —
 * i pulsanti della galleria erano scritti due volte, sulla card e nel visore.
 *
 * Ritorna `true` quando il foglio è stato APERTO. L'annullamento dell'utente
 * conta come `true`: il meccanismo ha funzionato, ha solo cambiato idea lui — e
 * chiamarlo guasto significherebbe scrivere in `app_log` una riga d'errore ogni
 * volta che qualcuno tocca «Annulla».
 */
export async function condividiFileLocale(uri: string, titolo?: string): Promise<boolean> {
  if (!uri || !isNativeApp()) return false
  try {
    const { Share } = await import('@capacitor/share')
    await Share.share({ files: [uri], ...(titolo ? { title: titolo } : {}) })
    return true
  } catch (e) {
    return annullatoDallUtente(e)
  }
}

/**
 * L'annullamento del foglio di condivisione, che NON è un guasto.
 *
 * Due forme, perché le piattaforme non concordano: iOS e la Web Share API
 * alzano un `AbortError`, il plugin Android rifiuta con un messaggio che dice
 * «Share canceled». Il `message` si legge solo per DECIDERE, e non esce di qui:
 * nei log va il verdetto, mai il testo dell'errore (§8 di AGENTS.md).
 */
function annullatoDallUtente(e: unknown): boolean {
  try {
    const err = e as { name?: unknown; message?: unknown } | null | undefined
    if (err?.name === 'AbortError') return true
    return typeof err?.message === 'string' && /cancel|annull/i.test(err.message)
  } catch {
    // Getter ostile sull'errore: nel dubbio è un guasto, e chi chiama ripiega.
    return false
  }
}
