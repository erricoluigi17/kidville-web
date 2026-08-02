import type { Metadata } from 'next';
import it from '../../../messages/it/offline.json';
import en from '../../../messages/en/offline.json';
import ContenutoOffline from './ContenutoOffline';
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

// Il titolo della SCHEDA. Viene dal catalogo come tutto il resto: cablarlo qui
// significava lasciarlo italiano anche in inglese, ed è quello che succedeva —
// `curl -b 'KV_LOCALE=en' /offline` rendeva `<title>Kidville — nessuna
// connessione</title>` con `documentElement.lang="en"` e il corpo tutto in
// inglese. Il `metadata` di Next è statico per costruzione (`force-static`), e
// la lingua la sistema lo script qui sotto: è la stessa staffetta che già
// corregge `lang` e i blocchi `data-kv-lang`, non una strada nuova.
export const metadata: Metadata = {
  title: it.titoloScheda,
  description: 'Kidville non è raggiungibile: controlla la connessione e riprova.',
};

const SCRIPT_LINGUA = `(function(){try{
var m=document.cookie.match(/(?:^|; )KV_LOCALE=([^;]*)/);
var l=m?decodeURIComponent(m[1]):'it';
if(l!=='en')return;
var n=document.querySelectorAll('[data-kv-lang]');
for(var i=0;i<n.length;i++){n[i].hidden=n[i].getAttribute('data-kv-lang')!=='en';}
document.documentElement.lang='en';
document.title=${JSON.stringify(en.titoloScheda)};
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
      {/* Il corpo è un componente CLIENT: elenco e lingua sono stato di React.
          Quando la scrittura nel DOM la faceva solo lo script inline,
          l'idratazione la disfaceva — vedi il commento in testa a
          `ContenutoOffline.tsx` e i test in
          `__tests__/offline/idratazione-offline.test.tsx`. Un componente client
          NON rende dinamica la pagina: `force-static` resta valido. */}
      <ContenutoOffline testi={{ it, en }} />
      {/* Nessuna CSP nel progetto: gli script inline sono ammessi. Vedi sopra. */}
      <script dangerouslySetInnerHTML={{ __html: SCRIPT_LINGUA }} />
      <script dangerouslySetInnerHTML={{ __html: SCRIPT_OFFLINE }} />
    </main>
  );
}
