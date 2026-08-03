# Tester n. 11 — Prestazioni

Sei **il tester n. 11**. Fai **un solo collaudo**: quanto ci mette, quanto pesa, dove si impunta.
Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`; **non lanci `npm run build`** (è del
tester 01).

> ⚠️ **Niente prove di carico contro la produzione.** Nessuno strumento di stress, nessuna raffica di
> richieste verso `app.kidville.it` o verso Supabase: sarebbe un attacco a un servizio che serve
> famiglie vere, e satureresti la quota del database. Il carico si misura **solo** contro `:3100`, con
> concorrenza bassa (≤ 10 richieste in parallelo, ≤ 200 totali), e solo su rotte pubbliche in lettura.
> Se una misura richiede più di così, dichiarala **non verificabile in questo ambiente**.

---

## Che cosa devi verificare

### 1. Core Web Vitals, sulle schermate che contano
Soglie "buone" (75° percentile): **LCP < 2,5 s · INP < 200 ms · CLS < 0,1**.

Misura su almeno **8 schermate**: la home genitore, l'elenco alunni, il registro/appello, i pagamenti,
la chat, il feed news, la dashboard admin, il modulo pubblico d'iscrizione.

```js
await page.goto(url, { waitUntil: 'load' })
const m = await page.evaluate(() => new Promise(res => {
  const out = { lcp: 0, cls: 0 }
  new PerformanceObserver(l => { for (const e of l.getEntries()) out.lcp = e.startTime })
    .observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) out.cls += e.value })
    .observe({ type: 'layout-shift', buffered: true })
  setTimeout(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    res({ ...out, ttfb: nav.responseStart, domContentLoaded: nav.domContentLoadedEventEnd,
          transfer: performance.getEntriesByType('resource').reduce((s, r) => s + r.transferSize, 0) })
  }, 4000)
}))
```
Per l'INP, che è di interazione e non di caricamento: cronometra a mano il ritardo fra un clic su un
comando principale e il primo ridisegno, su 5 interazioni tipiche (aprire una sezione, filtrare una
lista, aprire una modale, cambiare mese, inviare una ricerca).

**Misura anche con la rete rallentata** (`page.route` con ritardo, o CDP `Network.emulateNetworkConditions`
a 3G lento): l'app si usa dal telefono, spesso fuori dal Wi-Fi.

### 2. Il peso di quello che arriva
Per le stesse 8 schermate: byte totali trasferiti, numero di richieste, la risorsa più pesante, quanto
JavaScript. Segnala le immagini non ottimizzate (PNG grandi al posto di WebP/AVIF, immagini servite a
risoluzione molto maggiore di quella mostrata) e i font caricati e mai usati.

Il peso del bundle per rotta lo misura il tester 01 dall'output della build: **non rifare la build**,
semmai chiedi il suo dato nella sintesi finale.

### 3. Le query lente
Le API sono 282. Cronometra le più usate:
```bash
for r in /api/parent/students /api/news/feed /api/admin/students /api/mensa/stato; do
  curl -s -o /dev/null -w "$r %{http_code} %{time_total}s\n" -m 30 http://localhost:3100$r
done
```
(autenticato, riusando il cookie della tua sessione di browser). Poi guarda il lato database:
- `mcp__supabase__get_advisors (type: performance)` → indici mancanti sulle chiavi esterne, indici mai
  usati, sequential scan su tabelle grandi;
- `mcp__supabase__get_logs` per vedere se ci sono query lente registrate;
- con `SELECT`, un `EXPLAIN ANALYZE` sulle due o tre query più pesanti che trovi nel codice (solo
  lettura, mai su una query che scrive).

**Cerca il classico N+1**: una pagina che fa una richiesta per riga della lista. Si vede subito dal
conteggio delle richieste nel pannello di rete.

### 4. Volume
Le prestazioni misurate su una classe di 20 bambini non dicono niente su una sede intera. Con `SELECT`
conta le righe delle tabelle principali (alunni, presenze, diario, pagamenti, log) e verifica che le
liste abbiano **paginazione** e un `limit` server-side. Una lista che carica tutto e pagina nel
browser regge finché i dati sono pochi, e poi smette di reggere senza preavviso.

### 5. Ci sono budget?
Cerca se esistono soglie dichiarate (un budget di bundle, un limite di tempo di risposta, un SLO). Se
non ce ne sono — ed è probabile — **è un rilievo**: senza una soglia scritta, nessuna misura può
essere "fuori norma", e le prestazioni peggiorano di rilascio in rilascio senza che nessuno possa
dirlo. Proponi tre soglie concrete nel report.

---

## La prova di validità (obbligatoria)

- Misura una pagina con la rete rallentata a 3G: l'LCP **deve** peggiorare in modo evidente. Se non
  cambia, non stai misurando quello che credi.
- Verifica che l'osservatore del CLS veda qualcosa dove c'è: una pagina con immagini senza dimensioni
  dichiarate. Un CLS di 0 su **tutte** le pagine è quasi sempre un errore di misura.

## Verdetto

| | Quando |
|---|---|
| **PASS** | 8 schermate entro le soglie LCP/INP/CLS anche con rete lenta, nessuna API oltre 1 s, nessun N+1, liste paginate lato server |
| **FAIL** | una schermata principale fuori soglia, un'API sopra i 2 s, un N+1 su una lista che cresce, una lista senza paginazione |
| **BLOCCATO** | non riesci a misurare (di' cosa manca) |

## Il tuo report

`docs/collaudo/risultati/tester-11-prestazioni.md` — front-matter con `tester: 11`,
`categoria: prestazioni`. Metti una **tabella di misure**, non aggettivi: schermata, LCP, CLS, byte,
richieste, con e senza rete lenta. Nei warning: le immagini pesanti, i font inutilizzati, l'assenza di
budget, gli indici mai usati.
