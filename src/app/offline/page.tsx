import type { Metadata } from 'next';
import it from '../../../messages/it/offline.json';
import en from '../../../messages/en/offline.json';

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
          className="flex flex-col items-center gap-5"
        >
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">
            {testi.titolo}
          </h1>
          <p className="max-w-sm font-maven text-[15px] leading-relaxed text-white/85">
            {testi.corpo}
          </p>
          {/* `<a>` e NON `<Link>`, di proposito: questo documento viene servito
              dal Service Worker quando la rete manca, quindi non c'è alcun
              router idratato e una navigazione client-side non partirebbe. Serve
              una navigazione VERA, che ripassi dal SW. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            className="inline-flex items-center rounded-pill bg-kidville-yellow px-7 py-3 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green active:scale-95"
          >
            {testi.riprova}
          </a>
          <p className="font-maven text-xs text-white/60">{testi.nota}</p>
        </div>
      ))}
      {/* Nessuna CSP nel progetto: lo script inline è ammesso. Vedi commento sopra. */}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT_LINGUA }} />
    </main>
  );
}
