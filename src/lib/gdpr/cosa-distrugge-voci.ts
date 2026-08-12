// =============================================================================
// LE VOCI DELL'AVVISO — la parte che il PANNELLO legge, e SOLO quella.
//
// ⚠️ PERCHÉ QUESTO FILE ESISTE, separato da `cosa-distrugge.ts`.
// Non è un'organizzazione più bella: è un vincolo del bundler, e senza di esso
// l'applicazione NON COMPILA. `AvvisoOblio.tsx` è un componente client e importa
// queste costanti; `cosa-distrugge.ts` importa `logger` → `app-log` →
// `supabase/server-client`, che nel browser non può esistere. Tenendo le due cose
// nello stesso file, l'intera catena del server finiva nel bundle del client e
// `npm run build` falliva — misurato il 2026-08-13.
//
// La regola che ne discende, per chi aggiunge roba qui: in questo file entrano solo
// DATI e TIPI. Nessun import che tocchi Supabase, il logger o `next/headers`. Se
// una voce nuova avesse bisogno di leggere qualcosa, quel qualcosa va in
// `cosa-distrugge.ts`, che questo file non conosce.
//
// `cosa-distrugge.ts` le RI-ESPORTA tutte, così le route e il lock
// `oblio-avviso-dichiarato.test.ts` continuano a importarle da lì: chi legge quel
// modulo non deve sapere che lo split esiste.
// =============================================================================


// =============================================================================
// CHE COSA DISTRUGGE L'OBLIO — detto per intero, PRIMA di farlo.
//
// ─── IL DIFETTO ─────────────────────────────────────────────────────────────
//
// Il pannello della Direzione faceva confermare un'anonimizzazione IRREVERSIBILE
// mostrando quattro righe: anagrafica, genitori, genitori mantenuti e «file da
// rimuovere: N». Quel numero è l'unica cosa che parlava dei documenti, e non dice
// che cosa sono: al 2026-08-12 dentro ci finiscono le PAGELLE del bambino e i suoi
// CERTIFICATI MEDICI, oltre alle foto, agli allegati di chat e alla domanda
// d'iscrizione. Chi confermava non poteva saperlo — non perché fosse nascosto, ma
// perché non era scritto da nessuna parte che un operatore potesse leggere.
//
// Non è un dettaglio di interfaccia. «File da rimuovere: 3» e «se ne vanno le due
// pagelle e il certificato medico di suo figlio» sono la stessa operazione e due
// decisioni diverse, e chi risponde alla famiglia è la persona che legge quella
// riga.
//
// ─── PERCHÉ UNA FONTE UNICA, E NON UN ELENCO SCRITTO NEL PANNELLO ───────────
//
// Perché un elenco scritto nel pannello invecchia in silenzio. `esegui.ts` porta
// già `REGISTRO_BUCKET_OBLIO`, che dice magazzino per magazzino chi lo svuota: il
// giorno in cui l'oblio comincerà a svuotarne uno in più, quel registro lo saprà e
// l'avviso no. Qui c'è la SECONDA metà del giro — «e quindi che cosa dico
// all'operatore?» — e `__tests__/architecture/oblio-avviso-dichiarato.test.ts`
// tiene insieme le due: ogni bucket coperto per il canale ALUNNO deve comparire
// qui, e ogni voce con un bucket dev'essere davvero coperta là. Un magazzino nuovo
// rende rosso l'avviso finché qualcuno non lo dice a chi conferma.
//
// ⚠️ Qui NON si esegue niente: questo modulo dichiara e CONTA (sole `SELECT`).
// L'esecuzione sta in `src/lib/gdpr/esegui.ts` e non passa di qui.
// =============================================================================

/** Chi può chiedere l'oblio — ricalca `CanaleOblio` di `esegui.ts`. */
type Canale = 'alunno' | 'genitore'

/**
 * I campi del corpo del dry-run che portano un conteggio.
 *
 * È un'unione chiusa e non una stringa qualunque: una voce che punta a un campo
 * inesistente mostrerebbe il vuoto accanto all'etichetta, cioè un avviso che dice
 * «pagelle» e non dice quante. Con l'unione, `tsc` lo ferma prima.
 */
export const CAMPI_CONTEGGIO = [
  'file_da_rimuovere',
  'pagelle',
  'certificati_medici',
  'foto_solo_sue',
  'foto_di_gruppo',
  'foto_non_rimovibili',
  'articoli_pubblici',
  'allegati_chat',
] as const

export type CampoConteggioOblio = (typeof CAMPI_CONTEGGIO)[number]

/** Una cosa che l'oblio DISTRUGGE, con il suo nome per l'operatore. */
export interface VoceOblio {
  /**
   * La chiave del catalogo `adminAltro` (it + en in parità). Non il testo: questa
   * riga la legge una Direzione che può avere l'interfaccia in inglese.
   */
  chiave: string
  /**
   * Il magazzino dello Storage che si svuota, quando ce n'è uno. È la chiave con
   * cui il lock aggancia questa voce a `REGISTRO_BUCKET_OBLIO`.
   */
  bucket?: string
  /** Il canale da cui passa la distruzione: quasi sempre l'alunno. */
  canale: Canale
  /** Il campo del dry-run col conteggio vero, quando è misurabile. */
  campo?: CampoConteggioOblio
  /**
   * Il conteggio è un MINIMO, non il totale: si mostra «almeno N».
   *
   * Serve dove il dry-run può contare solo una parte di ciò che l'esecuzione
   * troverà. `file_da_rimuovere` è l'unico caso: conta i documenti d'identità
   * (`alunni.documento_path` + quello degli adulti orfani), mentre i percorsi
   * che solo la domanda d'iscrizione conosce si scoprono eseguendo. Un numero
   * parziale presentato come totale è un numero falso; presentato come minimo è
   * un numero vero — e la differenza va scritta DOVE si legge, non nel commento
   * di una route.
   */
  stima?: true
}

/**
 * L'ELENCO, nell'ordine in cui va letto.
 *
 * PAGELLE E CERTIFICATI MEDICI PER PRIMI, e non è una scelta grafica: sono le due
 * voci per cui questo modulo esiste. Un documento di valutazione e un certificato
 * medico sono l'unica parte dell'archivio che una famiglia può volere indietro
 * dopo. Chi conferma deve leggerli per primi, non trovarli in fondo a un elenco.
 *
 * ⚠️ Fino al 2026-08-13 queste righe dicevano anche che sono «gli unici DUE su cui
 * `REGISTRO_BUCKET_OBLIO` porta ancora una riserva scritta (DA CONFERMARE DAL
 * TITOLARE sul massimario di scarto)». È falso, e si misura in un comando:
 * `grep -c 'DA CONFERMARE DAL TITOLARE' src/lib/gdpr/esegui.ts` → **1**, dentro la
 * sola voce `pagelle`. La voce `certificati-medici` non porta nessuna riserva. Un
 * commento che descrive un presidio documentale inesistente è la trappola che
 * questo repo ha già pagato altrove: chi legge si fida e non verifica.
 */
export const OBLIO_DISTRUGGE: VoceOblio[] = [
  // Le pagelle: giudizi per disciplina, comportamento, giudizio globale. Il PDF
  // esce dal bucket e la riga che lo indicizza sparisce.
  { chiave: 'oblioDistruggePagelle', bucket: 'pagelle', canale: 'alunno', campo: 'pagelle' },
  // Dato sanitario dell'art. 9, di un minore. Via il file e via la riga, che porta
  // anche `note` e `nota_validazione` scritte a mano.
  {
    chiave: 'oblioDistruggeCertificati',
    bucket: 'certificati-medici',
    canale: 'alunno',
    campo: 'certificati_medici',
  },
  // Galleria: il conteggio annunciato è quello delle foto in cui il bambino è
  // l'unico taggato, perché sono le uniche che se ne vanno davvero. Le foto di
  // GRUPPO restano — dentro c'è l'immagine di altri bambini — e perdono soltanto
  // il tag: hanno una riga loro nel pannello, e non si sommano a questa.
  { chiave: 'oblioDistruggeGalleria', bucket: 'gallery', canale: 'alunno', campo: 'foto_solo_sue' },
  // Il blog PUBBLICO: l'unico bucket servito senza login. Qui esce il FILE, non
  // solo il tag, e l'articolo viene ritirato dalla vista.
  //
  // ⚠️ L'UNITÀ DI MISURA È L'ARTICOLO, e l'etichetta lo dice. Fino al 2026-08-13
  // diceva «Foto sul sito pubblico: N» mentre `articoli_pubblici` conta righe di
  // `news_posts`: un post porta `copertina_url` PIÙ i media dentro
  // `contenuto_json`, quindi «1» poteva voler dire sette immagini. Era la stessa
  // confusione fra numero e cosa per cui questo modulo esiste — «file da
  // rimuovere: 3» — reintrodotta con un'etichetta nuova. Il numero delle IMMAGINI
  // non è annunciabile in un dry-run: `liberaFilePubbliciDelPost` toglie solo i
  // file che nessun altro post nomina ancora, e quali siano si sa eseguendo.
  { chiave: 'oblioDistruggeNews', bucket: 'news', canale: 'alunno', campo: 'articoli_pubblici' },
  // Gli allegati scambiati in chat con la scuola: per dichiarazione della sua
  // migrazione, lì «passano certificati medici, foto di bambini».
  { chiave: 'oblioDistruggeChat', bucket: 'chat-allegati', canale: 'alunno', campo: 'allegati_chat' },
  // Documento d'identità e domanda d'iscrizione: il conteggio è quello che il
  // dry-run già mostrava come «file da rimuovere», qui finalmente con un nome.
  //
  // `stima: true` perché il numero copre UNA delle due cose che l'etichetta
  // nomina: i documenti d'identità (`alunni.documento_path` + quello degli adulti
  // orfani). Gli allegati che solo la domanda d'iscrizione conosce si trovano per
  // codice fiscale in fase di esecuzione — lo dice la route stessa, che li
  // chiamava «una STIMA» in un commento che nessun operatore legge. Da qui in
  // avanti lo legge: a schermo compare «almeno N».
  {
    chiave: 'oblioDistruggeIscrizione',
    bucket: 'form_attachments',
    canale: 'alunno',
    campo: 'file_da_rimuovere',
    stima: true,
  },
  // Il PDF delle credenziali del genitore, che contiene una PASSWORD IN CHIARO.
  // Passa dal canale GENITORE — se ne va solo per gli adulti che restano senza
  // altri figli iscritti — ma questa operazione lo distrugge, quindi si dice.
  // Non ha conteggio: il file non ha nessuna tabella-indice, si trova solo
  // elencando il bucket, e un dry-run che lo elenca farebbe una lettura dello
  // Storage per un numero che non cambia la decisione.
  { chiave: 'oblioDistruggeCredenziali', bucket: 'credenziali', canale: 'genitore' },
  // Senza bucket, e non per questo meno visibili alla famiglia: la campanella
  // porta il nome del bambino nel corpo del messaggio.
  { chiave: 'oblioDistruggeNotifiche', canale: 'alunno' },
  // Il motivo dell'assenza scritto dalla famiglia e le note d'appello del docente
  // (`presenze.giustificazione_testo` / `note_appello`): testo libero di natura
  // sanitaria. Le RIGHE di presenza restano — sono un fatto del registro — il
  // testo no.
  { chiave: 'oblioDistruggeMotivoAssenza', canale: 'alunno' },
]

/**
 * Che cosa RESTA, e va detto nello stesso riquadro.
 *
 * Un elenco di distruzioni senza il suo contrappeso è metà informazione: chi legge
 * conclude che se ne va tutto, e la domanda vera della Direzione — «potrò ancora
 * dimostrare che quella retta era stata pagata?» — resta senza risposta proprio
 * nel punto in cui se la sta ponendo.
 */
export const OBLIO_RESTA = [
  // Art. 17 §3 lett. b GDPR + art. 2220 c.c.: dieci anni, non è una scelta nostra.
  'oblioRestaPagamenti',
  // Le righe del registro: data, stato, giustificata. È il fatto della frequenza.
  'oblioRestaPresenze',
  // DPR 445/2000: il registro deve poter dire, anche fra anni, che quel documento
  // è entrato o uscito quel giorno.
  'oblioRestaProtocollo',
  // `audit_scritture_docente`: resta la riga (chi, cosa, quando), non il contenuto.
  'oblioRestaAudit',
]

