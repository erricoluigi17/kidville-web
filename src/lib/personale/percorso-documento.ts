// IL DOCUMENTO D'IDENTITÀ DEL PERSONALE: quali colonne lo tengono, e che forma ha il
// percorso che ci sta dentro.
//
// ── PERCHÉ ESISTE QUESTO FILE, DETTO CON CIÒ CHE È SUCCESSO ─────────────────────────
//
// Fino all'11/08/2026 la scansione era UNA e la colonna si chiamava `documento_path`.
// Il 12/08 la migrazione `20260812194501` l'ha RINOMINATA in `documento_fronte_path` e
// ne ha aggiunta una seconda, `documento_retro_path`. Il rinomino è stato applicato in
// produzione; il codice no. Risultato, misurato sul database vero e non dedotto:
//
//     select id from pratiche_personale where documento_path = '…'
//     → ERROR 42703: column "documento_path" does not exist
//
// I due `assertDocumentoInScope` del pannello di Segreteria interrogavano quella
// colonna, sono fail-CLOSED per scelta, e un errore di lettura lì dentro significa
// «non firmo». Cioè: dal momento del rinomino, la Segreteria non poteva più aprire
// NESSUNA scansione di documento d'identità, in nessuna delle tre sedi, e la risposta
// che riceveva era la stessa di un tentativo abusivo. Nessun test era rosso.
//
// La lezione che questo file mette in pratica è una sola: **il nome di una colonna che
// tiene un documento non si scrive due volte.** Sta scritto qui, si legge dal template
// (`COLONNE_DOCUMENTO`), e chi interroga il database itera su quell'elenco.
//
// ── CHI CHIAMA QUESTO MODULO, oggi, verificabile con `grep -rn … src/` ──────────────
//
//   `COLONNE_DOCUMENTO`
//     · `iscrizione/personale:POST` — valida la forma di OGNI faccia dichiarata, e
//       dichiara `COLONNE_INDEGRADABILI`: sono le uniche colonne che il suo ramo di
//       degrado non toglie mai (risponde 503 invece di scrivere una pratica senza la
//       scansione, e la migrazione `20260812194501` lo prescrive per esteso);
//     · `admin/pratiche-personale:GET` — `assertDocumentoInScope`, una colonna per volta;
//     · `admin/anagrafica-personale:GET` — idem, sul fascicolo;
//     · `gdpr/retention-personale:POST` — le colonne che si leggono, quelle la cui
//       assenza rende il documento IGNOTO e quelle che l'`UPDATE` azzera. ⚠️ Fino al
//       13/08/2026 quel file NON era in questo elenco perché se le ribatteva a mano:
//       misurato aggiungendo un terzo campo `file` al template — 136 test rossi in 14
//       file e la conservazione **93/93 verde**, cioè una terza faccia sarebbe entrata,
//       sarebbe stata archiviata, e non sarebbe stata cancellata mai. Adesso il divieto
//       di riscriverli è un lock:
//       `__tests__/architecture/colonne-documento-un-posto-solo.test.ts`.
//   `percorsoDocumentoAmmesso`
//     · `iscrizione/personale:POST` — il gate della porta ANONIMA, l'unica in cui il
//       percorso lo scrive chi bussa;
//     · `admin/pratiche-personale:GET` e `admin/anagrafica-personale:GET` — la PRIMA
//       riga dei due `assertDocumentoInScope`, prima di qualunque query.
//
//       ⚠️ Fino al 12/08/2026 questa voce diceva «e basta», con la motivazione che nei
//       gate admin il percorso «finisce in un `.eq()`, e lì la validazione di forma non
//       aggiungerebbe una difesa». Era vero finché la colonna era UNA. Con due colonne
//       la scrittura che viene naturale è un `.or(…)` — e in quel momento la frase
//       diventa il permesso scritto di aprire la porta descritta nel riquadro qui
//       sotto. Il gate di forma sta davanti proprio perché la difesa non deve dipendere
//       da quale scrittura sceglierà chi tocca quel file domani.
//   `DOC_MAX_LUNGHEZZA`
//     · gli schemi `zod` di `?doc=` nelle due rotte admin.
//   `DOC_PREFISSO`
//     · `iscrizione/personale/upload:POST` — la porta pubblica, che i percorsi li COSTRUISCE;
//     · `admin/anagrafica-personale/scansione:POST` — la porta di Segreteria, che li
//       costruisce nella STESSA forma (`documenti/<uuid>/<uuid>.<ext>`) proprio perché il
//       gate di forma e il `check (… like 'documenti/%')` valgano per entrambe senza una
//       seconda regola.
//
//       ⚠️ Fino al 13/08/2026 questa voce ne dichiarava UNO SOLO, sotto un titolo che
//       invita a verificare con `grep -rn`. Chi ha aggiunto la porta admin ha importato
//       la costante — che è la cosa giusta — e non ha aggiornato l'elenco: un elenco che
//       chiede di essere verificato e non supera la propria verifica è la forma di
//       documentazione che questo repo ha già pagato. Il comando è, letteralmente:
//
//           grep -rn "DOC_PREFISSO" src/
//
// ── ⚠️ PERCHÉ SI INTERROGA UNA COLONNA PER VOLTA, E NON CON UN `.or(…)` ─────────────
//
// Con due colonne da confrontare la scrittura che viene naturale è
//
//     .or(`documento_fronte_path.eq.${doc},documento_retro_path.eq.${doc}`)
//
// e sarebbe la cosa sbagliata da fare con del testo che arriva da fuori. In quella
// sintassi la virgola SEPARA le condizioni e le parentesi le RAGGRUPPANO: un valore che
// contenga una virgola non rompe il filtro — lo RISCRIVE. Il gate direbbe «questo
// documento è della tua sede» per un oggetto che non lo è. Non è un'iniezione SQL
// (PostgREST non concatena SQL): è un'iniezione di FILTRO, che qui produce lo stesso
// danno.
//
// Perciò i due gate admin fanno DUE COSE, e sono indipendenti apposta:
//
//   1. chiamano `percorsoDocumentoAmmesso` PRIMA di qualunque query, così il valore che
//      arriva a un filtro ha già un alfabeto senza virgole, parentesi e apici;
//   2. interrogano una colonna per volta con `.eq()`, che non interpola niente — il
//      valore viaggia come parametro e la virgola esce percent-encodata. Misurato, non
//      supposto:
//
//          node -e "new URLSearchParams({a:'x,y'}).toString()"   →  a=x%2Cy
//
// Due difese per la stessa porta, e non è ridondanza pigra: la (1) sta in QUESTO file e
// la (2) in quelli delle rotte. Se un domani la forma si allargasse per far passare un
// percorso legittimo che oggi non passa, la (2) regge senza che nessuno se ne ricordi;
// se le rotte passassero a un `.or()`, la (1) è ciò che impedisce il danno. Con una
// difesa sola, ogni allentamento in un file diventerebbe un buco in un altro.
//
// Il costo è una seconda lettura solo quando la prima non trova nulla, su una rotta che
// gira a ogni clic su «Apri documento». Il guadagno è che non esiste, in questo repo,
// un solo posto in cui il testo di un anonimo entri in un filtro composto.
//
// ── COSA QUESTO GATE NON FA ────────────────────────────────────────────────────────
//
// La forma NON dimostra che l'oggetto esista, né che sia della pratica che lo dichiara:
// gli uuid non sono indovinabili, ma un URL firmato porta il percorso in chiaro, e
// questa forma è documentata in un repository PUBBLICO. Quelle due catene si chiudono
// con una lettura sul registro dei caricamenti (`@/lib/personale/caricamenti`) e col
// gate di sede, non qui. Questo resta il filtro di forma: costa zero, sta davanti a
// tutto, e respinge il grosso prima di toccare il database.
//
// ── ⚠️ NEL LOG NON VA MAI IL PERCORSO ──────────────────────────────────────────────
//
// Non contiene il nome del file (la rotta di caricamento lo butta via apposta), ma resta
// la chiave che apre il documento d'identità di una persona, e `redact()` non lo ha in
// lista bianca. Si registra CHE un percorso è stato respinto, mai che cosa era.

import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'

/**
 * Le colonne che tengono un percorso di documento — che sono anche gli id dei campi
 * `file` del modulo: `PERSONALE_FIELDS[].id` **è** il nome della colonna, e la
 * migrazione `20260812194501` lo dichiara esplicitamente come il motivo per cui ha
 * rinominato invece di affiancare.
 *
 * ⚠️ SI CHIAMA `COLONNE_` E NON `CAMPI_` PER NON COLLIDERE, e la collisione è reale:
 * in `src/components/features/anagrafica/DocumentoIdentitaFields.tsx` esiste già un
 * `CAMPI_DOCUMENTO` esportato che è un `FormField[]` (gli oggetti-campo del wizard,
 * `document_type` e `document_number` compresi), e un terzo in `StaffDetailPanel`.
 * Tre cose diverse con lo stesso nome sono un import sbagliato che compila.
 *
 * ⚠️ LA LETTURA È PER TIPO DI CAMPO, NON PER ID, ed è l'unica che il rinomino non
 * rompe. Un `find(f => f.id === 'documento_path')` sopravvive a un rinomino
 * restituendo `undefined` — cioè elenco vuoto, gate che respinge tutto e query che
 * cercano una colonna che non c'è più. È il difetto che è appena costato alla
 * Segreteria l'accesso a ogni documento d'identità, e sta in cima a questo file.
 *
 * FAIL-CLOSED se un giorno la lettura tornasse vuota: nessun campo da validare, ma
 * anche nessuna colonna da interrogare, quindi nessuna firma. Per un gate è la
 * direzione giusta, e il rosso arriva dalla suite prima che dal rilascio.
 */
const CAMPI_FILE = PERSONALE_FIELDS.filter((campo) => campo.type === 'file')

export const COLONNE_DOCUMENTO: readonly string[] = CAMPI_FILE.map((campo) => campo.id)

/**
 * La cartella dentro il bucket `documenti_personale`: l'unico prefisso che
 * `iscrizione/personale/upload:POST` produce — ed è quella rotta a importarlo, così la
 * costante e il percorso che nasce davvero non possono divergere.
 *
 * Il bucket separato rende impossibile PER COSTRUZIONE che di qui si indichi il
 * documento d'iscrizione di un minore (quelli stanno in `form_attachments`). Dentro lo
 * stesso bucket, il prefisso è il primo dei tre vincoli di forma.
 */
export const DOC_PREFISSO = 'documenti/'

/**
 * Il tetto di lunghezza, e non è una scelta di questo modulo: lo dichiarano le colonne,
 * con `check (… is null or length(…) <= 200)` su `documento_fronte_path` e
 * `documento_retro_path`.
 *
 * ⚠️ NON È PIÙ UN CONTROLLO DI `percorsoDocumentoAmmesso`, ed è un cambiamento del
 * 12/08/2026. C'era un `if (percorso.length > DOC_MAX_LUNGHEZZA) return false` e una
 * mutazione ha dimostrato che era codice morto: rimosso, la suite restava verde. Un percorso
 * che passa la forma è lungo 84 caratteri più l'estensione, e per superare 200 servirebbe
 * un'estensione di 117 caratteri — che in `DOC_ESTENSIONI` non c'è. Un ramo che non si
 * può far scattare, dentro un gate di sicurezza, racconta una difesa che non agisce.
 *
 * Dove il tetto agisce DAVVERO: negli schemi `zod` di `?doc=` delle due rotte admin,
 * dove la stringa arriva dalla query string senza nessuna forma imposta (prima era
 * `.max(500)`, con accanto un commento che diceva «lo stesso del CHECK in tabella»).
 * E nella suite, che misura che il percorso più lungo ammesso stia sotto questo numero.
 */
export const DOC_MAX_LUNGHEZZA = 200

/**
 * Le estensioni ammesse, LETTE DAL TEMPLATE e non ribattute.
 *
 * ⚠️ NON SI IMPORTA `ESTENSIONI_ALLEGATO_PUBBLICO`, che pure è la fonte di quella
 * lista: quella costante vive in `@/lib/upload/allegati-pubblici`, che tira dentro
 * `next/server`, e questo modulo deve poter essere caricato anche fuori da un handler.
 * L'allineamento fra le due liste non è affidato alla buona volontà: è un lock nella
 * suite, esattamente come il template fa per il proprio `accept`.
 */
export const DOC_ESTENSIONI: readonly string[] = [
  ...new Set(
    CAMPI_FILE.flatMap((campo) => String(campo.accept ?? '').split(','))
      .map((estensione) => estensione.trim().replace(/^\./, '').toLowerCase())
      .filter((estensione) => estensione !== ''),
  ),
]

/** Il solo uuid in minuscolo, come lo scrive `crypto.randomUUID()`. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * `documenti/<uuid>/<uuid>.<ext>` — la stessa forma che costruisce la rotta di caricamento.
 *
 * ⚠️ NESSUN FLAG, e sono tre decisioni diverse: `g`/`y` renderebbero la regex STATEFUL
 * (`lastIndex` sopravvive fra due `.test()`, quindi lo stesso percorso risulterebbe
 * valido a richieste alterne); `m` farebbe sì che `^` e `$` àncorino alla riga invece
 * che all'input, e `documenti/<uuid>/<uuid>.pdf\nqualunque-cosa` passerebbe. Senza `m`,
 * in JavaScript `$` àncora davvero alla fine dell'input — a differenza di Perl e Python,
 * dove accetta un a capo finale. La suite tiene ferme tutte e tre, misurando il
 * COMPORTAMENTO e non i flag.
 *
 * `DOC_PREFISSO` entra nel pattern senza escape perché non contiene metacaratteri: è una
 * costante di questo file, non un valore che arriva da fuori.
 */
const DOC_FORMA = new RegExp(`^${DOC_PREFISSO}${UUID}/${UUID}\\.[A-Za-z0-9]+$`)

/**
 * Solo la FORMA, senza l'elenco delle estensioni.
 *
 * È esportata per una ragione sola, e non è la comodità: la suite deve poter provare
 * che un percorso è respinto DALLA FORMA e non dall'estensione. La differenza è stata
 * misurata — togliendo l'àncora `$` quasi tutti i rifiuti restavano verdi perché
 * cadevano sull'estensione, e l'unico che diventava verde era il peggiore
 * (`….pdf,documento_retro_path.eq.….jpg`, che finisce con un'estensione legittima).
 * Senza questo predicato quella distinzione non si può scrivere, e la suite
 * dichiarerebbe difesa una regola che ha smesso di difendere proprio nel caso che conta.
 *
 * I caratteri che la forma ammette sono: `documenti/`, le cifre e le lettere `a-f` degli
 * uuid, i trattini degli uuid, le due barre, il punto, e per l'estensione `[A-Za-z0-9]+`
 * — quindi lì passano anche maiuscole e cifre (`.PDF` è ammesso e vale `pdf`). Ciò che
 * NON passa in nessuna posizione: virgole, parentesi, apici, spazi, a capo e ogni altro
 * metacarattere di un filtro PostgREST.
 */
export function formaDocumentoAmmessa(percorso: string): boolean {
  return DOC_FORMA.test(percorso)
}

/**
 * Il percorso ha la forma che la rotta di caricamento produce, e un'estensione in elenco.
 *
 * DUE controlli, in quest'ordine: la forma (che è anche ciò che rende il valore inerte
 * in un filtro PostgREST) e l'estensione, che la forma da sola non decide —
 * `[A-Za-z0-9]+` accetterebbe `.exe`.
 *
 * ⚠️ E DUE VUOL DIRE DUE. C'era anche un `if (punto < 0) return false`, tolto il
 * 12/08/2026 insieme al controllo di lunghezza e per la stessa ragione, verificata con
 * la stessa mutazione: rimosso, la suite resta verde (37/37 fra unità e integrazione).
 * Non poteva essere altrimenti — un percorso che ha passato `DOC_FORMA` contiene per
 * costruzione il punto dell'estensione. E il ramo non serve nemmeno come rete per il
 * futuro: se un domani la forma si allargasse a percorsi senza punto, `punto` varrebbe
 * `-1`, `slice(0)` restituirebbe il percorso intero e l'elenco delle estensioni lo
 * respingerebbe comunque. Fail-closed senza una riga di codice morto.
 *
 * L'estensione si confronta in minuscolo: `.PDF` è ammesso e vale `pdf`. È il
 * comportamento che la rotta pubblica ha da sempre, ed è preservato di proposito —
 * stringerlo sarebbe una decisione da prendere guardando i percorsi già archiviati, non
 * un effetto collaterale.
 */
export function percorsoDocumentoAmmesso(percorso: string): boolean {
  if (!formaDocumentoAmmessa(percorso)) return false
  return DOC_ESTENSIONI.includes(percorso.slice(percorso.lastIndexOf('.') + 1).toLowerCase())
}
