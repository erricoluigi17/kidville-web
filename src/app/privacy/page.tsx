import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicPageHeader } from '@/components/ui/PublicPageHeader';
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni';

// Pagina PUBBLICA (nessun login): informativa GDPR. Serve anche come
// "Privacy Policy URL" per gli store. È un server component statico: nessun
// dato personale, solo i riferimenti societari del Titolare (dati pubblici
// d'impresa), forniti dal Titolare stesso.
//
// Il recapito è lo stesso di /termini e /assistenza: una casella ORDINARIA, così
// un interessato può esercitare i suoi diritti scrivendo da un indirizzo
// qualunque (una PEC rifiuterebbe la posta ordinaria e la richiesta rimbalzerebbe).
//
// La ragione sociale è scritta PER ESTESO e non abbreviata: la User Data policy di
// Google Play pretende che «l'entità nominata nella scheda dello store compaia
// nell'informativa», e la scheda porta il nome come risulta da visura. Un
// «Soc. Coop.» qui e un nome completo là è una discrepanza che si paga in review.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVISIONE 2026-07-31 — testo riscritto applicando l'analisi di conformità
// prodotta il 30/07. Le tre correzioni sostanziali, e il perché:
//
//  1. BASE GIURIDICA DEI DATI SANITARI. Prima: consenso esplicito (art. 9.2.a).
//     Ora: interesse pubblico rilevante nell'istruzione (art. 9.2.g GDPR + art.
//     2-sexies, c. 2, lett. bb del Codice privacy). Il motivo non è formale: un
//     consenso «obbligato» non è libero — se non comunichi l'allergia la Scuola
//     non può preparare il pasto in sicurezza — e un consenso non libero NON è
//     una base giuridica valida. Fondarci sopra il trattamento di dati sanitari
//     di minori significherebbe trattarli senza base. Il consenso resta SOLO per
//     foto e video, dove il rifiuto non pregiudica nulla ed è quindi libero.
//  2. TRASFERIMENTI dichiarati per FORNITORE e non genericamente, e Apple/APNs
//     indicata come titolare autonomo per la consegna delle notifiche iOS: prima
//     era taciuta del tutto pur essendo un destinatario noto.
//  3. CONSERVAZIONE allineata agli obblighi archivistici che valgono anche per
//     le scuole paritarie (il fascicolo personale dell'alunno è a conservazione
//     illimitata): prima il criterio era generico e li sottostimava.
//
// ⚠️ VALIDAZIONE LEGALE ANCORA NECESSARIA. Il testo è redatto su fonti ufficiali
// verificate, ma NON è un parere legale e nessun professionista abilitato l'ha
// sottoscritto. Restano da confermare: la qualificazione art. 9.2.g per una
// paritaria, il termine di conservazione di diario e foto dopo l'uscita
// dell'alunno, e la riga finale del Passo 5 DSA di Apple.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recapito del Responsabile della protezione dei dati (RPD/DPO).
 *
 * `null` finché la nomina non è perfezionata, e in quel caso la sezione NON
 * viene pubblicata affatto. Scrivere «la Scuola ha designato un RPD» prima di
 * averlo designato sarebbe un'affermazione falsa dentro un documento legale — ed
 * è anche la più facile da smentire, perché la comunicazione del RPD al Garante
 * passa da una procedura telematica tracciata.
 *
 * Per attivarla: perfezionare la nomina (atto di designazione del CdA +
 * comunicazione al Garante su https://servizi.gpdp.it/comunicazionerpd/s/), poi
 * mettere qui il recapito dedicato. Nient'altro da toccare.
 */
const RPD_RECAPITO: string | null = null;

export const metadata: Metadata = {
  title: 'Informativa sulla privacy — Kidville',
  description:
    'Informativa sul trattamento dei dati personali (Reg. UE 2016/679) del registro elettronico Kidville.',
};

const H2 =
  'font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl';
const P = 'font-maven text-[15px] leading-relaxed text-kidville-ink';
const UL = `list-disc space-y-1.5 pl-5 ${P}`;

// `lang="it"` sul CONTENITORE, non sul documento: `layout.tsx` rende
// `<html lang={locale}>` e questa pagina NON passa da next-intl — il testo legale
// resta italiano per scelta (tradurlo senza validazione legale è un rischio
// maggiore che non tradurlo). Con l'app in inglese il documento risultava quindi
// `lang="en"` su un testo tutto italiano, e uno screen reader leggeva
// l'informativa sui dati dei minori con la pronuncia sbagliata: WCAG 3.1.2
// «Lingua delle parti». Il giorno in cui il testo verrà tradotto, questo attributo
// va tolto — il lock `pagine-legali` lo pretende, e fallisce se resta.
// `searchParams` serve al solo `?da=`: il percorso da cui si è arrivati, che la
// riga di testa usa come ritorno. `PublicPageHeader` lo filtra (solo percorsi
// interni), perché è un valore che scrive chiunque sappia comporre un URL.
export default async function PrivacyPage({ searchParams }: { searchParams?: Promise<{ da?: string }> }) {
  const { da } = (await searchParams) ?? {};

  return (
    <main lang="it" className="kv-public min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        {/* Riga di testa: ritorno + comando di ACCESSIBILITÀ, in un componente
            unico. Il comando di Alto Contrasto era già condiviso; il link di
            RITORNO no, ed è rimasto italiano a mano mentre l'altro si traduceva
            (R13). Ora la riga è UNA, e il ritorno torna dove il mittente dice
            (`?da=`), perché nel guscio nativo non ci sono schede da chiudere. */}
        <PublicPageHeader ritorno={da} />

        <article className="mt-6 rounded-card border border-kidville-line bg-white p-6 shadow-sm sm:p-8">
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-kidville-green sm:text-4xl">
            Informativa sulla privacy
          </h1>
          <p className="mt-3 font-maven text-base leading-relaxed text-kidville-ink">
            La presente informativa descrive come vengono trattati i dati personali degli utenti
            del registro elettronico <strong>Kidville</strong>, ai sensi del Regolamento (UE)
            2016/679 (&laquo;GDPR&raquo;) e del d.lgs. 196/2003 (&laquo;Codice privacy&raquo;). Il
            trattamento riguarda anche dati di minori, forniti dai genitori o dagli esercenti la
            responsabilità genitoriale; i minori non hanno un account e non accedono al servizio:
            gli utenti sono sempre adulti.
          </p>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Titolare del trattamento</h2>
            <p className={P}>
              Il Titolare del trattamento è{' '}
              <strong>SCUOLA DELL&rsquo;INFANZIA LA FAVOLA SOCIETA&rsquo; COOPERATIVA</strong>{' '}
              (di seguito anche &laquo;la Scuola&raquo;), P.IVA e codice fiscale{' '}
              <strong>03394870616</strong>, iscritta al Registro delle Imprese al n. REA{' '}
              <strong>CE 240763</strong>, con sede legale in{' '}
              <strong>Via Silvio Pellico 7, 81030 Cesa (CE), Italia</strong>. La Scuola è
              l&rsquo;ente che eroga il servizio educativo, anche presso le proprie sedi operative,
              e che pubblica l&rsquo;applicazione <strong>Kidville</strong>. Per ogni richiesta
              relativa al trattamento dei dati è possibile scrivere a{' '}
              <strong>info@kidville.it</strong>.
            </p>
          </section>

          {RPD_RECAPITO !== null && (
            <section className="mt-8 space-y-3">
              <h2 className={H2}>Responsabile della protezione dei dati</h2>
              <p className={P}>
                La Scuola ha designato un <strong>Responsabile della protezione dei dati</strong>{' '}
                (RPD/DPO), che può essere contattato per ogni questione relativa al trattamento dei
                dati personali e all&rsquo;esercizio dei diritti: <strong>{RPD_RECAPITO}</strong>.
              </p>
            </section>
          )}

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Tipologie di dati trattati</h2>
            <p className={P}>
              Nell&rsquo;ambito del servizio possono essere trattate le seguenti categorie di dati,
              inclusi <strong>dati riferiti a minori</strong>:
            </p>
            <ul className={UL}>
              <li>
                dati anagrafici del minore e dei genitori/tutori (nome, cognome, data e luogo di
                nascita, indirizzo di residenza, recapiti telefonici ed email, codice fiscale,
                estremi di un documento d&rsquo;identità);
              </li>
              <li>dati sulla frequenza: presenze, assenze, entrate e uscite, giustifiche;</li>
              <li>
                dati didattici: diario delle attività educative, note educative e, per la scuola
                primaria, le valutazioni;
              </li>
              <li>comunicazioni scuola-famiglia e messaggi con le insegnanti;</li>
              <li>
                eventuali <strong>dati relativi alla salute</strong> — allergie e intolleranze
                alimentari, certificati medici, indicazioni per la somministrazione dei pasti,
                informazioni su bisogni educativi speciali — quando necessari per la cura, la
                sicurezza e l&rsquo;inclusione del minore;
              </li>
              <li>
                <strong>fotografie e video</strong> del minore, solo se espressamente autorizzati
                dai genitori e <strong>solo sul canale autorizzato</strong> (galleria riservata,
                sito web pubblico, canali social: vedi &laquo;Base giuridica&raquo;);
              </li>
              <li>
                dati amministrativi e contabili: rette dovute, pagamenti registrati, metodo di
                pagamento e riferimento dell&rsquo;operazione, ticket mensa;
              </li>
              <li>
                dati tecnici: identificativi dell&rsquo;account e del dispositivo (compreso il
                token per le notifiche push), log di accesso e di utilizzo del servizio, dati
                diagnostici sul funzionamento dell&rsquo;applicazione.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Finalità del trattamento</h2>
            <ul className={UL}>
              <li>gestione del servizio educativo e organizzazione delle attività;</li>
              <li>comunicazioni tra scuola e famiglia, incluse le notifiche sul dispositivo;</li>
              <li>
                tutela della salute e della sicurezza del minore durante la permanenza a scuola;
              </li>
              <li>adempimenti amministrativi, contabili e fiscali connessi al rapporto;</li>
              <li>
                sicurezza del servizio, prevenzione degli abusi, diagnosi dei malfunzionamenti e
                assistenza agli utenti.
              </li>
            </ul>
            <p className={P}>
              I dati <strong>non</strong> sono utilizzati per pubblicità, marketing, profilazione o
              analisi del comportamento. L&rsquo;applicazione non contiene inserzioni pubblicitarie
              né strumenti di analisi comportamentale di terze parti.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Base giuridica</h2>
            <ul className={UL}>
              <li>
                per le <strong>attività educative e didattiche istituzionali</strong> — gestione
                delle presenze, del diario, delle valutazioni, delle comunicazioni scuola-famiglia
                — il trattamento è necessario per l&rsquo;esecuzione di un{' '}
                <strong>compito di interesse pubblico</strong> (art. 6, par. 1, lett. e GDPR): la
                Scuola, in quanto scuola paritaria, svolge un servizio pubblico ai sensi della
                legge 62/2000 e tratta i dati secondo la normativa scolastica di settore;
              </li>
              <li>
                per la <strong>gestione del rapporto di iscrizione</strong> e i relativi aspetti
                organizzativi e amministrativi, l&rsquo;
                <strong>esecuzione di un contratto</strong> o di misure precontrattuali (art. 6,
                par. 1, lett. b GDPR);
              </li>
              <li>
                per gli adempimenti amministrativi, contabili e fiscali, l&rsquo;
                <strong>obbligo legale</strong> (art. 6, par. 1, lett. c GDPR);
              </li>
              <li>
                per i <strong>dati relativi alla salute</strong> necessari alla sicurezza e
                all&rsquo;inclusione del minore — allergie e intolleranze ai fini della refezione,
                certificati medici, bisogni educativi speciali — il trattamento si fonda su{' '}
                <strong>motivi di interesse pubblico rilevante</strong> nel settore
                dell&rsquo;istruzione (art. 9, par. 2, lett. g GDPR e art. 2-sexies, comma 2, lett.
                bb del Codice privacy), secondo quanto previsto dalla normativa scolastica e
                sanitaria di settore: per questi trattamenti{' '}
                <strong>non viene richiesto il consenso</strong>, perché sono doverosi per la
                tutela del minore. Nelle situazioni di emergenza il trattamento può fondarsi sulla{' '}
                <strong>tutela di un interesse vitale</strong> del minore (art. 9, par. 2, lett. c
                GDPR);
              </li>
              <li>
                per la <strong>pubblicazione di fotografie e video</strong> del minore, il{' '}
                <strong>consenso</strong> dei genitori o degli esercenti la responsabilità
                genitoriale (art. 6, par. 1, lett. a GDPR), <strong>distinto per ciascun canale</strong>{' '}
                e revocabile in qualsiasi momento. I canali sono tre, e il consenso dato per uno{' '}
                <strong>non vale per gli altri</strong>:
                <ul className={UL}>
                  <li>
                    la <strong>galleria riservata</strong> dell&rsquo;applicazione, visibile alle
                    sole famiglie della sezione del minore, dopo aver effettuato l&rsquo;accesso;
                  </li>
                  <li>
                    il <strong>sito web della Scuola</strong> (sezione &laquo;News&raquo;): è un
                    canale <strong>pubblico</strong>, consultabile{' '}
                    <strong>da chiunque, senza alcun accesso</strong>, e i contenuti pubblicati
                    possono essere indicizzati dai motori di ricerca;
                  </li>
                  <li>
                    i <strong>canali social</strong> della Scuola: la pubblicazione avviene su
                    piattaforme di terzi, fuori dai sistemi della Scuola, e ai loro contenuti si
                    applicano anche le condizioni di quelle piattaforme.
                  </li>
                </ul>
                Senza il consenso relativo a un canale, su quel canale{' '}
                <strong>non viene pubblicata alcuna immagine del minore</strong>; il rifiuto di un
                canale non pregiudica gli altri.
              </li>
              <li>
                per i <strong>log tecnici</strong> e le attività di sicurezza e diagnosi, il{' '}
                <strong>legittimo interesse</strong> del Titolare a garantire la sicurezza della
                rete e dell&rsquo;informazione (art. 6, par. 1, lett. f e considerando 49 GDPR);
                l&rsquo;interessato può richiedere al Titolare le informazioni sul relativo
                bilanciamento.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Natura del conferimento</h2>
            <p className={P}>
              Il conferimento dei dati anagrafici, di quelli sulla frequenza e di quelli
              amministrativi è <strong>necessario</strong>: senza di essi la Scuola non può
              iscrivere il minore né erogare il servizio, e l&rsquo;accesso all&rsquo;applicazione
              non può essere attivato.
            </p>
            <p className={P}>
              È parimenti <strong>necessaria</strong> la comunicazione delle informazioni sulla
              salute indispensabili alla sicurezza del minore — in particolare allergie e
              intolleranze alimentari: la loro mancata comunicazione impedisce alla Scuola di
              predisporre in sicurezza il servizio di refezione.
            </p>
            <p className={P}>
              È invece <strong>facoltativo</strong> il conferimento delle fotografie e dei video:
              il rifiuto o la revoca del consenso non pregiudicano in alcun modo
              l&rsquo;iscrizione e la fruizione del servizio, ma impediscono la pubblicazione delle
              immagini del minore sul canale rifiutato. I consensi sono{' '}
              <strong>tre e separati</strong> — galleria riservata, sito web pubblico, canali
              social — e si possono accogliere o rifiutare uno per uno.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Destinatari dei dati</h2>
            <p className={P}>
              I dati sono accessibili al solo personale autorizzato e istruito per iscritto, nei
              limiti delle mansioni di ciascuno. Per far funzionare il servizio la Scuola si avvale
              di fornitori tecnici che agiscono come{' '}
              <strong>responsabili del trattamento</strong> ai sensi dell&rsquo;art. 28 GDPR,
              vincolati da accordi che impongono loro obblighi di protezione dei dati{' '}
              <strong>equivalenti a quelli previsti dalla presente informativa</strong> e dalla
              normativa applicabile:
            </p>
            <ul className={UL}>
              <li>
                <strong>Supabase</strong> — banca dati, autenticazione degli account e archiviazione
                dei file. I dati sono ospitati su infrastruttura situata in{' '}
                <strong>Irlanda</strong>;
              </li>
              <li>
                <strong>Vercel</strong> — pubblicazione ed esecuzione dell&rsquo;applicazione web;
              </li>
              <li>
                <strong>Google LLC</strong> (servizio Firebase Cloud Messaging) — recapito delle
                notifiche push sui dispositivi Android;
              </li>
              <li>
                <strong>Resend</strong> (Plus Five Five, Inc.) — invio dei messaggi di posta
                elettronica di servizio (credenziali, avvisi, comunicazioni);
              </li>
              <li>
                <strong>Aruba S.p.A.</strong> — trasmissione dei documenti fiscali al Sistema di
                Interscambio dell&rsquo;Agenzia delle Entrate, quando dovuta. Trattamento svolto in
                Italia.
              </li>
            </ul>
            <p className={P}>
              Sui dispositivi iOS il recapito delle notifiche push avviene tramite il servizio{' '}
              <strong>APNs di Apple</strong>, che opera quale{' '}
              <strong>autonomo titolare del trattamento</strong> per la consegna delle notifiche,
              secondo la propria informativa privacy.
            </p>
            <p className={P}>
              I dati possono inoltre essere comunicati alle autorità e agli enti pubblici cui la
              Scuola è tenuta a trasmetterli per obbligo di legge. I dati{' '}
              <strong>non sono ceduti o venduti a terzi</strong> per finalità commerciali, e non
              sono condivisi con intermediari pubblicitari o data broker.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Luogo del trattamento e trasferimenti verso Paesi terzi</h2>
            <p className={P}>
              La banca dati del servizio è ospitata all&rsquo;interno dello{' '}
              <strong>Spazio Economico Europeo</strong>, su infrastruttura situata in Irlanda.
            </p>
            <p className={P}>
              Alcune funzioni del servizio comportano tuttavia un trasferimento di dati personali
              verso Paesi terzi, con le seguenti garanzie previste dal Capo V del GDPR:
            </p>
            <ul className={UL}>
              <li>
                <strong>Google LLC</strong> (notifiche push Android), <strong>Vercel Inc.</strong>{' '}
                (esecuzione dell&rsquo;applicazione) e <strong>Resend</strong> (email di servizio)
                sono società statunitensi certificate al{' '}
                <strong>Quadro UE-USA per la protezione dei dati (Data Privacy Framework)</strong>,
                oggetto della decisione di adeguatezza della Commissione europea; i rispettivi
                accordi prevedono inoltre, in via ulteriore, le{' '}
                <strong>clausole contrattuali tipo</strong> approvate dalla Commissione;
              </li>
              <li>
                <strong>Supabase</strong>: i dati risiedono in Irlanda; eventuali accessi tecnici
                di supporto da parte di società del gruppo stabilite in Paesi terzi (Stati Uniti,
                Singapore) avvengono sulla base delle{' '}
                <strong>clausole contrattuali tipo</strong>;
              </li>
              <li>
                <strong>Apple</strong> (notifiche push iOS): gli eventuali trasferimenti extra-SEE
                sono regolati dalle <strong>clausole contrattuali tipo</strong> adottate dal gruppo
                Apple.
              </li>
            </ul>
            <p className={P}>
              Copia delle garanzie adottate può essere richiesta scrivendo a{' '}
              <strong>info@kidville.it</strong>.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Conservazione dei dati</h2>
            <p className={P}>
              I dati sono conservati per il tempo strettamente necessario alle finalità per cui
              sono stati raccolti, secondo i criteri seguenti:
            </p>
            <ul className={UL}>
              <li>
                <strong>dati anagrafici, didattici e sulla frequenza</strong>: per tutta la durata
                dell&rsquo;iscrizione e, successivamente, per il tempo imposto dagli obblighi di
                conservazione documentale previsti per le istituzioni scolastiche, anche paritarie,
                dal piano di conservazione degli archivi scolastici (alcuni documenti — in
                particolare il fascicolo personale dell&rsquo;alunno e le valutazioni — sono
                soggetti a conservazione illimitata per obbligo archivistico);
              </li>
              <li>
                <strong>domande di pre-iscrizione non accolte</strong> (in attesa di valutazione
                o respinte): <strong>ventiquattro mesi</strong> dalla data di invio della domanda,
                dopodiché la domanda e i documenti allegati — compreso il documento
                d&rsquo;identità — sono cancellati automaticamente. Se la domanda viene accolta,
                i dati confluiscono nella posizione dell&rsquo;alunno iscritto e seguono i tempi
                indicati al punto precedente;
              </li>
              {/*
                LA CANDIDATURA DI CHI CERCA LAVORO, E PERCHÉ I NUMERI SONO DUE.
                Il modulo pubblico «Lavora con noi» raccoglie nome, recapito e spesso il
                curriculum di una persona adulta. La base è l'art. 6.1.b (misure
                precontrattuali su sua richiesta): esaurita la valutazione, quella base non
                copre più niente, e restano dodici mesi. I ventiquattro esistono solo se la
                persona li ha chiesti spuntando il consenso facoltativo, il cui testo
                interpola `CANDIDATURA_LIMITI.mesiConservazione` — lo STESSO numero che
                `retention-candidature/route.ts` applica, importato e non ribattuto.
                Il lock `gdpr-retention-candidature.test.ts` confronta questa voce con
                quelle due costanti: promettere dodici mesi qui e ventiquattro nel codice è
                il difetto che questa riga esiste per impedire.
                CHI FA SCADERE QUESTA VOCE, dal 2026-08-10: il job `candidature-retention`
                (`5 5 * * *`, ogni notte), installato da
                `supabase/migrations/20260810204727_candidature_retention_cron.sql` e
                APPLICATO in produzione lo stesso giorno — `cron.job` lo riporta attivo.
                Chiama `POST /api/gdpr/retention-candidature`, che toglie prima il file dal
                bucket e poi la riga, e lascia il proprio battito in `app_log`: se smette di
                girare, `/api/health` lo dice entro 26 h col nome del job.
                ⚠️ Questa riga NON dice «automaticamente», e non è una svista. Il lock
                `informativa-conservazione-dichiarata` pretende che l'automa esista prima che
                l'informativa lo prometta; qui l'automa ora esiste, ma ciò che la persona ha
                diritto di sapere (art. 13 §2 lett. a) è il TERMINE, non il meccanismo. Se un
                giorno si vorrà scrivere «automaticamente», va aggiunta la voce in
                `AUTOMI_DICHIARATI` di quel lock: la parola tira con sé una prova.
              */}
              {/*
                ⚠️ LA COPIA IN CASELLA NON LA CANCELLA NESSUN CRON (19/08/2026).

                Fino a oggi questa voce era vera per intero: la candidatura viveva
                solo dentro l'applicazione, e il job di conservazione la portava via
                col suo curriculum. Dal 2026-08-19 ogni invio recapita alla casella
                del plesso una copia completa del modulo con il curriculum in
                allegato (`src/lib/candidature/copia-alla-sede.ts`), perché è dalla
                posta che la segreteria lavora.

                Quella copia il cron NON la tocca — non può: sta su un server di
                posta, non in questo database. Titolare e finalità non cambiano (le
                tre sedi sono la stessa cooperativa, e la persona ha scelto lei a
                quale scrivere), ma il TERMINE promesso non è più vero per quella
                copia, e una promessa che il codice non mantiene è peggio di una
                promessa non fatta.

                ⚠️ La frase nuova sta DENTRO questa stessa voce d'elenco, e non è
                pigrizia: il lock `gdpr-retention-candidature.test.ts` isola la voce
                che nomina «Lavora con noi» e ci pretende dentro i due termini in
                lettere e la parola «curriculum». Una frase messa in una voce
                ACCANTO sarebbe invisibile al lock — cioè potrebbe divergere dal
                codice senza che nessuno se ne accorga, che è precisamente il
                difetto che questo lock esiste per impedire.

                ⚠️ E in questo commento non si scrive il nome del tag di lista per
                esteso. Il lock spezza la sezione proprio su quel tag: scritto qui,
                crea un punto di taglio finto e gli fa isolare QUESTA PROSA invece
                della voce vera. Non è un'ipotesi — è successo scrivendo questo
                commento, e il lock ha risposto «l'informativa non dichiara i 12
                mesi» mentre li dichiarava due righe più sotto.
              */}
              <li>
                <strong>candidature spontanee di personale</strong> (modulo «Lavora con
                noi»): <strong>dodici mesi</strong> dalla ricezione, o dalla decisione se la
                candidatura non è accolta. Con il consenso della persona alla conservazione
                per opportunità future: <strong>ventiquattro mesi</strong>. Il curriculum
                allegato viene cancellato insieme alla candidatura. Al momento dell&rsquo;invio,
                però, una <strong>copia della candidatura con il curriculum allegato</strong>{' '}
                viene recapitata alla casella di posta della sede scelta, perché è la sede a
                doverla valutare: <strong>quella copia resta nella casella e non è cancellata
                dalla cancellazione automatica</strong>, che riguarda i dati archiviati
                nell&apos;applicazione e il file nel suo archivio. Per farla rimuovere si
                scrive alla segreteria della sede, o all&apos;indirizzo indicato in fondo a
                questa pagina;
              </li>
              {/*
                IL CURRICULUM CHE NON È DIVENTATO UNA CANDIDATURA — voce nuova del
                2026-08-15, ed è nuova perché fino a quel giorno non poteva esistere:
                nessuna rotta di caricamento produceva un curriculum, e il campo del
                modulo non veniva nemmeno reso.
                Adesso il file si carica PRIMA che la candidatura esista, quindi fra i
                due gesti c'è una persona che può chiudere la pagina. Quel file è un
                dato personale trattato, e l'art. 13 §2 lett. a pretende che il suo
                termine sia dichiarato: non ha una valutazione da cui far decorrere
                dodici mesi, perché una valutazione non c'è.
                ⚠️ VOCE SEPARATA di proposito, e non una frase in coda a quella qui
                sopra: il lock `gdpr-retention-candidature.test.ts` isola il <li> che
                nomina «Lavora con noi» e ne confronta i termini con le due costanti
                del codice. Infilarci dentro un terzo numero — «ventiquattro ore» —
                significherebbe far leggere a quel confronto una durata che non è un
                termine di conservazione della candidatura.
                CHI LA FA SCADERE: `spazzaCurriculumOrfani` in
                `gdpr/retention-candidature/route.ts`, che gira dentro lo stesso job
                notturno `candidature-retention`.
                Anche questa riga NON dice «automaticamente», per la stessa ragione
                scritta sopra: il lock `informativa-conservazione-dichiarata` lega
                quella parola a una voce in `AUTOMI_DICHIARATI`, e ciò che la persona
                ha diritto di sapere è il TERMINE, non il meccanismo.
              */}
              <li>
                <strong>curriculum caricato e mai inviato</strong> (il modulo è stato
                abbandonato prima della conferma finale): <strong>ventiquattro ore</strong>.
                Non essendo collegato a nessuna candidatura non ha una valutazione da cui
                far decorrere un termine, e viene rimosso dall&rsquo;archivio con la
                pulizia notturna;
              </li>
              {/*
                I TRE TERMINI DEL PERSONALE, E DA DOVE VENGONO I NUMERI.
                Non sono scritti qui e non sono scritti nel codice: sono `PERSONALE_LIMITI`
                (src/lib/forms/personale-template.ts), gli stessi che il TESTO del consenso
                interpola nella frase che l'interessata legge e spunta — «cancellata entro N
                mesi dalla cessazione, ed entro N giorni se questa richiesta non viene
                approvata» — e che `gdpr/retention-personale/route.ts` importa invece di
                ribattere. Il lock `gdpr-retention-personale.test.ts` confronta queste tre
                voci con quella costante: promettere dodici mesi qui e ventiquattro nel
                codice è il difetto che queste righe esistono per impedire.
                PERCHÉ TRE VOCI E NON UNA. Perché sono tre termini diversi su tre cose
                diverse, e il più corto è quello che regge di meno: nessuna norma impone al
                datore di conservare una FOTOCOPIA del documento — impone di identificare — e
                cessato il rapporto l'identificazione è finita. Annegare i dodici mesi dentro
                i dieci anni del fascicolo significherebbe dichiarare il termine lungo su un
                dato che ne ha uno breve.
                CHI LE FA SCADERE: il job `retention-personale`, che chiama
                `POST /api/gdpr/retention-personale` — toglie PRIMA il file dal bucket
                `documenti_personale` e POI la riga (o azzera `documento_fronte_path` e
                `documento_retro_path` — entrambe sempre, mai una sola — che è la stessa
                perdita di riferimento), e lascia il proprio battito in `app_log`.
                ⚠️ L'ULTIMA FRASE DELLA TERZA VOCE È STATA SCRITTA L'11/08/2026, e dice ciò
                che prima nessuno faceva. La voce diceva già che la richiesta approvata
                «segue i termini indicati ai due punti precedenti», ma MISURATO: in tutto
                `src/` non esisteva una `.delete()` che toccasse una riga `approvata` di
                `pratiche_personale` — la route leggeva i soli stati non approvati. Una
                richiesta accolta sarebbe rimasta in tabella per sempre, con codice fiscale,
                nascita, residenza, domicilio, recapiti, estremi del documento e la prova di
                presa visione, mentre questo documento le prometteva dieci anni. Ora la route
                la cancella INSIEME all'anagrafica che ne è nata (`origine_pratica_id`), e la
                cancella PRIMA di lei: nell'ordine opposto un guasto a metà lascerebbe la
                copia in tabella e nessuna riga che sappia più a chi appartiene. La frase è
                esplicita perché il termine più lungo di tutti non si deduce da un rimando.
                ⚠️ QUESTE TRE VOCI NON DICONO «automaticamente», e non è una svista: il lock
                `informativa-conservazione-dichiarata` pretende che l'automa esista — e sia
                APPLICATO al database — prima che l'informativa lo prometta. Ciò che la
                persona ha diritto di sapere (art. 13 §2 lett. a) è il TERMINE, non il
                meccanismo. Il giorno in cui la migrazione
                `..._retention_personale_cron.sql` sarà applicata e attestata, si potrà
                aggiungere la parola insieme alla voce in `AUTOMI_DICHIARATI` di quel lock:
                la parola tira con sé una prova.
                ⚠️ E LA SOSTITUZIONE DELLA COPIA NON È PIÙ PROMESSA — c'era, ed è stata TOLTA
                l'11/08/2026, per la stessa ragione per cui manca «automaticamente».
                Questa voce e il paragrafo della sezione sul personale dicevano che la copia
                del documento «viene sostituita, con cancellazione della precedente, appena
                l'interessata ne consegna una nuova». MISURATO: in tutto `src/` non esiste una
                sola riga che scriva le colonne del documento di `anagrafica_personale`
                (l'unica scrittura su quelle colonne è l'azzeramento di `retention-personale`),
                e nessuna `remove()` sul bucket `documenti_personale` vive fuori da quel job.
                ⚠️ Dal 12/08/2026 le colonne sono DUE — `documento_fronte_path` e
                `documento_retro_path`, prima era la sola `documento_path` — e questo raddoppia
                il numero di file che una sostituzione lascerebbe indietro, non lo dimezza.
                Il giorno in cui la route di approvazione sovrascriverà un percorso con la
                scansione nuova di una persona, il file precedente resterà nel bucket senza più
                nessuna riga che lo nomini: `retention-personale` legge quelle due colonne, e
                puntano ormai ai nuovi. Una fotografia di carta d'identità conservata per
                sempre e irrintracciabile — «invisibile, non cancellata», che è la definizione
                di guasto peggiore secondo la testata di quella route. Era per giunta il termine
                a base giuridica più fragile: nessuna norma impone al datore di custodire una
                FOTOCOPIA.
                Il divieto non è affidato alla memoria di chi rilegge: `gdpr-retention-personale`
                ha una prova che va rossa se la frase torna qui o nel testo del consenso
                (`personale-template.ts`) senza che nel repo esista chi rimuove la copia
                precedente. Chi scriverà quel meccanismo rimetta la frase: la prova diventa
                verde da sé, ed è quello il momento in cui la promessa è vera.
              */}
              <li>
                <strong>dati anagrafici del personale</strong> della Scuola (fascicolo di
                dipendenti e collaboratori): <strong>dieci anni</strong> dalla cessazione del
                rapporto di lavoro, in ragione degli obblighi documentali, contributivi e
                fiscali che gravano sul datore;
              </li>
              <li>
                <strong>copia del documento d&rsquo;identità del personale</strong>:{' '}
                <strong>dodici mesi</strong> dalla cessazione del rapporto. È il termine più breve
                di questa sezione perché la copia serve soltanto a identificare la persona per gli
                adempimenti obbligatori, e cessato il rapporto quella finalità è esaurita;
              </li>
              <li>
                <strong>richieste di anagrafica del personale non approvate</strong> (in attesa di
                valutazione o respinte): <strong>novanta giorni</strong> dalla ricezione, o dalla
                decisione se la richiesta è stata respinta, dopodiché la richiesta e la copia del
                documento allegata sono cancellate. Se la richiesta viene approvata, i dati
                confluiscono nel fascicolo del personale e seguono i termini indicati ai due punti
                precedenti: la richiesta stessa, che resta agli atti come prova di come quei dati
                sono stati raccolti, è cancellata <strong>insieme al fascicolo</strong>, cioè a{' '}
                <strong>dieci anni</strong> dalla cessazione del rapporto;
              </li>
              <li>
                <strong>documenti contabili e fiscali</strong>: <strong>dieci anni</strong>, come
                previsto dall&rsquo;art. 2220 del Codice civile e dalla normativa tributaria;
              </li>
              <li>
                <strong>dati relativi alla salute</strong>: per il tempo necessario alla finalità
                che ne ha giustificato la raccolta e comunque non oltre la durata
                dell&rsquo;iscrizione, salvi i documenti che confluiscono nel fascicolo
                dell&rsquo;alunno soggetti agli obblighi archivistici di cui sopra;
              </li>
              {/*
                LA PAROLA È TORNATA, E IL GIORNO IN CUI SE L'È GUADAGNATA.
                Questa voce è nata dicendo «cancellato AUTOMATICAMENTE» quando la macchina che
                lo fa non esisteva ancora in produzione: la parola è stata TOLTA il 2026-08-07
                (commit 9e36055) e RIMESSA lo stesso giorno, poche ore dopo, quando la
                migrazione 20260807211157_presenze_retention_motivo_assenza.sql è stata
                applicata davvero.
                La prova non è il «success» dello strumento: `presenze_giustificazioni_retention_tick`
                è in `pg_proc`, `presenze-giustificazioni-retention` è in `cron.job` («59 4 * * *»,
                attivo) e la corsa una tantum ha lasciato in `app_log` la sua riga con n_righe = 0.
                Il lock __tests__/architecture/informativa-conservazione-dichiarata.test.ts tiene
                insieme le tre cose: i dodici mesi qui e nella migrazione devono essere lo stesso
                numero, il job dev'essere installato da un `cron.schedule`, e quella migrazione
                non dev'essere marcata «NON APPLICATA». Se un giorno il job sparisse, questa
                riga diventerebbe rossa prima di diventare una bugia.
              */}
              <li>
                <strong>motivo dell&rsquo;assenza</strong> comunicato o scritto dalla famiglia, e
                note dell&rsquo;appello del personale docente: <strong>dodici mesi</strong> dal
                giorno dell&rsquo;assenza e comunque non oltre la fine dell&rsquo;iscrizione,
                dopodiché il testo è cancellato automaticamente. Resta la registrazione della presenza o
                dell&rsquo;assenza, che è un dato sulla frequenza e segue i tempi indicati al
                primo punto;
              </li>
              <li>
                <strong>fotografie e video</strong>: fino alla revoca del consenso e comunque non
                oltre la durata dell&rsquo;iscrizione;
              </li>
              <li>
                <strong>log tecnici di accesso e di utilizzo</strong>: <strong>30 giorni</strong>,
                dopodiché sono cancellati automaticamente;
              </li>
              <li>
                <strong>copia locale dei dati sul dispositivo</strong> (funzionamento senza
                connessione): <strong>sette giorni</strong>, e comunque fino all&rsquo;uscita
                dall&rsquo;account.
              </li>
            </ul>
            <p className={P}>
              Al termine dei periodi indicati i dati sono cancellati oppure resi anonimi in modo
              irreversibile.
            </p>
          </section>

          {/*
            LA CATEGORIA DI INTERESSATI CHE QUESTA INFORMATIVA NON AVEVA.
            Fino alla versione 2026-08-10 questo documento parlava di minori, di genitori e
            — dal 10 agosto — di chi si candida a un lavoro. Del PERSONALE IN SERVIZIO non
            diceva niente, e dall'11/08/2026 la Scuola ne raccoglie l'anagrafica completa
            con un modulo pubblico (`/anagrafica-personale`), compresa la scansione del
            documento d'identità. Una categoria di interessati che non trova sé stessa
            nell'informativa non è una lacuna redazionale: è l'art. 13 non adempiuto verso
            le persone che quei dati li stanno consegnando.
            PERCHÉ NON SI CHIEDE IL CONSENSO, ed è scritto nel testo e non solo qui: fra
            datore e dipendente il potere è squilibrato per presunzione, e un consenso che
            non si può rifiutare senza mettere a rischio il rapporto non è libero (art. 7
            §4 e cons. 43 GDPR). Chi ci si appoggiasse tratterebbe quei dati credendo di
            avere una base e non avendola. Le basi vere sono due, e sono NOMINATE.
            ⚠️ QUESTA SEZIONE STA DOPO «Conservazione dei dati», E NON PUÒ STARE PRIMA.
            Non è una scelta editoriale: `informativa-conservazione-dichiarata.test.ts`
            ritaglia la sezione della conservazione con
            `indexOf('Conservazione dei dati')` sul FILE INTERO, e il testo qui sotto la
            cita per rimando. Messa più in alto, quel rimando diventava l'inizio del
            ritaglio e il lock finiva per contare i `<li>` di QUESTA sezione: misurato,
            2 voci invece di 9, con due prove rosse. Chi riordina le sezioni sposti anche
            il rimando, o tenga questa dopo.
          */}
          <section className="mt-8 space-y-3">
            <h2 className={H2}>Personale della Scuola (dipendenti e collaboratori)</h2>
            <p className={P}>
              Questa sezione riguarda le <strong>persone che lavorano per la Scuola</strong> —
              insegnanti, educatrici, personale ausiliario e amministrativo, collaboratori — e non
              i minori né le loro famiglie. I dati sono raccolti dalla Segreteria o tramite il
              modulo di <strong>anagrafica del personale</strong>, e diventano parte del fascicolo
              solo dopo che la Segreteria o la Direzione hanno verificato e approvato la richiesta.
            </p>
            <p className={P}>Le categorie di dati trattate sono:</p>
            <ul className={UL}>
              <li>
                dati anagrafici e identificativi: nome, cognome, sesso, data e luogo di nascita,
                cittadinanza, codice fiscale;
              </li>
              <li>residenza, domicilio e recapiti (indirizzo email e numero di telefono);</li>
              <li>
                estremi e <strong>copia del documento d&rsquo;identità</strong>, con la relativa
                data di scadenza;
              </li>
              <li>
                titolo di studio e fasce d&rsquo;età su cui si presta servizio, necessari a
                configurare le funzioni dell&rsquo;applicazione;
              </li>
              <li>
                nominativo e recapito di una persona da avvisare in caso di urgenza, se
                l&rsquo;interessata sceglie di indicarli: il conferimento è{' '}
                <strong>facoltativo</strong>, perché sono dati di un terzo.
              </li>
            </ul>
            <p className={P}>
              La Scuola <strong>non chiede</strong>, con questi moduli, dati relativi alla salute o
              all&rsquo;idoneità sanitaria, dati giudiziari, il permesso di soggiorno, lo stato
              civile o i carichi di famiglia, la firma autografa e le coordinate bancarie.
            </p>
            <p className={P}>Le basi giuridiche sono due, e nessuna delle due è il consenso:</p>
            <ul className={UL}>
              <li>
                l&rsquo;<strong>esecuzione del contratto di lavoro</strong> di cui
                l&rsquo;interessata è parte (<strong>art. 6, par. 1, lett. b GDPR</strong>);
              </li>
              <li>
                l&rsquo;adempimento di <strong>obblighi legali</strong> a cui la Scuola è soggetta
                in quanto datore di lavoro (<strong>art. 6, par. 1, lett. c GDPR</strong>): la
                comunicazione obbligatoria di instaurazione, trasformazione e cessazione del
                rapporto (<strong>UNILAV</strong>), la tenuta del{' '}
                <strong>libro unico del lavoro</strong>, le denunce contributive e assicurative a{' '}
                <strong>INPS e INAIL</strong> e gli adempimenti della Scuola quale{' '}
                <strong>sostituto d&rsquo;imposta</strong>.
              </li>
            </ul>
            <p className={P}>
              La <strong>copia del documento d&rsquo;identità</strong> è chiesta per
              l&rsquo;identificazione certa della persona ai fini di quegli adempimenti: è
              conservata separatamente dal resto del fascicolo e ha il termine di conservazione più
              breve fra i dati di questa sezione (vedi &laquo;Conservazione dei dati&raquo;). Il
              conferimento dei dati anagrafici e della copia del documento è{' '}
              <strong>necessario</strong>: senza, la Scuola non può eseguire gli adempimenti
              obbligatori sopra indicati.
            </p>
            <p className={P}>
              Oltre al personale interno autorizzato, i dati di questa sezione possono essere
              comunicati a:
            </p>
            <ul className={UL}>
              <li>
                il <strong>consulente del lavoro</strong> incaricato dalla Scuola, che tratta i
                dati quale <strong>responsabile del trattamento</strong> ai sensi
                dell&rsquo;art. 28 GDPR, sulla base di un atto di nomina;
              </li>
              <li>
                <strong>INPS</strong>, <strong>INAIL</strong> e{' '}
                <strong>Agenzia delle Entrate</strong>, nonché gli altri enti pubblici competenti,
                quali <strong>autonomi titolari</strong> e per obbligo di legge.
              </li>
            </ul>
            <p className={P}>
              L&rsquo;interessata può in qualsiasi momento esercitare i diritti previsti dagli
              articoli 15-22 del GDPR — accesso ai propri dati, rettifica, cancellazione,
              limitazione, opposizione e portabilità — e proporre reclamo al{' '}
              <strong>Garante per la protezione dei dati personali</strong>, con le modalità
              indicate nella sezione &laquo;Diritti dell&rsquo;interessato&raquo;. Al momento della
              raccolta le viene inoltre chiesto di impegnarsi a comunicare tempestivamente alla
              Segreteria ogni variazione dei propri dati, compreso il rinnovo del documento
              d&rsquo;identità.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Misure di sicurezza</h2>
            <p className={P}>
              La Scuola adotta misure tecniche e organizzative adeguate a proteggere i dati (art.
              32 GDPR). In particolare: le comunicazioni tra l&rsquo;applicazione e i server sono{' '}
              <strong>cifrate in transito</strong>; l&rsquo;accesso richiede credenziali personali
              ed è <strong>limitato per ruolo e per sede</strong>, così che ciascuno veda soltanto
              i dati di propria competenza; l&rsquo;accesso alla banca dati è regolato da politiche
              di sicurezza applicate a livello di singola riga; gli accessi e le operazioni sono{' '}
              <strong>registrati</strong> per finalità di sicurezza; i dati personali sono{' '}
              <strong>oscurati automaticamente nei registri tecnici</strong> prima che la riga
              sia scritta: nomi, recapiti e codici fiscali vengono sostituiti da un codice non
              reversibile, e i testi liberi — comprese le informazioni sulla salute — vengono
              rimossi. Nei registri tecnici restano leggibili soltanto identificativi tecnici,
              date e conteggi.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Dati conservati sul dispositivo</h2>
            <p className={P}>
              Per far funzionare l&rsquo;app anche senza connessione, una copia di alcune
              informazioni già visualizzate — comunicazioni, diario e menu della mensa — viene
              salvata <strong>sul dispositivo</strong>, nella memoria riservata all&rsquo;app. Non
              viene inviata a nessuno: serve solo a mostrare l&rsquo;ultimo aggiornamento
              disponibile quando la rete manca, e in quel caso l&rsquo;app segnala che i dati non
              sono aggiornati.
            </p>
            <ul className={UL}>
              <li>
                la copia viene <strong>cancellata quando si esce dall&rsquo;account</strong> e,
                comunque, dopo <strong>sette giorni</strong>;
              </li>
              <li>
                sui dispositivi Android questi dati sono <strong>esclusi dai backup</strong>{' '}
                automatici del sistema;
              </li>
              <li>disinstallando l&rsquo;app la copia viene rimossa insieme ad essa.</li>
            </ul>
            <p className={P}>
              Le richieste di cancellazione dei dati riguardano gli archivi del Titolare: la copia
              presente su un dispositivo personale si rimuove uscendo dall&rsquo;account o
              disinstallando l&rsquo;app.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Sblocco con impronta o volto</h2>
            <p className={P}>
              Nell&rsquo;app è possibile attivare, <strong>a scelta</strong>, lo sblocco con
              impronta digitale o riconoscimento del volto. È una protezione in più nel caso in cui
              il telefono finisca in altre mani, e <strong>non sostituisce</strong> l&rsquo;accesso
              con email e password.
            </p>
            <p className={P}>
              L&rsquo;impronta e i dati biometrici{' '}
              <strong>non lasciano mai il dispositivo</strong> e non sono accessibili
              all&rsquo;app: il confronto lo esegue il sistema operativo del telefono, che comunica
              soltanto l&rsquo;esito. L&rsquo;impostazione si può disattivare in qualsiasi momento
              da &laquo;Profilo e deleghe&raquo;, e viene comunque azzerata quando si esce
              dall&rsquo;account.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Cookie</h2>
            <p className={P}>
              Le pagine web del servizio utilizzano esclusivamente{' '}
              <strong>cookie tecnici</strong>, strettamente necessari all&rsquo;autenticazione e al
              funzionamento dell&rsquo;applicazione. Non sono utilizzati cookie di profilazione né
              strumenti di tracciamento di terze parti; per questa ragione, in conformità alle
              Linee guida del Garante del 10 giugno 2021, non è richiesto alcun banner di consenso.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Responsabilità genitoriale e genitori separati</h2>
            <p className={P}>
              I diritti del minore sono esercitati dagli{' '}
              <strong>esercenti la responsabilità genitoriale</strong>. Salvo diversa statuizione
              dell&rsquo;autorità giudiziaria, la responsabilità genitoriale è esercitata da{' '}
              <strong>entrambi i genitori</strong>, anche se separati o divorziati: ciascuno di
              essi ha diritto di ricevere le comunicazioni scolastiche e di accedere con{' '}
              <strong>credenziali personali</strong> ai dati del proprio figlio. I consensi
              previsti dalla presente informativa (ad esempio per le fotografie) sono prestati
              dagli esercenti la responsabilità genitoriale; in caso di disaccordo tra i genitori
              su questioni di particolare importanza si applicano le norme del Codice civile (artt.
              316, 337-ter e 337-quater c.c.). Eventuali provvedimenti che limitano o escludono la
              responsabilità genitoriale devono essere comunicati alla Scuola, che vi si conforma.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Decisioni automatizzate</h2>
            <p className={P}>
              Il servizio <strong>non adotta processi decisionali automatizzati</strong>, compresa
              la profilazione, che producano effetti giuridici o incidano in modo analogamente
              significativo sugli interessati (art. 22 GDPR). Le valutazioni educative e le
              decisioni amministrative sono sempre assunte da persone.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Diritti dell&rsquo;interessato</h2>
            <p className={P}>
              In qualsiasi momento è possibile esercitare i diritti previsti dagli articoli 15-22
              del GDPR:
            </p>
            <ul className={UL}>
              <li>
                accesso ai propri dati e a quelli del minore su cui si esercita la responsabilità
                genitoriale;
              </li>
              <li>rettifica dei dati inesatti;</li>
              <li>
                <strong>cancellazione</strong> dei dati;
              </li>
              <li>limitazione e opposizione al trattamento;</li>
              <li>portabilità dei dati;</li>
              <li>
                <strong>revoca del consenso</strong> in qualsiasi momento, senza che ciò
                pregiudichi la liceità del trattamento effettuato prima della revoca. La revoca è{' '}
                <strong>semplice quanto la concessione</strong>: può essere comunicata
                dall&rsquo;app (sezione &laquo;Profilo e deleghe&raquo;), per email a{' '}
                <strong>info@kidville.it</strong> o alla Segreteria;
              </li>
              <li>
                reclamo al <strong>Garante per la protezione dei dati personali</strong>{' '}
                (www.garanteprivacy.it — Piazza Venezia 11, 00187 Roma).
              </li>
            </ul>
            <p className={P}>
              Le richieste si inviano a <strong>info@kidville.it</strong> e ricevono riscontro{' '}
              <strong>entro un mese</strong> dal ricevimento, ai sensi dell&rsquo;art. 12 GDPR.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Cancellazione dell&rsquo;account e dei dati</h2>
            <p className={P}>
              La <strong>cancellazione dell&rsquo;account</strong> può essere richiesta in due modi:
            </p>
            <ul className={UL}>
              <li>
                dall&rsquo;interno dell&rsquo;app, nella sezione{' '}
                <strong>&laquo;Profilo e deleghe&raquo;</strong>;
              </li>
              <li>
                dalla{' '}
                <Link href="/cancellazione-account" className="font-semibold underline">
                  pagina pubblica di cancellazione
                </Link>
                , utilizzabile <strong>anche senza accedere all&rsquo;app</strong> e anche dopo
                averla disinstallata.
              </li>
            </ul>
            <p className={P}>
              La richiesta viene registrata ed evasa dalla Direzione. Vengono cancellati o resi
              anonimi i dati dell&rsquo;account e i contenuti a esso collegati. Restano conservati,
              per il tempo imposto dalla legge, i soli documenti che la Scuola è obbligata a
              custodire — in particolare quelli <strong>contabili e fiscali</strong>, per i dieci
              anni previsti dall&rsquo;art. 2220 del Codice civile, e i documenti scolastici
              soggetti agli obblighi di conservazione archivistica.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Modifiche alla presente informativa</h2>
            <p className={P}>
              La presente informativa può essere aggiornata per adeguarla a modifiche normative,
              organizzative o tecniche. Ogni versione è identificata dalla data riportata in calce;
              le modifiche sostanziali sono comunicate agli utenti tramite l&rsquo;applicazione. Le
              versioni precedenti possono essere richieste al Titolare.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>Contatti</h2>
            <p className={P}>
              Per ogni informazione relativa alla presente informativa e al trattamento dei dati è
              possibile contattare il Titolare all&rsquo;indirizzo{' '}
              <strong>info@kidville.it</strong> oppure rivolgersi alla Segreteria.
            </p>
          </section>

          {/* Versione del testo: stessa costante usata dall'INSERT in
              consensi_accettazioni, così il testo mostrato e quello registrato
              come accettato non possono mai divergere nel tempo. */}
          <p className="mt-8 border-t border-kidville-line pt-4 font-maven text-xs text-kidville-sub">
            Versione: {VERSIONE_PRIVACY}
          </p>
        </article>
      </div>
    </main>
  );
}
