/**
 * L'ESITO DI UN RAMO DI RIFIUTO CHE NOMINA I CAMPI, e che ci sta in 64 caratteri.
 *
 * ── PERCHÉ NON SI CONCATENA E BASTA ─────────────────────────────────────────
 *
 * `redact()` (`@/lib/logging/redact`) lascia in chiaro il valore di `esito` solo se
 * rispetta `FORMA_ENUMERATO`, che impone al massimo 64 caratteri. Sopra il tetto non
 * si perde il dettaglio: si perde TUTTO, perché l'intero valore diventa
 * `[redatto:str/N]` e nel log non resta nemmeno la parola «campi-non-validi». Cioè si
 * perde la CLASSIFICAZIONE del ramo — e il caso che lo innesca è il modulo spedito
 * quasi vuoto, che è la forma più comune di invio fallito.
 *
 * Misurato sui 32 id di `PERSONALE_FIELDS`: `campi-non-validi-` più tutti gli id
 * ordinati misura **oltre 400** caratteri, e già con TRE campi non validi
 * (`address.birth_date.birth_nation`) si superano i 64. Sull'anagrafica del personale
 * non è un caso limite: è il primo invio incompleto di chiunque.
 *
 * Qui il prefisso è garantito per costruzione (è corto e viene prima di tutto), gli id
 * entrano finché ci stanno, e i tagliati si CONTANO: `+7` dice che sopra ce n'erano
 * altri sette. Un elenco troncato senza il conteggio direbbe una cosa falsa — che i
 * campi respinti erano quelli e basta.
 *
 * L'alternativa (id in un campo separato) non regge alla misura: `campi_ko` non è una
 * chiave in lista bianca, quindi ogni id uscirebbe `[redatto:str/N]`. La lista bianca
 * sta in un file condiviso e non si allarga per comodità di una rotta.
 *
 * ── PERCHÉ STA QUI E NON DENTRO UNA ROUTE ───────────────────────────────────
 *
 * Perché la stessa regola vale già per due porte pubbliche — «Lavora con noi»
 * (`iscrizione/insegnanti:POST`) e l'anagrafica del personale
 * (`iscrizione/personale:POST`) — e in questo repo una regola valida per due strade
 * che vive in due posti diverge alla prima modifica: è successo su `gallery` (50 MB
 * nel bucket, 200 MB nella route, per mesi).
 *
 * ⚠️ OGGI LA MIGRAZIONE È A METÀ, e va detto invece che taciuto:
 * `src/app/api/iscrizione/insegnanti/route.ts` ha ancora una copia PRIVATA e identica
 * di questa funzione. Non è stata spostata qui perché quel file appartiene al modulo
 * delle candidature, che questo lavoro non tocca. Chi ci ripasserà cancelli quella
 * copia e importi da qui: è un import e una cancellazione.
 */

/** Il tetto di `FORMA_ENUMERATO` in `@/lib/logging/redact`. Sopra, il valore sparisce. */
const ESITO_MAX = 64

export function esitoConElenco(prefisso: string, ids: string[]): string {
  const ordinati = [...ids].sort()
  let testo = prefisso
  let messi = 0
  for (const id of ordinati) {
    const candidato = messi === 0 ? `${prefisso}-${id}` : `${testo}.${id}`
    const restanti = ordinati.length - (messi + 1)
    // Il marcatore di taglio si prenota PRIMA di aggiungere: se aggiungere un id
    // lasciasse fuori il `+N`, il valore direbbe di essere completo mentendo.
    const coda = restanti > 0 ? `+${restanti}`.length : 0
    if (candidato.length + coda > ESITO_MAX) break
    testo = candidato
    messi++
  }
  const tagliati = ordinati.length - messi
  return tagliati > 0 ? `${testo}+${tagliati}` : testo
}
