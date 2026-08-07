import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicContrastButton } from '@/components/ui/PublicContrastButton';
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
export default function PrivacyPage() {
  return (
    <main lang="it" className="kv-public min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        {/* Riga di testa: ritorno + comando di ACCESSIBILITÀ. Il comando di Alto
            Contrasto viveva solo nei menu account, cioè dopo il login: su una
            pagina pubblica — che per lo store è anche il recapito legale — chi ne
            ha bisogno non poteva raggiungerlo. Sta in un componente unico proprio
            perché queste cinque pagine non ricomincino a divergere. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1 font-maven text-sm font-semibold text-kidville-green hover:underline"
          >
            <span aria-hidden="true">←</span> Torna indietro
          </Link>
          <PublicContrastButton />
        </div>

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
              <li>
                <strong>motivo dell&rsquo;assenza</strong> comunicato o scritto dalla famiglia, e
                note dell&rsquo;appello del personale docente: <strong>dodici mesi</strong> dal
                giorno dell&rsquo;assenza e comunque non oltre la fine dell&rsquo;iscrizione,
                dopodiché il testo è cancellato automaticamente. Resta la registrazione della
                presenza o dell&rsquo;assenza, che è un dato sulla frequenza e segue i tempi
                indicati al primo punto;
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
              <strong>oscurati nei registri tecnici</strong>, che non contengono nomi, recapiti,
              contenuti dei messaggi né informazioni sulla salute.
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
