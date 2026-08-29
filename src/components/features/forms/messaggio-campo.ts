'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import {
  MSG_CAMPO_OBBLIGATORIO,
  MSG_ALLEGA_FILE,
  MSG_SCEGLI_OPZIONE,
  MSG_SCEGLI_DA_ELENCO,
} from '@/lib/forms/validate-fields'

/**
 * ─── LA TRADUZIONE DELL'OBBLIGO VIVE IN UN POSTO SOLO (2026-08-25) ───────────
 *
 * `validateField` è la regola UNICA che gira sul client e sul server, e i suoi
 * messaggi sono ITALIANI PER COSTRUZIONE: sul server il locale dell'interfaccia
 * non esiste. Il lato client però quella stringa la mostra A SCHERMO, e le porte
 * pubbliche hanno il catalogo inglese completo — quindi qualcuno deve scambiare
 * la costante con la voce del catalogo. Fino a stamattina quel «qualcuno» era
 * un `if` dentro `FieldRenderer`, e chi rendeva un campo A MANO non ci passava.
 *
 * ⚠️ MISURATO su `/anagrafica-personale`, passo «I tuoi dati», dopo un «Avanti»
 * a passo vuoto, leggendo insieme i nove `[role=alert]` della stessa colonna:
 *   it → […, "Scegli prima la provincia di nascita: …", "Campo obbligatorio", …]
 *   en → […, "Choose the province of birth first: …", "Campo obbligatorio", …]
 * Il sesto è il codice fiscale, reso a mano per poter legare `aria-describedby`
 * al badge di coerenza. **Su una pagina inglese si leggeva una riga italiana**:
 * esattamente la «mezza traduzione» che il rimedio del 25/08 dichiarava chiusa.
 * E in italiano non era innocuo: otto frasi umane e una risposta di database in
 * mezzo, cioè una colonna incoerente dove prima era coerente.
 *
 * ⚠️ IL RIMEDIO NON È RIBATTERE L'`if` UNA QUARTA VOLTA. Quattro copie della
 * stessa mappatura sono quattro cose destinate a divergere alla prima frase
 * nuova, e diverge in silenzio: catalogo giusto, testo sbagliato a schermo, test
 * verdi. La mappatura esce di qui, e i quattro punti la chiamano.
 *
 * ⚠️ SI RICEVE L'ERRORE, NON IL MESSAGGIO. La funzione prende l'oggetto d'errore
 * di react-hook-form e fa da sé la lettura di `.message`: così il cast grezzo
 * `as { message?: string } | undefined` esiste in UN FILE SOLO di tutta la
 * superficie dei moduli, ed è greppabile. Se domani un quinto campo verrà reso a
 * mano, il lock `un solo lettore del messaggio grezzo` lo vedrà — invece di
 * scoprirlo un critico con lo screenshot di una pagina inglese.
 *
 * Il residuo — i predicati di FORMA (email, data, numero, pattern) — resta
 * italiano ed è debito dichiarato nella testata di `validate-fields`: si chiude
 * con questa stessa forma, una costante per messaggio, quando lo si affronterà.
 * Un messaggio che non riconosce passa di qui invariato.
 */
export function useMessaggioCampo(): (errore: unknown) => string | undefined {
  const t = useTranslations('parentForms')
  return useCallback(
    (errore: unknown): string | undefined => {
      const grezzo = (errore as { message?: string } | undefined)?.message
      if (grezzo === MSG_ALLEGA_FILE) return t('allegaFile')
      if (grezzo === MSG_SCEGLI_OPZIONE) return t('scegliOpzione')
      if (grezzo === MSG_SCEGLI_DA_ELENCO) return t('scegliDaElenco')
      if (grezzo === MSG_CAMPO_OBBLIGATORIO) return t('campoObbligatorio')
      return grezzo
    },
    [t],
  )
}
