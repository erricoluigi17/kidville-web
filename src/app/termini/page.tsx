import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicContrastButton } from '@/components/ui/PublicContrastButton';
import { VERSIONE_TERMINI } from '@/lib/legal/versioni';

// Pagina PUBBLICA (nessun login): termini di servizio. Server component statico.
// I riferimenti societari sono quelli reali del Titolare (dati pubblici d'impresa).
//
// ─────────────────────────────────────────────────────────────────────────────
// REVISIONE 2026-07-31 — testo riscritto applicando l'analisi di conformità
// prodotta il 30/07. Le correzioni che contano, e il perché:
//
//  · ACCETTAZIONE. Prima: «utilizzando il servizio dichiari di accettare». Una
//    formula del genere non vincola nessuno: senza un'accettazione espressa, la
//    limitazione di responsabilità che dovrebbe proteggere la Scuola non
//    protegge. Ora l'accettazione è espressa al primo accesso, distinta da
//    quella dell'informativa, con data e versione registrate.
//  · RESPONSABILITÀ. Il genitore verso una scuola paritaria è un CONSUMATORE
//    (Cass. 10910/2017): le clausole che escludono la responsabilità per
//    inadempimento sono NULLE (artt. 33-36 Cod. Cons.; art. 1229 c.c.). La
//    clausola è stata riscritta stretta — meglio una che tiene che una larga che
//    cade — con salvezza espressa delle norme inderogabili.
//  · MODIFICHE UNILATERALI: da «efficaci dalla pubblicazione» (presunta
//    vessatoria, art. 33.2.m Cod. Cons.) a giustificato motivo + 30 giorni di
//    preavviso + facoltà di non proseguire.
//  · FORO: per i consumatori è inderogabile quello di residenza (art. 66-bis
//    Cod. Cons.), non «quello indicato dalla normativa», che non significa nulla.
//  · ADR: aggiunta nel quadro attuale. ⚠️ La piattaforma ODR europea è CHIUSA
//    (Reg. UE 2024/3228, dal 20/07/2025): citarla oggi sarebbe un errore.
//
// ⚠️ VALIDAZIONE LEGALE ANCORA NECESSARIA: il testo è redatto su fonti
// verificate ma NON è un parere legale e nessun professionista abilitato l'ha
// sottoscritto. Da confermare in particolare la formulazione della sez. 10.
// ─────────────────────────────────────────────────────────────────────────────
export const metadata: Metadata = {
  title: 'Termini di servizio — Kidville',
  description: 'Termini e condizioni di utilizzo del registro elettronico Kidville.',
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
export default function TerminiPage() {
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
            Termini di servizio
          </h1>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>1. Chi fornisce il servizio</h2>
            <p className={P}>
              Il registro elettronico <strong>Kidville</strong> (di seguito &laquo;il
              Servizio&raquo;) è fornito da{' '}
              <strong>SCUOLA DELL&rsquo;INFANZIA LA FAVOLA SOCIETA&rsquo; COOPERATIVA</strong> (di
              seguito &laquo;la Scuola&raquo;), con sede legale in Via Silvio Pellico 7, 81030 Cesa
              (CE), P.IVA e codice fiscale 03394870616, REA CE 240763, contattabile
              all&rsquo;indirizzo <strong>info@kidville.it</strong> o tramite la Segreteria. I
              presenti termini disciplinano l&rsquo;utilizzo del Servizio.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>2. Oggetto del servizio</h2>
            <p className={P}>
              Kidville è un registro elettronico che consente la gestione del rapporto
              scuola-famiglia: comunicazioni, presenze, diario delle attività, adempimenti
              amministrativi e funzioni collegate. Il Servizio è riservato agli utenti autorizzati
              — famiglie degli alunni iscritti, personale docente e amministrativo — ed è
              accessorio al rapporto di iscrizione: non esiste registrazione libera e gli account
              sono creati dalla Segreteria. Gli utenti sono sempre persone adulte; i minori non
              hanno un account.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>3. Rapporto con il contratto di iscrizione e con l&rsquo;informativa privacy</h2>
            <p className={P}>
              Il Servizio è uno strumento di gestione del rapporto scolastico e{' '}
              <strong>non sostituisce né modifica il contratto di iscrizione</strong>, che resta la
              fonte del rapporto tra la Scuola e la famiglia. In caso di contrasto tra i presenti
              termini e il contratto di iscrizione, <strong>prevale il contratto di iscrizione</strong>.
            </p>
            <p className={P}>
              Il trattamento dei dati personali effettuato tramite il Servizio è descritto
              nell&rsquo;
              <Link href="/privacy" className="font-semibold underline">
                informativa sulla privacy
              </Link>
              , che costituisce documento autonomo e prevalente per tutto ciò che riguarda i dati
              personali.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>4. Accettazione dei termini</h2>
            <p className={P}>
              I presenti termini sono accettati <strong>espressamente</strong> al primo accesso al
              Servizio, mediante un&rsquo;apposita dichiarazione distinta da quella relativa
              all&rsquo;informativa privacy. La Scuola conserva la registrazione della data e della
              versione dei termini accettati. Per il personale scolastico, l&rsquo;utilizzo del
              Servizio rientra tra gli strumenti di lavoro e resta disciplinato anche dal rapporto
              di lavoro e dalle istruzioni ricevute.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>5. Account e credenziali</h2>
            <p className={P}>
              L&rsquo;accesso avviene tramite credenziali personali. L&rsquo;utente è tenuto a
              custodirle con riservatezza, a non cederle a terzi e a comunicare tempestivamente
              alla Scuola qualsiasi utilizzo non autorizzato. L&rsquo;account è a uso personale e
              non cedibile. Ciascun esercente la responsabilità genitoriale ha diritto a{' '}
              <strong>credenziali proprie</strong>; la gestione di eventuali deleghe avviene
              tramite la sezione &laquo;Profilo e deleghe&raquo;.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>6. Uso consentito e divieti</h2>
            <p className={P}>
              Il Servizio deve essere utilizzato nel rispetto della legge e dei presenti termini.
              In particolare è vietato:
            </p>
            <ul className={UL}>
              <li>accedere ad aree o dati non di propria competenza, o tentare di farlo;</li>
              <li>
                tentare di compromettere la sicurezza, l&rsquo;integrità o la disponibilità del
                Servizio;
              </li>
              <li>
                utilizzare il Servizio per finalità illecite, offensive o lesive dei diritti di
                terzi;
              </li>
              <li>
                diffondere all&rsquo;esterno dati, comunicazioni, fotografie o video riservati
                acquisiti tramite il Servizio: in particolare, le immagini che ritraggono minori
                diversi dai propri figli <strong>non possono essere pubblicate o condivise</strong>{' '}
                (ad esempio su social network) senza il consenso degli esercenti la responsabilità
                genitoriale interessati.
              </li>
            </ul>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>7. Contenuti caricati dagli utenti</h2>
            <p className={P}>
              L&rsquo;utente è responsabile dei contenuti che carica (ad esempio documenti,
              messaggi o immagini) e garantisce di averne titolo. È vietato caricare contenuti
              illeciti o lesivi dei diritti altrui. La Scuola può rimuovere contenuti che violino i
              presenti termini o la legge.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>8. Proprietà intellettuale</h2>
            <p className={P}>
              Il software, i marchi, i loghi e i contenuti del Servizio sono protetti dalle norme
              sulla proprietà intellettuale e restano di titolarità dei rispettivi aventi diritto.
              Non è consentito copiarli, modificarli o distribuirli senza autorizzazione.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>9. Disponibilità del servizio</h2>
            <p className={P}>
              La Scuola si impegna a fornire il Servizio con diligenza e continuità. Il Servizio
              può tuttavia subire interruzioni o limitazioni temporanee per interventi di
              manutenzione — programmata e, ove possibile, comunicata in anticipo — per cause
              tecniche non imputabili alla Scuola o per eventi di forza maggiore. Il Servizio è uno
              strumento digitale di supporto: in caso di indisponibilità prolungata, le
              comunicazioni tra scuola e famiglia restano garantite attraverso i canali
              tradizionali della Segreteria.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>10. Responsabilità</h2>
            <p className={P}>
              La Scuola risponde dei danni causati da proprio inadempimento o da fatto proprio nei
              limiti previsti dalla legge.{' '}
              <strong>
                Nulla nei presenti termini esclude o limita la responsabilità della Scuola
              </strong>{' '}
              nei casi in cui la legge non consente di escluderla o limitarla, né esclude o limita
              i diritti riconosciuti al consumatore da norme inderogabili, incluso il Codice del
              Consumo.
            </p>
            <p className={P}>
              La Scuola non risponde dei danni derivanti da: eventi di forza maggiore o caso
              fortuito; fatti di terzi non imputabili alla Scuola, incluse le interruzioni delle
              reti di comunicazione o dei servizi tecnici di fornitori esterni; uso del Servizio
              improprio, non autorizzato o contrario ai presenti termini da parte dell&rsquo;utente,
              inclusa la mancata custodia delle credenziali; contenuti caricati dagli utenti.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>11. Sospensione dell&rsquo;account</h2>
            <p className={P}>
              La Scuola può sospendere l&rsquo;accesso di un utente in caso di violazione dei
              presenti termini, di rischio per la sicurezza del Servizio o degli altri utenti, o su
              richiesta dell&rsquo;autorità. Salvo i casi d&rsquo;urgenza, la sospensione è
              preceduta da un avviso con l&rsquo;indicazione del motivo. La sospensione
              dell&rsquo;accesso all&rsquo;applicazione non pregiudica i diritti derivanti dal
              rapporto di iscrizione né l&rsquo;esercizio dei diritti sui dati personali.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>12. Durata e cessazione</h2>
            <p className={P}>
              L&rsquo;accesso al Servizio dura quanto il rapporto che lo giustifica:
              l&rsquo;iscrizione dell&rsquo;alunno per le famiglie, il rapporto di lavoro per il
              personale. Al termine del rapporto scolastico l&rsquo;account viene disattivato;
              prima della disattivazione l&rsquo;utente può richiedere alla Segreteria copia dei
              documenti e dei contenuti che lo riguardano. La conservazione e la cancellazione dei
              dati dopo la cessazione sono regolate dall&rsquo;informativa privacy e dagli obblighi
              di legge.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>13. Modifiche ai termini</h2>
            <p className={P}>
              La Scuola può aggiornare i presenti termini <strong>per giustificato motivo</strong>:
              adeguamenti normativi, esigenze tecniche o di sicurezza, evoluzione del Servizio. Le
              modifiche sono comunicate agli utenti tramite l&rsquo;applicazione{' '}
              <strong>con un preavviso di almeno 30 giorni</strong>, salvo che la modifica derivi
              da un obbligo di legge immediatamente applicabile. L&rsquo;utente che non intenda
              accettare le modifiche può cessare l&rsquo;utilizzo del Servizio e rivolgersi alla
              Segreteria per le comunicazioni scolastiche attraverso i canali tradizionali, ferma
              restando la disciplina del rapporto di iscrizione. Ogni versione dei termini è
              identificata dalla data riportata in calce.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>14. Legge applicabile e foro competente</h2>
            <p className={P}>
              I presenti termini sono regolati dalla legge italiana. Per le controversie con utenti
              che rivestono la qualità di <strong>consumatori</strong> è competente in via
              inderogabile il{' '}
              <strong>giudice del luogo di residenza o di domicilio del consumatore</strong> (art.
              66-bis del Codice del Consumo). Per ogni altra controversia è competente il foro
              individuato dalle norme ordinarie.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>15. Risoluzione alternativa delle controversie</h2>
            <p className={P}>
              Il consumatore può ricorrere alle procedure di{' '}
              <strong>risoluzione alternativa delle controversie</strong> (ADR) previste dal d.lgs.
              130/2015, rivolgendosi agli organismi iscritti negli elenchi tenuti dalle autorità
              competenti, ferma la possibilità di rivolgersi all&rsquo;autorità giudiziaria. La
              Scuola fornirà in ogni caso, su richiesta e dopo un eventuale reclamo non risolto, le
              informazioni previste dall&rsquo;art. 141-sexies del Codice del Consumo.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className={H2}>16. Contatti</h2>
            <p className={P}>
              Per informazioni sui presenti termini è possibile contattare{' '}
              <strong>SCUOLA DELL&rsquo;INFANZIA LA FAVOLA SOCIETA&rsquo; COOPERATIVA</strong>, Via
              Silvio Pellico 7, 81030 Cesa (CE), P.IVA e codice fiscale 03394870616, REA CE 240763,
              all&rsquo;indirizzo <strong>info@kidville.it</strong> oppure rivolgersi alla
              Segreteria.
            </p>
          </section>

          {/* Versione del testo: stessa costante usata dall'INSERT in
              consensi_accettazioni (prova d'accettazione), così il testo mostrato
              e quello registrato come accettato non divergono mai. */}
          <p className="mt-8 border-t border-kidville-line pt-4 font-maven text-xs text-kidville-sub">
            Versione: {VERSIONE_TERMINI}
          </p>
        </article>
      </div>
    </main>
  );
}
