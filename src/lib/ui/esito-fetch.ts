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
