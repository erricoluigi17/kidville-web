import { CHIAVI_MESSAGGIO_VIDEO } from '@/lib/media/video/contratto';
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
    /**
     * I QUATTORDICI CODICI DELLA PIPELINE VIDEO, innestati invece che ribattuti.
     *
     * `src/lib/media/video/contratto.ts` li dichiara insieme alla mappa che li ricava dai
     * sessantadue codici INTERNI della pipeline. Una seconda copia qui divergerebbe dalla
     * prima il giorno in cui `verifyVideoOutput` aggiunge un ramo o una RPC un `code` — ed
     * è il modo in cui un catalogo smette di dire la verità senza che nessun test lo noti.
     *
     * \u26a0\ufe0f PERCHE' LO SPREAD STA IN TESTA E NON IN FONDO, che è dove verrebbe naturale
     * metterlo: `CHIAVI_MESSAGGIO_VIDEO` contiene anche `SEDE_DA_SPECIFICARE` —
     * deliberatamente, perché i video non inventino un secondo diniego di sede accanto a
     * quello che `rifiutoSede` manda già da 137 route. In fondo all'oggetto quella chiave
     * sovrascriverebbe la voce esplicita qui sotto, e `tsc` lo dice con un TS2783
     * («specified more than once, so this usage will be overwritten»).
     *
     * Misurato, non previsto — e la parte che conta è che ESLINT TACE: `no-dupe-keys`
     * guarda le chiavi letterali, non gli spread. In fondo, il difetto lo prenderebbe solo
     * il typecheck. In testa l'ordine si rovescia e a vincere è la riga esplicita, che è
     * quella giusta.
     */
    ...CHIAVI_MESSAGGIO_VIDEO,
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
     * 409 — si sta correggendo l'orario di un appello che non è stato ancora fatto
     * (`PATCH /api/attendance/daily`). Un orario senza una presenza registrata non
     * significa niente, e la porta non inventa la riga: dice al docente di segnare
     * prima se il bambino c'è.
     */
    APPELLO_NON_REGISTRATO: 'erroreAppelloNonRegistrato',
    /**
     * 422 — l'orario non sta insieme allo stato registrato: un'entrata su un
     * assente, un'uscita anticipata su un presente. Non è un errore di forma (per
     * quello c'è zod): è un'incoerenza che si vede solo avendo letto la riga.
     */
    ORARIO_INCOERENTE: 'erroreOrarioIncoerente',
    /**
     * I QUATTRO RIFIUTI DELL'ANNULLAMENTO DELL'APPELLO (`DELETE /api/attendance/daily`,
     * libreria `@/lib/presenze/annulla-appello`, condivisa con la primaria).
     *  · 409 — l'appello si annulla solo nel giorno stesso, in data di Roma;
     *  · 404 — per quel bambino, quel giorno, non c'è nessuna presenza;
     *  · 409 — c'è solo la comunicazione del genitore: l'appello non è mai stato fatto;
     *  · 409 — la riga è cambiata fra lettura e scrittura (il genitore ha comunicato
     *    nel frattempo): nessuna riga toccata, si ricarica.
     */
    APPELLO_ANNULLA_SOLO_OGGI: 'erroreAppelloAnnullaSoloOggi',
    PRESENZA_NON_TROVATA: 'errorePresenzaNonTrovata',
    NIENTE_DA_ANNULLARE: 'erroreNienteDaAnnullare',
    APPELLO_CAMBIATO_NEL_FRATTEMPO: 'erroreAppelloCambiatoNelFrattempo',
    /**
     * 500 — l'annullamento dell'appello (`DELETE /api/attendance/daily` e
     * `DELETE /api/primaria/appello`, risposta unica in
     * `@/lib/presenze/annulla-appello-risposta`) non è riuscito per un guasto. Il `message` di PostgREST resta
     * nel log; al docente si dice che niente è cambiato e che può riprovare.
     */
    APPELLO_NON_ANNULLATO: 'erroreAppelloNonAnnullato',
    /**
     * I RIFIUTI DI «ANNULLA PRESA VISIONE» della giustifica, primaria
     * (`DELETE /api/primaria/presenze/giust-vista`, spec 2026-09-24 punto 2):
     *  · 404 — la presenza non esiste (più);
     *  · 409 — non c'è nessuna presa visione da annullare;
     *  · 403 — l'ha presa un altro docente: la annulla lui, o Segreteria/Direzione;
     *  · 409 — la presa visione è cambiata fra lettura e scrittura: nessuna riga toccata;
     *  · 500 — guasto di lettura o scrittura: il `message` resta nel log.
     */
    PRESA_VISIONE_PRESENZA_NON_TROVATA: 'errorePresaVisionePresenzaNonTrovata',
    PRESA_VISIONE_ASSENTE: 'errorePresaVisioneAssente',
    PRESA_VISIONE_NON_TUA: 'errorePresaVisioneNonTua',
    PRESA_VISIONE_CAMBIATA: 'errorePresaVisioneCambiata',
    PRESA_VISIONE_NON_ANNULLATA: 'errorePresaVisioneNonAnnullata',
    /**
     * 403 — non si può APRIRE una conversazione fra queste due persone su questo
     * bambino: il docente non è della sua sezione, o non è più in servizio, o lo
     * staff è di un altro plesso (`@/lib/chat/rubrica`). Vale sulla porta, non
     * sui thread già aperti.
     */
    CHAT_ABBINAMENTO_NON_CONSENTITO: 'erroreChatAbbinamentoNonConsentito',
    /**
     * 500 — la verifica di cui sopra non si è POTUTA fare (una lettura è
     * fallita). Deliberatamente distinto dal 403: negare su un guasto vorrebbe
     * dire dire a una famiglia «questa non è la tua insegnante» perché una query
     * è andata storta.
     */
    CHAT_ABBINAMENTO_NON_VERIFICATO: 'erroreChatAbbinamentoNonVerificato',
    /** 500 — la conversazione non si è potuta aprire, per un guasto del database. */
    CHAT_THREAD_NON_CREATO: 'erroreChatThreadNonCreato',
    /**
     * 503 — la lettura di vigilanza su una conversazione altrui non si è POTUTA
     * registrare, e allora il contenuto non esce. La supervisione è silenziosa
     * per scelta (i due interlocutori non vedono nulla): la riga di registro è
     * l'unico contrappeso, e una lettura non tracciata è esattamente la cosa che
     * non deve poter accadere. Distinto da un 500: non è la lettura ad essere
     * fallita, è la sua traccia.
     */
    VIGILANZA_NON_TRACCIABILE: 'erroreVigilanzaNonTracciabile',
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
     * 400 — l'import di una domanda d'iscrizione senza la retta di un bambino.
     *
     * Non è un campo dimenticato: fino al 2026-09-02 la retta non veniva chiesta
     * affatto, e il bambino nasceva a `0` — che il generatore rilegge come «usa il
     * default di sede», cioè 150 €/mese decisi da nessuno. Quaranta alunni veri
     * erano in quello stato. La frase dice la CONSEGUENZA, non «campo obbligatorio».
     */
    RETTA_MANCANTE: 'erroreRettaMancante',
    /**
     * 400 — retta scritta come zero.
     *
     * Lo zero è il valore che si digita naturalmente per dire «non paga», ed è
     * proprio quello che sulla colonna significa il contrario. La prova che senza
     * spiegazione la gente trova un ripiego: sei bambini in produzione avevano la
     * retta a **0,01 €**.
     */
    RETTA_ZERO: 'erroreRettaZero',
    /** 400 — «la paga il fratello», ma il fratello indicato non è di questa domanda. */
    RETTA_FRATELLO_NON_VALIDO: 'erroreRettaFratelloNonValido',
    /**
     * 400 — «la paga il fratello» dall'ANAGRAFICA, e il bambino indicato non va bene.
     *
     * Codice distinto da `RETTA_FRATELLO_NON_VALIDO` di proposito: là il fatto è
     * «non è fra i bambini di questa domanda», qui è «non è un iscritto della stessa
     * sede». Riusare il codice dell'import darebbe alla segreteria una frase che
     * parla di una domanda d'iscrizione che non ha davanti — un messaggio sbagliato
     * con l'aria di essere a posto.
     *
     * Il testo NON dice quale delle quattro condizioni è caduta (non esiste, altra
     * sede, ritirato, archiviato): la tendina la disegna l'interfaccia, e dettagliare
     * racconterebbe l'anagrafica di un minore a chi potrebbe non avere titolo.
     */
    RETTA_FRATELLO_NON_DISPONIBILE: 'erroreRettaFratelloNonDisponibile',
    /**
     * 409 — il legame «paga il fratello» formerebbe una CATENA o un ANELLO.
     *
     * 🔴 Non è teorico. Misurato a Giugliano il 2026-09-04: un bambino con retta
     * 250 € marcato a carico di un fratello che aveva 0,01 €. Entrambe le strade che
     * generano le rette saltano chi è a carico di un altro, quindi la famiglia è
     * stata addebitata di UN CENTESIMO per settembre 2026 — nove mesi così sono 2.250 €
     * che nessuno avrebbe mai chiesto, e nessun errore da nessuna parte.
     *
     * Porta il DETTAGLIO: «il fratello è a sua volta a carico di un altro» e «questo
     * bambino paga già per qualcuno» sono due situazioni diverse, e chi deve
     * districarle ha bisogno di sapere quale delle due ha davanti.
     */
    RETTA_CICLO_FRATELLI: 'erroreRettaCicloFratelli',
    /** 400 — il fratello indicato non paga a sua volta: la catena non finisce mai. */
    RETTA_FRATELLO_SENZA_CIFRA: 'erroreRettaFratelloSenzaCifra',
    /** 400 — l'adulto scelto per le fatture non è fra quelli della domanda. */
    INTESTATARIO_NON_VALIDO: 'erroreIntestatarioNonValido',
    /**
     * Import di una domanda — il BAMBINO GEMELLO (2026-09-14): in sede c'è già un
     * bambino con lo stesso nome e la stessa data di nascita, ma un codice fiscale
     * diverso. Viaggia dentro `errors[]` della risposta (non da solo come corpo
     * d'errore), e il pannello risponde offrendo «usa la scheda esistente».
     *
     * Misurato quel giorno: sette coppie di alunni doppi nella stessa sede, codici
     * diversi per UN carattere. L'import riconosceva solo il codice identico.
     */
    POSSIBILE_DOPPIONE: 'errorePossibileDoppione',
    /**
     * 400 / bloccante — l'abbinamento a una scheda esistente («è lo stesso bambino»)
     * non si può onorare: il bambino non è nella domanda, oppure l'uuid scelto dal
     * client non è fra i gemelli che il server trova, o è fuori scope. Si ferma tutto
     * invece di proseguire: proseguire creerebbe proprio l'alunno doppio che la
     * segreteria ha appena detto di non volere.
     */
    ABBINAMENTO_NON_VALIDO: 'erroreAbbinamentoNonValido',
    /**
     * 409 — si è scelto un intestatario per un pagamento RIPARTITO fra due genitori.
     *
     * Non si scavalca la ripartizione, e non è prudenza: con i genitori separati la
     * ripartizione esiste perché ciascuno riceva un documento per la propria quota, e
     * la detrazione si porta sulla fattura intestata a chi ha pagato. Un documento
     * unico cancella la detrazione dell'altro genitore. La via d'uscita esiste — si
     * modificano le quote del pagamento — e il messaggio la nomina.
     */
    INTESTATARIO_IN_CONFLITTO_CON_QUOTE: 'erroreIntestatarioInConflittoConQuote',
    /**
     * 409 — questo pagamento ha già una fattura VIVA, e l'intestatario non è quello.
     *
     * 🔴 È la guardia che impedisce una SECONDA fattura vera per la stessa retta:
     * l'idempotenza confronta `quota_adult_id`, quindi emettere per il genitore A e
     * poi scegliere B non trovava nessuna riga corrispondente. Misurato il 2026-09-04:
     * il database non la ferma — l'indice unico ha `quota_adult_id` nella chiave, e
     * l'INSERT arriva comunque dopo l'upload. La guardia di codice è l'unica difesa.
     */
    FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO: 'erroreFatturaGiaEmessaAltroIntestatario',
    /**
     * 422 — l'adulto scelto come intestatario non è un genitore di quel bambino.
     *
     * Non protegge da un operatore che vuole sbagliare (col ramo «altra persona» si
     * digita chiunque): protegge da un BUG DEL CLIENT — il modale che rimanda
     * l'`adult_id` del pagamento precedente — che farebbe partire una fattura col
     * codice fiscale e la residenza di un'altra famiglia. Codice distinto da
     * `INTESTATARIO_NON_VALIDO` di proposito: quello parla di «questa domanda»
     * d'iscrizione, che qui la segreteria non ha davanti.
     */
    INTESTATARIO_NON_DEL_BAMBINO: 'erroreIntestatarioNonDelBambino',
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
     * (`GET /api/parent/presenze`: anagrafica, appello di oggi, riepilogo;
     * `GET /api/primaria/appello`: alunni e presenze della classe, da cui dipende
     * anche `appello_fatto` — un 200 con righe vuote mostrerebbe un appello mai fatto).
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
     * PRIMARIA — modifica ed eliminazione delle voci (`src/lib/primaria/permesso-voce.ts`).
     * 403: la voce è di un altro docente. 423: oltre il termine, serve lo sblocco della
     * Direzione (`/api/primaria/sblocca`).
     */
    VOCE_NON_AUTORE: 'erroreVoceNonAutore',
    VOCE_BLOCCATA: 'erroreVoceBloccata',
    /**
     * PRIMARIA — note disciplinari (`/api/primaria/note`, PATCH/DELETE).
     * 404: la nota (o il suo gruppo) non c'è più. 500: scrittura non riuscita.
     */
    NOTA_NON_TROVATA: 'erroreNotaNonTrovata',
    NOTA_OPERAZIONE_NON_RIUSCITA: 'erroreNotaOperazioneNonRiuscita',
    /**
     * 409: firma o allegato vivo (non nel cestino) con `registro_id` NULL.
     * Un allegato nel cestino è 404 `SBLOCCO_VOCE_NON_TROVATA`.
     */
    VOCE_SENZA_LEZIONE: 'erroreVoceSenzaLezione',
    /**
     * PRIMARIA — modifica (PATCH) ed eliminazione (DELETE) di una valutazione
     * (`/api/primaria/valutazioni`). 404: la voce non c'è più (eliminata nel frattempo).
     * 500: scrittura non riuscita; `…_OBIETTIVI_NON_AGGIORNATI` = il giudizio è salvato
     * ma i collegamenti agli obiettivi no (riprovare completa). 400: gli stessi rifiuti
     * della POST, con il codice.
     */
    VALUTAZIONE_NON_TROVATA: 'erroreValutazioneNonTrovata',
    VALUTAZIONE_NON_SALVATA: 'erroreValutazioneNonSalvata',
    VALUTAZIONE_NON_ELIMINATA: 'erroreValutazioneNonEliminata',
    VALUTAZIONE_OBIETTIVI_NON_AGGIORNATI: 'erroreValutazioneObiettiviNonAggiornati',
    VALUTAZIONE_ANNOTAZIONE_NON_VALIDA: 'erroreValutazioneAnnotazioneNonValida',
    VALUTAZIONE_OBIETTIVO_MANCANTE: 'erroreValutazioneObiettivoMancante',
    VALUTAZIONE_OBIETTIVO_NON_VALIDO: 'erroreValutazioneObiettivoNonValido',
    /** 404/500/503 di `/api/primaria/sblocca`: voce inesistente, audit non scritto, schema non migrato. */
    SBLOCCO_VOCE_NON_TROVATA: 'erroreSbloccoVoceNonTrovata',
    SBLOCCO_NON_REGISTRATO: 'erroreSbloccoNonRegistrato',
    SBLOCCO_NON_DISPONIBILE: 'erroreSbloccoNonDisponibile',
    /**
     * Impreparato dichiarato dal GENITORE (`PATCH`/`DELETE /api/parent/giustifiche-didattiche`).
     * 404: la dichiarazione non c'è o non è sua; 409: il giorno dichiarato è passato (o la
     * nuova data è nel passato), in data di Roma; 400: materia di un'altra classe; 500: la
     * scrittura non è riuscita. Gli stessi 404/400/500 li usa anche la route del DOCENTE
     * (`/api/primaria/giustifiche-didattiche`, compito V2), anche per l'eliminazione: per
     * questo le frasi in catalogo sono neutre («impreparato», «operazione»).
     */
    IMPREPARATO_NON_TROVATO: 'erroreImpreparatoNonTrovato',
    IMPREPARATO_DATA_PASSATA: 'erroreImpreparatoDataPassata',
    IMPREPARATO_MATERIA_NON_VALIDA: 'erroreImpreparatoMateriaNonValida',
    IMPREPARATO_NON_SALVATO: 'erroreImpreparatoNonSalvato',
    /**
     * `PATCH /api/primaria/giustifiche-didattiche` (compito V2): 400 quando si chiede il tipo
     * «impreparato» su una dichiarazione del GENITORE, che resta sempre «giustificato».
     */
    IMPREPARATO_TIPO_GENITORE: 'erroreImpreparatoTipoGenitore',
    /**
     * Allegati del registro della primaria (compito R2: `primaria/allegati`,
     * `…/sostituisci`, `…/cestino`). 400 formato o dimensione (PDF fino a 10 MB, immagini
     * fino a 3 MB); 404 allegato vivo che non c'è; 409 eliminato o sostituito nel
     * frattempo, non più nel cestino, oltre i giorni di custodia, oppure lezione eliminata
     * e non ancora rifirmata nello stesso slot (`LEZIONE_DA_RIFIRMARE`); 500 scrittura non
     * riuscita; 503 DB non migrato (il cestino non c'è: niente è cambiato).
     */
    ALLEGATO_REGISTRO_FORMATO_NON_AMMESSO: 'erroreAllegatoRegistroFormatoNonAmmesso',
    ALLEGATO_REGISTRO_TROPPO_GRANDE: 'erroreAllegatoRegistroTroppoGrande',
    ALLEGATO_REGISTRO_NON_TROVATO: 'erroreAllegatoRegistroNonTrovato',
    ALLEGATO_REGISTRO_CAMBIATO: 'erroreAllegatoRegistroCambiato',
    ALLEGATO_REGISTRO_NON_NEL_CESTINO: 'erroreAllegatoRegistroNonNelCestino',
    ALLEGATO_REGISTRO_CESTINO_SCADUTO: 'erroreAllegatoRegistroCestinoScaduto',
    /**
     * 409 del ripristino: l'allegato è oltre il termine di CONSERVAZIONE del registro
     * (decisione del titolare del 2026-09-25, contato dal caricamento), cestino o no.
     */
    ALLEGATO_REGISTRO_CONSERVAZIONE_SCADUTA: 'erroreAllegatoRegistroConservazioneScaduta',
    ALLEGATO_REGISTRO_SCRITTURA_FALLITA: 'erroreAllegatoRegistroScritturaFallita',
    ALLEGATO_REGISTRO_CESTINO_NON_DISPONIBILE: 'erroreAllegatoRegistroCestinoNonDisponibile',
    LEZIONE_DA_RIFIRMARE: 'erroreLezioneDaRifirmare',
    /**
     * `DELETE /api/primaria/registro` — la propria firma (`?firmaId=`) o la lezione
     * intera (`?registroId=`). 404 firma/lezione che non c'è; 403 lezione intera
     * chiesta da chi non è Segreteria o Direzione; 500 eliminazione non riuscita
     * (la frase non promette «non è cambiato niente»: manda a ricaricare); 503 DB
     * non migrato con allegati da mettere nel cestino (la lezione resta).
     */
    FIRMA_NON_TROVATA: 'erroreFirmaNonTrovata',
    LEZIONE_NON_TROVATA: 'erroreLezioneNonTrovata',
    LEZIONE_ELIMINA_SOLO_STAFF: 'erroreLezioneEliminaSoloStaff',
    REGISTRO_NON_ELIMINATO: 'erroreRegistroNonEliminato',
    REGISTRO_CESTINO_NON_DISPONIBILE: 'erroreRegistroCestinoNonDisponibile',
    /**
     * `/api/primaria/scrutinio/riapri` (Segreteria e Direzione). 404: lo scrutinio non c'è;
     * 409: non è chiuso (o un'altra riapertura è passata prima); 500: un passo non è riuscito —
     * lo scrutinio resta chiuso e la richiesta si può ripetere.
     */
    SCRUTINIO_RIAPERTURA_NON_TROVATO: 'erroreScrutinioRiaperturaNonTrovato',
    SCRUTINIO_RIAPERTURA_NON_CHIUSO: 'erroreScrutinioRiaperturaNonChiuso',
    SCRUTINIO_RIAPERTURA_NON_RIUSCITA: 'erroreScrutinioRiaperturaNonRiuscita',
    /**
     * `DELETE /api/primaria/pagella` (Segreteria e Direzione): una sola pagella. 404: lo
     * scrutinio non c'è, oppure non c'è né la riga né il PDF di quell'alunno; 500: un passo
     * non è riuscito — la richiesta si può ripetere (file prima, riga poi).
     */
    PAGELLA_ELIMINAZIONE_SCRUTINIO_NON_TROVATO: 'errorePagellaEliminazioneScrutinioNonTrovato',
    PAGELLA_ELIMINAZIONE_NON_TROVATA: 'errorePagellaEliminazioneNonTrovata',
    PAGELLA_ELIMINAZIONE_NON_RIUSCITA: 'errorePagellaEliminazioneNonRiuscita',
    /**
     * 404 — il pagamento di cui si chiede l'anteprima della fattura non c'è più.
     *
     * ⚠️ Il TESTO non è «Pagamento non trovato», ed è deliberato: quella frase è
     * scritta a mano in quattordici punti di `src/app/api/pagamenti/**` senza codice,
     * e il lock `errori-con-codice` — giustamente — pretende che la frase di un
     * codice non viaggi mai senza il suo codice. Dare a questo codice quella frase
     * significherebbe rendere rossi quattordici file che questo lavoro non tocca.
     * Quando qualcuno vorrà dare un codice anche a loro, li unirà; fino ad allora
     * questa frase è sua e di nessun altro.
     */
    PAGAMENTO_INESISTENTE: 'errorePagamentoInesistente',
    /**
     * 503 — i modelli di causale della sede non si sono potuti leggere.
     *
     * FAIL-CLOSED, e la frase lo dice: la causale è la descrizione della riga, cioè
     * l'unico punto in cui la fattura identifica il minore e ciò da cui dipende la
     * detrazione del genitore. Un guasto di lettura non può riscriverla in silenzio
     * su un documento che si corregge solo con una nota di variazione.
     */
    CAUSALE_CONFIG_NON_LETTA: 'erroreCausaleConfigNonLetta',
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
    /*
     * ── FASCICOLO: modifica, sostituzione, cestino, ripristino (spec 2026-09-24, F1) ──
     * Route `primaria/fascicolo` (PATCH, DELETE), `…/sostituisci`, `…/cestino`.
     */
    /** 401 — nessuna sessione riconosciuta sulle route di gestione del fascicolo. */
    FASCICOLO_NON_AUTENTICATO: 'erroreFascicoloNonAutenticato',
    /** 403 — chi ACCEDE al fascicolo ma non è né l'autore del documento né Segreteria/Direzione. */
    FASCICOLO_GESTIONE_NEGATA: 'erroreFascicoloGestioneNegata',
    /** 400 — PATCH senza nessuno dei tre campi modificabili (tipo, descrizione, scadenza). */
    FASCICOLO_NIENTE_DA_MODIFICARE: 'erroreFascicoloNienteDaModificare',
    /** 400 — il file sostitutivo non è un PDF né un'immagine ammessa. */
    FASCICOLO_FORMATO_NON_AMMESSO: 'erroreFascicoloFormatoNonAmmesso',
    /** 400 — il file sostitutivo supera il tetto del fascicolo. */
    FASCICOLO_FILE_TROPPO_GRANDE: 'erroreFascicoloFileTroppoGrande',
    /** 500 — upload del file fallito (caricamento o sostituzione): nel fascicolo non è cambiato niente. */
    FASCICOLO_FILE_NON_CARICATO: 'erroreFascicoloFileNonCaricato',
    /** 500 — scrittura su `student_documents` fallita (caricamento, modifica, cestino, ripristino, sostituzione). */
    FASCICOLO_SCRITTURA_FALLITA: 'erroreFascicoloScritturaFallita',
    /**
     * 409 — il documento è stato eliminato o sostituito da qualcun altro fra la lettura e la
     * scrittura. Non è un 404: il documento c'era quando la schermata è stata disegnata.
     */
    FASCICOLO_DOCUMENTO_CAMBIATO: 'erroreFascicoloDocumentoCambiato',
    /** 409 — ripristino di un documento che non è (più) nel cestino. */
    FASCICOLO_NON_NEL_CESTINO: 'erroreFascicoloNonNelCestino',
    /** 409 — ripristino oltre i giorni di custodia del cestino (`GIORNI_CESTINO_REGISTRO`). */
    FASCICOLO_CESTINO_SCADUTO: 'erroreFascicoloCestinoScaduto',
    /**
     * 409 — PATCH o sostituzione di una riga di `student_documents` che NON è del fascicolo
     * (tipo fuori da `TIPI_FASCICOLO`): un prestampato firmato dal genitore o protocollato.
     * La firma, la data della firma e il numero di protocollo appartengono a quel modulo:
     * dal fascicolo si può solo mettere nel cestino.
     */
    FASCICOLO_DOCUMENTO_NON_MODIFICABILE: 'erroreFascicoloDocumentoNonModificabile',

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
     * 404 — il nome della classe non corrisponde a nessuna sezione fra le sedi
     * ATTIVE (`admin/registro-presenze/pdf:GET`).
     *
     * Distinto da `REGISTRO_SEZIONE_VUOTA`, e la differenza non è formale: là la
     * sezione c'è e non ha alunni, qui la sezione non è stata trovata affatto —
     * di solito perché il SedeSelector è su un'altra sede. Le due situazioni si
     * risolvono in modi opposti (iscrivere un bambino / cambiare sede), e dire
     * «non c'è nessun alunno» a chi ha solo la sede sbagliata lo manda a cercare
     * il problema dove non è.
     */
    REGISTRO_CLASSE_NON_RISOLTA: 'erroreRegistroClasseNonRisolta',
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
    /**
     * 403 — le credenziali di un account di DIREZIONE si rigenerano dalla
     * Direzione (`admin/regenerate-credentials:POST`, `admin/credentials-pdf:GET`).
     *
     * Dal 2026-09-03 la Segreteria rigenera le credenziali dello staff del
     * proprio plesso, ma non quelle di `admin`/`coordinator`: chi preme il
     * pulsante riceve un PDF con la password IN CHIARO, e su un account di
     * Direzione quello non sarebbe un recupero credenziali — sarebbe un
     * passaggio di consegne.
     */
    CREDENZIALI_STAFF_RISERVATE: 'erroreCredenzialiStaffRiservate',
    /**
     * 403 — l'incarico che si sta modificando è riservato alla Direzione
     * (`admin/staff:PATCH`).
     *
     * Dal 2026-09-04 la Segreteria sposta di SEDE un membro dello staff, ma non
     * ne cambia ruolo, fasce d'età o classi, e non tocca affatto un account di
     * `admin`/`coordinator`. Un codice solo per i tre dinieghi perché a schermo
     * la frase è la stessa — «questo lo fa la Direzione» — mentre il motivo
     * preciso serve a chi legge i log, e lì ci resta.
     *
     * ⚠️ È la METÀ di `CREDENZIALI_STAFF_RISERVATE`, non un suo doppione: chi
     * potesse promuovere una collega ad `admin` otterrebbe per via indiretta ciò
     * che quel codice le nega. Le due riserve si tengono in piedi a vicenda.
     */
    INCARICO_STAFF_RISERVATO: 'erroreIncaricoStaffRiservato',
    /**
     * 403 — chi chiede il rinvio in blocco non ha nessun plesso associato.
     *
     * Non è un errore tecnico e non è un tentativo: è un account configurato a
     * metà. Codice suo e non `SEDE_NON_ACCESSIBILE` perché quel contatore è un
     * segnale di sicurezza — «hai chiesto una sede che non è tua» — e riempirlo
     * di account senza sede lo renderebbe illeggibile proprio il giorno che serve.
     */
    RINVIO_NESSUN_PLESSO: 'erroreRinvioNessunPlesso',
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
     * 400 — GoTrue ha respinto la password perché COMPARE IN ELENCHI DI PASSWORD
     * RUBATE ad altri siti (`422 weak_password`, protezione «leaked password»).
     *
     * ⚠️ È IL RIFIUTO PIÙ FREQUENTE DI TUTTI, e fino al 2026-09-04 non aveva un
     * codice suo: cadeva in `PASSWORD_RIFIUTATA`, la cui frase manda a scegliere
     * una password «più lunga e con almeno una lettera e una cifra». Misurato in
     * produzione quel giorno: **30 rifiuti su 20 utenti distinti**, 47 su 29 il
     * giorno prima. Tutte password da dieci caratteri, con maiuscola e cifra —
     * cioè persone mandate a correggere requisiti che avevano già soddisfatto,
     * con i tre criteri della schermata verdi sotto gli occhi.
     *
     * PERCHÉ MERITA UN CODICE PROPRIO E NON BASTA `PASSWORD_RIFIUTATA`: il rimedio
     * è diverso, ed è l'unico caso in cui la forma della password NON è il
     * problema. Dire «più lunga» a chi ha scritto una parola comune di dodici
     * lettere lo manda a scriverne una di quindici — che sarà respinta uguale.
     * La frase deve dire l'unica cosa che risolve: cambiare *parola*, non misura.
     */
    PASSWORD_TROPPO_COMUNE: 'errorePasswordTroppoComune',
    /**
     * 409 — le credenziali NON sono state inviate perché l'indirizzo dell'anagrafica
     * è già di un altro account, e quello di accesso è quindi rimasto un altro.
     *
     * PERCHÉ È UN RIFIUTO E NON UN AVVISO: spedire qui vorrebbe dire scrivere una
     * password su un account e mandarla a un indirizzo che non è il suo. È il
     * difetto misurato il 2026-09-04 — 4 famiglie mai entrate, una con 13
     * rigenerazioni in un giorno — e ogni corsa distruggeva anche la password
     * precedente. Meglio non spedire niente che spedire una cosa che non funziona.
     */
    CREDENZIALI_INDIRIZZO_IN_USO: 'erroreCredenzialiIndirizzoInUso',
    /**
     * 409 — stesso rifiuto del precedente, ma per un guasto invece che per un
     * conflitto: l'indirizzo di accesso non si è potuto riallineare.
     *
     * NON riusa il codice qui sopra perché il rimedio è opposto: là bisogna
     * sistemare due anagrafiche, qui basta riprovare fra qualche minuto. Dire
     * «unificare le anagrafiche» a chi ha solo incontrato un provider lento lo
     * manderebbe a cercare un problema che non esiste.
     */
    CREDENZIALI_INDIRIZZO_NON_ALLINEATO: 'erroreCredenzialiIndirizzoNonAllineato',
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
    /**
     * ─── L'ESTRATTO CONTO DELLA BANCA ───────────────────────────────────────
     * Cinque rifiuti che l'operatore di segreteria può incontrare caricando il file,
     * e che senza codice uscirebbero in italiano dentro un'interfaccia inglese.
     * Sono separati di proposito: «troppo grande», «tipo sbagliato», «non si apre» e
     * «non ci sono accrediti» si riparano in quattro modi diversi, e una frase sola
     * («import fallito») costringerebbe a indovinare quale.
     */
    /** 400 — nessun file nella richiesta multipart. */
    ESTRATTO_CONTO_ASSENTE: 'erroreEstrattoContoAssente',
    /** 415 — non è un .csv/.xls/.xlsx né per nome né per tipo dichiarato. */
    ESTRATTO_CONTO_TIPO_NON_AMMESSO: 'erroreEstrattoContoTipoNonAmmesso',
    /** 413 — oltre il tetto di piattaforma (4 MB), che non è il nostro ma vince lo stesso. */
    ESTRATTO_CONTO_TROPPO_GRANDE: 'erroreEstrattoContoTroppoGrande',
    /** 400 — i byte sono arrivati, ma non si aprono come foglio di calcolo. */
    ESTRATTO_CONTO_ILLEGGIBILE: 'erroreEstrattoContoIlleggibile',
    /** 400 — il file si apre ma non ha nessun accredito riconoscibile. */
    ESTRATTO_CONTO_SENZA_ACCREDITI: 'erroreEstrattoContoSenzaAccrediti',
    /* ⚠️ Il tetto di frequenza dei tentativi NON prende un codice nuovo: è già
     * `TROPPE_RICHIESTE`, dichiarato più in alto in questo stesso file e tradotto
     * nelle due lingue. Un `PASSWORD_TROPPE_RICHIESTE` accanto direbbe la stessa
     * cosa con un'altra frase da tenere allineata — che è il modo in cui questo
     * elenco ha già prodotto un codice riusato per sbaglio (vedi
     * `NEWS_FILE_SOSTITUITI_NON_RIMOSSI`). Chi scriverà `POST /api/account/password`
     * usi quello. */
    /**
     * ─── LO STESSO BONIFICO SU UNA VOCE GIÀ FATTURATA ───────────────────────
     * 409 — il movimento bancario porta ancora il pagamento a cui era abbinato, e
     * quel pagamento ha una fattura VIVA. Riabbinarlo a un'altra voce lascerebbe
     * quel documento senza l'incasso che lo giustifica.
     *
     * La prosa del server porta il NUMERO della fattura, che il catalogo non può
     * conoscere: per questo il codice sta anche in `CODICI_CON_DETTAGLIO`. Senza
     * il numero la segreteria sa che c'è una fattura di mezzo e non sa quale.
     */
    BONIFICO_GIA_FATTURATO: 'erroreBonificoGiaFatturato',
    /**
     * 503 — se quella fattura ci sia non si è potuto LEGGERE (PostgREST ha
     * risposto con un errore): fail-closed, non si riabbina.
     *
     * NON riusa il codice qui sopra, ed è la differenza che conta per chi legge:
     * là c'è un documento e il rimedio è fiscale (una nota di variazione), qui
     * non si sa niente e il rimedio è riprovare fra un minuto. Dire «c'è già una
     * fattura» quando non lo si è potuto verificare manderebbe dal
     * commercialista per un guasto di lettura.
     */
    BONIFICO_FATTURA_NON_VERIFICABILE: 'erroreBonificoFatturaNonVerificabile',
    /**
     * ─── LE QUOTE DI OGGI NON SONO QUELLE DELLA FATTURA DI IERI ─────────────
     * 409 — il pagamento è ripartito fra più intestatari e a registro c'è già una
     * fattura VIVA che non corrisponde a nessuna di quelle quote: intestatario
     * ignoto, un adulto che oggi non ha quota, oppure il suo importo di ieri (la
     * fattura intera da 150 € contro la quota da 75 € della stessa persona).
     *
     * Codice distinto da `FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO` perché diverso è
     * il posto in cui si ripara: là si è scelto l'intestatario sbagliato, qui
     * sono le QUOTE del pagamento ad essere cambiate dopo l'emissione — e la
     * fattura di ieri va chiusa con una nota di variazione prima di emettere
     * quelle nuove. Un codice solo per due situazioni manderebbe metà di chi lo
     * riceve a guardare la cosa sbagliata.
     */
    FATTURA_RIGA_VIVA_ESTRANEA_ALLE_QUOTE: 'erroreFatturaRigaVivaEstraneaAlleQuote',
    /**
     * ─── I LEGAMI FAMILIARI (`admin/legami-familiari`) ──────────────────────
     * 404 — l'adulto e il bambino non risultano collegati: si sta scollegando o
     * correggendo un legame che non c'è (di solito un elenco vecchio a schermo).
     * Non è `ALUNNO_NON_TROVATO`: il bambino c'è, è il LEGAME a non esserci.
     */
    LEGAME_NON_TROVATO: 'erroreLegameNonTrovato',
    /**
     * 409 — si sta togliendo l'ULTIMO adulto collegato a un bambino.
     *
     * Non è un guasto, è una protezione, e la frase deve dire il rimedio: senza
     * nessun legame quel bambino non lo vede più nessun genitore — diario,
     * galleria, pagamenti, chat — e il solo modo di ricollegarlo è la stessa
     * schermata da cui lo si è tolto. In produzione cinque alunni sono già in
     * quello stato; l'ordine giusto è collegare prima l'altro genitore.
     * È la stessa lezione del 409 dell'oblio: un rifiuto che non dice come si
     * sblocca è un rifiuto che torna.
     */
    LEGAME_ULTIMO_GENITORE: 'erroreLegameUltimoGenitore',
    /**
     * 500 — la scrittura del legame è stata respinta dal database.
     *
     * NON riusa `LETTURA_FALLITA`, che sta accanto in questa stessa rotta: là
     * non si era ancora toccato niente e il rimedio è riprovare; qui una
     * scrittura è stata tentata, e chi legge deve sapere che è quella ad essere
     * fallita. Il `message` grezzo di PostgREST non esce di qui — resta nel log.
     */
    LEGAME_NON_SALVATO: 'erroreLegameNonSalvato',
    /**
     * 500 — lo SCOLLEGAMENTO è riuscito a metà: la riga che apre l'accesso è già
     * stata tolta, quella in anagrafica no.
     *
     * NON è `LEGAME_NON_SALVATO`, e la differenza non è di sfumatura: quel codice
     * porta in catalogo la frase «niente è stato modificato», che qui è l'esatto
     * CONTRARIO del vero — metà del gesto è avvenuta, e la metà avvenuta è
     * proprio quella che toglie a un adulto la vista sui dati di un minore. Fino
     * al 2026-09-06 le due situazioni condividevano il codice: il server scriveva
     * la frase giusta, il catalogo la scartava (i codici `LEGAME_*` non sono in
     * `CODICI_CON_DETTAGLIO`) e l'operatore leggeva il contrario di ciò che era
     * successo. Due rimedi opposti — là si riprova e basta, qui si riprova
     * sapendo che una metà è già andata — non stanno sotto lo stesso codice.
     */
    LEGAME_MEZZO_TOLTO: 'erroreLegameMezzoTolto',
    /**
     * 500 — il ramo «crea un adulto NUOVO» del collegamento è caduto DOPO aver
     * chiamato `linkOrCreateParent`: l'anagrafica dell'adulto può essere già
     * nata, e con un'email le credenziali sono già partite verso una famiglia
     * vera.
     *
     * Anche qui il rimedio è l'opposto di `LEGAME_NON_SALVATO`: quella frase
     * («niente è stato modificato… riprova») invita a ricompilare il modulo, cioè
     * a creare un SECONDO adulto e a mandare una SECONDA email di credenziali. Il
     * dialogo di aggiunta se n'era accorto dal proprio lato e si difendeva
     * nascondendo la prosa del server sui 5xx; la difesa giusta è che la rotta
     * dica quale ramo ha preso, ed è questo codice.
     *
     * «FORSE» è la parola esatta e non un'attenuazione: `linkOrCreateParent` può
     * cadere prima di creare l'anagrafica (insert respinto) o dopo (il legame,
     * l'identità di accesso). Il rimedio però è lo stesso in entrambi i casi —
     * cercare l'adulto in archivio invece di ricrearlo — e due situazioni con lo
     * STESSO rimedio condividono il codice, esattamente come `TROPPE_RICHIESTE`.
     */
    LEGAME_ADULTO_FORSE_CREATO: 'erroreLegameAdultoForseCreato',
    /**
     * 400 — la richiesta di collegamento non porta né `parent_id` né l'anagrafica
     * di un adulto nuovo: non c'è nessuno da collegare.
     *
     * Era il quinto uso di `LEGAME_NON_SALVATO`, e stonava per il rimedio: la
     * frase di catalogo dice «riprova fra poco», mentre riprovare non serve a
     * niente finché non si sceglie un adulto. Non lo produce nessuna schermata
     * (il client costruisce sempre uno dei due corpi), quindi lo legge chi sta
     * scrivendo un chiamante nuovo: è a lui che il messaggio deve dire cosa
     * manca, non di aspettare.
     */
    LEGAME_ADULTO_NON_INDICATO: 'erroreLegameAdultoNonIndicato',
    /**
     * 500 — il menu della mensa non è stato scritto. Copre sia il guasto di scrittura sia
     * `42P10` (l'indice che la route usa come arbitro non c'è: migrazione mancante). Il
     * motivo vero resta nel log: fino al 2026-09-06 usciva a schermo, in inglese.
     */
    MENU_NON_SALVATO: 'erroreMenuNonSalvato',
    /**
     * 500 — il frammento di giudizio della Primaria non è stato scritto. Stessa forma e
     * stessa ragione di `MENU_NON_SALVATO`, su una strada dove il difetto non è ancora
     * morso: `giudizio_template` ha nove righe, tutte globali, e nessuno ha ancora
     * salvato un frammento per una sede — la prima che ci prova prende il `42P10` della
     * mensa. Il codice NON è condiviso con il menu perché il rimedio è lo stesso ma la
     * cosa non salvata no: a schermo deve restare scritto CHE COSA non è stato salvato.
     */
    GIUDIZIO_NON_SALVATO: 'erroreGiudizioNonSalvato',
    /**
     * 400 — l'insegnante ha chiesto i pasti residui senza dichiarare la propria
     * sezione (`mensa/ticket-residui:GET`). Per lui la classe non è un filtro ma
     * un permesso: il server la pretende, come già nel report cucina.
     */
    MENSA_CLASSE_OBBLIGATORIA: 'erroreMensaClasseObbligatoria',
    /** 403 — la sezione chiesta non è fra quelle assegnate al docente. */
    MENSA_SEZIONE_NON_ASSEGNATA: 'erroreMensaSezioneNonAssegnata',
    /**
     * 500 — l'elenco dei bambini non si è POTUTO leggere
     * (`mensa/ticket-residui:GET`). Non riusa `ALUNNO_NON_TROVATO`: «non c'è» e
     * «non l'ho potuto leggere» hanno rimedi opposti, e qui la schermata vuota
     * si leggerebbe come «nessuno ha pasti».
     */
    MENSA_ELENCO_NON_LETTO: 'erroreMensaElencoNonLetto',
    /** 500 — i pasti residui o il loro storico non sono stati letti. */
    MENSA_TICKET_NON_LETTI: 'erroreMensaTicketNonLetti',
    /** 403 — quel bambino non è in una delle classi dell'insegnante. */
    MENSA_ALUNNO_FUORI_CLASSE: 'erroreMensaAlunnoFuoriClasse',
    /** 500 — non si è potuto verificare a chi appartiene quel bambino. */
    MENSA_SCOPE_NON_VERIFICATO: 'erroreMensaScopeNonVerificato',
    /**
     * 400 (disdetta) o esito della prenotazione — il genitore ha chiesto un giorno
     * già passato, o oggi dopo l'orario limite della sua sede (ora italiana,
     * `mensa/prenotazioni`). Lo staff non lo riceve mai: allo sportello forza.
     */
    MENSA_OLTRE_CUTOFF: 'erroreMensaOltreCutoff',
    /**
     * ─── LA FATTURA È PARTITA, MA ARUBA NON L'HA CONFERMATO ─────────────────
     * 502 — rifiuto di TRASPORTO (`POST /api/pagamenti/fattura`): il numero è
     * stato consumato e nessuno sa se il documento sia arrivato allo SdI (un 429
     * sopravvissuto al ritentativo, un 401, un 5xx, un timeout).
     *
     * È l'unico rifiuto dell'emissione dopo il quale **ripremere è la cosa
     * sbagliata**: tutti gli altri si chiudono con «nessun numero è stato
     * consumato», qui un secondo tentativo produrrebbe una SECONDA fattura vera
     * per la stessa retta — che si corregge solo con una nota di variazione — e
     * ogni tentativo riazzera per un'ora il secchio dei limiti di Aruba.
     *
     * Sta anche in `CODICI_CON_DETTAGLIO`: la prosa del server porta il NUMERO
     * del documento, che il catalogo non può conoscere ed è l'unica cosa che dice
     * quale fattura andare a cercare sul pannello Aruba.
     */
    FATTURA_TRASPORTO_IGNOTO: 'erroreFatturaTrasportoIgnoto',
    /**
     * ─── LA FATTURA È PARTITA, MA A REGISTRO NON C'È ─────────────────────────
     * 409 — `POST /api/pagamenti/fattura` e `POST …/fattura/lotto` (D1§8): il
     * predicato CASE di C0.3 è vero — con file registrato, nessuna riga viva
     * di QUEL file; senza, nessuna riga viva di sorta. Una riga viva di
     * un'altra quota non basta a fermare il rifiuto. Non se ne emette una
     * seconda: va prima registrata a mano, o la ritrova lo script delle
     * orfane. NESSUN numero è stato consumato da questo rifiuto — a
     * differenza di `FATTURA_TRASPORTO_IGNOTO`, qui ripremere non rischia una
     * seconda fattura vera.
     *
     * Sta anche in `CODICI_CON_DETTAGLIO`: la prosa del server porta il NOME
     * FILE della fattura partita, che il catalogo non può conoscere ed è
     * l'unica cosa che dice quale documento andare a registrare.
     */
    FATTURA_PARTITA_NON_REGISTRATA: 'erroreFatturaPartitaNonRegistrata',
    /**
     * ─── IL PDF DELLA FATTURA NON C'È, E LO SI DICE ─────────────────────────
     * 404 — `GET /api/pagamenti/fattura`: il documento non è (ancora) nel bucket
     * `fatture`. O lo SdI non l'ha restituito, o la chiave scritta a registro non
     * corrisponde più a nessun oggetto.
     *
     * ⚠️ NASCE PERCHÉ PRIMA QUESTO RIFIUTO NON ESISTEVA. La rotta, quando il PDF
     * mancava, ne disegnava uno al volo — intestazione, numero, causale, importo
     * — e lo serviva come `application/pdf` con `200`. Chi premeva «Scarica
     * fattura» si ritrovava in mano un foglio che *sembra* una fattura e non è la
     * fattura elettronica trasmessa allo SdI: né il genitore che se lo salva sul
     * telefono, né il commercialista che se lo allega alla dichiarazione hanno
     * modo di accorgersene. Un surrogato indistinguibile dal documento vero è
     * peggio di un rifiuto: il rifiuto lo si legge.
     */
    FATTURA_PDF_NON_DISPONIBILE: 'erroreFatturaPdfNonDisponibile',
    /**
     * 409 — per questo pagamento non è stata emessa nessuna fattura. Non è un
     * guasto e non è un permesso negato: è una retta che nessuno ha ancora
     * fatturato, e la frase deve dirlo senza far pensare a un errore dell'utente.
     */
    FATTURA_NON_EMESSA: 'erroreFatturaNonEmessa',
    /**
     * ─── DUE FATTURE, DUE INTESTATARI: QUALE LO DICE CHI CHIEDE ─────────────
     * 409 — `GET /api/pagamenti/fattura` senza `fattura_id` su un pagamento che
     * ha PIÙ fatture vive (genitori separati: una quota a testa).
     *
     * ⚠️ NASCE PERCHÉ PRIMA LA ROTTA SCEGLIEVA DA SÉ, e sceglieva male: prendeva
     * la riga col `numero` più alto. Al padre usciva la fattura intestata alla
     * MADRE — suo codice fiscale, sua residenza, suo importo — servita come
     * documento ufficiale e usata come base della detrazione 730. Un documento
     * fiscale non si indovina: se le fatture sono due, si chiede quale.
     */
    FATTURA_PIU_QUOTE: 'erroreFatturaPiuQuote',
    /**
     * 404 — il pagamento indicato non risulta (`GET /api/pagamenti/fattura` e
     * `…/fattura/list`).
     *
     * ⚠️ LA VOCE DI CATALOGO NON DEVE ESSERE «Pagamento non trovato». Quella
     * frase è scritta a mano in altri punti di `src/app/api/pagamenti/**` che il
     * codice non ce l'hanno, e il lock `errori-con-codice` pretende che la frase
     * di un codice non viaggi mai senza il suo codice: darle quel testo
     * renderebbe rossi file che questo lavoro non tocca. Stessa trappola già
     * documentata su `PAGAMENTO_INESISTENTE`, e stessa uscita: una frase sua.
     */
    PAGAMENTO_NON_TROVATO: 'errorePagamentoNonTrovato',
    /**
     * 404 — la fattura indicata da `fattura_id` non esiste, oppure non è di
     * quel pagamento. Un solo codice per i due casi, di proposito: distinguerli
     * confermerebbe a chi non ha titolo di vederla che quella fattura esiste.
     */
    FATTURA_NON_TROVATA: 'erroreFatturaNonTrovata',
    /**
     * 500 — non si è potuto stabilire se questa fattura sia tua
     * (`src/lib/pagamenti/scope-fattura.ts`): la lettura dei legami
     * genitore↔figlio è fallita.
     *
     * Deliberatamente distinto dal 403: PostgREST non lancia, e finché il legame
     * era un `boolean` una lettura fallita usciva come «Accesso negato» addosso al
     * genitore TITOLARE, per giunta accendendo il contatore dei tentativi a suo
     * nome. «Non l'ho potuto leggere» non è «non è tuo figlio».
     */
    FATTURA_ACCESSO_NON_VERIFICATO: 'erroreFatturaAccessoNonVerificato',
    /**
     * 403 — questa fattura non è né della tua famiglia né del tuo plesso
     * (`src/lib/pagamenti/scope-fattura.ts`).
     *
     * Un solo codice per i due dinieghi, come per `CANDIDATURA_NON_TROVATA` e per
     * la stessa ragione: distinguerli direbbe a chi non ha titolo di vederla che
     * quella fattura esiste. La differenza vive nel log (`fattura-non-della-famiglia`
     * contro `fattura-ruolo-non-ammesso`).
     */
    FATTURA_ACCESSO_NEGATO: 'erroreFatturaAccessoNegato',
    /** 409 — la revisione storica è già stata finalizzata o la sede è già attiva. */
    FATTURA_REVISIONE_IMMUTABILE: 'erroreFatturaRevisioneImmutabile',
    /** 409 — l’insieme delle irrisolte è cambiato dopo l’anteprima mostrata allo staff. */
    FATTURA_ANTEPRIMA_CAMBIATA: 'erroreFatturaAnteprimaCambiata',
    /** 409 — almeno una fattura storica non ha ancora una revisione verificata. */
    FATTURA_REVISIONI_INCOMPLETE: 'erroreFatturaRevisioniIncomplete',
    /**
     * 429 — il blocco di fatture è stato rifiutato PRIMA di partire: Aruba concede
     * 60 upload l'ora per IP e per quest'ora sono esauriti.
     *
     * È l'unico rifiuto del lotto che non riguarda nessuna riga in particolare, ed è
     * volutamente rumoroso: ogni tentativo verso Aruba — anche rifiutato — riazzera il
     * TTL del secchio da un'ora. Un `429` incassato sul campo non costa solo la fattura
     * che non parte: costa l'ora successiva a chiunque, compreso chi sta fatturando a
     * mano dal pannello.
     */
    LOTTO_TETTO_ORARIO_RAGGIUNTO: 'erroreLottoTettoOrario',
    /**
     * 500 — non si è potuto LEGGERE la registrazione di diario che si stava per
     * cancellare (`diary/entries:DELETE`). Si legge prima di cancellare perché è
     * l’unico momento in cui il valore di prima esiste ancora: senza quella lettura
     * si cancellerebbe alla cieca e l’audit direbbe «non c’era niente».
     */
    DIARIO_LETTURA_FALLITA: 'erroreDiarioLetturaFallita',
    /** 500 — la registrazione di diario non è stata tolta (`diary/entries:DELETE`). */
    DIARIO_NON_ELIMINATO: 'erroreDiarioNonEliminato',
    /**
     * 500 — l'appello della primaria non ha potuto leggere lo stato PRECEDENTE
     * (`primaria/appello:POST`). Da quando la riga si costruisce a partire da ciò che
     * c'era, quella lettura è portante: proseguire senza azzererebbe note e orari in
     * silenzio, che è il difetto che il controllo esiste per chiudere.
     */
    APPELLO_STATO_PRIMA_NON_LETTO: 'erroreAppelloStatoPrimaNonLetto',
    /** 409 — a questo bambino è già stata registrata una ricarica OGGI: serve la conferma esplicita. */
    TICKET_RICARICA_DUPLICATA: 'erroreTicketRicaricaDuplicata',
    /**
     * 404 — la sezione su cui si vuole firmare il registro di primaria non esiste
     * (`assertSezionePrimariaFirmabile`).
     *
     * ⚠️ La frase di catalogo NON è «Sezione non trovata», ed è deliberato: quella
     * stringa è scritta a mano in una dozzina di route senza codice, e il lock
     * `errori-con-codice` — giustamente — pretende che la frase di un codice non
     * viaggi mai senza il suo codice. Dargli quella frase renderebbe rossi file che
     * questo lavoro non tocca. Quando qualcuno darà un codice anche a loro, li unirà.
     */
    SEZIONE_NON_TROVATA: 'erroreSezioneNonTrovata',
    /** 403 — questa è la porta del registro di PRIMARIA, e la classe è di un altro grado. */
    CLASSE_NON_DI_PRIMARIA: 'erroreClasseNonDiPrimaria',
    /**
     * 403 — il docente non risulta abilitato al grado di scuola richiesto
     * (`assertGradoDocente`). Vale per primaria, infanzia e nido: la frase di
     * catalogo è unica e non nomina il grado, che sta invece nella prosa italiana
     * di ripiego e nel log (`grado-non-abilitato`).
     */
    GRADO_NON_ABILITATO: 'erroreGradoNonAbilitato',
    /** 500 — il `catch` di `primaria/registro:POST`: la firma non è stata salvata. */
    FIRMA_NON_SALVATA: 'erroreFirmaNonSalvata',
    /**
     * 400 — la linguetta «Compiti» del registro ha chiesto più di 365 giorni in una
     * volta (`GET /api/primaria/compiti`).
     *
     * ⚠️ ESISTE PERCHÉ SENZA CODICE IL MOTIVO NON ARRIVAVA. Fino al 2026-09-19 il
     * tetto viveva in un `superRefine` dello schema, quindi il rifiuto usciva come
     * `{ error: 'Dati non validi', details: [{ message: 'Periodo troppo lungo…' }] }`:
     * la forma ordinata di tutti gli ingressi rifiutati del repo, e anche quella che
     * NESSUNO legge — `messaggioDaCorpo`, `soloCatalogoDaCorpo` ed `erroreDaRisposta`
     * guardano `error` e `codice`, e l'unico consumatore di `details` in `src/`
     * (`CassaMovimentoModal`) ne usa il `path`. Il docente leggeva «Dati non validi»
     * davanti a un intervallo da restringere, senza sapere che cosa restringere.
     *
     * NON sta in `CODICI_CON_DETTAGLIO`. La prosa del server porta il numero di
     * giorni chiesti, ma è un numero che il client HA GIÀ — le due date le ha scelte
     * lui — e appenderla vorrebbe dire mostrare a un'interfaccia inglese una coda di
     * italiano per un dato che sapeva già: il difetto che i codici hanno chiuso,
     * riaperto per comodità. Il numero resta nella prosa per chi legge i log e per il
     * ripiego italiano.
     */
    PERIODO_TROPPO_LUNGO: 'errorePeriodoTroppoLungo',
    /**
     * 400 — l'intervallo chiesto finisce prima di cominciare (`dataA` precedente a
     * `dataDa`, `GET /api/primaria/compiti`).
     *
     * NON riusa `PERIODO_TROPPO_LUNGO`: quello chiede di RESTRINGERE, e qui
     * restringere non serve a niente. Fino al 2026-09-19 questo caso rispondeva 200
     * con elenco vuoto, cioè «in questo periodo non sono stati assegnati compiti» —
     * una frase vera solo per caso, che mandava il docente a cercare compiti
     * inesistenti invece dei due campi che aveva invertito.
     *
     * Non sta in `CODICI_CON_DETTAGLIO` per la stessa ragione dell'altro: le due
     * date che la prosa ripete sono quelle che il client ha appena mandato.
     */
    PERIODO_ROVESCIATO: 'errorePeriodoRovesciato',
    /**
     * 409 — la foto che si sta modificando è NEL CESTINO (`gallery:PATCH`).
     *
     * Non è un 403 e non è un 404: il titolo chi chiede ce l'ha (il gate di sede è
     * appena passato) e la foto esiste — per 30 giorni è ancora lì e si ripristina.
     * È lo STATO della riga a rendere l'operazione senza senso, e la frase deve dire
     * la via d'uscita («ripristinala prima»), non il rifiuto.
     */
    GALLERIA_MEDIA_NEL_CESTINO: 'erroreGalleriaMediaNelCestino',
    /**
     * 501 — su questo impianto la galleria non ha il cestino (`gallery:DELETE`): le
     * colonne `eliminato_il`/`file_rimosso_il` non esistono e l'archiviazione non è
     * avvenuta. È il degrado del DB E2E della CI, non migrato.
     *
     * ⚠️ 501 e non 500, e la differenza è quella che l'utente deve leggere: non è un
     * guasto passeggero da riprovare fra un minuto — è una funzione che su questo
     * impianto non c'è. Qui NON si degrada cancellando: un `.delete()` di ripiego
     * distruggerebbe la riga e renderebbe il file del bucket irraggiungibile per
     * sempre, proprio dove il cestino non c'è per accoglierla.
     */
    GALLERIA_CESTINO_NON_DISPONIBILE: 'erroreGalleriaCestinoNonDisponibile',
    /* ── Il ritorno dal cestino (`gallery/ripristina:POST`, 2026-09-12) ──────── */
    /**
     * 404 — non esiste nessuna foto con quell'id (`gallery/ripristina:POST`).
     *
     * Distinto da `MEDIA_NON_RIPRISTINABILE` qui sotto perché sono due cose che
     * l'interfaccia deve trattare in modo diverso: «questa riga non c'è» si chiude
     * togliendola dall'elenco, «c'è ma non si può ripristinare» si chiude
     * ricaricando l'elenco e spiegando perché.
     */
    GALLERIA_MEDIA_NON_TROVATO: 'erroreGalleriaMediaNonTrovato',
    /**
     * 409 — la foto non si può riportare in galleria (`gallery/ripristina:POST`), e
     * i due stati che lo impediscono sono entrambi qui dentro.
     *
     *  · `eliminato_il IS NULL` — non era nel cestino: chi ha premuto Ripristina
     *    sta guardando un elenco che non è più vero, e la via d'uscita è ricaricarlo
     *    (non si risponde 200 «già fatto», che gli lascerebbe credere di aver
     *    recuperato qualcosa);
     *  · `file_rimosso_il IS NOT NULL` — il file è uscito dallo Storage allo scadere
     *    dei 30 giorni. La riga si riporterebbe in vita in un millisecondo, e
     *    sarebbe la cosa peggiore: in galleria comparirebbe una foto ROTTA.
     *
     * Non è un 403 e non è un 404: il titolo chi chiede ce l'ha (il gate di sede è
     * appena passato) e la riga esiste. È lo STATO a rendere l'operazione senza
     * senso — lo stesso ragionamento di `GALLERIA_MEDIA_NEL_CESTINO`, nell'altro
     * verso.
     */
    MEDIA_NON_RIPRISTINABILE: 'erroreMediaNonRipristinabile',
    /**
     * 501 — su questo impianto la galleria non ha il cestino e il ripristino non è
     * avvenuto (`gallery/ripristina:POST`). È il gemello di
     * `GALLERIA_CESTINO_NON_DISPONIBILE` per il gesto INVERSO, e non lo riusa per
     * una ragione sola: quella frase dice «la foto non è stata eliminata», che a chi
     * ha premuto Ripristina racconta il contrario di quello che è successo.
     */
    GALLERIA_RIPRISTINO_NON_DISPONIBILE: 'erroreGalleriaRipristinoNonDisponibile',
    /**
     * 500 — il ripristino è stato tentato e NON è avvenuto: la scrittura è stata
     * respinta dal database, o un'eccezione è arrivata al `catch` dell'handler
     * (`gallery/ripristina:POST`). La foto è rimasta nel cestino, quindi la frase
     * dice «riprova» e non «è stata ripristinata».
     */
    MEDIA_NON_RIPRISTINATO: 'erroreMediaNonRipristinato',
    /* ── «Componi il pagamento»: un bonifico ripartito su più voci (2026-09-12) ─ */
    /**
     * 422 — la somma delle voci composte non è uguale all'importo del bonifico.
     *
     * È il rifiuto CENTRALE della schermata, e non è un capriccio di forma: una
     * composizione che non quadra scrive incassi che non corrispondono a nessun
     * denaro arrivato in banca, e il buco ricompare mesi dopo nello scadenzario di
     * una famiglia che aveva pagato. Il conto lo rifà il server — il totale che si
     * vede a schermo è quello del browser, e fra i due c'è una rete.
     *
     * 422 e non 400: il corpo è ben formato e zod lo accetta: è la RELAZIONE fra i
     * numeri a non stare in piedi, e si vede solo avendo letto il movimento.
     */
    CONCILIAZIONE_NON_QUADRA: 'erroreConciliazioneNonQuadra',
    /**
     * 403 — una delle voci composte sta in un plesso che l'operatore non può
     * toccare.
     *
     * NON è `SEDE_NON_ACCESSIBILE`, e la differenza è quella che l'operatore deve
     * leggere: lì la sede rifiutata è quella DELL'OPERAZIONE (l'ha indicata lui, o
     * viene dal cookie), qui l'operazione è legittima e a essere fuori portata è
     * UNA RIGA fra quelle che ha messo nel pagamento — spesso un fratello iscritto
     * in un altro plesso. La via d'uscita è togliere quella voce, non cambiare
     * sede, e `rifiutoSede` direbbe il contrario.
     */
    CONCILIAZIONE_SEDE_NON_ACCESSIBILE: 'erroreConciliazioneSedeNonAccessibile',
    /**
     * 400 — non è stata indicata la voce su cui ANCORARE la fattura.
     *
     * L'àncora non è un dettaglio del documento: da quella voce si prendono
     * l'intestatario e la sede in cui la fattura viene archiviata. Senza, la route
     * dovrebbe indovinare — ed è esattamente il modo in cui un documento finisce
     * nel plesso sbagliato in silenzio.
     */
    CONCILIAZIONE_ANCORA_MANCANTE: 'erroreConciliazioneAncoraMancante',
    /**
     * 409 — la riga bancaria è cambiata mentre la si stava componendo: un altro
     * operatore l'ha abbinata, riaperta o fatturata nel frattempo.
     *
     * Non si risponde 200 «fatto»: la composizione che si sta confermando è stata
     * pensata su uno stato che non c'è più, e applicarla scriverebbe incassi
     * doppi. La frase dice di ricaricare, che è l'unica cosa che rimette
     * l'operatore davanti alla realtà.
     */
    CONCILIAZIONE_MOVIMENTO_CAMBIATO: 'erroreConciliazioneMovimentoCambiato',
    /**
     * ⚠️ NON È UN RIFIUTO: è un AVVISO su una risposta **200**.
     *
     * Si è riaperto un movimento che aveva già prodotto una fattura VIVA (emessa,
     * consegnata o in attesa dello SDI: tutto tranne una scartata). Il documento
     * resta in piedi mentre l'incasso che lo giustificava è stato stornato — cioè
     * un numero di fattura senza più niente sotto, che si chiude solo con una nota
     * di variazione. Chi riapre deve saperlo, e deve sapere QUALI documenti
     * guardare: la prosa del server porta i numeri, che il catalogo non può
     * conoscere, e il campo `avviso.numeri` li porta anche in forma di elenco.
     *
     * ⚠️ FINO AL 2026-09-13 QUESTO BLOCCO DICEVA «409» e la frase di catalogo
     * diceva «annullala prima di riaprirlo». Era un divieto, ed è stato MISURATO
     * che cosa avrebbe vietato: in produzione, **167 movimenti confermati su 174**
     * hanno una fattura viva sul pagamento abbinato — il 96%. Una riapertura che
     * rifiuta il 96% dei casi non è una riapertura: è un pulsante che non funziona
     * mai. Decisione del titolare, esplicita: «riapri comunque, avvisando».
     *
     * Le SCARTATE non passano di qui: quelle vanno rifatte, ed è il caso normale.
     */
    RIAPERTURA_CON_FATTURA_VIVA: 'erroreRiaperturaConFatturaViva',
    /**
     * ⚠️ Anche questo è un AVVISO su una risposta **200**, non un rifiuto.
     *
     * Se una fattura viva ci sia non si è potuto LEGGERE (PostgREST ha risposto
     * con un errore). La riapertura NON si ferma — il titolare ha deciso che si
     * riapre sempre — ma tacere trasformerebbe un guasto di lettura in un
     * «nessuna fattura viva» che nessuno ha verificato, e sarebbe la stessa specie
     * di silenzio che questo repo passa il tempo a chiudere.
     *
     * NON riusa `BONIFICO_FATTURA_NON_VERIFICABILE`, che dice «l'operazione è
     * stata fermata»: qui l'operazione è ANDATA, e dire il contrario manderebbe
     * l'operatrice a rifare una riapertura già avvenuta.
     */
    RIAPERTURA_FATTURE_NON_VERIFICATE: 'erroreRiaperturaFattureNonVerificate',
    /**
     * 503 — la riapertura di un movimento composito passa dalla RPC
     * `annulla_transazione_contabile`, che su questo ambiente non c'è
     * (`PGRST202`/`42883`: il DB E2E della CI non è migrato).
     *
     * Niente è stato scritto: lo storno e la riapertura vivono dentro quella
     * chiamata, e senza di lei non parte nemmeno la prima riga.
     */
    RIAPERTURA_NON_DISPONIBILE: 'erroreRiaperturaNonDisponibile',
    /**
     * 409 — la transazione che questo bonifico ha saldato ha generato un credito
     * di eccedenza che la famiglia ha già speso: annullarla lascerebbe il saldo
     * negativo (`KV410` della RPC).
     *
     * Il rimedio non è ritentare: è recuperare prima il credito speso. Per questo
     * non riusa `CONCILIAZIONE_MOVIMENTO_CAMBIATO`, che invece invita a ricaricare.
     */
    RIAPERTURA_CREDITO_GIA_SPESO: 'erroreRiaperturaCreditoGiaSpeso',
    /**
     * 500 — lo storno che la riapertura deve fare PRIMA di rimettere il bonifico in
     * coda non è riuscito: il movimento non è stato toccato.
     *
     * L'ordine (prima si storna, poi si riapre) non è un dettaglio implementativo e
     * spiega perché questo codice esiste: nel verso opposto resterebbe un movimento
     * libero con l'incasso ancora vivo, che si fa riabbinare a un'altra voce — cioè
     * lo stesso denaro incassato due volte. Meglio non riaprire.
     */
    RIAPERTURA_NON_RIUSCITA: 'erroreRiaperturaNonRiuscita',
    /**
     * 500 — la riga dell'estratto conto non si è potuta LEGGERE.
     *
     * Non è «non esiste»: PostgREST non lancia, e fino al 2026-09-13 qualunque
     * guasto di lettura qui usciva come 404 «Movimento non trovato» — un messaggio
     * che manda a cercare una riga che invece c'è.
     *
     * ⚠️ **500 È LO STATO VERO, e per un po' non lo è stato.** Lo stesso giorno in
     * cui questo blocco è nato, il codice usciva anche su un **503** — il gate di
     * sede della riapertura composita, dove però la cosa non letta è la
     * TRANSAZIONE, non la riga bancaria di cui parla la frase qui sotto. Quel punto
     * ha ora il suo codice (`RIAPERTURA_SEDE_NON_VERIFICATA`): qui resta soltanto
     * la lettura del movimento, che è 500 e parla del movimento.
     */
    MOVIMENTO_NON_LETTO: 'erroreMovimentoNonLetto',
    /**
     * 404 — la riga bancaria che si stava per comporre non c'è (più).
     *
     * Distinto da `CONCILIAZIONE_MOVIMENTO_CAMBIATO` (409), che è il caso in cui
     * il movimento esiste ancora ma non è più nello stato su cui la composizione
     * era stata pensata: lì si ricarica e si ricompone, qui non c'è più niente da
     * comporre. Dirli con lo stesso codice manderebbe l'operatrice a ricaricare
     * una schermata che resterà vuota.
     */
    CONCILIAZIONE_MOVIMENTO_NON_TROVATO: 'erroreConciliazioneMovimentoNonTrovato',
    /**
     * 500 — il contesto del pannello «Componi il pagamento» non si è potuto
     * leggere (una query del database non ha risposto).
     *
     * ⚠️ ESISTE PERCHÉ UN GUASTO NON DEVE TRAVESTIRSI DA ELENCO VUOTO. PostgREST
     * non lancia: ritorna `{ error }`, e una route che lo ignorasse risponderebbe
     * 200 con zero voci aperte — cioè «questa famiglia non deve niente» detto a
     * chi sta per incassare un bonifico. Chi legge questo codice sa di non aver
     * ricevuto un elenco corto: sa di non aver ricevuto l'elenco.
     */
    CONCILIAZIONE_CONTESTO_NON_LETTO: 'erroreConciliazioneContestoNonLetto',
    /**
     * 500 — la ricerca del bambino da cui comporre il bonifico non è riuscita.
     *
     * ⚠️ NON è un elenco vuoto, ed è tutta la ragione per cui esiste. In una
     * RICERCA i due esiti si somigliano — la schermata non mostra nessuna riga
     * in entrambi i casi — ma dicono cose opposte: «quel bambino non c'è, apri
     * la sua scheda» e «non ho potuto cercare, riprova». Chi legge il primo
     * mentre valeva il secondo va a creare una seconda anagrafica di un bambino
     * che è già a registro.
     *
     * Distinto da `CONCILIAZIONE_CONTESTO_NON_LETTO`, che è il guasto del
     * pannello già aperto su una famiglia scelta: là non si compone, qui non si
     * sceglie nemmeno.
     */
    CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA: 'erroreConciliazioneRicercaAlunniNonLetta',
    /**
     * 403 — il pagante indicato a mano non è fra i genitori dei bambini che
     * questo bonifico nomina.
     *
     * La proposta si cambia, ma si cambia SCEGLIENDO fra i candidati che la
     * schermata mostra. Accettare un `parents.id` qualunque farebbe di questa
     * rotta un modo per sfogliare le famiglie dell'intero archivio — voci aperte,
     * importi e plessi — conoscendo un solo uuid. Non è un errore di forma (per
     * quello c'è zod): è una richiesta ben scritta a cui si risponde di no.
     */
    CONCILIAZIONE_PAGANTE_NON_AMMESSO: 'erroreConciliazionePaganteNonAmmesso',
    /**
     * 404 — uno dei bambini indicati a mano (`?alunni=` sul contesto) non è in
     * nessuna delle sedi che l'operatore può gestire.
     *
     * È l'altra metà del paragrafo qui sopra. Su un movimento che il matcher non
     * ha saputo abbinare non c'è nessun suggerimento, quindi nessun bambino,
     * quindi nessun candidato: senza un modo di dire «questo bonifico è di questa
     * famiglia» la composizione resta spenta. `?alunni=` è quel modo — e un uuid
     * arbitrario, senza la verifica di sede, lo renderebbe anche un modo per
     * sfogliare l'archivio: voci aperte, residui e nomi dei genitori di una
     * famiglia qualunque, conoscendo un solo id.
     *
     * ⚠️ **404 E NON 403**, che qui è la sostanza e non la forma. Un 403
     * distinguerebbe «non tuo» da «non esiste», cioè confermerebbe a chi lavora
     * in un plesso che un certo bambino è iscritto in un altro — metà
     * dell'informazione che il gate esiste per non dare. Stessa grammatica del
     * gate sul movimento (`CONCILIAZIONE_MOVIMENTO_NON_TROVATO`), e per la stessa
     * ragione. Non è nemmeno un errore di forma: per quello c'è zod, che risponde
     * 400 a un uuid malformato o a più di cinque.
     */
    CONCILIAZIONE_ALUNNO_NON_TROVATO: 'erroreConciliazioneAlunnoNonTrovato',
    /**
     * 403 — una voce NUOVA o una ricarica ticket è intestata a un bambino che non
     * è più attivo: ritirato, oppure con l'anagrafica cancellata dall'oblio GDPR.
     *
     * ⚠️ NON è `CONCILIAZIONE_SEDE_NON_ACCESSIBILE`, e la differenza è quella che
     * l'operatrice deve leggere: quel codice parla di PLESSO e manda a togliere una
     * voce che appartiene a un'altra sede. Qui il bambino è della sua sede, e il
     * problema è il suo stato — dirle «sede che non puoi gestire» la manderebbe a
     * cercare un errore di plesso che non c'è.
     *
     * Misurato sul database vivo il 2026-09-13, su 727 alunni: **10 ritirati**
     * (lo stato `archiviato` non esiste: gli stati sono due, `iscritto` e
     * `ritirato`) e **4 anonimizzati**, tutti e quattro dentro i dieci ritirati.
     * La RPC `registra_transazione_contabile` accetta qualunque `alunno_id`
     * ESISTA: il rifiuto è un gate applicativo e il suo posto è la route.
     *
     * Vale solo per le voci che NASCONO qui. Una voce già a sistema resta
     * incassabile anche dopo il ritiro: un insoluto si salda anche quando il
     * bambino non frequenta più, ed è il caso normale di fine anno.
     */
    CONCILIAZIONE_ALUNNO_NON_ATTIVO: 'erroreConciliazioneAlunnoNonAttivo',
    /**
     * 503 — la conciliazione composita non è disponibile su questo ambiente, e
     * NIENTE è stato scritto.
     *
     * Due cause, una sola risposta: la RPC estesa non c'è (`PGRST202`/`42883`) o
     * il legame movimento→transazione non esiste ancora (`42703` su
     * `riconciliazione_movimenti.transazione_id`). Il DB E2E della CI è un
     * progetto separato e non migrato: là questa strada non esiste affatto.
     *
     * ⚠️ Il 503 sulla COLONNA assente non è pignoleria. La RPC *vecchia* esiste e
     * accetta lo stesso payload: ignorerebbe `movimento_id` in silenzio,
     * scriverebbe gli incassi e lascerebbe la riga bancaria rossa — cioè
     * esattamente il difetto che questa funzionalità esiste per chiudere, con un
     * 200 sopra. Meglio non partire.
     */
    CONCILIAZIONE_NON_DISPONIBILE: 'erroreConciliazioneNonDisponibile',
    /**
     * 500 — la registrazione non è riuscita: la RPC ha risposto con un errore che
     * non è né «non ci sono» né «hai perso la corsa».
     *
     * Il `message` grezzo della RPC NON esce di qui. La funzione è stata scritta
     * apposta per non interpolare testo libero nei propri `RAISE` — le voci si
     * nominano con l'indice, mai con la descrizione — ma il patto si mantiene da
     * tutt'e due i capi: quel messaggio resta nel log, dove ha un lettore, e non
     * nel corpo della risposta, dove diventerebbe un canale.
     */
    CONCILIAZIONE_NON_REGISTRATA: 'erroreConciliazioneNonRegistrata',
    /**
     * 409 — LO STORNO È AVVENUTO, la riga bancaria non è tornata in coda.
     *
     * ⚠️ ESISTE PERCHÉ `CONCILIAZIONE_MOVIMENTO_CAMBIATO` QUI DICEVA IL CONTRARIO.
     * Quel codice era stato messo su questa risposta proprio per «dichiarare lo
     * storno», e la prosa del server lo dichiarava davvero — ma
     * `CONCILIAZIONE_MOVIMENTO_CAMBIATO` NON sta in `CODICI_CON_DETTAGLIO`:
     * `messaggioDaCorpo` scarta la prosa appena riconosce il codice, e a schermo
     * usciva la frase di catalogo, «un altro operatore ha appena modificato questo
     * bonifico: ricarica l'elenco e ricomponi il pagamento». Del denaro restituito,
     * niente. Misurato eseguendo `messaggioDaCorpo`, non dedotto.
     *
     * La via non era aggiungere quel codice a `CODICI_CON_DETTAGLIO`: la sua frase
     * INVITA A RICOMPORRE, ed è giusta dov'è usata (la composizione perde la corsa
     * e si rifà). Qui il fatto è un altro, ed è l'unico che conti: il denaro è già
     * stato stornato, e chi ripreme il pulsante non ne raddoppia lo storno.
     *
     * Sta su un 409 e non su un 500 perché non è un guasto: è una corsa persa
     * sulla SECONDA metà di un'operazione la cui prima metà è riuscita.
     */
    RIAPERTURA_STORNATA_NON_RIAPERTA: 'erroreRiaperturaStornataNonRiaperta',
    /**
     * 503 — non si è potuta LEGGERE la transazione di cui il bonifico fa parte,
     * quindi non si è potuta verificare la sua SEDE: la riapertura è stata fermata
     * prima di qualunque storno.
     *
     * ⚠️ NON è `MOVIMENTO_NON_LETTO`, e per due motivi che erano entrambi sbagliati
     * insieme: quel codice è documentato **500** (ed è 500 dov'è usato davvero,
     * sulla lettura della riga bancaria) mentre questa risposta è **503**; e la sua
     * frase dice «questa riga dell'estratto conto», mentre la cosa che qui non si è
     * potuta leggere è la TRANSAZIONE. Un codice che porta lo stato sbagliato e il
     * soggetto sbagliato non è un'imprecisione: manda a guardare l'oggetto che non
     * c'entra.
     *
     * Fail-closed: `annulla_transazione_contabile` gira a service-role e storna
     * incassi, ricariche mensa e credito di famiglia senza che nessun filtro le
     * arrivi addosso. Senza quella lettura non si sa di CHI sia il denaro.
     */
    RIAPERTURA_SEDE_NON_VERIFICATA: 'erroreRiaperturaSedeNonVerificata',
    /**
     * ─── I QUATTRO DELL'ANNULLAMENTO IN BLOCCO DI UN IMPORT ─────────────────
     *
     * «Disfa tutto ciò che la macchina ha chiuso da sola in questo import»:
     * `pagamenti/riconciliazione/annulla-import`. Sono rifiuti che arrivano
     * PRIMA di qualunque storno — l'annullo non parte mai a metà — e ognuno
     * manda a fare una cosa diversa, che è il motivo per cui sono quattro e non
     * uno generico.
     *
     * 500/503 — l'elenco di ciò che l'import ha chiuso da solo non si è potuto
     * leggere, oppure non si sono potute leggere le transazioni dei bonifici
     * compositi. **Nessuna riga è stata toccata**, e la frase lo dice: chi legge
     * un «errore» su un'operazione che storna denaro deve sapere, prima di tutto
     * il resto, se qualcosa è già partito.
     */
    ANNULLO_IMPORT_NON_LETTO: 'erroreAnnulloImportNonLetto',
    /**
     * 503 — su questo ambiente la marca `abbinato_auto_il` non esiste (il DB E2E
     * della CI non è migrato), quindi non esiste nemmeno il modo di sapere quali
     * righe abbia chiuso la macchina.
     *
     * ⚠️ Il rimedio NON è riprovare: è riaprire i movimenti uno per uno dal
     * registro, col pulsante di sempre. Un «riprova» qui manderebbe a ripetere
     * un'operazione che su quell'ambiente non può riuscire mai.
     */
    ANNULLO_IMPORT_NON_DISPONIBILE: 'erroreAnnulloImportNonDisponibile',
    /**
     * 422 — l'import ha chiuso da solo più movimenti di quanti se ne possano
     * disfare in una richiesta.
     *
     * Un ciclo non limitato su una rotta serverless è un timeout travestito da
     * successo parziale: a tempo scaduto le righe già stornate restano stornate
     * e nessuna risposta dice quali fossero. Il rimedio è il registro filtrato
     * per import, dove si riaprono a gruppi.
     */
    ANNULLO_IMPORT_TROPPE_RIGHE: 'erroreAnnulloImportTroppeRighe',
    /**
     * 403 — fra le righe da disfare ce n'è almeno una chiusa su una sede che chi
     * opera non gestisce.
     *
     * ⚠️ NON è un'incoerenza col fatto che quelle righe si VEDANO: l'abbinamento
     * automatico lavora su tutte e tre le sedi per decisione del titolare
     * (l'estratto conto della banca è uno solo), ma annullare è uno **storno** —
     * un movimento contabile definitivo sul denaro di un plesso — e lo storno si
     * fa dalla propria sede. La frase dice anche che nessuna riga è stata
     * toccata: l'annullo è tutto-o-niente, e non esiste un mezzo annullo da
     * andare a cercare.
     */
    ANNULLO_IMPORT_FUORI_PERIMETRO: 'erroreAnnulloImportFuoriPerimetro',
    /**
     * 500 — l'annullo in blocco si è interrotto a metà del ciclo.
     *
     * ⚠️ ESISTE PERCHÉ NON SI PUÒ DIRE «nessuna riga è stata toccata», che è
     * invece la frase di `ANNULLO_IMPORT_NON_LETTO`. Qui l'eccezione è arrivata
     * DOPO che il ciclo era partito: una parte dei bonifici può essere già
     * tornata in coda, coi suoi storni registrati. Dire il contrario manderebbe
     * l'operatrice a ripetere un annullo già avvenuto per metà — e anche se il
     * ritentativo è idempotente per costruzione, il conteggio che lei ha in
     * testa non lo sarebbe.
     *
     * Il rimedio è guardare: il registro filtrato per quell'import dice quali
     * righe sono tornate rosse e quali sono rimaste verdi.
     */
    ANNULLO_IMPORT_INTERROTTO: 'erroreAnnulloImportInterrotto',
    /**
     * 503 — gli avvisi alle famiglie degli abbinamenti automatici non sono
     * partiti: non si è potuto leggere che cosa fosse già stato avvisato, o quali
     * voci il bonifico abbia saldato.
     *
     * ⚠️ È un fail-closed VOLUTO, e la frase deve dire che si può riprovare: un
     * avviso mandato due volte non si ritira, uno non ancora partito si manda
     * riaprendo il riepilogo. Nessuna famiglia ha ricevuto niente.
     */
    RIEPILOGO_NOTIFICHE_NON_INVIATE: 'erroreRiepilogoNotificheNonInviate',
    /**
     * 500 — l'invio degli avvisi si è interrotto a metà.
     *
     * Gemello di `ANNULLO_IMPORT_INTERROTTO`, e per la stessa ragione: a
     * differenza del fail-closed qui sopra, in questo caso **una parte delle
     * famiglie può aver già ricevuto l'avviso**, e dire «nessuna famiglia ha
     * ricevuto niente» sarebbe falso. Riaprire il riepilogo resta la cosa giusta
     * da fare — la rotta è idempotente, chi è già stato avvisato non lo sarà due
     * volte — ma va detto che qualcosa è partito.
     */
    RIEPILOGO_NOTIFICHE_INTERROTTE: 'erroreRiepilogoNotificheInterrotte',
    /**
     * 422 — una delle voci scelte è un CONTENITORE di rate (`pagamenti.tipo =
     * 'padre'`): il totale di un piano, non una cosa che si incassa.
     *
     * Incassarlo lo porterebbe a `pagato` LASCIANDO APERTE le rate figlie: lo
     * stesso denaro a registro due volte, e la famiglia che resta morosa sulle
     * rate. Il resto dell'applicazione lo esclude da sempre — nove punti, da
     * `/api/pagamenti` alla dashboard — ma sempre in LETTURA: sulla rotta che
     * scrive i soldi il filtro non c'era, e una voce `padre` passava con 200
     * (sonda del 2026-09-13). Una guardia sulla lettura non protegge la scrittura.
     *
     * Il rimedio che la frase deve dare è preciso: non «riprova», ma «togli quella
     * riga e scegli le rate». In produzione al 2026-09-13 c'è UNA riga `padre` su
     * 825 pagamenti, ed è già `pagato`: il varco era dormiente, non chiuso.
     */
    CONCILIAZIONE_VOCE_CONTENITORE: 'erroreConciliazioneVoceContenitore',
    /**
     * 200 (sì, DUECENTO) — l'incasso è stato registrato, ma la riga dell'estratto
     * conto non è stata legata alla transazione.
     *
     * ⚠️ È L'UNICO CODICE DI QUESTO ELENCO CHE VIAGGIA SU UNA RISPOSTA RIUSCITA, ed
     * è deliberato. Succede nella finestra stretta in cui la colonna
     * `riconciliazione_movimenti.transazione_id` esiste ma la RPC è ancora quella
     * VECCHIA: gli incassi vengono scritti e il compare-and-swap non avviene. Un
     * 500 direbbe «nulla è stato scritto» — falso — e inviterebbe a ritentare; un
     * 200 muto lascia leggere «fatto» davanti a una riga che resta rossa, e
     * l'operatrice ritenta lo stesso. Al secondo giro il doppio incasso è fermato
     * dal residuo riletto SOLO per le voci esistenti: le voci nuove e i ticket
     * nascono di nuovo, e niente li trattiene.
     *
     * Perciò la frase dice una cosa sola e la dice in imperativo: non ripetere.
     */
    CONCILIAZIONE_MOVIMENTO_NON_LEGATO: 'erroreConciliazioneMovimentoNonLegato',

    /* ── Avvisi con adesione: due scadenze, posti e lista d'attesa (cantiere B4) ──
     *
     * La scadenza dell'avviso (quando sparisce dalla bacheca) e la scadenza
     * dell'adesione (ultimo istante per rispondere) sono due colonne distinte, con
     * data E ora. Dodici codici: cinque sul salvataggio dell'avviso da parte della
     * segreteria/docente (`POST`/`PATCH /api/avvisi`), cinque sulla risposta del
     * genitore (`POST /api/avvisi/[id]/risposte`), uno di degrado e uno
     * sull'esportazione riservata. Nessuna delle frasi tradotte nomina le due
     * colonne: si dice «la scadenza dell'avviso» e «la data entro cui si può
     * aderire», mai `scadenza_avviso`/`scadenza_adesione`.
     */

    /**
     * 400 — la data/ora dopo cui l'avviso sparisce dalla bacheca non è utilizzabile:
     * non è più opzionale.
     *
     * ⚠️ «MANCANTE» NEL NOME, «manca o non è valida» NELLA FRASE, e la differenza è
     * stata misurata: `risolviScadenze` (`@/lib/avvisi/scadenze`) risponde con questo
     * codice anche quando il campo È compilato ma illeggibile — `2026-06-01T99:99`,
     * `2026-02-30T10:00`. Il testo precedente diceva «senza questa data e ora»,
     * cioè mandava la segreteria a cercare un campo vuoto che aveva invece
     * riempito: un messaggio sbagliato con l'aria di essere a posto, la stessa forma
     * di `NEWS_FILE_NON_RIMOSSI` usato sulla PATCH.
     *
     * Il codice NON è stato sdoppiato in un `…_NON_LEGGIBILE`, ed è una decisione:
     * dietro lo schema (`zScadenzaAvvisoDataOra`) quel ramo non è raggiungibile —
     * zod rifiuta prima, con un messaggio che dice DOVE è lo sbaglio — quindi un
     * secondo codice sarebbe una voce di catalogo in due lingue per una frase che
     * nessuno può leggere. Il ragionamento per esteso, con il rapporto fra le due
     * difese, sta accanto al ramo in `scadenze.ts`.
     */
    SCADENZA_AVVISO_MANCANTE: 'erroreScadenzaAvvisoMancante',
    /**
     * 400 — la data/ora entro cui si può aderire non è utilizzabile (assente o
     * illeggibile), su un avviso che chiede un'adesione. Distinto da
     * `SCADENZA_AVVISO_MANCANTE`: sono due campi, due validazioni, e la frase deve
     * dire quale dei due. Stessa storia del testo, qui sopra.
     */
    SCADENZA_ADESIONE_MANCANTE: 'erroreScadenzaAdesioneMancante',
    /**
     * 400 — la scadenza per aderire cade DOPO la scadenza dell'avviso: l'avviso
     * sparirebbe dalla bacheca lasciando adesioni ancora aperte, oppure le
     * adesioni si chiuderebbero su un avviso che nessuno vede più da tempo.
     */
    SCADENZE_INCOERENTI: 'erroreScadenzeIncoerenti',
    /** 400 — una delle due scadenze è già passata al momento del salvataggio. */
    SCADENZA_NEL_PASSATO: 'erroreScadenzaNelPassato',
    /**
     * 400 — la segreteria sta configurando l'intervallo di persone per adesione
     * (minimo, massimo, valore predefinito) e i tre numeri non stanno insieme:
     * minimo sopra il massimo, o predefinito fuori dai due. Distinto da
     * `NUMERO_PARTECIPANTI_FUORI_INTERVALLO`, che è lo stesso controllo ma sulla
     * risposta del GENITORE contro un intervallo già salvato e valido.
     */
    NUMERO_INTERVALLO_NON_VALIDO: 'erroreNumeroIntervalloNonValido',
    /**
     * 400 — l'avviso chiede il numero di partecipanti e il genitore ha risposto
     * senza indicarlo (`POST /api/avvisi/[id]/risposte`).
     */
    NUMERO_PARTECIPANTI_RICHIESTO: 'erroreNumeroPartecipantiRichiesto',
    /**
     * 400 — il numero di partecipanti indicato dal genitore è fuori
     * dall'intervallo minimo/massimo che la segreteria ha configurato per questo
     * avviso.
     */
    NUMERO_PARTECIPANTI_FUORI_INTERVALLO: 'erroreNumeroPartecipantiFuoriIntervallo',
    /**
     * 409 — la scadenza per aderire è già passata quando arriva la risposta: la
     * risposta non viene registrata, nemmeno in lista d'attesa.
     */
    ADESIONE_SCADUTA: 'erroreAdesioneScaduta',
    /**
     * 409 — il tetto di posti (contato in persone, non in famiglie) non lascia
     * spazio per questa adesione, e la lista d'attesa non fa parte di questa
     * risposta (è la segreteria ad ammettere a mano quando si libera un posto).
     *
     * 🔴 La frase NON dice quanti posti restano, per decisione esplicita del
     * committente: il numero libero non si mostra mai al genitore. Alla
     * segreteria i numeri arrivano da un canale diverso (il riepilogo del
     * dettaglio avviso), non da questa stringa: lo stesso testo deve valere per
     * entrambi i pubblici senza rivelare nulla al primo.
     */
    POSTI_ESAURITI: 'errorePostiEsauriti',
    /**
     * 503 — la lettura o la scrittura di un'adesione non è riuscita (conteggio
     * posti, tetto configurato, lista d'attesa): degrado, non un rifiuto di
     * merito. Riprovare può bastare.
     */
    ADESIONI_NON_DISPONIBILI: 'erroreAdesioniNonDisponibili',
    /**
     * 404 — l'id di risposta indicato (per correggere il numero, ritirare
     * un'adesione, o ammettere dalla lista d'attesa) non appartiene all'avviso
     * della richiesta. Un solo codice per «non esiste» e «è di un altro avviso»,
     * come altrove in questo file: distinguerli non aiuterebbe chi guarda, e la
     * differenza vive nel log.
     */
    RISPOSTA_NON_DELLAVVISO: 'erroreRispostaNonDellAvviso',
    /*
     * 🔻 `ESPORTAZIONE_RISERVATA` È STATO TOLTO il 2026-09-19, insieme alle sue
     * due voci di catalogo. Era nato per il 403 di `avvisi/[id]/risposte/esporta`
     * e non l'ha mai mandato nessuno: `grep` su `src/` e `__tests__/` trovava la
     * dichiarazione e null'altro. Quel 403 lo costruisce `requireStaff`, che
     * risponde con la propria forma e senza `codice` — quindi il codice non era
     * «da collegare», era decorazione.
     *
     * PERCHÉ TOLTO E NON EMESSO. Emetterlo vuol dire riscrivere il ramo 403
     * dentro la route dell'export, che questo lavoro non tocca; e un codice
     * dichiarato che nessuno manda è peggio di un codice assente, perché il lock
     * `errori-con-codice` lo vede verde (è dichiarato, è tradotto in due lingue) e
     * chi legge questo elenco crede che quel rifiuto sia già tradotto. Un catalogo
     * che dice il falso su sé stesso è il difetto, non la sua misura.
     *
     * Chi un giorno darà un `codice` a quel 403 lo ridichiari qui — in FONDO, come
     * ogni voce nuova: i cataloghi non si riordinano, e un riordino produce
     * migliaia di righe di diff che non sono di nessuno.
     */
    /**
     * 404 — l'avviso indicato non esiste (o non esiste più).
     *
     * NON si riusa `RISPOSTA_NON_DELLAVVISO`, che direbbe una cosa falsa: lì il
     * problema è la risposta, qui manca l'avviso intero. Due frasi diverse perché
     * mandano a guardare due posti diversi.
     */
    AVVISO_NON_TROVATO: 'erroreAvvisoNonTrovato',
    /**
     * 400 — un valore su un enumerato chiuso delle adesioni non è fra quelli
     * ammessi: la `risposta` del genitore (`si`/`no`) o lo `stato` che la
     * segreteria sta assegnando (`ammessa`/`in_attesa`/`nessuna`).
     *
     * UN CODICE SOLO PER I DUE CASI, e non è pigrizia. Sono due sbagli del
     * CLIENT sullo stesso genere di campo, e per chi legge non sono due
     * situazioni diverse: in entrambe non c'è niente da correggere nel proprio
     * dato: c'è una schermata da ricaricare. La differenza — quale dei due — vive
     * nel log, dove serve a chi indaga.
     */
    ADESIONE_VALORE_NON_VALIDO: 'erroreAdesioneValoreNonValido',
    /**
     * 409 — la segreteria sta ammettendo una famiglia che aveva risposto **NO**.
     *
     * 🔴 NON È UN ERRORE: È UNA DOMANDA. Il «no» di una famiglia e l'istante in
     * cui l'ha espresso sono un dato suo; sovrascriverli li farebbe sparire dal
     * database. La funzione si ferma e restituisce ciò che ha trovato proprio
     * perché l'interfaccia possa CHIEDERE — «questa famiglia aveva rifiutato:
     * confermi?» — e ripresentarsi con `ignora_rifiuto`. Il testo deve dire cosa
     * succede al sì, non «operazione fallita»: chi legge deve poter decidere.
     */
    RISPOSTA_CONTRARIA: 'erroreRispostaContraria',
    /**
     * 503 — la funzione di database che serializza le adesioni ha rifiutato di
     * lavorare fuori da `READ COMMITTED`: fuori di lì il conteggio dei posti non
     * è protetto e due ammissioni concorrenti sfonderebbero il tetto in silenzio.
     *
     * ⚠️ RIUSA LA VOCE DI `ADESIONI_NON_DISPONIBILI`, e la decisione va motivata
     * perché è l'unico riuso di questo file. Tre ragioni:
     *  · per chi legge è lo STESSO fatto — «adesso non si può, riprova» — e una
     *    seconda frase direbbe la stessa cosa con altre parole, cioè due testi da
     *    tenere allineati per nessun guadagno;
     *  · una frase propria dovrebbe nominare il livello di isolamento di una
     *    transazione per essere più informativa di così, e questo file vieta di
     *    mostrare a chi lavora in segreteria il funzionamento interno del
     *    database (regola 3 del lock `errori-con-codice`);
     *  · le route non emettono MAI questo codice al client: lo traducono in
     *    `ADESIONI_NON_DISPONIBILI` e scrivono il nome vero nel log. La voce sta
     *    qui come rete per il giorno in cui un codice della RPC uscisse
     *    verbatim — meglio la frase giusta che la prosa italiana del server.
     */
    ISOLAMENTO_NON_SUPPORTATO: 'erroreAdesioniNonDisponibili',
    /**
     * 403 — il bambino indicato non è destinatario di questo avviso: è iscritto
     * in un altro plesso, oppure l'avviso è rivolto a certe classi e la sua non è
     * fra quelle (`POST /api/avvisi/[id]/risposte`).
     *
     * 🔴 NON si riusa `ADESIONE_VALORE_NON_VALIDO` né `AVVISO_NON_TROVATO`, e la
     * differenza non è di sfumatura: quei due mandano a ricaricare la pagina, e
     * ricaricare qui non cambia niente. Qui l'avviso c'è, il bambino è davvero
     * suo, e il rifiuto riguarda l'ACCOPPIAMENTO fra i due — l'unica strada è
     * chiedere alla segreteria, che è ciò che la frase deve dire.
     *
     * ⚠️ E la frase non nomina né la sede né la classe: sono i due casi che
     * questo codice unisce, e distinguerli a schermo direbbe a chi legge dove è
     * iscritto un bambino che non ha davanti. La differenza vive nel log
     * (`adesione-alunno-fuori-avviso`, campo `tipo`), dove serve a chi indaga.
     */
    ADESIONE_ALUNNO_FUORI_AVVISO: 'erroreAdesioneAlunnoFuoriAvviso',
    /**
     * 403 — a questo account è stato REVOCATO il profilo staff
     * (`utenti.archiviato_il` valorizzato) e non esiste il ponte genitore.
     *
     * 🔴 NON si riusa `ACCOUNT_SOSPESO`, e la differenza non è di sfumatura:
     * quello nasce dalla morosità di una famiglia
     * (`src/lib/pagamenti/sospensione.ts`) e la sua frase parla di «posizione
     * amministrativa da regolarizzare». Darlo a una maestra archiviata le
     * direbbe che non ha pagato una retta.
     *
     * ⚠️ La frase non dice PERCHÉ, non porta una data e non nomina chi ha
     * deciso: è una decisione sul rapporto di lavoro di una persona, e la
     * schermata di un'app non è il posto dove gliela si comunica. Manda alla
     * segreteria perché è l'unico rimedio — non è un errore che si corregge
     * riprovando.
     *
     * ⚠️ Chi ha ANCHE il ponte `parents` non vede mai questo codice: per lui
     * l'archiviazione revoca il profilo staff e basta, e continua a entrare
     * come genitore. Vedi `utenteDellaRichiesta`.
     */
    ACCOUNT_ARCHIVIATO: 'erroreAccountArchiviato',
    /** 503 — le sonde sulle tracce del docente non si sono potute leggere. */
    STAFF_ELIMINAZIONE_NON_LETTA: 'erroreStaffEliminazioneNonLetta',
    /**
     * 503 — almeno una verifica è fallita, quindi non si offre nessun comando.
     *
     * FAIL-CLOSED. «Non ho potuto leggere» non è «non c'è»: su una lettura
     * fallita l'anteprima direbbe «si cancella» su un docente che ha scritto il
     * registro per un anno.
     */
    STAFF_ELIMINAZIONE_NON_DECISA: 'erroreStaffEliminazioneNonDecisa',
    /**
     * 409 — fra l'anteprima e la conferma la decisione è cambiata.
     *
     * È la corsa che rende impossibile «ho premuto archivia e mi ha cancellato»:
     * il server ricalcola e, se non trova ciò che il client dichiara di aver
     * letto, non esegue.
     */
    STAFF_ELIMINAZIONE_CAMBIATA: 'erroreStaffEliminazioneCambiata',
    /** 409 — l'account è anche l'accesso di una famiglia: non si elimina. */
    STAFF_ELIMINAZIONE_PROFILO_DOPPIO: 'erroreStaffEliminazioneProfiloDoppio',
    /** 403 — archiviare sé stessi è l'unico errore senza rimedio in-app. */
    STAFF_ELIMINAZIONE_SE_STESSI: 'erroreStaffEliminazioneSeStessi',
    /** 403 — un bersaglio di Direzione non si elimina da questo pannello. */
    STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE: 'erroreStaffEliminazioneBersaglioDirezione',
    /** 409 — l'account risultava già archiviato (CAS a zero righe). */
    STAFF_GIA_ARCHIVIATO: 'erroreStaffGiaArchiviato',
    /**
     * 409 — si chiede di riportare a genitore una persona che non ha il ponte
     * `parents`.
     *
     * ⚠️ Il ponte NON si crea qui: fabbricare una scheda di genitore copiandola
     * dal fascicolo del personale che si sta per cancellare è esattamente la
     * scrittura silenziosa da evitare. E un genitore senza figli collegati
     * atterra su un'area vuota. La frase manda dove il legame si crea davvero.
     */
    RIPORTA_GENITORE_SENZA_PONTE: 'erroreRiportaGenitoreSenzaPonte',
    /** 409 — è già `genitore`: non c'è niente da cambiare. */
    RIPORTA_GENITORE_GIA_GENITORE: 'erroreRiportaGenitoreGiaGenitore',
    /** 409 — il CAS sul ruolo ha trovato zero righe: qualcuno è arrivato prima. */
    RIPORTA_GENITORE_GIA_DECISO: 'erroreRiportaGenitoreGiaDeciso',
    /**
     * 503 — le scansioni del documento non sono uscite dallo Storage, quindi
     * NESSUNA riga è stata cancellata.
     *
     * L'ordine è file → pratica → anagrafica, e questo codice è il punto in cui
     * ci si ferma se il primo passo non riesce. Cancellare le righe adesso
     * renderebbe quelle scansioni irraggiungibili invece che cancellate.
     */
    FASCICOLO_NON_CANCELLATO: 'erroreFascicoloNonCancellato',
    /**
     * 500 — il ramo `catch` delle route del personale.
     *
     * ⚠️ LA FRASE NON DICE «nessun dato è stato modificato», e la differenza è
     * onestà: un `catch` non sa a che punto si è fermato. Queste operazioni
     * toccano lo Storage, poi una RPC, poi `utenti`, e un'eccezione può
     * arrivare in mezzo. Dire «non è cambiato niente» sarebbe una promessa che
     * il codice non può mantenere; «ricarica e controlla com'è rimasta» è ciò
     * che serve davvero a chi ha appena premuto il bottone.
     */
    PERSONALE_OPERAZIONE_NON_RIUSCITA: 'errorePersonaleOperazioneNonRiuscita',
    /**
     * ─── LA CODA DELLE FATTURE (route `pagamenti/fattura/coda`, `…/azioni`, `…/sospensione`) ───
     *
     * 503 — la tabella della coda non esiste ancora (PGRST205/42P01): la migrazione non è
     * applicata. Non è un guasto dell'utente e non si finge un successo: nessuna voce è stata
     * toccata.
     */
    CODA_FATTURE_NON_DISPONIBILE: 'erroreCodaFattureNonDisponibile',
    /**
     * 500 — la scrittura sulla coda (accodamento, azione su voci, sospensione) è fallita.
     *
     * ⚠️ La frase NON promette «nessuna voce è cambiata»: su un accodamento di più voci il
     * `catch` non sa a che punto si è fermato. Manda a ricaricare e controllare.
     */
    CODA_FATTURE_SCRITTURA_FALLITA: 'erroreCodaFattureScritturaFallita',
    /** 400 — si chiede di mettere in coda la fattura di un pagamento non ancora `pagato`. */
    PAGAMENTO_NON_SALDATO: 'errorePagamentoNonSaldato',
    /** 400 — accodamento con un intestatario scritto a mano che `validaCessionario` rifiuta (consegna 2b, D1). */
    INTESTATARIO_DIGITATO_INCOMPLETO: 'erroreIntestatarioDigitatoIncompleto',
    /**
     * 409 — PATCH di un obiettivo della primaria col codice di un'altra riga della
     * stessa materia e classe (UNIQUE scuola_id, materia_codice, livello, codice).
     * Nessuna riga è stata modificata.
     */
    OBIETTIVO_CODICE_DUPLICATO: 'erroreObiettivoCodiceDuplicato',
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
    // Catena e anello sono due guai diversi e si sciolgono in modi diversi.
    'RETTA_CICLO_FRATELLI',
    'CLASSI_FUORI_SEDE',
    // I cinque della retta all'import portano tutti il NUMERO DEL BAMBINO
    // («Bambino 2: …»), che il catalogo non può conoscere. Con tre figli nella
    // stessa domanda, sapere che «una retta manca» senza sapere quale è
    // un'informazione che non si può usare: si riguardano tutti e tre.
    'RETTA_MANCANTE',
    'RETTA_ZERO',
    'RETTA_FRATELLO_NON_VALIDO',
    'RETTA_FRATELLO_SENZA_CIFRA',
    'INTESTATARIO_NON_VALIDO',
    // Stessa ragione dei cinque qui sopra: la prosa dice QUALE bambino («Bambino 2: …»).
    'ABBINAMENTO_NON_VALIDO',
    // Il NUMERO della fattura viva («Asilo 2328/2026»): senza, chi riceve il
    // rifiuto sa che c'è un documento di mezzo e non sa quale andare a guardare
    // — cioè non può fare la sola cosa che il messaggio gli chiede.
    'BONIFICO_GIA_FATTURATO',
    // Il NUMERO della fattura consumata («FPR 1949/2026»): la frase di catalogo
    // dice «non ripremere, verifica sul pannello Aruba», e senza il numero quel
    // controllo non si può fare — è l'unica cosa che dice QUALE documento cercare.
    'FATTURA_TRASPORTO_IGNOTO',
    // Il NOME FILE della fattura già partita: senza, chi riceve il rifiuto sa
    // solo che una fattura è partita, non quale andare a registrare.
    'FATTURA_PARTITA_NON_REGISTRATA',
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
