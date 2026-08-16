/**
 * Quanto paga la famiglia, e chi la paga.
 *
 * ─── LE TRE RISPOSTE POSSIBILI ──────────────────────────────────────────────
 *   · IMPORTO         accanto al nome c'è una cifra → è quella
 *   · A_CARICO        accanto al nome c'è «vedi fratello» → paga un fratello
 *   · DA_CONTROLLARE  tutto il resto: vuoto, «?», cifre di famiglia discordi
 *
 * ─── LO ZERO NON SIGNIFICA «NON PAGA», E QUESTA È LA RIGA PIÙ IMPORTANTE ────
 * La retta di un alunno finisce in `alunni.importo_retta_mensile`, e chi genera
 * le rette mensili la legge così:
 *
 *     COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150)
 *     — supabase/migrations/20260731115341_genera_rette_per_sede.sql:154
 *     — e il gemello in src/app/api/pagamenti/genera-rette/route.ts:52-55
 *
 * `NULLIF(…, 0)` **annulla lo zero**, e al suo posto entra il default della
 * sede: misurato il 2026-08-16, per tutte e tre le sedi vale 150,00 €. Scrivere
 * zero a un bambino che non deve pagare gli manderebbe 150 € al mese per dieci
 * mesi, senza che nessun errore compaia da nessuna parte.
 *
 * Per questo `a_carico` è un esito distinto e non «importo = 0»: chi lo riceve
 * scrive `alunni.retta_a_carico_di`, ed è QUELLA colonna — non la cifra — a far
 * saltare l'alunno alla generazione delle rette.
 *
 * ─── PERCHÉ «UNA SOLA CIFRA IN FAMIGLIA» ────────────────────────────────────
 * Il rimando dice «paga mio fratello», non «paga quanto mio fratello». Se in
 * famiglia le cifre sono due e diverse, non c'è modo di sapere quale sia la
 * retta di famiglia e quale un caso a parte: ci si ferma. Sul file vero il caso
 * esiste ed è raro; quello frequente è l'opposto — una cifra sola che copre due
 * o tre figli (`BADALAMENTI`: 450 € per tre).
 */
import type { RigaElenco } from './abbinamento'

export type EsitoRetta =
  | { tipo: 'importo'; importo: number }
  | { tipo: 'a_carico'; importoFamiglia: number; aCaricoDi: RigaElenco }
  | { tipo: 'da_controllare'; motivo: string }

/**
 * Riconosce il rimando a un fratello.
 *
 * Volutamente largo sulla parola che segue: sul file vero compaiono «vedi
 * fratello», «vedi sorella», «vedi fr», «vedi sor», «vedi sor micronido» e
 * «VEDI SORELA» (con il refuso). Volutamente stretto su «vedi»: un testo che
 * non contiene quella parola non viene interpretato, viene passato a una
 * persona.
 */
const RIMANDO = /\bvedi\b/i

/** Una cifra utilizzabile: positiva. Lo zero e i negativi non lo sono (v. testata). */
function cifraValida(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * @param riga     la riga dell'elenco del bambino
 * @param fratelli le righe dell'elenco dei suoi fratelli — riconosciuti dal
 *                 CODICE FISCALE DEL GENITORE, non dal cognome: sul file vero
 *                 una famiglia ha due cognomi diversi sotto lo stesso genitore,
 *                 e due fratelli stanno in domande separate.
 */
export function risolviRetta(riga: RigaElenco, fratelli: readonly RigaElenco[]): EsitoRetta {
  if (cifraValida(riga.retta)) return { tipo: 'importo', importo: riga.retta }

  if (riga.retta !== null && riga.retta !== undefined) {
    return {
      tipo: 'da_controllare',
      motivo:
        riga.retta === 0
          ? 'La retta è scritta come 0: nel registro lo zero vale «usa la retta di default della sede» (150 €). Se il bambino non deve pagare, va indicato il fratello che paga per lui.'
          : `La retta scritta nel foglio non è una cifra utilizzabile: ${riga.retta}.`,
    }
  }

  const testo = (riga.rettaTesto ?? '').trim()
  if (!testo) {
    return { tipo: 'da_controllare', motivo: 'Nel foglio manca la retta: la cella accanto al nome è vuota.' }
  }

  if (!RIMANDO.test(testo)) {
    return {
      tipo: 'da_controllare',
      motivo: `Al posto della retta il foglio riporta «${testo}», che non è né una cifra né un rimando a un fratello.`,
    }
  }

  const conCifra = fratelli.filter((f) => cifraValida(f.retta))
  if (conCifra.length === 0) {
    return {
      tipo: 'da_controllare',
      motivo:
        fratelli.length === 0
          ? `Il foglio dice «${testo}», ma fra le iscrizioni arrivate non risulta nessun fratello a cui la retta sia intestata.`
          : `Il foglio dice «${testo}», ma nessuno dei fratelli ha una cifra accanto al nome.`,
    }
  }

  const importi = [...new Set(conCifra.map((f) => f.retta as number))]
  if (importi.length > 1) {
    return {
      tipo: 'da_controllare',
      motivo: `Il foglio dice «${testo}», ma i fratelli hanno rette diverse fra loro (${importi
        .sort((a, b) => a - b)
        .map((i) => `${i} €`)
        .join(', ')}): non è possibile dedurre quale sia la retta di famiglia.`,
    }
  }

  return { tipo: 'a_carico', importoFamiglia: importi[0], aCaricoDi: conCifra[0] }
}
