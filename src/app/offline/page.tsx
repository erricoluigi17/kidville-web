import type { Metadata } from 'next';
import it from '../../../messages/it/offline.json';
import en from '../../../messages/en/offline.json';
import { costruisciScriptOffline } from './script-offline';

// Pagina di ripiego OFFLINE: è ciò che il Service Worker pre-cacha in `install`
// e serve quando la rete manca e non c'è un documento salvato per quella rotta.
//
// PERCHÉ NON USA `useTranslations`. La risoluzione della lingua di next-intl
// passa da `cookies()` (src/i18n/request.ts): usarla qui renderebbe la pagina
// DINAMICA e — molto peggio — congelerebbe la lingua al momento del pre-cache.
// Un utente che passa a EN dopo l'installazione si troverebbe la pagina offline
// in italiano per sempre. Quindi il documento contiene ENTRAMBE le lingue e un
// piccolo script inline mostra quella giusta leggendo il cookie KV_LOCALE.
//
// Deve funzionare anche SENZA JavaScript: i due link sono `<a>` veri, non
// bottoni, e in assenza di script si vede la versione italiana (il default
// dell'app). È la pagina che deve reggere quando non regge nient'altro.
//
// ─── PERCHÉ C'È UN ELENCO DI PAGINE (v2) ────────────────────────────────────
// Collaudo su emulatore Android, app puntata a https://app.kidville.it: a cold
// start senza rete il Service Worker serve questa pagina, e le rotte già
// visitate SONO in cache e consultabili. Ma l'unico link era «Riprova» → `/`, e
// la root non finisce MAI in cache (risponde 307, e `sw.js` la lascia passare
// senza salvarla). Misurato: «Riprova» → `/` → di nuovo questa pagina →
// «Riprova» → LOOP INFINITO. Nel frattempo il testo prometteva pagine
// consultabili che l'interfaccia non permetteva di raggiungere: una promessa che
// l'interfaccia non consente di mantenere è un difetto, non un dettaglio.
//
// Da qui le due aggiunte, entrambe in JS inline perché qui NON c'è il bundle di
// Next (il documento arriva dalla CacheStorage):
//  · l'elenco delle pagine davvero disponibili, letto dalla cache dello shell;
//  · «Riprova» che sonda la rete prima di navigare, e se non c'è resta qui.
// Se non c'è NULLA in cache, la promessa non si fa: si mostra l'altra variante
// del paragrafo. Vedi `./script-offline.ts` e i test in
// `__tests__/offline/pagina-offline.test.tsx`.
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Kidville — nessuna connessione',
  description: 'Kidville non è raggiungibile: controlla la connessione e riprova.',
};

const SCRIPT_LINGUA = `(function(){try{
var m=document.cookie.match(/(?:^|; )KV_LOCALE=([^;]*)/);
var l=m?decodeURIComponent(m[1]):'it';
if(l!=='en')return;
var n=document.querySelectorAll('[data-kv-lang]');
for(var i=0;i<n.length;i++){n[i].hidden=n[i].getAttribute('data-kv-lang')!=='en';}
document.documentElement.lang='en';
}catch(e){}})();`;

// Le etichette delle rotte sono tradotte come tutto il resto della pagina, e
// viaggiano dentro lo script perché è lui a costruire i link.
const SCRIPT_OFFLINE = costruisciScriptOffline({
  it: it.etichette,
  en: en.etichette,
});

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-kidville-green px-8 text-center">
      {([
        ['it', it],
        ['en', en],
      ] as const).map(([lingua, testi]) => (
        <div
          key={lingua}
          data-kv-lang={lingua}
          hidden={lingua === 'en'}
          className="flex w-full max-w-sm flex-col items-center gap-5"
        >
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">
            {testi.titolo}
          </h1>
          {/* Due varianti del paragrafo, entrambe già nel documento: senza JS —
              e quando in cache non c'è nulla — resta visibile quella che NON
              promette pagine consultabili. Lo script scambia le due solo dopo
              aver trovato davvero qualcosa. */}
          <p
            data-kv-corpo="cache"
            hidden
            className="font-maven text-[15px] leading-relaxed text-white/85"
          >
            {testi.corpo}
          </p>
          <p
            data-kv-corpo="vuota"
            className="font-maven text-[15px] leading-relaxed text-white/85"
          >
            {testi.corpoSenzaCache}
          </p>

          {/* L'elenco lo riempie lo script leggendo la cache dello shell: qui
              non si può sapere a build time cosa l'utente ha visitato. */}
          <nav
            data-kv-disponibili=""
            hidden
            aria-labelledby={`kv-disponibili-${lingua}`}
            className="w-full"
          >
            <h2
              id={`kv-disponibili-${lingua}`}
              className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-yellow"
            >
              {testi.disponibili}
            </h2>
            <ul data-kv-elenco={lingua} className="flex flex-col gap-2 text-left" />
          </nav>

          {/* `<a>` e NON `<Link>`, di proposito: questo documento viene servito
              dal Service Worker quando la rete manca, quindi non c'è alcun
              router idratato e una navigazione client-side non partirebbe. Serve
              una navigazione VERA, che ripassi dal SW.
              `href="/"` resta il comportamento senza JS; con JS lo script
              intercetta il click e naviga solo se la rete risponde davvero,
              altrimenti si resterebbe nel loop. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            data-kv-riprova=""
            className="inline-flex items-center rounded-pill bg-kidville-yellow px-7 py-3 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green active:scale-95"
          >
            {testi.riprova}
          </a>
          <p
            data-kv-nessuna-rete=""
            hidden
            role="status"
            className="font-maven text-sm font-semibold text-kidville-yellow"
          >
            {testi.nessunaRete}
          </p>
          <p className="font-maven text-xs text-white/60">{testi.nota}</p>
        </div>
      ))}
      {/* Nessuna CSP nel progetto: gli script inline sono ammessi. Vedi sopra. */}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT_LINGUA }} />
      <script dangerouslySetInnerHTML={{ __html: SCRIPT_OFFLINE }} />
    </main>
  );
}
