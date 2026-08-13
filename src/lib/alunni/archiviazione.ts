/**
 * ARCHIVIAZIONE DI UN ALUNNO — le due cose che i due lati devono dire uguali.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
 *
 * L'archiviazione ha due lati che devono concordare su un insieme chiuso: la
 * rotta (`admin/students/archivia:POST`, che valida `motivo` con `z.enum`) e la
 * scheda alunno (la tendina che quel motivo lo fa scegliere). Sono due file
 * diversi, scritti da due persone diverse, e il vincolo vero non sta in nessuno
 * dei due: sta nel `CHECK` del database
 * (`supabase/migrations/20260812194517_alunni_archiviazione.sql`).
 *
 * Con due elenchi paralleli il difetto non è teorico: la tendina propone
 * `trasferimento`, la rotta accetta `trasferito`, la richiesta prende **400** e
 * l'operatore legge «Dati non validi» su una scelta che gli è stata offerta.
 * L'elenco vive quindi in un posto solo, e chi lo cambia deve toccare la
 * migrazione — che è esattamente il punto in cui la decisione va presa.
 */

/**
 * I MOTIVI AMMESSI, nell'ordine in cui hanno senso per chi compila.
 *
 * ⚠️ DEVONO COMBACIARE con `alunni_archiviato_motivo_check`. La migrazione
 * spiega perché è un insieme chiuso e non testo libero: «un campo libero sulla
 * scheda di un minore è una PII nuova che nessuna lista bianca sorveglia».
 *
 * `altro` è l'ultima voce e non chiede di spiegarsi: la casella «specifica…»
 * accanto a un «altro» è il modo in cui il testo libero rientra dalla finestra.
 */
export const MOTIVI_ARCHIVIAZIONE = ['ritiro', 'fine_ciclo', 'trasferimento', 'altro'] as const

export type MotivoArchiviazione = (typeof MOTIVI_ARCHIVIAZIONE)[number]

/**
 * CHI PUÒ LIBERARE LO SPAZIO — la Direzione, e nessun altro.
 *
 * ⚠️ NON è chi può ARCHIVIARE. Archiviare si annulla (si riporta lo stato a
 * `iscritto` e il bambino ricompare), quindi lo fa tutto lo staff; liberare lo
 * spazio toglie file da tre bucket e cancella il testo dei messaggi, e non
 * esiste un ripristino. Il confine fra i due gesti passa esattamente di qui.
 *
 * ⚠️ E VIVE IN UN POSTO SOLO PER LA STESSA RAGIONE DEI MOTIVI, qui sopra: il
 * gate del server (`requireStaff`) e il filtro di cortesia del client
 * (`AlunniArchiviatiView`) devono dire la stessa cosa. Con due elenchi paralleli
 * la divergenza è muta in tutte e due le direzioni — un comando offerto a chi
 * riceverà 403, oppure un comando nascosto a chi ne ha diritto — e nessuno dei
 * due casi produce un errore che qualcuno vada a leggere.
 *
 * Che il gate del server riceva ESATTAMENTE questo elenco non è affidato alla
 * lettura del codice: `__tests__/api/admin-students-libera-spazio.test.ts`
 * asserisce l'argomento passato a `requireStaff` sul valore LETTERALE. Prima di
 * quella riga, aggiungere `'segreteria'` qui lasciava verdi 49 test dedicati e
 * i 1017 di architettura — misurato.
 */
export const RUOLI_LIBERA_SPAZIO = ['admin', 'coordinator'] as const

/**
 * LE SEI COLONNE che la migrazione ha aggiunto, e senza le quali l'archiviazione
 * NON si fa a metà.
 *
 * Serve a un solo scopo, ed è il commento qui sotto: sapere se l'ambiente le ha.
 */
export const COLONNE_ARCHIVIAZIONE = [
  'archiviato_il',
  'archiviato_da',
  'archiviato_motivo',
  'archiviato_section_id',
  'archiviato_classe_sezione',
  'spazio_liberato_il',
] as const

/**
 * «Questo errore PostgREST dice che una COLONNA non esiste?»
 *
 * ─── PERCHÉ QUI SI RIFIUTA INVECE DI DEGRADARE ───────────────────────────────
 *
 * Il resto del repo, davanti a `42703`/`PGRST204`, toglie la colonna dal record e
 * riprova: il DB E2E della CI è un progetto separato e non migrato, e un campo in
 * più non deve portarsi via un'intera funzionalità (vedi il ciclo di resilienza in
 * `admin/students:POST`).
 *
 * QUI QUELLA STRADA È VIETATA, e non è una svista. L'UPDATE dell'archiviazione fa
 * due cose insieme: sgancia il bambino dalla classe (`section_id` e
 * `classe_sezione` a NULL — è *quello* che lo fa sparire dagli elenchi) e RICORDA
 * da dove veniva (`archiviato_section_id`, `archiviato_classe_sezione`). Togliere
 * le colonne assenti e riprovare eseguirebbe la prima metà e non la seconda:
 * l'alunno esce dalla sua sezione e nessuna riga dice più quale fosse. Il ritorno
 * fra gli iscritti diventerebbe un indovinello — e «un bambino nella sezione
 * sbagliata è invisibile a chi lo cerca in quella giusta».
 *
 * Il degrado pulito, su questa operazione, è **non scrivere niente e dirlo**:
 * 503 con `ARCHIVIO_NON_DISPONIBILE`. Un'archiviazione a metà è irreversibile,
 * un 503 si ripete domani.
 *
 * ⚠️ Si guarda il CODICE e non il messaggio, a differenza di `colonnaSconosciuta`
 * (`@/lib/anagrafiche/parents`): quella funzione serve a sapere QUALE colonna
 * togliere, quindi deve estrarne il nome dal testo — e il testo del `42703` in
 * LETTURA («column alunni.archiviato_il does not exist») non ha la forma «of
 * relation» che quella regex cerca. Qui il nome non serve: la domanda è «l'archivio
 * esiste in questo database?», e la risposta è il codice.
 */
export function colonnaAssente(errore: { code?: string } | null | undefined): boolean {
  const codice = errore?.code
  return codice === '42703' || codice === 'PGRST204'
}
