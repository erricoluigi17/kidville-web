import type { FormField, FormFieldOption } from '@/types/database.types'
// Il tetto della PIATTAFORMA, non il nostro. Questo modulo non importa niente di
// `next/server` e lo carica anche un componente `'use client'`.
import { LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { GRADI_OPTIONS, TITOLI_STUDIO } from '@/lib/forms/insegnanti-template'

/**
 * Template prestampato dell'ANAGRAFICA DEL PERSONALE IN SERVIZIO — il modulo
 * pubblico di `/anagrafica-personale`, che alimenta `POST /api/iscrizione/personale`.
 *
 * Come in `enrollment-template.ts` e in `insegnanti-template.ts`, `id` = nome della
 * colonna di destinazione, così ciò che il modulo raccoglie è già pronto per
 * l'INSERT; `db_mapping` porta `tabella.colonna` per riferimento.
 *
 * ── A CHI SERVE, E PERCHÉ NON È IL MODULO DELLE CANDIDATURE ──────────────────
 *
 * `/lavora-con-noi` raccoglie CANDIDATURE: persone che si propongono, e di cui la
 * Scuola non sa ancora niente. Questo modulo raccoglie l'anagrafica di chi il
 * rapporto di lavoro ce l'ha GIÀ: la Segreteria manda il link alle maestre in
 * servizio, loro compilano, e la Segreteria approva.
 *
 * Misurato l'11/08/2026, ed è la ragione per cui il modulo esiste: in produzione ci
 * sono 10 insegnanti con un account — 8 a Giugliano, UNA ad Aversa, UNA a Cesa. Le
 * altre non sono nel sistema affatto, e per farcele entrare l'unica strada esistente
 * era approvare una candidatura, cioè far fingere a una dipendente di candidarsi.
 *
 * ── PERCHÉ QUI IL CODICE FISCALE SI CHIEDE, E LÀ NO ──────────────────────────
 *
 * `insegnanti-template.ts` (righe 21-34) argomenta che nella candidatura il codice
 * fiscale non si chiede, e quel ragionamento poggia su DUE gambe. Vanno separate,
 * perché solo una cade.
 *
 *  · **Minimizzazione** (art. 5 §1 lett. c). Là la finalità è «valutare una
 *    proposta di collaborazione», e per farlo il codice fiscale non serve: la
 *    Scuola non ne fa nulla fino al contratto. Qui la finalità è un'altra e il
 *    contratto c'è già — **art. 6.1.b** (esecuzione del contratto di lavoro) e
 *    **art. 6.1.c** (obbligo legale del datore: comunicazione obbligatoria UNILAV,
 *    libro unico del lavoro, denunce INPS/UNIEMENS e INAIL, sostituto d'imposta).
 *    Il codice fiscale è il dato senza il quale NESSUNO di quegli adempimenti è
 *    eseguibile. Questa gamba cade, e cade legittimamente.
 *
 *  · **La circostanza**: «questo modulo è PUBBLICO e senza login. Un codice fiscale
 *    chiesto qui è un identificativo nazionale in una tabella che chiunque può
 *    alimentare, e da lì non si torna indietro». Questa gamba **NON cade da sé**, e
 *    va detto invece che taciuto: il titolare ha scelto l'11/08/2026 il link aperto,
 *    senza verifica dell'email, valutando l'alternativa (codice OTP prima dei campi
 *    sensibili) e scartandola.
 *
 * Quindi la difesa non è la porta: è ciò che sta dietro. Ogni voce qui sotto è un
 * requisito, non un auspicio, e chi tocca questo modulo non ne tolga nessuna:
 *   1. tetto di invii l'ora per INDIRIZZO IP, ed esca (`sito_web`) — come la
 *      candidatura. ⚠️ Il NUMERO non si scrive qui, e la ragione è quella per cui
 *      fino all'11/08/2026 questa riga diceva «3»: quel tre veniva dalla candidatura
 *      spontanea, che arriva da casa, una per rete. Qui il modo previsto di usare il
 *      modulo è l'opposto — «la Segreteria manda il link alle maestre in servizio»,
 *      cioè più dipendenti che compilano lo stesso pomeriggio dietro il NAT della
 *      sede — e con tre l'ora dalla quarta in poi prendevano un 429. Il numero vivo,
 *      con la misura che lo giustifica, sta in `iscrizione/personale:POST`: un tetto
 *      ribattuto in due posti diverge alla prima modifica, e questo l'aveva già fatto;
 *   2. la pratica NON è un account e NON è l'anagrafica: vive in
 *      `pratiche_personale`, RLS senza policy, e non produce niente finché una
 *      persona non la riconosce;
 *   3. le pratiche non approvate si cancellano a 90 giorni, scansioni comprese;
 *   4. le scansioni — dal 12/08/2026 sono DUE, fronte e retro — vanno nel bucket
 *      privato `documenti_personale`, separato da `form_attachments` (che custodisce
 *      i documenti dei minori), e il NOME dei file non si conserva;
 *   5. i campi vietati qui sotto non si aggiungono mai (`CAMPI_VIETATI`);
 *   6. ogni invio avvisa la Segreteria della sede, così una pratica falsa si vede
 *      il giorno stesso;
 *   7. l'approvazione non scrive MAI `utenti.ruolo` né `utenti.scuola_id`: un
 *      modulo anonimo non può promuovere nessuno né spostarlo di plesso.
 *
 * ── ⚠️ DEBITO DICHIARATO: LE ETICHETTE QUI SOTTO SONO SOLO IN ITALIANO ───────
 *
 * Come in `enrollment-template.ts` e `insegnanti-template.ts`: il guscio della
 * pagina è bilingue, i campi no, quindi con l'interfaccia in inglese la schermata
 * esce tradotta a metà. Non è un difetto introdotto qui — è la forma dei due
 * template esistenti — ma è scritto perché nessuno lo scambi per fatto. Si chiude
 * portando le etichette a chiavi di messaggio, e il giorno in cui si fa si fa per
 * TUTTI E TRE, altrimenti il difetto si sposta e basta.
 */

const PROV_PATTERN = '^[A-Z]{2}$'
const CAP_PATTERN = '^[0-9]{5}$'
/**
 * La forma del codice fiscale, **omocodia compresa**.
 *
 * ⚠️ NON è `enrollment-template.ts`, che usa `^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$`
 * e quindi RIFIUTA i codici omocodici — quelli in cui l'Agenzia sostituisce alcune
 * cifre con lettere per distinguere due persone che collidono. Sono codici veri, di
 * persone vere, e un modulo che li respinge dice a qualcuno che il proprio codice
 * fiscale non esiste. Qui la classe delle posizioni numeriche è `[0-9LMNPQRSTUV]` e
 * la lettera del mese è vincolata alle dodici valide, esattamente come `FORMA_CF` di
 * `@/lib/fiscale/tabelle` — che è la fonte, e da cui questa stringa è ribattuta solo
 * perché `validateField` vuole un `pattern` testuale.
 *
 * Ed è la stessa forma del CHECK in tabella (migrazione `20260811205643`): tre
 * dichiarazioni che devono coincidere, e `__tests__/lib/personale-template.test.ts` le
 * confronta — la stringa contro il CHECK (due volte: `pratiche_personale` e
 * `anagrafica_personale`), il VERDETTO contro `FORMA_CF`, perché le due `source`
 * DEVONO differire sulle minuscole e confrontarle sarebbe il lock sbagliato.
 *
 * ⚠️ QUELLA CITAZIONE È DIVENTATA VERA IL 12/08/2026, e fino a quel giorno non lo era:
 * il file non esisteva (`find __tests__ -name "*personale-template*"` → nessun
 * risultato). Vale la pena saperlo perché è la seconda volta che questo template
 * nomina al presente un collaudo mai scritto — l'altra sta sopra `CAMPI_VIETATI` — e
 * in questo repo un documento che descrive una protezione che non c'è è peggio di
 * nessun documento.
 */
const CF_PATTERN =
  '^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$'

/** Tipo di documento d'identità: elenco chiuso, gli stessi tre di `ADULT_FIELDS`. */
export const TIPI_DOCUMENTO: FormFieldOption[] = [
  { label: 'Carta d’identità', value: 'CI' },
  { label: 'Passaporto', value: 'PP' },
  { label: 'Patente', value: 'DL' },
]

/**
 * I limiti e i termini del modulo, in un posto solo — e sono anche i termini
 * PROMESSI nel testo dei consensi e quelli che il cron di conservazione applica.
 *
 * Chi scriverà `retention-personale` li legga da qui: una conservazione che applica
 * un termine diverso da quello dichiarato non è un refuso, è la dichiarazione su cui
 * l'interessata ha preso visione (art. 13 §2 lett. a). È la stessa disciplina di
 * `CANDIDATURA_LIMITI`, e la ragione per cui il testo dei consensi qui sotto
 * INTERPOLA questi numeri invece di ribatterli.
 */
export const PERSONALE_LIMITI = {
  /** Tetto di OGNI scansione, in MB: il tetto della PIATTAFORMA, non una scelta. */
  maxDocMb: LIMITE_UPLOAD_MB,
  /** Giorni di conservazione di una pratica NON approvata (scansioni comprese). */
  giorniPraticaNonApprovata: 90,
  /** Mesi di conservazione delle SCANSIONI dopo la cessazione del rapporto. */
  mesiDocumentoDopoCessazione: 12,
  /** Anni di conservazione del fascicolo anagrafico dopo la cessazione. */
  anniFascicoloDopoCessazione: 10,
  /**
   * Le soglie dell'allarme di scadenza, in giorni. `0` = documento già scaduto.
   * Scendono: si avvisa una volta per soglia, mai due volte la stessa.
   */
  soglieAvviso: [90, 60, 30, 7, 0],
  /** Giorni fra un risollecito e il successivo, a scadenza già superata. */
  giorniRisollecitoScaduto: 7,
} as const

// ── Campi dell'ANAGRAFICA (→ pratiche_personale) ──────────────────────────────
/**
 * L'ordine di questo elenco è l'ordine in cui i campi compaiono nel modulo, e i
 * quattro gruppi corrispondono ai quattro passi del wizard (dati · residenza ·
 * documento · professione). Chi aggiunge un campo lo metta nel gruppo giusto: il
 * riepilogo si costruisce da qui, non a mano.
 */
export const PERSONALE_FIELDS: FormField[] = [
  // ── Dati anagrafici ─────────────────────────────────────────────────────────
  { id: 'nome', type: 'text', label: 'Nome', required: true, autocomplete: 'given-name', db_mapping: 'pratiche_personale.nome', placeholder: 'Es. Maria', validation: { min_length: 2, max_length: 50 } },
  { id: 'cognome', type: 'text', label: 'Cognome', required: true, autocomplete: 'family-name', db_mapping: 'pratiche_personale.cognome', placeholder: 'Es. Rossi', validation: { min_length: 2, max_length: 50 } },

  // ⚠️ OBBLIGATORIO, e non è una formalità: senza il sesso `verificaCoerenza` non
  // può confrontare la cifra del giorno, e il codice fiscale che si verifica da solo
  // — cioè la ragione per cui questo modulo chiede il luogo di nascita da una
  // tendina invece che a mano — si degrada a un controllo di sola forma. È l'unico
  // campo che `ADULT_FIELDS` non ha e che qui c'è.
  { id: 'gender', type: 'select', label: 'Sesso', required: true, db_mapping: 'pratiche_personale.gender', options: [{ label: 'Femmina', value: 'F' }, { label: 'Maschio', value: 'M' }] },
  { id: 'birth_date', type: 'date', label: 'Data di nascita', required: true, autocomplete: 'bday', db_mapping: 'pratiche_personale.birth_date' },

  // ⚠️ Il Belfiore è OBBLIGATORIO e il comune scritto a mano non lo sostituisce: da
  // un testo libero il codice fiscale non si verifica (omonimie fra province, comuni
  // soppressi, refusi). È il ragionamento della migrazione `20260810094625`, e qui è
  // la differenza fra un badge che dice qualcosa e un badge che dice «non
  // verificabile» su ogni riga. Lo produce `LuogoNascitaFields`, mai la tastiera.
  { id: 'codice_belfiore_nascita', type: 'text', label: 'Comune di nascita', required: true, db_mapping: 'pratiche_personale.codice_belfiore_nascita', validation: { pattern: '^[A-Z][0-9]{3}$', min_length: 4, max_length: 4 } },
  // Derivati dalla tendina: si archiviano perché il pannello dev'essere leggibile
  // senza risolvere un codice catastale, non perché servano al calcolo.
  { id: 'birth_place', type: 'text', label: 'Comune di nascita (per esteso)', required: false, db_mapping: 'pratiche_personale.birth_place', validation: { max_length: 100 } },
  // ⚠️ L'id FINISCE per `_province` di proposito: `isProvinceField` guarda quel
  // suffisso, e da lì arrivano gratis l'auto-maiuscolo, lo snap su blur
  // («Napoli» → «NA») e il controllo che la sigla ESISTA davvero.
  { id: 'birth_province', type: 'text', label: 'Provincia di nascita', required: false, db_mapping: 'pratiche_personale.birth_province', placeholder: 'Es. NA', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
  { id: 'birth_nation', type: 'text', label: 'Nazione di nascita', required: true, db_mapping: 'pratiche_personale.birth_nation', placeholder: 'Es. Italia', validation: { max_length: 100 } },

  { id: 'fiscal_code', type: 'text', label: 'Codice fiscale', required: true, db_mapping: 'pratiche_personale.fiscal_code', placeholder: 'Es. RSSMRA80A41H501U', validation: { pattern: CF_PATTERN, min_length: 16, max_length: 16 } },
  // La cittadinanza la richiede la comunicazione obbligatoria UNILAV. È il campo più
  // vicino all'art. 9 di tutto il modulo: si chiede COSÌ E BASTA, senza nessun campo
  // derivato (Paese d'origine dei genitori, etnia, religione, titolo di soggiorno).
  { id: 'citizenship', type: 'text', label: 'Cittadinanza', required: true, db_mapping: 'pratiche_personale.citizenship', placeholder: 'Es. Italiana', validation: { max_length: 100 } },

  // ── Residenza e recapiti ────────────────────────────────────────────────────
  { id: 'address', type: 'text', label: 'Indirizzo di residenza', required: true, autocomplete: 'address-line1', db_mapping: 'pratiche_personale.address', placeholder: 'Es. Via Roma', validation: { max_length: 200 } },
  { id: 'residence_street_number', type: 'text', label: 'Numero civico', required: true, db_mapping: 'pratiche_personale.residence_street_number', placeholder: 'Es. 12', validation: { max_length: 20 } },
  { id: 'residence_city', type: 'text', label: 'Comune di residenza', required: true, autocomplete: 'address-level2', db_mapping: 'pratiche_personale.residence_city', placeholder: 'Es. Giugliano in Campania', validation: { max_length: 100 } },
  { id: 'residence_province', type: 'text', label: 'Provincia di residenza', required: true, autocomplete: 'address-level1', db_mapping: 'pratiche_personale.residence_province', placeholder: 'Es. NA', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
  { id: 'zip_code', type: 'text', label: 'CAP', required: true, autocomplete: 'postal-code', db_mapping: 'pratiche_personale.zip_code', placeholder: 'Es. 80014', validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 } },

  // Domicilio: SOLO se diverso dalla residenza, e facoltativo per intero. Chi abita
  // dove è residente non deve compilare cinque campi per dirlo.
  { id: 'domicilio_address', type: 'text', label: 'Indirizzo di domicilio (se diverso)', required: false, db_mapping: 'pratiche_personale.domicilio_address', validation: { max_length: 200 } },
  { id: 'domicilio_street_number', type: 'text', label: 'Numero civico (domicilio)', required: false, db_mapping: 'pratiche_personale.domicilio_street_number', validation: { max_length: 20 } },
  { id: 'domicilio_city', type: 'text', label: 'Comune di domicilio', required: false, db_mapping: 'pratiche_personale.domicilio_city', validation: { max_length: 100 } },
  { id: 'domicilio_province', type: 'text', label: 'Provincia di domicilio', required: false, db_mapping: 'pratiche_personale.domicilio_province', placeholder: 'Es. NA', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
  { id: 'domicilio_zip_code', type: 'text', label: 'CAP (domicilio)', required: false, db_mapping: 'pratiche_personale.domicilio_zip_code', placeholder: 'Es. 80014', validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 } },

  // ⚠️ L'email è OBBLIGATORIA, mentre in `ADULT_FIELDS` è facoltativa: è la chiave
  // con cui l'approvazione decide se AGGIORNARE l'anagrafica di chi ha già un
  // account o aprirne uno nuovo. Senza, approvare sarebbe indovinare.
  { id: 'email', type: 'email', label: 'Email', required: true, autocomplete: 'email', db_mapping: 'pratiche_personale.email', placeholder: 'Es. maria.rossi@email.it', validation: { max_length: 200 } },
  // Obbligatorio qui e facoltativo nella candidatura: in una scuola dell'infanzia il
  // numero di chi è in servizio è il canale delle urgenze, e oggi non esiste da
  // nessuna parte.
  { id: 'telefono', type: 'phone', label: 'Numero di cellulare', required: true, autocomplete: 'tel', db_mapping: 'pratiche_personale.telefono', placeholder: 'Es. +39 333 1234567', validation: { max_length: 30 } },

  // ── Documento d'identità ────────────────────────────────────────────────────
  { id: 'document_type', type: 'select', label: 'Tipo di documento', required: true, db_mapping: 'pratiche_personale.document_type', options: TIPI_DOCUMENTO },
  { id: 'document_number', type: 'text', label: 'Numero del documento', required: true, db_mapping: 'pratiche_personale.document_number', placeholder: 'Es. AB1234567', validation: { max_length: 50 } },
  // ⚠️ OBBLIGATORIA: è LA colonna che il cron dell'allarme legge. Facoltativa
  // significherebbe una riga invisibile all'allarme — cioè la funzionalità richiesta
  // che non parte, in silenzio, proprio sulle persone che non l'hanno compilata.
  //
  // Una data GIÀ PASSATA è ammessa e non blocca l'invio: chi ha il documento scaduto
  // è esattamente la persona per cui questo modulo esiste, e respingerla lascerebbe
  // la Segreteria senza nemmeno il nome. Il modulo lo segnala in rosso e va avanti.
  { id: 'document_expiry', type: 'date', label: 'Scadenza del documento', required: true, db_mapping: 'pratiche_personale.document_expiry' },
  // ── LE DUE FACCE DEL DOCUMENTO ──────────────────────────────────────────────
  //
  // Fino al 12/08/2026 qui c'era UN campo solo (`documento_path`). Le due colonne
  // sono `documento_fronte_path` e `documento_retro_path` dalla migrazione
  // `20260812194501`: l'`id` di un campo di questo template **è** il nome della
  // colonna, quindi rinominare è l'unico modo di non avere un'etichetta che mente.
  //
  // ⚠️ IL RETRO È OBBLIGATORIO PER TUTTI E TRE I TIPI (CI · PP · DL), e NON è una
  // svista da raffinare con un «obbligatorio solo se CI o DL».
  //
  //  · **La ragione tecnica, che è la prima.** Una regola condizionale vivrebbe in
  //    TRE posti: il client che valida il passo, il server che ri-valida il corpo, e
  //    questo template che dichiara `required`. Tre copie della stessa regola
  //    divergono alla prima modifica — è già successo in questo repo sul tetto degli
  //    invii orari, ribattuto in due file — e a divergere sarebbe la differenza fra
  //    un modulo che si può compilare e uno che il server rifiuta per sempre.
  //  · **La ragione di merito, che la rende anche giusta.** Sul passaporto il retro
  //    è la PAGINA DEI DATI; sulla carta d'identità cartacea è dove stanno residenza
  //    e firma; sulla patente sono le categorie. Non esiste il tipo di documento a
  //    cui la seconda faccia non serva.
  //  · **Il conto di chi compila.** Due foto invece di una costano trenta secondi a
  //    chi ha il documento in mano; una faccia mancante costa alla Segreteria una
  //    telefonata a una persona che credeva di aver finito.
  //
  // L'`accept` è ESATTAMENTE `ESTENSIONI_ALLEGATO_PUBBLICO` (@/lib/upload/allegati-pubblici)
  // e vale IDENTICO per le due facce: due liste diverse per lo stesso documento
  // sarebbero un fronte accettato e un retro respinto dallo stesso telefono. Non è
  // importato perché quel modulo tira dentro `next/server`, e questo template lo
  // carica anche il browser. `.heic` è in elenco perché è ciò che produce un iPhone
  // fotografando una carta d'identità, cioè il modo in cui arriveranno quasi sempre.
  { id: 'documento_fronte_path', type: 'file', label: 'Fronte del documento (foto o scansione)', required: true, db_mapping: 'pratiche_personale.documento_fronte_path', accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic', max_size_mb: PERSONALE_LIMITI.maxDocMb },
  { id: 'documento_retro_path', type: 'file', label: 'Retro del documento', required: true, db_mapping: 'pratiche_personale.documento_retro_path', accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic', max_size_mb: PERSONALE_LIMITI.maxDocMb },

  // ── Profilo professionale ───────────────────────────────────────────────────
  { id: 'titolo_studio', type: 'select', label: 'Titolo di studio', required: true, db_mapping: 'pratiche_personale.titolo_studio', options: TITOLI_STUDIO },
  { id: 'titolo_dettaglio', type: 'text', label: 'Dettaglio del titolo (indirizzo, istituto)', required: false, db_mapping: 'pratiche_personale.titolo_dettaglio', placeholder: 'Es. Scienze dell’educazione', validation: { max_length: 200 } },
  // Le fasce guidano quali funzioni la persona vede nell'app: senza, l'anagrafica
  // non basta a configurare l'account. `type: 'checkbox'` è già multi-valore, e
  // `required: true` significa già «almeno una fascia» sul client e sul server con
  // la stessa funzione. In tabella il CHECK è `cardinality(gradi) >= 1`, che a
  // differenza di `array_length` morde davvero anche sull'array vuoto.
  { id: 'gradi', type: 'checkbox', label: 'Fasce d’età su cui lavori', required: true, db_mapping: 'pratiche_personale.gradi', options: GRADI_OPTIONS },

  // ── Contatto d'emergenza ────────────────────────────────────────────────────
  // FACOLTATIVI per intero, e la ragione va detta a chi compila: sono i dati di un
  // TERZO, che non sta compilando nulla e non ha ricevuto nessuna informativa
  // (art. 14 GDPR). Renderli obbligatori significherebbe costringere qualcuno a
  // consegnare il recapito di un altro per poter finire il modulo.
  { id: 'emergenza_nome', type: 'text', label: 'Persona da avvisare in caso di urgenza', required: false, db_mapping: 'pratiche_personale.emergenza_nome', placeholder: 'Es. Giulia Rossi', validation: { max_length: 100 } },
  { id: 'emergenza_telefono', type: 'phone', label: 'Suo numero di telefono', required: false, db_mapping: 'pratiche_personale.emergenza_telefono', placeholder: 'Es. +39 333 1234567', validation: { max_length: 30 } },
  { id: 'emergenza_relazione', type: 'text', label: 'Che rapporto ha con te', required: false, db_mapping: 'pratiche_personale.emergenza_relazione', placeholder: 'Es. sorella', validation: { max_length: 60 } },
]

/**
 * I campi che NON si chiedono, e che non si aggiungono nemmeno «perché sarebbe
 * comodo averli». `__tests__/lib/personale-template.test.ts` confronta questa lista con
 * gli `id`, i `db_mapping` e gli id dei consensi di `PERSONALE_FIELDS`: chi ne aggiunge
 * uno lo scopre il giorno in cui lo aggiunge, non sei mesi dopo.
 *
 * ⚠️ IL CONFRONTO È PER RADICE (`includes`), NON PER NOME ESATTO, ed è il motivo per cui
 * le voci qui sotto sono tronche (`allerg`, `contratto`): nessuno aggiunge una colonna
 * che si chiama `iban` e basta — si aggiunge `iban_accredito`, ed è così che un campo
 * vietato entra davvero. Provato con una mutazione il 12/08/2026: inserito
 * `iban_accredito` nel template, due prove diventano rosse e lo nominano.
 *
 * ⚠️ E FINO AL 12/08/2026 QUESTO PARAGRAFO DICEVA IL FALSO: il collaudo che cita non
 * esisteva (`grep -rn CAMPI_VIETATI __tests__/` → nessun risultato), cioè il presidio su
 * IBAN, firma autografa e dati sanitari del modulo del PERSONALE era dichiarato e mai
 * scritto. È stato scritto quel giorno, insieme ai due campi delle facce del documento.
 *
 * Le ragioni, che sono diverse fra loro e vanno lette una per una:
 *
 *  · **IBAN** — questa applicazione non fa le buste paga: non c'è nessun lettore per
 *    quel dato, e un dato raccolto e mai letto è la promessa non mantenuta
 *    dell'art. 5 §2 (è la storia dei 141 consensi foto di `enrollment-template.ts`).
 *    E un «cambio IBAN» inviato da una porta anonima è la forma canonica della frode
 *    sulle retribuzioni: la Segreteria non ha modo di distinguerla da un cambio
 *    vero. Il suo posto è una route AUTENTICATA, dopo che l'account esiste.
 *  · **firma autografa scansionata** — è materiale per falsificare documenti,
 *    raccolto da una porta condivisibile. Per quando serve una firma, il repo ha già
 *    l'OTP/FEA.
 *  · **idoneità sanitaria, L. 104, L. 68/99, gravidanza, allergie** — art. 9. Fuori
 *    da un modulo pubblico, sempre.
 *  · **casellario giudiziale / certificato antipedofilia (d.lgs. 39/2014)** —
 *    art. 10, dato giudiziario; e comunque lo richiede il DATORE alla Procura, non
 *    l'interessata.
 *  · **permesso di soggiorno** — rivela la condizione di straniero e spesso il
 *    MOTIVO del soggiorno (asilo, protezione ⇒ art. 9/10). Si esibisce in segreteria.
 *  · **stato civile, carichi di famiglia, codice fiscale dei figli** — è il modulo
 *    delle detrazioni, che è un altro modulo, e tocca dati di minori.
 *  · **fotografia del volto** — non necessaria a nulla di ciò che questo modulo
 *    dichiara.
 *  · **data di assunzione, mansione, contratto** — la Scuola li ha già, li ha
 *    firmati lei. Chiederli è far ricopiare a una persona un documento che è in
 *    segreteria: non è minimizzazione, è un modulo più lungo con più errori dentro.
 */
export const CAMPI_VIETATI = [
  'iban',
  'firma',
  'permesso_soggiorno',
  'titolo_soggiorno',
  'casellario',
  'antipedofilia',
  'l104',
  'idoneita',
  'certificato_medico',
  'gravidanza',
  'allerg',
  'foto_volto',
  'stato_civile',
  'carichi_famiglia',
  'data_assunzione',
  'mansione',
  'contratto',
] as const

// ── Consensi (→ pratiche_personale.consents_log) ──────────────────────────────
/**
 * TRE prese visione obbligatorie e NESSUN consenso al trattamento. Il ragionamento
 * va rifatto qui e non copiato dagli altri due template, perché la situazione è una
 * terza.
 *
 * ── PERCHÉ NON SI CHIEDE IL CONSENSO ────────────────────────────────────────
 *
 * Nell'iscrizione i dati sono di un MINORE e comprendono allergie: la base è
 * l'interesse pubblico rilevante (art. 9.2.g). Nella candidatura sono di un adulto
 * che si propone: la base è la misura precontrattuale (art. 6.1.b).
 *
 * Qui i dati sono di una DIPENDENTE, e la base è l'esecuzione del contratto di
 * lavoro (art. 6.1.b) insieme agli obblighi di legge del datore (art. 6.1.c). Il
 * consenso non solo non serve: sarebbe **dannoso**. Fra datore e dipendente il
 * potere è squilibrato per presunzione, e un consenso che non si può rifiutare senza
 * mettere a rischio il rapporto non è libero (art. 7 §4 e cons. 43) — cioè non vale
 * nulla, e chi ci si appoggiasse tratterebbe quei dati credendo di avere una base e
 * non avendola. Il Garante lo ripete da anni sul rapporto di lavoro subordinato.
 *
 * Quello che serve davvero, e che qui è obbligatorio, è l'INFORMATIVA al punto di
 * raccolta (art. 13) e la prova che sia stata data.
 *
 * ── PERCHÉ TRE BLOCCHI E NON UNO ────────────────────────────────────────────
 *
 * Perché rispondono a tre domande diverse, e il giorno in cui una venisse contestata
 * la prova di che cosa era stato scritto dev'essere isolabile in `consents_log`,
 * non annegata in un blocco che parlava d'altro. In particolare il terzo: la copia
 * del documento è il pezzo con la base più fragile dell'intero modulo — nessuna
 * norma impone al datore di conservare una FOTOCOPIA, impone di identificare — ed è
 * per questo che ha il termine di conservazione più corto e un blocco tutto suo.
 */
export const CONSENSI_PERSONALE_FIELDS: FormField[] = [
  {
    id: 'presa_visione_informativa_personale',
    type: 'consent',
    label: 'Ho letto l’informativa sulla privacy',
    required: true,
    text:
      'Dichiaro di aver preso visione dell’informativa sul trattamento dei dati del personale. ' +
      'I dati di questo modulo sono trattati dalla Scuola per costituire e gestire il rapporto di ' +
      'lavoro e per adempiere agli obblighi che ne derivano — comunicazioni obbligatorie, libro ' +
      'unico del lavoro, adempimenti previdenziali, contributivi e fiscali: per queste finalità ' +
      'non è richiesto il consenso, ed è per lo stesso motivo che non mi viene chiesto. Posso in ' +
      'ogni momento chiedere di accedere ai miei dati, correggerli o farli aggiornare.',
    link: '/privacy',
  },
  {
    id: 'dichiarazione_veridicita',
    type: 'consent',
    label: 'Dichiaro che i dati sono veri e mi impegno a segnalare le variazioni',
    required: true,
    // Non è un orpello: è ciò che rende il fascicolo utilizzabile SENZA pretendere
    // un allegato per ogni campo, ed è la ragione per cui questo modulo chiede una
    // sola scansione invece di cinque.
    text:
      'Dichiaro che i dati indicati corrispondono al vero, ai sensi degli artt. 46 e 47 del ' +
      'd.P.R. 445/2000, e mi impegno a comunicare tempestivamente alla Segreteria ogni ' +
      'variazione, compreso il rinnovo del documento d’identità.',
  },
  {
    id: 'presa_visione_copia_documento',
    type: 'consent',
    label: 'Ho letto perché mi viene chiesta la copia del documento',
    required: true,
    // ⚠️ I due termini sono INTERPOLATI da `PERSONALE_LIMITI`, non ribattuti a mano:
    // sono ciò che viene promesso all'interessata e archiviato in `consents_log`, e
    // devono coincidere con quelli che il cron di conservazione applica davvero.
    //
    // ⚠️ LA FRASE SULLA SOSTITUZIONE È STATA TOLTA l'11/08/2026, ed è la correzione
    // più importante di questo blocco. Diceva: «viene sostituita, con cancellazione
    // della precedente, appena ne consegno una nuova». MISURATO lo stesso giorno: in
    // tutto `src/` nessuna riga scrive `anagrafica_personale.documento_path` — l'unica
    // scrittura su quella colonna è l'azzeramento di `retention-personale` — e nessuna
    // `remove()` sul bucket `documenti_personale` esiste fuori da quel job. Quando la
    // route di approvazione sovrascriverà il percorso con una seconda scansione, il
    // file precedente resterà nel bucket senza più nessuna riga che lo nomini, e
    // `retention-personale` non lo troverà mai: una fotografia di carta d'identità
    // conservata per sempre e irrintracciabile.
    // ⚠️ NOTA DI LETTURA (12/08/2026): la colonna misurata quel giorno si chiamava
    // `documento_path` e oggi si chiama `documento_fronte_path`, con una sorella
    // `documento_retro_path` (migrazione `20260812194501`). Chi rifà la misura cerchi
    // i due nomi nuovi. Il ragionamento non cambia — vale identico per due file invece
    // che per uno — ma il conto sì: un percorso sovrascritto senza cancellare lascia
    // adesso DUE fotografie orfane, non una.
    // Qui pesa il doppio che in `/privacy`: questo testo viene CONGELATO in
    // `pratiche_personale.consents_log` e resta la prova, fra dieci anni, di ciò che
    // alla persona è stato dichiarato. Una promessa non mantenuta è un documento
    // legale che dice il falso, non un refuso redazionale.
    // NON è stata alzata `CONSENSI_PERSONALE_VERSIONE`, e la ragione è una misura, non
    // una comodità: il 2026-08-11 `pratiche_personale` conteneva ZERO righe in
    // produzione (`select count(*)`), il modulo non è mai stato rilasciato e la
    // versione nasce oggi — nessuna presa visione è mai stata archiviata con la
    // formulazione vecchia, quindi non c'è nessuna differenza da rendere tracciabile.
    // Chi toccherà questo testo dopo il rilascio rifaccia quella query prima di
    // decidere: da quel momento la versione va alzata.
    // Il divieto di rimetterla senza il meccanismo non è affidato alla memoria: la
    // prova sta in `__tests__/api/gdpr-retention-personale.test.ts`.
    //
    // ⚠️ IL TESTO PARLA DI «LA COPIA» AL SINGOLARE, E DAL 12/08/2026 LE COPIE SONO DUE
    // (fronte e retro). NON è stato riscritto, e la ragione è la query che quel
    // paragrafo qui sopra ordina di rifare invece di fidarsi della data:
    //     select count(*) from pratiche_personale;  → 1  (misurato il 12/08/2026)
    //     …di cui con `consents_log` valorizzato    → 1
    // Cioè una presa visione è GIÀ ARCHIVIATA con questa formulazione e con la
    // versione `2026-08-11`: toccare il testo adesso obbliga ad alzare
    // `CONSENSI_PERSONALE_VERSIONE`, altrimenti due formulazioni diverse restano
    // indistinguibili in `consents_log` — che è esattamente ciò che la versione esiste
    // per impedire. Nel merito la promessa regge: ciò che è dichiarato — finalità,
    // conservazione separata, i due termini di cancellazione — vale identico per due
    // immagini dello stesso documento, e il cron le tratta insieme. Chi lo riscriverà
    // («la copia» → «le copie») lo faccia in un lavoro suo, alzando la versione.
    text:
      'Ho letto perché mi viene chiesta la copia del documento d’identità: serve a identificarmi ' +
      'per gli adempimenti obbligatori del datore di lavoro. La copia è conservata separatamente ' +
      `dal resto del fascicolo. È cancellata entro ${PERSONALE_LIMITI.mesiDocumentoDopoCessazione} mesi ` +
      'dalla cessazione del rapporto, ed entro ' +
      `${PERSONALE_LIMITI.giorniPraticaNonApprovata} giorni se questa richiesta non viene approvata.`,
  },
]

/**
 * Versione del TESTO dei consensi qui sopra. Cambia quando cambia il testo: è ciò
 * che viene archiviato in `consents_log` insieme alla risposta, così fra dieci anni
 * si sa a quale formulazione la persona ha detto sì — e se quella formulazione
 * prometteva davvero dodici mesi.
 */
export const CONSENSI_PERSONALE_VERSIONE = '2026-08-11'
