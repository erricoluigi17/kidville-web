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
 * quando il documento arriva dalla CacheStorage senza il bundle di Next (app
 * appena installata e senza rete: `precarica()` salva /offline, non i suoi
 * chunk). React è l'unico che funziona DOPO l'idratazione, perché il DOM lo
 * possiede lui e qualunque modifica fatta da fuori viene disfatta. Servono
 * entrambi, e la duplicazione è il prezzo.
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

function nodi(sel){return document.querySelectorAll(sel);}
function mostra(sel,visibile){var n=nodi(sel);for(var i=0;i<n.length;i++){n[i].hidden=!visibile;}}

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

function disegna(rotte){
if(!rotte||!rotte.length)return;
var liste=nodi('[data-kv-elenco]');
for(var i=0;i<liste.length;i++){
var lista=liste[i];
var lingua=lista.getAttribute('data-kv-elenco')||'it';
lista.textContent='';
for(var r=0;r<rotte.length;r++){
var li=document.createElement('li');
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

try{rotteInCache().then(disegna,function(){});}catch(e){}
try{collegaRiprova();}catch(e){}
})();`;
}
