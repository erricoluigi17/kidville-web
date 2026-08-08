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
