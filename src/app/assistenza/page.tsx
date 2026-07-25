import type { Metadata } from 'next';
import Link from 'next/link';

// Pagina PUBBLICA (nessun login): supporto. Serve anche come "Support URL"
// per gli store. Mostra SOLO l'email di supporto e l'invito a contattare la
// Segreteria: nessun telefono, nessun indirizzo.
//
// L'indirizzo è una casella ORDINARIA, e deve restare tale: qui prima c'era una
// PEC, ma quasi tutti i gestori PEC rifiutano la posta ordinaria — un genitore
// che scrive da Gmail, e il revisore Apple che usa questa pagina come Support
// URL, si sarebbero presi un errore di consegna. Un recapito di supporto che
// rimbalza è peggio di nessun recapito: sembra funzionare.
export const metadata: Metadata = {
  title: 'Assistenza — Kidville',
  description: 'Come ricevere assistenza per il registro elettronico Kidville.',
};

export default function AssistenzaPage() {
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
            Assistenza
          </h1>
          <p className="mt-3 font-maven text-base leading-relaxed text-kidville-ink">
            Hai bisogno di aiuto con il registro elettronico <strong>Kidville</strong>? Siamo qui
            per supportarti.
          </p>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Come ricevere assistenza
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per domande, segnalazioni o problemi tecnici, scrivi al nostro indirizzo di supporto.
              Descrivi con qualche dettaglio cosa stai riscontrando: ti risponderemo il prima
              possibile.
            </p>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Email di supporto:{' '}
              <strong className="text-kidville-green">lerrico7@gmail.com</strong>
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="font-barlow text-xl font-bold uppercase tracking-wide text-kidville-green sm:text-2xl">
              Contatta la Segreteria
            </h2>
            <p className="font-maven text-[15px] leading-relaxed text-kidville-ink">
              Per richieste relative all&rsquo;iscrizione, alle comunicazioni o alla gestione del
              tuo account puoi rivolgerti alla <strong>Segreteria</strong>, che ti indirizzerà alla
              persona giusta.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
