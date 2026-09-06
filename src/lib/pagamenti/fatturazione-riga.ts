/**
 * ─── IL MOTORE: UNA POLITICA SOLA, LETTA DAL BROWSER E DAL SERVER ────────────
 *
 * «Questa riga della Riconciliazione è fatturata, o è da fatturare?» — qui, e in
 * nessun altro posto.
 *
 * PERCHÉ ESISTE, e non è una rifattorizzazione di gusto.
 *
 * Fino al 2026-09-06 questa politica era scritta due volte: dentro
 * `chipFatturazione` (il chip della lista) e dentro
 * `api/pagamenti/riconciliazione` (`fatturaGiaFatta` / `fatturaDaFare`, che
 * decidevano il sottofiltro `?fattura=`). Le due copie NON erano identiche, e la
 * differenza stava in un dettaglio che nessuna delle due dichiarava: il DOCUMENTO
 * SINTETICO.
 *
 * La rotta appende `{ stato: 'da_fatturare', numeri: [] }` a ogni riga abbinata
 * che in `fatture_emesse` non ha nessuna riga — quindi per il filtro «un
 * documento» c'era sempre, e il ripiego sul riassunto non scattava mai. Il chip
 * invece ci ripiega ogni volta che il documento non è `emessa` né `scartata`.
 *
 * Il caso in cui divergevano è quello che `src/lib/aruba/emissione.ts` chiama
 * «il caso più velenoso»: la fattura è partita verso lo SdI e la scrittura in
 * `fatture_emesse` NON è andata a buon fine, quindi resta un `fattura_stato`
 * `in_attesa` senza nessun documento accanto. Il chip diceva «In attesa SDI», il
 * filtro la metteva fra le «Da fatturare e scartate» — un bidone in cui non si
 * può fare niente, perché su `in_attesa` il pulsante di emissione non c'è
 * (`MovimentoDialog.tsx`) — e la toglieva da «Fatturate e in attesa», che è
 * l'elenco con cui si controlla che le fatture siano uscite davvero.
 *
 * ⚠️ IL DOCUMENTO SINTETICO NON DIMOSTRA UN'ASSENZA. `da_fatturare` lì significa
 * soltanto «in `fatture_emesse` non c'è nessuna riga per questo pagamento»: chi
 * sa se una fattura è partita è il riassunto su `pagamenti`. Quindi vale come i
 * documenti solo quando ha qualcosa di POSITIVO da dire (`emessa`, `scartata`);
 * altrimenti si ripiega, esattamente come su `fattura: null`.
 *
 * ─── PERCHÉ STA IN `src/lib` E NON FRA I COMPONENTI ──────────────────────────
 *
 * La prima stesura di questa fusione mise il motore in
 * `components/features/admin/pagamenti/riconciliazione-ui.ts` e fece importare la
 * ROTTA da `@/components/…`. Funzionava — il modulo è puro — ma era il **primo**
 * import di `src/app/api` da `src/components` di tutto il repository: nessuna
 * regola lo intercettava (`eslint` esce 0, `tsc --noEmit` passa) e a provare
 * davvero la frontiera RSC è solo `next build`. Cioè: il giorno in cui qualcuno
 * avesse aggiunto un `'use client'`, o un import di React, in un file di
 * componenti — la cosa più naturale del mondo, in quella cartella — la rotta
 * sarebbe caduta in CI, lontano da chi ha scritto la riga e con un messaggio che
 * non nomina la fatturazione.
 *
 * Qui vive la POLITICA (che cosa risulta di una riga). Il CHIP — pelle, etichette,
 * forma, Alto Contrasto — resta in `riconciliazione-ui.ts`, che è roba da schermo.
 *
 * ⚠️ QUESTO MODULO LO IMPORTA IL SERVER (la rotta del registro) E IL BROWSER (il
 * chip). Deve restare privo di `use client`, di React e di `next-intl`: da qui
 * escono verdetti, non testi — a tradurre è chi disegna. Lock:
 * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts`.
 */

/** Gli stati di `pagamenti.fattura_stato` (colonna esistente, nessuna migrazione). */
export type StatoFattura = 'non_richiesta' | 'in_attesa' | 'emessa' | 'scartata'

/**
 * Lo stato della FATTURA di un movimento già abbinato, come lo calcola il GET.
 *
 * Tre stati, non due: `emessa` porta i numeri dei documenti (uno per quota, quindi più
 * d'uno sui pagamenti ripartiti fra due genitori), `scartata` è un tentativo fallito da
 * riemettere, `da_fatturare` è un bonifico incassato per cui non è mai partito niente.
 * Confondere le ultime due farebbe sembrare «da fare» un lavoro già fatto e finito male.
 */
export interface FatturaMovimentoUi {
  stato: 'emessa' | 'scartata' | 'da_fatturare'
  numeri: string[]
}

/** I quattro «tono» del chip: la chiave della pelle, non un testo. */
export type TonoFatturazione = 'fatturata' | 'attesa' | 'scartata' | 'da_fatturare'

/** Da dove viene il verdetto: i DOCUMENTI di `fatture_emesse` o il RIASSUNTO su `pagamenti`. */
export type FonteFatturazione = 'documenti' | 'riassunto'

/** Che cosa risulta della fattura di una riga: il tono, la fonte, e i numeri quando ci sono. */
export interface EsitoFatturazione {
  tono: TonoFatturazione
  fonte: FonteFatturazione
  /** Valorizzato solo con `fonte: 'documenti'` e tono `fatturata`: sono i numeri dei documenti. */
  numeri: string[]
}

/**
 * I QUATTRO CAMPI CHE DECIDONO, e nient'altro: la riga com'è nella lista o come
 * esce dal GET.
 *
 * `MovimentoUi` (la riga intera della lista) la estende, così le due forme non
 * possono divergere senza che `tsc` lo dica.
 */
export interface RigaFatturabile {
  /**
   * L'abbinamento. Senza, non esiste nessun pagamento da fatturare — e un documento
   * su una riga non abbinata sarebbe comunque roba d'altri.
   */
  pagamento_id?: string | null
  /**
   * Stato del pagamento collegato (`pagamenti.stato`), DERIVATO dal server e
   * valorizzato solo sui movimenti confermati di una sede dell'operatore.
   * Serve a un caso solo: distinguere «da fatturare» (saldato) dal rumore.
   */
  pagamento_stato?: string | null
  /**
   * Stato di fatturazione del PAGAMENTO (`pagamenti.fattura_stato`), stessa
   * minimizzazione.
   *
   * ⚠️ Convive con `fattura` qui sotto, e i due NON sono un doppione: questo è il
   * riassunto scritto sul pagamento (una riga sola, aggiornata dall'emissione),
   * quello è ciò che risulta dai DOCUMENTI davvero presenti in `fatture_emesse`,
   * quota per quota. Quando divergono vince `fattura`, perché è la fonte: un
   * `fattura_stato` fermo a `emessa` su un documento poi scartato dallo SdI
   * direbbe «fatto» di un lavoro da rifare.
   */
  fattura_stato?: StatoFattura | null
  /**
   * Presente solo sulle righe già abbinate. `null` significa «non lo so» — la lettura di
   * `fatture_emesse` è fallita — ed è diverso da `da_fatturare`: in quel caso non si mostra
   * nessun chip che parli dei DOCUMENTI, e si ripiega su `fattura_stato`.
   *
   * ⚠️ A differenza dei due campi qui sopra, questo NON è minimizzato per sede: arriva anche
   * sulle righe di un altro plesso, col numero del documento. È una decisione dichiarata —
   * il registro è l'estratto conto unico del titolare, cross-sede per progetto — e il perché
   * sta nella rotta, accanto al codice che la applica (`api/pagamenti/riconciliazione`).
   */
  fattura?: FatturaMovimentoUi | null
}

/** Da quale stato di fatturazione nasce quale tono (gli sconosciuti: nessuno). */
const TONO_DA_FATTURA: Partial<Record<StatoFattura, TonoFatturazione>> = {
  in_attesa: 'attesa',
  emessa: 'fatturata',
  scartata: 'scartata',
}

/**
 * Lo stato di fatturazione di una riga, o `null` se non c'è niente da dire.
 *
 * L'ordine delle due fonti non è arbitrario: v. la testata di questo file.
 */
export function esitoFatturazione(m: RigaFatturabile): EsitoFatturazione | null {
  // Su una riga non abbinata non esiste nessun pagamento da fatturare, e un
  // documento lì sarebbe comunque roba d'altri.
  const documenti = m.pagamento_id ? m.fattura ?? null : null
  if (documenti?.stato === 'emessa') {
    // Senza numeri leggibili resta «Fatturata»: il tono è lo stesso, cambia solo
    // che cosa si riesce a scriverci dentro.
    return { tono: 'fatturata', fonte: 'documenti', numeri: documenti.numeri.filter((n) => typeof n === 'string' && n !== '') }
  }
  if (documenti?.stato === 'scartata') return { tono: 'scartata', fonte: 'documenti', numeri: [] }
  const fs = m.fattura_stato
  if (!fs) return null
  // ⚠️ «Da fatturare» è l'unico caso che pretende DUE campi: `non_richiesta` su un
  // pagamento non ancora saldato non è un invito ad agire, è rumore su una riga che
  // l'emissione rifiuterebbe.
  const tono: TonoFatturazione | undefined =
    fs === 'non_richiesta' ? (m.pagamento_stato === 'pagato' ? 'da_fatturare' : undefined) : TONO_DA_FATTURA[fs]
  if (!tono) return null
  return { tono, fonte: 'riassunto', numeri: [] }
}

/**
 * I DUE BIDONI DEL SOTTOFILTRO `?fattura=`, e sono una PARTIZIONE dei quattro toni.
 *
 * «Fatturate» comprende le IN ATTESA (il documento è partito, la risposta dello SdI
 * no) e «Da fatturare» comprende le SCARTATE (una fattura respinta va rifatta): due
 * bidoni per quattro chip, ed è per questo che le etichette li nominano tutti e
 * quattro (v. `FILTRI_FATTURA` in `riconciliazione-ui.ts`). Una riga senza chip non
 * sta in nessuno dei due.
 */
const TONI_FATTA = new Set<TonoFatturazione>(['fatturata', 'attesa'])
const TONI_DA_FARE = new Set<TonoFatturazione>(['da_fatturare', 'scartata'])

/** La fattura è già partita (in viaggio verso lo SdI o consegnata): non si rifà. */
export function fatturaGiaFatta(m: RigaFatturabile): boolean {
  const esito = esitoFatturazione(m)
  return esito != null && TONI_FATTA.has(esito.tono)
}

/**
 * La fattura è ancora da fare: mai emessa, oppure emessa e SCARTATA dallo SdI.
 *
 * ⚠️ Non basta a mettere una riga nella lista di lavoro: chi filtra pretende anche
 * il movimento CONFERMATO e il pagamento SALDATO (su un pagamento parziale la
 * fattura non si emette). Qui c'è solo la parte che riguarda la fattura.
 */
export function fatturaDaFare(m: RigaFatturabile): boolean {
  const esito = esitoFatturazione(m)
  return esito != null && TONI_DA_FARE.has(esito.tono)
}
