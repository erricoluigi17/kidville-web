import it from '../../../messages/it/shared.json';
import en from '../../../messages/en/shared.json';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config';

/**
 * Il messaggio d'errore di una risposta del server, per l'interfaccia.
 *
 * PERCHÉ ESISTE. Il repo ha la regola giusta sui log del SERVER («un catch che
 * non logga è un bug») ma non ne aveva l'equivalente a schermo: decine di
 * mutazioni del cockpit erano scritte `if (res.ok) { … }` senza `else`. Quando
 * il server rifiutava — un 403 di scope, il 400 «Specificare la sede» nato con
 * il multi-sede — la pagina si comportava esattamente come dopo un successo:
 * modale chiuso, elenco ricaricato, nessun segnale. È ciò che ha reso invisibili
 * gli errori di sede per mesi: l'unico modo di accorgersene sarebbe stato
 * l'errore, e l'errore non arrivava mai.
 *
 * COSA FA. Legge il corpo (`{ error: '…', codice?: '…' }`, la forma di tutte le
 * route: il wrapper `withRoute` restituisce la Response invariata) e ne ricava il
 * testo da mostrare. Se c'è un `codice` DICHIARATO qui sotto, il testo viene dal
 * catalogo nella lingua dell'interfaccia; altrimenti resta la prosa del server;
 * se manca anche quella, il `fallback` — mai la stringa vuota, che a schermo è
 * indistinguibile dal silenzio di prima.
 *
 * NON LANCIA e non logga: il log lo fa il chiamante, che è l'unico a sapere
 * quale operazione è stata rifiutata (`stato` compreso: è un numero, passa la
 * lista bianca di `redact`, ed è l'unica cosa che distingue un 400 da un 403).
 * Il corpo NON si logga: può contenere il nome di una classe o di un bambino.
 *
 * ─── PERCHÉ IL CODICE, E NON UNA TRADUZIONE DELLA FRASE ─────────────────────
 *
 * Collaudo del 2026-07-31, categoria localizzazione, fallimenti F1 e F2: con
 * `<html lang="en">` la modale «New notice» mostrava «Sede non accessibile» e
 * «Specificare la sede (scuola_id) per questa operazione». Italiano dentro
 * un'interfaccia inglese — e il secondo messaggio, scritto per chi legge i log,
 * mostrava a una segretaria il nome di una colonna del database.
 *
 * Non è una traduzione dimenticata: quel testo NASCE sul server, dentro
 * `resolveScuolaScrittura`, dove non esistono né il locale né il catalogo.
 * Tradurre le due frasi avrebbe chiuso i due sintomi e lasciato in piedi la
 * causa: la frase successiva sarebbe nata italiana come le altre 1498.
 *
 * Perciò il server manda un CODICE stabile accanto alla prosa, e la traduzione
 * avviene qui, dove la lingua c'è. Il codice non si traduce e non si mostra: è
 * un identificatore, come `PGRST204`.
 *
 * ─── PERCHÉ NON `useTranslations` ───────────────────────────────────────────
 *
 * Questa non è una funzione di React: la chiamano gestori di eventi e funzioni
 * asincrone, dove gli hook non si possono invocare. E cambiarne la firma per
 * farsi passare il traduttore vorrebbe dire toccare i 14 punti che la usano, cioè
 * far dipendere la correzione dalla disciplina di chi la adotta — che è
 * esattamente il motivo per cui gli errori italiani sono 1498.
 *
 * Quindi i due cataloghi si importano diretti e la lingua si legge da
 * `document.documentElement.lang`, che `RootLayout` scrive da `getLocale()` (la
 * stessa fonte di next-intl: il cookie `KV_LOCALE`, già validato). Stesso
 * espediente, stesso motivo, di `src/app/offline/page.tsx`, che importa entrambe
 * le lingue perché è servita da una cache dove il provider non arriva.
 */

/**
 * I codici che il server può mandare, e la chiave di catalogo di ciascuno
 * (namespace `shared`, presente in `messages/it` e `messages/en`).
 *
 * È l'UNICO elenco: il lock `__tests__/architecture/errori-con-codice.test.ts`
 * pretende che ogni `codice:` scritto in `src/` sia qui dentro e che la sua
 * chiave esista in entrambi i cataloghi. Un codice inventato in una route e mai
 * dichiarato qui non è un mezzo fix: a schermo sarebbe indistinguibile dal
 * difetto di partenza, perché ricadrebbe sulla prosa italiana.
 */
export const CODICI_ERRORE = {
    /** 403 — la sede indicata (nel corpo o nel cookie) non è fra le proprie. */
    SEDE_NON_ACCESSIBILE: 'erroreSedeNonAccessibile',
    /** 400 — più sedi accessibili e nessuna indicata: l'operatore deve scegliere. */
    SEDE_DA_SPECIFICARE: 'erroreSedeDaSpecificare',
    /** 415 — il tipo dell'allegato non è fra quelli ammessi (`src/lib/allegati/mime.ts`). */
    ALLEGATO_TIPO_NON_AMMESSO: 'erroreAllegatoTipoNonAmmesso',
    /**
     * 415 — il tipo dell'allegato non è ammesso su una porta PUBBLICA
     * (`src/lib/upload/allegati-pubblici.ts`): lì si accettano solo PDF e immagini.
     *
     * È un codice suo e non `ALLEGATO_TIPO_NON_AMMESSO` perché l'elenco è diverso: fra il
     * personale un `.docx` si allega, dal modulo pubblico d'iscrizione no. Dire a una
     * famiglia «sono ammessi anche i documenti Word» le farebbe riprovare con un file che
     * verrebbe respinto lo stesso — un messaggio che manda l'utente contro un muro è peggio
     * di nessun messaggio.
     */
    ALLEGATO_PDF_O_IMMAGINE: 'erroreAllegatoPdfOImmagine',
    /** 413 — l'allegato supera il limite del bucket (10 MB). */
    ALLEGATO_TROPPO_GRANDE: 'erroreAllegatoTroppoGrande',
    /** 400 — l'indirizzo dell'allegato non è del nostro bucket (`src/lib/chat/allegati.ts`). */
    ALLEGATO_NON_VALIDO: 'erroreAllegatoNonValido',
    /**
     * 500 — lo Storage ha rifiutato il caricamento per un motivo IMPREVISTO
     * (`src/lib/allegati/risposte.ts`). Il messaggio del fornitore resta nel log: fino al
     * 2026-08-01 usciva invece di qui, in inglese e col nome di un vincolo interno.
     */
    ALLEGATO_NON_CARICATO: 'erroreAllegatoNonCaricato',
    /** 403/500 — il file appena caricato non si può togliere dal bucket (`src/lib/allegati/risposte.ts`). */
    ALLEGATO_NON_RIMOSSO: 'erroreAllegatoNonRimosso',
    /** 429 — tetto di frequenza raggiunto (`src/lib/security/otp-rate-limit.ts`). */
    TROPPE_RICHIESTE: 'erroreTroppeRichieste',
    /**
     * 500 — il conteggio delle notifiche non lette non è stato letto
     * (`src/app/api/notifiche/route.ts`). La campanella tiene l'ultimo valore noto
     * invece di mostrare 0, che sarebbe indistinguibile da «hai letto tutto».
     *
     * Nasce col conteggio separato di T17-F2 (il badge si fermava a 100) e fino al
     * 2026-08-03 rispondeva col `message` grezzo di PostgREST: prosa inglese e nomi
     * di colonna del database dentro l'interfaccia di una segretaria.
     */
    NOTIFICHE_CONTEGGIO_NON_LETTO: 'erroreNotificheConteggioNonLetto',
    /**
     * 500 — la configurazione GIÀ SALVATA non si è potuta rileggere, e quindi non si
     * salva niente (`PATCH /api/admin/settings`).
     *
     * Le colonne JSONB di `admin_settings` si aggiornano in shallow-merge col salvato:
     * se la lettura del pregresso fallisce e si prosegue lo stesso, il merge riparte da
     * `{}` e la PATCH **cancella** ciò che l'operatore non stava toccando, rispondendo
     * 200. Meglio un guasto dichiarato che un salvataggio riuscito a metà: qui il
     * fallimento è NOSTRO e va detto come tale, senza accusare chi ha premuto Salva.
     */
    CONFIG_PREGRESSO_NON_LETTO: 'erroreConfigPregressoNonLetto',
    /**
     * 400 — un avviso «di classe» senza nessuna classe destinataria. Non degrada a
     * globale in silenzio: notifica e bacheca devono sempre dire la stessa cosa.
     */
    CLASSE_DESTINATARIA_MANCANTE: 'erroreClasseDestinatariaMancante',
    /**
     * 400 — una classe destinataria non esiste nella sede dell'avviso
     * (`src/lib/avvisi/classi-sede.ts`). Il `error` accanto elenca QUALI: il codice
     * dà la frase tradotta, la prosa il dettaglio che solo il server conosce.
     */
    CLASSI_FUORI_SEDE: 'erroreClassiFuoriSede',
    /**
     * 500 — non è stato possibile leggere le sezioni per validare i destinatari.
     * È un guasto NOSTRO, e va detto come tale: prima del 2026-08-01 un errore di
     * lettura sarebbe uscito come «nessuna classe trovata», cioè un 400 che accusa
     * l'operatore di uno sbaglio che non ha commesso.
     */
    VERIFICA_CLASSI_NON_RIUSCITA: 'erroreVerificaClassiNonRiuscita',
    /**
     * I quattro rifiuti dell'uscita didattica (`teacher/uscite:POST`) che restavano
     * senza codice: creare una gita fa fan-out di un modulo da firmare su un'intera
     * sezione, quindi ogni rifiuto deve dire QUALE porta si è chiusa. Gli altri tre
     * — `USCITA_CLASSE_FUORI_SEDE`, `USCITA_NON_CREATA`,
     * `AUTORIZZAZIONI_USCITA_NON_LETTE` — stanno più in basso in questo stesso file:
     * cercali lì prima di aggiungerne di nuovi, perché il primo tentativo di questo
     * blocco li aveva ridefiniti con un altro nome.
     */
    /** 400 — il rientro non è successivo alla partenza (confronto fra stringhe `HH:MM`). */
    USCITA_ORARI_NON_VALIDI: 'erroreUscitaOrariNonValidi',
    /** 400 — il termine per autorizzare cade dopo il giorno dell'uscita. */
    USCITA_TERMINE_NON_VALIDO: 'erroreUscitaTermineNonValido',
    /** 500 — non è stato possibile verificare le sezioni destinatarie: guasto nostro. */
    USCITA_SEZIONI_NON_VERIFICATE: 'erroreUscitaSezioniNonVerificate',
    /** 500 — non è stato possibile rileggere l'uscita per capire se esisteva già. */
    USCITA_NON_VERIFICATA: 'erroreUscitaNonVerificata',
    /**
     * 403 — almeno uno dei bambini taggati in una foto non è nei plessi di chi
     * pubblica o modifica (`src/lib/gallery/tag-scope.ts`).
     *
     * La prosa NON dice QUALI, ed è l'unico caso in cui il dettaglio si tace di
     * proposito: nominarli confermerebbe l'esistenza di quei minori a chi non ha
     * titolo di conoscerli — che è esattamente il difetto T05-F1. I conteggi
     * stanno nel log.
     *
     * Lo stesso codice copre anche lo scope di sede VUOTO: per chi guarda lo
     * schermo è lo stesso rifiuto («quei bambini non li puoi taggare»), e
     * distinguere i due casi racconterebbe a chi prova come è andata la
     * risoluzione delle sedi. La differenza vive nel log (`motivo: scope-vuoto`),
     * dove serve a chi deve capire, non a chi tenta.
     */
    TAG_FUORI_SEDE: 'erroreTagFuoriSede',
    /**
     * 403 — almeno uno dei bambini taggati è dei propri plessi ma NON È PIÙ
     * ISCRITTO (archiviato, `src/lib/gallery/tag-scope.ts`).
     *
     * Codice distinto da `TAG_FUORI_SEDE` di proposito, e non per pignoleria:
     * riusare quello avrebbe risposto «non appartengono ai tuoi plessi» su un
     * bambino che alla maestra risulta della sua sede, mandandola a cercare un
     * errore di plesso inesistente. Qui la prosa può dire il motivo perché si
     * pronuncia solo su bambini già dimostrati dentro le sedi di chi chiede:
     * non rivela nulla che chi guarda non potesse già vedere.
     */
    TAG_ALUNNO_NON_ISCRITTO: 'erroreTagAlunnoNonIscritto',
    /**
     * 500 — non è stato possibile leggere l'anagrafica per verificare i bambini
     * taggati. Gemello di `VERIFICA_CLASSI_NON_RIUSCITA`, e per la stessa
     * ragione: un guasto di lettura non deve travestirsi da «non sono tuoi»,
     * cioè da un 403 che accusa l'operatore di uno sbaglio che non ha commesso.
     */
    VERIFICA_TAG_NON_RIUSCITA: 'erroreVerificaTagNonRiuscita',
    /**
     * 422 — il post contiene una foto e nessuno ha dichiarato chi è ritratto
     * (`src/lib/news/gate-consenso.ts`). Non si pubblica «non sapendo».
     */
    CONSENSO_FOTO_DICHIARAZIONE_MANCANTE: 'erroreConsensoFotoDichiarazioneMancante',
    /**
     * 422 — almeno un bambino ritratto non ha il consenso al canale «sito web».
     * Il `error` accanto elenca QUALI (nome, all'operatore che li ha appena
     * scelti): il codice dà la frase tradotta, la prosa il dettaglio.
     */
    CONSENSO_FOTO_SITO_MANCANTE: 'erroreConsensoFotoSitoMancante',
    /**
     * 503 — il consenso non è LEGGIBILE (colonna assente su un ambiente non
     * migrato, guasto di lettura, id fuori dalle proprie sedi). Fail-closed:
     * «non lo so» non vale «sì».
     */
    CONSENSO_FOTO_NON_VERIFICABILE: 'erroreConsensoFotoNonVerificabile',
    /**
     * 503 — il consenso è verificato ma il media non si è potuto spostare
     * nell'archivio pubblico (`src/lib/news/media-bozza.ts`). Non si salva: la
     * riga mostrerebbe un'immagine rotta o un indirizzo destinato a scadere.
     */
    MEDIA_NON_PROMOSSI: 'erroreMediaNonPromossi',
    /**
     * 503 — la news NON è stata ELIMINATA perché i suoi file non sono usciti dal
     * bucket pubblico (`liberaFilePubbliciDelPost`, da `DELETE /api/news/[id]`).
     * Cancellare la riga lasciando il file significherebbe una foto di minore a un
     * indirizzo pubblico senza più nessuna riga da cui ritrovarla: si preferisce
     * non cancellare e riprovare.
     *
     * VALE SOLO PER LA CANCELLAZIONE, e il gemello qui sotto esiste per questo.
     */
    NEWS_FILE_NON_RIMOSSI: 'erroreNewsFileNonRimossi',
    /**
     * 503 — la MODIFICA non è stata salvata perché le immagini sostituite non sono
     * uscite dal bucket pubblico (`PATCH /api/news/[id]`, difetto W1).
     *
     * ─── PERCHÉ NON RIUSA IL CODICE DELLA DELETE ────────────────────────────────
     *
     * Perché il testo che l'utente legge viene dal CATALOGO, non dalla prosa del
     * server: `messaggioDaCorpo`, appena riconosce un codice, scarta l'`error` (a
     * meno che il codice non sia in `CODICI_CON_DETTAGLIO`). Fino al 2026-08-03 la
     * PATCH mandava `NEWS_FILE_NON_RIMOSSI`, cioè il codice della cancellazione: a
     * chi aveva appena cambiato la copertina di un articolo lo schermo rispondeva
     * «la news non è stata eliminata» — il resoconto di una cancellazione che
     * nessuno aveva chiesto. La prosa giusta c'era, nel corpo, e non arrivava mai.
     *
     * Il lock `errori-con-codice` non poteva vederlo: il codice era DICHIARATO e
     * tradotto in due lingue: sbagliato, non mancante. Un codice riusato è un
     * messaggio sbagliato che ha l'aria di essere a posto — la stessa forma delle
     * altre trappole di questo ciclo.
     */
    NEWS_FILE_SOSTITUITI_NON_RIMOSSI: 'erroreNewsFileSostituitiNonRimossi',
    /**
     * 403 — la modifica richiama, dentro copertina o rich-text, l'immagine di un
     * ALTRO articolo (`PATCH /api/news/[id]`). Il bucket `news` è pubblico: quegli
     * indirizzi li conosce chiunque legga il sito, e finché una riga poteva
     * cominciare a nominarli bastava toglierli con una seconda modifica per far
     * cancellare il file di qualcun altro.
     *
     * La prosa dice che cosa fare — ricaricare l'immagine — perché il rifiuto
     * arriva quasi sempre a chi ha incollato un'immagine da un altro articolo
     * senza sapere che così ne stava adottando il file.
     */
    NEWS_MEDIA_ESTRANEO: 'erroreNewsMediaEstraneo',
    /**
     * 404 — il link pubblico di un modulo non apre niente
     * (`src/lib/forms/token-pubblico.ts`): token malformato, modello inesistente o non
     * pubblicato. UN SOLO codice per i tre casi, ed è il punto: distinguerli direbbe a chi
     * prova a indovinare il token quando ha imbroccato almeno la forma giusta.
     *
     * Lo legge una famiglia, sul telefono, fuori da qualunque sessione — cioè esattamente
     * il pubblico per cui la lingua dell'interfaccia non è detto che sia l'italiano.
     */
    MODULO_NON_TROVATO: 'erroreModuloNonTrovato',
    /**
     * 415 — il video non è riproducibile ovunque (HEVC/QuickTime) e va convertito
     * prima del caricamento (`src/lib/media/codec-sniff.ts`).
     *
     * La prosa che il server manda accanto è `MESSAGGIO_VIDEO_NON_CONVERTIBILE`,
     * che vive in una libreria condivisa client+server e per costruzione nasce
     * italiana: era l'ultimo testo lungo che una maestra con l'interfaccia in
     * inglese leggeva in italiano. Il codice la traduce; il dettaglio operativo
     * (il percorso nelle impostazioni dell'iPhone) resta nella prosa e nella
     * frase che la pagina mostra quando la conversione fallisce sul dispositivo.
     */
    VIDEO_NON_CONVERTIBILE: 'erroreVideoNonConvertibile',
    /**
     * 503 — la segnalazione non è stata registrata perché non si è riusciti ad
     * attribuirla a un plesso (`POST /api/segnalazioni`).
     *
     * È il rifiuto che ha sostituito una riga muta: prima quella segnalazione
     * veniva scritta con `scuola_id: null`, nessuna Direzione riceveva la
     * notifica e la moderazione la rifiutava — cioè «inviata» a schermo e
     * invisibile a tutti. Meglio dirlo: chi segnala può riprovare o avvisare la
     * segreteria, e nel frattempo il log a livello `error` porta il caso sotto
     * gli occhi di qualcuno.
     *
     * La frase NON spiega perché: «il bambino di quella conversazione non ha un
     * plesso in anagrafica» è la diagnosi, e la diagnosi sta nel log
     * (`sede-non-attribuibile`), non davanti a un genitore.
     */
    SEGNALAZIONE_SENZA_PLESSO: 'erroreSegnalazioneSenzaPlesso',
    /**
     * 404 — la domanda d'iscrizione chiesta per id non è apribile
     * (`GET /api/admin/iscrizioni?id=`).
     *
     * Un solo codice per due situazioni diverse, ed è deliberato: la domanda non
     * esiste, oppure esiste ma è di un'altra sede. Distinguerle a schermo
     * direbbe a chi non ha diritto di vederla che quella domanda c'è — e da qui
     * esce il fascicolo di un minore. La differenza vive nel log
     * (`dettaglio-non-in-scope`), che è il posto giusto per saperla.
     */
    DOMANDA_NON_APRIBILE: 'erroreDomandaNonApribile',
    /**
     * 500 — la lettura della domanda d'iscrizione non è riuscita
     * (`GET /api/admin/iscrizioni?id=`, errore PostgREST).
     *
     * Il motivo tecnico resta nel log col codice d'errore: il `message` grezzo
     * di PostgREST è prosa inglese con dentro nomi di colonne, e non è
     * un'informazione per chi lavora in segreteria.
     */
    DOMANDA_NON_LETTA: 'erroreDomandaNonLetta',
    /**
     * 400 — l'assenza si comunica in ANTICIPO, e la data indicata è già passata
     * (`POST /api/parent/presenze/comunica-assenza`, fuso Europe/Rome).
     *
     * La frase dice anche dove andare — la giustifica — perché il rifiuto arriva
     * a chi ha appena provato a fare la cosa giusta con lo strumento sbagliato:
     * senza quel rimando l'unico messaggio possibile sarebbe «no», e il genitore
     * riproverebbe con la stessa data.
     */
    ASSENZA_DATA_PASSATA: 'erroreAssenzaDataPassata',
    /**
     * 403 — l'account della famiglia è sospeso per morosità
     * (`src/lib/pagamenti/sospensione.ts`, `negato()`): le azioni di servizio sono
     * inibite finché la posizione non è regolarizzata.
     *
     * Fino al 2026-08-08 quella risposta portava solo `motivo: 'account_sospeso'`,
     * che `soloCatalogoDaCorpo` non guarda: il genitore leggeva la frase generica
     * della schermata e non sapeva né perché era stato respinto né cosa fare. La
     * frase nomina la segreteria perché è l'unico modo che ha di risolvere: non è
     * un errore che si corregge riprovando.
     */
    ACCOUNT_SOSPESO: 'erroreAccountSospeso',
    /**
     * 400 — l'assenza si comunica in anticipo, ma non a QUALUNQUE distanza
     * (`POST /api/parent/presenze/comunica-assenza`, tetto in
     * `GIORNI_MASSIMI_IN_ANTICIPO`).
     *
     * NON riusa `ASSENZA_DATA_PASSATA`, che dice l'esatto contrario («è già
     * passata») e manderebbe il genitore verso la giustifica per un giorno che
     * deve ancora arrivare. Fino al 2026-08-07 questo rifiuto non esisteva
     * affatto: `2099-12-31` rispondeva 201.
     */
    ASSENZA_DATA_TROPPO_LONTANA: 'erroreAssenzaDataTroppoLontana',
    /**
     * 400 — il motivo dell'assenza supera la lunghezza massima
     * (`POST /api/parent/presenze/comunica-assenza`, `MOTIVO_MAX_CARATTERI`).
     *
     * Ha un codice suo perché il rimedio è diverso da ogni altro rifiuto di
     * questa rotta: qui non si cambia il giorno né si chiama la scuola, si
     * accorcia il testo. La frase dice il numero, altrimenti «troppo lungo» non
     * è un'istruzione. In produzione è stata scritta una riga da 200.000
     * caratteri prima che questo confine esistesse.
     */
    ASSENZA_MOTIVO_TROPPO_LUNGO: 'erroreAssenzaMotivoTroppoLungo',
    /**
     * 500 — l'oblio (art. 17) non è stato eseguito: una delle due letture che lo
     * decidono — l'anagrafica dell'alunno, i suoi genitori — non è riuscita
     * (`POST /api/admin/gdpr/erase`).
     *
     * NON riusa il 404 «Alunno non trovato», ed è tutto il punto: fino al
     * 2026-08-07 una lettura fallita usciva proprio da quella porta, e a una
     * richiesta di cancellazione di una famiglia si rispondeva che il bambino
     * non esiste. «Non c'è» chiude la pratica; «non l'ho potuto leggere» chiede
     * di riprovare. La frase lo dice, perché chi la legge è la Direzione e
     * l'operazione non ha un annulla.
     */
    GDPR_ERASE_NON_RIUSCITO: 'erroreGdprEraseNonRiuscito',
    /**
     * 409 — l'insegnante ha GIÀ fatto l'appello di quel giorno: la comunicazione
     * del genitore (e il suo annullamento) non sovrascrive il registro.
     *
     * È un rifiuto che protegge un dato altrui, non un guasto, e va detto come
     * tale: un 500 generico farebbe riprovare all'infinito una cosa che non può
     * riuscire. La via d'uscita è una persona, non un altro tentativo.
     */
    ASSENZA_GIA_REGISTRATA: 'erroreAssenzaGiaRegistrata',
    /**
     * 404 — l'alunno indicato non esiste, oppure non è fra i figli di chi chiede.
     *
     * Un solo codice per i due casi, come per `DOMANDA_NON_APRIBILE` e per la
     * stessa ragione: distinguerli direbbe a chi prova un id a caso quando ha
     * imbroccato un bambino vero. Qui la posta è più alta che altrove — la
     * risposta confermerebbe l'esistenza di un minore a chi non ha titolo di
     * conoscerlo. La differenza vive nel log, non a schermo.
     *
     * NON riusa `MODULO_NON_TROVATO`: quello è il 404 del link pubblico di un
     * modulo, e la sua frase parla di collegamenti scaduti. A un genitore che ha
     * appena toccato il nome di suo figlio in un elenco direbbe una cosa falsa.
     */
    ALUNNO_NON_TROVATO: 'erroreAlunnoNonTrovato',
    /**
     * 500 — la riga di presenza non è stata scritta (errore PostgREST).
     *
     * Il `message` grezzo di PostgREST NON esce di qui: è prosa inglese con dentro
     * nomi di colonne, e fino a questo ciclo era proprio ciò che il server rimandava
     * al client (`{ error: error.message }`). Il motivo tecnico resta nel log.
     *
     * La frase invita a RIPROVARE perché è l'unico caso dei quattro in cui il
     * secondo tentativo può andare bene: gli altri tre chiedono di cambiare
     * qualcosa. Dirlo sbagliato manda il genitore contro un muro o, peggio, gli
     * fa credere che l'assenza sia registrata quando non lo è.
     */
    ASSENZA_NON_SALVATA: 'erroreAssenzaNonSalvata',
    /**
     * 500 — la GIUSTIFICA non si è potuta scrivere
     * (`POST /api/parent/presenze/giustifica`: il guasto PostgREST sull'UPDATE, e
     * l'eccezione del `catch` esterno).
     *
     * NON riusa `ASSENZA_NON_SALVATA`: quella parla di un'assenza COMUNICATA in
     * anticipo, questa di una giustifica FIRMATA a posteriori. La differenza che
     * il genitore deve poter leggere è cosa è rimasto valido: qui l'assenza è già
     * in registro e ciò che manca è la firma, quindi la frase non deve fargli
     * temere di aver perso anche l'assenza.
     *
     * Fino al 2026-08-08 questa rotta mandava al client il `message` grezzo di
     * PostgREST — prosa inglese con dentro il nome di un vincolo — e nel ramo
     * dell'eccezione non lo LOGGAVA nemmeno: il genitore leggeva il dettaglio
     * tecnico e nessun altro lo vedeva.
     */
    GIUSTIFICA_NON_SALVATA: 'erroreGiustificaNonSalvata',
    /**
     * 500 — le presenze del bambino non si sono POTUTE LEGGERE
     * (`GET /api/parent/presenze`: anagrafica, appello di oggi, riepilogo).
     *
     * NON riusa `ALUNNO_NON_TROVATO`, ed è tutto il punto: fino al 2026-08-07 una
     * lettura fallita usciva proprio da quella porta, perché PostgREST non lancia e
     * `alunno` restava `null`. Al genitore si diceva che suo figlio non esiste — per
     * un guasto del database. «Non c'è» e «non l'ho potuto leggere» hanno rimedi
     * opposti: il primo si risolve in segreteria, il secondo riprovando.
     *
     * NON riusa nemmeno `ASSENZA_NON_SALVATA`: quella frase parla di una scrittura
     * («non siamo riusciti a registrare l'assenza») e qui non si stava scrivendo
     * niente — racconterebbe a chi ha solo aperto la home un fallimento che non è
     * avvenuto.
     */
    PRESENZE_NON_LETTE: 'errorePresenzeNonLette',
    /**
     * 500 — l'ANNULLAMENTO della comunicazione non è riuscito
     * (`DELETE /api/parent/presenze/comunica-assenza`).
     *
     * NON riusa `ASSENZA_NON_SALVATA`, ed è l'unica ragione per cui esiste: quella
     * frase dice «non siamo riusciti a registrare l'assenza», che a chi ha appena
     * premuto «annulla» racconta il contrario di quello che è successo — e nel
     * verso peggiore, perché lascia credere che l'assenza non ci sia più mentre è
     * ancora lì. I due guasti hanno lo stesso status e rimedi identici (riprova),
     * ma direzioni opposte: un codice solo per entrambi mentirebbe metà delle volte.
     */
    ASSENZA_NON_ANNULLATA: 'erroreAssenzaNonAnnullata',

    /* ── Candidature insegnanti (`/lavora-con-noi`) ──────────────────────────
     *
     * Il modulo è PUBBLICO, si compila dal telefono e senza login: è la porta
     * con la platea più larga e meno assistita di tutta l'app. Nessuno di
     * questi rifiuti può ricadere sulla prosa italiana del server — chi si
     * candida può benissimo avere l'interfaccia in inglese, e non ha una
     * segreteria a cui chiedere che cosa vuol dire quello che ha appena letto.
     */

    /**
     * 500 — la candidatura NON è stata scritta (guasto PostgREST sull'INSERT, o
     * l'eccezione del `catch` esterno).
     *
     * La frase invita a riprovare perché è l'unico rifiuto di questa rotta in cui
     * il secondo tentativo può andare bene: tutti gli altri chiedono di cambiare
     * qualcosa, o non si risolvono affatto da soli. Il motivo tecnico resta nel
     * log: il `message` grezzo di PostgREST è prosa inglese con dentro nomi di
     * colonne, e non è un'informazione per chi sta cercando lavoro.
     */
    CANDIDATURA_NON_INVIATA: 'erroreCandidaturaNonInviata',
    /**
     * 409 — da questo indirizzo email una candidatura è già arrivata ed è ancora
     * in valutazione.
     *
     * ⚠️ NON SI USA SUL MODULO PUBBLICO. È riservato al COCKPIT DI SEGRETERIA,
     * cioè alle rotte autenticate: quando una collega inserisce a mano una
     * candidatura arrivata per posta e l'indice `candidature_insegnanti_email_viva`
     * risponde `23505`, dirle che quella persona è già in valutazione le fa aprire
     * la scheda che c'è invece di crearne una seconda.
     *
     * Sul modulo pubblico la stessa frase sarebbe un ORACOLO DI ENUMERAZIONE:
     * chiunque, digitando l'indirizzo di una maestra, scoprirebbe se quella persona
     * ha una candidatura aperta alla Kidville — che per un'insegnante attualmente
     * impiegata altrove è precisamente l'informazione che non deve uscire. Il
     * modulo è pubblico e senza login: non c'è nessun costo da pagare per provare
     * un indirizzo, e nessuno a cui sia dovuta quella risposta.
     *
     * PERCIÒ `POST /api/iscrizione/insegnanti` RISPONDE `201` GENERICO ANCHE SUL
     * DOPPIO INVIO, e la deduplicazione avviene in silenzio lato server (il `23505`
     * si intercetta, si logga come `candidatura` e NON si racconta a chi ha
     * compilato). Non è una perdita per chi rinvia il modulo temendo che il primo
     * invio non sia passato: il `201` gli dice «ricevuta», che è esattamente la
     * risposta che stava cercando — e gliela dà senza dire nulla su nessun altro.
     *
     * È anche la scelta che il repo fa già altrove: `POST /api/iscrizione`, che ha
     * lo stesso identico problema di doppio invio sullo stesso modulo pubblico, non
     * espone nessun codice equivalente.
     *
     * ⚠️ E C'È UNA PRESCRIZIONE CONTRARIA, SCRITTA PRIMA DI QUESTA, NEL FILE CHE CHI
     * SCRIVERÀ LA ROUTE APRIRÀ DI SICURO. Il commento di
     * `supabase/migrations/20260810094610_candidature_insegnanti.sql:58-60` — cioè
     * proprio la migrazione che crea l'indice da cui il `23505` arriva — dice:
     * «il secondo invio prende 23505, che la route traduce in 409 “l'abbiamo già
     * ricevuta” — non in un doppione muto». Quel 409 sul modulo PUBBLICO è l'oracolo
     * di enumerazione descritto qui sopra, ed è **SUPERATO da questa decisione**:
     * sul pubblico si risponde `201` generico, `CANDIDATURA_GIA_INVIATA` è del
     * COCKPIT autenticato — dove chi legge ha già titolo di vedere quella riga, e la
     * frase serve a mandarlo sulla scheda esistente invece che a crearne una seconda.
     * La frase della migrazione resta corretta per il cockpit e sbagliata per il
     * modulo: chi corregge quel commento tolga «la route» e scriva «la route del
     * cockpit». Nominarlo qui costa una riga; scoprirlo dopo il rilascio costa
     * l'indirizzo di una maestra.
     *
     * ── ⚠️ E LE SEDI SONO TRE. Cosa succede al doppio invio a SEDE DIVERSA ──────
     *
     * Questa prescrizione era stata scritta senza guardare la FORMA dell'indice che
     * genera il `23505`. Misurata il 2026-08-10 su `pg_indexes`:
     *
     *   CREATE UNIQUE INDEX candidature_insegnanti_email_viva
     *     ON public.candidature_insegnanti USING btree (lower(email))
     *     WHERE (stato = ANY (ARRAY['pending','in_approvazione']))
     *
     * `lower(email)` e basta: l'unicità è **GLOBALE**, non `(scuola_id, lower(email))`.
     * Con Giugliano, Aversa e Cesa questo significa che la stessa persona che dopo
     * una settimana si propone a una SECONDA sede prende `23505`, riceve il `201`
     * «ricevuta» — e la segreteria di quella sede non vede mai niente, perché la
     * riga esistente porta lo `scuola_id` della PRIMA.
     *
     * LA DECISIONE, scritta invece che lasciata implicita: **una candidatura viva
     * vale per l'intera cooperativa.** Il datore di lavoro è uno solo («Scuola
     * dell'infanzia La Favola soc. coop.»), la Direzione che valuta è una sola, e
     * un curriculum duplicato in tre righe sarebbe tre volte lo stesso dato
     * personale da conservare e da cancellare. L'indice globale è quindi la forma
     * GIUSTA, non un difetto da correggere in migrazione.
     *
     * Ma «vale per tutte» ha un prezzo, e va pagato invece che taciuto — perché
     * altrimenti la sede che non vede la candidatura crede che non sia arrivata:
     *
     *   1. IL COCKPIT DELLE CANDIDATURE NON SI FILTRA PER SEDE. È l'eccezione
     *      dichiarata alla regola di isolamento di questo repo (AGENTS.md: «non
     *      dare più per scontato che la sede sia una sola»), e sta in piedi solo
     *      perché qui il dato NON è di una famiglia né di un minore: è la proposta
     *      di un adulto a un unico datore di lavoro. `scuola_id` resta la sede di
     *      PROVENIENZA — da dove la persona ha bussato — non un recinto di lettura.
     *   2. IL `23505` NON È RUMORE, ed è l'informazione che si perde: dice che
     *      quella persona ha bussato una seconda volta, e a un'altra porta. Va
     *      loggato a livello **`warn`**, con lo `scuola_id` RICHIESTO ADESSO e l'id
     *      della riga già viva. Non `info`: `candidatura` oggi non è in
     *      `EVENTI_PERSISTITI` (ci entra insieme al ramo felice della route), e un
     *      `info` su un evento non persistito vive qualche giorno sui Runtime Logs
     *      di Vercel e poi sparisce — cioè non è interrogabile in SQL proprio
     *      quando serve, che è quando la seconda segreteria chiede «è arrivata?».
     *      Un `warn` invece si persiste PER LIVELLO, oggi, senza aspettare nessuna
     *      promozione (`src/lib/logging/logger.ts`: `livello === 'error' ||
     *      livello === 'warn' || EVENTI_PERSISTITI.has(evento)`).
     *      Nel log ci vanno `scuola_id`, l'uuid della candidatura viva ed
     *      `error_code: '23505'` — mai l'email, che è la chiave: `redact()` è a
     *      lista bianca e la lascerebbe fuori comunque.
     *
     * Se un domani si decidesse il contrario — una candidatura per sede — non
     * basta cambiare questo commento: va cambiato l'INDICE, in migrazione, a
     * `(scuola_id, lower(email))`. Finché l'indice è quello misurato qui sopra,
     * questa è la sola lettura vera.
     */
    CANDIDATURA_GIA_INVIATA: 'erroreCandidaturaGiaInviata',
    /**
     * 503 — le candidature non si possono ricevere adesso: il modulo è chiuso
     * dalla Scuola, oppure la sede non è configurata per riceverle.
     *
     * NON riusa `CANDIDATURA_NON_INVIATA`, che invita a riprovare fra qualche
     * minuto: qui riprovare non serve a niente, e mandare qualcuno a ritentare
     * ogni cinque minuti una cosa che non può riuscire è peggio di non dire
     * nulla. La frase indirizza alla segreteria, che è l'unica via d'uscita.
     */
    CANDIDATURE_NON_DISPONIBILI: 'erroreCandidatureNonDisponibili',
    /**
     * 400 — l'invio nomina più plessi di quanti ne esistano
     * (`POST /api/iscrizione/insegnanti`).
     *
     * ⚠️ ESISTE PERCHÉ SENZA IL CODICE IL MESSAGGIO NON ARRIVAVA. Il rifiuto era
     * la sola prosa di zod («Troppe sedi indicate») su `scuole_ids`, che non è un
     * campo del modulo: `mappaErroriServer` non lo riconosceva, qui non c'era
     * niente da tradurre, e chi compilava leggeva «Si è verificato un errore
     * durante l'invio. Controlla i dati e riprova» — dopo cinque passi, senza che
     * nulla nominasse la causa e senza nessun dato da correggere.
     */
    TROPPE_SEDI: 'erroreTroppeSedi',
    CORPO_NON_VALIDO: 'erroreCorpoNonValido',
    LETTURA_FALLITA: 'erroreLetturaFallita',
    /**
     * 404 — la candidatura chiesta per id non è apribile dal cockpit.
     *
     * Un solo codice per due situazioni, come per `DOMANDA_NON_APRIBILE` e per la
     * stessa ragione: non esiste, oppure esiste ed è di un'altra sede.
     * Distinguerle direbbe a chi non ha titolo di vederla che quella candidatura
     * c'è — e da lì esce il curriculum di una persona. La differenza vive nel log.
     */
    CANDIDATURA_NON_TROVATA: 'erroreCandidaturaNonTrovata',
    /**
     * 409 — la candidatura è già stata evasa (accolta o rifiutata) da qualcun
     * altro: non si valuta due volte.
     *
     * È il rifiuto di due schede aperte sulla stessa riga, e va detto come tale:
     * un 500 generico farebbe premere «Accetta» all'infinito, e la seconda
     * decisione sovrascriverebbe in silenzio quella di una collega. La frase dice
     * di ricaricare, perché lo stato vero è già in tabella.
     */
    CANDIDATURA_GIA_EVASA: 'erroreCandidaturaGiaEvasa',
    /**
     * 409 — l'email della candidatura appartiene GIÀ a un account del personale:
     * l'approvazione si fermerebbe alla creazione delle credenziali.
     *
     * Il rifiuto arriva a chi sta in segreteria, non a chi si è candidato, e per
     * questo la frase dice cosa fare: la persona un accesso ce l'ha già, va
     * collegata all'account esistente invece di crearne un secondo. Due account
     * per la stessa insegnante significano un registro diviso in due.
     */
    CANDIDATURA_EMAIL_GIA_STAFF: 'erroreCandidaturaEmailGiaStaff',
    /**
     * 409 — la stessa email è già quella di un GENITORE.
     *
     * Ha un codice suo e non riusa quello del personale, perché il rimedio è
     * l'opposto: lì si collega un account che ha già il ruolo giusto, qui no —
     * la stessa persona può essere insegnante *e* genitore di un bambino della
     * Scuola, e sovrascriverle il ruolo le toglierebbe l'accesso ai suoi figli.
     * Un codice solo per i due casi manderebbe la segreteria a fare la mossa
     * sbagliata metà delle volte.
     */
    CANDIDATURA_EMAIL_GIA_GENITORE: 'erroreCandidaturaEmailGiaGenitore',
    /**
     * 503 — il COCKPIT delle candidature (segreteria e Direzione) non è riuscito
     * a leggere o a evadere: tabella non ancora migrata, lettura fallita, claim
     * non riuscito, curriculum non firmabile, account non creato.
     *
     * NON riusa `CANDIDATURE_NON_DISPONIBILI`, che è della PORTA PUBBLICA: quella
     * frase dice «non possiamo ricevere candidature… oppure scrivi alla segreteria
     * della scuola», cioè manda la segreteria a scrivere a sé stessa, e la sua
     * documentazione dichiara che riprovare non serve a niente — mentre qui
     * riprovare è esattamente il rimedio. Un codice solo per due situazioni con
     * rimedi opposti è la stessa bugia del 404 su un guasto, con un altro numero.
     */
    CANDIDATURE_OPERAZIONE_NON_RIUSCITA: 'erroreCandidatureOperazioneNonRiuscita',
    /**
     * 500 — l'anagrafica non si è potuta leggere, quindi il pannello «Codici
     * fiscali da verificare» (`GET /api/admin/anagrafiche/codici-fiscali`) non ha
     * verificato NIENTE.
     *
     * Ha un codice suo, e a livello 500, perché il guasto è NOSTRO e va detto
     * come tale. Un elenco vuoto sarebbe indistinguibile da «va tutto bene»:
     * esattamente il contrario di ciò che è successo, e la lettura più
     * pericolosa che quel pannello possa dare. Il `message` di PostgREST resta
     * nel log — è prosa inglese con dentro nomi di colonne — e la frase qui
     * dice solo che non si è potuto guardare.
     */
    VERIFICA_CODICI_FISCALI_NON_RIUSCITA: 'erroreVerificaCodiciFiscaliNonRiuscita',

    /* ── Modulo pubblico «Anagrafica del personale» (`/anagrafica-personale`) ──
     *
     * Due codici, e nessuno dei due riusa quelli delle CANDIDATURE, benché le due
     * porte si somiglino riga per riga. Non è simmetria: è la parola che una persona
     * legge a schermo. Chi apre questo modulo è una maestra che LAVORA già qui e a cui
     * la Segreteria ha mandato il link; dirle «non siamo riusciti a registrare la tua
     * candidatura» le direbbe che il sistema ha capito un'altra cosa di lei — e su un
     * modulo in cui ha appena caricato il proprio documento d'identità è esattamente il
     * momento in cui non deve dubitare di dove siano finiti i suoi dati.
     */

    /**
     * 400/500 — l'anagrafica del personale NON è stata registrata: campi non validi,
     * consensi mancanti, esca scattata, o guasto PostgREST sull'INSERT.
     *
     * La frase invita a riprovare perché il 500 è l'unico rifiuto di questa rotta in
     * cui il secondo tentativo può andare bene da solo; i 400 portano con sé `campi`
     * (o `consensi`), che è ciò che il modulo mostra accanto al campo. Il motivo
     * tecnico resta nel log: il `message` grezzo di PostgREST è prosa inglese con
     * dentro nomi di colonne, e non è un'informazione per chi sta compilando.
     */
    PRATICA_NON_INVIATA: 'errorePraticaPersonaleNonInviata',
    /**
     * 503 — l'anagrafica del personale non si può ricevere adesso: la tabella non
     * risponde (è lo stato del database della CI, che non è migrato).
     *
     * NON riusa `PRATICA_NON_INVIATA`, che invita a riprovare fra qualche minuto: qui
     * riprovare non serve a niente, e mandare qualcuno a ritentare ogni cinque minuti
     * una cosa che non può riuscire è peggio di non dire nulla. La frase indirizza alla
     * segreteria, che è l'unica via d'uscita — ed è anche l'unica cosa vera da dire, al
     * posto di un `201` che direbbe «ricevuta» su una riga che non esiste.
     */
    PRATICHE_NON_DISPONIBILI: 'errorePratichePersonaleNonDisponibili',
    /**
     * 413 — la scansione del documento supera il limite della PIATTAFORMA.
     *
     * ⚠️ NON riusa `ALLEGATO_TROPPO_GRANDE`, ed è una misura e non una preferenza:
     * la frase di quel codice dice «un allegato può pesare al massimo 10 MB» in
     * entrambi i cataloghi, mentre il tetto vero di una funzione Vercel è
     * `LIMITE_UPLOAD_MB` (4 MB) — sopra i ~4,5 MB il corpo lo rifiuta la
     * piattaforma prima che l'handler esista. Mostrarla qui direbbe a una maestra
     * che ha ancora 6 MB di margine mentre il caricamento è già stato respinto: è
     * il modo di rendere il modulo inutilizzabile con un messaggio rassicurante.
     *
     * E LA FRASE NON PORTA IL NUMERO, di proposito. Scriverlo nel catalogo
     * significherebbe una TERZA copia di `LIMITE_UPLOAD_MB` (dopo la route e il
     * `file_size_limit` del bucket), in due lingue, in un file che nessuno rilegge
     * quando la piattaforma alza il tetto: è la divergenza di `gallery` (50 MB nel
     * bucket, 200 MB nella route, per mesi) con un passaggio in più. Il numero
     * esatto resta nella prosa del server — che lo interpola dalla costante — e nel
     * log; a schermo va ciò che si può fare, che è la cosa che serve davvero a chi
     * sta fotografando una carta d'identità col telefono.
     */
    ALLEGATO_OLTRE_LIMITE_PIATTAFORMA: 'erroreAllegatoOltreLimitePiattaforma',

    /* ── Cockpit delle PRATICHE del personale (`/admin/modulistica?tab=personale`) ──
     *
     * Cinque codici del lato SEGRETERIA, distinti dai due qui sopra — che sono della
     * porta pubblica — e distinti da quelli delle CANDIDATURE, benché le due schermate
     * si somiglino riga per riga. Non è simmetria: le frasi delle candidature dicono
     * «candidatura», e qui non si sta valutando nessuna candidatura. Chiamare
     * «candidatura» la scheda di una collega che lavora qui da anni non è un refuso
     * di catalogo, è dirle che il sistema ha capito un'altra cosa di lei.
     */

    /**
     * 404/403 — la pratica non esiste, **oppure** è di un'altra sede: un messaggio
     * solo per due fatti, e non per pigrizia.
     *
     * Distinguerli direbbe a chi non ha titolo di vederla che quella pratica c'è, e da
     * lì escono codice fiscale, residenza ed estremi di un documento d'identità. Lo
     * stesso codice vale sul 403 dell'ALLEGATO: una scansione non si conferma
     * rispondendo «esiste ma non è tua». La differenza vive nel log.
     */
    PRATICA_NON_TROVATA: 'errorePraticaPersonaleNonTrovata',
    /**
     * 503 — la lettura o la scrittura del COCKPIT non è riuscita.
     *
     * NON riusa `PRATICHE_NON_DISPONIBILI`, che è della porta pubblica: la sua frase
     * («in questo momento non possiamo registrare i dati del personale… scrivi alla
     * segreteria della scuola») è scritta per chi sta compilando, e mostrata qui
     * manderebbe la segreteria a scrivere a sé stessa. Il fatto, qui, è un altro:
     * l'elenco non si è letto, o l'approvazione non si è potuta completare.
     */
    PRATICHE_OPERAZIONE_NON_RIUSCITA: 'errorePratichePersonaleOperazioneNonRiuscita',
    /**
     * 409 — qualcun altro ha già deciso. È l'esito del claim atomico
     * (`pending → in_approvazione`) che chiude la corsa fra due clic o due schede, ed è
     * anche la risposta a chi prova a spostare di sede una pratica già valutata.
     */
    PRATICA_GIA_EVASA: 'errorePraticaPersonaleGiaEvasa',
    /**
     * 409 — quell'email è l'accesso di un GENITORE.
     *
     * È l'unica delle due porte di `ensureStaffIdentity` che qui resta chiusa: il riuso
     * del profilo del PERSONALE è il caso normale di questo modulo (la maestra
     * l'account ce l'ha), mentre dare il profilo docente all'uid di un genitore gli
     * darebbe l'anagrafica di tutti i bambini — oppure gli toglierebbe l'accesso ai
     * propri figli. È una decisione che prende una persona, non una route.
     */
    PRATICA_EMAIL_GIA_GENITORE: 'errorePraticaPersonaleEmailGiaGenitore',
    /**
     * 400 — la sede indicata per lo spostamento non è una sede della cooperativa.
     *
     * Vale anche per la sede fittizia su cui gira la CI, che `sediReali` esclude da
     * ogni elenco: spostarci una pratica vera la farebbe sparire da tutte le
     * scrivanie senza che nessuno possa più trovarla.
     */
    PRATICA_SEDE_NON_AMMESSA: 'errorePraticaPersonaleSedeNonAmmessa',
    /**
     * 403 — quell'email ha un account registrato su un plesso che questa postazione
     * non gestisce, e il fascicolo NON è stato scritto.
     *
     * NON riusa `PRATICA_NON_TROVATA`, e non è una svista: lì il silenzio protegge
     * (dire «esiste» rivelerebbe una pratica che chi guarda non ha titolo di vedere),
     * qui la pratica chi guarda ce l'ha davanti — l'ha appena aperta — e ciò che
     * manca è l'unica cosa che gli permette di rimediare: sapere che il muro è la
     * SEDE DELLA PERSONA, non la pratica, e che l'approvazione va chiesta a chi quel
     * plesso lo gestisce. Un 403 muto la manderebbe a ripremere.
     */
    PRATICA_ACCOUNT_ALTRA_SEDE: 'errorePraticaPersonaleAccountAltraSede',

    /* ── «Aggiungi il ruolo di insegnante a questo account» ──────────────────────
     *
     * I cinque rifiuti di `POST /api/admin/staff/collega-profilo-esistente`, la porta
     * che una PERSONA apre a mano quando l'email di una pratica è quella di un
     * genitore. NON riusano `PRATICA_*`: quelli parlano di una pratica da approvare
     * («l'approvazione verrà rifiutata»), questi di un ruolo da aggiungere a un
     * accesso che esiste — e chi legge sta facendo due gesti diversi.
     */

    /**
     * 404 — quell'uid non ha (più) nessun profilo. Non si crea niente: l'operazione
     * esiste per AGGIUNGERE un ruolo a un accesso vivo, e su un uid che non risponde
     * l'unica cosa onesta è dirlo.
     */
    PROFILO_DOPPIO_ACCOUNT_NON_TROVATO: 'erroreProfiloDoppioAccountNonTrovato',
    /**
     * 409 — quell'accesso ha già un profilo del PERSONALE.
     *
     * È anche l'esito del secondo clic: la clausola `ruolo = <valore letto>` rende
     * l'UPDATE atomico, quindi due schede aperte danno un 200 e un 409 invece di due
     * scritture. Il ruolo che la persona ha NON viene sovrascritto: un declassamento
     * silenzioso è un accesso perso, e si cambia dal pannello Personale.
     */
    PROFILO_DOPPIO_GIA_PERSONALE: 'erroreProfiloDoppioGiaPersonale',
    /**
     * 409 — quell'accesso non è collegato a nessuna scheda di figlio.
     *
     * Questa porta esiste per aggiungere un ruolo *senza togliere l'accesso alle
     * schede dei figli*: senza il ponte `parents` non c'è nessun accesso da salvare,
     * quindi non è questo lo strumento — è un normale cambio di ruolo, e si fa dal
     * pannello Personale, dove si vede che cosa si sta cambiando.
     */
    PROFILO_DOPPIO_SENZA_PONTE: 'erroreProfiloDoppioSenzaPonte',
    /**
     * 403 — quell'accesso è registrato su un plesso che questa postazione non
     * gestisce, e non è stato modificato niente. Come per `PRATICA_ACCOUNT_ALTRA_SEDE`
     * il muro è la SEDE DELLA PERSONA, non il gesto: un 403 muto manderebbe a
     * ripremere.
     */
    PROFILO_DOPPIO_ALTRA_SEDE: 'erroreProfiloDoppioAltraSede',
    /**
     * 400/503 — la richiesta non porta la conferma esplicita, oppure una lettura o la
     * scrittura non sono riuscite. In ogni caso niente è stato modificato: è la
     * differenza che chi opera deve poter leggere prima di riprovare.
     */
    PROFILO_DOPPIO_NON_RIUSCITO: 'erroreProfiloDoppioNonRiuscito',

    /* ── Cruscotto «Scadenze documenti» in Segreteria (`/admin/staff?tab=scadenze`) ──
     *
     * Tre codici, e nessuno riusa i due della porta PUBBLICA qui sopra: quelli
     * parlano a una maestra che sta compilando il modulo («non siamo riusciti a
     * registrare i tuoi dati»), questi a chi sta in segreteria con la persona davanti
     * al banco. La stessa frase, letta dai due posti, dice due cose diverse — e in
     * uno dei due sarebbe falsa.
     */

    /**
     * 503 — il cruscotto delle scadenze non si è potuto leggere: schema non ancora
     * creato (è lo stato del database della CI), lettura fallita, storage muto.
     *
     * ⚠️ ESISTE PERCHÉ L'ALTERNATIVA È UN ELENCO VUOTO, che su questa pagina è la
     * risposta più pericolosa possibile: «nessun documento in scadenza» si legge
     * come «va tutto bene» ed è indistinguibile da «non abbiamo guardato». La
     * segreteria smetterebbe di controllare proprio mentre il controllo è fermo.
     */
    ANAGRAFICA_PERSONALE_NON_DISPONIBILE: 'erroreAnagraficaPersonaleNonDisponibile',
    /**
     * 404/403 — quell'anagrafica non è accessibile: non esiste, oppure è di
     * un'altra sede. Una frase sola per i due casi, ed è deliberato: distinguerli
     * direbbe a chi non ha titolo che quella persona lavora qui.
     */
    ANAGRAFICA_PERSONALE_NON_TROVATA: 'erroreAnagraficaPersonaleNonTrovata',
    /**
     * 503 — la correzione allo sportello non è stata registrata.
     *
     * NON riusa `ANAGRAFICA_PERSONALE_NON_DISPONIBILE`: lì non si è letto niente,
     * qui non si è SCRITTO — e chi ha la persona davanti deve sapere che la nuova
     * scadenza non è in tabella, invece di congedarla credendo di averla salvata.
     */
    ANAGRAFICA_PERSONALE_NON_AGGIORNATA: 'erroreAnagraficaPersonaleNonAggiornata',
    /**
     * 409 — fra la lettura e la scrittura qualcun ALTRO ha sostituito la stessa faccia
     * del documento (`admin/anagrafica-personale/scansione:POST`).
     *
     * NON riusa `ANAGRAFICA_PERSONALE_NON_AGGIORNATA`, e la differenza è tutta nel
     * rimedio: là non si è scritto per un guasto e la risposta giusta è «riprova»; qui
     * la scrittura è stata RIFIUTATA di proposito, perché eseguirla avrebbe cancellato
     * dall'archivio la scansione che un collega ha appena caricato — su un documento
     * d'identità, senza possibilità di recupero. Chi legge deve ricaricare la scheda e
     * guardare che cosa c'è adesso, non ripremere lo stesso pulsante.
     */
    SCANSIONE_SOSTITUITA_ALTROVE: 'erroreScansioneSostituitaAltrove',
    /**
     * 503 — il fascicolo non si è potuto LEGGERE, quindi la scansione non è stata
     * caricata (`admin/anagrafica-personale/scansione:POST`, passo 5).
     *
     * ⚠️ NON riusa `ANAGRAFICA_PERSONALE_NON_DISPONIBILE`, e la ragione è che quella
     * frase — l'unica che il client mostra, perché la prosa del server la butta chi
     * non è in `CODICI_CON_DETTAGLIO` — dice «le scadenze dei documenti non sono
     * consultabili… qui sotto non compare nessuna riga». È la frase giusta SOTTO IL
     * CRUSCOTTO DELLE SCADENZE, dove l'elenco vuoto è la cosa da spiegare. Sotto un
     * pulsante «Carica il fronte» parla di un elenco che non c'è sullo schermo, e non
     * dice l'unica cosa che chi ha il documento in mano deve sapere: **che il file
     * non è stato archiviato**, e che la persona davanti al banco non ha consegnato
     * niente.
     */
    SCANSIONE_ARCHIVIO_NON_DISPONIBILE: 'erroreScansioneArchivioNonDisponibile',
    /**
     * 503 — la colonna del fascicolo non si è potuta SCRIVERE, e l'oggetto appena
     * caricato è stato ritirato dal bucket
     * (`admin/anagrafica-personale/scansione:POST`, passo 12).
     *
     * ⚠️ NON riusa `ANAGRAFICA_PERSONALE_NON_AGGIORNATA`, che dice «LA CORREZIONE non
     * è stata registrata»: la correzione è il PATCH allo sportello — scadenza, tipo,
     * numero del documento — e chi ha appena premuto «Carica il retro» non ha corretto
     * niente. Peggio: quella frase tace sul fatto che pesa, cioè che la fotografia non
     * è rimasta nemmeno nell'archivio. Qui la risposta utile è «rifallo», e per
     * poterla dare bisogna prima dire che non è stato conservato niente.
     */
    SCANSIONE_NON_REGISTRATA: 'erroreScansioneNonRegistrata',
    /**
     * 404 — «libera spazio» non trova più quell'alunno in archivio
     * (`admin/students/libera-spazio:POST`).
     *
     * NON riusa `ALUNNO_NON_TROVATO`, la cui frase dice «fra i TUOI figli» e parla
     * a un genitore: qui davanti allo schermo c'è la Direzione, che ha scelto un
     * nome da un elenco. La risposta utile è «ricarica l'elenco», non «contatta la
     * segreteria» — la segreteria è chi sta leggendo.
     */
    SPAZIO_ALUNNO_NON_TROVATO: 'erroreSpazioAlunnoNonTrovato',
    /**
     * 409 — si libera spazio solo di chi è fra i «non più iscritti»
     * (`admin/students/libera-spazio:POST`).
     *
     * È un rifiuto che protegge, non un guasto, e la frase deve dire COME si
     * sblocca: prima si archivia il bambino, poi se ne liberano foto e messaggi.
     * Un rifiuto che non dice il rimedio è un rifiuto che torna — la lezione già
     * pagata sul 409 dell'oblio, che diceva «solo su alunni non iscritti» mentre
     * rifiutava uno stato che non iscritto lo era davvero.
     */
    SPAZIO_ALUNNO_ANCORA_ISCRITTO: 'erroreSpazioAlunnoAncoraIscritto',
    /**
     * 400 — il nominativo digitato per confermare non combacia
     * (`admin/students/libera-spazio:POST`).
     *
     * La conferma è una digitazione e non un secondo click perché qui non si torna
     * indietro: foto, video e messaggi non si ripristinano. La frase ripete la
     * forma attesa («Cognome Nome»), altrimenti «conferma non valida» non è
     * un'istruzione.
     */
    SPAZIO_CONFERMA_NON_VALIDA: 'erroreSpazioConfermaNonValida',
    /**
     * 500 — non si è potuto liberare lo spazio: una delle letture che decidono
     * l'operazione non è riuscita (`admin/students/libera-spazio:POST`).
     *
     * «Non c'è niente da togliere» e «non l'ho potuto leggere» qui portano a due
     * gesti opposti — il primo autorizza a cancellare — quindi la seconda non si
     * traveste mai da prima: si risponde 500 e non si scrive niente. La frase
     * chiede di riprovare perché la riga resta azionabile: nulla è stato tolto a
     * metà.
     */
    SPAZIO_NON_LIBERATO: 'erroreSpazioNonLiberato',

    /* ── Archiviazione e ritorno di un alunno (`admin/students/archivia|riattiva`) ──
     *
     * Il primo tempo del modello a due tempi: il bambino esce dagli elenchi con
     * l'anagrafica INTATTA, ed è reversibile. Chi legge queste frasi è la
     * segreteria, con la famiglia davanti o al telefono — non un genitore: nessuna
     * di queste può dire «contatta la segreteria», che è chi sta leggendo.
     */

    /**
     * 409 — quel bambino è già fra i «non più iscritti»
     * (`admin/students/archivia:POST`).
     *
     * È il rifiuto di due schede aperte sulla stessa riga, non un guasto: la frase
     * dice di ricaricare, perché lo stato vero è già in tabella e ripremere non
     * cambierebbe niente.
     *
     * ⚠️ Scatta su `archiviato_il`, non sullo stato: un bambino messo a «Ritirato»
     * dalla tendina della scheda NON è archiviato — è ancora agganciato alla sua
     * sezione — e archiviarlo è esattamente ciò che serve fare.
     */
    ALUNNO_GIA_ARCHIVIATO: 'erroreAlunnoGiaArchiviato',
    /**
     * 409 — quel bambino è già fra gli iscritti (`admin/students/riattiva:POST`).
     *
     * NON riusa `ALUNNO_GIA_ARCHIVIATO`: dice il contrario, e a chi ha appena
     * premuto «Riporta fra gli iscritti» racconterebbe che il bambino è fuori
     * mentre è dentro. I due rifiuti hanno lo stesso status e lo stesso rimedio
     * (ricarica), ma direzioni opposte: un codice solo mentirebbe metà delle volte
     * — la lezione già pagata su `ASSENZA_NON_ANNULLATA`.
     */
    ALUNNO_NON_ARCHIVIATO: 'erroreAlunnoNonArchiviato',
    /**
     * 404 — quel bambino non è più raggiungibile da questa postazione: non esiste
     * più, oppure è uscito dalle sedi di chi guarda.
     *
     * Un solo codice per i due casi, come per `DOMANDA_NON_APRIBILE` e per la
     * stessa ragione: distinguerli confermerebbe l'esistenza di un minore a chi non
     * ha titolo di conoscerlo. La differenza vive nel log.
     *
     * NON riusa `ALUNNO_NON_TROVATO`, la cui frase dice «fra i TUOI figli» e parla
     * a un genitore: qui davanti allo schermo c'è la segreteria, e il rimedio è
     * ricaricare l'elenco.
     */
    ALUNNO_NON_APRIBILE: 'erroreAlunnoNonApribile',
    /**
     * 409 — su un bambino ARCHIVIATO la tendina «Stato» non decide più niente
     * (`admin/students:PATCH`).
     *
     * ⚠️ CHIUDE UNA SECONDA PORTA, e la porta era aperta in produzione. La PATCH
     * tiene `stato` in `allowedFields` e non tocca né `archiviato_*` né
     * `classe_sezione`: un `PATCH` con `stato` = `'iscritto'` su una riga archiviata
     * rispondeva **200** e lasciava un bambino ISCRITTO con `section_id` e
     * `classe_sezione` a NULL — fuori da registro, appello, mensa, diario e
     * valutazioni (le query per sezione, che sono la maggioranza) e fuori anche
     * dalla linguetta «Non più iscritti», che filtra `stato=ritirato`. Restava
     * nella sola anagrafica piatta, senza un log e senza un avviso: il danno
     * esatto che il modello a due tempi esiste per evitare, raggiungibile dal
     * bottone «Apri scheda» dell'elenco nuovo.
     *
     * Il rifiuto NON è un dispetto burocratico: il ritorno ha una rotta sua
     * (`admin/students/riattiva:POST`) che rimette lo stato E ripristina la
     * classe dopo averne verificato l'esistenza nella sede. La frase manda lì,
     * perché un rifiuto che non dice dove andare è un vicolo cieco.
     *
     * Scatta su `archiviato_il`, come il 409 dell'archiviazione e per la stessa
     * ragione: il ritiro fatto a mano dalla tendina (`stato='ritirato'`,
     * `archiviato_il` NULL) è ancora agganciato alla sua sezione, e correggerlo
     * dalla tendina non fa sparire nessuno.
     */
    STATO_ALUNNO_ARCHIVIATO: 'erroreStatoAlunnoArchiviato',
    /**
     * 503 — le colonne dell'archiviazione non esistono in questo database, e
     * NIENTE è stato scritto (`archivia` e `riattiva`).
     *
     * ⚠️ È il rifiuto che sostituisce il degrado. Il resto del repo, davanti a
     * `42703`/`PGRST204`, toglie la colonna e riprova — perché il DB E2E della CI
     * è un progetto separato e non migrato, e un campo in più non deve portarsi via
     * una funzionalità. Su questo UPDATE quella strada è vietata: eseguirebbe lo
     * sganciamento dalla classe (`section_id` a NULL) e non la memoria di dov'era,
     * cioè renderebbe il ritorno un indovinello. Un'archiviazione a metà è
     * irreversibile; un 503 si ripete domani.
     *
     * NON riusa `ARCHIVIAZIONE_NON_RIUSCITA`, che invita a riprovare: qui riprovare
     * non serve a niente finché la migrazione non è applicata, e mandare qualcuno a
     * ritentare ogni cinque minuti una cosa che non può riuscire è peggio del
     * silenzio.
     */
    ARCHIVIO_NON_DISPONIBILE: 'erroreArchivioNonDisponibile',
    /**
     * 500 — l'archiviazione non è stata registrata: la lettura della scheda o
     * l'UPDATE non sono riusciti (`admin/students/archivia:POST`).
     *
     * La frase dice che la scheda è rimasta com'era, ed è l'informazione che serve:
     * senza, chi ha premuto non sa se il bambino è uscito dagli elenchi a metà. Il
     * `message` grezzo di PostgREST resta nel log — è prosa inglese con dentro nomi
     * di colonne, e non è un'informazione per chi lavora in segreteria.
     */
    ARCHIVIAZIONE_NON_RIUSCITA: 'erroreArchiviazioneNonRiuscita',
    /**
     * 500 — il ritorno fra gli iscritti non è riuscito
     * (`admin/students/riattiva:POST`).
     *
     * NON riusa `ARCHIVIAZIONE_NON_RIUSCITA`, per la stessa ragione della coppia di
     * 409 qui sopra: quella frase dice «l'archiviazione non è stata registrata», e
     * a chi stava riportando dentro un bambino racconterebbe il fallimento di
     * un'operazione opposta a quella che ha chiesto.
     */
    RIATTIVAZIONE_NON_RIUSCITA: 'erroreRiattivazioneNonRiuscita',
    /**
     * 500 — la rubrica non si è potuta leggere (`chat/contacts:GET`, lato maestra).
     *
     * Nasce insieme al controllo dell'`{ error }` di quella query (2026-08-13):
     * PostgREST non lancia, quindi una lettura fallita usciva come `data = null` e
     * la rubrica mostrava «nessun contatto». Per la maestra «questa classe non ha
     * genitori a sistema» e «la lettura è andata storta» sono la stessa schermata
     * vuota, e la prima delle due la manda a cercare il problema nei legami.
     *
     * NON riusa un codice dei contatti di segreteria: quella rotta è un'altra, e
     * chi legge un log o una schermata deve poter dire QUALE delle due rubriche
     * non ha risposto.
     */
    RUBRICA_NON_DISPONIBILE: 'erroreRubricaNonDisponibile',
    /**
     * 500 — l'archivio dei documenti non ha potuto leggere gli alunni
     * (`documenti-firmati:GET`). Senza questo codice la schermata direbbe
     * «nessun documento», che è un'affermazione di fatto — e falsa: la
     * differenza fra «questo bambino non ha documenti» e «non ho potuto
     * guardare» è tutta la differenza che conta per chi cerca un nulla osta.
     */
    DOCUMENTI_ELENCO_NON_LETTO: 'erroreDocumentiElencoNonLetto',
    /** 404 — il documento chiesto non esiste, o non appartiene a nessun fascicolo. */
    DOCUMENTO_NON_TROVATO: 'erroreDocumentoNonTrovato',
    /**
     * 403 — documento SANITARIO chiesto da chi non è né la segreteria del plesso
     * né un'insegnante contitolare della sezione dell'alunno
     * (`puoAccedereFascicolo`). Codice proprio, distinto dal diniego di sede:
     * chi legge un log deve poter contare quante volte è stato chiesto un
     * documento sanitario da fuori — è un segnale, non rumore.
     */
    DOCUMENTO_SANITARIO_NEGATO: 'erroreDocumentoSanitarioNegato',

    /* ── I diciassette PRESTAMPATI (`src/lib/prestampati/`) ──────────────────
     *
     * Otto codici per la modulistica prestampata: il pannello della segreteria, la
     * generazione self-service del genitore, il render del PDF. Li legge sia chi sta
     * allo sportello sia una famiglia dal telefono — cioè, di nuovo, una platea in
     * cui l'italiano non è garantito.
     *
     * ⚠️ DUE CODICI CHE NON SONO STATI CREATI, e vale la pena dire perché:
     *
     *  · «SEDE NON DICHIARATA» non esiste qui. Quel rifiuto ce l'ha già
     *    `SEDE_DA_SPECIFICARE`, che nasce dentro `resolveScuolaScrittura` e passa da
     *    `rifiutoSede()` — l'unica sorgente consentita dal lock `errori-con-codice`.
     *    Un secondo codice con la stessa frase e lo stesso rimedio («scegli una sede»)
     *    sarebbe la trappola del codice DUPLICATO, gemella di quella del codice
     *    RIUSATO che questo file documenta su `NEWS_FILE_SOSTITUITI_NON_RIMOSSI`:
     *    dichiarato, tradotto, e sbagliato.
     *  · «ALUNNO FUORI PORTATA» non esiste qui: è `ALUNNO_NON_APRIBILE`, dichiarato
     *    più su, la cui frase dice esattamente questo («non è più nell'elenco di
     *    questa postazione: ricarica la pagina o controlla la sede selezionata»). Il
     *    prefill dei prestampati usa quello.
     */

    /**
     * 503 — l'elenco da cui si sceglie il bambino (classi → alunni) non si è letto,
     * e il pannello dei prestampati non ha niente da mostrare.
     *
     * ⚠️ NON riusa `DOCUMENTI_ELENCO_NON_LETTO`, che è l'archivio dei documenti GIÀ
     * firmati: quella frase dice «l'elenco dei documenti non si è potuto caricare» e
     * qui di documenti non ce n'è ancora nessuno — chi legge starebbe cercando un
     * bambino, non un file. Il motivo per cui esiste è lo stesso: un elenco vuoto si
     * legge come «questa classe non ha bambini» ed è indistinguibile da «non ho
     * potuto guardare».
     */
    PRESTAMPATI_ELENCO_NON_LETTO: 'errorePrestampatiElencoNonLetto',
    /**
     * 404 — lo slug chiesto non è fra i diciassette del registro
     * (`src/lib/prestampati/registro.ts`).
     *
     * È il rifiuto del cancello, e non è un caso di scuola: `document_type` finisce
     * dentro `student_documents`, dentro il nome del file nel bucket e dentro
     * l'oggetto del protocollo. Una stringa scelta da chi chiama diventerebbe una
     * riga d'archivio che nessun elenco della segreteria saprà più mostrare.
     */
    PRESTAMPATO_SCONOSCIUTO: 'errorePrestampatoSconosciuto',
    /**
     * 503 — i dati del bambino (anagrafica, sezione, sede, genitori) non si sono
     * potuti leggere, quindi NON è stato generato niente.
     *
     * ⚠️ NON riusa `ALUNNO_NON_APRIBILE`, ed è la distinzione che questo repo ha già
     * pagato tre volte: «non c'è» e «non l'ho potuto leggere» hanno rimedi opposti.
     * PostgREST non lancia — ritorna `{ error }` — quindi senza un codice suo una
     * lettura fallita uscirebbe dalla porta del 404, dicendo a una segretaria che il
     * bambino che ha davanti non esiste.
     */
    PRESTAMPATO_ANAGRAFICA_NON_LETTA: 'errorePrestampatoAnagraficaNonLetta',
    /**
     * 404 — il bambino che la FAMIGLIA ha chiesto non è più in anagrafica.
     *
     * Il ramo del banco resta `ALUNNO_NON_APRIBILE`, la cui frase parla di postazione e
     * di sede selezionata: è giusta allo sportello, dove una sede si sceglie davvero, e
     * non vuol dire niente per una madre col telefono in mano — che una postazione non
     * ce l'ha e una sede non la seleziona. Non è un doppione: due platee, due rimedi
     * (ricaricare l'elenco della segreteria · scrivere alla segreteria), due frasi.
     */
    PRESTAMPATO_ALUNNO_NON_TROVATO: 'errorePrestampatoAlunnoNonTrovato',
    /**
     * 409 — su un bambino archiviato (o comunque non più iscritto) il prestampato non
     * si genera: uscirebbe con la sezione vuota e l'anno scolastico in corso addosso a
     * chi quest'anno non frequenta, cioè una dichiarazione falsa su carta intestata.
     *
     * La frase dice il rimedio — riportarlo fra gli iscritti — perché un rifiuto che
     * non dice come si sblocca è un rifiuto che torna. NON riusa
     * `SPAZIO_ALUNNO_ANCORA_ISCRITTO`, che dice l'esatto contrario e appartiene a
     * «libera spazio».
     */
    PRESTAMPATO_ALUNNO_NON_ISCRITTO: 'errorePrestampatoAlunnoNonIscritto',
    /**
     * 409 — l'anagrafica è stata anonimizzata (art. 17): nome e cognome in tabella
     * sono un segnaposto, e stamparli su un certificato sarebbe il modo peggiore di
     * rispettare una richiesta di cancellazione.
     *
     * Codice suo e non `PRESTAMPATO_ALUNNO_NON_ISCRITTO`, benché lo status coincida:
     * lì il rimedio esiste ed è a un click, qui non esiste e non esisterà mai. Mandare
     * qualcuno a «riportare fra gli iscritti» un bambino cancellato è mandarlo a
     * cercare un bottone che non c'è.
     */
    PRESTAMPATO_ALUNNO_ANONIMIZZATO: 'errorePrestampatoAlunnoAnonimizzato',
    /**
     * 422 — manca un dato che quel foglio deve riportare per avere valore: la sede del
     * bambino, gli estremi dell'autorizzazione comunale sul certificato per il Bonus
     * Asilo Nido, il livello scolastico su un certificato diretto a un ente.
     *
     * È l'unico punto in cui l'assenza di un dato NON degrada in una riga omessa, e la
     * ragione è nella specifica del n. 28: un modulo INPS con «N. ______ del ______»
     * viene respinto allo sportello, e la famiglia lo scopre in coda.
     */
    PRESTAMPATO_DATI_MANCANTI: 'errorePrestampatoDatiMancanti',
    /**
     * 500 — la composizione del PDF è fallita e NON è stato archiviato niente.
     *
     * La frase lo dice, perché è ciò che chi ha premuto deve sapere: non è rimasto un
     * documento a metà nel fascicolo del bambino. Il motivo tecnico resta nel log.
     */
    PRESTAMPATO_NON_GENERATO: 'errorePrestampatoNonGenerato',
    /**
     * 409 — il documento non si genera perché la firma non c'è o non è valida: la
     * firma OTP della famiglia non è stata raccolta, oppure manca il nome del legale
     * rappresentante che il §3b della specifica pretende sotto la dicitura del
     * D.Lgs 39/93.
     *
     * Un solo codice per i due casi, e non per pigrizia: a schermo il fatto è lo
     * stesso — «questo foglio non può uscire senza una firma» — e la differenza sta in
     * chi deve intervenire, che il log dice e la frase no. Senza questo rifiuto
     * uscirebbe un certificato con «Firma autografa sostituita a mezzo stampa» sopra
     * il vuoto, cioè un atto firmato da nessuno.
     */
    PRESTAMPATO_FIRMA_NON_VALIDA: 'errorePrestampatoFirmaNonValida',
    /**
     * 409 — un foglio che ESCE dalla scuola non ha detto che cos'è: né numero di
     * protocollo né dicitura «Copia a uso della famiglia», oppure tutte e due insieme,
     * oppure un numero su un modulo che dalla scuola non esce affatto.
     *
     * ⚠️ NON è `PRESTAMPATO_DATI_MANCANTI`, che pure avrebbe lo status vicino: quello
     * manda a completare l'anagrafica, e qui in anagrafica non manca niente — manca la
     * dichiarazione di chi genera. I due fogli si somigliano e valgono cose diverse
     * (§4.1 di `00-impaginazione.md`): senza questo rifiuto la copia che il genitore si
     * scarica da sé finisce a un ente al posto del certificato protocollato.
     */
    PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE: 'errorePrestampatoProtocolloDaDichiarare',
    /**
     * 403 — una delle sezioni indicate per l'uscita non appartiene alla sede
     * dichiarata (`teacher/uscite:POST`).
     *
     * ⚠️ NON riusa `CLASSI_FUORI_SEDE`, benché il fatto si somigli: quella frase
     * parla della «sede dell'avviso» — è nata per la bacheca — e mostrata a chi sta
     * programmando una gita manderebbe a cercare un avviso che non esiste. Il costo
     * di un codice in più è una riga; il costo di una frase che nomina la cosa
     * sbagliata lo paga chi la legge.
     */
    USCITA_CLASSE_FUORI_SEDE: 'erroreUscitaClasseFuoriSede',
    /**
     * 500 — l'uscita didattica non è stata creata, e non è rimasto niente a metà:
     * o non è riuscita la verifica di ciò che esiste già, o non è riuscita la
     * scrittura (`teacher/uscite:POST`).
     *
     * Un codice solo per i due casi, e non per pigrizia: a schermo il fatto è lo
     * stesso — la gita non c'è e il rimedio è riprovare — mentre la differenza sta
     * nel log, che dice quale delle due query è caduta e col corpo dell'errore.
     * L'operazione è idempotente, quindi «riprova» è un consiglio che non può
     * generare un doppione.
     */
    USCITA_NON_CREATA: 'erroreUscitaNonCreata',
    /**
     * 500 — non si è riusciti a leggere chi ha firmato l'autorizzazione della gita
     * (`teacher/uscite:GET` con `form_id`).
     *
     * Esiste perché il silenzio qui è peggio dell'errore: senza questo rifiuto la
     * lettura caduta darebbe «nessuno ha firmato», e il giorno dell'uscita
     * l'insegnante lascerebbe a scuola dei bambini autorizzati leggendo un elenco
     * che sembra completo.
     */
    AUTORIZZAZIONI_USCITA_NON_LETTE: 'erroreAutorizzazioniUscitaNonLette',
    /**
     * 500 — l'elenco degli alunni della sezione non si è potuto leggere, e quindi il
     * registro mensile non si stampa (`admin/registro-presenze/pdf:GET`).
     *
     * NON degrada a «nessun alunno», ed è l'unica ragione per cui non riusa
     * `REGISTRO_SEZIONE_VUOTA`: PostgREST non lancia, quindi una lettura caduta
     * lascerebbe un elenco vuoto e il PDF uscirebbe con le colonne dei giorni e
     * NESSUNA riga. Un registro senza nomi non sembra un guasto: sembra un mese in
     * cui non è venuto nessuno, e verrebbe firmato così.
     */
    REGISTRO_ALUNNI_NON_LETTI: 'erroreRegistroAlunniNonLetti',
    /**
     * 404 — la sezione esiste ma non ha alunni da stampare
     * (`admin/registro-presenze/pdf:GET`).
     *
     * È un 404 e non un PDF vuoto: un foglio con la testata, le colonne dei giorni e
     * nessuna riga è indistinguibile da un guasto, e chi lo tiene in mano non ha modo
     * di sapere quale dei due sia.
     */
    REGISTRO_SEZIONE_VUOTA: 'erroreRegistroSezioneVuota',
    /**
     * 500 — il registro mensile non è stato generato
     * (`admin/registro-presenze/pdf:GET`): la composizione del PDF o la carta
     * intestata sono fallite.
     *
     * Non si consegna il foglio nudo: senza la carta uscirebbe un registro senza il
     * marchio della scuola, senza il piede con la P.IVA e le tre sedi — cioè un
     * documento che sembra della scuola e non lo è.
     */
    REGISTRO_NON_GENERATO: 'erroreRegistroNonGenerato',
    /**
     * 401 — una porta di cron chiamata senza (o con il) `x-cron-secret` sbagliato.
     *
     * Non la legge nessun essere umano in un'interfaccia: la chiama `pg_cron`. Il
     * codice esiste lo stesso perché il lock `errori-con-codice` non ammette
     * eccezioni per destinatario, e la ragione è buona — il giorno in cui
     * qualcuno costruisce un pannello «esegui adesso» la frase c'è già, invece di
     * nascere in inglese in quel momento.
     */
    CRON_NON_AUTORIZZATO: 'erroreCronNonAutorizzato',
    /**
     * 500 — il giro giornaliero delle iscrizioni non è stato eseguito
     * (`iscrizione/import-massivo:POST`): elenchi non leggibili, lotto non preso,
     * oppure un'eccezione.
     *
     * Il motivo vero resta nel log con il codice PostgREST: farlo uscire da qui
     * significherebbe mandare il nome di una tabella a chi legge la risposta.
     */
    /**
     * 403 — il rinvio delle credenziali in blocco è della Direzione
     * (`admin/iscrizioni/rinvia-credenziali:POST`).
     *
     * Riscrive in una volta sola la password di decine di famiglie: è la stessa
     * riserva che `regenerate-credentials` applica già alle credenziali dello staff,
     * e per la stessa ragione — una password riscritta per sbaglio chiude fuori
     * qualcuno che stava lavorando, e non se ne accorge nessuno finché non telefona.
     */
    RINVIO_CREDENZIALI_RISERVATO: 'erroreRinvioCredenzialiRiservato',
    /** 500 — il registro degli inviti non si è potuto leggere. */
    REGISTRO_INVITI_NON_LETTO: 'erroreRegistroInvitiNonLetto',
    /** 500 — la sede indicata non si è potuta risolvere in un elenco di genitori. */
    RINVIO_SEDE_NON_RISOLTA: 'erroreRinvioSedeNonRisolta',
    IMPORT_ISCRIZIONI_NON_ESEGUITO: 'erroreImportIscrizioniNonEseguito',
    /** 500 — l'elenco di classe della sede non si è potuto leggere. */
    ELENCO_CLASSI_NON_LETTO: 'erroreElencoClassiNonLetto',
    /** 500 — l'elenco caricato non si è potuto salvare: il file è stato ritirato. */
    ELENCO_CLASSI_NON_SALVATO: 'erroreElencoClassiNonSalvato',
    /**
     * 415 — il file caricato non è un foglio di calcolo.
     *
     * Codice suo e non `ALLEGATO_TIPO_NON_AMMESSO`: lì si accettano immagini, PDF
     * e Word, qui SOLO `.xlsx`/`.xls`. Dire a una segretaria «sono ammessi anche i
     * PDF» le farebbe caricare un file che verrebbe respinto lo stesso.
     */
    ELENCO_CLASSI_TIPO_NON_AMMESSO: 'erroreElencoClassiTipoNonAmmesso',
    /** 413 — il foglio supera il tetto della piattaforma (4 MB). */
    ELENCO_CLASSI_TROPPO_GRANDE: 'erroreElencoClassiTroppoGrande',
    /** 400 — il file è arrivato ma non si apre come foglio di calcolo. */
    ELENCO_CLASSI_ILLEGGIBILE: 'erroreElencoClassiIlleggibile',
    /** 404 — per questa sede non c'è nessun elenco attivo da riscaricare. */
    ELENCO_CLASSI_ASSENTE: 'erroreElencoClassiAssente',

    /* ── La PASSWORD: sette rifiuti, e perché ce ne vogliono sette ─────────────
     *
     * I primi QUATTRO sono, uno per uno, i motivi di `CodiceRegolaPassword`
     * (`src/lib/auth/regole-password.ts`): stesso nome, di proposito, così la route
     * e la schermata mandano al catalogo il codice che la regola ha appena
     * restituito, senza una mappa in mezzo da tenere allineata. Il compilatore lo
     * verifica dove i due tipi si incontrano (`parent/onboarding/page.tsx`), e
     * `__tests__/components/parent-onboarding-password.test.tsx` lo misura.
     *
     * PERCHÉ ESISTONO. Fino al 2026-09-01 la schermata dell'onboarding si fermava a
     * `password.length < 8` mentre la regola condivisa ne pretende dieci con una
     * lettera e una cifra: chi ne scriveva nove passava il client e veniva respinto
     * dal server. E siccome quella pagina passa da `soloCatalogoDaCorpo` — che la
     * prosa del server non la mostra mai — il rifiuto arrivava come «Operazione non
     * riuscita. Riprova.»: una password correggibile in tre secondi, davanti a un
     * messaggio che non nomina la password. Un rifiuto che non dice che cosa
     * correggere manda l'utente a riprovare la stessa cosa.
     *
     * PERCHÉ UNO PER MOTIVO E NON UNO SOLO. Perché i rimedi sono diversi: allungare,
     * aggiungere una cifra, togliere uno spazio, sceglierne un'altra. Una frase sola
     * («password non valida») li coprirebbe tutti dicendo, ogni volta, quasi niente —
     * ed è precisamente il rifiuto opaco che la regola condivisa esiste per evitare.
     *
     * ⚠️ NESSUNA di queste frasi ripete la password, e nessuna dice quale regola è
     * stata violata *sull'ultimo tentativo di qualcun altro*: sono messaggi per chi
     * sta scegliendo la propria.
     */

    /** 400 — sotto {@link LUNGHEZZA_MINIMA_PASSWORD} caratteri. La frase porta il numero. */
    PASSWORD_TROPPO_CORTA: 'errorePasswordTroppoCorta',
    /**
     * 400 — manca una lettera **oppure** manca una cifra.
     *
     * UN codice per le due metà, e non è una scorciatoia: la policy `letters_digits`
     * di GoTrue è una regola sola, e chi la viola in un verso o nell'altro deve
     * correggere la stessa cosa. Due codici darebbero due frasi da tradurre e da
     * tenere allineate per un unico requisito.
     */
    PASSWORD_SENZA_CIFRA: 'errorePasswordSenzaCifra',
    /**
     * 400 — uno spazio a inizio o fine, di solito arrivato con un incollaggio.
     *
     * La frase lo dice esplicitamente perché è l'unico dei quattro rifiuti che
     * riguarda un carattere CHE NON SI VEDE: senza nominarlo, chi guarda il proprio
     * campo vede una password giusta e un rifiuto senza causa. `src/app/auth/login/page.tsx`
     * porta un intero secondo tentativo d'accesso per non chiudere fuori chi una
     * password così ce l'ha già dentro l'hash (difetto del 2026-08-22).
     */
    PASSWORD_CON_SPAZI_AI_BORDI: 'errorePasswordConSpaziAiBordi',
    /**
     * 400 — la nuova coincide con quella in uso.
     *
     * Dall'onboarding non può uscire (lì non c'è nessuna password precedente): serve
     * al cambio password, ed è dichiarato ADESSO perché il vocabolario della regola è
     * chiuso e completo. Dichiarare tre motivi su quattro vuol dire che il quarto,
     * il giorno in cui esce, ricade sulla frase generica — con tutto il resto verde.
     */
    PASSWORD_UGUALE_ALLA_PRECEDENTE: 'errorePasswordUgualeAllaPrecedente',
    /**
     * 400 — la password ATTUALE non verifica (cambio password: `POST /api/account/password`).
     *
     * ⚠️ Qui c'era scritto **401**, e sarebbe stato l'errore sbagliato: un 401 dice
     * «non sei autenticato» e manda a rifare il login, mentre chi arriva a questa
     * risposta la sessione ce l'ha già — l'ha dovuta esibire per passare il gate.
     * Rimandarlo al login per un campo sbagliato gli farebbe perdere anche la nuova
     * password appena scritta. La route implementa 400 (verificato nel suo test).
     *
     * NON è uno dei motivi di `valutaPasswordNuova`, che giudica solo la nuova: qui
     * l'utente ha sbagliato a riscrivere quella che sta già usando. Riusare
     * `PASSWORD_UGUALE_ALLA_PRECEDENTE` — l'unico altro codice che nomina la password
     * di prima — direbbe l'esatto contrario di ciò che è successo, e manderebbe a
     * cambiare il campo sbagliato.
     */
    PASSWORD_ATTUALE_ERRATA: 'errorePasswordAttualeErrata',
    /**
     * 400 — GoTrue ha respinto la password (4xx) per una ragione che le nostre regole
     * non prevedono: password nota alle liste di violazione, utente sospeso, policy
     * del provider cambiata sotto di noi.
     *
     * NON riusa i quattro codici della regola, e la differenza è tutta nel rimedio:
     * quelli dicono che cosa correggere, questo può solo dire «sceglierne un'altra» —
     * perché il motivo vero lo conosce il provider, e sta nel log (mai a schermo: il
     * corpo di GoTrue è prosa inglese, ed è esattamente ciò che i codici hanno tolto
     * dall'interfaccia).
     */
    PASSWORD_RIFIUTATA: 'errorePasswordRifiutata',
    /**
     * 500 — GoTrue non ha potuto scrivere (5xx): guasto suo, non della password.
     *
     * NON riusa `PASSWORD_RIFIUTATA`: quella frase manda a sceglierne un'altra, cioè
     * a rifare un lavoro che non era sbagliato, e lascia credere che il problema sia
     * la password appena pensata. Qui il rimedio è riprovare, e c'è una cosa che chi
     * legge deve sapere e nessun'altra frase dice: **la password di prima è ancora
     * valida**. Senza, resta il dubbio peggiore — di essere rimasto fuori.
     */
    PASSWORD_NON_SCRITTA: 'errorePasswordNonScritta',
    /* ⚠️ Il tetto di frequenza dei tentativi NON prende un codice nuovo: è già
     * `TROPPE_RICHIESTE`, dichiarato più in alto in questo stesso file e tradotto
     * nelle due lingue. Un `PASSWORD_TROPPE_RICHIESTE` accanto direbbe la stessa
     * cosa con un'altra frase da tenere allineata — che è il modo in cui questo
     * elenco ha già prodotto un codice riusato per sbaglio (vedi
     * `NEWS_FILE_SOSTITUITI_NON_RIMOSSI`). Chi scriverà `POST /api/account/password`
     * usi quello. */
} as const;

export type CodiceErrore = keyof typeof CODICI_ERRORE;

/**
 * I codici la cui PROSA porta un dettaglio che la frase tradotta non può avere:
 * per questi il testo a schermo è «frase di catalogo — prosa del server».
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Fino al 2026-08-01 `messaggioErrore`, appena trovava un codice, restituiva il
 * testo di catalogo e **buttava via** l'`error` — mentre la documentazione di
 * `CLASSI_FUORI_SEDE` (qui sopra) prometteva l'esatto contrario. Codice e
 * commento dicevano due cose diverse, e a perderci era l'operatore: l'avviso
 * veniva rifiutato con «alcune classi destinatarie non appartengono alla sede»,
 * e QUALI — l'unica informazione che dice che cosa correggere — non arrivava
 * mai a schermo.
 *
 * ─── PERCHÉ UN ELENCO, E NON «SEMPRE LA PROSA» ──────────────────────────────
 *
 * Perché i codici sono nati proprio per NON mostrarla: la prosa nasce sul
 * server, dove il locale non esiste, ed è quella che faceva leggere a una
 * segretaria in interfaccia inglese «Specificare la sede (scuola_id) per questa
 * operazione». Riappenderla a tutti riaprirebbe il difetto che i codici hanno
 * chiuso. L'aggiunta si DICHIARA, un codice per volta, e solo quando il server
 * mette lì dentro un dato che il catalogo non può conoscere.
 *
 * LIMITE RESIDUO, dichiarato invece che nascosto: il dettaglio resta nella
 * lingua del server. Per `CLASSI_FUORI_SEDE` è quasi tutto nomi di classi
 * («3 ANNI A»), che non si traducono; il contorno sì. Si chiude quando il
 * server manderà l'elenco in un campo suo invece che dentro la frase — allora
 * qui si comporrà «frase tradotta + elenco» e la coda italiana sparirà.
 */
export const CODICI_CON_DETTAGLIO: ReadonlySet<CodiceErrore> = new Set<CodiceErrore>([
    'CLASSI_FUORI_SEDE',
]);

const CATALOGHI: Record<Locale, Record<string, string>> = {
    it: it as Record<string, string>,
    en: en as Record<string, string>,
};

/**
 * La lingua dell'interfaccia, letta dal documento. Fuori dal browser (test in
 * ambiente `node`, render sul server) e per qualunque valore non previsto:
 * italiano, che è il default dichiarato dell'app.
 *
 * Si guarda il SOTTOTAG di base perché `lang` potrebbe un giorno diventare
 * BCP47 completo (`en-GB`: la regione è già decisa in `@/i18n/config`, e la
 * distanza fra le due cose è una riga di `RootLayout`). Oggi vale `en` —
 * verificato sul server di sviluppo, `Cookie: KV_LOCALE=en` → `<html lang="en">`
 * — ma un giorno in cui quella riga cambia e questa no sarebbe un giorno in cui
 * tutti gli errori tornano italiani senza che nulla diventi rosso.
 */
function linguaCorrente(): Locale {
    if (typeof document === 'undefined') return DEFAULT_LOCALE;
    const lang = document.documentElement.getAttribute('lang');
    const base = (lang ?? '').split('-')[0];
    return isLocale(base) ? base : DEFAULT_LOCALE;
}

/** Il testo di catalogo di un codice, o `null` se il codice non è dichiarato. */
function testoDelCodice(codice: unknown): string | null {
    if (typeof codice !== 'string') return null;
    const chiave = (CODICI_ERRORE as Record<string, string>)[codice];
    if (!chiave) return null;
    // Se la chiave manca dal catalogo si torna `null` e si ricade sulla prosa:
    // mostrare `erroreSedeNonAccessibile` all'utente sarebbe peggio dell'italiano.
    const testo = CATALOGHI[linguaCorrente()][chiave];
    return typeof testo === 'string' && testo.trim() !== '' ? testo : null;
}

/** Il codice porta un dettaglio che la frase tradotta non può avere? */
function portaDettaglio(codice: unknown): boolean {
    return typeof codice === 'string' && CODICI_CON_DETTAGLIO.has(codice as CodiceErrore);
}

/**
 * Il testo da mostrare, a partire dal CORPO già letto.
 *
 * ─── PERCHÉ È ESPORTATA ─────────────────────────────────────────────────────
 * Un corpo si legge UNA volta sola: `res.json()` consuma lo stream. Qualche
 * chiamante ha bisogno del corpo anche per altro — la galleria docente legge
 * `nomi` dal 422 del Privacy Lock, per dire all'insegnante QUALI bambini
 * togliere dai tag — e con la sola `messaggioErrore(res, …)` dovrebbe leggerlo
 * due volte (impossibile) o rinunciare alla traduzione e ricadere sulla prosa
 * italiana del server: cioè esattamente il difetto che i codici hanno chiuso.
 *
 * La logica «codice → catalogo, altrimenti prosa, altrimenti ripiego» resta in
 * UN posto solo: `messaggioErrore` è il guscio che legge la risposta, questa è
 * la decisione. Se domani nasce un terzo modo di ottenere il corpo, passerà
 * comunque di qui.
 */
export function messaggioDaCorpo(corpoGrezzo: unknown, fallback: string): string {
    const corpo = corpoGrezzo as { error?: unknown; codice?: unknown } | null;
    const msg = corpo?.error;
    const prosa = typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : null;
    const tradotto = testoDelCodice(corpo?.codice);
    if (tradotto) {
        // La prosa si aggiunge SOLO per i codici dichiarati in
        // `CODICI_CON_DETTAGLIO`, e solo se dice qualcosa in più: quando
        // coincide col testo di catalogo (interfaccia italiana, frasi
        // gemelle) ripeterla sarebbe rumore.
        if (prosa && prosa !== tradotto && portaDettaglio(corpo?.codice)) {
            return `${tradotto} — ${prosa}`;
        }
        return tradotto;
    }
    return prosa ?? fallback;
}

export async function messaggioErrore(res: Response, fallback: string): Promise<string> {
    try {
        return messaggioDaCorpo(await res.json(), fallback);
    } catch {
        return fallback;
    }
}

/**
 * Come sopra, ma **senza il ripiego sulla prosa del server**: o il testo del
 * catalogo (codice dichiarato), o il `fallback` di chi chiama.
 *
 * ─── PERCHÉ ESISTE UNA SECONDA REGOLA ───────────────────────────────────────
 *
 * `messaggioDaCorpo` mostra la prosa del server quando non riconosce un codice,
 * e per il cockpit è la scelta giusta: quelle frasi sono scritte per chi opera
 * («alcune classi destinatarie non appartengono alla sede»), e perderle
 * significherebbe sostituire il motivo vero con una frase generica.
 *
 * Le schermate delle FAMIGLIE non hanno lo stesso corpo di errori. Su
 * `POST /api/segnalazioni` — i due soli chiamanti di questa funzione — la prosa
 * che il server può mandare comprende «oggetto_id obbligatorio per questo tipo
 * di segnalazione» e «segnalato_id obbligatorio…»: testo scritto per chi legge i
 * log, con il nome di un campo del corpo dentro, e italiano per costruzione.
 * Mostrarlo a un genitore con l'interfaccia in inglese sarebbe **esattamente**
 * il fallimento F2 del collaudo del 2026-07-31 («Specificare la sede
 * (scuola_id) per questa operazione» dentro una modale inglese), riaperto in una
 * schermata nuova.
 *
 * Quindi qui il ripiego non è la prosa ma la frase del componente, che è già
 * tradotta perché passa da `useTranslations`. Il codice dichiarato continua a
 * vincere — è il solo modo che ha il server di farsi capire in due lingue — e
 * quando non c'è, chi guarda legge la frase generica invece di un pezzo di
 * documentazione interna.
 *
 * NON è una scorciatoia per non dichiarare i codici: quando una di quelle
 * risposte meriterà un messaggio suo, la strada resta aggiungere il codice in
 * `CODICI_ERRORE` e le due traduzioni.
 */
export async function messaggioSoloCatalogo(res: Response, fallback: string): Promise<string> {
    try {
        return soloCatalogoDaCorpo(await res.json(), fallback);
    } catch {
        return fallback;
    }
}

/**
 * La regola di `messaggioSoloCatalogo` applicata a un corpo GIÀ letto — codice
 * dichiarato → catalogo, tutto il resto → la frase del componente.
 *
 * ─── PERCHÉ SERVE ANCHE QUESTA FORMA ────────────────────────────────────────
 *
 * Perché `res.json()` consuma lo stream, e nelle schermate delle famiglie il
 * corpo serve quasi sempre ANCHE per altro: la modulistica legge `email`,
 * `expiry`, `ticket` e `signature_log` dalla stessa risposta da cui deve
 * ricavare il messaggio d'errore; il modulo pubblico legge `campi` per riportare
 * l'utente sul campo sbagliato. Con la sola `messaggioSoloCatalogo` quei punti
 * dovrebbero leggere il corpo due volte (impossibile) o rinunciare alla
 * traduzione — cioè ricadere sulla prosa italiana del server, che è esattamente
 * il difetto T10-F1.
 *
 * Sta a `messaggioSoloCatalogo` come `messaggioDaCorpo` sta a `messaggioErrore`:
 * il guscio legge la risposta, la decisione vive in un posto solo. Se domani la
 * regola cambia — un nuovo ripiego, un secondo campo del corpo — cambia qui, e
 * cambia per tutte e due le strade.
 */
export function soloCatalogoDaCorpo(corpoGrezzo: unknown, fallback: string): string {
    const corpo = corpoGrezzo as { codice?: unknown } | null;
    return testoDelCodice(corpo?.codice) ?? fallback;
}

/** Ciò che si sa di una risposta di ERRORE dopo averla letta senza mai lanciare. */
export interface EsitoErrore {
    /** Il testo da mostrare: catalogo se il codice è dichiarato, altrimenti il `fallback`. */
    testo: string;
    /** Il codice dichiarato dal server, se c'è ed è una stringa. Altrimenti `null`. */
    codice: string | null;
    /**
     * Lo status HTTP. `undefined` solo se la risposta non ne ha uno leggibile (un oggetto
     * costruito a mano nei test): **non** si ripiega su `0`, che in tabella somiglia a un
     * codice HTTP vero e mentirebbe.
     */
    stato: number | undefined;
    /**
     * `false` quando il corpo non era JSON leggibile (500 senza corpo, HTML di un proxy,
     * risposta troncata). Serve a chi LOGGA: «il server ha rifiutato dicendo perché» e «il
     * server è morto senza dire niente» sono due fatti diversi e vanno detti in modo diverso.
     */
    corpoLetto: boolean;
}

/**
 * Legge una risposta di errore SENZA MAI LANCIARE, e senza perdere lo status.
 *
 * ─── PERCHÉ ESISTE (R17 del quinto collaudo) ────────────────────────────────
 *
 * La forma ripetuta in quattro punti su due schermate era:
 *
 *     if (!r.ok) { const corpo = await r.json(); … segnala('invio-respinto', r.status) }
 *
 * e presuppone che ogni risposta d'errore porti un corpo JSON. È vero per i rifiuti che la
 * rotta scrive di suo pugno; NON per gli errori che nascono FUORI dall'handler — il 500 di
 * Next quando l'handler non restituisce una Response (misurato: `Transfer-Encoding: chunked`
 * e ZERO byte), il 502/504 di un proxy, una risposta troncata. In quei casi `await r.json()`
 * lancia dentro il `try`, l'eccezione salta al `catch` esterno — che è scritto per un'altra
 * cosa, la RETE CADUTA — e il numero di stato, che il codice aveva in mano un istante prima,
 * viene buttato via prima di arrivare al log.
 *
 * Conseguenza misurata: a schermo il messaggio del ramo sbagliato («non sappiamo se l'assenza
 * è stata registrata», mentre il server aveva risposto eccome) e in `app_log` una riga
 * `invio-non-riuscito` con `stato` indefinito. Chi indaga dal log non sa nemmeno che il
 * server ha risposto.
 *
 * È il rovescio esatto della regola che il repo si è già dato per i provider esterni
 * («loggare uno status senza il corpo è il bug»): qui lo status si perde perché il corpo non
 * si è potuto leggere. Le due metà dell'informazione vanno tenute insieme.
 *
 * ─── PERCHÉ QUI E NON NEI COMPONENTI ────────────────────────────────────────
 *
 * Perché la stessa forma vive su due schermate («Comunica un'assenza» dell'infanzia e quella
 * della primaria) e in due gesti ciascuna (invio e annullamento). Una regola valida per due
 * strade deve vivere in un posto solo: è la lezione che questo ciclo ripete da tre giri, e
 * l'unico modo perché la prossima schermata la erediti invece di doverla riscoprire.
 *
 * Il `catch` esterno del chiamante NON sparisce: resta per la rete davvero caduta (`fetch`
 * che rigetta), che è un fatto diverso — lì il server non ha risposto affatto, e non si sa
 * se la scrittura è avvenuta.
 */
export async function erroreDaRisposta(res: Response, fallback: string): Promise<EsitoErrore> {
    const stato = statoDi(res);
    let corpo: unknown;
    let corpoLetto = false;
    try {
        corpo = await res.json();
        corpoLetto = true;
    } catch {
        // Corpo assente, troncato o non JSON. Non è un caso da segnalare qui: è
        // un'informazione da restituire (`corpoLetto: false`), perché chi chiama è l'unico
        // che sa quale operazione stava facendo e quindi come raccontarlo.
        corpo = null;
    }
    const codice = (corpo as { codice?: unknown } | null)?.codice;
    return {
        testo: soloCatalogoDaCorpo(corpo, fallback),
        codice: typeof codice === 'string' ? codice : null,
        stato,
        corpoLetto,
    };
}

/** Lo status, letto in modo difensivo: `res` è una `Response` solo per contratto. */
function statoDi(res: unknown): number | undefined {
    try {
        const s = (res as { status?: unknown } | null | undefined)?.status;
        return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
    } catch {
        return undefined;
    }
}
