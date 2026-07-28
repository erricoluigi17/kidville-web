import type { Metadata } from 'next';
import Link from 'next/link';
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
// RESTA DA FARE prima della submission: la validazione legale del testo (dossier A3).
// In particolare vanno confermati da un professionista: la condizione dell'art. 9(2)
// scelta per i dati sanitari, l'obbligo o meno di nominare un RPD/DPO, e i tempi di
// conservazione qui dichiarati.
export const metadata: Metadata = {
  title: 'Informativa sulla privacy — Kidville',
  description:
    'Informativa sul trattamento dei dati personali (Reg. UE 2016/679) del registro elettronico Kidville.',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href="/"
          className="inline-flex items-center gap-1 font-maven text-sm font-semibold text-kidville-green hover:underline"
        >
          <span aria-hidden="true">←</span> Torna indietro
        </Link>

        <article className="mt-6 rounded-card border border-kidville-line bg-white p-6 shadow-sm sm:p-8">
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-kidville-green sm:text-4xl">
            Informativa sulla privacy
          </h1>
          <p className="mt-3 font-maven text-base leading-relaxed text-kidville-ink">
            La presente informativa descrive come vengono trattati i dati personali degli utenti
            del registro elettronico <strong>Kidville</strong>, ai sensi del Regolamento (UE)
            2016/679 (GDPR) e della normativa italiana applicabile. Il trattamento riguarda anche
            dati di minori, forniti dai genitori o dagli esercenti la responsabilità genitoriale.
          </p>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Titolare del trattamento
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il Titolare del trattamento è{' '}
              <strong>SCUOLA DELL&rsquo;INFANZIA LA FAVOLA SOCIETA&rsquo; COOPERATIVA</strong>{' '}
              (di seguito anche &laquo;la Scuola&raquo;), P.IVA e codice fiscale{' '}
              <strong>03394870616</strong>, iscritta al Registro delle Imprese al n. REA{' '}
              <strong>CE 240763</strong>, con sede legale in{' '}
              <strong>Via Silvio Pellico 7, 81030 Cesa (CE), Italia</strong>. La Scuola è
              l&rsquo;ente che eroga il servizio educativo e che pubblica l&rsquo;applicazione
              <strong> Kidville</strong>. Per ogni richiesta relativa al trattamento dei dati è
              possibile scrivere a <strong>info@kidville.it</strong>.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Tipologie di dati trattati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Nell&rsquo;ambito del servizio possono essere trattate le seguenti categorie di dati,
              inclusi <strong>dati riferiti a minori</strong>:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                dati anagrafici del minore e dei genitori/tutori (nome, cognome, data e luogo di
                nascita, indirizzo di residenza, recapiti telefonici ed email, codice fiscale,
                estremi di un documento d&rsquo;identità);
              </li>
              <li>dati sulla frequenza: presenze, assenze, entrate e uscite, giustifiche;</li>
              <li>
                comunicazioni scuola-famiglia, messaggi con le insegnanti e diario delle attività
                educative e didattiche;
              </li>
              <li>
                eventuali <strong>dati relativi alla salute</strong> — allergie e intolleranze
                alimentari, certificati medici, indicazioni per la somministrazione dei pasti,
                informazioni su bisogni educativi speciali — forniti dai genitori quando necessari
                per la cura, la sicurezza e l&rsquo;inclusione del minore;
              </li>
              <li>
                <strong>fotografie e video</strong> del minore, solo se espressamente autorizzati
                dai genitori;
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
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Finalità del trattamento
            </h2>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>gestione del servizio educativo e organizzazione delle attività;</li>
              <li>comunicazioni tra scuola e famiglia, incluse le notifiche sul dispositivo;</li>
              <li>
                tutela della salute e della sicurezza del minore durante la permanenza a scuola;
              </li>
              <li>adempimenti amministrativi, contabili e fiscali connessi al rapporto;</li>
              <li>
                sicurezza del servizio, diagnosi dei malfunzionamenti e assistenza agli utenti.
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati <strong>non</strong> sono utilizzati per pubblicità, marketing, profilazione o
              analisi del comportamento. L&rsquo;applicazione non contiene inserzioni pubblicitarie
              né strumenti di analisi statistica di terze parti.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Base giuridica
            </h2>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                <strong>esecuzione di un contratto</strong> o di misure precontrattuali (art. 6,
                par. 1, lett. b GDPR), per l&rsquo;erogazione del servizio educativo;
              </li>
              <li>
                <strong>obbligo legale</strong> (art. 6, par. 1, lett. c GDPR), per gli adempimenti
                amministrativi, contabili e fiscali;
              </li>
              <li>
                <strong>consenso</strong> (art. 6, par. 1, lett. a GDPR) per la pubblicazione di
                fotografie e video del minore nella galleria di classe, revocabile in qualsiasi
                momento;
              </li>
              <li>
                per i <strong>dati relativi alla salute</strong>, che rientrano fra le categorie
                particolari di dati, il <strong>consenso esplicito</strong> dei genitori o degli
                esercenti la responsabilità genitoriale (art. 9, par. 2, lett. a GDPR); nelle
                situazioni di emergenza il trattamento può fondarsi sulla tutela di un interesse
                vitale del minore (art. 9, par. 2, lett. c GDPR).
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Natura del conferimento
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il conferimento dei dati anagrafici, di quelli sulla frequenza e di quelli
              amministrativi è <strong>necessario</strong>: senza di essi la Scuola non può
              iscrivere il minore né erogare il servizio, e l&rsquo;accesso
              all&rsquo;applicazione non può essere attivato.
            </p>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              È invece <strong>facoltativo</strong> il conferimento delle fotografie e dei video,
              così come dei dati sanitari non indispensabili: il rifiuto non pregiudica
              l&rsquo;iscrizione, ma impedisce alla Scuola di erogare le prestazioni che li
              richiedono — per esempio la predisposizione di un pasto alternativo in caso di
              allergia non comunicata, o la pubblicazione di immagini nella galleria della sezione.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Destinatari dei dati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati sono accessibili al solo personale autorizzato e opportunamente istruito, nei
              limiti delle mansioni di ciascuno. Per far funzionare il servizio la Scuola si avvale
              di fornitori tecnici che agiscono come <strong>responsabili del trattamento</strong>{' '}
              ai sensi dell&rsquo;art. 28 GDPR, nominati con apposito accordo:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                <strong>Supabase</strong> — banca dati e autenticazione degli account. I dati sono
                ospitati su infrastruttura situata in <strong>Irlanda</strong>.
              </li>
              <li>
                <strong>Vercel</strong> — pubblicazione ed esecuzione dell&rsquo;applicazione web.
              </li>
              <li>
                <strong>Google</strong> (servizio Firebase Cloud Messaging) — recapito delle
                notifiche push sul dispositivo.
              </li>
              <li>
                <strong>Resend</strong> — invio dei messaggi di posta elettronica di servizio
                (credenziali, avvisi, comunicazioni).
              </li>
              <li>
                <strong>Aruba</strong> — trasmissione dei documenti fiscali al Sistema di
                Interscambio dell&rsquo;Agenzia delle Entrate, quando dovuta.
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati possono inoltre essere comunicati alle autorità e agli enti pubblici cui la
              Scuola è tenuta a trasmetterli per obbligo di legge. I dati{' '}
              <strong>non sono ceduti o venduti a terzi</strong> per finalità commerciali, e non
              sono condivisi con intermediari pubblicitari o data broker.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Luogo del trattamento e trasferimenti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              La banca dati del servizio è ospitata all&rsquo;interno dello{' '}
              <strong>Spazio Economico Europeo</strong>, su infrastruttura situata in Irlanda.
            </p>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Alcuni dei fornitori indicati sopra — in particolare quelli che curano il recapito
              delle notifiche push e dei messaggi di posta elettronica — sono società stabilite
              negli <strong>Stati Uniti d&rsquo;America</strong> o appartenenti a gruppi
              statunitensi. Nei limiti in cui ciò comporta un trasferimento di dati personali verso
              un Paese terzo, il trasferimento avviene sulla base delle garanzie previste dal Capo V
              del GDPR: <strong>decisione di adeguatezza</strong> della Commissione europea relativa
              al quadro UE-USA per la protezione dei dati, ove il fornitore vi abbia aderito,
              oppure <strong>clausole contrattuali tipo</strong> adottate dalla Commissione europea.
              Copia delle garanzie adottate può essere richiesta scrivendo a{' '}
              <strong>info@kidville.it</strong>.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Conservazione dei dati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati sono conservati per il tempo strettamente necessario alle finalità per cui sono
              stati raccolti, secondo i criteri seguenti:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                <strong>dati anagrafici, didattici e sulla frequenza</strong>: per tutta la durata
                del rapporto con la famiglia e, successivamente, per il tempo imposto dagli obblighi
                di conservazione documentale della Scuola;
              </li>
              <li>
                <strong>documenti contabili e fiscali</strong>: <strong>dieci anni</strong>, come
                previsto dall&rsquo;art. 2220 del Codice civile e dalla normativa tributaria;
              </li>
              <li>
                <strong>log tecnici di accesso e di utilizzo</strong>: <strong>30 giorni</strong>,
                dopodiché sono cancellati automaticamente;
              </li>
              <li>
                <strong>copia locale dei dati sul dispositivo</strong> (funzionamento senza
                connessione): <strong>sette giorni</strong>, e comunque fino all&rsquo;uscita
                dall&rsquo;account;
              </li>
              <li>
                <strong>dati particolari</strong>, come quelli sulla salute: fino alla revoca del
                consenso o al venir meno della necessità che ne ha giustificato la raccolta.
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Al termine dei periodi indicati i dati sono cancellati oppure resi anonimi in modo
              irreversibile.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Misure di sicurezza
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              La Scuola adotta misure tecniche e organizzative adeguate a proteggere i dati (art. 32
              GDPR). In particolare: le comunicazioni tra l&rsquo;applicazione e i server sono
              <strong> cifrate in transito</strong>; l&rsquo;accesso richiede credenziali personali
              ed è <strong>limitato per ruolo</strong>, così che ciascuno veda soltanto i dati di
              propria competenza; l&rsquo;accesso alla banca dati è regolato da politiche di
              sicurezza applicate a livello di singola riga; gli accessi e le operazioni sono
              <strong> registrati</strong> per finalità di sicurezza; i dati personali sono{' '}
              <strong>oscurati nei registri tecnici</strong>, che non contengono nomi, recapiti,
              contenuti dei messaggi né informazioni sulla salute.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Dati conservati sul dispositivo
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per far funzionare l&rsquo;app anche senza connessione, una copia di alcune
              informazioni già visualizzate — comunicazioni, diario e menu della mensa — viene
              salvata <strong>sul dispositivo</strong>, nella memoria riservata all&rsquo;app. Non
              viene inviata a nessuno: serve solo a mostrare l&rsquo;ultimo aggiornamento
              disponibile quando la rete manca, e in quel caso l&rsquo;app segnala che i dati non
              sono aggiornati.
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                la copia viene <strong>cancellata quando si esce dall&rsquo;account</strong> e,
                comunque, dopo <strong>sette giorni</strong>;
              </li>
              <li>
                sui dispositivi Android questi dati sono <strong>esclusi dai backup</strong>
                automatici del sistema;
              </li>
              <li>
                disinstallando l&rsquo;app la copia viene rimossa insieme ad essa.
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Le richieste di cancellazione dei dati riguardano gli archivi del Titolare: la copia
              presente su un dispositivo personale si rimuove uscendo dall&rsquo;account o
              disinstallando l&rsquo;app.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Sblocco con impronta o volto
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Nell&rsquo;app è possibile attivare, <strong>a scelta</strong>, lo sblocco con
              impronta digitale o riconoscimento del volto. È una protezione in più nel caso in cui
              il telefono finisca in altre mani, e <strong>non sostituisce</strong>
              l&rsquo;accesso con email e password.
            </p>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              L&rsquo;impronta e i dati biometrici <strong>non lasciano mai il dispositivo</strong>
              e non sono accessibili all&rsquo;app: il confronto lo esegue il sistema operativo del
              telefono, che comunica soltanto l&rsquo;esito. L&rsquo;impostazione si può disattivare
              in qualsiasi momento da &laquo;Profilo e deleghe&raquo;, e viene comunque azzerata
              quando si esce dall&rsquo;account.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Decisioni automatizzate
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il servizio <strong>non adotta processi decisionali automatizzati</strong>, compresa
              la profilazione, che producano effetti giuridici o incidano in modo analogamente
              significativo sugli interessati (art. 22 GDPR). Le valutazioni educative e le
              decisioni amministrative sono sempre assunte da persone.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Diritti dell&rsquo;interessato
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              In qualsiasi momento è possibile esercitare i diritti previsti dagli articoli 15-22
              del GDPR:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>accesso ai propri dati;</li>
              <li>rettifica dei dati inesatti;</li>
              <li>
                <strong>cancellazione</strong> dei dati;
              </li>
              <li>limitazione e opposizione al trattamento;</li>
              <li>portabilità dei dati;</li>
              <li>
                <strong>revoca del consenso</strong> in qualsiasi momento, senza che ciò pregiudichi
                la liceità del trattamento effettuato prima della revoca;
              </li>
              <li>
                reclamo al <strong>Garante per la protezione dei dati personali</strong>{' '}
                (www.garanteprivacy.it).
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Le richieste si inviano a <strong>info@kidville.it</strong> e ricevono riscontro entro
              i termini di legge.
            </p>
          </section>

          <section id="cancellazione" className="mt-8 scroll-mt-6 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Cancellazione dell&rsquo;account e dei dati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              La <strong>cancellazione dell&rsquo;account</strong> può essere richiesta in due modi:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                dall&rsquo;interno dell&rsquo;app, nella sezione{' '}
                <strong>&laquo;Profilo e deleghe&raquo;</strong>;
              </li>
              <li>
                dalla{' '}
                <Link
                  href="/cancellazione-account"
                  className="font-semibold text-kidville-green underline"
                >
                  pagina pubblica di cancellazione
                </Link>
                , utilizzabile <strong>anche senza accedere all&rsquo;app</strong> e anche dopo
                averla disinstallata.
              </li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              La richiesta viene registrata ed evasa dalla Direzione. Vengono cancellati o resi
              anonimi i dati dell&rsquo;account e i contenuti a esso collegati. Restano conservati,
              per il tempo imposto dalla legge, i soli documenti che la Scuola è obbligata a
              custodire — in particolare quelli <strong>contabili e fiscali</strong>, per i dieci
              anni previsti dall&rsquo;art. 2220 del Codice civile.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Contatti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per ogni informazione relativa alla presente informativa e al trattamento dei dati è
              possibile contattare il Titolare all&rsquo;indirizzo{' '}
              <strong>info@kidville.it</strong> oppure rivolgersi alla Segreteria.
            </p>
          </section>

          {/* Versione del testo: stessa costante usata dall'INSERT in
              consensi_accettazioni, così il testo mostrato e quello registrato
              come accettato non possono mai divergere nel tempo. */}
          <p className="mt-8 border-t border-kidville-line pt-4 font-maven text-xs text-kidville-muted">
            Versione: {VERSIONE_PRIVACY}
          </p>
        </article>
      </div>
    </main>
  );
}
