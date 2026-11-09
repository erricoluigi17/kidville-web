/**
 * «FIRMATO IN APP» PER UN ANNO — il calcolo, puro (PR 4.5, compito 4.5.10).
 *
 * La segreteria spunta i moduli dell'iscrizione a mano (decisione §4.18.7: la spunta è sua). Accanto alla spunta le si dice, a titolo
 * INFORMATIVO, se la famiglia ha già firmato lo stesso modulo in app. La risposta 10 dice che i moduli scadono con l'anno, tranne i
 * sanitari: perciò una firma dell'anno scorso non è una firma di quest'anno, e senza questo calcolo la segreteria leggerebbe
 * «firmato in app il…» accanto a una firma del 2026/27 mentre prepara il 2027/28.
 *
 *  · `durata = 'anno'`        — conta la firma dell'anno della frequenza: dal giorno dopo l'ultimo giorno aperto dell'anno prima
 *                               (la stessa soglia di `da-rifirmare.ts`: chi firma in giugno per l'anno che viene, firma per quello)
 *                               fino alla fine dell'anno.
 *  · `durata = 'fino_a_revoca'` — vale anche una firma precedente, di qualunque anno: conta ogni firma fino alla fine dell'anno.
 *
 * Una firma DOPO la fine dell'anno non conta mai (sarebbe di un anno dopo). Nessuna firma corrisponde a un `codice` che non sia
 * del registro dei prestampati: i moduli «fuori registro» (un foglio cartaceo) si spuntano e basta.
 *
 * Restituisce il GIORNO (di Roma, `AAAA-MM-GG`), mai l'istante né il documento: è un'informazione, non un fascicolo.
 * Modulo PURO, come `registro.ts` e `da-rifirmare.ts`: le letture stanno nella route.
 */

import { dataCivile } from '@/i18n/config'
import { prestampato } from '@/lib/prestampati/registro'

/** Una riga del fascicolo, con le sole colonne che servono. */
export interface FirmaDelFascicolo {
  document_type: string | null
  created_at: string | null
}

/** L'anno della frequenza, com'è nel calendario della sede. Tutte date `AAAA-MM-GG`. */
export interface AnnoDellaFirma {
  inizio: string
  fine: string
  /** L'`ultimo_giorno_aperto` dell'anno prima, se la sede lo ha. Senza, la soglia è l'inizio dell'anno. */
  ultimoGiornoAnnoPrima: string | null
}

/** Il giorno di Roma di una firma, o `null` se la data non si legge. */
function giorno(creataIl: string | null): string | null {
  if (!creataIl) return null
  const istante = new Date(creataIl)
  return Number.isNaN(istante.getTime()) ? null : dataCivile(istante)
}

/** `true` se il `codice` del modulo è uno slug del registro: solo allora ha senso cercare la firma. */
export function haUnaFirmaInApp(codice: string): boolean {
  return prestampato(codice) !== null
}

/**
 * L'ultimo giorno in cui la famiglia ha firmato `codice` in modo che valga per `anno`, o `null`.
 * `null` anche se il `codice` non è del registro.
 */
export function firmatoInAppIl(
  codice: string,
  firme: readonly FirmaDelFascicolo[],
  anno: AnnoDellaFirma,
): string | null {
  const voce = prestampato(codice)
  if (!voce) return null
  let ultima: string | null = null
  for (const f of firme) {
    if (f.document_type?.trim() !== voce.slug) continue
    const g = giorno(f.created_at)
    if (!g || g > anno.fine) continue
    if (voce.durata === 'anno') {
      // Dal giorno DOPO l'ultimo giorno aperto dell'anno prima; senza quel confine, dall'inizio dell'anno.
      if (anno.ultimoGiornoAnnoPrima ? g <= anno.ultimoGiornoAnnoPrima : g < anno.inizio) continue
    }
    if (!ultima || g > ultima) ultima = g
  }
  return ultima
}
