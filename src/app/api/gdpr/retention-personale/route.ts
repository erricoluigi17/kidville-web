import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { PERSONALE_LIMITI } from '@/lib/forms/personale-template'
// Le colonne che tengono il documento si LEGGONO dal template, non si ribattono: il
// riquadro che spiega perché sta più in basso, dove viveva la copia scritta a mano.
import { COLONNE_DOCUMENTO } from '@/lib/personale/percorso-documento'

/**
 * LA CONSERVAZIONE DELL'ANAGRAFICA DEL PERSONALE — scansione del documento
 * d'identità compresa.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ È UNA ROUTE E NON UNA FUNZIONE SQL ─────────────
 *
 * Il modulo pubblico `/anagrafica-personale` raccoglie di una dipendente il
 * codice fiscale, la residenza e **la fotografia del suo documento d'identità**.
 * La base giuridica non è il consenso — fra datore e dipendente non sarebbe
 * libero (art. 7 §4 e cons. 43) — ma l'esecuzione del contratto di lavoro
 * (art. 6.1.b) e gli obblighi legali del datore (art. 6.1.c: UNILAV, libro unico,
 * denunce INPS/INAIL, sostituto d'imposta). Nessuna di quelle due basi copre la
 * conservazione all'infinito, e nessuna norma impone al datore di custodire una
 * FOTOCOPIA: impone di identificare. Da qui i tre termini di questo file.
 *
 * Ed è una route HTTP e non una funzione SQL per la stessa ragione del gemello
 * `retention-candidature`: **i file si tolgono solo dalla Storage API**, e da
 * Postgres non ci si arriva. La versione SQL del bisnonno — la conservazione
 * delle domande d'iscrizione — nacque con un `DELETE FROM storage.objects`
 * dentro, e Postgres lo vieta (`42501`, trigger `protect_objects_delete`, FOR
 * EACH STATEMENT: scatta anche a zero righe). Sarebbe fallita dalla prima notte
 * e per sempre.
 *
 * ─── LE QUATTRO COSE CHE I GEMELLI HANNO GIÀ PAGATO ─────────────────────────
 *
 * 1. **PRIMA I FILE, POI LE RIGHE.** Al contrario, un errore a metà lascerebbe
 *    le scansioni dei documenti nell'archivio senza più nessuna riga che le
 *    nomini: invisibili, non cancellate — il modo peggiore di conservare il dato
 *    di una persona. E la rinuncia è PER PRATICA: una scansione che non esce
 *    trattiene **la sua** riga, non l'intero lotto.
 *
 *    ⚠️ VALE ANCHE PER L'UPDATE, e qui è più facile sbagliarsi che nel gemello:
 *    azzerare il percorso NON è una cancellazione più mite di una `DELETE`, è la
 *    stessa perdita di riferimento. Se si azzerasse la colonna prima di togliere
 *    il file, resterebbe un oggetto nel bucket che nessuna riga nomina più — e la
 *    volta dopo questo lavoro non saprebbe nemmeno che esiste.
 *
 * ─── DUE FACCE, E LA RIGA SI CHIUDE SOLO QUANDO ESCONO ENTRAMBE ─────────────
 *
 * Dal 12/08/2026 il documento d'identità si conserva fronte E retro
 * (`documento_fronte_path` e `documento_retro_path`, migrazione `20260812194501`;
 * `documento_path` non esiste più). Per questo lavoro non è un campo in più: è
 * l'unico posto del repo che toglie dal bucket la scansione di una persona dodici
 * mesi dopo la cessazione, e una route rimasta a un percorso solo avrebbe lasciato
 * il RETRO della carta d'identità di ogni dipendente cessata nell'archivio per
 * sempre — dichiarando `ok` ogni notte, perché il fronte usciva.
 *
 * Da lì tre regole, e nessuna è di stile:
 *
 *   · **`every`, NON `some`.** La riga si chiude solo quando TUTTI i suoi percorsi
 *     sono usciti (o erano già assenti). Con `some` basterebbe il fronte: le due
 *     colonne andrebbero a NULL mentre il retro è ancora nel bucket, e da quel
 *     momento nessuna riga lo nominerebbe più — nemmeno questo job, che parte
 *     proprio da quelle colonne. È «invisibile, non cancellato» applicato a metà
 *     documento, ed è peggio del caso a un file solo, perché l'altra metà DICHIARA
 *     il successo. Resta vera l'altra metà della regola: la rinuncia è PER RIGA,
 *     non per lotto.
 *   · **L'`UPDATE` azzera ENTRAMBE le colonne**, e solo su una riga chiudibile: una
 *     colonna azzerata e l'altra no è uno stato che nessuno ha deciso.
 *   · **Se anche UNA SOLA delle due colonne non si legge, il documento è IGNOTO** e
 *     non si tocca niente. Metà informazione non è informazione: il file che la
 *     colonna assente nominava esiste comunque.
 *
 * 2. **IL CONTEGGIO SI SCRIVE SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
 *    FALLIRE.** Nella versione SQL del bisnonno l'`INSERT` in `app_log` stava
 *    DOPO la `DELETE`: l'eccezione lo saltava, e la difesa che doveva accorgersi
 *    del guasto era a valle del guasto. Qui il battito sta in un `finally`. Con
 *    i soli errori, «nessun log» non distingue «tutto a posto» da «non è mai
 *    partito niente».
 *
 * 3. **RIGHE TRATTENUTE ⇒ 500.** Un 200 direbbe «fatto» a chi sorveglia il
 *    lavoro notturno, e la conservazione di quelle scansioni resterebbe scoperta
 *    senza che nessuno lo sappia.
 *
 * 4. **IL TERMINE APPLICATO È IL TERMINE PROMESSO.** I 90 giorni, i 12 mesi e i
 *    10 anni non sono numeri di questo file: sono `PERSONALE_LIMITI`, cioè quelli
 *    che il testo del consenso INTERPOLA nella frase che l'interessata legge e
 *    spunta — frase che finisce congelata in `pratiche_personale.consents_log`.
 *    Ribatterli qui significherebbe che il giorno in cui il titolare cambia
 *    termine il modulo promette una cosa e il cron ne applica un'altra, in
 *    silenzio, e su una promessa scritta (art. 13 §2 lett. a GDPR).
 *
 * ─── LE REGOLE, DECISE PER RIGA ─────────────────────────────────────────────
 *
 *   pratica MAI VALUTATA (`pending`, `in_approvazione`)
 *        → 90 giorni dalla RICEZIONE (`creata_il`): via il file, via la riga.
 *   pratica RESPINTA (`rifiutata`)
 *        → 90 giorni dalla DECISIONE (`evasa_il`): via il file, via la riga. E se
 *          la decisione non si legge — colonna assente, valore nullo, data rotta —
 *          **non si cancella**: ripiegare sulla ricezione anticiperebbe il termine
 *          promesso di tutto il tempo che la Segreteria ci ha messo a decidere.
 *   anagrafica con `cessato_il` valorizzata
 *        → a 12 mesi via le SOLE scansioni (prima i due file, poi entrambe le
 *          colonne a `null`);
 *        → a 10 anni via la riga intera, e CON LEI la pratica **approvata** che
 *          l'ha generata (`origine_pratica_id`).
 *   `cessato_il` NULL = rapporto in corso
 *        → non si cancella niente. Mai.
 *
 * E, dopo i file: **le righe di `caricamenti_personale` che li nominavano.** Quel
 * registro ha per chiave primaria il percorso e dice CHI ha caricato l'oggetto
 * (migrazione `20260811234334`, più `anagrafica_utente_id` da `20260812194501`).
 * Le sue due cascate lo puliscono da sé quando muore il proprietario — `pratica_id`
 * e `anagrafica_utente_id` sono entrambe `on delete cascade` — ma NON coprono il
 * caso centrale di questo job: a dodici mesi la scansione esce e l'anagrafica
 * RESTA, ancora nove anni. Senza la spazzata, quelle righe continuerebbero a
 * nominare oggetti che non esistono più.
 *
 * ─── LA PRATICA APPROVATA, E PERCHÉ NON POTEVA RESTARE PER SEMPRE ───────────
 *
 * Fino all'11/08/2026 questo riquadro dichiarava che la pratica approvata «questo
 * lavoro non la tocca», e chiudeva così: «se un giorno si vorrà farla scadere, il
 * termine va prima DICHIARATO in /privacy e poi applicato qui, in quest'ordine».
 * Era già dichiarato dieci righe più in là: `/privacy`, nella voce sulle richieste
 * di anagrafica, dice che «se la richiesta viene approvata i dati confluiscono nel
 * fascicolo del personale e seguono i termini indicati ai due punti precedenti» —
 * cioè dieci anni dalla cessazione. Il perimetro contraddiceva sé stesso, e
 * l'effetto MISURATO era che in tutto `src/` nessuna `.delete()` toccasse mai una
 * riga `approvata`: nome, codice fiscale, data e luogo di nascita, residenza,
 * domicilio, recapiti, estremi del documento e `consents_log` restavano in tabella
 * senza termine (rilievo del revisore, 2026-08-11).
 *
 * Ed è peggio del caso del gemello per un dettaglio di schema: `origine_pratica_id`
 * sta sul lato ANAGRAFICA (`on delete set null` verso `pratiche_personale`), quindi
 * cancellare l'anagrafica non si porta via la pratica — e distrugge l'unica riga che
 * sapeva quale fosse. Da lì due conseguenze operative, che non sono di stile:
 *
 *   · **LA PRATICA SI CANCELLA PRIMA DELLA SUA ANAGRAFICA.** Nell'ordine opposto,
 *     una seconda `delete` che fallisce lascia in tabella una copia completa
 *     dell'anagrafica di una persona e nessuna riga che la nomini: il giro dopo non
 *     saprebbe nemmeno cercarla. È lo stesso guasto del file rimasto nel bucket —
 *     invisibile, non cancellato — applicato a una riga invece che a un oggetto.
 *   · **SE `origine_pratica_id` NON SI PUÒ LEGGERE, non si chiude nessun
 *     fascicolo.** «Non so quale pratica appartenga a questa anagrafica» vale «non
 *     toccare», per la stessa ragione per cui vale sui percorsi del documento.
 *
 * ⚠️ RESTA FUORI, e si dichiara invece di scoprirlo fra sei mesi: la pratica
 * approvata che NESSUNA anagrafica cita. Oggi non può esistere — MISURATO
 * l'11/08/2026: in tutto `src/` non c'è una riga che scriva
 * `pratiche_personale.stato = 'approvata'` né una che scriva `anagrafica_personale`,
 * perché la route di approvazione della Segreteria non è ancora stata scritta.
 * Potrà nascere in due modi: se chi la scriverà dimenticherà `origine_pratica_id`,
 * o se l'utente verrà cancellato (`on delete cascade` da `utenti` porta via
 * l'anagrafica e con lei il legame). Il primo modo è chiuso da una prova
 * (`gdpr-retention-personale`: chi approva scrive il legame, o il lock è rosso); il
 * secondo è un debito misurato e scritto qui. Cancellare «tutte le approvate che
 * nessuno cita» sarebbe la strada facile e sbagliata: su un database in cui il
 * legame non fosse stato scritto porterebbe via il modulo d'origine di persone
 * ANCORA IN SERVIZIO, e su un'operazione irreversibile «non so» vale «non toccare».
 *
 * ─── COSA NON ENTRA NEI LOG, E PERCHÉ QUI CONTA PIÙ CHE ALTROVE ─────────────
 *
 * Il **percorso della scansione** e il nome del suo file. Il bucket è
 * `documenti_personale` e l'oggetto è la fotografia di una carta d'identità:
 * `app_log` è interrogabile in SQL per 30 giorni, e una riga che riportasse quel
 * percorso pubblicherebbe l'indirizzo di un documento d'identità dentro una
 * tabella di diagnosi. Niente percorsi, niente nomi di file, niente email,
 * niente codici fiscali, niente uuid di utente. Conteggi, esiti, codici d'errore.
 */

/**
 * Il nome con cui questo lavoro si presenta in `app_log` e in `JOB_CRON`.
 *
 * ⚠️ `retention-personale` e NON `personale-retention`, che sarebbe la forma dei
 * fratelli (`candidature-retention`, `iscrizioni-retention`,
 * `notifiche-retention`). La convenzione qui perde contro due fatti, entrambi
 * scritti prima di questo file: `personale-template.ts` dice «chi scriverà
 * `retention-personale` legga i termini da qui», e `JOB_CRON`
 * (`src/lib/health/controlli.ts`) porta la voce con quella grafia. Ed è la
 * grafia che conta, perché questa stringa è la CHIAVE con cui
 * `controlloBattitoCron` associa il battito al job: due nomi che si somigliano
 * sono peggio di un nome brutto — il job non verrebbe mai riconosciuto,
 * `/api/health` direbbe «job senza battito: retention-personale» dal primo
 * deploy e per sempre, e un allarme che suona da solo viene spento. Coincide per
 * giunta con il percorso della route.
 */
const JOB = 'retention-personale'

/**
 * NOVANTA GIORNI — la pratica non approvata, scansione compresa.
 *
 * Non è un numero scritto qui: è `PERSONALE_LIMITI.giorniPraticaNonApprovata`,
 * cioè il termine che il terzo blocco di consenso interpola nella frase «…ed
 * entro N giorni se questa richiesta non viene approvata». Chi compila quel
 * modulo legge quel numero: è la dichiarazione, non una nota interna.
 */
const GIORNI_PRATICA = PERSONALE_LIMITI.giorniPraticaNonApprovata

/**
 * DODICI MESI — la sola scansione, dopo la cessazione del rapporto.
 *
 * È il termine più corto dell'intero modulo, e ha una ragione: la copia del
 * documento è il pezzo con la base giuridica più fragile che questa Scuola
 * conservi. Nessuna norma impone al datore di custodire una fotocopia — impone
 * di IDENTIFICARE — e l'identificazione, cessato il rapporto, è finita.
 */
const MESI_DOCUMENTO = PERSONALE_LIMITI.mesiDocumentoDopoCessazione

/**
 * DIECI ANNI — il fascicolo anagrafico, dopo la cessazione.
 *
 * È il termine degli obblighi documentali del datore di lavoro (libro unico,
 * documentazione contributiva e fiscale: art. 2220 c.c. e normativa tributaria,
 * gli stessi dieci anni che l'informativa dichiara per i documenti contabili).
 */
const ANNI_FASCICOLO = PERSONALE_LIMITI.anniFascicoloDopoCessazione

/**
 * Il bucket delle scansioni. È `documenti_personale` e non `form_attachments`:
 * quello custodisce i documenti allegati alle domande d'iscrizione, cioè carte
 * d'identità di genitori e fotografie di MINORI. Due popolazioni, due basi
 * giuridiche, due termini — e tenerli insieme significherebbe che il risolutore
 * di percorso di un modulo può, sbagliando, cancellare l'oggetto dell'altro.
 */
const BUCKET_DOCUMENTI = 'documenti_personale'

/**
 * Gli stati in cui la pratica NON è stata accolta: **lì, e solo lì**, si cancella.
 *
 * È un elenco POSITIVO e non la negazione di `approvata`, e la differenza non è
 * di stile. Con `stato !== 'approvata'` uno stato NUOVO — introdotto domani da
 * chi aggiunge un passaggio al flusso di segreteria — cadrebbe da solo dentro
 * l'insieme di ciò che si cancella a novanta giorni, senza che nessuno l'abbia
 * deciso. Un elenco positivo sbaglia nel verso opposto: uno stato ignoto non si
 * tocca, e la riga resta finché qualcuno non aggiorna questa costante.
 */
const STATI_NON_APPROVATE = new Set(['pending', 'in_approvazione', 'rifiutata'])

/**
 * Gli stati in cui la richiesta è stata RESPINTA: **lì, e solo lì**, il termine
 * decorre dalla decisione invece che dalla ricezione.
 *
 * È la frase dell'informativa letta alla lettera («novanta giorni dalla
 * ricezione, o dalla decisione se la richiesta è stata respinta»), e la
 * distinzione non è teorica nemmeno qui, dove tutti gli stati trattati sono
 * «non approvati»: una riga `pending` con un `evasa_il` valorizzato — una
 * incoerenza che nessun percorso applicativo produce oggi, ma che una scrittura
 * a mano in SQL produce in un secondo — verrebbe conservata NOVANTA GIORNI OLTRE
 * il termine dichiarato. È il verso in cui il gemello ha sbagliato il 2026-08-10,
 * e la sua lezione va riusata: conservare oltre il termine promesso non è
 * prudenza, è il trattamento che l'art. 13 §2 lett. a non copre più.
 *
 * ⚠️ E LA DECORRENZA NON RIPIEGA SULL'ALTRA. Fino all'11/08/2026 una pratica
 * respinta senza `evasa_il` leggibile tornava a `creata_il`, e il `warn` del
 * ripiego dichiarava che «la ricezione è la data più vecchia: non si anticipa
 * nessuna cancellazione». È rovesciato, ed è aritmetica: `creata_il <= evasa_il`,
 * quindi il termine calcolato dalla data più VECCHIA scade PRIMA — di tutto il
 * tempo che la Segreteria ci ha messo a decidere. Su un database che avesse
 * `stato` e non `evasa_il` (il DB della CI, o una colonna caduta) se ne andavano
 * la pratica E la scansione della carta d'identità allegata, prima del termine che
 * l'informativa promette. Adesso una decorrenza illeggibile vale «non toccare» —
 * la stessa regola della data rotta, e il verso che `COLONNE_PRATICA_FACOLTATIVE`
 * dichiara per ogni assenza (rilievo del revisore, 2026-08-11).
 *
 * Il verso opposto — conservare più a lungo del promesso — resta un difetto, e per
 * questo non è silenzioso: le righe che restano indietro si contano e finiscono nel
 * battito (`n_pratiche_senza_riferimento`), con un `warn` che le dichiara. Una
 * `rifiutata` senza `evasa_il` è un'incoerenza da riparare alla fonte, non da
 * risolvere cancellando al buio.
 */
const STATI_RESPINTE = new Set(['rifiutata'])

/**
 * IL DB DELLA CI NON È MIGRATO, e il codice deve degradare in modo DICHIARATO.
 * Tabella assente ⇒ 503 con il codice, mai un 200 bugiardo: «non ho cancellato
 * niente perché la tabella non c'è» e «non c'era niente da cancellare» sono due
 * fatti diversi, e confonderli è esattamente il guasto invisibile.
 */
const CODICI_TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

/** Colonna assente ⇒ si ritenta senza, con un `warn` che la NOMINA. */
const CODICI_COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * LE DUE FACCE DEL DOCUMENTO, in un posto solo.
 *
 * Sono la stessa lista in tre punti diversi — le colonne che si leggono, quelle la
 * cui assenza rende il documento IGNOTO, quelle che l'`UPDATE` azzera — e in questo
 * repo una lista scritta tre volte diverge alla prima modifica. Il giorno in cui
 * qualcuno aggiungesse una terza faccia (il permesso di soggiorno ha due lati e un
 * timbro), da qui discenderebbe tutto il resto: se il nome nuovo finisse solo nella
 * `select`, il suo file uscirebbe dal bucket e la colonna continuerebbe a nominarlo.
 *
 * ⚠️ FINO AL 13/08/2026 QUESTA RIGA ERA UNA COPIA SCRITTA A MANO, e il commento qui
 * sopra la difendeva parlando di «un posto solo» che non era questo. La misura che
 * l'ha smentita: aggiunto un terzo campo `file` a `PERSONALE_FIELDS`, la suite dava
 * **136 test rossi in 14 file** e `gdpr-retention-personale` restava **93/93 verde**
 * — cioè una terza faccia sarebbe entrata dal modulo pubblico, sarebbe stata
 * archiviata, e la conservazione non l'avrebbe cancellata MAI, senza che un solo test
 * lo dicesse. Ora l'elenco si legge da `PERSONALE_FIELDS` come ovunque, e il lock
 * `__tests__/architecture/colonne-documento-un-posto-solo.test.ts` vieta la prossima
 * copia. L'ordine (fronte, poi retro) è quello del template, che è la stessa cosa
 * scritta una volta invece che due.
 *
 * ⚠️ L'ORDINE CONTA per una cosa sola, ed è la leggibilità dei percorsi passati a
 * `remove()`: fronte prima, retro poi. Non è un'invariante — nessun codice ci
 * poggia sopra — ma un lotto ordinato è un lotto che si legge in un log di Storage.
 *
 * L'import sta in cima al file, con gli altri: `COLONNE_DOCUMENTO` da
 * `@/lib/personale/percorso-documento`.
 */

/**
 * Le colonne che possono mancare su un database non migrato, tabella per
 * tabella. Nessuna di queste assenze autorizza a cancellare di più: quando
 * un'informazione non c'è si sceglie sempre il verso che CONSERVA.
 */
const COLONNE_PRATICA_FACOLTATIVE = [
    'evasa_il',
    ...COLONNE_DOCUMENTO,
] as const
const COLONNE_PRATICA_SEMPRE = ['id', 'stato', 'creata_il'] as const

const COLONNE_ANAGRAFICA_FACOLTATIVE = [
    'cessato_il',
    ...COLONNE_DOCUMENTO,
    // Il legame col modulo d'origine. È FACOLTATIVA come le altre due — un
    // database non migrato non ce l'ha — ma la sua assenza costa più delle altre:
    // senza, un fascicolo che scade porterebbe via l'anagrafica e lascerebbe in
    // `pratiche_personale` la copia che l'ha generata, irraggiungibile per sempre.
    'origine_pratica_id',
] as const
const COLONNE_ANAGRAFICA_SEMPRE = ['utente_id'] as const

/**
 * IL TETTO DEL LOTTO, e perché un giro senza tetto è un giro che a un certo
 * punto smette di funzionare senza dirlo.
 *
 * PostgREST ha un suo massimo di righe (`db-max-rows`) e la funzione ha un tempo
 * massimo: una lettura senza `.limit()` non è «tutte le righe», è «tutte finché
 * qualcun altro non decide di tagliare» — e il taglio di qualcun altro arriva
 * muto. Con un tetto ESPLICITO il taglio è nostro, si sa quand'è avvenuto
 * (`lotto_pieno` nel battito) e il giro dopo riprende dalle più vecchie, perché
 * entrambe le letture sono ordinate crescenti sulla loro data: la riga più in
 * ritardo è la prima a uscire, non l'ultima.
 */
const TETTO_LOTTO = 500

/**
 * QUANTI PERCORSI ENTRANO IN UNA SOLA `DELETE … .in('percorso', …)`.
 *
 * PostgREST mette i filtri nella QUERY STRING anche per la `DELETE`, e i percorsi
 * di questo job non hanno un tetto proprio: derivano dal lotto, che con due facce
 * arriva a ~3000 (500 pratiche×2 + 500 fascicoli×2 + 500 anagrafiche×2). Misurato
 * con `new URLSearchParams({percorso: 'in.("…","…")'})`, sui percorsi VERI
 * (`documenti/<uuid>/<uuid>.jpeg`, 88 caratteri) e al tetto del CHECK di colonna
 * (200 caratteri):
 *
 *   |  percorsi | reali (88 car.) | al CHECK (200 car.) |
 *   |-----------|-----------------|---------------------|
 *   |        25 |       2.540 byte|          5.340 byte |
 *   |        50 |       5.065 byte|         10.665 byte |
 *   |      3000 |     303.015 byte|        639.015 byte |
 *
 * Kong e nginx tagliano molto prima — 8 KB è il default del buffer di richiesta —
 * e la risposta è un 414 o un 400, cioè un errore di TRASPORTO che questo codice
 * vedrebbe come «registro non ripulito». Siccome quel guasto è un `warn` che non
 * ferma il giro (scelta dichiarata più sotto, e giusta), su un lotto pieno il
 * registro non si sarebbe ripulito MAI, in silenzio: l'esito esatto che la FASE 4
 * esiste per impedire.
 *
 * 25 tiene la riga di richiesta sotto gli 8 KB anche nel caso peggiore consentito
 * dal CHECK. È lo stesso numero di `TETTO_SPAZZATA` in `@/lib/personale/caricamenti`
 * — che spazza lo stesso registro — e la coincidenza è voluta: due tetti diversi
 * sulla stessa tabella sarebbero due numeri da rispiegare ogni volta.
 */
const TETTO_REGISTRO = 25

/** Le due facce, come arrivano da PostgREST: assenti se la colonna non c'è. */
type ConDocumento = {
    documento_fronte_path?: string | null
    documento_retro_path?: string | null
}

type Pratica = ConDocumento & {
    id: string
    stato?: string | null
    creata_il?: string | null
    evasa_il?: string | null
}

type Anagrafica = ConDocumento & {
    utente_id: string
    cessato_il?: string | null
    origine_pratica_id?: string | null
}

/**
 * Una riga da chiudere, tenuta legata ai SUOI file fino alla fine.
 *
 * `percorsi` è un ELENCO e non un percorso solo, ed è la modifica strutturale del
 * 12/08/2026: da qui discende che la riga si chiuda con `every` e non con `some`.
 * Può essere vuoto — una riga senza scansioni non ha niente da attendere.
 *
 * `legata` è l'id di un'ALTRA riga che deve sparire per prima: la usa la sola
 * anagrafica, e vi mette la pratica che l'ha generata. Serve perché il legame
 * `origine_pratica_id` muore con l'anagrafica: cancellare quest'ultima mentre la
 * sua pratica resta indietro — trattenuta dai propri file — lascerebbe in
 * `pratiche_personale` una copia integrale che nessuna riga nomina più.
 */
type RigaConFile = { chiave: string; percorsi: string[]; legata?: string | null }

const NIENTE_DA_TOGLIERE: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

/** Il codice PostgREST/Postgres dell'errore, se c'è. */
function codiceDi(errore: unknown): string {
    const c = (errore as { code?: unknown } | null)?.code
    return typeof c === 'string' ? c : ''
}

/**
 * Quali fra le colonne facoltative l'errore NOMINA. Non si legge il messaggio
 * grezzo per scriverlo nei log — si cerca dentro di esso un nome che conosciamo
 * già, così ciò che esce di qui è un valore chiuso e non testo di un terzo.
 * Se non se ne riconosce nessuna, si rinuncia a tutte: è il ripiego più
 * conservativo, e resta dichiarato nel `warn`.
 */
function colonneMancanti<C extends string>(errore: unknown, facoltative: readonly C[]): C[] {
    const testo = [
        (errore as { message?: unknown } | null)?.message,
        (errore as { details?: unknown } | null)?.details,
        (errore as { hint?: unknown } | null)?.hint,
    ]
        .map((v) => (typeof v === 'string' ? v : ''))
        .join(' ')
    const nominate = facoltative.filter((c) => testo.includes(c))
    return nominate.length > 0 ? [...nominate] : [...facoltative]
}

/** `data + n giorni`. */
function piuGiorni(data: Date, giorni: number): Date {
    const d = new Date(data.getTime())
    d.setDate(d.getDate() + giorni)
    return d
}

/** `data + n mesi`, con lo stesso arrotondamento di `Date.setMonth`. */
function piuMesi(data: Date, mesi: number): Date {
    const d = new Date(data.getTime())
    d.setMonth(d.getMonth() + mesi)
    return d
}

/** `data + n anni`. */
function piuAnni(data: Date, anni: number): Date {
    const d = new Date(data.getTime())
    d.setFullYear(d.getFullYear() + anni)
    return d
}

/** La data leggibile, o `null` se non lo è. */
function quando(v: unknown): Date | null {
    if (typeof v !== 'string' || v.trim() === '') return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t)
}

/**
 * Il valore testuale non vuoto, o `null`. Serve due volte, e la domanda è la
 * stessa: «questa riga nomina davvero qualcosa?». Vale per il percorso di una
 * scansione come per l'uuid della pratica d'origine — e la risposta sbagliata, in
 * entrambi i casi, è la stringa vuota scambiata per un nome, che manderebbe una
 * `remove('')` allo Storage o una `.in('id', [''])` a PostgREST.
 */
function testoDi(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * I percorsi che una riga nomina davvero: fronte, retro, o nessuno dei due.
 *
 * Il `Set` è igiene, e si dichiara per quello che è invece di farsi passare per una
 * difesa: nessuna delle due colonne è unica in tabella, e l'invariante «i due
 * percorsi non possono essere uguali» NON la impone il database. La impone una riga
 * sola, in un altro file, e si chiama per nome perché una difesa citata senza
 * indirizzo è una difesa che nessuno può verificare:
 *
 *     src/app/api/iscrizione/personale/route.ts
 *     if (new Set(percorsiDocumento).size !== percorsiDocumento.length) → 400
 *
 * cioè la route del modulo pubblico, PRIMA di inserire (`esito:
 * 'documento-facce-uguali'`). Una riga scritta a mano in SQL non ci passa, e può
 * quindi nominare due volte lo stesso oggetto.
 *
 * ⚠️ Fino al 12/08/2026 questa nota affermava la stessa cosa mentre il confronto
 * NON esisteva in tutto `src/`: descriveva una difesa immaginaria, che è la cosa
 * che CLAUDE.md chiama «peggio di nessun documento». Il confronto è stato scritto
 * quel giorno; se un domani sparisse, questa nota va riscritta prima — non dopo.
 *
 * Oggi la duplicazione non farebbe comunque danni qui (`tuttiIPercorsi` deduplica a
 * sua volta prima di chiamare `remove()`, e `every` su due elementi uguali risponde
 * come su uno), ma `percorsi` è l'elenco che risponde alla domanda «quanti file
 * nomina questa riga»: lasciarcene due identici lo renderebbe una risposta falsa
 * per il prossimo che se ne servirà.
 */
function percorsiDi(riga: ConDocumento): string[] {
    // ⚠️ LA LETTURA È PER CHIAVE DINAMICA, e il tipo largo vive QUI — su una riga sola,
    // dentro la funzione — invece di allargare `ConDocumento`.
    //
    // `COLONNE_DOCUMENTO` si legge da `PERSONALE_FIELDS` a runtime (è il punto del
    // modulo condiviso: il nome della colonna sta scritto in un posto solo), quindi per
    // TypeScript è `readonly string[]` e non l'unione delle due chiavi: `riga[c]` su un
    // tipo chiuso è `TS7053`, ed è stato un gate rosso il 13/08/2026.
    //
    // Allargare `ConDocumento` a un tipo con index signature avrebbe tolto il rosso in
    // un modo che costa caro altrove: `Pratica` e `Anagrafica` lo intersecano, e con una
    // chiave libera `testoDi(r.origine_pratica_idX)` compilerebbe restituendo `null` per
    // sempre — cioè il legame fascicolo→pratica si spezzerebbe in silenzio, che è
    // esattamente il guasto che `legata` esiste per impedire. I tipi restano chiusi; è
    // questa funzione a dichiarare che sta leggendo per chiave calcolata.
    //
    // Stessa forma già adottata in `src/app/api/iscrizione/personale/route.ts`, che
    // itera sulle stesse colonne su righe lette da PostgREST.
    const campi: Record<string, unknown> = riga
    return [
        ...new Set(
            COLONNE_DOCUMENTO.map((c) => testoDi(campi[c])).filter((p): p is string => p !== null),
        ),
    ]
}

// POST /api/gdpr/retention-personale
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-personale:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'

    // ── I CONTATORI DEL BATTITO ──
    // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
    // È il punto di tutto questo file: un log che dimostra il funzionamento non
    // può stare dentro la transazione che deve sorvegliare.
    let esitoBattito = 'ok'
    let nPratiche = 0
    let nPraticheFascicolo = 0
    let nAnagrafiche = 0
    let nScansioni = 0
    let nPraticheScadute = 0
    let nPraticheSenzaRiferimento = 0
    let nAnagraficheScadute = 0
    let nScansioniScadute = 0
    let nTrattenute = 0
    /**
     * Le righe del REGISTRO dei caricamenti tolte in questo giro. `null` quando il
     * numero NON È STATO MISURATO: «non l'ho misurato» e «erano zero» sono due
     * fatti diversi, ed è la distinzione che tutto questo file difende.
     *
     * Non misurato vuol dire due cose, ed entrambe scrivono `null`:
     *   · PostgREST non ha restituito il conteggio;
     *   · la spazzata è FALLITA, quindi non è mai arrivata in fondo.
     *
     * ⚠️ Il secondo caso è stato un difetto vero, ed è il motivo per cui questa nota
     * è così lunga. Il ramo d'errore della FASE 4 non toccava questa variabile: il
     * battito scriveva `n_registro: 0` sia quando la spazzata era riuscita senza
     * trovare nulla, sia quando era esplosa — indistinguibili proprio nell'unico
     * ramo in cui la distinzione serve, perché sul DB della CI (non migrato) e sulla
     * produzione fino all'11/08/2026 la tabella non c'è e l'errore è la norma. Chi
     * avesse letto `app_log` filtrando `esito = 'ok'` non avrebbe avuto modo di
     * sapere che la spazzata non era mai partita: la stessa classe di guasto del
     * `403` senza corpo (AGENTS §5), dentro il file che si vanta di averla evitata.
     *
     * `0` resta il valore di partenza, e ci resta a ragione: se dal bucket non è
     * uscito nessun file la spazzata non ha nulla da fare, e «zero righe tolte» è
     * una misura certa, non un'assenza di misura.
     */
    let nRegistro: number | null = 0
    let esito: EsitoRimozione = NIENTE_DA_TOGLIERE
    let nBloccanti = 0
    let documentoIgnoto = false
    let cessazioneIgnota = false
    let origineIgnota = false
    let lottoPieno = false
    let conteggioVerificato = false

    try {
        const secret = request.headers.get('x-cron-secret')
        const isCron = segretoCronValido(secret)
        if (!isCron) {
            // Si grida solo se l'header c'è ma non torna: quello è un cron che bussa
            // con la chiave sbagliata, ed è il guasto invisibile — smette di cancellare
            // e non lo dice a nessuno. Se manca del tutto è lo staff che lancia il giro
            // a mano, e il gate qui sotto è il suo.
            if (secret) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'secret-errato',
                    msg: process.env.CRON_SECRET
                        ? `${JOB}: x-cron-secret non corrispondente`
                        : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
                })
            }
            const auth = await requireStaff(request)
            if (auth.response) {
                esitoBattito = 'non-autorizzato'
                return auth.response
            }
            canale = 'manuale'
        }

        const supabase = await createAdminClient()
        const adesso = new Date()

        // ═══ FASE 1 · LE PRATICHE NON APPROVATE ══════════════════════════════
        //
        // Il TAGLIO GROSSOLANO si fa su `creata_il`, ed è corretto: il giorno di
        // riferimento non è mai anteriore alla ricezione (`evasa_il` viene dopo),
        // quindi nessuna pratica ricevuta da meno di 90 giorni può essere scaduta.
        // Il taglio FINE — per riga, con il suo riferimento — si fa in memoria
        // subito sotto, dove è leggibile e collaudabile.
        const sogliaPratiche = piuGiorni(adesso, -GIORNI_PRATICA)

        const leggiPratiche = (colonne: string) =>
            supabase
                .from('pratiche_personale')
                .select(colonne)
                // Elenco POSITIVO degli stati: vedi `STATI_NON_APPROVATE`. La stessa
                // condizione è ripetuta in memoria, e non è ridondanza inutile — è
                // ciò che rende la regola vera anche se qualcuno un giorno tocca la
                // query e non il filtro (o viceversa).
                .in('stato', [...STATI_NON_APPROVATE])
                .lt('creata_il', sogliaPratiche.toISOString())
                // Le più vecchie per prime: se il tetto taglia, taglia le meno in
                // ritardo. Con l'ordine opposto un lotto pieno lascerebbe indietro
                // per sempre proprio le pratiche scadute da più tempo.
                .order('creata_il', { ascending: true })
                .limit(TETTO_LOTTO)

        let colonnePratica = [...COLONNE_PRATICA_SEMPRE, ...COLONNE_PRATICA_FACOLTATIVE].join(', ')
        // PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un
        // guasto di lettura diventerebbe «nessuna pratica scaduta», cioè un giro a
        // vuoto che si dichiara riuscito.
        let { data: datiPratiche, error: erroreP } = await leggiPratiche(colonnePratica)

        if (erroreP && CODICI_COLONNA_ASSENTE.has(codiceDi(erroreP))) {
            const mancanti = colonneMancanti(erroreP, COLONNE_PRATICA_FACOLTATIVE)
            // ANCHE UNA SOLA basta: metà informazione non è informazione. Se manca il
            // retro, il fronte si legge benissimo — e cancellare la riga lascerebbe
            // nel bucket la seconda faccia di una carta d'identità che quella riga era
            // l'unica a nominare.
            if (COLONNE_DOCUMENTO.some((c) => mancanti.includes(c))) documentoIgnoto = true
            colonnePratica = [
                ...COLONNE_PRATICA_SEMPRE,
                ...COLONNE_PRATICA_FACOLTATIVE.filter((c) => !mancanti.includes(c)),
            ].join(', ')
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'colonna-assente',
                canale,
                entita_tipo: 'pratica',
                error_code: codiceDi(erroreP),
                msg:
                    `${JOB}: colonne assenti su pratiche_personale (${mancanti.join(', ')}), lettura ` +
                    `ritentata senza. Senza \`evasa_il\` le pratiche RESPINTE non si cancellano: il ` +
                    `loro termine decorre dalla decisione, e ripiegare sulla RICEZIONE — che è la ` +
                    `data più vecchia — le farebbe scadere PRIMA del termine promesso. Le altre ` +
                    `seguono la ricezione, che è già la loro decorrenza`,
            })
            ;({ data: datiPratiche, error: erroreP } = await leggiPratiche(colonnePratica))
        }

        if (erroreP) {
            const codice = codiceDi(erroreP)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                entita_tipo: 'pratica',
                error_code: codice,
                ms: Date.now() - t0,
                msg: tabellaAssente
                    ? `${JOB}: la tabella pratiche_personale non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                    : `${JOB}: lettura delle pratiche scadute non riuscita`,
            })
            // `{ ok, motivo }` e non `{ error }`: questa route la chiama pg_net, non
            // un browser. Una prosa italiana qui non la legge nessun utente — sarebbe
            // solo una stringa in più da tradurre.
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        // ═══ FASE 2 · LE ANAGRAFICHE DI CHI HA CESSATO ═══════════════════════
        //
        // Il taglio grossolano si fa sul termine PIÙ BREVE dei due (12 mesi): una
        // riga cessata da meno di così non ha niente da perdere, né la scansione né
        // il fascicolo. Col termine più lungo, tutte le cessazioni fra i 12 mesi e i
        // 10 anni non verrebbero MAI lette — quindi mai sbiancate — e il battito
        // continuerebbe a dire «ok, zero».
        //
        // `.lt('cessato_il', …)` esclude già le righe con `cessato_il` NULL (in SQL
        // un confronto con NULL non è mai vero), ma il rapporto in corso è la cosa
        // che questo lavoro non deve toccare per nessun motivo: la stessa condizione
        // è riverificata in memoria, dove un test la può misurare.
        const sogliaAnagrafiche = piuMesi(adesso, -MESI_DOCUMENTO)

        const leggiAnagrafiche = (colonne: string) =>
            supabase
                .from('anagrafica_personale')
                .select(colonne)
                .lt('cessato_il', sogliaAnagrafiche.toISOString())
                .order('cessato_il', { ascending: true })
                .limit(TETTO_LOTTO)

        let colonneAnagrafica = [
            ...COLONNE_ANAGRAFICA_SEMPRE,
            ...COLONNE_ANAGRAFICA_FACOLTATIVE,
        ].join(', ')
        let { data: datiAnagrafiche, error: erroreA } = await leggiAnagrafiche(colonneAnagrafica)

        if (erroreA && CODICI_COLONNA_ASSENTE.has(codiceDi(erroreA))) {
            const mancanti = colonneMancanti(erroreA, COLONNE_ANAGRAFICA_FACOLTATIVE)
            if (COLONNE_DOCUMENTO.some((c) => mancanti.includes(c))) documentoIgnoto = true
            if (mancanti.includes('cessato_il')) cessazioneIgnota = true
            if (mancanti.includes('origine_pratica_id')) origineIgnota = true
            colonneAnagrafica = [
                ...COLONNE_ANAGRAFICA_SEMPRE,
                ...COLONNE_ANAGRAFICA_FACOLTATIVE.filter((c) => !mancanti.includes(c)),
            ].join(', ')
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'colonna-assente',
                canale,
                entita_tipo: 'anagrafica',
                error_code: codiceDi(erroreA),
                msg: cessazioneIgnota
                    ? `${JOB}: colonne assenti su anagrafica_personale (${mancanti.join(', ')}). ` +
                      `Senza \`cessato_il\` non si sa chi abbia cessato e non esiste nemmeno la ` +
                      `condizione con cui selezionarlo: la lettura NON viene ritentata e nessuna ` +
                      `anagrafica viene toccata. Le pratiche seguono la loro strada`
                    : `${JOB}: colonne assenti su anagrafica_personale (${mancanti.join(', ')}), ` +
                      `lettura ritentata senza`,
            })
            if (cessazioneIgnota) {
                // ⚠️ NON SI RITENTA, e non è una rinuncia comoda: è l'unica forma in
                // cui il ripiego può funzionare.
                //
                // `cessato_il` non è soltanto una colonna della `select`: è anche il
                // `.lt()` e l'`.order()` di questa query. Togliendola dalla sola lista
                // delle colonne lette, PostgREST rialzerebbe **lo stesso `42703`** sul
                // filtro, `erroreA` resterebbe valorizzato e la route uscirebbe 500
                // `lettura-fallita` — mentre il `warn` qui sopra racconta una
                // degradazione pulita e il battito scrive `cessazione_ignota: true`.
                // Un ramo irraggiungibile che si descrive nei log è peggio di un ramo
                // che non c'è: chi cerca in `app_log` un giro degradato-ma-riuscito ne
                // troverebbe uno fallito, e non capirebbe perché. (Rilievo del
                // revisore del 2026-08-11; la prova che lo copriva era verde solo
                // perché la fixture faceva RIUSCIRE la seconda lettura, cosa che un
                // database senza quella colonna non fa mai.)
                //
                // Non si perde niente: senza `cessato_il` nessuna riga è databile,
                // quindi l'insieme delle anagrafiche scadute è vuoto per costruzione —
                // rileggere la tabella senza filtro servirebbe solo a portare in
                // memoria fino a 500 righe da scartare tutte, e a far scattare
                // `lotto_pieno` su un lotto che nessuno lavorerà.
                erroreA = null
                datiAnagrafiche = null
            } else {
                ;({ data: datiAnagrafiche, error: erroreA } =
                    await leggiAnagrafiche(colonneAnagrafica))
            }
        }

        if (erroreA) {
            const codice = codiceDi(erroreA)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                entita_tipo: 'anagrafica',
                error_code: codice,
                ms: Date.now() - t0,
                msg: tabellaAssente
                    ? `${JOB}: la tabella anagrafica_personale non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                    : `${JOB}: lettura delle anagrafiche cessate non riuscita`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        // ── IL TAGLIO FINE, per riga ──
        const pratiche = (datiPratiche ?? []) as unknown as Pratica[]
        const anagrafiche = (datiAnagrafiche ?? []) as unknown as Anagrafica[]
        lottoPieno = pratiche.length >= TETTO_LOTTO || anagrafiche.length >= TETTO_LOTTO

        const praticheScadute = pratiche.filter((r) => {
            const stato = typeof r.stato === 'string' ? r.stato : ''
            if (!STATI_NON_APPROVATE.has(stato)) return false
            // Il riferimento è la DECISIONE se la richiesta è stata RESPINTA, la
            // RICEZIONE in ogni altro caso — e NON si ripiega dall'una all'altra:
            // l'unica direzione possibile sarebbe verso la data più VECCHIA, cioè
            // verso una cancellazione ANTICIPATA. Vedi `STATI_RESPINTE`.
            const riferimento = STATI_RESPINTE.has(stato)
                ? quando(r.evasa_il)
                : quando(r.creata_il)
            // Riferimento illeggibile ⇒ non si cancella. Un dato mancante non è un
            // permesso: è un «non verificabile», e su un'operazione irreversibile
            // «non verificabile» vale «non toccare».
            if (!riferimento) {
                // Si conta, invece di sparire dentro un `false`: «zero righe
                // scadute» e «righe che non so datare» sono due fatti diversi, e
                // confonderli è la forma di guasto che questo file esiste per non
                // ripetere. Il numero finisce nel battito.
                nPraticheSenzaRiferimento++
                return false
            }
            return piuGiorni(riferimento, GIORNI_PRATICA).getTime() <= adesso.getTime()
        })
        nPraticheScadute = praticheScadute.length

        if (nPraticheSenzaRiferimento > 0) {
            // Trattenere oltre il termine promesso è a sua volta un difetto (art. 13
            // §2 lett. a), solo reversibile: quindi si sceglie, ma non in silenzio.
            // Nessun conteggio per riga e nessun id: chi indaga parte da qui e va a
            // guardare la tabella, non `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'riferimento-illeggibile',
                canale,
                n_pratiche_senza_riferimento: nPraticheSenzaRiferimento,
                msg:
                    `${JOB}: ${nPraticheSenzaRiferimento} pratiche non approvate senza una decorrenza ` +
                    `leggibile (una respinta senza data di decisione, o una data non interpretabile): ` +
                    `NON vengono cancellate, e restano oltre il termine dichiarato finché il dato non ` +
                    `viene riparato alla fonte`,
            })
        }

        // `cessato_il` NULL o illeggibile = rapporto in corso, o comunque non
        // databile: non si tocca niente. È la regola più importante di questo file,
        // perché è l'unica che protegge una persona ANCORA IN SERVIZIO.
        const cessate = anagrafiche
            .map((r) => ({ riga: r, cessato: quando(r.cessato_il) }))
            .filter((x): x is { riga: Anagrafica; cessato: Date } => x.cessato !== null)

        const anagraficheScadute = cessate
            .filter((x) => piuAnni(x.cessato, ANNI_FASCICOLO).getTime() <= adesso.getTime())
            .map((x) => x.riga)
        nAnagraficheScadute = anagraficheScadute.length

        // LE PRATICHE APPROVATE DEI FASCICOLI CHE SCADONO, raccolte ADESSO.
        //
        // Il legame vive sul lato anagrafica e muore con lei (`origine_pratica_id`,
        // `on delete set null` verso `pratiche_personale`): letto dopo la
        // cancellazione, non esisterebbe più. È la ragione per cui la riga della
        // pratica va chiusa nello stesso giro, e prima della sua anagrafica.
        const idPraticheFascicolo = [
            ...new Set(
                anagraficheScadute
                    .map((r) => testoDi(r.origine_pratica_id))
                    .filter((v): v is string => v !== null),
            ),
        ]

        const daCancellare = new Set(anagraficheScadute.map((r) => r.utente_id))
        // Lo sbiancamento riguarda SOLO chi non viene cancellato del tutto: sulla
        // riga che sta per sparire un `UPDATE` sarebbe lavoro doppio, e — peggio —
        // farebbe contare due volte lo stesso file.
        const scansioniScadute = cessate
            .filter(
                (x) =>
                    !daCancellare.has(x.riga.utente_id) &&
                    // «Ne nomina ALMENO UNO»: la riga col solo fronte (scritta prima
                    // del 12/08/2026 e portata lì dal `rename column`) e quella col
                    // solo retro sono entrambe da lavorare. Zero percorsi vuol dire
                    // che il giro precedente l'ha già sbiancata, e un `update` a
                    // vuoto gonfierebbe il conteggio dichiarato.
                    percorsiDi(x.riga).length > 0 &&
                    piuMesi(x.cessato, MESI_DOCUMENTO).getTime() <= adesso.getTime(),
            )
            .map((x) => x.riga)
        nScansioniScadute = scansioniScadute.length

        if (lottoPieno) {
            // Un lotto tagliato che rispondesse `ok` senza dirlo sarebbe un giro
            // riuscito a metà travestito da giro riuscito: il resto delle righe
            // scadute è ancora lì e nessuno lo saprebbe. L'esito resta `ok` — il
            // lavoro si riprende la notte dopo dalle più vecchie — ma il fatto è
            // scritto, ed è leggibile con una query su `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'lotto-pieno',
                canale,
                n_pratiche_lette: pratiche.length,
                n_anagrafiche_lette: anagrafiche.length,
                msg: `${JOB}: lotto al tetto di ${TETTO_LOTTO} righe, il giro successivo riprende dalle più vecchie`,
            })
        }

        // ── SENZA I PERCORSI DEL DOCUMENTO NON SI CANCELLA NIENTE ──
        //
        // Il difetto che questo blocco chiude, e che il gemello ha pagato per
        // davvero: se una delle colonne del documento finisce fra quelle assenti, la
        // seconda `select` la esclude, il suo valore è `undefined`, nessuna
        // `remove()` parte per quel file — e senza questo `return` le righe si
        // cancellerebbero LO STESSO. Risultato: scansioni di documenti d'identità nel
        // bucket senza più nessuna riga che le nomini, cioè «invisibili, non
        // cancellate», il modo peggiore di conservare un dato personale.
        //
        // ⚠️ BASTA UNA DELLE DUE, e da quando le facce sono due è il caso PROBABILE:
        // un database fermo a prima del 12/08/2026 ha il fronte (sotto il vecchio
        // nome) e non ha il retro. Leggere il solo fronte e cancellare vorrebbe dire
        // togliere la riga lasciando dentro il retro — che quella riga era l'unica a
        // nominare. Metà informazione non è informazione.
        //
        // Vale ANCHE per il ripiego di `colonneMancanti`, che quando non riconosce
        // nessun nome rinuncia a TUTTE le colonne facoltative: qualunque
        // `42703`/`PGRST204` che non sappiamo leggere finisce qui, e qui non si
        // cancella. È lo stesso verso di `rimuoviEVerifica`: «non so quali file
        // questa riga nomini» vale «li nomina», e su un'operazione irreversibile
        // «non so» vale «non toccare».
        //
        // ⚠️ LA STESSA REGOLA VALE PER `origine_pratica_id`, ed è il verso di errore
        // che il revisore ha trovato l'11/08/2026 sull'altra sponda: se il legame non
        // si può leggere, cancellare l'anagrafica lascerebbe in `pratiche_personale`
        // la copia integrale che l'ha generata — codice fiscale, nascita, residenza,
        // domicilio, recapiti, estremi del documento, `consents_log` — e nessuna riga
        // che sappia più a chi appartiene. Vale solo quando c'è davvero un fascicolo
        // da chiudere: senza anagrafiche scadute non c'è niente da orfanare, e un
        // ripiego che si allargasse oltre il proprio danno fermerebbe la
        // cancellazione delle pratiche a 90 giorni per un motivo che non le riguarda.
        const legameIgnoto = origineIgnota && nAnagraficheScadute > 0
        if (documentoIgnoto || legameIgnoto) {
            // `documento-ignoto` e non più `documento-path-ignoto`: la colonna
            // `documento_path` non esiste più, e un esito che la nomina manderebbe a
            // cercare in `information_schema` una colonna caduta il 12/08/2026.
            esitoBattito = documentoIgnoto ? 'documento-ignoto' : 'origine-pratica-ignota'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_pratiche_scadute: nPraticheScadute,
                n_anagrafiche_scadute: nAnagraficheScadute,
                ms: Date.now() - t0,
                msg: documentoIgnoto
                    ? `${JOB}: almeno una fra ${COLONNE_DOCUMENTO.join(' e ')} non esiste su questo ` +
                      `database, quindi non si sa quali scansioni ogni riga nomini: NESSUNA riga viene ` +
                      `toccata. Cancellarle lascerebbe i file nell'archivio senza più nulla che li nomini`
                    : `${JOB}: la colonna origine_pratica_id non esiste su questo database, quindi non si sa ` +
                      `quale pratica abbia generato ciascun fascicolo: NESSUNA riga viene toccata. ` +
                      `Chiudere il fascicolo lascerebbe la sua pratica in tabella senza più nulla che la nomini`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    motivo: esitoBattito,
                    pratiche: 0,
                    anagrafiche: 0,
                    scansioni: 0,
                    pratiche_scadute: nPraticheScadute,
                    anagrafiche_scadute: nAnagraficheScadute,
                },
                { status: 503 },
            )
        }

        // ═══ FASE 3 · LA PRATICA APPROVATA CHE HA GENERATO IL FASCICOLO ══════
        //
        // Si rilegge, invece di cancellarla per id e basta, per sapere una cosa
        // sola: **se porta ancora un file**. Per contratto non lo porta —
        // «all'approvazione l'oggetto NON si copia: l'anagrafica punta allo stesso
        // file e questa colonna torna NULL», commento di colonna della migrazione
        // `20260811205643` — ma cancellare una riga fidandosi di un contratto è
        // esattamente il modo in cui una fotografia di carta d'identità resta nel
        // bucket senza più nulla che la nomini. Il contratto lo scriverà una route
        // di approvazione che oggi non esiste ancora: verificarlo costa una lettura
        // per lotto, e solo nei giri in cui un fascicolo scade davvero.
        //
        // Un id che NON torna è una riga già sparita (cancellata a mano, o da un
        // giro precedente andato a metà): non è un errore, è il lavoro già fatto.
        const idPraticheScadute = new Set(praticheScadute.map((r) => r.id))
        let praticheFascicolo: Pratica[] = []
        if (idPraticheFascicolo.length > 0) {
            const { data, error } = await supabase
                .from('pratiche_personale')
                .select(['id', ...COLONNE_DOCUMENTO].join(', '))
                .in('id', idPraticheFascicolo)
            if (error) {
                const codice = codiceDi(error)
                const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
                esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica-fascicolo',
                    error_code: codice,
                    n_anagrafiche_scadute: nAnagraficheScadute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: lettura delle pratiche d'origine dei fascicoli scaduti non riuscita: nessuna riga viene toccata`,
                })
                return NextResponse.json(
                    { ok: false, motivo: esitoBattito, error_code: codice },
                    { status: tabellaAssente ? 503 : 500 },
                )
            }
            praticheFascicolo = ((data ?? []) as unknown as Pratica[]).filter(
                // Una riga già nell'insieme dei 90 giorni non si conta due volte: la
                // seconda `delete` toccherebbe zero righe e farebbe gridare
                // `conteggio-discorde` a un giro perfettamente riuscito.
                (r) => !idPraticheScadute.has(r.id),
            )
        }

        // Ogni riga resta legata ai SUOI file fino alla fine: è ciò che permette di
        // trattenere una riga sola invece dell'intero lotto.
        const praticheConFile: RigaConFile[] = praticheScadute.map((r) => ({
            chiave: r.id,
            percorsi: percorsiDi(r),
        }))
        const fascicoloConFile: RigaConFile[] = praticheFascicolo.map((r) => ({
            chiave: r.id,
            percorsi: percorsiDi(r),
        }))
        const anagraficheConFile: RigaConFile[] = anagraficheScadute.map((r) => ({
            chiave: r.utente_id,
            percorsi: percorsiDi(r),
            legata: testoDi(r.origine_pratica_id),
        }))
        const scansioniConFile: RigaConFile[] = scansioniScadute.map((r) => ({
            chiave: r.utente_id,
            percorsi: percorsiDi(r),
        }))

        // UNA CHIAMATA SOLA allo Storage, con dentro tutti i percorsi del lotto — e
        // deduplicata, perché due righe possono legittimamente nominare lo stesso
        // oggetto (la pratica approvata e il fascicolo che l'ha ereditata puntano
        // allo stesso file: «un oggetto, un proprietario» dice chi lo POSSIEDE, non
        // che nessun altro lo nomini durante il travaso).
        const tuttiIPercorsi = [
            ...new Set(
                [
                    ...praticheConFile,
                    ...fascicoloConFile,
                    ...anagraficheConFile,
                    ...scansioniConFile,
                ].flatMap((r) => r.percorsi),
            ),
        ]

        // ── PRIMA I FILE ──
        if (tuttiIPercorsi.length > 0) {
            esito = await rimuoviEVerifica(supabase, BUCKET_DOCUMENTI, tuttiIPercorsi, JOB)
            if (esito.erroreRimozione) {
                // La chiamata è fallita: nessun file è uscito e non c'è niente da
                // verificare. Toccare le righe adesso renderebbe le scansioni
                // irraggiungibili invece che cancellate. Si riprova il giro dopo.
                esitoBattito = 'file-non-rimossi'
                nTrattenute =
                    praticheConFile.length +
                    fascicoloConFile.length +
                    anagraficheConFile.length +
                    scansioniConFile.length
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    n_file: tuttiIPercorsi.length,
                    n_righe_trattenute: nTrattenute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione delle scansioni non riuscita, righe NON toccate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'allegati-non-rimossi',
                        pratiche: 0,
                        anagrafiche: 0,
                        scansioni: 0,
                        righe_trattenute: nTrattenute,
                        file: tuttiIPercorsi.length,
                    },
                    { status: 500 },
                )
            }
        }

        // Una scansione ancora nell'archivio — o che non si è potuto verificare —
        // trattiene la SUA riga, e soltanto quella.
        //
        // ⚠️ `every`, NON `some`, ed è la riga più importante di questo file. Con due
        // facce, la riga si chiude solo se sono usciti ENTRAMBI i file (o se erano
        // già assenti: `bloccanti` non comprende i `giaAssenti`, per i quali l'esito
        // voluto è raggiunto). Con `some` il fronte uscito basterebbe ad azzerare
        // tutt'e due le colonne, e il retro rimasto nel bucket non sarebbe più
        // nominato da nessuna riga — nemmeno dal giro successivo, che parte proprio
        // da quelle colonne. La fotografia della seconda faccia di una carta
        // d'identità resterebbe lì per sempre, dichiarata cancellata.
        //
        // `[].every(...)` è `true`: la riga senza scansioni è chiudibile, che è
        // esattamente ciò che diceva il vecchio `percorso === null ||`.
        const daNonToccare = new Set(bloccanti(esito))
        nBloccanti = daNonToccare.size
        const chiudibili = (righe: RigaConFile[]) =>
            righe.filter((r) => r.percorsi.every((p) => !daNonToccare.has(p)))

        const praticheChiudibili = chiudibili(praticheConFile)
        const fascicoloChiudibili = chiudibili(fascicoloConFile)
        const scansioniChiudibili = chiudibili(scansioniConFile)

        // ── UNA PRATICA TRATTENUTA TRATTIENE ANCHE LA SUA ANAGRAFICA ──
        //
        // L'ordine «prima la pratica, poi l'anagrafica» da solo non basta, e il
        // controesempio è concreto: se la scansione allegata alla pratica d'origine
        // non esce dall'archivio, quella riga viene trattenuta — e l'anagrafica, che
        // ha un file suo (o nessuno), sarebbe chiudibile. Cancellandola si perderebbe
        // `origine_pratica_id`, cioè l'unico puntatore alla pratica rimasta: un
        // orfano con dentro codice fiscale, nascita, residenza, domicilio, recapiti e
        // `consents_log`, che nessun giro successivo saprebbe più trovare.
        //
        // Una pratica che la lettura non ha nemmeno restituito NON trattiene niente:
        // quell'id non è in `fascicoloConFile`, ed è una riga già sparita.
        const fascicoloChiuse = new Set(fascicoloChiudibili.map((r) => r.chiave))
        const fascicoloTrattenute = new Set(
            fascicoloConFile.filter((r) => !fascicoloChiuse.has(r.chiave)).map((r) => r.chiave),
        )
        const anagraficheChiudibili = chiudibili(anagraficheConFile).filter(
            (r) => !(typeof r.legata === 'string' && fascicoloTrattenute.has(r.legata)),
        )

        nTrattenute =
            praticheConFile.length -
            praticheChiudibili.length +
            (fascicoloConFile.length - fascicoloChiudibili.length) +
            (anagraficheConFile.length - anagraficheChiudibili.length) +
            (scansioniConFile.length - scansioniChiudibili.length)

        // ── POI LE RIGHE ──
        //
        // `count: 'exact'` — e non è pignoleria. Senza, il numero che finisce nel
        // battito e nella risposta è quello delle righe che si INTENDEVA toccare:
        // questo file predica «si verifica lo STATO, non il conteggio» per i file, e
        // sulle righe darebbe per buona la propria intenzione.
        let conteggiChiesti = 0
        let conteggiOttenuti = 0
        let scartoConteggio = false

        const registraConteggio = (count: number | null, attese: number): number => {
            conteggiChiesti++
            if (typeof count !== 'number') return attese
            conteggiOttenuti++
            if (count !== attese) scartoConteggio = true
            return count
        }

        if (praticheChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('pratiche_personale')
                .delete({ count: 'exact' })
                .in('id', praticheChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica',
                    error_code: codiceDi(error),
                    n_pratiche: praticheChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse ma righe di pratiche_personale NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nPratiche = registraConteggio(count ?? null, praticheChiudibili.length)
        }

        // ── LA PRATICA D'ORIGINE, PRIMA DELLA SUA ANAGRAFICA ──
        //
        // L'ordine è la sostanza, non lo stile: `origine_pratica_id` vive sul lato
        // anagrafica e la `delete` della pratica lo azzera da sé (`on delete set
        // null`). Cancellando prima l'anagrafica, se questa `delete` fallisse
        // resterebbe in tabella la copia integrale di un'anagrafica e nessuna riga
        // che sappia più a chi appartiene: il giro dopo non saprebbe nemmeno
        // cercarla. In quest'ordine, invece, un guasto lascia l'anagrafica al suo
        // posto e la coppia si richiude la notte seguente.
        //
        // È un blocco separato da quello sopra, e non un unico `.in()`, perché i due
        // conteggi rispondono a due domande diverse — «quante richieste non
        // approvate sono scadute» e «quanti fascicoli si sono chiusi» — e sommarli
        // renderebbe il battito illeggibile proprio nel giro in cui serve.
        if (fascicoloChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('pratiche_personale')
                .delete({ count: 'exact' })
                .in('id', fascicoloChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica-fascicolo',
                    error_code: codiceDi(error),
                    n_pratiche_fascicolo: fascicoloChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg:
                        `${JOB}: pratiche d'origine dei fascicoli scaduti NON cancellate; le anagrafiche ` +
                        `restano al loro posto, così la coppia si richiude al giro successivo`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nPraticheFascicolo = registraConteggio(count ?? null, fascicoloChiudibili.length)
        }

        if (anagraficheChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('anagrafica_personale')
                .delete({ count: 'exact' })
                .in('utente_id', anagraficheChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'anagrafica',
                    error_code: codiceDi(error),
                    n_anagrafiche: anagraficheChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse ma righe di anagrafica_personale NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nAnagrafiche = registraConteggio(count ?? null, anagraficheChiudibili.length)
        }

        if (scansioniChiudibili.length > 0) {
            // L'UPDATE che DIMENTICA i file, e viene DOPO la loro rimozione. Il
            // rapporto di lavoro è finito da un anno ma il fascicolo resta ancora
            // nove: si toglie la sola copia del documento, e la riga sopravvive.
            //
            // ⚠️ ENTRAMBE LE COLONNE, sempre, anche quando la riga ne portava una
            // sola. Azzerare il solo campo che era valorizzato costerebbe uguale e
            // lascerebbe due stati diversi per lo stesso fatto — «documento
            // conservato» scritto in due modi — che è il genere di differenza che
            // fra un anno qualcuno interpreterà come significativa. E la riga arriva
            // qui solo se è CHIUDIBILE: entrambi i suoi file sono fuori dal bucket.
            const azzeraDocumento = Object.fromEntries(COLONNE_DOCUMENTO.map((c) => [c, null]))
            const { error, count } = await supabase
                .from('anagrafica_personale')
                .update(azzeraDocumento, { count: 'exact' })
                .in('utente_id', scansioniChiudibili.map((r) => r.chiave))
            if (error) {
                // Le scansioni sono USCITE e la colonna le nomina ancora: è il caso
                // in cui il prossimo giro troverà un percorso che non esiste più.
                // Non è una perdita di dati — `rimuoviEVerifica` tratta il file già
                // assente come esito raggiunto — ma è un guasto, e si dichiara.
                esitoBattito = 'scansioni-non-azzerate'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'anagrafica',
                    error_code: codiceDi(error),
                    n_scansioni: scansioniChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse dall'archivio ma i percorsi del documento NON azzerati`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'scansioni-non-azzerate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nScansioni = registraConteggio(count ?? null, scansioniChiudibili.length)
        }

        // ═══ FASE 4 · IL REGISTRO DEI CARICAMENTI ════════════════════════════
        //
        // `caricamenti_personale` ha per chiave primaria il PERCORSO e dice chi ha
        // caricato quell'oggetto. Le sue due cascate lo ripuliscono da sole quando il
        // proprietario muore (`pratica_id` e `anagrafica_utente_id`, entrambe
        // `on delete cascade`), ma il caso centrale di questo job non è una
        // cancellazione: a DODICI MESI la scansione esce dal bucket e l'anagrafica
        // resta in tabella ancora nove anni. Senza questo blocco, il registro
        // continuerebbe a nominare oggetti che non esistono più — e chi lo interroga
        // per rispondere a una richiesta di accesso leggerebbe l'elenco di file che
        // la Scuola custodisce di una persona, con dentro due che ha già cancellato.
        //
        // ── SI CANCELLA PER PERCORSO, E SOLO PER I FILE DAVVERO USCITI ──
        //
        // `rimossi` più `giaAssenti`: sono i due esiti in cui l'oggetto NON è più
        // nell'archivio (il secondo perché non c'era già). I `bloccanti` restano
        // fuori, ed è la stessa regola di sempre letta al contrario: finché il file è
        // lì dentro, la sua riga di registro è l'unica cosa che lo nomina per chiave,
        // e toglierla lo renderebbe irraggiungibile perfino alla spazzata degli
        // orfani. Per percorso e non per proprietario, così la regola vale identica
        // per le righe della pratica, per quelle dell'anagrafica e per quelle che un
        // travaso ha lasciato con il proprietario vecchio.
        //
        // ── E UN GUASTO QUI NON FERMA IL GIRO, al contrario di tutto il resto ──
        //
        // Il verso conservativo si sceglie sempre guardando QUALE dato resta
        // indietro. Ovunque in questo file il dato in ballo è una fotografia di carta
        // d'identità, e allora si trattiene tutto. Qui no: qui resta indietro una
        // riga che nomina un file GIÀ CANCELLATO. Rispondere 500 farebbe fallire ogni
        // notte un lavoro che ha appena tolto le scansioni dal bucket — e su un
        // database senza questa tabella (la CI, e la produzione fino a ieri) le
        // toglierebbe smettendo di dichiararlo. Perciò: `warn`, conteggio nel battito,
        // e il giro prosegue.
        const percorsiUsciti = [...esito.rimossi, ...esito.giaAssenti]
        if (percorsiUsciti.length > 0) {
            // A GRUPPI DI `TETTO_REGISTRO`, e non in una `.in()` sola: la ragione, con
            // i byte misurati, sta nella testata di quella costante.
            let tolte = 0
            let misurate = true
            let erroreRegistro: unknown = null
            let nonSpazzati = 0

            for (let i = 0; i < percorsiUsciti.length; i += TETTO_REGISTRO) {
                const gruppo = percorsiUsciti.slice(i, i + TETTO_REGISTRO)
                const { error, count } = await supabase
                    .from('caricamenti_personale')
                    .delete({ count: 'exact' })
                    .in('percorso', gruppo)
                if (error) {
                    // CI SI FERMA AL PRIMO ERRORE. Il caso che si presenta davvero è la
                    // tabella assente (la CI, che non è migrata): lì nessun gruppo
                    // successivo potrebbe riuscire, e insistere sarebbe una richiesta
                    // dietro l'altra verso lo stesso `PGRST205` — rumore nei log e
                    // tempo di funzione bruciato dentro un job che ha già fatto la
                    // parte che conta.
                    erroreRegistro = error
                    nonSpazzati = percorsiUsciti.length - i
                    break
                }
                // `count` assente non è `0`: è «non l'ho misurato», e basta un gruppo
                // muto perché la SOMMA smetta di essere una misura.
                if (typeof count === 'number') tolte += count
                else misurate = false
            }

            if (erroreRegistro) {
                const codice = codiceDi(erroreRegistro)
                // ⚠️ `null`, NON il parziale dei gruppi riusciti. La domanda a cui
                // `n_registro` risponde è «quante righe di registro sono state tolte in
                // questo giro», e con la spazzata interrotta a metà quella risposta non
                // si conosce. Il parziale non si butta però via: sta nel `warn` qui
                // sotto, dove è un dettaglio del guasto e non una misura del giro.
                nRegistro = null
                logEvento('cron', 'warn', {
                    operazione: JOB,
                    esito: 'registro-non-ripulito',
                    canale,
                    entita_tipo: 'caricamenti_personale',
                    error_code: codice,
                    n_file: percorsiUsciti.length,
                    // Quanti percorsi non sono stati nemmeno tentati: è il numero da cui
                    // si riparte per rimediare a mano, e senza di lui il `warn` dice che
                    // qualcosa è andato storto senza dire quanto.
                    n_percorsi_non_spazzati: nonSpazzati,
                    n_registro_parziale: tolte,
                    msg:
                        `${JOB}: le scansioni sono uscite dall'archivio ma le righe di ` +
                        `caricamenti_personale che le nominavano non sono state cancellate ` +
                        `(${codice || 'senza codice'}). Restano righe che nominano oggetti inesistenti: ` +
                        `è un difetto reversibile, e non ferma la conservazione — che ha già fatto la ` +
                        `parte irreversibile`,
                })
            } else {
                // `null` e non `0` quando PostgREST il conteggio non lo dà: qui non si
                // può ripiegare sul numero dei percorsi nominati — come fanno le altre
                // scritture — perché lo scarto è NORMALE, non anomalo. Un percorso
                // scritto prima che il registro esistesse (la produzione fino
                // all'11/08/2026) non ha nessuna riga da cancellare, quindi
                // «percorsi usciti» e «righe di registro tolte» sono due numeri che
                // non devono coincidere. Dichiarare l'intenzione al posto della misura
                // farebbe credere a una pulizia mai avvenuta.
                nRegistro = misurate ? tolte : null
            }
        }

        conteggioVerificato = conteggiChiesti > 0 && conteggiOttenuti === conteggiChiesti
        if (scartoConteggio) {
            // `.in('id', …)` non può toccare PIÙ righe di quante ne nomina: lo scarto
            // è sempre in difetto, e significa che quelle righe erano già sparite fra
            // la SELECT e la DELETE. Resta `warn` e non `error`, ma per la ragione
            // giusta: il fine di questo job — quelle righe non ci sono più — è
            // raggiunto comunque, e chiamare «errore» una retention riuscita è la
            // strada per far spegnere l'allarme. Ciò che questo `warn` garantisce è
            // che il numero dichiarato sia quello VERO e che lo scarto abbia un nome.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'conteggio-discorde',
                canale,
                n_pratiche: nPratiche,
                n_pratiche_fascicolo: nPraticheFascicolo,
                n_anagrafiche: nAnagrafiche,
                n_scansioni: nScansioni,
                msg: `${JOB}: toccate meno righe di quante ne erano state nominate; cercare una scrittura manuale in SQL o due giri sovrapposti. Si dichiara il numero vero`,
            })
        }

        if (nTrattenute > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto.
            esitoBattito = 'righe-trattenute'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_pratiche: nPratiche,
                n_pratiche_fascicolo: nPraticheFascicolo,
                n_anagrafiche: nAnagrafiche,
                n_scansioni: nScansioni,
                n_righe_trattenute: nTrattenute,
                n_file_bloccanti: nBloccanti,
                n_file_ancora_presenti: esito.ancoraPresenti.length,
                n_file_non_verificati: esito.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenute} righe NON chiuse, ${nBloccanti} scansioni ancora nell'archivio o non verificabili`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge il registro deve poter distinguere un archivio
                    // che non risponde da un file che non esce.
                    motivo:
                        esito.ancoraPresenti.length > 0
                            ? 'allegati-non-rimossi'
                            : 'verifica-non-riuscita',
                    pratiche: nPratiche,
                    pratiche_fascicolo: nPraticheFascicolo,
                    anagrafiche: nAnagrafiche,
                    scansioni: nScansioni,
                    righe_trattenute: nTrattenute,
                    file: esito.rimossi.length,
                    file_bloccanti: nBloccanti,
                },
                { status: 500 },
            )
        }

        return NextResponse.json({
            ok: true,
            pratiche: nPratiche,
            // Separato da `pratiche`, e non sommato: sono due termini diversi —
            // novanta giorni dalla richiesta non approvata, dieci anni dalla
            // cessazione per il modulo che ha generato il fascicolo. Un numero solo
            // renderebbe impossibile capire quale dei due sta lavorando.
            pratiche_fascicolo: nPraticheFascicolo,
            anagrafiche: nAnagrafiche,
            scansioni: nScansioni,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
            registro: nRegistro,
            // Il lotto tagliato si dichiara anche qui: chi lancia il giro a mano
            // deve sapere se richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            giorni_pratica: GIORNI_PRATICA,
            mesi_documento: MESI_DOCUMENTO,
            anni_fascicolo: ANNI_FASCICOLO,
        })
    } catch (error) {
        esitoBattito = 'eccezione'
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            ms: Date.now() - t0,
            msg: `${JOB}: eccezione non prevista`,
        })
        throw error
    } finally {
        // ── IL BATTITO ──
        // SEMPRE, anche a zero, anche quando tutto è fallito: è la riga che nella
        // versione SQL del bisnonno non veniva mai scritta.
        //
        // `esito: 'ok'` solo quando il giro ha davvero finito il lavoro, ed è
        // deliberato: `controlloBattitoCron` (`/api/health`) conta come battito i
        // soli esiti di `ESITI_BATTITO` — `ok` e `ok-parziale` — quindi un lavoro
        // che fallisce ogni notte diventa visibile come «job senza battito» oltre
        // la finestra. L'esito risponde a «è andata bene?», non a «di che cosa si
        // occupa».
        //
        // ⚠️ QUESTO GIRO NON SCRIVE MAI `ok-parziale`, e non è un dettaglio: il
        // terzo stato serve a chi salta una porzione di lavoro per una funzionalità
        // assente (è il caso di `notifiche-promemoria` con `locker_requests`).
        // Qui una fase saltata significa che una scansione di documento d'identità
        // è rimasta dov'era, e non esiste un modo mite di dirlo: gli esiti di
        // guasto qui sopra sono tutti nomi propri di ciò che non è stato tolto.
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            n_pratiche: nPratiche,
            n_pratiche_fascicolo: nPraticheFascicolo,
            n_anagrafiche: nAnagrafiche,
            n_scansioni: nScansioni,
            n_pratiche_scadute: nPraticheScadute,
            // Le pratiche non approvate che NON si sono potute datare, e che perciò
            // restano indietro. Sta accanto a `n_pratiche_scadute` di proposito:
            // insieme dicono «quante ne ho chiuse» e «quante non ho potuto
            // guardare», che è la distinzione senza la quale un `esito: ok` a zero
            // righe non significa niente.
            n_pratiche_senza_riferimento: nPraticheSenzaRiferimento,
            n_anagrafiche_scadute: nAnagraficheScadute,
            n_scansioni_scadute: nScansioniScadute,
            n_righe_trattenute: nTrattenute,
            n_file: esito.rimossi.length,
            n_file_gia_assenti: esito.giaAssenti.length,
            n_file_bloccanti: nBloccanti,
            // Le righe del registro dei caricamenti che nominavano i file usciti. Sta
            // accanto ai conteggi dei file e non a quelli delle righe perché risponde
            // a una domanda sui FILE: «di quanti oggetti spariti è rimasto il nome?».
            n_registro: nRegistro,
            giorni_pratica: GIORNI_PRATICA,
            mesi_documento: MESI_DOCUMENTO,
            anni_fascicolo: ANNI_FASCICOLO,
            documento_ignoto: documentoIgnoto,
            cessazione_ignota: cessazioneIgnota,
            // La colonna del LEGAME fra fascicolo e modulo d'origine. Si dichiara
            // anche quando non ha fermato niente (nessun fascicolo scaduto in questo
            // giro): è l'unico modo di distinguere, rileggendo `app_log`, «il
            // database ce l'ha» da «non c'era ancora niente da chiudere».
            origine_pratica_ignota: origineIgnota,
            lotto_pieno: lottoPieno,
            // `false` non vuol dire «il conteggio è sbagliato»: vuol dire che
            // PostgREST non l'ha restituito (o che non c'era niente da contare) e i
            // numeri qui accanto sono l'intenzione, non la misura. Distinguere le due
            // cose è tutto il punto di questo file.
            conteggio_verificato: conteggioVerificato,
            ms: Date.now() - t0,
            msg: `${JOB}: ${nPratiche} pratiche, ${nPraticheFascicolo} moduli d'origine, ${nAnagrafiche} anagrafiche e ${nScansioni} scansioni oltre il termine`,
        })
    }
})
