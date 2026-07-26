import type { Metadata } from 'next';
import Link from 'next/link';

// Pagina PUBBLICA (nessun login): termini di servizio. Server component
// statico. I riferimenti societari sono quelli reali del Titolare (dati
// pubblici d'impresa). RESTA DA FARE: la validazione legale del testo.
export const metadata: Metadata = {
  title: 'Termini di servizio — Kidville',
  description:
    'Termini e condizioni di utilizzo del registro elettronico Kidville.',
};

export default function TerminiPage() {
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
            Termini di servizio
          </h1>
          <p className="mt-3 font-maven text-base leading-relaxed text-kidville-ink">
            I presenti termini disciplinano l&rsquo;utilizzo del registro elettronico{' '}
            <strong>Kidville</strong>. Utilizzando il servizio, l&rsquo;utente dichiara di aver
            letto e accettato le condizioni di seguito descritte.
          </p>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              1. Oggetto del servizio
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Kidville è un registro elettronico che consente la gestione del rapporto
              scuola-famiglia: comunicazioni, presenze, diario delle attività, adempimenti
              amministrativi e funzioni collegate. Il servizio è riservato agli utenti autorizzati
              (famiglie, personale docente e amministrativo).
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              2. Account e credenziali
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              L&rsquo;accesso avviene tramite credenziali personali. L&rsquo;utente è tenuto a
              custodirle con riservatezza, a non cederle a terzi e a comunicare tempestivamente
              qualsiasi utilizzo non autorizzato. L&rsquo;account è a uso personale e non cedibile.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              3. Uso consentito e divieti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il servizio deve essere utilizzato nel rispetto della legge e delle presenti
              condizioni. In particolare è vietato:
            </p>
            <ul className="list-disc space-y-1.5 pl-5 font-maven text-[15px] leading-relaxed text-kidville-ink">
              <li>accedere ad aree o dati non di propria competenza;</li>
              <li>
                tentare di compromettere la sicurezza, l&rsquo;integrità o la disponibilità del
                servizio;
              </li>
              <li>
                utilizzare il servizio per finalità illecite, offensive o lesive dei diritti di
                terzi;
              </li>
              <li>
                diffondere all&rsquo;esterno dati e comunicazioni riservati acquisiti tramite il
                servizio.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              4. Contenuti caricati dagli utenti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              L&rsquo;utente è responsabile dei contenuti che carica (ad esempio documenti, messaggi
              o immagini) e garantisce di averne titolo. È vietato caricare contenuti illeciti o
              lesivi dei diritti altrui. Il gestore può rimuovere contenuti che violino le presenti
              condizioni o la legge.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              5. Proprietà intellettuale
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il software, i marchi, i loghi e i contenuti del servizio sono protetti dalle norme
              sulla proprietà intellettuale e restano di titolarità dei rispettivi aventi diritto.
              Non è consentito copiarli, modificarli o distribuirli senza autorizzazione.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              6. Limitazione di responsabilità
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Il servizio è fornito con la massima diligenza, ma senza garanzia di assenza di
              interruzioni o errori. Nei limiti consentiti dalla legge, il gestore non risponde dei
              danni derivanti da un uso improprio del servizio, da malfunzionamenti tecnici o da
              cause non imputabili al gestore stesso.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              7. Modifiche ai termini
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I presenti termini possono essere aggiornati per esigenze normative, tecniche o
              organizzative. Le modifiche sono efficaci dalla pubblicazione. La prosecuzione
              nell&rsquo;uso del servizio comporta l&rsquo;accettazione della versione aggiornata.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              8. Legge applicabile e foro competente
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              I presenti termini sono regolati dalla legge italiana. Per ogni controversia è
              competente il foro del luogo indicato dalla normativa applicabile, fatte salve le
              disposizioni inderogabili a tutela del consumatore.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              9. Contatti
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per informazioni sui presenti termini è possibile contattare{' '}
              <strong>Scuola dell&rsquo;Infanzia La Favola Soc. Coop.</strong>, Via Silvio Pellico
              7, 81030 Cesa (CE), P.IVA 03394870616, all&rsquo;indirizzo{' '}
              <strong>lerrico7@gmail.com</strong> oppure rivolgersi alla Segreteria.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
