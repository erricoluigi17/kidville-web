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
// RESTA DA FARE prima della submission: la validazione legale del testo.
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
              <strong>Scuola dell&rsquo;Infanzia La Favola Soc. Coop.</strong>, P.IVA{' '}
              <strong>03394870616</strong>, con sede in{' '}
              <strong>Via Silvio Pellico 7, 81030 Cesa (CE)</strong>. Per ogni richiesta relativa
              al trattamento dei dati è possibile scrivere a{' '}
              <strong>info@kidville.it</strong>.
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
                dati anagrafici del minore e dei genitori/tutori (nome, cognome, data di nascita,
                recapiti, codice fiscale);
              </li>
              <li>presenze, assenze, entrate e uscite;</li>
              <li>
                comunicazioni scuola-famiglia e diario delle attività educative e didattiche;
              </li>
              <li>
                eventuali <strong>dati sanitari o relativi ad allergie e intolleranze</strong>,
                forniti dai genitori quando necessari per la cura e la sicurezza del minore;
              </li>
              <li>
                <strong>fotografie</strong> del minore, solo se espressamente autorizzate dai
                genitori;
              </li>
              <li>
                dati tecnici e log di accesso al servizio, per finalità di sicurezza e diagnosi.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Finalità del trattamento
            </h2>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>gestione del servizio educativo e organizzazione delle attività;</li>
              <li>comunicazioni tra scuola e famiglia;</li>
              <li>adempimenti amministrativi, contabili e fiscali connessi al rapporto.</li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Base giuridica
            </h2>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>
                <strong>esecuzione di un contratto</strong> o di misure precontrattuali, per
                l&rsquo;erogazione del servizio educativo;
              </li>
              <li>
                <strong>obbligo legale</strong>, per gli adempimenti amministrativi, contabili e
                fiscali;
              </li>
              <li>
                <strong>consenso</strong>, per il trattamento delle fotografie e dei dati
                particolari (ad esempio dati sanitari/allergie), revocabile in qualsiasi momento.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Destinatari dei dati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati sono accessibili al solo personale autorizzato e opportunamente istruito.
              Possono essere trattati da fornitori tecnici che agiscono come responsabili del
              trattamento, quali servizi di hosting e infrastruttura, invio di email e notifiche.
              I dati non sono ceduti a terzi per finalità commerciali.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Conservazione dei dati
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati sono conservati per la durata del rapporto e, successivamente, per il tempo
              necessario ad adempiere agli obblighi di legge (ad esempio quelli amministrativi e
              fiscali). I log tecnici sono conservati per un periodo limitato, funzionale alla
              sicurezza e alla diagnosi. Al termine dei periodi previsti i dati sono cancellati o
              anonimizzati.
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
              <li>reclamo all&rsquo;Autorità Garante per la protezione dei dati personali.</li>
            </ul>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              La <strong>cancellazione dell&rsquo;account</strong> può essere avviata direttamente
              dall&rsquo;app, nella sezione <strong>&laquo;Profilo e deleghe&raquo;</strong>. Per
              le altre richieste è possibile scrivere a <strong>info@kidville.it</strong>.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Luogo del trattamento e trasferimenti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I dati sono trattati all&rsquo;interno dello Spazio Economico Europeo. Eventuali
              trasferimenti verso Paesi terzi avvengono solo in presenza di adeguate garanzie
              previste dal GDPR (ad esempio decisioni di adeguatezza o clausole contrattuali
              standard).
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
            {/* Google Play pretende che l'URL di cancellazione sia raggiungibile
                ANCHE da chi non ha (più) l'app installata: il modulo Data safety
                chiede un link pubblico, e l'informativa è la pagina pubblica che
                il revisore apre per prima. */}
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per chiedere la cancellazione dell&rsquo;account e dei dati associati è disponibile la{' '}
              <Link href="/cancellazione-account" className="font-semibold text-kidville-green underline">
                pagina dedicata
              </Link>
              , utilizzabile anche senza accedere all&rsquo;app.
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
