/**
 * Costruttore dello script inline della pagina `/offline`.
 *
 * PERCHÉ È UNA STRINGA E NON UN COMPONENTE. `/offline` è ciò che il Service
 * Worker serve quando la rete non c'è: arriva dalla CacheStorage come documento
 * HTML e basta, senza il bundle JS di Next, senza router, senza idratazione.
 * Tutto ciò che deve funzionare lì dentro va scritto in JS inline, in ES5, senza
 * dipendenze. Questo file la costruisce a build time (la pagina resta
 * `force-static`) e i test la eseguono TALE E QUALE in un contesto `vm` — così
 * ciò che si collauda è esattamente ciò che finisce nel documento.
 */

/**
 * Prefisso del nome della cache dello shell.
 *
 * In `public/sw.js` il nome completo è `'kidville-shell-' + VERSIONE`. Qui si
 * usa SOLO il prefisso e si enumerano le cache a runtime: un bump di `VERSIONE`
 * nel Service Worker non va tenuto allineato a mano, e il giorno in cui una
 * vecchia cache sopravvive alla pulizia le sue pagine restano raggiungibili.
 * Il lock in `__tests__/offline/pagina-offline.test.tsx` verifica che il
 * prefisso combaci con quello di `sw.js`.
 */
export const PREFISSO_CACHE_SHELL = 'kidville-shell-';

/**
 * Rotta usata come sonda di raggiungibilità della rete.
 *
 * Deve essere PUBBLICA (nessun redirect al login), statica (nessun costo
 * server) e certa di esistere: `/offline` è tutte e tre. La sonda parte in
 * `HEAD`, e `public/sw.js` esce subito su `request.method !== 'GET'`: la
 * richiesta non viene mai intercettata, quindi misura la RETE e non la cache.
 * Con una GET su un asset la sonda direbbe «c'è rete» leggendo una copia
 * salvata — cioè esattamente il falso positivo che rimetterebbe l'utente nel
 * loop da cui questa pagina lo sta tirando fuori.
 */
export const ROTTA_SONDA = '/offline';

/** Oltre questo tempo la sonda si arrende: meglio un «no» che un'attesa muta. */
export const TIMEOUT_SONDA_MS = 3000;

/**
 * ─── LA STAFFETTA FRA LO SCRIPT INLINE E REACT ─────────────────────────────
 * Due implementazioni scrivono nello stesso `<ul data-kv-elenco>` (il perché è
 * più sotto): senza una regola di possesso, in produzione l'elenco è uscito
 * DOPPIO — sei voci per tre rotte, ogni pagina due volte. Succede quando la
 * CacheStorage risponde DOPO l'idratazione: React idrata una `<ul>` vuota e la
 * fa sua, poi lo script inline vi infila i propri `<li>`, poi React appende i
 * suoi senza vedere gli altri.
 *
 * La regola è una sola riga di contratto: **la lista appartiene a React da
 * quando React lo dichiara, e da quel momento lo script inline non la tocca
 * più**. Il possesso si dichiara con un attributo sul nodo — non con una
 * variabile globale — perché così vale per-nodo, si azzera insieme al DOM e
 * non sopravvive a un remount.
 *
 * Nell'ordine inverso (script inline prima dell'idratazione) React non può
 * "non toccare": ha già in mano il nodo. Allora ciò che lo script inline
 * disegna è marcato, e React lo rimuove quando prende possesso — invece di
 * sommarcisi.
 */

/** Attributo sul nodo dell'elenco: `react` = da qui in poi la lista è di React. */
export const ATTRIBUTO_POSSESSO = 'data-kv-owner';

/**
 * ─── E LA STAFFETTA NON BASTAVA: IL MISMATCH DI IDRATAZIONE ────────────────
 * La regola di possesso qui sopra risolve il DOPPIONE, non il MISMATCH.
 * Misurato in collaudo (2026-08-02): con qualche rotta in CacheStorage,
 * `/offline` riportava a ogni caricamento il React #418 — «Hydration failed
 * because the server rendered HTML didn't match the client. As a result this
 * tree will be regenerated on the client». Il markup del server ha le due liste
 * VUOTE; il DOM, al momento dell'idratazione, ne aveva 17-18 voci per lista,
 * messe lì da questo script. **Qualunque nodo aggiunto prima dell'idratazione è
 * un mismatch**, e il prezzo è che React butta l'HTML del server e ricostruisce
 * l'intero albero.
 *
 * La via d'uscita non è ritardare alla cieca — sarebbe rallentare proprio il
 * caso in cui questo script è l'unica cosa che funziona — ma FARE UNA DOMANDA
 * al documento: React arriverà?
 *
 *  · **Nessun `<script src=".../_next/...">` nel documento** → non c'è bundle,
 *    React non idraterà mai: si disegna SUBITO, senza un millisecondo d'attesa.
 *    Attenzione a cosa dice davvero questa condizione: guarda i TAG del
 *    documento, non se il loro contenuto sia arrivato. `/offline` è HTML
 *    statico e i tag ce li ha sempre, anche servito dalla CacheStorage: qui ci
 *    si passa solo con un guscio che non ne ha (la `SHELL_MINIMA` di
 *    `public/sw.js`).
 *  · **Il bundle c'è** → si aspetta. O React dichiara il possesso — e allora qui
 *    non si tocca nulla, e il mismatch non può esistere — oppure uno di quegli
 *    script FALLISCE, e si disegna subito lo stesso.
 *  · **Ultima rete**: `ATTESA_REACT_MS`. Serve al caso in cui l'evento `error`
 *    è già passato prima che noi potessimo ascoltarlo, o in cui il bundle si
 *    carica ma l'idratazione non arriva (un errore nel bundle stesso). Meglio un
 *    elenco in ritardo di un elenco mai.
 *
 * ─── QUELL'`error` NON SIGNIFICA «REACT NON ARRIVERÀ» ──────────────────────
 * Per tre giri di questo commento qui c'era scritto che un chunk che non si
 * carica rende «l'idratazione impossibile». È vero solo se falliscono TUTTI.
 * Con 14 chunk su 15 in cache — che è lo stato stazionario di chi ha usato
 * l'app qualche volta, perché i chunk condivisi con `/auth/login` li scrive
 * `assetStatico` durante la navigazione normale — React PARTE, non trova
 * l'unico che gli manca e muore: l'error boundary sostituisce l'intero albero,
 * compreso ciò che questo script aveva appena disegnato. È il difetto T16-F1
 * (misurato il 2026-08-03 su una build di produzione, 3 volte su 3): senza rete
 * si leggeva «QUALCOSA È ANDATO STORTO» invece della pagina «non sei in rete».
 *
 * La correzione NON sta qui — un elenco che l'error boundary cancella un
 * istante dopo non lo salva nessun ritardo — ma in `public/sw.js`:
 * `precaricaSottoRisorse()` salva il documento **insieme** alle sue
 * sotto-risorse `/_next/`, così il bundle o c'è tutto o non c'è affatto. Questo
 * `error` resta quel che è sempre stato: l'unico segnale disponibile che
 * qualcosa manca. Disegnare è comunque meglio che fissare un elenco vuoto fino
 * alla scadenza, e se poi React arriva la staffetta qui sotto tiene.
 */

/**
 * Selettore dei chunk di Next nel documento. `*="/_next/"` copre sia il path
 * relativo sia un `assetPrefix` assoluto (CDN).
 */
export const SELETTORE_BUNDLE_NEXT = 'script[src*="/_next/"]';

/**
 * Tetto d'attesa di React quando il bundle è nel documento. Non è il meccanismo
 * principale (lo sono le due condizioni qui sopra): è la rete di sicurezza, e
 * per questo può permettersi di essere generosa.
 */
export const ATTESA_REACT_MS = 1200;

/** Attributo sui nodi creati dallo script inline: sono quelli che React rimuove. */
export const ATTRIBUTO_INLINE = 'data-kv-inline';

/** Etichette leggibili per le rotte, in UNA lingua. */
export interface DizionarioEtichette {
  /** Path completo → etichetta (le home di area, che non hanno un segmento utile). */
  esatte: Record<string, string>;
  /** Ultimo segmento del path → etichetta (copre tutte le aree in un colpo solo). */
  segmenti: Record<string, string>;
}

/**
 * Estensioni che NON sono pagine. Sorgente unica: la usano sia lo script inline
 * (inlinata qui sotto) sia le funzioni TS.
 */
const ASSET = /\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|json|txt|xml)$/i;

/* ─────────────────────────────────────────────────────────────────────────────
 * Le funzioni qui sotto sono la versione TS di ciò che lo script inline fa in
 * ES5, e servono al componente client `ContenutoOffline.tsx` — cioè al percorso
 * che vale DOPO l'idratazione di React.
 *
 * PERCHÉ ESISTONO DUE IMPLEMENTAZIONI. Lo script inline è l'unico che funziona
 * quando il documento arriva dalla CacheStorage senza un bundle di Next
 * COMPLETO: la `SHELL_MINIMA`, un pre-cache interrotto a metà, lo sviluppo (dove
 * i chunk non sono immutabili e non si cachano), un dispositivo col Service
 * Worker vecchio. Non è più il caso NORMALE: dal 2026-08-03 `precarica()` salva
 * /offline **e** le sue sotto-risorse `/_next/` — prima ne salvava il solo
 * documento, ed era il difetto T16-F1. React è l'unico che funziona DOPO
 * l'idratazione, perché il DOM lo possiede lui e qualunque modifica fatta da
 * fuori viene disfatta. Servono entrambi, e la duplicazione è il prezzo.
 *
 * Quel prezzo non lo si paga in silenzio: `__tests__/offline/equivalenza-offline.test.ts`
 * esegue le due implementazioni sugli STESSI ingressi e pretende lo stesso
 * risultato. Se divergono, il gate diventa rosso.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Da chiavi di cache a rotte mostrabili: solo same-origin, niente `/offline`
 * (è la pagina su cui siamo), niente `/_next/`, niente asset, niente query,
 * senza duplicati e in ordine.
 */
export function rotteDaChiaviCache(chiavi: readonly string[], origin: string): string[] {
  const visti = new Set<string>();
  const rotte: string[] = [];
  for (const chiave of chiavi) {
    let u: URL;
    try {
      u = new URL(chiave);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const p = u.pathname;
    if (p === ROTTA_SONDA) continue;
    if (p.startsWith('/_next/')) continue;
    if (ASSET.test(p)) continue;
    if (visti.has(p)) continue;
    visti.add(p);
    rotte.push(p);
  }
  rotte.sort();
  return rotte;
}

/** Etichetta leggibile di una rotta: esatta, poi per ultimo segmento, poi derivata. */
export function etichettaRotta(dizionario: DizionarioEtichette, path: string): string {
  if (dizionario.esatte[path]) return dizionario.esatte[path];
  const parti = path.split('/');
  const ultimo = parti[parti.length - 1] || '';
  if (dizionario.segmenti[ultimo]) return dizionario.segmenti[ultimo];
  if (!ultimo) return path;
  let leggibile = ultimo;
  try {
    leggibile = decodeURIComponent(ultimo);
  } catch {
    // Escape malformata (`%zz` → URIError): si tiene il segmento grezzo. Una
    // chiave storta non deve far sparire l'intero elenco.
    leggibile = ultimo;
  }
  const t = leggibile.replace(/[-_]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Legge le rotte da TUTTE le cache col prefisso dello shell. Non rigetta mai:
 * su questa pagina un'eccezione significa elenco vuoto, non pagina rotta.
 */
export async function leggiRotteInCache(origin: string): Promise<string[]> {
  try {
    if (typeof caches === 'undefined') return [];
    const nomi = await caches.keys();
    const chiavi: string[] = [];
    for (const nome of nomi) {
      if (!nome.startsWith(PREFISSO_CACHE_SHELL)) continue;
      try {
        const cache = await caches.open(nome);
        for (const req of await cache.keys()) chiavi.push(req.url);
      } catch {
        // Una cache illeggibile non deve far perdere le altre.
      }
    }
    return rotteDaChiaviCache(chiavi, origin);
  } catch {
    return [];
  }
}

/**
 * Sonda di raggiungibilità: `HEAD` con timeout. `true` = la rete risponde.
 * Non rigetta mai — un rifiuto qui vale «non c'è rete».
 */
export async function sondaRete(): Promise<boolean> {
  let annulla: AbortController | null = null;
  try {
    annulla = new AbortController();
  } catch {
    annulla = null;
  }
  const timer = setTimeout(() => {
    try {
      annulla?.abort();
    } catch {
      // AbortController non supportato: si aspetta il rifiuto naturale della fetch.
    }
  }, TIMEOUT_SONDA_MS);
  try {
    await fetch(`${ROTTA_SONDA}?kv=${Date.now()}`, {
      method: 'HEAD',
      cache: 'no-store',
      ...(annulla ? { signal: annulla.signal } : {}),
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lingua scelta dal genitore, dal cookie `KV_LOCALE`. Stessa regola dello
 * script inline: tutto ciò che non è `en` è italiano (il default dell'app).
 */
export function linguaDalCookie(cookie: string): 'it' | 'en' {
  const m = /(?:^|; )KV_LOCALE=([^;]*)/.exec(cookie);
  if (!m) return 'it';
  let valore = m[1];
  try {
    valore = decodeURIComponent(m[1]);
  } catch {
    valore = m[1];
  }
  return valore === 'en' ? 'en' : 'it';
}

/** Classi dei link dell'elenco. Stanno qui perché li crea lo script, non il JSX. */
const CLASSI_LINK =
  'block rounded-2xl bg-white/10 px-5 py-3 font-maven text-sm font-semibold text-white underline-offset-4 active:scale-95';

/**
 * @param dizionari etichette per lingua (`{ it: …, en: … }`), inlinate nello
 *   script: la pagina rende ENTRAMBE le lingue e l'elenco va riempito in
 *   entrambe, perché la lingua la sceglie un altro script leggendo il cookie.
 */
export function costruisciScriptOffline(
  dizionari: Record<string, DizionarioEtichette>
): string {
  return `(function(){
var PREFISSO=${JSON.stringify(PREFISSO_CACHE_SHELL)};
var DIZ=${JSON.stringify(dizionari)};
var CLASSI=${JSON.stringify(CLASSI_LINK)};
var ASSET=/${ASSET.source}/i;
var POSSESSO=${JSON.stringify(ATTRIBUTO_POSSESSO)};
var INLINE=${JSON.stringify(ATTRIBUTO_INLINE)};
var BUNDLE=${JSON.stringify(SELETTORE_BUNDLE_NEXT)};
var ATTESA=${ATTESA_REACT_MS};

function nodi(sel){return document.querySelectorAll(sel);}
function mostra(sel,visibile){var n=nodi(sel);for(var i=0;i<n.length;i++){n[i].hidden=!visibile;}}

/* La staffetta: se React ha dichiarato il possesso, questa pagina non è più
   nostra. Vale per l'elenco e per «Riprova»: due sonde per un click sono due
   richieste di rete su una pagina che esiste perché la rete non c'è. */
function reactPossiede(){
var liste=nodi('[data-kv-elenco]');
for(var i=0;i<liste.length;i++){if(liste[i].getAttribute(POSSESSO)==='react')return true;}
return false;
}

function etichetta(lingua,path){
var d=DIZ[lingua]||DIZ.it;
if(d.esatte[path])return d.esatte[path];
var parti=path.split('/');
var ultimo=parti[parti.length-1]||'';
if(d.segmenti[ultimo])return d.segmenti[ultimo];
if(!ultimo)return path;
var leggibile=ultimo;
try{leggibile=decodeURIComponent(ultimo);}catch(e){leggibile=ultimo;}
var t=leggibile.replace(/[-_]+/g,' ');
return t.charAt(0).toUpperCase()+t.slice(1);
}

function rotteInCache(){
return caches.keys().then(function(nomi){
var shell=[];
for(var i=0;i<nomi.length;i++){if(nomi[i].indexOf(PREFISSO)===0)shell.push(nomi[i]);}
return Promise.all(shell.map(function(n){
return caches.open(n).then(function(c){return c.keys();}).catch(function(){return [];});
}));
}).then(function(gruppi){
var visti={},rotte=[];
for(var g=0;g<gruppi.length;g++){
var chiavi=gruppi[g]||[];
for(var k=0;k<chiavi.length;k++){
var u;
try{u=new URL(chiavi[k].url);}catch(e){continue;}
if(u.origin!==location.origin)continue;
var p=u.pathname;
if(p===${JSON.stringify(ROTTA_SONDA)})continue;
if(p.indexOf('/_next/')===0)continue;
if(ASSET.test(p))continue;
if(visti[p])continue;
visti[p]=1;rotte.push(p);
}
}
rotte.sort();
return rotte;
});
}

/* QUANDO tocca a noi disegnare — vedi la testata di ATTESA_REACT_MS.
   Chiama \`azione\` UNA volta sola, e solo se React non è (ancora) arrivato. */
function quandoTocca(azione){
var bundle=document.querySelectorAll(BUNDLE);
/* Nessun chunk di Next: React non idraterà mai, la pagina è nostra. Subito. */
if(!bundle.length){azione();return;}
var fatto=false;
function ora(){
if(fatto)return;
fatto=true;
/* React è arrivato: da qui in poi la pagina non è più nostra. */
if(reactPossiede())return;
azione();
}
/* L'ultima rete si arma PER PRIMA: se qualcosa andasse storto qui sotto,
   l'elenco deve comparire lo stesso. */
setTimeout(ora,ATTESA);
/* Un chunk che non si carica. Se falliscono TUTTI, React non idraterà mai e la
   pagina è nostra; se ne manca UNO SOLO, React parte e poi muore, e l'elenco lo
   cancella l'error boundary (il difetto T16-F1: la cura sta in public/sw.js,
   che pre-cacha i pezzi insieme al documento). In entrambi i casi aspettare
   ancora non serve a niente, quindi si disegna. */
for(var i=0;i<bundle.length;i++){bundle[i].addEventListener('error',ora);}
}

function disegna(rotte){
if(reactPossiede())return;
if(!rotte||!rotte.length)return;
var liste=nodi('[data-kv-elenco]');
for(var i=0;i<liste.length;i++){
var lista=liste[i];
var lingua=lista.getAttribute('data-kv-elenco')||'it';
lista.textContent='';
for(var r=0;r<rotte.length;r++){
var li=document.createElement('li');
li.setAttribute(INLINE,'');
var a=document.createElement('a');
a.setAttribute('href',rotte[r]);
a.className=CLASSI;
a.textContent=etichetta(lingua,rotte[r]);
li.appendChild(a);
lista.appendChild(li);
}
}
mostra('[data-kv-disponibili]',true);
mostra('[data-kv-corpo="cache"]',true);
mostra('[data-kv-corpo="vuota"]',false);
}

function sonda(){
return new Promise(function(risolvi){
var chiuso=false,ctrl=null,timer=null;
function esito(v){if(chiuso)return;chiuso=true;if(timer!==null)clearTimeout(timer);risolvi(v);}
try{ctrl=new AbortController();}catch(e){ctrl=null;}
timer=setTimeout(function(){
if(chiuso)return;
if(ctrl){try{ctrl.abort();}catch(e){}}
esito(false);
},${TIMEOUT_SONDA_MS});
var opz={method:'HEAD',cache:'no-store'};
if(ctrl)opz.signal=ctrl.signal;
try{
fetch(${JSON.stringify(ROTTA_SONDA)}+'?kv='+Date.now(),opz).then(function(){esito(true);},function(){esito(false);});
}catch(e){esito(false);}
});
}

function collegaRiprova(){
var inCorso=false;
var b=nodi('[data-kv-riprova]');
for(var i=0;i<b.length;i++){
b[i].addEventListener('click',function(ev){
if(reactPossiede())return;
if(ev&&ev.preventDefault)ev.preventDefault();
if(inCorso)return;
inCorso=true;
mostra('[data-kv-nessuna-rete]',false);
sonda().then(function(ok){
inCorso=false;
if(ok){location.assign('/');return;}
mostra('[data-kv-nessuna-rete]',true);
},function(){
inCorso=false;
mostra('[data-kv-nessuna-rete]',true);
});
});
}
}

/* La lettura della cache parte SUBITO (è la parte lenta), il disegno aspetta il
   proprio turno: le due cose sono indipendenti, e chi arriva secondo non
   rallenta il primo. */
try{
var pronte=rotteInCache().then(function(r){return r;},function(){return [];});
quandoTocca(function(){pronte.then(disegna,function(){});});
}catch(e){}
try{collegaRiprova();}catch(e){}
})();`;
}
