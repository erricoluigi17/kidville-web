# Fixture reali — health-check embed Instagram

Queste fixture sono corpi HTML **reali** dell'endpoint embed di Instagram, catturati col
**meccanismo esatto di produzione**: `globalThis.fetch(url, { method: 'GET' })` nudo, senza
cookie né User-Agent custom — identico a come `externalFetch('instagram', …)` chiama l'endpoint
dal runtime Node (undici) su Vercel, cioè da un IP datacenter senza sessione.

Esistono per un motivo preciso: l'health-check era stato costruito e testato su **fixture
inventate** (un corpo che dichiarava `EmbedIsBroken` / `isn't available`, e un mock `status 404`)
che **in produzione non si verificano mai**. Il collaudo del ciclo 1 (categoria *debug*) ha
dimostrato che la realtà server-side è tutt'altra. Queste fixture ancorano i test alla realtà.

## Cattura

- **Data:** 2026-07-20
- **Comando (riproducibile):**
  ```js
  const res = await fetch(url, { method: 'GET' }) // runtime Node/undici, come externalFetch
  const body = await res.text()
  ```
- **Endpoint:** `https://www.instagram.com/p/<shortcode>/embed/captioned/` (= `buildEmbedUrl`)

| File | Shortcode | Post | Status | Byte (originale) |
|---|---|---|---|---|
| `embed-inesistente-200-consent.html` | `ZZZZZZZZZZZ` | **inesistente** (non è mai esistito) | **200** | 79.998 |
| `embed-vivo-200-consent.html` | `Bt_Lm2zjM7v` | **vivo e pubblico** («world record egg», stabile da anni) | **200** | 79.998 |

## Conclusione dell'analisi differenziale (il cuore del fix C2)

**Post vivo e post inesistente sono INDISTINGUIBILI da un fetch anonimo da datacenter.**

Entrambi rispondono `200` con **lo stesso interstiziale consent/login di Meta** (bootstrap
`envFlush` / `requireLazy`), byte-identici a meno dei soli token di sessione dinamici. A parità
di analisi:

| Marker | inesistente | vivo | Significato |
|---|---|---|---|
| `cdninstagram` | 125× | 125× | marker «ok» dell'implementazione vecchia → **generico, presente ovunque** |
| `class="Embed` | 4× | 4× | idem, generico |
| `consent` / `login` / `cookie` / `requireLazy` | presenti | presenti | è la pagina consent, non l'embed |
| `og:image`, `data-instgrm`, **`EmbeddedMediaImage`** | 0 | 0 | **il media reale dell'embed NON c'è** |
| `isn't available` / `EmbedIsBroken` / `content unavailable` | 0 | 0 | **nessun marker di rimozione** |

Conseguenza per `esitoHealthCheck`:

1. I marker `ok` vecchi (`cdninstagram` / `og:image` / `class="Embed"`) sono **rimossi dal ramo
   `ok`**: erano soddisfatti anche dalla pagina consent → giudicavano `ok` sia un post vivo sia
   uno inesistente → il contatore `ig_check_falliti` veniva sempre azzerato → la soglia `≥2` non
   scattava mai → **auto-nascondimento inerte**.
2. L'interstiziale consent (ciò che si riceve SEMPRE server-side) → **`indeterminato`, MAI `ok`**:
   cade nel default `indeterminato` perché non contiene alcun marker di embed reale.
3. `ok` richiede ora **marker specifici dell'embed realmente renderizzato**
   (`EmbeddedMediaImage`, `data-instgrm-captioned`, `data-instgrm-permalink`, `class="Caption`),
   assenti dall'interstiziale consent.
4. `fallito` resta ancorato ai **soli segnali reali di rimozione**: `status 404`, o i marker di
   pagina rimossa/privata se Instagram li servisse.

**Best-effort dichiarato.** Poiché da IP datacenter l'endpoint serve quasi sempre la pagina
consent (`200`), in produzione `esitoHealthCheck` di norma restituisce `indeterminato`: non
azzera né incrementa il contatore, aggiorna solo `ig_check_il`. L'auto-nascondimento degli
Instagram rimossi è quindi **best-effort** (scatta con certezza solo su un vero `404`); la via
primaria per togliere un post IG morto resta il **ritiro manuale** dal cockpit. Il fallback
«Apri su Instagram» è sempre presente nel dettaglio. Documentato nel PRD (step E4).

## Nota sul caso `ok` nei test

Un embed **realmente renderizzato** non è ottenibile server-side (muro consent da datacenter):
non esiste quindi una fixture reale del ramo `ok`. Le asserzioni `→ ok` usano un corpo di
prova minimale che contiene i marker specifici dell'embed reale — dichiarato come tale nei test.
Le fixture reali coprono ciò che conta davvero: che il consent **non** sia mai `ok`.

## Bonifica (repo pubblico)

I token di sessione **effimeri di Meta** presenti nel corpo (`nonce`, `ajaxpipe_token`,
`compat_iframe_token`, `brsid`, `hsi`, `serverLID`, `__spin_*`, `haste_session`, il claim firmato
`hmac_ttl.*` e i timestamp epoch della richiesta) sono stati sostituiti con placeholder fissi
(`SCRUBBED` / `0` / `1700000000`). **Nessun segreto Kidville, nessuna PII reale.** Tutti i marker
strutturali letti da `esitoHealthCheck` sono preservati intatti (verificato). Non sono
credenziali: sono ciò che Meta serve a qualunque fetch anonimo.
