import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicContrastButton } from '@/components/ui/PublicContrastButton';

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

// `lang="it"` sul CONTENITORE, non sul documento: `layout.tsx` rende
// `<html lang={locale}>` e questa pagina NON passa da next-intl — il testo legale
// resta italiano per scelta (tradurlo senza validazione legale è un rischio
// maggiore che non tradurlo). Con l'app in inglese il documento risultava quindi
// `lang="en"` su un testo tutto italiano, e uno screen reader leggeva
// l'informativa sui dati dei minori con la pronuncia sbagliata: WCAG 3.1.2
// «Lingua delle parti». Il giorno in cui il testo verrà tradotto, questo attributo
// va tolto — il lock `pagine-legali` lo pretende, e fallisce se resta.
export default function AssistenzaPage() {
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
              <strong className="text-kidville-green">info@kidville.it</strong>
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
