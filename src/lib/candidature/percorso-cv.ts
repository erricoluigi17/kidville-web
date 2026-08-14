// IL CURRICULUM DI UNA CANDIDATURA: dove si archivia, che forma ha il percorso che lo
// nomina, e chi ha il diritto di costruirne uno.
//
// ── PERCHÉ ESISTE QUESTO FILE ───────────────────────────────────────────────────────
//
// Perché la stessa regola vale per QUATTRO strade, e in questo repo una regola che vive
// in quattro posti diverge alla prima modifica — è la lezione scritta in
// `@/lib/allegati/mime`, in `@/lib/personale/percorso-documento` e in
// `@/lib/storage/rimozione-verificata`, ognuna pagata con un difetto in produzione:
//
//   · `iscrizione/insegnanti/upload:POST`  — la porta pubblica che i percorsi li COSTRUISCE;
//   · `iscrizione/insegnanti:POST`         — il gate che decide se accettare il percorso
//                                            dichiarato da chi invia il modulo;
//   · `admin/candidature-insegnanti:GET`   — il pannello di Segreteria, che lo FIRMA;
//   · `gdpr/retention-candidature:POST`    — il cron che lo CANCELLA a termine scaduto.
//
// Prima del 2026-08-15 le prime due non esistevano e le altre due si ribattevano il nome
// del bucket a mano (`BUCKET_CV` in una, `BUCKET_ALLEGATI` nell'altra: due nomi diversi
// per lo stesso archivio, in due file che devono per forza puntare allo stesso posto —
// uno firma ciò che l'altro cancella).
//
// ── ⚠️ IL BUCKET È QUELLO DEI DOCUMENTI DEI MINORI, E RESTA COSÌ ───────────────────
//
// `form_attachments` custodisce gli allegati delle domande d'iscrizione: carte d'identità
// di genitori e fotografie di bambini (1389 oggetti al 2026-08-15, misurati). Il
// curriculum ci convive, e la separazione è affidata al PREFISSO — non a un bucket suo,
// come è stato fatto per i documenti del personale.
//
// La scelta è deliberata e va detta, perché l'altra volta si era deciso il contrario:
//   · il bucket dichiara già i cinque tipi ammessi e il tetto (misurato: 8 MB, ma la
//     piattaforma taglia a 4 prima), cioè esattamente ciò che serve a un curriculum;
//   · le tre rotte che leggono percorsi `candidature/…` NON possono risolvere un percorso
//     `iscrizioni/…`, e viceversa: il gate di forma qui sotto rifiuta tutto ciò che non
//     comincia col prefisso giusto, e il gate del personale fa lo stesso col suo;
//   · un bucket nuovo avrebbe voluto dire una migrazione, un `allowed_mime_types` da
//     tenere allineato a un terzo posto e un lock in più — per una separazione che il
//     prefisso dà già.
// Il documento d'identità del personale ha avuto un bucket suo per un motivo che qui non
// vale: là il rischio era che il risolutore di percorso di un modulo firmasse l'oggetto
// dell'altro, e i due moduli erano gemelli. Qui i prefissi sono diversi per costruzione.
//
// ── IL NOME DEL FILE NON SOPRAVVIVE ALLA RICHIESTA ─────────────────────────────────
//
// `costruisciPercorsoCv` NON conserva il nome che il browser ha mandato, e non è una
// semplificazione: su questa porta quel nome è `cv-<cognome>.pdf`. Lo dice questo stesso
// repo, in `gdpr/retention-candidature:POST`, dove sta scritto testualmente che «in
// produzione si chiama `cv-<cognome>.pdf`: quel nome È il cognome di chi si è candidato».
// Un percorso finisce in una colonna del database, dentro un URL firmato che porta il
// percorso IN CHIARO, e — se qualcuno si distrae — dentro un log. Il cognome ci sta già,
// nella riga accanto, dove è protetto dal gate di sede: nel percorso non serve a niente.
//
// ⚠️ E NON SI TRATTA DI UNA FORMA PIÙ LARGA STRETTA A POSTERIORI: fino al 2026-08-15
// `cv_path` era NULL su tutte le candidature esistenti e il prefisso `candidature/` non
// conteneva NESSUN oggetto (misurato in produzione: 0 righe con curriculum, 0 oggetti).
// La forma è stata decisa nel momento in cui il primo curriculum poteva nascere, che è
// l'unico momento in cui la si può decidere senza migrare niente.
//
// ── ⚠️ NEI LOG NON VA MAI IL PERCORSO ──────────────────────────────────────────────
//
// Non contiene più il nome del file, ma resta la CHIAVE con cui si firma il curriculum di
// una persona, e `redact()` non lo ha in lista bianca. Si registra CHE un percorso è stato
// prodotto o respinto, mai che cosa era.

import { INSEGNANTE_FIELDS } from '@/lib/forms/insegnanti-template'

/**
 * L'archivio. È `form_attachments` — vedi la testata per il perché non è un bucket suo —
 * e da qui lo leggono la rotta di caricamento, il pannello di Segreteria e il cron di
 * conservazione: tre file che devono puntare allo stesso posto o uno firma ciò che un
 * altro non cancella.
 */
export const BUCKET_CURRICULUM = 'form_attachments'

/**
 * La cartella dentro il bucket: l'unico prefisso che `iscrizione/insegnanti/upload:POST`
 * produce, e l'unico che i gate accettano.
 *
 * È la parte che porta il peso della separazione: `iscrizioni/…`, cioè tutto ciò che
 * l'altra porta pubblica ha scritto in questo stesso bucket — i documenti dei minori —
 * non combacia, e da una candidatura non può più essere indicato.
 */
export const CV_PREFISSO = 'candidature/'

/**
 * Il nome fisso dell'oggetto, senza estensione.
 *
 * Due parole sul perché esiste una costante per tre caratteri: la forma pretende che dopo
 * l'uuid ci sia QUALCOSA (`-cv.<ext>`), e quel qualcosa è la stessa stringa nel costruttore
 * e nella regex che lo verifica. Scriverla due volte è il modo in cui il giorno in cui
 * diventasse `curriculum` la rotta produrrebbe percorsi che il proprio gate rifiuta — cioè
 * un caricamento riuscito e un invio che fallisce, dopo che il modulo è stato compilato
 * per intero. È il difetto «bucket più stretto del gate» che questo repo ha già pagato.
 */
const CV_NOME = 'cv'

/**
 * Il tetto di lunghezza. Non è la lunghezza della colonna (`text`): è il punto oltre il
 * quale un «percorso» non è più un percorso ma un campo di testo libero scritto da un
 * anonimo dentro il database.
 *
 * ⚠️ Con la forma attuale il percorso più lungo possibile misura **56 caratteri**
 * (`candidature/` 12 + uuid 36 + `-cv.` 4 + `webp` 4), quindi questo controllo oggi non
 * scatta mai. Resta, e non come codice morto: è il tetto che si applica al percorso che
 * arriva DA FUORI, cioè alla stringa che chi invia il modulo dichiara in `cv_path`. Lì
 * non c'è nessuna forma garantita prima di questo controllo, e una stringa di 10.000
 * caratteri non deve nemmeno arrivare alla regex.
 */
export const CV_MAX_LUNGHEZZA = 200

/**
 * Le estensioni ammesse, LETTE dal template e non ribattute — è la stessa lista che
 * `insegnanti-template.ts` tiene allineata a `ESTENSIONI_ALLEGATO_PUBBLICO` (e che un test
 * confronta con quella costante).
 *
 * ⚠️ NON si importa `ESTENSIONI_ALLEGATO_PUBBLICO`, che pure è la fonte di quella lista:
 * quella costante vive in `@/lib/upload/allegati-pubblici`, che tira dentro `next/server`,
 * e questo modulo deve poter essere caricato anche fuori da un handler. È la stessa
 * ragione, e la stessa nota, di `@/lib/personale/percorso-documento`.
 */
export const CV_ESTENSIONI: readonly string[] = String(
  INSEGNANTE_FIELDS.find((f) => f.id === 'cv_path')?.accept ?? '',
)
  .split(',')
  .map((e) => e.trim().replace(/^\./, '').toLowerCase())
  .filter((e) => e !== '')

/** Il solo uuid in minuscolo, come lo scrive `crypto.randomUUID()`. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * `candidature/<uuid>-cv.<estensione>` — la stessa forma che costruisce
 * `costruisciPercorsoCv`, e nient'altro.
 *
 * L'uuid è la parte che chi invia il modulo NON può scegliere: la genera il server al
 * momento del caricamento, e senza di essa il prefisso da solo non impedirebbe di indicare
 * l'oggetto di un'altra candidatura.
 *
 * Nessuna barra dopo il prefisso, quindi nessuna risalita: `..` non è nemmeno esprimibile,
 * perché fra l'uuid e il punto c'è una stringa fissa.
 *
 * ⚠️ NESSUN FLAG, e sono tre decisioni diverse — le stesse di `percorso-documento.ts`:
 * `g`/`y` renderebbero la regex STATEFUL (`lastIndex` sopravvive fra due `.test()`, quindi
 * lo stesso percorso risulterebbe valido a richieste alterne); `m` farebbe sì che `^` e `$`
 * àncorino alla riga invece che all'input, e `candidature/<uuid>-cv.pdf\nqualunque-cosa`
 * passerebbe. Senza `m`, in JavaScript `$` àncora davvero alla fine dell'input — a
 * differenza di Perl e Python, dove accetta un a capo finale.
 *
 * I caratteri che questa forma ammette sono soltanto: le lettere di `candidature/`, le
 * cifre e le lettere `a-f` dell'uuid, i trattini, `-cv.` e per l'estensione
 * `[A-Za-z0-9]+`. Ciò che NON passa in nessuna posizione: virgole, parentesi, apici, spazi
 * e a capo — cioè ogni metacarattere di un filtro PostgREST. Non è una cautela teorica: il
 * gate di Segreteria mette questo valore dentro un `.eq()`, e la nota su
 * `percorso-documento.ts` spiega per esteso come una virgola in quella posizione RISCRIVA
 * un filtro invece di romperlo.
 */
const CV_FORMA = new RegExp(`^${CV_PREFISSO}${UUID}-${CV_NOME}\\.[A-Za-z0-9]+$`)

/**
 * Solo la FORMA, senza l'elenco delle estensioni.
 *
 * Esportata per una ragione sola, e non è la comodità: la suite deve poter provare che un
 * percorso è respinto DALLA FORMA e non dall'estensione. Senza questo predicato la
 * distinzione non si può scrivere, e un allentamento della regex resterebbe verde perché
 * i casi cadrebbero tutti sull'estensione — è la misura fatta sul gemello del personale,
 * dove togliendo l'àncora `$` l'unico caso che diventava verde era il peggiore.
 */
export function formaCvAmmessa(percorso: string): boolean {
  return CV_FORMA.test(percorso)
}

/**
 * Il percorso ha la forma che la rotta di caricamento produce, e un'estensione in elenco.
 *
 * TRE controlli, in quest'ordine: la lunghezza (perché la stringa arriva da fuori e può
 * essere enorme), la forma (che è anche ciò che rende il valore inerte in un filtro
 * PostgREST) e l'estensione, che la forma da sola non decide — `[A-Za-z0-9]+`
 * accetterebbe `.exe`.
 */
export function percorsoCvAmmesso(percorso: string): boolean {
  if (percorso.length > CV_MAX_LUNGHEZZA) return false
  if (!formaCvAmmessa(percorso)) return false
  return CV_ESTENSIONI.includes(percorso.slice(percorso.lastIndexOf('.') + 1).toLowerCase())
}

/**
 * IL PERCORSO DI UN CURRICULUM APPENA CARICATO — l'unico modo legittimo di crearne uno.
 *
 * ⚠️ L'ESTENSIONE ARRIVA DAL TIPO, MAI DAL NOME DEL FILE, e chi chiama la ricava da
 * `estensioneArchiviata(gate.contentType)` — cioè dal tipo che
 * `verificaAllegatoPubblico` ha già normalizzato e ammesso. È la stessa cosa nei fatti
 * (il gate pretende che estensione e tipo concordino) ma per COSTRUZIONE e non per
 * fiducia: da `file.name` non passa un solo byte dentro questo percorso.
 *
 * Il valore prodotto soddisfa `percorsoCvAmmesso()` per costruzione, e non è un'aspettativa
 * scritta in un commento: `__tests__/lib/percorso-cv.test.ts` genera percorsi con tutte le
 * estensioni ammesse e lo verifica. Il giorno in cui le due funzioni divergessero, chi
 * carica riuscirebbe e chi invia il modulo si vedrebbe rifiutare il proprio allegato —
 * dopo aver compilato tutto.
 */
export function costruisciPercorsoCv(estensione: string): string {
  return `${CV_PREFISSO}${crypto.randomUUID()}-${CV_NOME}.${estensione}`
}
