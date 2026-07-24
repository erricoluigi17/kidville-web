import type { Metadata } from 'next';
import Link from 'next/link';

// Pagina PUBBLICA (nessun login): informativa GDPR. Serve anche come
// "Privacy Policy URL" per gli store. È un server component statico: nessun
// dato personale reale, i riferimenti dell'ente sono segnaposto tra parentesi
// quadre che il Titolare compilerà.
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
              Il Titolare del trattamento è <strong>[Ragione sociale del Titolare]</strong>, con
              sede in <strong>[indirizzo sede]</strong>. Per ogni richiesta relativa al trattamento
              dei dati è possibile scrivere a <strong>[email del Titolare/DPO]</strong>.
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
              le altre richieste è possibile scrivere a <strong>[email del Titolare/DPO]</strong>.
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
              <strong>[email del Titolare/DPO]</strong> oppure rivolgersi alla Segreteria.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
