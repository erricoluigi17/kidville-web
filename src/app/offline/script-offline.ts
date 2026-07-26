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
var ASSET=/\\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|json|txt|xml)$/i;

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
