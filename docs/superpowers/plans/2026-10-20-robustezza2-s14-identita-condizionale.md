# Sessione 14 — Identità, condizionale — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** solo se la misura del Passo 0 supera la soglia T10 e il titolare riapre la decisione del 12/10, le **letture** verificano la firma del token in locale (`getClaims()`), le scritture continuano a chiedere ad Auth (`getUser()`), e `risolviDaAuthUid` si legge una volta per richiesta.

**Architettura:** `withRoute` mette il verbo HTTP nel contesto della richiesta (`src/lib/logging/context.ts`). Un modulo nuovo, `src/lib/auth/verifica-sessione.ts`, decide la strada: `GET`/`HEAD` dentro `withRoute`, oppure una pagina che si dichiara lettura (`letturaDiPagina`), passano dalla verifica locale con le chiavi pubbliche tenute in `src/lib/auth/chiavi-firma.ts` (uscite dal middleware, che le usa dallo stesso modulo); ogni altro verbo, il verbo assente e chi chiede `sempreAlServer` vanno ad Auth. `risolviDaAuthUid` si ricorda per la durata della richiesta con `ricordaPerRichiesta`, una memoria appesa allo store di `AsyncLocalStorage` aperto da `withRoute` (non `cache()` di React), e un lock testuale impedisce che una scrittura passi da `getClaims()`.

**Tecnologie:** Next.js 16.3 (route handler su Node, `src/middleware.ts` sull'Edge), `@supabase/ssr` 0.10.3, `@supabase/supabase-js` / `@supabase/auth-js` 2.112.0 (`getSession`, `getClaims`, `getUser`), WebCrypto, `AsyncLocalStorage`, vitest, i lock testuali di `__tests__/architecture/` con `__tests__/fixtures/sorgente.ts`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 14 — Identità, condizionale» (righe 773-806 il 20/10: si cerca il titolo), con la soglia T10 della §2 (riga 59, e righe 63-64: «le decisioni non si riaprono dentro un piano»), la dipendenza dalla sessione 7 della §3, le regole comuni della §5 (prerequisiti, chiusura della precedente, tabella di stato in due tempi, ramo `-esito` per l'ultima sessione, «Misure di controllo» con la terza fotografia di fine serie) e il formato della §6 («Apertura e chiusura», «Per la sessione dopo»).

---

## Come si legge questo piano

Il piano ha **due uscite**, e solo una delle due porta codice.

1. Si fa il **Passo 0** (sola lettura). La tabella 0.10 dice dove andare.
2. **Uscita 1 — «non serve».** Sotto la soglia, oppure con un token che non si può verificare in locale, oppure se il titolare risponde «no»: una PR di soli documenti (prima la chiusura della sessione rilasciata per ultima, poi la riga 14 «in revisione» e una voce nel PRD). Nessun compito di codice.
4. **Dopo il merge, in tutte e due le uscite**, il ramo di soli documenti `robustezza2/s14-esito` chiude la sessione 14 e la serie: stato finale, misura «dopo», misure maturate tardi delle sessioni prima, terza fotografia completa (sezione «Per la sessione dopo», in fondo).
3. **Uscita 2 — sopra la soglia.** Il piano **si ferma** prima del Compito 1 e chiede al titolare di riaprire la decisione del 12/10 con i numeri nuovi. Solo con un «sì» scritto si va ai Compiti 1-11.

Una sessione alla volta (§5): mentre si lavora a questa, nessun'altra sessione della seconda serie apre un ramo.

---

## Mappa dei file

Righe lette il 20/10 su `main` (`4c6df438`). Il Compito 1 le fa ricontrollare sul ramo nuovo: se nel frattempo un'altra sessione ha toccato questi file, i numeri si spostano, i blocchi di codice no.

| File | Ruolo in questa sessione | Righe |
|---|---|---|
| `src/lib/logging/context.ts` | Contesto per richiesta. Riceve il campo `verbo` (normalizzato da `verboSicuro`) e la memoria `ricordaPerRichiesta`. | `ContestoRichiesta` 29-59; `conContesto` 121-132; `REQUEST_ID_PLAUSIBILE`/`requestIdSicuro` 144-153; `impostaUtente` 172-182 |
| `src/lib/logging/with-route.ts` | Apre il contesto. Ci mette il verbo letto dalla `Request` con `verboGrezzo`. | apertura del contesto 182; `requestIdGrezzo` 314-316; `intestazione` 318-326 |
| `src/lib/auth/chiavi-firma.ts` (**nuovo**) | Cache di modulo delle chiavi pubbliche (JWKS) e lettura dell'intestazione del token. Gira su Edge e su Node: importa solo `public-config`, niente `fetch(`, niente `Buffer`. | — |
| `src/middleware.ts` | Perde la cache delle chiavi (passa al modulo nuovo) e due commenti diventano veri. La chiamata `chiaviDiFirma(fetchBudget)` resta. | import 1-6; cache e commento 207-283; commento «DOVE GUARDARE INVECE» 363-366; `chiaviDiFirma` 375; `getClaims` 399-408 |
| `src/lib/auth/verifica-sessione.ts` (**nuovo**) | `verificaSessione`: decide «locale» o «server», verifica, ripiega. Ospita `livelloErroreSessione` (spostata). | — |
| `src/lib/auth/require-staff.ts` | `resolveIdentity` passa da `verificaSessione`; `risolviDaAuthUid` si ricorda per richiesta; `resolveSessionAppId` e `requireSessioneAuth` restano ad Auth (`sempreAlServer`). Dal Compito 8 `requireUser`, `requireStaff`, `requireDocente`, `utenteDellaRichiesta` e `resolveIdentity` accettano `opzioni` e le passano fino a `verificaSessione`. | import 2-4; `risolviDaAuthUid` 202-230; `livelloErroreSessione` 232-250; `resolveIdentity` 266-327 (sessione 270-287, lookup 288-302); `resolveSessionAppId` 334-352; `utenteDellaRichiesta` 465-468; `requireSessioneAuth` 696-746 (sessione 704-714); `requireStaff` 779-784; `requireUser` 827-828; `requireDocente` 914-919 |
| `src/lib/auth/profili.ts` | `getSessionProfili(opzioni)` passa da `verificaSessione`. | import 1-6; `getSessionProfili` 100-122 (`getUser` 103, scala 108-112) |
| `src/lib/auth/area-guard.ts` | `requireArea` dichiara `letturaDiPagina`. | `requireArea` 84-90 (`getSessionProfili` 87) |
| `src/app/page.tsx` | La radice `/` dichiara `letturaDiPagina`. | 17 |
| `src/app/api/me/route.ts` | **Non cambia**: resta su `getUser()` (riga 41), come chiede la specifica. Il lock lo tiene. | 41 |
| `src/app/api/chat/messages/route.ts`, `src/app/api/news/feed/[id]/route.ts`, `src/app/api/admin/protocolli/categorie/route.ts`, `src/app/api/primaria/scrutinio/route.ts` | Compito 8: il gate della `GET`, che scrive, passa `{ sempreAlServer: true }`. La sessione 12 cambia il primo file e la sessione 10 il quarto, in altri punti: si trovano per contenuto. | apertura della `GET` e gate: 229-235; 38-40; 42-44; 179-181 |
| `src/app/api/chat/threads/route.ts` | Solo letto: dopo la sessione 12 la sua `GET` chiama `chat_riepilogo_conversazioni`, che entra in `RPC_NEI_GET` del lock. La sessione 12 sposta anche l'`UPDATE` di `delivered_at` in una route nuova, `src/app/api/chat/threads/consegnati/route.ts` (`POST`): è una scrittura con il verbo giusto, va ad Auth da sé, e il lock non la elenca (legge solo i corpi dei `GET`). | la `GET` |
| `__tests__/architecture/gate-coverage.test.ts` | `verificaSessione(` diventa una forma di gate senza nome. La sessione 7 cambia lo stesso file: si cerca `const GATE_SENZA_NOME`, non la riga. | commento 95-98; `GATE_SENZA_NOME` 99; due giri 247-260 |
| `__tests__/lib/resolveIdentity.test.ts` | L'asserzione sul log di sessione guadagna `canale: 'server'`. | 202 |
| `__tests__/lib/middleware-tetto.test.ts` | Solo il commento sopra i test 7 (ora falso in due punti). | 464-473 |
| `__tests__/lib/logging-context-verbo.test.ts` (**nuovo**) | Il verbo nel contesto, da `conContesto` e da `withRoute`. | — |
| `__tests__/lib/logging-context-memoria.test.ts` (**nuovo**) | `ricordaPerRichiesta`: una richiesta una lettura, due richieste due. | — |
| `__tests__/lib/auth/chiavi-firma.test.ts` (**nuovo**) | Cache, «no» ricordato, riprova, intestazione del token. | — |
| `__tests__/lib/auth/verifica-sessione.test.ts` (**nuovo**) | Le due strade con il client vero di `@supabase/ssr` e chiavi ES256 vere. | — |
| `__tests__/lib/auth/identita-per-richiesta.test.ts` (**nuovo**) | `resolveIdentity` due volte nella stessa richiesta: una lettura di `utenti` e una di `parents`. | — |
| `__tests__/lib/auth/area-guard-lettura.test.ts` (**nuovo**) | Layout e radice chiamano `getSessionProfili({ letturaDiPagina: true })`. | — |
| `__tests__/lib/auth/get-che-scrivono-al-server.test.ts` (**nuovo**) | I gate passano le opzioni a `verificaSessione`; `sempreAlServer` arriva fino in fondo. | — |
| `__tests__/architecture/identita-letture-scritture.test.ts` (**nuovo**) | Il lock: chi verifica in locale, chi chiede ad Auth, quali `GET` scrivono. | — |
| `PRD REGISTRO ELETTRONICO.md` | Voce datata in cima (Compito 10, oppure Uscita 1, U1.5), con Stato «in revisione»; lo Stato finale sul ramo `robustezza2/s14-esito`. Nel primo commit, lo Stato della voce della sessione chiusa (Compito 1, Passo 5, oppure U1.3). | 1 |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Riga 14 della tabella di stato, trovata con `grep -n "^| 14 |"`: «in revisione» nella PR della sessione (Compito 11, Passo 5, oppure U1.4); lo stato finale sul ramo `robustezza2/s14-esito`. Nel primo commit, la riga della sessione chiusa. | 38 il 20/10 |
| `__tests__/fixtures/*.json`, `__tests__/architecture/soglia-fotografia.ts` | Solo nel primo commit, se la sessione chiusa lo chiede nel suo «Per la sessione dopo» (Compito 1, Passo 5, oppure U1.3). | — |
| `docs/analisi-robustezza-<AAAA-MM-GG>.md` (**nuovo**, sul ramo `robustezza2/s14-esito`) | La terza fotografia di fine serie: le 14 misure della §4 di `docs/analisi-robustezza-2026-10-20.md`, misurate nello stesso modo (sezione «Per la sessione dopo»). | — |
| `supabase/config.toml` | Solo letto: `jwt_expiry = 3600` in locale. Quello di produzione lo legge il Passo 0.8. | 160 |

Numeri che il piano usa e da dove vengono (letti, non stimati):
- `GET`/`HEAD` avvolti in `withRoute` sotto `src/app/api`: **245** corpi (scansione testuale del 20/10); `route.ts` in tutto: 375. Nessuno contiene `.delete(`, `.remove(` o `auth.admin`.
- `GET` che scrivono come effetto della lettura: **4** file — `src/app/api/chat/messages/route.ts` (`.update({ read_at })`, righe 318-322), `src/app/api/news/feed/[id]/route.ts` (`upsert` in `news_visualizzazioni`, 88-91), `src/app/api/admin/protocolli/categorie/route.ts` (`insert` delle categorie predefinite, 80-83), `src/app/api/primaria/scrutinio/route.ts` (`insert` della riga di scrutinio, 247-251). Righe del 20/10: la sessione 12 cambia `chat/messages/route.ts` e la sessione 10 `primaria/scrutinio/route.ts`, quindi il Compito 8 le trova per contenuto (l'apertura della `GET` e il suo gate). Sono scritture: con il Compito 8 il loro gate chiede ad Auth anche se il verbo è `GET` (`sempreAlServer`).
- `GET` che chiamano RPC: **5** file dopo le sessioni 2 e 12, che vengono prima di questa. Il 20/10 erano 5 file, ma diversi: la sessione 2 cancella `admin/setup-registro` (le sette `exec_sql`), e la sessione 12 fa chiamare alla `GET` di `chat/threads` la RPC `chat_riepilogo_conversazioni` (`STABLE`, `SECURITY INVOKER`, `EXECUTE` solo a `service_role`). I cinque: `admin/chat/ricerca` (`chat_vigilanza_ricerca`), `pagamenti/cassa/dettaglio` (`report_cassa_dettaglio`), `pagamenti/cassa/report` (`conteggio_cassa_provenienza`, `report_cassa_aggregato`), `pagamenti/genera-servizi` (`servizi_da_generare`), `chat/threads` (`chat_riepilogo_conversazioni`): sei RPC.
- Nessun file `'use server'` in `src/`: nessuna Server Action, quindi un layout si rende solo su `GET`.
- `auth.getUser(` nel codice di `src/` (commenti esclusi): `me/route.ts:41`, `panic-alert/route.ts:26` (POST), `src/app/m/[token]/page.tsx:49`, `require-staff.ts:272,337,706`, `profili.ts:103`. `getClaims(` solo in `middleware.ts:402`.

---

## Passo 0 — misura prima

Tutto in **sola lettura**: log di Supabase (strumento `query_logs` del server MCP Supabase, oppure Logs Explorer del pannello), `SELECT` sul database di produzione, `curl` in `GET` su un indirizzo pubblico, il pannello del titolare. Nessuna scrittura, nessun token stampato, nessuna chiave stampata. I risultati vanno nelle note di sessione, **con giorno della settimana, data e ora UTC e finestra**; finiranno nella PR e nel PRD.

Le misure valgono **sette giorni**: se fra il Passo 0 e il Compito 1 ne passano di più, il Passo 0 si rifà da capo.

- [ ] **0.1 Ora UTC e conteggio delle domande d'iscrizione**

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ %A"
```

```sql
SELECT count(*) FROM enrollment_submissions;
```

Annota il numero con l'ora UTC. È una lettura: non chiede conferma a nessuno.

- [ ] **0.2 Il token è firmato con una chiave asimmetrica?**

Prima le chiavi pubbliche del progetto (indirizzo pubblico, nessun segreto):

```bash
curl -s https://uimulkjyekgemjakmepp.supabase.co/auth/v1/.well-known/jwks.json | jq -c '[.keys[]? | {alg, kid, kty}]'
```

Se la risposta è un errore di autorizzazione invece di un elenco, si ripete con la chiave **pubblica** del progetto, letta dal file e **mai** stampata:

```bash
ANON=$(grep -o "eyJ[A-Za-z0-9._-]*" /Users/lerri/kidville-web/src/lib/supabase/public-config.ts | head -1)
curl -s -H "apikey: $ANON" https://uimulkjyekgemjakmepp.supabase.co/auth/v1/.well-known/jwks.json | jq -c '[.keys[]? | {alg, kid, kty}]'
unset ANON
```

Atteso: almeno una chiave con `alg` `ES256` (il 05/10 era così). Una chiave pubblicata però può essere solo **in attesa** («standby»): quale firma davvero lo dice il token. Il titolare, da un browser in cui è entrato nell'app di produzione, apre la console degli strumenti per sviluppatori e incolla questo frammento, che stampa **solo** `alg`, `kid` e `role` — mai il token:

```js
(() => {
  const nome = 'sb-uimulkjyekgemjakmepp-auth-token';
  const pezzi = document.cookie.split('; ')
    .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)])
    .filter(([n]) => n === nome || n.startsWith(nome + '.'))
    .sort(([a], [b]) => Number(a.split('.')[1] ?? -1) - Number(b.split('.')[1] ?? -1))
    .map(([, v]) => v);
  if (pezzi.length === 0) return 'nessun cookie di sessione leggibile';
  let grezzo = pezzi.join('');
  if (grezzo.startsWith('base64-')) {
    const b = grezzo.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    grezzo = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  } else {
    grezzo = decodeURIComponent(grezzo);
  }
  const parte = (i) => {
    const b = JSON.parse(grezzo).access_token.split('.')[i].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4)));
  };
  const { alg, kid } = parte(0);
  const { role } = parte(1);
  return { alg, kid, role };
})();
```

Se stampa `nessun cookie di sessione leggibile`, il titolare guarda invece il pannello Supabase, **Project Settings → JWT Keys**: quale chiave è «Current key» (ECC P-256 = `ES256`; «Legacy HS256» = simmetrica).

Esito:
- `alg` `ES256` (o `RS256`) **e** quel `kid` compare nell'elenco del `curl` → si prosegue;
- qualunque altro caso → **token non asimmetrico**: `getClaims()` ripiegherebbe su `getUser()` e non si guadagnerebbe niente. Si va all'Uscita 1, variante «token non asimmetrico», anche se i numeri dei passi seguenti fossero sopra la soglia.

- [ ] **0.3 I nomi dei campi dei log sono quelli giusti?**

Il filtro sul percorso (`request.path`) è quello usato il 05/10 e il 20/10 (ricetta della fase 1); `request.method` non è mai stato usato. Si verificano entrambi su una finestra di un'ora di un giorno feriale (`iso_timestamp_start` / `iso_timestamp_end`, per esempio `…T09:00:00Z` → `…T10:00:00Z`):

```sql
select toString(log_attributes['request.method']) as verbo,
  toString(log_attributes['request.path']) as percorso, count(*) as n
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.path']) like '/auth/v1/%'
group by verbo, percorso order by n desc limit 10
```

Atteso: in testa `GET` `/auth/v1/user`, poi `POST` `/auth/v1/token` e poco altro. Se `percorso` è vuoto ovunque, il campo ha un altro nome: si riprova con `toString(log_attributes['request.url']) like '%/auth/v1/user%'` al posto del filtro sul percorso, e da qui in avanti si usa quella forma. Se nemmeno così compare niente, **ci si ferma**: senza un filtro verificato la soglia non si misura, e il titolare va avvisato con la query e il risultato vuoto.

- [ ] **0.4 Scegli il giorno**

Un giorno feriale (lunedì-venerdì, non festivo), dentro la ritenzione dei log (la misura del 20/10 ha letto il 19/10: un giorno indietro funziona). Il backup notturno ha sforato fino alla punta il 19 e il 20/10: controlla che quel giorno non sia girato fra le 07:55 e le 08:05 UTC.

```bash
gh run list --repo erricoluigi17/kidville-web --workflow backup-notturno.yml --limit 10 --json createdAt,updatedAt,conclusion | jq -c '.[]'
```

Se un'esecuzione copre la finestra 07:55–08:05 del giorno scelto, scegli un altro giorno feriale: la soglia misura l'identità, non il backup. Se la sessione 4 ha già spostato il backup alle 02:23 fuori da GitHub, il controllo resta e dà «nessuna sovrapposizione».

- [ ] **0.5 Il p95 in punta (soglia: 300 ms)**

Query 2 bis (`docs/roadmap-robustezza.md`, righe 488-497) con il filtro sul percorso, finestra `iso_timestamp_start = '{giorno}T07:55:00Z'`, `iso_timestamp_end = '{giorno}T08:05:00Z'`:

```sql
select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
  round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
  round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.path']) = '/auth/v1/user'
group by colo order by n desc limit 8
```

Il numero della soglia è il `p95` della riga con più richieste (il 20/10 erano tutte `DUB`). Se ci sono più righe con più del 5% delle richieste ciascuna, si rilancia la stessa query senza `group by colo` (e senza `colo` nella `select`) e si usa quel `p95`.

- [ ] **0.6 Le chiamate in 24 ore (soglia: 200.000)**

Stessa query, finestra `'{giorno prima}T12:30:00Z'` → `'{giorno}T12:30:00Z'`, con entrambi i giorni feriali (stessa forma della misura del 20/10: 146.787). Il numero della soglia è la somma di `n` su tutte le righe.

- [ ] **0.7 I numeri di confronto (non decidono, servono al titolare e al «dopo»)**

(a) Tutto il traffico server→DB nella stessa punta: la query 0.5 **senza** la riga `and toString(log_attributes['request.path']) = '/auth/v1/user'`. Se anche il resto è lento quanto `/auth/v1/user`, la coda è del database e non dell'identità — era la conclusione del 12/10, e il titolare deve vederlo.

(b) Letture di `utenti` e `parents` dal server, 24 ore (finestra 0.6):

```sql
select toString(log_attributes['request.path']) as percorso, count(*) as n
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.method']) = 'GET'
  and toString(log_attributes['request.path']) in ('/rest/v1/utenti', '/rest/v1/parents')
group by percorso order by n desc
```

(Il 20/10: 204.976 + 191.718 = 396.694.)

(c) Le righe di autenticazione che `app_log` ha già, sette giorni:

```sql
select livello, contesto->'campi'->>'operazione' as operazione, contesto->'campi'->>'esito' as esito,
       count(*) as righe, sum(occorrenze) as occorrenze, max(visto_l_ultima) as ultima
from app_log
where evento = 'auth' and sorgente = 'server' and visto_l_ultima > now() - interval '7 days'
group by 1, 2, 3 order by 5 desc limit 20;
```

(d) Le chiamate al JWKS dal server nelle stesse 24 ore: la query 0.6 con `'/auth/v1/.well-known/jwks.json'` al posto di `'/auth/v1/user'`.

- [ ] **0.8 Quanto vive un token in produzione**

In locale `supabase/config.toml:160` dice `jwt_expiry = 3600` (un'ora). Quello di produzione lo legge il titolare nel pannello, **Project Settings → JWT Keys → Access token expiry time**. In alternativa, se nel suo terminale c'è già un token personale della Management API in `SUPABASE_ACCESS_TOKEN` (mai stampato, mai incollato in chat):

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/uimulkjyekgemjakmepp/config/auth | jq '{jwt_exp}'
```

Il numero in secondi è la **durata massima** per cui, con la sessione 14, un account revocato continuerebbe a leggere.

- [ ] **0.9 Le RPC chiamate dai `GET`: possono scrivere?**

```sql
select p.proname, p.provolatile, p.prosecdef
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('chat_vigilanza_ricerca', 'report_cassa_dettaglio', 'conteggio_cassa_provenienza',
                    'report_cassa_aggregato', 'servizi_da_generare', 'chat_riepilogo_conversazioni', 'exec_sql')
order by 1;
```

`provolatile` `s` o `i` = non può scrivere. `chat_riepilogo_conversazioni` (sessione 12) deve dare `s` e `prosecdef` `false`; se manca, la sessione 12 non è in produzione e la regola 8 del lock (Compito 9) sarà rossa: si avvisa il titolare. Per ogni riga `v`, leggi il corpo (`select pg_get_functiondef('public.{nome}'::regproc);`) e annota se contiene `insert`, `update` o `delete`: una funzione `v` che scrive fa di quel `GET` un quinto «`GET` che scrive», da nominare al titolare nell'Uscita 2.

- [ ] **0.10 Decisione**

| Esito | Condizione | Si va a |
|---|---|---|
| Misura non valida | 0.3 non trova `/auth/v1/user` con nessuno dei due filtri | ci si ferma e si avvisa il titolare; nessuna uscita |
| Token non asimmetrico | 0.2: `alg` non è `ES256`/`RS256`, oppure il `kid` non è nel JWKS | **Uscita 1**, variante «token non asimmetrico» |
| Sotto la soglia | 0.5 p95 **≤ 300 ms** e 0.6 **≤ 200.000** | **Uscita 1**, variante «sotto soglia» |
| Sopra la soglia | 0.5 p95 **> 300 ms** oppure 0.6 **> 200.000** | **Uscita 2** |

---

## Uscita 1 — «non serve»: si chiude dopo il Passo 0

Tre varianti, stessa procedura: sotto la soglia; token non asimmetrico; titolare che risponde «no» all'Uscita 2. Una PR di soli documenti, con la stessa apertura di ogni sessione (§5): prerequisiti, poi la chiusura della sessione rilasciata per ultima nel primo commit. Dopo il merge, il ramo `robustezza2/s14-esito` scrive lo stato finale e la terza fotografia (sezione «Per la sessione dopo»).

- [ ] **U1.1 Prerequisiti: la sessione 7 è rilasciata, nessun'altra sessione è aperta**

La colonna «Dopo» della riga 14 dice `7`. Si verificano due fatti, non il testo dello «Stato» (che per la 7 lo scrive la sessione dopo di lei). Prima la PR della 7, mergiata:

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: **una riga**, numero e data del merge. Nessuna riga: **fermati**, la 7 non è rilasciata.

Poi la sua migrazione, applicata. La sessione 7 ne porta una, `<version>_salute_rpc_sola_lettura.sql`:

```bash
git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | grep "_salute_rpc_sola_lettura\.sql$"
```

Atteso: una riga; le 14 cifre dopo `supabase/migrations/` sono la `<version>`. Con quel valore, sul database di produzione, con `execute_sql` (sola lettura):

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('<version>');
```

Atteso: una riga. Nessuna riga: **fermati** e avvisa il titolare (la migrazione della 7 non è applicata).

Poi nessuna PR `robustezza2/` aperta, salvo i rami `-esito`, e la specifica in `main` con la riga 14 ancora «da fare»:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "^| 14 |"
```

Atteso: nessuna riga dal primo comando; una riga dal secondo, con Stato «da fare». Se c'è una PR aperta di un'altra sessione, **fermati** e aspetta il suo merge (una sessione alla volta, §5).

- [ ] **U1.2 Worktree, ramo, dipendenze**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s14-identita-condizionale /Users/lerri/kidville-web-s14-identita origin/main
cd /Users/lerri/kidville-web-s14-identita && git status -sb | head -3
npm ci 2>&1 | tail -5
```

Atteso: `## robustezza2/s14-identita-condizionale...origin/main`, albero pulito; `added N packages`, nessun `ERR!`. `npm ci` serve alla verifica della chiusura (U1.3), che lancia i lock. Il `.env.local` non serve ai lock di `__tests__/architecture`: se una verifica lo chiedesse, **chiedi al titolare** e copialo solo col suo sì, con `cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s14-identita/.env.local`.

- [ ] **U1.3 Chiusura della sessione rilasciata per ultima, nel primo commit**

```bash
cd /Users/lerri/kidville-web-s14-identita
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: un numero e un ramo `robustezza2/sNN-…` (con l'ordine della serie, di solito `robustezza2/s13-bordo-pubblico`). Se stampa `null null`, nessuna sessione è rilasciata: il passo si salta.

1. Apri il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md`, e leggi per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello che si presume.
2. Se quella sessione aveva migrazioni, rigenera la fotografia delle migrazioni applicate. Stampa la query:

   ```bash
   SCRATCH=$(mktemp -d)
   node __tests__/fixtures/migrazioni-fotografia.mjs --sql
   ```

   Eseguila sul database di produzione con `execute_sql` (sola lettura: legge solo `supabase_migrations.schema_migrations`), salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

   ```bash
   node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
   npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
   ```

   Atteso: `migrazioni-complete` verde. `soglia-fotografia` resta rosso sulla prova «2 · nessuna chiave è già applicata» finché non togli da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che la sezione elenca: è il segnale previsto.
3. Fai le altre voci della sezione nell'ordine in cui sono scritte: le altre fotografie che nomina (ciascuna col suo comando), le voci tolte dalle liste, la riga di stato a «in produzione», lo Stato della sua voce nel PRD, le misure «dopo» già mature. Una misura che la sezione dice «matura dal …» con un giorno non ancora arrivato resta scritta così: la raccoglie il ramo `robustezza2/s14-esito`.
4. Verifica, e committa solo se c'è qualcosa da committare:

   ```bash
   CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
   grep -n -A3 "export const MIGRAZIONI_ATTESE_AL_MERGE" __tests__/architecture/soglia-fotografia.ts
   git status --short
   ```

   Atteso: tutto verde; la costante con le sole voci che la sezione non dice di togliere (di solito `= {}`, che `-A3` mostra anche se la dichiarazione va a capo). Con `git status --short` vuoto non si committa. Altrimenti:

   ```bash
   git add __tests__/fixtures __tests__/architecture docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
   git status --short
   git commit -m "$(cat <<'EOF'
   Chiusura della sessione rilasciata per ultima: fotografie, stato in produzione, PRD

   Eseguita la sezione «Per la sessione dopo» del suo piano.

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   EOF
   )"
   ```

   Se il secondo `git status --short` mostra file che la sezione nomina e il `git add` non ha preso (per esempio `docs/cicd.md`), aggiungili per nome prima del commit.

- [ ] **U1.4 La riga della tabella di stato, «in revisione»**

```bash
grep -n "^| 14 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga, oggi

```markdown
| 14 | Identità, **condizionale** | S3 | 7 | da fare | — | `s14-identita-condizionale` | T10: si procede solo sopra la soglia |
```

Sostituisci **quella** riga, trovata col testo, con questa, mettendo nella colonna «Note» la nota della variante (graffe sostituite con i numeri misurati). Lo Stato è «in revisione», con queste parole: lo stato finale lo scrive il ramo `robustezza2/s14-esito` dopo il merge.

```markdown
| 14 | Identità, **condizionale** | S3 | 7 | in revisione | — | `docs/superpowers/plans/2026-10-20-robustezza2-s14-identita-condizionale.md` | {nota della variante} |
```

Note delle tre varianti:
- sotto la soglia: `Uscita 1, sotto la soglia. T10, misura di {giorno} {data}: punta 07:55–08:05 UTC p95 **{p95} ms** (soglia 300); 24 h {finestra UTC} **{n}** chiamate a `/auth/v1/user` (soglia 200.000); token `{alg}`. Non serve; si rimisura con la terza fotografia di fine serie`
- token non asimmetrico: `Uscita 1, token non asimmetrico. T10, misura di {giorno} {data}: p95 in punta **{p95} ms**, **{n}** chiamate in 24 h. Il token è firmato `{alg}`: `getClaims()` ripiegherebbe su `getUser()` e non si guadagnerebbe niente. Per riaprire serve prima il passaggio alle chiavi asimmetriche (pannello Supabase, decisione del titolare)`
- decisione confermata: `Uscita 1, decisione confermata. T10 superata il {data}: p95 in punta **{p95} ms**, **{n}** chiamate in 24 h. Il titolare il {data della risposta} ha confermato la decisione del 12/10: `getClaims()` sulle letture non si adotta (un account revocato leggerebbe fino a {jwt_exp} s)`

- [ ] **U1.5 La voce del PRD**

In cima a `PRD REGISTRO ELETTRONICO.md`, prima della prima riga `## …`, aggiungi (graffe sostituite):

```markdown
## 🛡️ Changelog — Robustezza 2, sessione 14: identità, misurata e chiusa senza codice — {data UTC} (branch `robustezza2/s14-identita-condizionale`)

**Stato:** 🟡 in revisione (PR #{numero}, solo documenti), in attesa del merge a mano del titolare. Lo stato finale e la terza fotografia di fine serie li scrive il ramo `robustezza2/s14-esito`.

- **La soglia T10.** Si procede solo se `/auth/v1/user` dal server supera **300 ms** di p95 nella punta 07:55–08:05 UTC **oppure** **200.000** chiamate in 24 ore feriali.
- **La misura** ({giorno} {data}, query 2 bis con il filtro sul percorso): punta p95 **{p95} ms** (p50 {p50}); 24 h {finestra UTC} **{n}** chiamate. Tutto il traffico server→DB nella stessa punta: p95 {p95 tutto} ms. Letture di `utenti` + `parents` in 24 h: {n utenti} + {n parents}. Token firmato `{alg}`; scadenza in produzione {jwt_exp} s.
- **Esito:** {«sotto la soglia: non serve» | «token non asimmetrico: niente da guadagnare» | «sopra la soglia, il titolare ha confermato la decisione del 12/10»}. Nessun codice, nessuna migrazione.
- **Domande d'iscrizione** contate alle {ora} UTC del {data}: **{conteggio}**.
```

- [ ] **U1.6 Niente token, chiavi o email nel diff**

```bash
cd /Users/lerri/kidville-web-s14-identita
git diff -U0 | grep -nE "eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" ; echo "righe sospette: fine elenco"
git diff --stat
```

Atteso: nessuna riga prima di `righe sospette: fine elenco`; due file cambiati (la specifica e il PRD; il commit di U1.3, se c'è, è già fatto).

- [ ] **U1.7 Commit, push, PR**

```bash
cd /Users/lerri/kidville-web-s14-identita
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
Robustezza 2, sessione 14: identità misurata, chiusa senza codice

La soglia T10 dice se serve verificare il token in locale sulle letture.
Misura, esito e numeri nella tabella di stato della specifica e nel PRD.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push -u origin robustezza2/s14-identita-condizionale
gh pr create --base main --head robustezza2/s14-identita-condizionale \
  --title "Robustezza 2, sessione 14: identità misurata, chiusa senza codice" \
  --body "$(cat <<'EOF'
## Cosa cambia
Solo documenti: la chiusura della sessione rilasciata prima (primo commit, se c'era qualcosa da chiudere), la riga 14 della tabella di stato a «in revisione» e una voce del PRD.

## Misure (sola lettura)
- Punta 07:55–08:05 UTC di {giorno} {data}, `/auth/v1/user` dal server: p95 {p95} ms (soglia 300).
- 24 h {finestra UTC}: {n} chiamate (soglia 200.000).
- Token `{alg}`; scadenza in produzione {jwt_exp} s.
- Domande d'iscrizione: {conteggio} alle {ora} UTC.

## Esito
{variante dell'Uscita 1}

## Dopo il merge
Il ramo `robustezza2/s14-esito` scrive lo stato finale della riga 14 e la terza fotografia di fine serie.

## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Prima di lanciarlo, sostituisci i valori fra graffe. Annota il numero della PR.

- [ ] **U1.8 Il numero della PR nella riga e nel PRD**

Nella riga trovata con `grep -n "^| 14 |"`, la colonna «PR» passa da `—` a `#{numero PR}`; nel PRD `#{numero}` prende lo stesso numero.

```bash
grep -c "^| 14 | .* | in revisione | #" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git commit -m "Sessione 14: numero della PR nella riga di stato e nel PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Atteso: `1`; il push aggiorna la PR.

- [ ] **U1.9 CI verde su tutti i job, merge del titolare**

```bash
gh pr checks {numero PR} --repo erricoluigi17/kidville-web --watch
```

Atteso: ogni job `pass`. Un E2E `cancelled` si rilancia con `gh run rerun {id del run} --failed`. Poi si avvisa il titolare con il link: il merge lo fa lui, a mano. **Mai** auto-merge, **mai** `gh pr merge` da chi esegue.

- [ ] **U1.10 Pulizia, dopo il merge**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s14-identita
git -C /Users/lerri/kidville-web branch -D robustezza2/s14-identita-condizionale
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s14-identita-condizionale
```

Gli altri rami con una PR aperta non si toccano. Poi si apre il ramo `robustezza2/s14-esito` ed esegue la sezione «Per la sessione dopo», in fondo al piano: è il ramo di soli documenti che la specifica (§5) prevede per l'ultima sessione, e si apre dopo un rilascio andato a buon fine (regola 1 di `AGENTS.md`). I Compiti qui sotto **non** si eseguono.

---

## Uscita 2 — sopra la soglia: ci si ferma e si chiede al titolare

La specifica (§2, righe 63-64) dice che una decisione non si riapre dentro un piano. Quindi, prima del Compito 1, chi esegue **si ferma** e manda al titolare questo messaggio, con i numeri al posto delle graffe:

> **Sessione 14 (identità): il Passo 0 supera la soglia T10.**
> - `/auth/v1/user` dal server, punta 07:55–08:05 UTC di {giorno} {data}: p95 **{p95} ms** (soglia 300).
> - Chiamate in 24 ore ({finestra UTC}): **{n}** (soglia 200.000).
> - Nella stessa punta, tutto il traffico server→DB ha p95 {p95 tutto} ms: {«anche il resto è lento, la coda è del database» | «solo l'identità è lenta»}.
> - Letture di `utenti` + `parents` in 24 ore: {n utenti} + {n parents}.
> - Un token vive {jwt_exp} secondi in produzione.
>
> Il 12/10 avevi scartato `getClaims()` sulle letture perché un account revocato continuerebbe a leggere fino alla scadenza del token. Procedere vuol dire cambiare quella decisione. In concreto, con un «sì»:
> - sulle **letture** — `GET` e `HEAD` delle API, i layout delle tre aree, la pagina `/` — la firma del token si verifica in locale, senza chiamare Auth;
> - per al massimo {jwt_exp/60} minuti dopo la revoca continuerebbero a **leggere**: un account bannato dall'oblio GDPR, le altre sessioni di chi ha appena cambiato password, chi ha avuto le credenziali rigenerate dalla segreteria, un token rubato dopo il logout;
> - restano **immediati**: l'archiviazione di un membro dello staff (si rilegge a ogni richiesta), il cambio di ruolo, la cancellazione dell'utente in Auth, tutte le scritture (`POST`, `PUT`, `PATCH`, `DELETE`), `/api/me`, il cambio password, i PDF firmati e la pagina del modulo da firmare con OTP;
> - quattro `GET` scrivono come effetto della lettura (messaggi segnati come letti, visualizzazione di una notizia, categorie predefinite del protocollo, riga dello scrutinio alla prima apertura): quelle chiedono comunque ad Auth, e un account revocato non le produce{; invece, in quella finestra, potrebbe ancora produrre: {RPC `v` che scrivono, dal Passo 0.9}}.
>
> Rispondi «sì» per procedere, oppure «no» per chiudere la sessione con la decisione del 12/10 confermata.

- **«sì»** → si annota la risposta con data e ora UTC (andrà nel PRD e nella colonna «Note» della tabella di stato, al Compito 11) e si va al Compito 1.
- **«no»** → Uscita 1, variante «decisione confermata».
- **Nessuna risposta** → la sessione resta aperta, non si apre nessun ramo e non si scrive niente. Dopo sette giorni il Passo 0 si rifà.

---

## Compiti

Si eseguono **solo** dopo un «sì» del titolare all'Uscita 2.

### Compito 1 — Prerequisiti, worktree, chiusura della sessione precedente, gate di partenza

**File:** solo quelli che la sezione «Per la sessione dopo» della sessione chiusa nomina (Passo 5).

- [ ] **Passo 1: prerequisiti — la sessione 7 è rilasciata, nessun'altra sessione è aperta**

La colonna «Dopo» della riga 14 dice `7`. Si verificano due fatti, non il testo dello «Stato» (che per la 7 lo scrive la sessione dopo di lei). Prima la PR della 7, mergiata:

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: **una riga**, numero e data del merge. Nessuna riga: **fermati**, la 7 non è rilasciata.

Poi la sua migrazione, applicata. La sessione 7 ne porta una, `<version>_salute_rpc_sola_lettura.sql`:

```bash
git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | grep "_salute_rpc_sola_lettura\.sql$"
```

Atteso: una riga; le 14 cifre dopo `supabase/migrations/` sono la `<version>`. Con quel valore, sul database di produzione, con `execute_sql` (sola lettura):

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('<version>');
```

Atteso: una riga. Nessuna riga: **fermati** e avvisa il titolare (la migrazione della 7 non è applicata).

Poi nessuna PR `robustezza2/` aperta, salvo i rami `-esito`, e la specifica in `main` con la riga 14 ancora «da fare»:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "^| 14 |"
```

Atteso: nessuna riga dal primo comando; una riga dal secondo, con Stato «da fare». Se c'è una PR aperta di un'altra sessione, **fermati** e aspetta il suo merge (una sessione alla volta, §5).

La specifica (§3) mette la 14 dopo la 7, e il prerequisito si rispetta così com'è. Va detto però che cosa la 7 non dà: il controllo `auth` di `/api/health` c'era già prima di lei (`src/lib/health/controlli.ts`, `misura('auth', …)`) e interroga Auth con `auth.admin.getUserById`, che non passa da `verificaSessione`. Quel controllo non vede la verifica locale. Una regressione di questa sessione si vede nelle righe `auth` di `app_log` (Compito 11, Passo 7).

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s14-identita-condizionale /Users/lerri/kidville-web-s14-identita origin/main
cd /Users/lerri/kidville-web-s14-identita && git status -sb | head -3
```

Atteso: `## robustezza2/s14-identita-condizionale...origin/main`, albero pulito.

- [ ] **Passo 3: `.env.local`**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s14-identita/.env.local
```

- [ ] **Passo 4: dipendenze**

```bash
cd /Users/lerri/kidville-web-s14-identita && npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`. Poi verifica la versione di auth-js su cui si basano i Compiti 4 e 5:

```bash
node -p "require('@supabase/auth-js/package.json').version"
```

Atteso: `2.112.0`. Se è diversa, rileggi `getClaims` e `fetchJwk` in `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js` prima del Compito 5: il piano si regge su due fatti di quel sorgente (con `jwks` passato e `kid` presente non si va in rete; un errore che non è di autenticazione, come una `DOMException` di WebCrypto, viene rilanciato).

- [ ] **Passo 5: chiusura della sessione rilasciata per ultima (§5), nel primo commit, prima di ogni codice**

```bash
cd /Users/lerri/kidville-web-s14-identita
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: un numero e un ramo `robustezza2/sNN-…` (con l'ordine della serie, di solito `robustezza2/s13-bordo-pubblico`). Se stampa `null null`, nessuna sessione è rilasciata: il passo si salta.

1. Apri il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md`, e leggi per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello che si presume.
2. Se quella sessione aveva migrazioni, rigenera la fotografia delle migrazioni applicate. Stampa la query:

   ```bash
   SCRATCH=$(mktemp -d)
   node __tests__/fixtures/migrazioni-fotografia.mjs --sql
   ```

   Eseguila sul database di produzione con `execute_sql` (sola lettura: legge solo `supabase_migrations.schema_migrations`), salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

   ```bash
   node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
   npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
   ```

   Atteso: `migrazioni-complete` verde. `soglia-fotografia` resta rosso sulla prova «2 · nessuna chiave è già applicata» finché non togli da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che la sezione elenca: è il segnale previsto.
3. Fai le altre voci della sezione nell'ordine in cui sono scritte: le altre fotografie che nomina (ciascuna col suo comando), le voci tolte dalle liste, la riga di stato a «in produzione», lo Stato della sua voce nel PRD, le misure «dopo» già mature. Una misura che la sezione dice «matura dal …» con un giorno non ancora arrivato resta scritta così: la raccoglie il ramo `robustezza2/s14-esito`, dopo il rilascio di questa sessione.
4. Verifica, e committa solo se c'è qualcosa da committare:

   ```bash
   CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
   grep -n -A3 "export const MIGRAZIONI_ATTESE_AL_MERGE" __tests__/architecture/soglia-fotografia.ts
   git status --short
   ```

   Atteso: tutto verde; la costante con le sole voci che la sezione non dice di togliere (di solito `= {}`, che `-A3` mostra anche se la dichiarazione va a capo). Con `git status --short` vuoto non si committa. Altrimenti:

   ```bash
   git add __tests__/fixtures __tests__/architecture docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
   git status --short
   git commit -m "$(cat <<'EOF'
   Chiusura della sessione rilasciata per ultima: fotografie, stato in produzione, PRD

   Eseguita la sezione «Per la sessione dopo» del suo piano.

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   EOF
   )"
   ```

   Se il secondo `git status --short` mostra file che la sezione nomina e il `git add` non ha preso (per esempio `docs/cicd.md`), aggiungili per nome prima del commit.

- [ ] **Passo 6: i punti della Mappa dei file ci sono ancora**

```bash
cd /Users/lerri/kidville-web-s14-identita
grep -n "LE CHIAVI PUBBLICHE DI FIRMA\|^async function chiaviDiFirma\|DOVE GUARDARE INVECE\|const chiavi = await chiaviDiFirma\|auth.getClaims(" src/middleware.ts
grep -n "^async function risolviDaAuthUid\|^function livelloErroreSessione\|^export async function resolveIdentity\|^export async function resolveSessionAppId\|^export async function requireSessioneAuth\|auth.getUser()" src/lib/auth/require-staff.ts
grep -n "^async function utenteDellaRichiesta\|^export async function requireStaff\|^export async function requireUser(\|^export async function requireDocente" src/lib/auth/require-staff.ts
grep -n "auth.getUser()\|^export async function getSessionProfili" src/lib/auth/profili.ts
grep -n "const GATE_SENZA_NOME" __tests__/architecture/gate-coverage.test.ts
grep -n "export const GET = withRoute" src/app/api/chat/messages/route.ts "src/app/api/news/feed/[id]/route.ts" src/app/api/admin/protocolli/categorie/route.ts src/app/api/primaria/scrutinio/route.ts
grep -n "rpc('chat_riepilogo_conversazioni'" src/app/api/chat/threads/route.ts
```

Atteso (al 20/10): middleware 208, 256, 363, 375, 402; require-staff 202, 245, 266, 272, 334, 337, 696, 706, poi 465, 779, 827, 914; profili 100, 103; gate-coverage 99; le quattro `GET` 229, 38, 42, 179. L'ultima riga (`chat_riepilogo_conversazioni`) il 20/10 non c'era: la porta la sessione 12, e deve esserci. Se manca, la 12 non è in `main`: **fermati** e avvisa il titolare. Se i numeri sono spostati (le sessioni 7, 10 e 12 toccano alcuni di questi file), nei compiti vale il **testo** dei blocchi «sostituisci»; i numeri servono solo a trovarli.

- [ ] **Passo 7: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
```

Atteso: tutti i file verdi tranne, al massimo, `__tests__/architecture/offline-html-nativo.test.ts`, che in un worktree nuovo è rosso perché la shell nativa non è sincronizzata. Si rilancia così:

```bash
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed (1)`. Leggi la riga `Test Files` del riepilogo, non il codice d'uscita di una pipe. Qualunque altro rosso va capito prima di toccare codice.

Non c'è niente da committare in questo passo.

---

### Compito 2 — Il verbo HTTP nel contesto della richiesta

**File:**
- Modifica: `src/lib/logging/context.ts:29-59` (campo `verbo`), `:121-132` (`conContesto`), dopo `:153` (`verboSicuro`)
- Modifica: `src/lib/logging/with-route.ts:182` e dopo `:326` (`verboGrezzo`)
- Test: `__tests__/lib/logging-context-verbo.test.ts` (nuovo)

Il verbo è ciò che distingue una lettura da una scrittura dentro una route. Arriva dal client come un header, quindi si tratta da input: si normalizza, e ciò che non è un verbo plausibile resta **assente** — e assente vuol dire «si chiede ad Auth».

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/logging-context-verbo.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import { conContesto, contesto } from '@/lib/logging/context';
import { withRoute } from '@/lib/logging/with-route';

/**
 * Il verbo HTTP nel contesto della richiesta (robustezza 2, sessione 14). `verificaSessione` lo
 * legge per decidere se la firma del token si verifica in locale: solo `GET` e `HEAD` sono
 * letture. Un valore che non è un verbo plausibile non deve entrare, perché ASSENTE vuol dire
 * «non so», e «non so» si tratta come una scrittura.
 */
describe('contesto — il verbo HTTP della richiesta', () => {
    it('si conserva in maiuscolo', async () => {
        for (const [dato, atteso] of [['GET', 'GET'], ['get', 'GET'], ['Post', 'POST'], ['HEAD', 'HEAD']] as const) {
            await conContesto({ requestId: 'r1', path: '/api/x', verbo: dato }, async () => {
                expect(contesto()?.verbo).toBe(atteso);
            });
        }
    });

    it('ciò che non è un verbo plausibile resta assente', async () => {
        for (const dato of ['GET\nX-Finto: 1', '', 'G E T', 'VERBOLUNGHISSIMOXYZ', 42, null]) {
            await conContesto({ requestId: 'r1', path: '/api/x', verbo: dato as never }, async () => {
                expect(contesto()?.verbo).toBeUndefined();
            });
        }
    });

    it('chi apre il contesto senza verbo (instrumentation, test) lo lascia assente', async () => {
        await conContesto({ requestId: 'r1', path: '/api/x' }, async () => {
            expect(contesto()?.verbo).toBeUndefined();
        });
    });
});

describe('withRoute — mette il verbo nel contesto', () => {
    const route = () => withRoute('prova/verbo:GET', async () =>
        NextResponse.json({ verbo: contesto()?.verbo ?? null }));

    it('GET e POST arrivano come sono', async () => {
        const h = route();
        const g = await h(new Request('http://localhost/api/prova'));
        expect(await g.json()).toEqual({ verbo: 'GET' });
        const p = await h(new Request('http://localhost/api/prova', { method: 'POST' }));
        expect(await p.json()).toEqual({ verbo: 'POST' });
    });

    it('una richiesta che non sa dire il suo verbo non rompe la route: verbo assente', async () => {
        const r = new Request('http://localhost/api/prova');
        Object.defineProperty(r, 'method', { get() { throw new Error('getter rotto'); } });
        const res = await route()(r);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ verbo: null });
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/logging-context-verbo.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed`. I test sul maiuscolo e su `withRoute` falliscono (`verbo` è `undefined`, o `'get'` invece di `'GET'`); `tsc` segnalerebbe anche che `verbo` non esiste in `ContestoRichiesta`.

- [ ] **Passo 3: il campo in `ContestoRichiesta`**

In `src/lib/logging/context.ts`, dentro `export interface ContestoRichiesta`, subito dopo `scuolaId?: string;` aggiungi:

```ts
    /**
     * Il verbo HTTP della richiesta, in MAIUSCOLO (`GET`, `POST`…), messo da `withRoute`.
     * Lo legge `verificaSessione` (`src/lib/auth/verifica-sessione.ts`) per decidere se la firma
     * del token si può verificare in locale: solo `GET` e `HEAD` sono letture (robustezza 2,
     * sessione 14). ASSENTE vuol dire «non so», e «non so» si tratta come una scrittura: si
     * chiede ad Auth. Lo normalizza `conContesto` (vedi `verboSicuro`). Non va nei log.
     */
    verbo?: string;
```

- [ ] **Passo 4: `conContesto` lo normalizza**

Sostituisci

```ts
    const store: ContestoRichiesta = {
        ...iniziale,
        requestId: requestIdSicuro(iniziale.requestId),
        path: pathSicuro(iniziale.path),
    };
```

con

```ts
    const store: ContestoRichiesta = {
        ...iniziale,
        requestId: requestIdSicuro(iniziale.requestId),
        path: pathSicuro(iniziale.path),
        verbo: verboSicuro(iniziale.verbo),
    };
```

E subito dopo la funzione `requestIdSicuro` (prima del commento di `pathSicuro`) aggiungi:

```ts
/**
 * Il verbo arriva dalla `Request`, cioè dal client. Si tiene solo se, in maiuscolo, è una
 * parola di sole lettere lunga al più 16: `GET`, `HEAD`, `POST`, `PATCH`… Tutto il resto diventa
 * ASSENTE, e un verbo assente fa chiedere ad Auth: l'errore possibile è la strada lenta, mai
 * quella fidata. Non lancia (regola del modulo).
 */
const VERBO_PLAUSIBILE = /^[A-Z]{1,16}$/;

function verboSicuro(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const maiuscolo = v.toUpperCase();
    return VERBO_PLAUSIBILE.test(maiuscolo) ? maiuscolo : undefined;
}
```

- [ ] **Passo 5: `withRoute` lo passa**

In `src/lib/logging/with-route.ts` sostituisci

```ts
        return conContesto({ requestId: requestIdGrezzo(args[0]), path: pathDi(args[0]) }, esegui);
```

con

```ts
        // Il verbo distingue una lettura da una scrittura per `verificaSessione` (sessione 14).
        // Grezzo come il requestId: lo normalizza `conContesto`.
        return conContesto(
            { requestId: requestIdGrezzo(args[0]), path: pathDi(args[0]), verbo: verboGrezzo(args[0]) },
            esegui,
        );
```

e subito dopo la funzione `intestazione` aggiungi:

```ts
/**
 * Il verbo HTTP, se la richiesta lo sa dire. Un getter che lancia (un doppio di test, un oggetto
 * JS qualunque) non deve rompere la route: verbo assente, e assente vuol dire «si chiede ad Auth».
 */
function verboGrezzo(req: unknown): string | undefined {
    try {
        const v = (req as { method?: unknown } | null | undefined)?.method;
        return typeof v === 'string' && v !== '' ? v : undefined;
    } catch {
        return undefined;
    }
}
```

- [ ] **Passo 6: verde, e i vicini restano verdi**

```bash
npx vitest run __tests__/lib/logging-context-verbo.test.ts __tests__/lib/logging-context.test.ts __tests__/lib/logging-with-route.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)`; `tsc` senza output.

- [ ] **Passo 7: commit**

```bash
git add src/lib/logging/context.ts src/lib/logging/with-route.ts __tests__/lib/logging-context-verbo.test.ts
git commit -m "$(cat <<'EOF'
Contesto della richiesta: il verbo HTTP, normalizzato

withRoute mette il verbo nel contesto; conContesto lo tiene solo se plausibile.
Assente vuol dire «non so», e verrà trattato come una scrittura.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3 — La memoria per richiesta: `ricordaPerRichiesta`

**File:**
- Modifica: `src/lib/logging/context.ts` (dopo `impostaUtente`, righe 172-182)
- Test: `__tests__/lib/logging-context-memoria.test.ts` (nuovo)

`cache()` di React nelle route non ricorda niente (le route stanno fuori dall'albero React, fonte S3b del rapporto). Lo store di `AsyncLocalStorage` aperto da `withRoute` invece è uno per richiesta: la memoria si appende lì, con una `WeakMap` chiave → store, la stessa forma di `lentePerRichiesta` in `src/lib/logging/supabase-fetch.ts:147`. Nessuno stato per richiesta in una variabile di modulo.

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/logging-context-memoria.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { conContesto, ricordaPerRichiesta } from '@/lib/logging/context';

const richiesta = (requestId: string) => ({ requestId, path: '/api/x', verbo: 'GET' });

describe('ricordaPerRichiesta — una lettura per richiesta, non per chiamata', () => {
    it('stessa richiesta, stessa chiave: il calcolo parte una volta', async () => {
        const calcola = vi.fn(async () => 7);
        await conContesto(richiesta('r1'), async () => {
            expect(await ricordaPerRichiesta('k', calcola)).toBe(7);
            expect(await ricordaPerRichiesta('k', calcola)).toBe(7);
        });
        expect(calcola).toHaveBeenCalledTimes(1);
    });

    it('anche in parallelo: la seconda chiamata aspetta la prima invece di rifarla', async () => {
        let risolvi!: (v: number) => void;
        const pronto = new Promise<number>((r) => { risolvi = r; });
        const calcola = vi.fn(() => pronto);
        await conContesto(richiesta('r1'), async () => {
            const a = ricordaPerRichiesta('k', calcola);
            const b = ricordaPerRichiesta('k', calcola);
            risolvi(3);
            expect(await Promise.all([a, b])).toEqual([3, 3]);
        });
        expect(calcola).toHaveBeenCalledTimes(1);
    });

    it('chiavi diverse: calcoli diversi', async () => {
        const calcola = vi.fn(async () => 1);
        await conContesto(richiesta('r1'), async () => {
            await ricordaPerRichiesta('a', calcola);
            await ricordaPerRichiesta('b', calcola);
        });
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('due richieste: due calcoli', async () => {
        const calcola = vi.fn(async () => 1);
        await conContesto(richiesta('r1'), () => ricordaPerRichiesta('k', calcola));
        await conContesto(richiesta('r2'), () => ricordaPerRichiesta('k', calcola));
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('due richieste in parallelo non si vedono', async () => {
        const calcola = vi.fn(async () => 1);
        await Promise.all([
            conContesto(richiesta('r1'), () => ricordaPerRichiesta('k', calcola)),
            conContesto(richiesta('r2'), () => ricordaPerRichiesta('k', calcola)),
        ]);
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('fuori da una richiesta non ricorda niente', async () => {
        const calcola = vi.fn(async () => 1);
        await ricordaPerRichiesta('k', calcola);
        await ricordaPerRichiesta('k', calcola);
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('un rifiuto non si ricorda: la chiamata dopo riprova', async () => {
        const calcola = vi.fn()
            .mockRejectedValueOnce(new Error('rete'))
            .mockResolvedValueOnce(5);
        await conContesto(richiesta('r1'), async () => {
            await expect(ricordaPerRichiesta('k', calcola)).rejects.toThrow('rete');
            expect(await ricordaPerRichiesta('k', calcola)).toBe(5);
        });
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('un risultato che `tieni` scarta non si ricorda', async () => {
        const calcola = vi.fn(async () => ({ completo: false }));
        await conContesto(richiesta('r1'), async () => {
            await ricordaPerRichiesta('k', calcola, (r) => r.completo);
            await ricordaPerRichiesta('k', calcola, (r) => r.completo);
        });
        expect(calcola).toHaveBeenCalledTimes(2);
    });

    it('un `tieni` che lancia non rompe niente: il valore arriva, e non si ricorda', async () => {
        const calcola = vi.fn(async () => 9);
        const rotto = () => { throw new Error('rotto'); };
        await conContesto(richiesta('r1'), async () => {
            expect(await ricordaPerRichiesta('k', calcola, rotto)).toBe(9);
            expect(await ricordaPerRichiesta('k', calcola, rotto)).toBe(9);
        });
        expect(calcola).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/logging-context-memoria.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`, con `ricordaPerRichiesta is not a function` (non esiste ancora).

- [ ] **Passo 3: il codice**

In `src/lib/logging/context.ts`, subito dopo la `}` che chiude `impostaUtente`, aggiungi:

```ts
/**
 * Memoria per la durata della richiesta CORRENTE (robustezza 2, sessione 14): la prima chiamata
 * con una chiave calcola, le altre della stessa richiesta ricevono la stessa promessa — anche se
 * arrivano mentre la prima è ancora in volo.
 *
 * NON è `cache()` di React, che nelle route non ricorda niente: le route stanno fuori dall'albero
 * React. La memoria è appesa allo store di `AsyncLocalStorage` che `withRoute` apre per ogni
 * richiesta, con una `WeakMap` (stessa forma di `lentePerRichiesta` in `supabase-fetch.ts`):
 * finita la richiesta, lo store non è più raggiungibile e la memoria se ne va con lui. Nessuno
 * stato per richiesta in una variabile di modulo, che è la regola di questo file.
 *
 * Cosa NON si ricorda, di proposito:
 *   · fuori da una richiesta (pagine, layout, test senza contesto): si calcola ogni volta;
 *   · una promessa rifiutata: la chiamata dopo riprova;
 *   · un valore che `tieni` scarta (per esempio una lettura con un errore dentro): idem.
 * Un `tieni` che lancia vale come «non tenere». Questa funzione non lancia mai di suo.
 */
const memoriaPerRichiesta = new WeakMap<ContestoRichiesta, Map<string, Promise<unknown>>>();

export function ricordaPerRichiesta<T>(
    chiave: string,
    calcola: () => Promise<T>,
    tieni: (valore: T) => boolean = () => true,
): Promise<T> {
    const s = als.getStore();
    if (!s) return Promise.resolve().then(calcola);

    const memoria = memoriaPerRichiesta.get(s) ?? new Map<string, Promise<unknown>>();
    memoriaPerRichiesta.set(s, memoria);

    const gia = memoria.get(chiave);
    if (gia) return gia as Promise<T>;

    const promessa = Promise.resolve().then(calcola);
    const dimentica = () => {
        if (memoria.get(chiave) === promessa) memoria.delete(chiave);
    };
    memoria.set(chiave, promessa);
    promessa.then(
        (valore) => {
            let resta = false;
            try {
                resta = tieni(valore);
            } catch {
                // Un criterio rotto non deve rompere la richiesta: vale come «non tenere», e la
                // chiamata dopo ricalcola. Qui non si può loggare (il logger importa questo file).
                resta = false;
            }
            if (!resta) dimentica();
        },
        dimentica,
    );
    return promessa;
}
```

- [ ] **Passo 4: verde**

```bash
npx vitest run __tests__/lib/logging-context-memoria.test.ts __tests__/lib/logging-context.test.ts 2>&1 | tail -6
npx eslint src/lib/logging/context.ts --max-warnings 0 2>&1 | tail -5
```

Atteso: `Test Files  2 passed (2)`; eslint senza output.

- [ ] **Passo 5: commit**

```bash
git add src/lib/logging/context.ts __tests__/lib/logging-context-memoria.test.ts
git commit -m "$(cat <<'EOF'
Contesto della richiesta: ricordaPerRichiesta

Una memoria appesa allo store di AsyncLocalStorage aperto da withRoute,
non cache() di React. Rifiuti e valori scartati non si ricordano.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — Le chiavi di firma in un modulo condiviso

**File:**
- Crea: `src/lib/auth/chiavi-firma.ts`
- Modifica: `src/middleware.ts:1-6` (import), `:207-283` (cache e commento tolti)
- Modifica: `__tests__/lib/middleware-tetto.test.ts:464-473` (solo commento)
- Test: `__tests__/lib/auth/chiavi-firma.test.ts` (nuovo)

Il modulo gira su due runtime: il middleware (Edge, dove il logger non si carica) e il server (Node). Quindi importa **solo** `@/lib/supabase/public-config`, non contiene `fetch(` (il trasporto lo passa chi chiama: lo vieta anche la regola 6 di `supabase-client-strumentato.test.ts`, che segnala chi nomina `SUPABASE_URL` e fa un `fetch(` grezzo), non usa `Buffer` né moduli `node:`.

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/auth/chiavi-firma.test.ts`:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const URL_PROGETTO = 'https://progetto.supabase.co';

/** Modulo fresco a ogni test: la cache vive in variabili di modulo. */
async function carica() {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_PROGETTO);
    return import('@/lib/auth/chiavi-firma');
}

interface Vista { url: string; conApikey: boolean }

function trasporto(rispondi: (n: number) => Promise<Response>) {
    const viste: Vista[] = [];
    const scarica = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        viste.push({ url, conApikey: (new Headers(init?.headers).get('apikey') ?? '') !== '' });
        return rispondi(viste.length);
    }) as typeof fetch;
    return { scarica, viste };
}

const json = (corpo: unknown, stato = 200) =>
    new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } });

const UNA_CHIAVE = { keys: [{ kty: 'EC', key_ops: ['verify'], alg: 'ES256', kid: 'kid-1', crv: 'P-256', x: 'xx', y: 'yy' }] };
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('chiaviDiFirma — la cache di modulo delle chiavi pubbliche', () => {
    it('chiede il JWKS del progetto, con la chiave pubblica nell\'intestazione', async () => {
        const m = await carica();
        const t = trasporto(async () => json(UNA_CHIAVE));
        const chiavi = await m.chiaviDiFirma(t.scarica);
        expect(t.viste).toEqual([{ url: `${URL_PROGETTO}/auth/v1/.well-known/jwks.json`, conApikey: true }]);
        expect(chiavi?.keys).toHaveLength(1);
    });

    it('le chiavi valgono dieci minuti: prima nessun giro di rete, dopo uno', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
        const m = await carica();
        const t = trasporto(async () => json(UNA_CHIAVE));
        const prima = await m.chiaviDiFirma(t.scarica);
        expect(await m.chiaviDiFirma(t.scarica)).toBe(prima);
        expect(t.viste).toHaveLength(1);
        vi.setSystemTime(new Date(Date.now() + m.CHIAVI_TTL_MS + 1));
        await m.chiaviDiFirma(t.scarica);
        expect(t.viste).toHaveLength(2);
    });

    it('anche il «no» si ricorda: un JWKS vuoto non si richiede a ogni chiamata', async () => {
        const m = await carica();
        const t = trasporto(async () => json({ keys: [] }));
        expect(await m.chiaviDiFirma(t.scarica)).toBeNull();
        expect(await m.chiaviDiFirma(t.scarica)).toBeNull();
        expect(t.viste).toHaveLength(1);
    });

    it('una risposta d\'errore si riprova dopo un minuto, non alla chiamata dopo', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
        const m = await carica();
        const t = trasporto(async () => json({ message: 'non trovato' }, 404));
        expect(await m.chiaviDiFirma(t.scarica)).toBeNull();
        await m.chiaviDiFirma(t.scarica);
        expect(t.viste).toHaveLength(1);
        vi.setSystemTime(new Date(Date.now() + m.CHIAVI_RIPROVA_MS + 1));
        await m.chiaviDiFirma(t.scarica);
        expect(t.viste).toHaveLength(2);
    });

    it('un guasto di rete tiene le chiavi vecchie, lo segnala, e non riprova subito', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
        const m = await carica();
        const t = trasporto(async (n) => {
            if (n === 1) return json(UNA_CHIAVE);
            throw new TypeError('fetch failed');
        });
        const segnala = vi.fn();
        const vecchie = await m.chiaviDiFirma(t.scarica, segnala);
        vi.setSystemTime(new Date(Date.now() + m.CHIAVI_TTL_MS + 1));
        expect(await m.chiaviDiFirma(t.scarica, segnala)).toBe(vecchie);
        expect(segnala).toHaveBeenCalledTimes(1);
        expect(segnala.mock.calls[0][0]).toBeInstanceOf(TypeError);
        await m.chiaviDiFirma(t.scarica, segnala);
        expect(t.viste).toHaveLength(2);
    });

    it('un corpo che non è JSON si segnala (il trasporto non lo vede)', async () => {
        const m = await carica();
        const t = trasporto(async () => new Response('<html>', { status: 200 }));
        const segnala = vi.fn();
        expect(await m.chiaviDiFirma(t.scarica, segnala)).toBeNull();
        expect(segnala).toHaveBeenCalledTimes(1);
    });
});

describe('intestazioneDelToken — `alg` e `kid` senza verificare niente', () => {
    it('legge alg e kid', async () => {
        const m = await carica();
        const token = `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1' }))}.e30.firma`;
        expect(m.intestazioneDelToken(token)).toEqual({ alg: 'ES256', kid: 'k1' });
    });

    it('senza kid: kid null', async () => {
        const m = await carica();
        const token = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.e30.firma`;
        expect(m.intestazioneDelToken(token)).toEqual({ alg: 'HS256', kid: null });
    });

    it.each([
        ['non-un-token'],
        ['a.b'],
        [`${b64url('{')}.e30.x`],
        [`${b64url('42')}.e30.x`],
        [`${b64url('[1]')}.e30.x`],
        ['.e30.x'],
    ])('%s → null', async (token) => {
        const m = await carica();
        expect(m.intestazioneDelToken(token)).toBeNull();
    });
});

describe('ALGORITMI_LOCALI', () => {
    it('sono quelli che auth-js sa verificare in locale', async () => {
        const m = await carica();
        expect([...m.ALGORITMI_LOCALI].sort()).toEqual(['ES256', 'RS256']);
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/auth/chiavi-firma.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`, con `Failed to resolve import "@/lib/auth/chiavi-firma"`.

- [ ] **Passo 3: il modulo**

Crea `src/lib/auth/chiavi-firma.ts`:

```ts
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/supabase/public-config'

/**
 * LE CHIAVI PUBBLICHE DI FIRMA, TENUTE PER ISTANZA — un modulo solo per il middleware (Edge) e
 * per i gate del server (Node). Robustezza 2, sessione 14.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE. Misura del 7 settembre 2026: 2.231.291 richieste a Supabase in un giorno, di cui
 * 643.281 di autenticazione, il 99,3% a `/user` («questo token vale ancora?», una telefonata per
 * richiesta). `getUser()` interroga Auth ogni volta; `getClaims()` verifica la FIRMA del token
 * con WebCrypto, in locale — a patto di avere la chiave pubblica. Questo modulo la tiene.
 *
 * PERCHÉ UNA CACHE NOSTRA, se auth-js 2.112 ne ha una (`GLOBAL_JWKS`, dieci minuti per
 * progetto). Letto nel sorgente (`GoTrueClient.fetchJwk`), per due ragioni:
 *   1. quella di auth-js NON ricorda il «no»: un JWKS vuoto si richiede a ogni verifica, cioè un
 *      giro di rete in PIÙ invece che in meno;
 *   2. se il JWKS non si raggiunge, `fetchJwk` lancia e `getClaims()` risponde con un errore —
 *      «nessuna sessione» — invece di ripiegare su `getUser()`. Chi usa questo modulo vede il
 *      `null` e decide lui: il middleware resta fail-closed, i gate chiedono ad Auth.
 *
 * DOVE VIVE. In variabili di MODULO: sull'Edge durano quanto l'isolate, su Node quanto l'istanza
 * della funzione, e in entrambi i casi servono molte richieste. Middleware e server NON
 * condividono la memoria (sono due runtime): condividono il codice e le regole.
 *
 * NIENTE `fetch` QUI DENTRO. Il trasporto lo passa chi chiama: il middleware il suo
 * `fetchConBudget` (con tetto e riga `KV_ERR`), il server `creaFetchStrumentato()`. Una chiamata
 * grezza verso l'host Supabase sarebbe la «settima strada» che `supabase-client-strumentato.test.ts`
 * vieta. E niente logger: sull'Edge non si carica (`logger → redact → node:crypto`). Chi vuole
 * sapere del guasto passa `segnala`.
 *
 * Lock: `middleware-tetto.test.ts` (7-bis, 7-ter-bis), `__tests__/lib/auth/chiavi-firma.test.ts`,
 * `identita-letture-scritture.test.ts` (regole 11 e 12).
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/**
 * La forma minima che `getClaims()` pretende da una chiave pubblica. Si dichiara QUI invece di
 * importare `JWK`: quel tipo vive in `@supabase/auth-js`, dipendenza TRANSITIVA che non compare
 * nel nostro `package.json` e che può cambiare senza che ce ne accorgiamo.
 */
export interface ChiavePubblica {
  kty: string
  key_ops: string[]
  alg?: string
  kid?: string
  [chiave: string]: unknown
}

export interface ChiaviFirma {
  keys: ChiavePubblica[]
}

export const CHIAVI_TTL_MS = 10 * 60_000
/** Dopo un guasto si riprova prima, ma non a ogni richiesta. */
export const CHIAVI_RIPROVA_MS = 60_000

/**
 * Gli algoritmi che `getClaims()` sa verificare in locale (auth-js 2.112, `getAlgorithm`). Con
 * qualunque altro — HS256 in testa — `getClaims()` telefona ad Auth: tanto vale farlo noi.
 */
export const ALGORITMI_LOCALI: ReadonlySet<string> = new Set(['ES256', 'RS256'])

let chiaviFirma: ChiaviFirma | null = null
/** Vale ANCHE per l'esito negativo: vedi `chiaviDiFirma`. */
let chiaviScadenza = 0

/**
 * Le chiavi pubbliche del progetto, dalla cache se fresche.
 *
 * ⚠️ SI RICORDA ANCHE IL «NO», ed è il caso peggiore: con un JWKS vuoto (progetto ancora a
 * segreto simmetrico) una cache dei soli successi riproverebbe a OGNI richiesta, per sempre.
 * Lock: `middleware-tetto.test.ts`, test 7-ter-bis.
 *
 * Su un guasto si tengono le chiavi vecchie, se ci sono — meglio una chiave di dieci minuti fa
 * che una porta che si chiude su tutti — e si riprova fra un minuto. Il guasto di rete lo scrive
 * il trasporto; `segnala` riceve anche ciò che il trasporto non vede (un corpo che non è JSON).
 */
export async function chiaviDiFirma(
  scarica: typeof fetch,
  segnala?: (err: unknown) => void,
): Promise<ChiaviFirma | null> {
  const ora = Date.now()
  if (ora < chiaviScadenza) return chiaviFirma
  try {
    const res = await scarica(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    })
    const dati = res.ok ? ((await res.json()) as { keys?: ChiavePubblica[] } | null) : null
    chiaviFirma = dati?.keys?.length ? { keys: dati.keys } : null
    chiaviScadenza = ora + (res.ok ? CHIAVI_TTL_MS : CHIAVI_RIPROVA_MS)
    return chiaviFirma
  } catch (err) {
    chiaviScadenza = ora + CHIAVI_RIPROVA_MS
    segnala?.(err)
    return chiaviFirma
  }
}

/**
 * `alg` e `kid` dall'intestazione di un JWT, SENZA verificarlo: servono solo a sapere se la
 * verifica locale è possibile. `null` quando il token non ha la forma di un JWT — e il `null` è
 * il segnale: chi chiama ripiega su Auth e lo dice nel suo log (`token-non-asimmetrico`).
 * `atob` e non `Buffer`: questo modulo gira anche sull'Edge.
 */
export function intestazioneDelToken(token: string): { alg: string | null; kid: string | null } | null {
  try {
    const parti = token.split('.')
    if (parti.length !== 3 || parti[0] === '') return null
    const b64 = parti[0].replace(/-/g, '+').replace(/_/g, '/')
    const h: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    if (!h || typeof h !== 'object' || Array.isArray(h)) return null
    const { alg, kid } = h as { alg?: unknown; kid?: unknown }
    return { alg: typeof alg === 'string' ? alg : null, kid: typeof kid === 'string' ? kid : null }
  } catch {
    return null
  }
}
```

- [ ] **Passo 4: il test del modulo, verde**

```bash
npx vitest run __tests__/lib/auth/chiavi-firma.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 5: il middleware usa il modulo**

Controlla prima che le righe siano quelle:

```bash
sed -n '206,209p;254,257p;282,286p' src/middleware.ts
```

Atteso: la riga 207 apre il commento `/**` di `LE CHIAVI PUBBLICHE DI FIRMA, TENUTE PER ISOLATE`, la 256 è `async function chiaviDiFirma(fetchBudget: typeof fetch)…`, la 283 è la `}` che la chiude e la 285 è `export async function middleware(…)`.

In `src/middleware.ts`, dopo la riga 6 (`import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase/public-config';`) aggiungi:

```ts
import { chiaviDiFirma } from '@/lib/auth/chiavi-firma';
```

Poi **cancella** il blocco dalla riga 207 alla riga 283 — dal commento `LE CHIAVI PUBBLICHE DI FIRMA, TENUTE PER ISOLATE`, passando per il commento su `ChiavePubblica`, l'interfaccia `ChiavePubblica`, le variabili `chiaviFirma` e `chiaviScadenza`, le costanti `CHIAVI_TTL_MS` e `CHIAVI_RIPROVA_MS`, fino alla `}` che chiude `async function chiaviDiFirma` — e al suo posto metti:

```ts
/**
 * LE CHIAVI PUBBLICHE DI FIRMA stanno in `@/lib/auth/chiavi-firma` dalla sessione 14 della
 * seconda serie di robustezza: le stesse regole, con la stessa cache di modulo, servono anche ai
 * gate del server, che sulle letture verificano la firma in locale
 * (`@/lib/auth/verifica-sessione`).
 *
 * La storia (7 settembre 2026: 643.281 chiamate di autenticazione in un giorno, il 99,3% a
 * `/user`) e le due regole che contano — la cache vive sul MODULO e ricorda anche il «no» — sono
 * scritte lì, accanto al codice. I lock restano qui: `middleware-tetto.test.ts`, test 7-bis (le
 * chiavi si scaricano una volta) e 7-ter-bis (anche un JWKS vuoto si ricorda).
 *
 * Il trasporto è `fetchConBudget` di questo file: il guasto di rete lo scrive lui (`KV_ERR …
 * evt=auth`), perché sull'Edge il logger non si carica. Per questo qui `chiaviDiFirma` si chiama
 * senza `segnala`.
 */
```

La chiamata più sotto, `const chiavi = await chiaviDiFirma(fetchBudget);`, **non cambia**.

```bash
grep -n "let chiaviFirma\|CHIAVI_TTL_MS\|interface ChiavePubblica\|async function chiaviDiFirma\|from '@/lib/auth/chiavi-firma'\|chiaviDiFirma(fetchBudget)" src/middleware.ts
```

Atteso: solo due righe — l'import e `const chiavi = await chiaviDiFirma(fetchBudget);`.

- [ ] **Passo 6: il commento del test del middleware**

In `__tests__/lib/middleware-tetto.test.ts` sostituisci le righe 464-473:

```ts
     * ⚠️ LA CACHE PER ISOLATE È IL PUNTO, non un ornamento. `fetchJwk` tiene le chiavi
     * sull'ISTANZA del client, e questo file ne costruisce una nuova a ogni richiesta: senza una
     * cache di modulo si scambierebbe una chiamata a `/user` con una al JWKS, cioè guadagno ZERO.
     * Il test 7-bis è l'unico che lo misura.
     *
     * PERCHÉ NON SI TOCCA IL RESTO. `getUser()` chiede al server «vale ADESSO?»; `getClaims()`
     * verifica la firma e si fida fino alla scadenza. Una sessione revocata resterebbe buona per
     * il residuo del token. Qui va bene perché il redirect di questo file **non è il controllo
     * d'accesso** — lo dice il commento in cima, e lo fanno `requireArea` e i gate `require*`, che
     * continuano a interrogare il server e dove la revoca resta immediata.
```

con

```ts
     * ⚠️ LA CACHE DI MODULO È IL PUNTO, non un ornamento. Dalla sessione 14 di robustezza 2 vive in
     * `@/lib/auth/chiavi-firma`, condivisa con i gate del server. auth-js 2.112 ha una cache sua,
     * ma non ricorda il «no» e, se il JWKS non si raggiunge, risponde «nessuna sessione» invece di
     * ripiegare. Il test 7-bis è quello che misura che le chiavi si scaricano una volta.
     *
     * DOVE LA REVOCA RESTA IMMEDIATA. `getUser()` chiede al server «vale ADESSO?»; `getClaims()`
     * verifica la firma e si fida fino alla scadenza. Il redirect di questo file non è il controllo
     * d'accesso. Dalla sessione 14 anche i gate delle LETTURE (`GET` e `HEAD`, layout d'area)
     * verificano in locale; le scritture, `/api/me`, il cambio password e i PDF firmati continuano
     * a interrogare il server. Lo sorveglia `identita-letture-scritture.test.ts`.
```

- [ ] **Passo 7: middleware e lock vicini, verdi**

```bash
npx vitest run __tests__/lib/middleware-tetto.test.ts __tests__/architecture/supabase-client-strumentato.test.ts __tests__/lib/auth/chiavi-firma.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)` (in particolare 7, 7-bis, 7-ter-bis, 7-quater, 7-sexies, 7-quinquies del middleware, e la regola 6 dello strumentato: `chiavi-firma.ts` nomina `SUPABASE_URL` ma non contiene `fetch(`); `tsc` senza output.

- [ ] **Passo 8: commit**

```bash
git add src/lib/auth/chiavi-firma.ts src/middleware.ts __tests__/lib/auth/chiavi-firma.test.ts __tests__/lib/middleware-tetto.test.ts
git commit -m "$(cat <<'EOF'
Chiavi di firma in un modulo condiviso fra middleware e server

La cache del JWKS esce dal middleware in src/lib/auth/chiavi-firma.ts, con le
stesse regole (dieci minuti, il «no» ricordato, riprova dopo un minuto).
Il middleware la usa invariata; i gate del server la useranno sulle letture.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — `verificaSessione`: le letture in locale, il resto ad Auth

**File:**
- Crea: `src/lib/auth/verifica-sessione.ts`
- Test: `__tests__/lib/auth/verifica-sessione.test.ts` (nuovo)

**Come il codice distingue una lettura da una scrittura** (è la regola che il lock del Compito 9 tiene ferma):
1. `sempreAlServer` → Auth. Lo usano i gate che decidono un'operazione sensibile anche quando la richiesta è un `GET`: `requireSessioneAuth` (cambio password, PDF firmati), `resolveSessionAppId` (la pagina del modulo da firmare con OTP) e, dal Compito 8, i gate delle quattro `GET` che scrivono.
2. Dentro una richiesta aperta da `withRoute`: decide il **verbo** del contesto. `GET` e `HEAD` → locale; qualunque altro verbo, o verbo assente → Auth. Il verbo **vince** su `letturaDiPagina`: una route non può dichiararsi lettura.
3. Fuori da `withRoute` (pagine e layout): Auth, a meno che chi chiama dichiari `letturaDiPagina` — solo `requireArea` e la radice `/` (Compito 7). Nel repo non ci sono Server Actions, quindi un layout si rende solo su `GET`; il lock lo verifica.

Nel dubbio, sempre Auth: la strada lenta è quella di oggi. Una verifica locale **impossibile** (token simmetrico, chiavi non raggiungibili, `kid` sconosciuto, guasto di WebCrypto) ripiega su Auth, mai sull'anonimo. Una verifica locale **riuscita e negativa** (firma falsa, token non di un utente) dà anonimo: Auth direbbe lo stesso.

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/auth/verifica-sessione.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClient } from '@supabase/ssr';

// Il logger è finto per SPIARE le righe. Il resto è vero: il client di `@supabase/ssr`, auth-js,
// WebCrypto con chiavi ES256 generate qui. La rete è una spia su `globalThis.fetch`.
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }));

const URL_PROGETTO = 'https://progetto.supabase.co';
const COOKIE = 'sb-progetto-auth-token';
const UTENTE = { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated', role: 'authenticated' };

const b64url = (dati: string | Uint8Array) =>
    Buffer.from(typeof dati === 'string' ? new TextEncoder().encode(dati) : dati).toString('base64url');

/** Un `kid` diverso per ogni coppia: con un `kid` condiviso il verdetto dipenderebbe dall'ordine. */
let contatoreKid = 0;

async function coppiaEs256(opzioni: { kid?: string } = {}) {
    const kid = opzioni.kid ?? `kid-verifica-${++contatoreKid}`;
    const coppia = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubblica = await crypto.subtle.exportKey('jwk', coppia.publicKey);
    async function firma(payload: Record<string, unknown> = {}) {
        const h = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
        const p = b64url(JSON.stringify({
            sub: UTENTE.id, aud: 'authenticated', role: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 3_600, ...payload,
        }));
        const s = await crypto.subtle.sign(
            { name: 'ECDSA', hash: { name: 'SHA-256' } }, coppia.privateKey, new TextEncoder().encode(`${h}.${p}`),
        );
        return `${h}.${p}.${b64url(new Uint8Array(s))}`;
    }
    return { kid, firma, jwks: { keys: [{ ...pubblica, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] }] } };
}

function jwtSimmetrico() {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ sub: UTENTE.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3_600 }));
    return `${h}.${p}.${b64url('firma-finta')}`;
}

/** Il client vero di `@supabase/ssr`, con la sessione nel cookie (formato `base64-`). */
function clientCon(token: string | null, scadeFra = 3_600) {
    const cookies = token === null ? [] : [{
        name: COOKIE,
        value: `base64-${b64url(JSON.stringify({
            access_token: token, refresh_token: 'rinnovo-finto',
            expires_at: Math.floor(Date.now() / 1000) + scadeFra, expires_in: 3_600, token_type: 'bearer',
        }))}`,
    }];
    return createServerClient(URL_PROGETTO, 'anon-di-prova', {
        cookies: { getAll: () => cookies, setAll: () => undefined },
    });
}

interface Chiamata { url: string; verbo: string }
let chiamate: Chiamata[];
let fetchVero: typeof globalThis.fetch;

function spia(rispondi: (url: string) => Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        chiamate.push({ url, verbo: init?.method ?? 'GET' });
        return rispondi(url);
    }) as typeof globalThis.fetch;
}

const risposta = (corpo: unknown, stato = 200) =>
    new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } });
const aUser = () => chiamate.filter((c) => c.url.includes('/auth/v1/user')).length;
const aJwks = () => chiamate.filter((c) => c.url.includes('jwks.json')).length;
const aToken = () => chiamate.filter((c) => c.url.includes('/auth/v1/token')).length;

/** Moduli freschi: la cache delle chiavi e i ricordi dei log vivono in variabili di modulo. */
async function carica() {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_PROGETTO);
    const verifica = await import('@/lib/auth/verifica-sessione');
    const { conContesto } = await import('@/lib/logging/context');
    const { logEvento } = await import('@/lib/logging/logger');
    function inRichiesta<T>(verbo: string | undefined, fn: () => Promise<T>) {
        return conContesto({ requestId: 'r-verifica', path: '/api/prova', ...(verbo ? { verbo } : {}) }, fn);
    }
    return { ...verifica, inRichiesta, logEvento: vi.mocked(logEvento) };
}

const righe = (m: Awaited<ReturnType<typeof carica>>, esito: string) =>
    m.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito);

beforeEach(() => {
    chiamate = [];
    fetchVero = globalThis.fetch;
    vi.clearAllMocks();
});

afterEach(() => {
    globalThis.fetch = fetchVero;
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('verificaSessione — in lettura la firma si verifica in locale, il resto lo decide Auth', () => {
    it('1. GET con token ES256: nessuna chiamata a /user, le chiavi una volta, strada «locale»', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(esito).toEqual({ uid: UTENTE.id, email: null, error: null, modo: 'locale' });
        expect(aUser()).toBe(0);
        expect(aJwks()).toBe(1);
    });

    it('2. le chiavi si scaricano una volta per istanza, e il loro arrivo si dice una volta', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        for (let i = 0; i < 3; i++) await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(aJwks()).toBe(1);
        expect(aUser()).toBe(0);
        const arrivi = righe(m, 'chiavi-aggiornate');
        expect(arrivi).toHaveLength(1);
        expect(arrivi[0][1]).toBe('info');
        expect(arrivi[0][2]).toMatchObject({ operazione: 'verificaSessione', canale: 'locale', n: 1 });
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('3. %s: si chiede ad Auth anche con un token verificabile', async (verbo) => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta(verbo, () => m.verificaSessione(clientCon(token)));
        expect(esito.modo).toBe('server');
        expect(esito.uid).toBe(UTENTE.id);
        expect(aUser()).toBe(1);
        expect(aJwks()).toBe(0);
    });

    it('4. HEAD è una lettura come GET', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('HEAD', () => m.verificaSessione(clientCon(token)));
        expect(esito.modo).toBe('locale');
        expect(aUser()).toBe(0);
    });

    it('5. dentro un POST `letturaDiPagina` non vale: decide il verbo', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('POST', () => m.verificaSessione(clientCon(token), { letturaDiPagina: true }));
        expect(esito.modo).toBe('server');
        expect(aUser()).toBe(1);
    });

    it('6. `sempreAlServer` vale anche in un GET', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token), { sempreAlServer: true }));
        expect(esito.modo).toBe('server');
        expect(aUser()).toBe(1);
        expect(aJwks()).toBe(0);
    });

    it('7. fuori da una richiesta si chiede ad Auth; con `letturaDiPagina` si verifica in locale', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        expect((await m.verificaSessione(clientCon(token))).modo).toBe('server');
        expect(aUser()).toBe(1);
        expect((await m.verificaSessione(clientCon(token), { letturaDiPagina: true })).modo).toBe('locale');
        expect(aUser()).toBe(1);
    });

    it('8. un contesto senza verbo si tratta come una scrittura', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta(undefined, () => m.verificaSessione(clientCon(token), { letturaDiPagina: true }));
        expect(esito.modo).toBe('server');
        expect(aUser()).toBe(1);
    });

    it('9. token HS256: si chiede ad Auth senza scaricare chiavi, e lo si dice una volta', async () => {
        spia(async (url) => (url.includes('jwks.json') ? risposta({ keys: [] }) : risposta(UTENTE)));
        const m = await carica();
        for (let i = 0; i < 2; i++) {
            const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(jwtSimmetrico())));
            expect(esito).toMatchObject({ uid: UTENTE.id, modo: 'server' });
        }
        expect(aJwks()).toBe(0);
        expect(aUser()).toBe(2);
        const dette = righe(m, 'token-non-asimmetrico');
        expect(dette).toHaveLength(1);
        expect(dette[0][1]).toBe('info');
    });

    it('10. nessun cookie: anonimo, e nessun giro di rete', async () => {
        spia(async () => risposta(UTENTE));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(null)));
        expect(esito).toEqual({ uid: null, email: null, error: null, modo: 'locale' });
        expect(chiamate).toHaveLength(0);
    });

    it('11. firma falsa con lo stesso kid: anonimo, e Auth non viene chiamato', async () => {
        const vera = await coppiaEs256();
        const falsa = await coppiaEs256({ kid: vera.kid });
        const token = await falsa.firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(vera.jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(esito.uid).toBeNull();
        expect(esito.modo).toBe('locale');
        expect(esito.error?.name).toBe('AuthInvalidJwtError');
        expect(m.livelloErroreSessione(esito.error)).toBe('info');
        expect(aUser()).toBe(0);
    });

    it('12. sessione scaduta: si rinnova, poi si verifica in locale', async () => {
        const { firma, jwks } = await coppiaEs256();
        const vecchio = await firma();
        const nuovo = await firma();
        spia(async (url) => {
            if (url.includes('jwks.json')) return risposta(jwks);
            if (url.includes('/auth/v1/token')) return risposta({
                access_token: nuovo, refresh_token: 'rinnovo-nuovo', expires_in: 3_600,
                expires_at: Math.floor(Date.now() / 1000) + 3_600, token_type: 'bearer', user: UTENTE,
            });
            return risposta(UTENTE);
        });
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(vecchio, -3_600)));
        expect(esito).toMatchObject({ uid: UTENTE.id, modo: 'locale' });
        expect(aToken()).toBe(1);
        expect(aUser()).toBe(0);
    });

    it('13. JWKS che risponde 404: si chiede ad Auth, e lo si dice una volta', async () => {
        const { firma } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta({ message: 'non trovato' }, 404) : risposta(UTENTE)));
        const m = await carica();
        for (let i = 0; i < 2; i++) {
            const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
            expect(esito).toMatchObject({ uid: UTENTE.id, modo: 'server' });
        }
        expect(aJwks()).toBe(1);
        expect(aUser()).toBe(2);
        const dette = righe(m, 'chiave-non-disponibile');
        expect(dette).toHaveLength(1);
        expect(dette[0][1]).toBe('warn');
        expect(dette[0][2]).toMatchObject({ operazione: 'verificaSessione', canale: 'locale' });
    });

    it('14. kid sconosciuto: si chiede ad Auth', async () => {
        const a = await coppiaEs256();
        const b = await coppiaEs256();
        const token = await b.firma();
        spia(async (url) => (url.includes('jwks.json') ? risposta(a.jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(esito).toMatchObject({ uid: UTENTE.id, modo: 'server' });
        expect(aUser()).toBe(1);
    });

    it('15. chiave corrotta: niente 500 e niente porta aperta — si chiede ad Auth, e il guasto si dice', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma();
        const chiave = jwks.keys[0] as Record<string, unknown>;
        const corrotto = { keys: [{ ...chiave, x: 'non-e-una-coordinata', y: 'nemmeno-questa' }] };
        spia(async (url) => (url.includes('jwks.json') ? risposta(corrotto) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(esito).toMatchObject({ uid: UTENTE.id, modo: 'server' });
        const dette = righe(m, 'verifica-locale-fallita');
        expect(dette).toHaveLength(1);
        expect(dette[0][1]).toBe('warn');
        expect(dette[0][3]).toBeDefined();
    });

    it('16. un token che non è di un utente (role anon): anonimo', async () => {
        const { firma, jwks } = await coppiaEs256();
        const token = await firma({ role: 'anon' });
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const m = await carica();
        const esito = await m.inRichiesta('GET', () => m.verificaSessione(clientCon(token)));
        expect(esito).toEqual({ uid: null, email: null, error: null, modo: 'locale' });
        expect(aUser()).toBe(0);
    });

    it('17. Auth che non risponde sul ripiego: l\'errore arriva a chi chiama, ed è un `error`', async () => {
        const { firma } = await coppiaEs256();
        const token = await firma();
        spia(async (url) => (url.includes('/auth/v1/user') ? risposta({ message: 'giù' }, 503) : risposta({ keys: [] })));
        const m = await carica();
        const esito = await m.inRichiesta('POST', () => m.verificaSessione(clientCon(token)));
        expect(esito.uid).toBeNull();
        expect(esito.modo).toBe('server');
        expect(m.livelloErroreSessione(esito.error)).toBe('error');
    });
});

describe('livelloErroreSessione — la scala, spostata qui da require-staff', () => {
    it.each([
        [null, null],
        [{ name: 'AuthSessionMissingError', status: 400 }, null],
        [{ name: 'AuthInvalidJwtError', status: 400 }, 'info'],
        [{ name: 'AuthApiError', status: 403 }, 'info'],
        [{ name: 'AuthRetryableFetchError', status: 0 }, 'error'],
        [{ name: 'AuthApiError', status: 503 }, 'error'],
        [{ name: 'AuthUnknownError' }, 'error'],
    ])('%o → %s', async (errore, atteso) => {
        const m = await carica();
        expect(m.livelloErroreSessione(errore)).toBe(atteso);
    });
});

describe('VERBI_DI_LETTURA', () => {
    it('sono GET e HEAD, e nient\'altro', async () => {
        const m = await carica();
        expect([...m.VERBI_DI_LETTURA].sort()).toEqual(['GET', 'HEAD']);
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/auth/verifica-sessione.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`, con `Failed to resolve import "@/lib/auth/verifica-sessione"`.

- [ ] **Passo 3: il modulo**

Crea `src/lib/auth/verifica-sessione.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { contesto } from '@/lib/logging/context'
import { logEvento, type Livello } from '@/lib/logging/logger'
import { creaFetchStrumentato } from '@/lib/logging/supabase-fetch'
import {
  ALGORITMI_LOCALI,
  chiaviDiFirma,
  intestazioneDelToken,
  type ChiaviFirma,
} from './chiavi-firma'

/**
 * CHI SEI, CHIESTO NEL MODO GIUSTO PER QUELLO CHE STAI FACENDO. Robustezza 2, sessione 14.
 *
 * Due strade:
 *   · «server» — `auth.getUser()`: una chiamata ad Auth, che risponde «vale ADESSO?». Una
 *     sessione revocata, un account bannato, una password cambiata si vedono subito;
 *   · «locale» — `auth.getClaims()` con le chiavi pubbliche in cache (`./chiavi-firma`): nessuna
 *     chiamata, ma ci si fida della firma fino alla scadenza del token (`jwt_expiry`: 3600 s in
 *     `supabase/config.toml`; quello di produzione sta nel PRD, voce della sessione 14).
 *
 * COME SI DISTINGUE UNA LETTURA (`modoVerifica`):
 *   1. `sempreAlServer` → server. Per chi decide un'operazione sensibile anche quando la
 *      richiesta è un GET (`requireSessioneAuth`, `resolveSessionAppId`);
 *   2. dentro una richiesta aperta da `withRoute` decide il VERBO del contesto: `GET` e `HEAD` →
 *      locale; ogni altro verbo, o il verbo assente → server. Il verbo vince su `letturaDiPagina`:
 *      una route non può dichiararsi lettura;
 *   3. fuori da `withRoute` (pagine e layout) → server, a meno che chi chiama dichiari
 *      `letturaDiPagina`: oggi solo `requireArea` e la radice `/`. Senza Server Actions nel
 *      repo, un layout si rende solo su GET.
 * Nel dubbio, sempre server: la strada lenta è quella di prima. Il lock è
 * `__tests__/architecture/identita-letture-scritture.test.ts`.
 *
 * UNA VERIFICA LOCALE IMPOSSIBILE ripiega su Auth, mai sull'anonimo: token simmetrico, chiavi non
 * raggiungibili, `kid` sconosciuto, un guasto di WebCrypto. Una verifica locale RIUSCITA E
 * NEGATIVA (firma falsa, token non di un utente) dà anonimo: Auth direbbe lo stesso.
 *
 * IL RINNOVO NON SI PERDE. La verifica locale parte da `getSession()`, che rinnova il token in
 * scadenza come faceva `getUser()`; il token rinnovato si passa poi a `getClaims(token, …)`, così
 * la sessione si legge una volta sola.
 */

/** Il pezzo del client che serve qui: basta `auth`. */
type ClientDiSessione = Pick<SupabaseClient, 'auth'>

export type ModoVerifica = 'locale' | 'server'

export interface OpzioniVerifica {
  /**
   * Solo per chi rende una PAGINA fuori da `withRoute` e sa di essere una lettura (layout d'area,
   * radice `/`). Dentro una route non conta: decide il verbo.
   */
  letturaDiPagina?: true
  /** Chiede ad Auth anche in un GET: per i gate delle operazioni sensibili. */
  sempreAlServer?: true
}

export interface ErroreSessione {
  name?: string
  status?: number
  message?: string
}

export interface EsitoSessione {
  /** L'uid di Supabase Auth; `null` = anonimo. */
  uid: string | null
  email: string | null
  error: ErroreSessione | null
  /** Quale strada ha deciso: va nel campo `canale` dei log di chi chiama. */
  modo: ModoVerifica
}

export const VERBI_DI_LETTURA: ReadonlySet<string> = new Set(['GET', 'HEAD'])

export function modoVerifica(opzioni: OpzioniVerifica = {}): ModoVerifica {
  if (opzioni.sempreAlServer) return 'server'
  const c = contesto()
  if (c) return c.verbo !== undefined && VERBI_DI_LETTURA.has(c.verbo) ? 'locale' : 'server'
  return opzioni.letturaDiPagina === true ? 'locale' : 'server'
}

/**
 * Il livello con cui si dice un errore di sessione, o `null` quando non c'è niente da dire.
 * Spostata qui da `require-staff.ts` (sessione 14), identica:
 *   · `AuthSessionMissingError` — nessun cookie: è ogni richiesta anonima. Nessuna riga;
 *   · 4xx (token scaduto, non valido, firma falsa: `AuthInvalidJwtError` è un 400) — `info`;
 *   · Auth che non risponde (`AuthRetryableFetchError`, status assente o 5xx) — `error`: un
 *     utente VALIDO trattato da anonimo, e senza questa riga nessuno saprebbe perché.
 */
export function livelloErroreSessione(error: ErroreSessione | null | undefined): Livello | null {
  if (!error || error.name === 'AuthSessionMissingError') return null
  const status = typeof error.status === 'number' ? error.status : 0
  if (error.name === 'AuthRetryableFetchError' || status === 0 || status >= 500) return 'error'
  return 'info'
}

/**
 * La sessione della richiesta, per la strada che `modoVerifica` sceglie. Non logga l'esito della
 * sessione (lo fa chi chiama, con il suo `operazione` e `canale: esito.modo`); logga solo i fatti
 * della verifica locale. Le eccezioni di `getUser()` (rarissime: GoTrue non lancia) arrivano a chi
 * chiama, che le ha sempre gestite nel suo `catch`.
 */
export async function verificaSessione(
  supabase: ClientDiSessione,
  opzioni: OpzioniVerifica = {},
): Promise<EsitoSessione> {
  if (modoVerifica(opzioni) === 'locale') {
    const locale = await verificaLocale(supabase)
    if (locale) return locale
  }
  return verificaAlServer(supabase)
}

async function verificaAlServer(supabase: ClientDiSessione): Promise<EsitoSessione> {
  const { data, error } = await supabase.auth.getUser()
  return {
    uid: data?.user?.id ?? null,
    email: data?.user?.email ?? null,
    error: error ?? null,
    modo: 'server',
  }
}

/*
 * Stato PER ISTANZA, non per richiesta (la regola di `context.ts` riguarda il secondo): il
 * trasporto strumentato, nato al primo uso; le ultime chiavi viste, per dire una volta sola che
 * sono arrivate; l'ultimo ripiego detto, per non scrivere la stessa riga a ogni richiesta.
 */
let trasportoChiavi: typeof fetch | null = null
let ultimeChiavi: ChiaviFirma | null = null
let ultimoRipiego: string | null = null

function trasporto(): typeof fetch {
  trasportoChiavi ??= creaFetchStrumentato()
  return trasportoChiavi
}

function segnalaChiaviIlleggibili(err: unknown): void {
  logEvento('auth', 'warn', { operazione: 'verificaSessione', esito: 'chiavi-illeggibili', canale: 'locale' }, err)
}

/** Si torna ad Auth; la riga si scrive solo quando il motivo cambia, una volta per istanza. */
function ripiega(esito: 'token-non-asimmetrico' | 'chiave-non-disponibile', livello: Livello): null {
  if (ultimoRipiego !== esito) {
    ultimoRipiego = esito
    logEvento('auth', livello, { operazione: 'verificaSessione', esito, canale: 'locale' })
  }
  return null
}

function anonimo(error: ErroreSessione | null): EsitoSessione {
  return { uid: null, email: null, error, modo: 'locale' }
}

/** `null` = «in locale non si può»: chi chiama va ad Auth. */
async function verificaLocale(supabase: ClientDiSessione): Promise<EsitoSessione | null> {
  // Un doppio di test con il solo `getUser` (centinaia di test delle route) non sa verificare in
  // locale: per lui la strada è quella di prima, e non è un guasto da scrivere.
  const auth = supabase.auth as Partial<Pick<ClientDiSessione['auth'], 'getSession' | 'getClaims'>>
  if (typeof auth.getSession !== 'function' || typeof auth.getClaims !== 'function') return null
  try {
    const { data: sessione, error: erroreSessione } = await supabase.auth.getSession()
    if (erroreSessione) return anonimo(erroreSessione)
    const token = sessione?.session?.access_token
    if (!token) return anonimo(null)

    const intestazione = intestazioneDelToken(token)
    if (!intestazione?.alg || !ALGORITMI_LOCALI.has(intestazione.alg) || !intestazione.kid) {
      return ripiega('token-non-asimmetrico', 'info')
    }

    const chiavi = await chiaviDiFirma(trasporto(), segnalaChiaviIlleggibili)
    if (chiavi && chiavi !== ultimeChiavi) {
      ultimeChiavi = chiavi
      logEvento('auth', 'info', {
        operazione: 'verificaSessione', esito: 'chiavi-aggiornate', canale: 'locale', n: chiavi.keys.length,
      })
    }
    const kid = intestazione.kid
    if (!chiavi || !chiavi.keys.some((k) => k.kid === kid)) return ripiega('chiave-non-disponibile', 'warn')

    const { data, error } = await supabase.auth.getClaims(token, { jwks: chiavi })
    if (error) return anonimo(error)
    const claims = data?.claims
    if (!claims || typeof claims.sub !== 'string' || claims.sub === '' || claims.role !== 'authenticated') {
      return anonimo(null)
    }
    ultimoRipiego = null
    return {
      uid: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      error: null,
      modo: 'locale',
    }
  } catch (err) {
    // `getClaims()` rilancia ciò che non è un errore di autenticazione (una `DOMException` di
    // WebCrypto su una chiave malformata). Non è un 500 e non è una porta aperta: si chiede ad
    // Auth, e il guasto si scrive.
    logEvento('auth', 'warn', { operazione: 'verificaSessione', esito: 'verifica-locale-fallita', canale: 'locale' }, err)
    return null
  }
}
```

- [ ] **Passo 4: verde**

```bash
npx vitest run __tests__/lib/auth/verifica-sessione.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
npx eslint src/lib/auth/verifica-sessione.ts src/lib/auth/chiavi-firma.ts --max-warnings 0 2>&1 | tail -5
```

Atteso: `Test Files  1 passed (1)`; `tsc` ed eslint senza output. Se il test 17 fallisce perché la 503 arriva con un nome d'errore diverso, l'asserzione resta quella (`livelloErroreSessione` → `error` per ogni status ≥ 500): si corregge il codice, non il test.

- [ ] **Passo 5: commit**

```bash
git add src/lib/auth/verifica-sessione.ts __tests__/lib/auth/verifica-sessione.test.ts
git commit -m "$(cat <<'EOF'
verificaSessione: le letture verificano la firma in locale, il resto chiede ad Auth

GET e HEAD dentro withRoute, o una pagina che si dichiara lettura, passano da
getClaims con le chiavi in cache; ogni altro verbo, il verbo assente e
sempreAlServer vanno a getUser. Una verifica locale impossibile ripiega su Auth.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — I gate passano da `verificaSessione`, e `risolviDaAuthUid` si ricorda

**File:**
- Modifica: `src/lib/auth/require-staff.ts:3-4` (import), `:202-230` (`risolviDaAuthUid`), `:232-250` (`livelloErroreSessione` tolta), `:270-302` (`resolveIdentity`), `:334-352` (`resolveSessionAppId`), `:704-714` (`requireSessioneAuth`)
- Modifica: `src/lib/auth/profili.ts:1-6`, `:100-122`
- Modifica: `__tests__/architecture/gate-coverage.test.ts:95-99`
- Modifica: `__tests__/lib/resolveIdentity.test.ts:202`
- Test: `__tests__/lib/auth/identita-per-richiesta.test.ts` (nuovo)

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/auth/identita-per-richiesta.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    utentiMaybeSingle: vi.fn(),
    parentsMaybeSingle: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: vi.fn().mockResolvedValue({ auth: { getUser: mocks.getUser } }),
    createAdminClient: vi.fn().mockResolvedValue({
        from: (tabella: string) => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: tabella === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
                }),
            }),
        }),
    }),
}));

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }));

import { resolveIdentity } from '@/lib/auth/require-staff';
import { conContesto } from '@/lib/logging/context';
import { logEvento } from '@/lib/logging/logger';

const AUTH_UID = '22222222-3333-4444-5555-666666666666';
const ALTRO_UID = '33333333-4444-5555-6666-777777777777';
const RIGA = { id: AUTH_UID, ruolo: 'educator', role: 'educator', scuola_id: null };

const richiesta = () => new Request('http://localhost/api/prova', { method: 'POST' });
const inPost = <T>(requestId: string, fn: () => Promise<T>) =>
    conContesto({ requestId, path: '/api/prova', verbo: 'POST' }, fn);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'false');
    mocks.getUser.mockResolvedValue({ data: { user: { id: AUTH_UID } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: RIGA, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe('risolviDaAuthUid si ricorda per la durata della richiesta (sessione 14)', () => {
    it('stessa richiesta, due gate: una lettura di `utenti` e una di `parents`', async () => {
        await inPost('r1', async () => {
            const a = await resolveIdentity(richiesta());
            const b = await resolveIdentity(richiesta());
            expect(a).toEqual(b);
            expect(a.userId).toBe(AUTH_UID);
        });
        expect(mocks.utentiMaybeSingle).toHaveBeenCalledTimes(1);
        expect(mocks.parentsMaybeSingle).toHaveBeenCalledTimes(1);
        // La sessione invece si verifica ogni volta: è un POST, e la revoca vale subito.
        expect(mocks.getUser).toHaveBeenCalledTimes(2);
    });

    it('due richieste: due letture', async () => {
        await inPost('r1', () => resolveIdentity(richiesta()));
        await inPost('r2', () => resolveIdentity(richiesta()));
        expect(mocks.utentiMaybeSingle).toHaveBeenCalledTimes(2);
        expect(mocks.parentsMaybeSingle).toHaveBeenCalledTimes(2);
    });

    it('fuori da una richiesta (pagine, test senza contesto): nessuna memoria', async () => {
        await resolveIdentity(richiesta());
        await resolveIdentity(richiesta());
        expect(mocks.utentiMaybeSingle).toHaveBeenCalledTimes(2);
    });

    it('una lettura fallita non si ricorda: la chiamata dopo rilegge', async () => {
        mocks.utentiMaybeSingle.mockResolvedValueOnce({
            data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' },
        });
        await inPost('r1', async () => {
            await resolveIdentity(richiesta());
            await resolveIdentity(richiesta());
        });
        expect(mocks.utentiMaybeSingle).toHaveBeenCalledTimes(2);
        expect(logEvento).toHaveBeenCalledWith(
            'auth', 'warn', { operazione: 'resolveIdentity', esito: 'utenti-non-letti' },
            expect.objectContaining({ code: '57014' }),
        );
    });

    it('due persone nella stessa richiesta non si confondono', async () => {
        mocks.getUser
            .mockResolvedValueOnce({ data: { user: { id: AUTH_UID } }, error: null })
            .mockResolvedValueOnce({ data: { user: { id: ALTRO_UID } }, error: null });
        mocks.utentiMaybeSingle
            .mockResolvedValueOnce({ data: RIGA, error: null })
            .mockResolvedValueOnce({ data: null, error: null });
        await inPost('r1', async () => {
            expect((await resolveIdentity(richiesta())).userId).toBe(AUTH_UID);
            expect((await resolveIdentity(richiesta())).userId).toBe(ALTRO_UID);
        });
        expect(mocks.utentiMaybeSingle).toHaveBeenCalledTimes(2);
    });

    it('il log della sessione non verificata dice quale strada ha preso', async () => {
        mocks.getUser.mockResolvedValue({
            data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503, message: 'giù' },
        });
        await inPost('r1', () => resolveIdentity(richiesta()));
        expect(logEvento).toHaveBeenCalledWith(
            'auth', 'error', { operazione: 'resolveIdentity', esito: 'sessione-non-verificata', canale: 'server' },
            expect.objectContaining({ status: 503 }),
        );
    });
});
```

E in `__tests__/lib/resolveIdentity.test.ts`, alla riga 202, sostituisci

```ts
      { operazione: 'resolveIdentity', esito: 'sessione-non-verificata' },
```

con

```ts
      { operazione: 'resolveIdentity', esito: 'sessione-non-verificata', canale: 'server' },
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/lib/auth/identita-per-richiesta.test.ts __tests__/lib/resolveIdentity.test.ts 2>&1 | tail -12
```

Atteso: `Test Files  2 failed`. Nel file nuovo il primo test vede 2 letture di `utenti` invece di 1, l'ultimo non trova `canale`; in `resolveIdentity.test.ts` fallisce il test «GoTrue che non risponde» per lo stesso `canale`.

- [ ] **Passo 3: `require-staff.ts` — import**

In `src/lib/auth/require-staff.ts` sostituisci

```ts
import { impostaUtente } from '@/lib/logging/context'
import { logEvento, type Livello } from '@/lib/logging/logger'
```

con

```ts
import { impostaUtente, ricordaPerRichiesta } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'
import { livelloErroreSessione, verificaSessione } from './verifica-sessione'
```

- [ ] **Passo 4: `risolviDaAuthUid` dice se ha letto tutto, e si ricorda**

Sostituisci la firma e il `return` di `risolviDaAuthUid` (righe 202-230). La firma

```ts
async function risolviDaAuthUid(authUid: string): Promise<{
  appId: string | null
  rigaUtenti: RigaUtenti | null
  ponteGenitore: boolean
}> {
```

diventa

```ts
async function risolviDaAuthUid(authUid: string): Promise<{
  appId: string | null
  rigaUtenti: RigaUtenti | null
  ponteGenitore: boolean
  /** Entrambe le letture riuscite: solo allora il risultato si ricorda per la richiesta. */
  completo: boolean
}> {
```

e il `return` finale

```ts
  return {
    appId: riga?.id ?? parentId,
    rigaUtenti: riga,
    ponteGenitore: !!parentId,
  }
}
```

diventa

```ts
  return {
    appId: riga?.id ?? parentId,
    rigaUtenti: riga,
    ponteGenitore: !!parentId,
    completo: !staffRes.error && !parentRes.error,
  }
}

/**
 * `risolviDaAuthUid` UNA volta per richiesta e per persona (robustezza 2, sessione 14): due gate
 * nella stessa richiesta — una route che chiama `requireStaff` e poi un helper che rifà
 * `resolveIdentity` — leggono `utenti` e `parents` una volta sola. La memoria è quella del
 * contesto aperto da `withRoute` (`ricordaPerRichiesta`), non `cache()` di React. Una lettura con
 * un errore dentro NON si ricorda: la chiamata dopo riprova, come prima.
 */
function risolviPerRichiesta(authUid: string) {
  return ricordaPerRichiesta(
    `risolviDaAuthUid:${authUid}`,
    () => risolviDaAuthUid(authUid),
    (r) => r.completo,
  )
}
```

- [ ] **Passo 5: `livelloErroreSessione` se ne va**

Cancella dal commento `/** Il livello con cui si dice un errore di \`auth.getUser()\`…` (riga 232) fino alla `}` che chiude `function livelloErroreSessione` (riga 250): la funzione ora sta, identica, in `src/lib/auth/verifica-sessione.ts` ed è importata al Passo 3.

- [ ] **Passo 6: `resolveIdentity`**

Sostituisci

```ts
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    const livello = livelloErroreSessione(error)
    if (livello) logEvento('auth', livello, { operazione: 'resolveIdentity', esito: 'sessione-non-verificata' }, error)
    sessionUid = data?.user?.id ?? null
  } catch (err) {
```

con

```ts
  try {
    const supabase = await createClient()
    // Sessione 14: un GET dentro `withRoute` verifica la firma in locale, tutto il resto chiede ad
    // Auth. La regola sta in `verificaSessione`; `canale` dice nel log quale strada ha preso.
    const verifica = await verificaSessione(supabase)
    const livello = livelloErroreSessione(verifica.error)
    if (livello) {
      logEvento('auth', livello, {
        operazione: 'resolveIdentity', esito: 'sessione-non-verificata', canale: verifica.modo,
      }, verifica.error)
    }
    sessionUid = verifica.uid
  } catch (err) {
```

e poco sotto sostituisci

```ts
    const risolto = await risolviDaAuthUid(sessionUid).catch((err) => {
      logEvento('auth', 'error', { operazione: 'resolveIdentity', esito: 'lookup-identita-fallito' }, err)
      return { appId: null, rigaUtenti: null, ponteGenitore: false }
    })
```

con

```ts
    const risolto = await risolviPerRichiesta(sessionUid).catch((err) => {
      logEvento('auth', 'error', { operazione: 'resolveIdentity', esito: 'lookup-identita-fallito' }, err)
      return { appId: null, rigaUtenti: null, ponteGenitore: false, completo: false }
    })
```

- [ ] **Passo 7: `resolveSessionAppId` resta ad Auth**

Il suo unico chiamante è la pagina del modulo da firmare con OTP (`src/app/(dashboard)/parent/forms/[id]/page.tsx:19`): una firma con valore legale, e chi è stato revocato non deve nemmeno vedere il modulo. Sostituisci

```ts
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    const livello = livelloErroreSessione(error)
    if (livello) logEvento('auth', livello, { operazione: 'resolveSessionAppId', esito: 'sessione-non-verificata' }, error)
    const uid = data?.user?.id ?? null
    if (!uid) return null
    const { appId } = await risolviDaAuthUid(uid)
    return appId ?? uid
```

con

```ts
    const supabase = await createClient()
    // `sempreAlServer`: l'unica pagina che lo chiama è il modulo da firmare con OTP. Una firma
    // con valore legale non si apre a un account revocato nemmeno per un'ora (sessione 14).
    const verifica = await verificaSessione(supabase, { sempreAlServer: true })
    const livello = livelloErroreSessione(verifica.error)
    if (livello) {
      logEvento('auth', livello, {
        operazione: 'resolveSessionAppId', esito: 'sessione-non-verificata', canale: verifica.modo,
      }, verifica.error)
    }
    const uid = verifica.uid
    if (!uid) return null
    const { appId } = await risolviPerRichiesta(uid)
    return appId ?? uid
```

- [ ] **Passo 8: `requireSessioneAuth` resta ad Auth**

Sostituisci

```ts
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    // PostgREST non lancia, e nemmeno GoTrue: l'errore torna nel valore. Livello
    // `info` per la stessa ragione di `resolveIdentity` — «non c'è sessione» è la
    // risposta normale di ogni richiesta anonima, e a `warn` riempirebbe la tabella.
    if (error) {
      logEvento('auth', 'info', { operazione: 'requireSessioneAuth', esito: 'sessione-non-leggibile' }, error)
    }
    authUserId = data?.user?.id ?? null
    email = data?.user?.email ?? null
```

con

```ts
    const supabase = await createClient()
    // `sempreAlServer`: questo gate protegge il cambio password e i PDF firmati, anche in GET.
    // Lì la revoca deve valere subito, e l'email deve venire da Auth (sessione 14).
    const verifica = await verificaSessione(supabase, { sempreAlServer: true })
    // PostgREST non lancia, e nemmeno GoTrue: l'errore torna nel valore. Livello
    // `info` per la stessa ragione di `resolveIdentity` — «non c'è sessione» è la
    // risposta normale di ogni richiesta anonima, e a `warn` riempirebbe la tabella.
    if (verifica.error) {
      logEvento('auth', 'info', { operazione: 'requireSessioneAuth', esito: 'sessione-non-leggibile' }, verifica.error)
    }
    authUserId = verifica.uid
    email = verifica.email
```

Il resto di `requireSessioneAuth` (il `getSession()` per il token di accesso, il `catch`, il `nega`) non cambia.

- [ ] **Passo 9: `profili.ts`**

In `src/lib/auth/profili.ts`, dopo l'ultima riga di import (`import type { AppRole } from './require-staff'`) aggiungi:

```ts
import { livelloErroreSessione, verificaSessione, type OpzioniVerifica } from './verifica-sessione'
```

Poi sostituisci l'intera funzione `getSessionProfili` (righe 96-122, commento compreso) con:

```ts
/**
 * Profili dalla SOLA sessione (cookie Supabase), per route e server component.
 * `null` = anonimo (o fuori da un contesto di richiesta, es. unit test).
 *
 * Sessione 14: la sessione passa da `verificaSessione`. Dentro una route decide il verbo; fuori
 * (layout, radice `/`) chi chiama può dichiarare `letturaDiPagina` e la firma si verifica in
 * locale. Senza opzioni, fuori da una route, si chiede ad Auth come prima.
 */
export async function getSessionProfili(
  opzioni: OpzioniVerifica = {},
): Promise<{ authUid: string; profili: Profilo[] } | null> {
  try {
    const supabase = await createClient()
    const verifica = await verificaSessione(supabase, opzioni)
    // Stessa scala di `resolveIdentity`: «nessuna sessione» non si dice, un token scaduto o falso
    // è `info`, Auth che non risponde è `error`. Il risultato resta `null` = anonimo.
    const livello = livelloErroreSessione(verifica.error)
    if (livello) {
      logEvento('auth', livello, {
        operazione: 'getSessionProfili', esito: 'sessione-non-verificata', canale: verifica.modo,
      }, verifica.error)
    }
    const authUid = verifica.uid
    if (!authUid) return null
    return { authUid, profili: await getProfiliForAuthUid(authUid) }
  } catch (err) {
    // `cookies()` lancia fuori da un contesto di richiesta (unit test): il ramo giusto è
    // «anonimo». Si dice a `info` invece di tacere, come in `resolveIdentity` (AGENTS regola 6).
    logEvento('auth', 'info', { operazione: 'getSessionProfili', esito: 'sessione-non-leggibile' }, err)
    return null
  }
}
```

- [ ] **Passo 10: i test di identità, verdi**

```bash
npx vitest run __tests__/lib/auth/identita-per-richiesta.test.ts __tests__/lib/resolveIdentity.test.ts __tests__/lib/auth/verifica-sessione.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)`; `tsc` senza output.

- [ ] **Passo 11: il lock dei gate, rosso**

```bash
npx vitest run __tests__/architecture/gate-coverage.test.ts 2>&1 | tail -15
```

Atteso: rosso su almeno una route il cui gate era riconosciuto solo dal `auth.getUser(` dentro `getSessionProfili` o `requireSessioneAuth` — per esempio `src/app/api/auth/active-role/route.ts` (POST, `getSessionProfili`) o `src/app/api/account/password/route.ts` (`requireSessioneAuth`). Ora quel `getUser` sta in `verificaAlServer`, che `verificaSessione` chiama, che quei due chiamano: tre passaggi, e `gateDiLibreria` ne fa due. Se fosse verde, il passo seguente si fa lo stesso: senza la regola il lock dipenderebbe dall'ordine in cui scopre gli helper.

- [ ] **Passo 12: `verificaSessione(` è una forma di gate**

In `__tests__/architecture/gate-coverage.test.ts` sostituisci

```ts
/**
 * Le due forme che un gate può avere senza essere una funzione con un nome:
 * il segreto del cron (service-to-service) e la sessione Supabase letta a mano.
 */
const GATE_SENZA_NOME = String.raw`CRON_SECRET|\bauth\s*\.\s*getUser\s*\(`
```

con

```ts
/**
 * Le tre forme che un gate può avere senza essere una funzione con un nome:
 * il segreto del cron (service-to-service), la sessione Supabase letta a mano, e
 * `verificaSessione` (robustezza 2, sessione 14), che legge la sessione per conto dei gate di
 * `src/lib/auth`. Senza quest'ultima, `requireSessioneAuth` e `getSessionProfili` sarebbero gate
 * solo al TERZO giro (`verificaAlServer` → `verificaSessione` → loro), e i giri sono due.
 */
const GATE_SENZA_NOME = String.raw`CRON_SECRET|\bauth\s*\.\s*getUser\s*\(|\bverificaSessione\s*\(`
```

- [ ] **Passo 13: verde, e la suite delle route intorno**

```bash
npx vitest run __tests__/architecture/gate-coverage.test.ts 2>&1 | tail -6
npx vitest run __tests__/lib __tests__/api __tests__/logging 2>&1 | tail -12
```

Atteso: `gate-coverage` verde; nel secondo comando tutti i file verdi. I test delle route che finto-mockano `createClient` con il solo `getUser` passano dalla strada di prima (la guardia su `getSession`/`getClaims` di `verificaLocale`); quelli con `getSession` finto (`account-password`, `forms-signed-pdf-identity`, `password-mai-nei-log`) passano da `requireSessioneAuth`, che è `sempreAlServer`. Un rosso qui va capito: non si allarga una deroga per farlo tacere.

- [ ] **Passo 14: commit**

```bash
git add src/lib/auth/require-staff.ts src/lib/auth/profili.ts __tests__/architecture/gate-coverage.test.ts __tests__/lib/resolveIdentity.test.ts __tests__/lib/auth/identita-per-richiesta.test.ts
git commit -m "$(cat <<'EOF'
Gate: la sessione passa da verificaSessione, risolviDaAuthUid si ricorda per richiesta

resolveIdentity e getSessionProfili verificano in locale sui GET dentro withRoute;
requireSessioneAuth e resolveSessionAppId restano ad Auth (sempreAlServer).
utenti e parents si leggono una volta per richiesta e per persona.
Il log di sessione porta canale: locale | server.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — I layout e la radice sono letture di pagina

**File:**
- Modifica: `src/lib/auth/area-guard.ts:79-90`
- Modifica: `src/app/page.tsx:17`
- Modifica: `src/middleware.ts:363-366` (solo commento; dopo il Compito 4 le righe sono più in alto: cerca `DOVE GUARDARE INVECE`)
- Test: `__tests__/lib/auth/area-guard-lettura.test.ts` (nuovo)

`requireArea` è montato nei tre layout d'area: oggi ogni navigazione (e ogni prefetch) paga un `getUser()` qui, oltre al middleware. Un layout si rende solo su `GET`, perché nel repo non ci sono Server Actions (il lock del Compito 9 lo verifica).

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/auth/area-guard-lettura.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSessionProfili: vi.fn(),
    redirect: vi.fn(),
}));

vi.mock('next/headers', () => ({
    cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/profili', () => ({ getSessionProfili: mocks.getSessionProfili }));

import { requireArea } from '@/lib/auth/area-guard';
import Home from '@/app/page';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionProfili.mockResolvedValue(null);
});

/**
 * Sessione 14: i layout d'area e la radice `/` sono LETTURE di pagina, e lo dichiarano. Fuori da
 * `withRoute` non c'è un verbo nel contesto: senza la dichiarazione la sessione andrebbe ad Auth
 * a ogni navigazione, cioè il secondo `getUser()` di ogni prefetch resterebbe dov'è.
 */
describe('layout e radice leggono la sessione come una lettura di pagina', () => {
    it('requireArea chiede `letturaDiPagina`, e l\'anonimo va al login', async () => {
        await requireArea('parent');
        expect(mocks.getSessionProfili).toHaveBeenCalledTimes(1);
        expect(mocks.getSessionProfili).toHaveBeenCalledWith({ letturaDiPagina: true });
        expect(mocks.redirect).toHaveBeenCalledWith('/auth/login');
    });

    it('la radice `/` anche', async () => {
        await Home();
        expect(mocks.getSessionProfili).toHaveBeenCalledTimes(1);
        expect(mocks.getSessionProfili).toHaveBeenCalledWith({ letturaDiPagina: true });
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/auth/area-guard-lettura.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`: `getSessionProfili` è chiamata senza argomenti.

- [ ] **Passo 3: `requireArea`**

In `src/lib/auth/area-guard.ts` sostituisci

```ts
 * nello statico); idem `redirect()` (NEXT_REDIRECT è control-flow di Next).
 */
export async function requireArea(area: Area): Promise<void> {
  const cookieStore = await cookies()
  const cookieRuolo = parseActiveRole(cookieStore.get(ACTIVE_ROLE_COOKIE)?.value)
  const sessione = await getSessionProfili()
```

con

```ts
 * nello statico); idem `redirect()` (NEXT_REDIRECT è control-flow di Next).
 *
 * `letturaDiPagina` (robustezza 2, sessione 14): un layout si rende solo su GET — nel repo non ci
 * sono Server Actions, e il lock `identita-letture-scritture.test.ts` lo verifica — quindi la
 * firma del token si verifica in locale invece di chiedere ad Auth a ogni navigazione. Le
 * scritture passano dalle route, dove decide il verbo.
 */
export async function requireArea(area: Area): Promise<void> {
  const cookieStore = await cookies()
  const cookieRuolo = parseActiveRole(cookieStore.get(ACTIVE_ROLE_COOKIE)?.value)
  const sessione = await getSessionProfili({ letturaDiPagina: true })
```

- [ ] **Passo 4: la radice**

In `src/app/page.tsx` sostituisci

```ts
  const sessione = await getSessionProfili();
```

con

```ts
  // Lettura di pagina (sessione 14): smista sulla home del ruolo e non scrive niente.
  const sessione = await getSessionProfili({ letturaDiPagina: true });
```

- [ ] **Passo 5: il commento del middleware diventa vero**

In `src/middleware.ts` sostituisci

```ts
   * DOVE GUARDARE INVECE. Un prefetch paga DUE `getUser()`, non uno: questo, e quello di
   * `requireArea()` (`@/lib/auth/area-guard`) montato in tutti e tre i layout d'area. Le strade
   * vere sono la verifica locale del JWT (`auth.getClaims()` con chiavi asimmetriche, che azzera
   * le chiamate a `/user`) oppure togliere uno dei due giri per richiesta.
```

con

```ts
   * DOVE SI È GUARDATO INVECE. Un prefetch pagava DUE `getUser()`: questo, e quello di
   * `requireArea()` (`@/lib/auth/area-guard`) montato in tutti e tre i layout d'area. Oggi
   * entrambi verificano la firma in locale — qui con `getClaims()`, nei layout con
   * `verificaSessione` e `letturaDiPagina` (robustezza 2, sessione 14) — e con un token
   * asimmetrico un prefetch non chiama più Auth.
```

- [ ] **Passo 6: verde**

```bash
npx vitest run __tests__/lib/auth/area-guard-lettura.test.ts __tests__/lib/middleware-tetto.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  2 passed (2)`; `tsc` senza output.

- [ ] **Passo 7: commit**

```bash
git add src/lib/auth/area-guard.ts src/app/page.tsx src/middleware.ts __tests__/lib/auth/area-guard-lettura.test.ts
git commit -m "$(cat <<'EOF'
Layout d'area e radice: la sessione si legge come una lettura di pagina

requireArea e la pagina / chiamano getSessionProfili({ letturaDiPagina: true }):
con un token asimmetrico una navigazione non chiama più Auth.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — I quattro `GET` che scrivono chiedono ad Auth

**File:**
- Modifica: `src/lib/auth/require-staff.ts` — l'import di `./verifica-sessione` scritto al Compito 6, `resolveIdentity`, `utenteDellaRichiesta`, `requireUser`, `requireStaff`, `requireDocente`. Si cercano per nome e per testo, non per riga.
- Modifica: la `GET` di `src/app/api/chat/messages/route.ts`, `src/app/api/news/feed/[id]/route.ts`, `src/app/api/admin/protocolli/categorie/route.ts`, `src/app/api/primaria/scrutinio/route.ts`. Ancora: la riga d'apertura `export const GET = withRoute('<nome>:GET'` e la prima chiamata al gate che la segue. La sessione 12 cambia `chat/messages/route.ts` (`programmaDispatchChat` e il commento in testa) e la sessione 10 cambia `primaria/scrutinio/route.ts` (gli import e un blocco più in basso nella `GET`): nessuna delle due tocca l'apertura della `GET` né la riga del gate, ma i numeri di riga si spostano.
- Test: `__tests__/lib/auth/get-che-scrivono-al-server.test.ts` (nuovo)

**Perché.** Quattro `GET` scrivono come effetto della lettura: `chat/messages` segna i messaggi come letti (`.update({ read_at })`), `news/feed/[id]` registra la visualizzazione (`upsert` in `news_visualizzazioni`), `admin/protocolli/categorie` semina le categorie predefinite (`insert`), `primaria/scrutinio` crea la riga dello scrutinio alla prima apertura (`insert`). Dopo il Compito 6 il loro gate verificherebbe la sessione in locale: un account revocato potrebbe ancora produrre quelle scritture fino alla scadenza del token. La specifica (§7) tiene `getUser()` sulle scritture, e queste sono scritture anche se il verbo è `GET`. Quindi chiedono ad Auth, come oggi: per queste quattro la sessione 14 non cambia niente, né in sicurezza né in costo.

**Perché passando dal gate, e non con una `verificaSessione` nel corpo della route.** In quelle quattro route `supabase` è il client di servizio (`createAdminClient()`), che non ha la sessione. L'identità che la route usa è quella del gate, che la prende da `resolveIdentity`: lì ci sono il ripiego legacy sull'intestazione e il `try/catch` su `createClient()` fuori da una richiesta. Una chiamata a parte nel corpo verificherebbe la sessione una seconda volta, e lascerebbe l'identità del gate verificata in locale. In più, la regola 4 del lock (solo i due moduli dei gate chiamano `verificaSessione`) resta vera. I gate prendono quindi un'opzione in più, `opzioni: OpzioniVerifica = {}`, e la passano fino a `verificaSessione`. Senza opzioni non cambia niente: decide il verbo.

- [ ] **Passo 1: il test, rosso**

Crea `__tests__/lib/auth/get-che-scrivono-al-server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verificaSessione: vi.fn(),
    utentiMaybeSingle: vi.fn(),
    parentsMaybeSingle: vi.fn(),
}));

// Si sostituisce solo `verificaSessione`: il resto del modulo (`livelloErroreSessione`) è quello vero.
vi.mock('@/lib/auth/verifica-sessione', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/auth/verifica-sessione')>()),
    verificaSessione: mocks.verificaSessione,
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: vi.fn().mockResolvedValue({ auth: {} }),
    createAdminClient: vi.fn().mockResolvedValue({
        from: (tabella: string) => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: tabella === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
                }),
            }),
        }),
    }),
}));

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }));

import { requireDocente, requireStaff, requireUser, resolveIdentity } from '@/lib/auth/require-staff';
import { conContesto } from '@/lib/logging/context';

const AUTH_UID = '44444444-5555-6666-7777-888888888888';
const RIGA_SEGRETERIA = { id: AUTH_UID, ruolo: 'segreteria', role: 'segreteria', scuola_id: null };
const RIGA_DOCENTE = { id: AUTH_UID, ruolo: 'educator', role: 'educator', scuola_id: null };

const richiesta = () => new Request('http://localhost/api/prova', { method: 'GET' });
const inGet = <T>(fn: () => Promise<T>) =>
    conContesto({ requestId: 'r-get', path: '/api/prova', verbo: 'GET' }, fn);

/** Il secondo argomento di ogni chiamata a `verificaSessione`. */
const opzioniViste = () => mocks.verificaSessione.mock.calls.map((c) => c[1]);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'false');
    mocks.verificaSessione.mockResolvedValue({ uid: AUTH_UID, email: null, error: null, modo: 'server' });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: RIGA_SEGRETERIA, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe('i GET che scrivono chiedono ad Auth (sessione 14)', () => {
    it('senza opzioni nessun gate cambia strada: decide il verbo', async () => {
        await inGet(() => requireUser(richiesta()));
        expect(opzioniViste().map((o) => o ?? {})).toEqual([{}]);
    });

    it('resolveIdentity passa le opzioni a verificaSessione', async () => {
        await inGet(() => resolveIdentity(richiesta(), { sempreAlServer: true }));
        expect(opzioniViste()).toEqual([{ sempreAlServer: true }]);
    });

    it('requireUser con `sempreAlServer`: Auth, e la persona passa', async () => {
        const auth = await inGet(() => requireUser(richiesta(), { sempreAlServer: true }));
        expect(auth.response).toBeUndefined();
        expect(opzioniViste()).toEqual([{ sempreAlServer: true }]);
    });

    it('requireStaff con la sua lista e `sempreAlServer`', async () => {
        const auth = await inGet(() => requireStaff(richiesta(), ['admin', 'segreteria'], { sempreAlServer: true }));
        expect(auth.response).toBeUndefined();
        expect(opzioniViste()).toEqual([{ sempreAlServer: true }]);
    });

    it('requireDocente con la lista di sempre (`undefined`) e `sempreAlServer`', async () => {
        mocks.utentiMaybeSingle.mockResolvedValue({ data: RIGA_DOCENTE, error: null });
        const auth = await inGet(() => requireDocente(richiesta(), undefined, { sempreAlServer: true }));
        expect(auth.response).toBeUndefined();
        expect(opzioniViste()).toEqual([{ sempreAlServer: true }]);
    });
});
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/auth/get-che-scrivono-al-server.test.ts 2>&1 | tail -12
```

Atteso: `Test Files  1 failed (1)`, con `Tests  4 failed | 1 passed (5)`. I quattro rossi vedono `[undefined]` al posto di `[{ sempreAlServer: true }]`: oggi i gate non accettano opzioni e `resolveIdentity` chiama `verificaSessione(supabase)`. Verde solo «senza opzioni».

- [ ] **Passo 3: l'import del tipo**

In `src/lib/auth/require-staff.ts` sostituisci la riga scritta al Compito 6, Passo 3

```ts
import { livelloErroreSessione, verificaSessione } from './verifica-sessione'
```

con

```ts
import { livelloErroreSessione, verificaSessione, type OpzioniVerifica } from './verifica-sessione'
```

- [ ] **Passo 4: `resolveIdentity` passa le opzioni**

Sostituisci la firma

```ts
export async function resolveIdentity(request: Request): Promise<Identita> {
```

con

```ts
export async function resolveIdentity(request: Request, opzioni: OpzioniVerifica = {}): Promise<Identita> {
```

e, nello stesso corpo, il blocco scritto al Compito 6, Passo 6

```ts
    // Sessione 14: un GET dentro `withRoute` verifica la firma in locale, tutto il resto chiede ad
    // Auth. La regola sta in `verificaSessione`; `canale` dice nel log quale strada ha preso.
    const verifica = await verificaSessione(supabase)
```

con

```ts
    // Sessione 14: un GET dentro `withRoute` verifica la firma in locale, tutto il resto chiede ad
    // Auth. La regola sta in `verificaSessione`; `canale` dice nel log quale strada ha preso.
    // `opzioni.sempreAlServer` lo chiede il gate di un GET che scrive: Auth anche lì.
    const verifica = await verificaSessione(supabase, opzioni)
```

- [ ] **Passo 5: `utenteDellaRichiesta` le inoltra**

Sostituisci

```ts
async function utenteDellaRichiesta(
  request: Request,
): Promise<{ userId: string | null; user: AppUser | null; archiviato?: true }> {
  const ident = await resolveIdentity(request)
```

con

```ts
async function utenteDellaRichiesta(
  request: Request,
  opzioni: OpzioniVerifica = {},
): Promise<{ userId: string | null; user: AppUser | null; archiviato?: true }> {
  const ident = await resolveIdentity(request, opzioni)
```

- [ ] **Passo 6: i tre gate le accettano**

`requireUser`: sostituisci

```ts
export async function requireUser(request: Request): Promise<AuthResult> {
  const { userId, user, archiviato } = await utenteDellaRichiesta(request)
```

con

```ts
export async function requireUser(
  request: Request,
  /** `{ sempreAlServer: true }` nel gate di un GET che scrive (sessione 14): la sessione si chiede ad Auth. */
  opzioni: OpzioniVerifica = {},
): Promise<AuthResult> {
  const { userId, user, archiviato } = await utenteDellaRichiesta(request, opzioni)
```

`requireStaff`: sostituisci

```ts
export async function requireStaff(
  request: Request,
  allowed: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']
): Promise<AuthResult> {
  const NEGATO = messaggioNegatoStaff(allowed)
  const { userId, user, archiviato } = await utenteDellaRichiesta(request)
```

con

```ts
export async function requireStaff(
  request: Request,
  allowed: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria'],
  /** `{ sempreAlServer: true }` nel gate di un GET che scrive (sessione 14): la sessione si chiede ad Auth. */
  opzioni: OpzioniVerifica = {},
): Promise<AuthResult> {
  const NEGATO = messaggioNegatoStaff(allowed)
  const { userId, user, archiviato } = await utenteDellaRichiesta(request, opzioni)
```

`requireDocente`: sostituisci

```ts
export async function requireDocente(
  request: Request,
  allowed: readonly AppRole[] = ['educator', 'admin', 'coordinator', 'segreteria']
): Promise<AuthResult> {
  const NEGATO = 'Accesso negato: riservato al personale docente'
  const { userId, user, archiviato } = await utenteDellaRichiesta(request)
```

con

```ts
export async function requireDocente(
  request: Request,
  allowed: readonly AppRole[] = ['educator', 'admin', 'coordinator', 'segreteria'],
  /** `{ sempreAlServer: true }` nel gate di un GET che scrive (sessione 14): la sessione si chiede ad Auth. */
  opzioni: OpzioniVerifica = {},
): Promise<AuthResult> {
  const NEGATO = 'Accesso negato: riservato al personale docente'
  const { userId, user, archiviato } = await utenteDellaRichiesta(request, opzioni)
```

`requireKitchenRead` e `requireUserDaSessioneVerificata` non cambiano: nessun `GET` che scrive li usa.

- [ ] **Passo 7: verde, e `tsc`**

```bash
npx vitest run __tests__/lib/auth/get-che-scrivono-al-server.test.ts __tests__/lib/auth/identita-per-richiesta.test.ts __tests__/lib/resolveIdentity.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)`; `tsc` senza output.

- [ ] **Passo 8: le quattro `GET` lo chiedono**

Lo script cerca l'apertura della `GET` di ogni file, poi la **prima** chiamata al gate che la segue, e si ferma se quella chiamata non sta nel corpo della `GET` (cioè se viene dopo il `export const` successivo). Mette sopra la riga del gate un commento con il perché, con lo stesso rientro.

```bash
node - <<'EOF'
const fs = require('node:fs')
const voci = [
  ['src/app/api/chat/messages/route.ts', "export const GET = withRoute('chat/messages:GET'",
    'requireUser(request);', 'requireUser(request, { sempreAlServer: true });',
    'segna come letti i messaggi aperti (`read_at`)'],
  ['src/app/api/news/feed/[id]/route.ts', "export const GET = withRoute('news/feed/[id]:GET'",
    'requireUser(request)\n', 'requireUser(request, { sempreAlServer: true })\n',
    'registra la visualizzazione della notizia (`news_visualizzazioni`)'],
  ['src/app/api/admin/protocolli/categorie/route.ts', "export const GET = withRoute('admin/protocolli/categorie:GET'",
    "requireStaff(request, ['admin', 'segreteria'])", "requireStaff(request, ['admin', 'segreteria'], { sempreAlServer: true })",
    'semina le categorie predefinite alla prima apertura'],
  ['src/app/api/primaria/scrutinio/route.ts', "export const GET = withRoute('primaria/scrutinio:GET'",
    'requireDocente(request)\n', 'requireDocente(request, undefined, { sempreAlServer: true })\n',
    'crea la riga dello scrutinio alla prima apertura del periodo'],
]
for (const [file, apertura, vecchio, nuovo, cosa] of voci) {
  const t = fs.readFileSync(file, 'utf8')
  const da = t.indexOf(apertura)
  if (da < 0 || t.indexOf(apertura, da + 1) >= 0) throw new Error(`${file}: l'apertura della GET non c'è una volta sola`)
  const fine = t.indexOf('\nexport const ', da + 1)
  const dove = t.indexOf(vecchio, da)
  if (dove < 0 || (fine >= 0 && dove > fine)) throw new Error(`${file}: «${vecchio.trim()}» non è nel corpo della GET`)
  const inizioRiga = t.lastIndexOf('\n', dove) + 1
  const rientro = t.slice(inizioRiga).match(/^\s*/)[0]
  const commento = `${rientro}// Sessione 14: questa GET ${cosa}, quindi la sessione si chiede ad Auth anche qui:\n`
    + `${rientro}// un account revocato non scrive, nemmeno nell'ora di validità del token.\n`
  const nuovoTesto = t.slice(0, inizioRiga) + commento + t.slice(inizioRiga, dove) + nuovo + t.slice(dove + vecchio.length)
  fs.writeFileSync(file, nuovoTesto)
  console.log(`${file}: ok`)
}
EOF
grep -c "sempreAlServer: true" src/app/api/chat/messages/route.ts "src/app/api/news/feed/[id]/route.ts" src/app/api/admin/protocolli/categorie/route.ts src/app/api/primaria/scrutinio/route.ts
git diff --stat
```

Atteso: quattro righe `…: ok`; poi `:1` per ciascuno dei quattro file; `git diff --stat` con i quattro file e `require-staff.ts`, poche righe ciascuno. Se lo script si ferma su un file, quel file è cambiato in un modo che il piano non conosce: leggi la sua `GET` e fermati prima di modificarla a mano.

- [ ] **Passo 9: le route intorno, e il lock dei gate**

```bash
npx vitest run __tests__/api/chat-messages-*.test.ts __tests__/api/chat-allegati-firmati.test.ts __tests__/api/news-feed.test.ts __tests__/api/protocolli-categorie-seed.test.ts __tests__/api/primaria-scrutinio-*.test.ts __tests__/api/primaria-errore-lettura-non-decide.test.ts __tests__/api/guasto-db-non-diventa-voto-o-firma.test.ts __tests__/architecture/gate-coverage.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
npx eslint src/lib/auth/require-staff.ts src/app/api/chat/messages/route.ts "src/app/api/news/feed/[id]/route.ts" src/app/api/admin/protocolli/categorie/route.ts src/app/api/primaria/scrutinio/route.ts --max-warnings 0 2>&1 | tail -5
```

Atteso: tutti i file verdi (i test delle route sostituiscono il gate con un doppio, e un argomento in più non cambia niente); `tsc` ed eslint senza output. Un `toHaveBeenCalledWith(…)` con due soli argomenti su uno di questi quattro gate sarebbe rosso: il 20/10 non ce n'era nessuno; se una sessione prima ne ha aggiunto uno, si aggiunge `{ sempreAlServer: true }` all'attesa.

- [ ] **Passo 10: commit**

```bash
git add src/lib/auth/require-staff.ts src/app/api/chat/messages/route.ts "src/app/api/news/feed/[id]/route.ts" src/app/api/admin/protocolli/categorie/route.ts src/app/api/primaria/scrutinio/route.ts __tests__/lib/auth/get-che-scrivono-al-server.test.ts
git commit -m "$(cat <<'EOF'
I quattro GET che scrivono chiedono ad Auth

requireUser, requireStaff e requireDocente accettano opzioni e le passano fino a
verificaSessione. chat/messages, news/feed/[id], protocolli/categorie e
primaria/scrutinio chiedono sempreAlServer: un account revocato non scrive,
nemmeno con il verbo GET.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---


### Compito 9 — Il lock: una scrittura non passa da `getClaims()`

**File:**
- Test: `__tests__/architecture/identita-letture-scritture.test.ts` (nuovo)

Il lock tiene ferme quattro cose: **chi** verifica la firma in locale (due file), **chi** chiede ad Auth direttamente (quattro file), **chi** si dichiara lettura di pagina (due file, nessuno sotto `src/app/api`), e **cosa fanno i `GET`** — che passano dalla strada locale — : nessuna cancellazione, quattro scritture conosciute che chiedono comunque ad Auth (Compito 8), sei RPC conosciute per nome in cinque file (dopo le sessioni 2 e 12).

**Cosa non copre**, e va detto: legge il **corpo** di `export const GET = withRoute(…)`. Una scrittura dentro un helper importato da un `GET` (una funzione di `src/lib` che fa `.insert(`) non la vede. Un helper che scrive chiamato da un `GET` scriverebbe con un'identità verificata in locale: è la finestra di rischio che il titolare accetta con il «sì» dell'Uscita 2. Le quattro scritture nel corpo, invece, chiedono ad Auth (`sempreAlServer`, Compito 8), e la regola 14 lo tiene fermo.

- [ ] **Passo 1: il lock**

Crea `__tests__/architecture/identita-letture-scritture.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fineParentesi, fileSorgente, mascheraSorgente, type SorgenteMascherato } from '../fixtures/sorgente'
import { VERBI_DI_LETTURA } from '@/lib/auth/verifica-sessione'

/**
 * LOCK — L'IDENTITÀ SI VERIFICA IN LOCALE SOLO SULLE LETTURE (robustezza 2, sessione 14).
 *
 * Il 12/10 il titolare aveva scartato `getClaims()` sulle letture: un account revocato
 * continuerebbe a leggere fino alla scadenza del token. Sopra la soglia T10 l'ha riaperta, a una
 * condizione: SOLO le letture. Questo lock tiene ferma la condizione, testualmente, come gli altri
 * di questa cartella:
 *   · chi verifica la firma in locale (`getClaims(`) — due file;
 *   · chi chiede ad Auth direttamente (`auth.getUser(`) — quattro file;
 *   · chi si dichiara lettura di pagina (`letturaDiPagina: true`) — due file, mai una route;
 *   · chi chiama `verificaSessione(` — i due moduli dei gate;
 *   · nessuna Server Action (`'use server'`): renderebbe un layout su un POST;
 *   · cosa fanno i corpi dei `GET`/`HEAD`, che ora passano dalla strada locale: nessuna
 *     cancellazione, le scritture e le RPC conosciute per nome;
 *   · i GET che scrivono chiedono comunque ad Auth: `sempreAlServer: true` nel loro gate.
 *
 * COSA NON COPRE. Legge il CORPO di `export const GET = withRoute(…)`. Una scrittura dentro un
 * helper chiamato da un GET non la vede: lì l'identità resta verificata in locale, ed è la
 * finestra di rischio accettata dal titolare con il «sì» alla sessione 14.
 */

const RADICE = process.cwd()
const relativo = (f: string) => path.relative(RADICE, f).split(path.sep).join('/')

const CODICE = new Map<string, SorgenteMascherato>(
  fileSorgente(path.join(RADICE, 'src')).map((f) => [relativo(f), mascheraSorgente(fs.readFileSync(f, 'utf8'))]),
)

const FILE_VERIFICA = 'src/lib/auth/verifica-sessione.ts'
const FILE_CHIAVI = 'src/lib/auth/chiavi-firma.ts'

const GET_CLAIMS = /\bgetClaims\s*\(/
const GET_USER = /\bauth\s*\.\s*getUser\s*\(/
const LETTURA_DI_PAGINA = /\bletturaDiPagina\s*:\s*true\b/
const CHIAMA_VERIFICA = /\bverificaSessione\s*\(/
const USE_SERVER = /(['"])use server\1/
const SCRITTURA = /\.(?:insert|upsert)\s*\(|\.update\s*\(\s*\{/
const DISTRUTTIVA = /\.(?:delete|remove)\s*\(|\bauth\s*\.\s*admin\b/
const APERTURA_GET = /export\s+const\s+(?:GET|HEAD)\s*=\s*withRoute\s*\(/g
const RPC = /\.rpc\s*\(/g
const RPC_CON_NOME = /\.rpc\s*\(\s*['"`]([A-Za-z0-9_]+)['"`]/g
const FETCH_GREZZO = /(^|[^\w$])fetch\s*\(/
const SEMPRE_AL_SERVER = /\bsempreAlServer\s*:\s*true\b/

/** I file in cui `re` compare nel campo scelto (`struttura` = codice senza commenti né stringhe). */
function chiContiene(re: RegExp, campo: 'struttura' | 'senzaCommenti' = 'struttura'): string[] {
  const singolo = new RegExp(re.source, re.flags.replace('g', ''))
  return [...CODICE.entries()].filter(([, s]) => singolo.test(s[campo])).map(([f]) => f).sort()
}

interface CorpoGet { file: string; struttura: string; senzaCommenti: string }

/** I corpi di `export const GET|HEAD = withRoute(…)`, dalla parentesi d'apertura a quella di chiusura. */
function corpiGet(s: SorgenteMascherato, file: string): CorpoGet[] {
  const out: CorpoGet[] = []
  for (const m of s.struttura.matchAll(APERTURA_GET)) {
    const apertura = (m.index ?? 0) + m[0].length - 1
    const fine = fineParentesi(s.struttura, apertura)
    out.push({ file, struttura: s.struttura.slice(apertura, fine), senzaCommenti: s.senzaCommenti.slice(apertura, fine) })
  }
  return out
}

/** Il pezzo di sorgente da `function <nome>` alla prossima dichiarazione esportata. */
function tratto(file: string, nome: string): string {
  const s = CODICE.get(file)?.senzaCommenti ?? ''
  const da = s.search(new RegExp(`function\\s+${nome}\\s*\\(`))
  if (da < 0) return ''
  const dopo = s.slice(da + 1).search(/\nexport\s/)
  return (dopo < 0 ? s.slice(da) : s.slice(da, da + 1 + dopo)).replace(/\s+/g, ' ')
}

const CHI_VERIFICA_LA_FIRMA = new Map<string, string>([
  ['src/middleware.ts',
    'il redirect delle pagine verso il login. NON è il controllo d\'accesso (lo dice la sua intestazione) '
    + 'e verifica la firma in locale dal 7/9, su ogni richiesta.'],
  [FILE_VERIFICA,
    'l\'unico punto dei gate dove la firma si verifica in locale, e solo quando `modoVerifica` dice «locale»: '
    + 'GET o HEAD dentro `withRoute`, oppure una lettura di pagina dichiarata.'],
])

const CHI_CHIEDE_AD_AUTH = new Map<string, string>([
  [FILE_VERIFICA, '`verificaAlServer`: la strada di ogni scrittura e il ripiego di ogni verifica locale impossibile.'],
  ['src/app/api/me/route.ts',
    'la specifica (§7, Sessione 14) lo tiene su `getUser()`: è la porta da cui il client rilegge chi è, '
    + 'e deve vedere una revoca subito.'],
  ['src/app/api/panic-alert/route.ts', 'POST: un allarme è una scrittura, e chi lo manda deve essere valido adesso.'],
  ['src/app/m/[token]/page.tsx',
    'la pagina del modulo pubblico decide dalla sessione se l\'accesso è riservato: apre un invio, '
    + 'e non ha letture da risparmiare.'],
])

const LETTURE_DI_PAGINA = new Map<string, string>([
  ['src/lib/auth/area-guard.ts',
    '`requireArea`, montato nei tre layout d\'area: un layout si rende solo su GET, perché nel repo non '
    + 'ci sono Server Actions (regola 5).'],
  ['src/app/page.tsx', 'la radice `/`: smista sulla home del ruolo e non scrive niente.'],
])

const CHI_CHIAMA_VERIFICA = new Map<string, string>([
  ['src/lib/auth/require-staff.ts',
    '`resolveIdentity` (decide il verbo, salvo `sempreAlServer` dai gate dei GET che scrivono), '
    + '`resolveSessionAppId` e `requireSessioneAuth` (sempre ad Auth: regola 10).'],
  ['src/lib/auth/profili.ts',
    '`getSessionProfili`: decide il verbo, o la lettura di pagina dichiarata da chi la chiama.'],
])

/** Ogni GET di questa lista chiede la sessione ad Auth: `sempreAlServer: true` nel suo gate (regola 14). */
const GET_CHE_SCRIVONO = new Map<string, string>([
  ['src/app/api/chat/messages/route.ts',
    'segna come letti i messaggi aperti (`read_at`): un effetto della lettura, ma una scrittura. Va ad Auth.'],
  ['src/app/api/news/feed/[id]/route.ts',
    'registra la visualizzazione di una notizia da parte di un genitore (`news_visualizzazioni`, upsert). Va ad Auth.'],
  ['src/app/api/admin/protocolli/categorie/route.ts',
    'semina le categorie predefinite del registro di protocollo alla prima apertura (23505 ignorato). Va ad Auth.'],
  ['src/app/api/primaria/scrutinio/route.ts',
    'crea la riga dello scrutinio alla prima apertura del periodo: una scrittura, anche se il verbo è GET. Va ad Auth.'],
])

const RPC_NEI_GET = new Map<string, { nomi: readonly string[]; perche: string }>([
  ['src/app/api/admin/chat/ricerca/route.ts', {
    nomi: ['chat_vigilanza_ricerca'],
    perche: 'ricerca della vigilanza sulle chat; volatilità e scritture lette al Passo 0.9 della sessione 14, nel PRD.',
  }],
  ['src/app/api/pagamenti/cassa/dettaglio/route.ts', {
    nomi: ['report_cassa_dettaglio'],
    perche: 'report della cassa; volatilità letta al Passo 0.9 della sessione 14, nel PRD.',
  }],
  ['src/app/api/pagamenti/cassa/report/route.ts', {
    nomi: ['conteggio_cassa_provenienza', 'report_cassa_aggregato'],
    perche: 'report della cassa e conteggio dei contanti; volatilità letta al Passo 0.9 della sessione 14, nel PRD.',
  }],
  ['src/app/api/pagamenti/genera-servizi/route.ts', {
    nomi: ['servizi_da_generare'],
    perche: 'anteprima dei servizi da generare (la generazione è il POST); volatilità letta al Passo 0.9, nel PRD.',
  }],
  ['src/app/api/chat/threads/route.ts', {
    nomi: ['chat_riepilogo_conversazioni'],
    perche: 'riepilogo dell\'elenco conversazioni, STABLE, SECURITY INVOKER (sessione 12); volatilità riletta al Passo 0.9.',
  }],
])

const FILE_ROUTE = [...CODICE.keys()].filter((f) => f.startsWith('src/app/api/') && f.endsWith('/route.ts'))
const CORPI_GET = FILE_ROUTE.flatMap((f) => corpiGet(CODICE.get(f)!, f))

describe('lock — in locale si verificano solo le letture (sessione 14)', () => {
  it('la misura vede davvero il codice (autoinganno)', () => {
    expect(CODICE.size).toBeGreaterThan(500)
    expect(FILE_ROUTE.length).toBeGreaterThan(300)
    expect(CORPI_GET.length, 'il lettore dei corpi GET non trova più niente').toBeGreaterThan(200)
    const tutti = [
      ...CHI_VERIFICA_LA_FIRMA.keys(), ...CHI_CHIEDE_AD_AUTH.keys(), ...LETTURE_DI_PAGINA.keys(),
      ...CHI_CHIAMA_VERIFICA.keys(), ...GET_CHE_SCRIVONO.keys(), ...RPC_NEI_GET.keys(), FILE_CHIAVI,
    ]
    for (const f of tutti) {
      expect(CODICE.has(f), `${f} non esiste più: la voce va tolta o spostata, non lasciata a coprire niente`).toBe(true)
    }
    // I lettori, provati su un caso costruito: «nessuna violazione» e «non so leggerle» non devono
    // avere lo stesso colore.
    const finto = mascheraSorgente(
      "export const GET = withRoute('x:GET', async () => { await db.from('t').update({ a: 1 }); await db.rpc('una_funzione', {}) })\n"
      + "export const POST = withRoute('x:POST', async () => { await db.from('t').delete() })\n"
      + "// export const GET = withRoute(commentato)\n",
    )
    const corpi = corpiGet(finto, '(finto)')
    expect(corpi, 'il lettore prende anche il POST o il commento').toHaveLength(1)
    expect(SCRITTURA.test(corpi[0].struttura), 'una `.update({` non si riconosce più').toBe(true)
    expect(DISTRUTTIVA.test(corpi[0].struttura), 'il `.delete(` del POST è finito nel corpo del GET').toBe(false)
    expect([...corpi[0].senzaCommenti.matchAll(RPC_CON_NOME)].map((m) => m[1])).toEqual(['una_funzione'])
    expect(GET_CLAIMS.test(mascheraSorgente('await supabase.auth.getClaims(undefined, x)').struttura)).toBe(true)
    expect(GET_CLAIMS.test(mascheraSorgente('// supabase.auth.getClaims()').struttura), 'un commento conta').toBe(false)
    expect(SEMPRE_AL_SERVER.test(mascheraSorgente('await requireUser(request, { sempreAlServer: true })').struttura)).toBe(true)
    expect(SEMPRE_AL_SERVER.test(mascheraSorgente('// requireUser(request, { sempreAlServer: true })').struttura)).toBe(false)
  })

  it('1. `getClaims()` solo dove la firma si verifica per scelta dichiarata', () => {
    expect(
      chiContiene(GET_CLAIMS),
      'Un `getClaims()` nuovo verifica la firma in locale: una sessione revocata resterebbe valida fino alla '
      + 'scadenza del token. Le letture passano da `verificaSessione`, che decide da sola; le scritture chiedono '
      + 'ad Auth con `getUser()`.',
    ).toEqual([...CHI_VERIFICA_LA_FIRMA.keys()].sort())
  })

  it('2. `auth.getUser()` diretto solo dove la revoca deve valere subito, per scelta scritta', () => {
    expect(
      chiContiene(GET_USER),
      'Un `getUser()` nuovo fuori da `verificaSessione` non è un errore di sicurezza, ma rifà una chiamata ad Auth '
      + 'che la sessione 14 ha tolto. Si usa `verificaSessione` (con `sempreAlServer` se serve), o si aggiunge qui '
      + 'il file con il perché.',
    ).toEqual([...CHI_CHIEDE_AD_AUTH.keys()].sort())
  })

  it('3. `letturaDiPagina` solo nei due punti dichiarati, mai in una route', () => {
    const trovati = chiContiene(LETTURA_DI_PAGINA)
    expect(trovati.filter((f) => f.startsWith('src/app/api/')), 'una route non si dichiara lettura: decide il verbo').toEqual([])
    expect(trovati).toEqual([...LETTURE_DI_PAGINA.keys()].sort())
  })

  it('4. `verificaSessione()` la chiamano solo i due moduli dei gate', () => {
    expect(chiContiene(CHIAMA_VERIFICA).filter((f) => f !== FILE_VERIFICA)).toEqual([...CHI_CHIAMA_VERIFICA.keys()].sort())
  })

  it('5. nessuna Server Action: un layout si rende solo su GET', () => {
    expect(
      chiContiene(USE_SERVER, 'senzaCommenti'),
      'Una Server Action è un POST che rende anche i layout: lì `letturaDiPagina` verificherebbe in locale una '
      + 'scrittura. Prima di aggiungerne una, `requireArea` va ripensato.',
    ).toEqual([])
  })

  it('6. nessun GET cancella, né usa `auth.admin`', () => {
    expect(
      [...new Set(CORPI_GET.filter((c) => DISTRUTTIVA.test(c.struttura)).map((c) => c.file))].sort(),
      'Un GET con `.delete(`, `.remove(` o `auth.admin` farebbe un\'operazione distruttiva con un\'identità '
      + 'verificata in locale. Va in un DELETE o in un POST.',
    ).toEqual([])
  })

  it('7. i GET che scrivono sono quelli conosciuti', () => {
    expect(
      [...new Set(CORPI_GET.filter((c) => SCRITTURA.test(c.struttura)).map((c) => c.file))].sort(),
      'Un GET nuovo che scrive: la scrittura avviene con un\'identità verificata in locale. Se è un effetto '
      + 'innocuo della lettura, va aggiunto a `GET_CHE_SCRIVONO` con il perché; altrimenti va in un POST.',
    ).toEqual([...GET_CHE_SCRIVONO.keys()].sort())
  })

  it('8. le RPC chiamate dai GET sono quelle conosciute, per nome', () => {
    const viste = new Map<string, Set<string>>()
    for (const c of CORPI_GET) {
      const tutte = [...c.struttura.matchAll(RPC)].length
      const nomi = [...c.senzaCommenti.matchAll(RPC_CON_NOME)].map((m) => m[1])
      expect(nomi.length, `${c.file}: una \`.rpc(\` con un nome non letterale non si può controllare`).toBe(tutte)
      if (nomi.length) viste.set(c.file, new Set([...(viste.get(c.file) ?? []), ...nomi]))
    }
    const lette = Object.fromEntries([...viste.entries()].map(([f, s]) => [f, [...s].sort()]).sort())
    const attese = Object.fromEntries([...RPC_NEI_GET.entries()].map(([f, v]) => [f, [...v.nomi].sort()]).sort())
    expect(
      lette,
      'Una RPC nuova in un GET può scrivere (una funzione VOLATILE). Si legge `pg_get_functiondef` in produzione '
      + 'e si aggiunge a `RPC_NEI_GET` con il perché.',
    ).toEqual(attese)
  })

  it('9. `/api/me` resta su `getUser()`', () => {
    const me = CODICE.get('src/app/api/me/route.ts')!.struttura
    expect(GET_USER.test(me)).toBe(true)
    expect(CHIAMA_VERIFICA.test(me), '`/api/me` non passa da `verificaSessione` (specifica, §7)').toBe(false)
  })

  it('10. i gate delle operazioni sensibili chiedono sempre ad Auth', () => {
    for (const nome of ['requireSessioneAuth', 'resolveSessionAppId']) {
      const t = tratto('src/lib/auth/require-staff.ts', nome)
      expect(t, `${nome} non trovato`).not.toBe('')
      expect(t, `${nome} deve chiamare verificaSessione(supabase, { sempreAlServer: true })`)
        .toContain('verificaSessione(supabase, { sempreAlServer: true })')
    }
    // Le opzioni dei gate arrivano fino a `verificaSessione` (Compito 8): senza questo filo,
    // `sempreAlServer` nelle route sarebbe un argomento ignorato.
    expect(tratto('src/lib/auth/require-staff.ts', 'resolveIdentity')).toContain('verificaSessione(supabase, opzioni)')
    expect(tratto('src/lib/auth/require-staff.ts', 'utenteDellaRichiesta')).toContain('resolveIdentity(request, opzioni)')
    for (const gate of ['requireUser', 'requireStaff', 'requireDocente']) {
      expect(tratto('src/lib/auth/require-staff.ts', gate), `${gate} non inoltra le opzioni`)
        .toContain('utenteDellaRichiesta(request, opzioni)')
    }
  })

  it('11. `chiavi-firma.ts` gira sull\'Edge: importa solo la configurazione pubblica, niente fetch, niente Node', () => {
    const s = CODICE.get(FILE_CHIAVI)!
    const importati = [...s.senzaCommenti.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(importati).toEqual(['@/lib/supabase/public-config'])
    expect(FETCH_GREZZO.test(s.struttura), 'il trasporto lo passa chi chiama').toBe(false)
    expect(/\bBuffer\b|['"]node:/.test(s.senzaCommenti)).toBe(false)
    expect(/^\s*import\s/m.test(CODICE.get('src/lib/supabase/public-config.ts')!.senzaCommenti),
      '`public-config.ts` ha cominciato a importare: va riverificato che regga l\'Edge').toBe(false)
  })

  it('12. il middleware prende le chiavi dal modulo condiviso, e non ne tiene una copia', () => {
    const s = CODICE.get('src/middleware.ts')!
    expect(s.senzaCommenti).toContain("from '@/lib/auth/chiavi-firma'")
    expect(/\blet\s+chiaviFirma\b|\bfunction\s+chiaviDiFirma\b/.test(s.struttura)).toBe(false)
  })

  it('13. le letture sono GET e HEAD', () => {
    expect([...VERBI_DI_LETTURA].sort()).toEqual(['GET', 'HEAD'])
  })

  it('14. i GET che scrivono chiedono la sessione ad Auth', () => {
    for (const file of GET_CHE_SCRIVONO.keys()) {
      const corpi = CORPI_GET.filter((c) => c.file === file)
      expect(corpi.length, `${file}: la GET non si trova più`).toBeGreaterThan(0)
      for (const c of corpi.filter((x) => SCRITTURA.test(x.struttura))) {
        expect(
          SEMPRE_AL_SERVER.test(c.struttura),
          `${file}: la GET scrive, quindi il suo gate chiede \`{ sempreAlServer: true }\`. Senza, un account `
          + 'revocato scriverebbe ancora fino alla scadenza del token.',
        ).toBe(true)
      }
    }
  })

  it('le motivazioni sono scritte davvero', () => {
    const tutte = [
      ...CHI_VERIFICA_LA_FIRMA.values(), ...CHI_CHIEDE_AD_AUTH.values(), ...LETTURE_DI_PAGINA.values(),
      ...CHI_CHIAMA_VERIFICA.values(), ...GET_CHE_SCRIVONO.values(), ...[...RPC_NEI_GET.values()].map((v) => v.perche),
    ]
    for (const m of tutte) expect(m.length).toBeGreaterThan(40)
  })
})
```

- [ ] **Passo 2: eseguilo**

```bash
npx vitest run __tests__/architecture/identita-letture-scritture.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 passed (1)`, perché i Compiti 2-8 hanno già portato il codice nello stato che il lock descrive. Se una regola è rossa, leggi il messaggio:
- regola 8 rossa con `admin/setup-registro` ancora presente → la sessione 2 non è in `main`: fermati, la 14 viene dopo la 2 nell'ordine della serie (§3);
- regola 8 rossa con `src/app/api/chat/threads/route.ts` atteso e non letto → la sessione 12 non è in `main` (la `GET` non chiama ancora `chat_riepilogo_conversazioni`): fermati e avvisa il titolare; la voce non si toglie per far tornare il verde;
- regola 14 rossa → una delle quattro `GET` ha perso `{ sempreAlServer: true }`: si rimette (Compito 8, Passo 8);
- regole 6, 7 o 8 rosse con un file **nuovo** → un'altra sessione ha aggiunto un `GET` che scrive o chiama una RPC: leggi il corpo, e solo se è un effetto innocuo della lettura aggiungilo con il perché; altrimenti fermati e chiedi al titolare;
- il «la misura vede davvero il codice» rosso → `mascheraSorgente` o i percorsi sono cambiati: va capito, non abbassato.

- [ ] **Passo 3: il lock morde (manomissione di prova, poi annullata)**

In `src/app/api/me/route.ts`, riga 41, cambia a mano `sessionClient.auth.getUser()` in `sessionClient.auth.getClaims()` e rilancia:

```bash
npx vitest run __tests__/architecture/identita-letture-scritture.test.ts 2>&1 | grep -E "✓|×|FAIL|passed|failed" | head -12
```

Atteso: rosse le regole 1, 2 e 9. Poi rimetti `getUser()` con la stessa modifica al contrario (non con `git checkout`, che cancella il lavoro non committato) e verifica:

```bash
git diff --stat -- src/app/api/me/route.ts
npx vitest run __tests__/architecture/identita-letture-scritture.test.ts 2>&1 | tail -4
```

Atteso: nessuna riga dal `git diff --stat`; `Test Files  1 passed (1)`.

Seconda prova, sulla regola 14: in `src/app/api/news/feed/[id]/route.ts` togli a mano `, { sempreAlServer: true }` dalla chiamata a `requireUser` della `GET` e rilancia:

```bash
npx vitest run __tests__/architecture/identita-letture-scritture.test.ts 2>&1 | grep -E "✓|×|FAIL|passed|failed" | head -12
```

Atteso: rossa la regola 14, con il nome del file. Rimetti `, { sempreAlServer: true }` a mano e verifica:

```bash
git diff --stat -- "src/app/api/news/feed/[id]/route.ts"
npx vitest run __tests__/architecture/identita-letture-scritture.test.ts 2>&1 | tail -4
```

Atteso: nessuna riga dal `git diff --stat` (il file è com'era al commit del Compito 8); `Test Files  1 passed (1)`.

- [ ] **Passo 4: commit**

```bash
git add __tests__/architecture/identita-letture-scritture.test.ts
git commit -m "$(cat <<'EOF'
Lock: in locale si verificano solo le letture

Chi usa getClaims, chi chiede ad Auth, chi si dichiara lettura di pagina, nessuna
Server Action, e cosa fanno i corpi dei GET: nessuna cancellazione, quattro
scritture che chiedono ad Auth, sei RPC conosciute per nome.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Migrazione

Nessuna: la sessione 14 non porta SQL e non dichiara niente in `MIGRAZIONI_ATTESE_AL_MERGE`, e il ramo `robustezza2/s14-esito` non rigenera fotografie per lei. Le fotografie che il primo commit rigenera sono quelle della sessione chiusa, se la sua sezione «Per la sessione dopo» lo chiede (U1.3; Compito 1, Passo 5).

---

## Log

| Dove | Evento · livello | `esito` | Campi | Quando |
|---|---|---|---|---|
| `src/lib/auth/verifica-sessione.ts`, `verificaLocale` | `auth` · `info` | `chiavi-aggiornate` | `operazione: 'verificaSessione'`, `canale: 'locale'`, `n` (numero di chiavi) | quando l'istanza riceve un JWKS nuovo: al primo uso e a ogni rinnovo (dieci minuti). È il battito «la verifica locale è viva». Solo su Vercel: `auth` non è in `EVENTI_PERSISTITI`, e un `info` non va in `app_log` |
| idem, `ripiega` | `auth` · `info` | `token-non-asimmetrico` | `operazione`, `canale: 'locale'` | il token non è ES256/RS256 o non ha `kid`: si chiede ad Auth. Una riga quando il motivo cambia, per istanza |
| idem, `ripiega` | `auth` · `warn` | `chiave-non-disponibile` | `operazione`, `canale: 'locale'` | JWKS vuoto o irraggiungibile, o `kid` sconosciuto: si chiede ad Auth. Una riga quando il motivo cambia, per istanza; in `app_log` |
| idem, `segnalaChiaviIlleggibili` | `auth` · `warn` | `chiavi-illeggibili` | `operazione`, `canale: 'locale'`, errore | il trasporto del JWKS lancia o il corpo non è JSON. Il trasporto strumentato scrive in più la sua riga sullo status |
| idem, `catch` | `auth` · `warn` | `verifica-locale-fallita` | `operazione`, `canale: 'locale'`, errore | un'eccezione che non è di autenticazione (WebCrypto): si chiede ad Auth |
| `require-staff.ts` `resolveIdentity`, `resolveSessionAppId`; `profili.ts` `getSessionProfili` | `auth` · `info` / `error` | `sessione-non-verificata` (c'era) | **nuovo** `canale: 'locale' \| 'server'` | come prima: 4xx `info`, Auth che non risponde `error`. Il canale dice quale strada ha deciso |
| `require-staff.ts` `risolviDaAuthUid` | `auth` · `warn` | `utenti-non-letti`, `parents-non-letti` (c'erano) | invariati | una lettura fallita non si ricorda, quindi la riga compare a ogni tentativo, come prima |
| `require-staff.ts` `requireSessioneAuth` | `auth` · `info` | `sessione-non-leggibile` (c'era) | invariati | invariato: questo gate resta ad Auth |

Nessun dato personale: niente uid, niente email, niente token nei campi. `canale`, `operazione` ed `esito` sono nella lista bianca di `redact`; `n` è un numero.

---

## PRD

### Compito 10 — Voce di changelog nel PRD

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md:1` (voce nuova in cima)

- [ ] **Passo 1: conta le domande d'iscrizione, con l'ora**

```sql
select now() at time zone 'utc' as adesso_utc, count(*) as domande from enrollment_submissions;
```

- [ ] **Passo 2: la voce**

In cima a `PRD REGISTRO ELETTRONICO.md`, prima della prima riga `## …`, aggiungi (graffe sostituite con i valori misurati):

```markdown
## 🛡️ Changelog — Robustezza 2, sessione 14: l'identità si verifica in locale sulle letture, e si legge una volta per richiesta — {data UTC} (branch `robustezza2/s14-identita-condizionale`)

**Stato:** 🟡 sul ramo, PR non ancora aperta.

- **Perché (la soglia T10).** Passo 0 di {giorno} {data}: `/auth/v1/user` dal server, punta 07:55–08:05 UTC p95 **{p95} ms** (soglia 300); 24 h {finestra UTC} **{n}** chiamate (soglia 200.000). Nella stessa punta tutto il traffico server→DB aveva p95 {p95 tutto} ms. Letture di `utenti` + `parents` in 24 h: {n utenti} + {n parents}. Token `{alg}`.
- **Decisione riaperta.** Il 12/10 `getClaims()` sulle letture era stato scartato. Il titolare l'ha riaperta il {data della risposta} con «sì», sui numeri qui sopra.
- **Cosa cambia.** `withRoute` mette il verbo HTTP nel contesto. `verificaSessione` (`src/lib/auth/verifica-sessione.ts`): sui `GET`/`HEAD` delle API, nei layout d'area e nella radice `/` la firma del token si verifica in locale con le chiavi pubbliche in cache; ogni altro verbo, il verbo assente, `requireSessioneAuth` (cambio password, PDF firmati), `resolveSessionAppId` (modulo da firmare con OTP) e `/api/me` chiedono ad Auth. Una verifica locale impossibile ripiega su Auth. La cache delle chiavi è uscita dal middleware in `src/lib/auth/chiavi-firma.ts`, condivisa. `risolviDaAuthUid` si legge una volta per richiesta e per persona (`ricordaPerRichiesta` nel contesto di `withRoute`, non `cache()` di React).
- **Il rischio accettato.** Per al massimo {jwt_exp} secondi dopo una revoca, sulle letture restano validi: un account bannato dall'oblio GDPR, le altre sessioni di chi ha cambiato password, chi ha avuto le credenziali rigenerate, un token rubato dopo il logout. Restano immediati: archiviazione dello staff, cambio di ruolo, cancellazione dell'utente in Auth, tutte le scritture, `/api/me`, cambio password, PDF firmati, e le quattro `GET` che scrivono come effetto della lettura (messaggi letti, visualizzazione di una notizia, categorie del protocollo, riga dello scrutinio), che chiedono ad Auth (`sempreAlServer` nel gate){. Restano nella finestra: {RPC `v` che scrivono, dal Passo 0.9}}.
- **Lock.** `__tests__/architecture/identita-letture-scritture.test.ts`: chi verifica in locale, chi chiede ad Auth, chi si dichiara lettura di pagina, nessuna Server Action, cosa fanno i corpi dei `GET`, e i quattro che scrivono vanno ad Auth.
- **Log nuovi** (evento `auth`, `operazione: 'verificaSessione'`): `chiavi-aggiornate` (`info`), `token-non-asimmetrico` (`info`), `chiave-non-disponibile`, `chiavi-illeggibili`, `verifica-locale-fallita` (`warn`); `canale: 'locale' | 'server'` sulle righe `sessione-non-verificata`.
- **Migrazioni:** nessuna. **Domande d'iscrizione** contate alle {ora} UTC: **{conteggio}**.
```

- [ ] **Passo 3: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: sessione 14 di robustezza 2, identità verificata in locale sulle letture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 11 — Gate, PR, merge del titolare, misura «dopo»

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (la riga **Stato** della voce del Compito 10: «in revisione», Passo 5)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga trovata con `grep -n "^| 14 |"`: «in revisione», Passo 5). Lo stato finale, la misura «dopo» e la terza fotografia li scrive il ramo `robustezza2/s14-esito` (sezione «Per la sessione dopo»).

- [ ] **Passo 1: gate completo**

```bash
cd /Users/lerri/kidville-web-s14-identita
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -15
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: eslint e tsc senza output. Vitest: tutti i file verdi; se l'unico rosso è `offline-html-nativo`, rilancialo con `CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts`. Build: `✓ Compiled` e nessun `Error` (attenzione al middleware: deve compilare per l'Edge con l'import di `@/lib/auth/chiavi-firma`). La build senza heap a 8192 MB va in OOM su questa macchina. Leggi le righe di riepilogo, non il codice d'uscita di una pipe.

- [ ] **Passo 2: log presenti sul codice toccato, e niente dati nel diff**

```bash
grep -n "chiavi-aggiornate\|token-non-asimmetrico\|chiave-non-disponibile\|chiavi-illeggibili\|verifica-locale-fallita" src/lib/auth/verifica-sessione.ts
grep -n "canale: verifica.modo" src/lib/auth/require-staff.ts src/lib/auth/profili.ts
git diff origin/main -U0 | grep -nE "eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" | grep -v "noreply@anthropic.com" ; echo "righe sospette: fine elenco"
```

Atteso: almeno una riga per ciascun `esito`; tre righe `canale: verifica.modo`; nessuna riga prima di `righe sospette: fine elenco`.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s14-identita-condizionale
gh pr create --base main --head robustezza2/s14-identita-condizionale \
  --title "Robustezza 2, sessione 14: l'identità si verifica in locale sulle letture" \
  --body "$(cat <<'EOF'
## Cosa cambia
- **Letture in locale.** `verificaSessione` (`src/lib/auth/verifica-sessione.ts`): `GET`/`HEAD` dentro `withRoute`, i layout d'area e la radice `/` verificano la firma del token con le chiavi pubbliche in cache (`getClaims`). Ogni altro verbo, il verbo assente, `requireSessioneAuth`, `resolveSessionAppId` e `/api/me` chiedono ad Auth (`getUser`). Una verifica locale impossibile ripiega su Auth.
- **Il verbo nel contesto.** `withRoute` lo mette, `conContesto` lo normalizza; assente = scrittura.
- **Chiavi condivise.** La cache del JWKS è uscita dal middleware in `src/lib/auth/chiavi-firma.ts` (Edge e Node), con le stesse regole.
- **Una lettura per richiesta.** `risolviDaAuthUid` si ricorda con `ricordaPerRichiesta` (store di `withRoute`, non `cache()` di React).
- **I `GET` che scrivono chiedono ad Auth.** `requireUser`, `requireStaff` e `requireDocente` accettano `opzioni`; `chat/messages`, `news/feed/[id]`, `admin/protocolli/categorie` e `primaria/scrutinio` passano `{ sempreAlServer: true }`.
- **Lock** `identita-letture-scritture.test.ts` (regola 14: i `GET` che scrivono vanno ad Auth; regola 8: sei RPC in cinque file, `chat_riepilogo_conversazioni` compresa).

## Misure (sola lettura, prima del merge)
- Punta 07:55–08:05 UTC di {giorno} {data}, `/auth/v1/user`: p95 {p95} ms (soglia 300). 24 h {finestra}: {n} chiamate (soglia 200.000).
- Tutto il server→DB nella stessa punta: p95 {p95 tutto} ms. `utenti` + `parents` in 24 h: {n utenti} + {n parents}.
- Token `{alg}`; scadenza in produzione {jwt_exp} s.
- Domande d'iscrizione: {conteggio} alle {ora} UTC.

## Decisione del titolare
Il 12/10 `getClaims()` sulle letture era stato scartato. Riaperta il {data} con «sì», sui numeri qui sopra. Rischio accettato: per al massimo {jwt_exp} s dopo una revoca, le letture restano valide.

## Migrazione
Nessuna.

## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Prima di lanciarlo, sostituisci i valori fra graffe con quelli misurati. Annota il numero della PR stampato da `gh`.

- [ ] **Passo 4: CI verde su tutti i job**

```bash
gh pr checks {numero PR} --repo erricoluigi17/kidville-web --watch
```

Atteso: ogni job `pass`, E2E compreso. Un job `cancelled` del gruppo E2E non è rosso: succede quando più PR partono di fila. Si rilancia con `gh run rerun {id del run} --failed`, una PR alla volta. «CI verde» vuol dire **tutti** i job.

- [ ] **Passo 5: la riga di stato «in revisione» e lo Stato nel PRD, nella PR stessa**

La riga si trova per contenuto, mai per numero:

```bash
grep -n "^| 14 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga con Stato «da fare». Si sostituisce **quella** riga con (graffe sostituite):

```markdown
| 14 | Identità, **condizionale** | S3 | 7 | in revisione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s14-identita-condizionale.md` | T10 superata il {data} (p95 punta {p95} ms, {n} chiamate in 24 h); decisione del 12/10 riaperta dal titolare il {data della risposta}. Misura «dopo», stato finale e terza fotografia: ramo `robustezza2/s14-esito` |
```

Lo Stato si scrive «in revisione», con queste parole: «in produzione» per questa riga lo scrive solo il ramo `robustezza2/s14-esito`, dopo il merge (§5, «La tabella di stato»). Nella voce del Compito 10 la riga **Stato** diventa `🟡 in revisione (PR #{numero}), CI verde, in attesa del merge a mano del titolare.`

```bash
grep -c "^| 14 | .* | in revisione | #" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
Sessione 14: riga di stato in revisione, numero della PR nel PRD

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Atteso: `1`. Poi aspetta di nuovo la CI (Passo 4).

- [ ] **Passo 6: merge — lo fa il titolare, a mano**

Avvisa il titolare con il link della PR, ricordandogli il rischio accettato (la durata del token del Passo 0.8). **Mai** auto-merge, **mai** `gh pr merge` da chi esegue. Annota l'ora UTC del merge e lo sha.

- [ ] **Passo 7: verifica dopo il deploy (sola lettura)**

Qualche minuto dopo il deploy di produzione:
- apri `/api/health` sull'indirizzo di produzione (o leggi l'ultima risposta del monitor Cloudflare): tutti i controlli `ok`. Il controllo `auth` non è della sessione 7: c'era già (`src/lib/health/controlli.ts`, `misura('auth', …)`) e chiede ad Auth con `auth.admin.getUserById`, che non passa da `verificaSessione`. Dice che Auth risponde, **non** che la verifica locale funziona;
- il segnale vero della verifica locale sono le righe di autenticazione in `app_log` dal merge:

```sql
select livello, contesto->'campi'->>'operazione' as operazione, contesto->'campi'->>'esito' as esito,
       contesto->'campi'->>'canale' as canale, count(*) as righe, sum(occorrenze) as occorrenze,
       max(visto_l_ultima) as ultima
from app_log
where evento = 'auth' and sorgente = 'server' and visto_l_ultima > '{ora del merge UTC}'
group by 1, 2, 3, 4 order by 6 desc limit 20;
```

Atteso: nessuna riga `verifica-locale-fallita`; `chiave-non-disponibile` al più qualche riga (avvii a freddo durante un guasto del JWKS); le righe `error` `sessione-non-verificata` dello stesso ordine del Passo 0.7(c). `chiavi-aggiornate` è `info` e non arriva in `app_log`: il battito della verifica locale si legge nei log di Vercel (`canale: 'locale'`). Se compaiono `verifica-locale-fallita` o `chiave-non-disponibile` in numero, o un controllo della salute non è `ok`, si avvisa il titolare e si valuta il **Ritorno indietro**.

- [ ] **Passo 8: pulizia del ramo della sessione**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s14-identita
git -C /Users/lerri/kidville-web branch -D robustezza2/s14-identita-condizionale
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s14-identita-condizionale
```

Gli altri rami con una PR aperta **non** si toccano. Il `.env.local` copiato al Compito 1 se ne va con il worktree.

- [ ] **Passo 9: il ramo dell'esito**

La misura «dopo» matura con la prima finestra di 24 ore feriali **tutta dopo il deploy**; lo stato finale della riga 14, le misure maturate tardi delle sessioni prima e la terza fotografia di fine serie vanno scritti su un ramo. È il ramo di soli documenti `robustezza2/s14-esito`, l'unico che la specifica (§5) concede dopo un rilascio, e si apre dopo la pulizia del Passo 8 (regola 1 di `AGENTS.md`). Si esegue la sezione «Per la sessione dopo», in fondo a questo piano. **Non** si aggiunge codice per inseguire un numero della misura «dopo».

---

## Ritorno indietro

Nessuna migrazione e nessun dato da ripristinare: si torna indietro solo col codice.

1. **Subito:** il titolare fa **Instant Rollback** di Vercel al deploy precedente il merge. Il middleware torna alla sua cache interna, i gate tornano a `getUser()` ovunque.
2. **Poi, una PR di revert**, da un worktree nuovo su `origin/main`:

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web worktree add -b revert/s14-identita-condizionale /Users/lerri/kidville-web-s14-revert origin/main
cd /Users/lerri/kidville-web-s14-revert
git revert --no-edit {sha del merge squash della PR}
```

Il messaggio del commit di revert va completato con il trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (`git commit --amend`), poi stessi gate, stessa PR (corpo che chiude con `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), stessa CI, merge a mano del titolare, voce nel PRD con il motivo e l'ora UTC.

3. **Ritorno parziale**, se il problema è solo la verifica locale e non la memoria per richiesta né il modulo delle chiavi: una PR di una riga che fa tornare `modoVerifica` sempre `'server'` — in `src/lib/auth/verifica-sessione.ts`, prima riga del corpo di `modoVerifica`:

```ts
  return 'server' // ritorno parziale: verifica locale spenta, vedi PRD {data}
```

In quel caso il test 1 di `verifica-sessione.test.ts` e il test di `area-guard-lettura` restano verdi solo se si aggiornano le attese: la PR lo dice e li adegua, e il lock del Compito 9 resta com'è.

---

## Per la sessione dopo

La 14 è l'ultima sessione della serie: non c'è una sessione dopo che la chiuda. Questa sezione la esegue il ramo di soli documenti **`robustezza2/s14-esito`** (§5, «La tabella di stato»), dopo il merge della PR della 14, qualunque sia l'uscita, e dopo la pulizia del suo ramo. Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Le query sono in **sola lettura** (`execute_sql` con sole `SELECT`, `query_logs`, `get_advisors`, `curl` in `GET`, `gh` in lettura); nessuna scrittura in produzione.

**Che cosa ha lasciato la sessione 14.** Nessuna migrazione, in tutte e due le uscite: niente fotografie da rigenerare (nemmeno `migrazioni-applicate-snapshot.json`), nessuna voce da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` né da altre liste. Con l'Uscita 1, solo documenti. Con l'Uscita 2, codice: verifica della firma in locale sulle letture, una lettura di `utenti`/`parents` per richiesta, i quattro `GET` che scrivono ad Auth. Restano la riga di stato, il PRD, la misura «dopo», le misure maturate tardi delle sessioni prima e la terza fotografia di fine serie.

- [ ] **1. Si può aprire?**

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s14-identita-condizionale" --json number,mergedAt,mergeCommit --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid[0:8])"'
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"'
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "^| 14 |\|matura dal"
```

Atteso: una riga dal primo `gh` (numero, data del merge, commit corto: si annotano); nessuna riga dal secondo; dal `grep`, la riga 14 con Stato «in revisione» e le misure «matura dal …» delle sessioni prima, se ce ne sono.

Si apre dal giorno in cui sono mature:
- con l'Uscita 2, la misura «dopo» della 14 (punto 3): la prima finestra di 24 ore fra due giorni feriali **tutta dopo il deploy** (per esempio merge martedì → finestra mercoledì 12:30 → giovedì 12:30 UTC);
- le «matura dal …» stampate dal `grep`.

Una misura che matura oltre 14 giorni dopo il merge della 14 non si aspetta: resta scritta «matura dal …», e la scrive la prima PR che tocca la specifica dopo quel giorno.

- [ ] **2. Worktree e ramo**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s14-esito /Users/lerri/kidville-web-s14-esito origin/main
cd /Users/lerri/kidville-web-s14-esito && git status -sb | head -3
```

Atteso: `## robustezza2/s14-esito...origin/main`, albero pulito. `npm ci` serve solo se una voce del punto 5 chiede di lanciare un test.

- [ ] **3. La misura «dopo» della 14 (solo Uscita 2)**

Con `query_logs`, sulla finestra di 24 ore del punto 1 (`iso_timestamp_start` / `iso_timestamp_end`). Le chiamate a `/auth/v1/user` dal server, con p50 e p95 (query 2 bis con il filtro sul percorso):

```sql
select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
  round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
  round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.path']) = '/auth/v1/user'
group by colo order by n desc limit 8
```

- 24 ore: la somma di `n` è il numero della prova. **Prova della specifica: sotto 30.000.**
- La stessa query sulla punta 07:55–08:05 UTC di un giorno feriale dopo il deploy: il `p95` della riga con più richieste, contro il p95 in punta del Passo 0 (scritto nella colonna «Note» della riga 14 e nella voce del PRD).
- La stessa query **senza** la riga `and toString(log_attributes['request.path']) = '/auth/v1/user'`, sulla stessa punta: tutto il traffico server→DB, per vedere se la coda è dell'identità o del database.
- Le chiamate al JWKS dal server nelle 24 ore: la query con `'/auth/v1/.well-known/jwks.json'` al posto di `'/auth/v1/user'`. Atteso: poche, una per istanza ogni dieci minuti.

Le letture di `utenti` e `parents` dal server, stesse 24 ore. **Prova della specifica: sotto 150.000** (il 20/10: 396.694):

```sql
select toString(log_attributes['request.path']) as percorso, count(*) as n
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.method']) = 'GET'
  and toString(log_attributes['request.path']) in ('/rest/v1/utenti', '/rest/v1/parents')
group by percorso order by n desc
```

Ogni numero con giorno, data, ora UTC e finestra. Se una prova non è raggiunta, il numero si scrive com'è, con «osservato» e «causa probabile» separati (per esempio: le letture di `utenti`/`parents` sui `GET` restano una per richiesta, perché la memoria toglie solo i doppioni dentro la stessa richiesta; `/api/me` resta su `getUser()`), e si porta al titolare. Non si aggiunge codice per inseguire il numero.

- [ ] **4. La riga 14, stato finale**

```bash
grep -n "^| 14 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga con Stato «in revisione». Si sostituisce **quella** riga, trovata col testo, con una di queste due (graffe sostituite; le note restano nella colonna «Note», la colonna «Dopo» resta `7`):

Uscita 2:

```markdown
| 14 | Identità, **condizionale** | S3 | 7 | in produzione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s14-identita-condizionale.md` | in produzione il {data UTC del merge}, `main` `{sha corto}`; T10 superata il {data} (p95 punta {p95} ms, {n} chiamate in 24 h); decisione del 12/10 riaperta dal titolare il {data della risposta}. Dopo ({finestra UTC}): `/auth/v1/user` {n dopo}/24 h (prova < 30.000), `utenti`+`parents` {n dopo} (prova < 150.000), p95 punta {p95 dopo} ms. Terza fotografia: `docs/analisi-robustezza-{AAAA-MM-GG}.md` |
```

Uscita 1:

```markdown
| 14 | Identità, **condizionale** | S3 | 7 | chiusa senza codice | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s14-identita-condizionale.md` | {la nota della variante, com'era}; chiusa il {data UTC del merge}, `main` `{sha corto}`. Terza fotografia: `docs/analisi-robustezza-{AAAA-MM-GG}.md`, `/auth/v1/user` {n} in 24 h |
```

- [ ] **5. Le misure maturate tardi delle sessioni prima**

Per ogni riga «matura dal …» stampata al punto 1 con un giorno già passato:
1. apri il piano della sua riga (colonna «Piano», oppure `docs/superpowers/plans/2026-10-20-robustezza2-<nome nella colonna>.md`), e nella sua sezione «Per la sessione dopo» trova il punto che descrive quella misura;
2. fai quel punto come è scritto, in sola lettura, e sostituisci «matura dal …» col risultato, nella riga della tabella e negli altri file che il punto nomina (per esempio, per la sessione 13: `docs/cicd.md` e la voce del PRD);
3. le cose condizionali restano tali: una decisione che il punto riserva al titolare (per esempio il passaggio a 429 di una regola del firewall della sessione 13) si porta a lui, e si scrive solo la decisione che prende.

Con l'ordine della serie, di solito restano qui la misura di controllo e le 7 letture del firewall della sessione 13.

- [ ] **6. La terza fotografia di fine serie (§5, «Misure di controllo»), in tutte e due le uscite**

Le stesse **14 misure** della §4 di `docs/analisi-robustezza-2026-10-20.md` («Fotografia di oggi — martedì 20/10/2026»), misurate nello stesso modo: la colonna «Come si rimisura» di quella tabella, le query «Query 1 — tempo DB per statement», «Query 2 — da dove arrivano le richieste a Supabase e quanto aspettano», «Query 2 bis — solo le richieste del server», «Query 3 — errori e timeout per giorno» e «Query 4 — dimensioni» di `docs/roadmap-robustezza.md`, e le fonti della §5.2 dello stesso rapporto (MCP Supabase in sola lettura, `supabase backups list`, API di gestione con il token dal Portachiavi mai stampato, `curl` sul dominio di produzione, `vercel api`, `gh run list`).
- **Quando.** Un giorno feriale. «24 h» = dalle 12:30 UTC del giorno feriale prima alle 12:30 UTC di oggi, come il 20/10. La punta è 07:55–08:05 UTC, la calma 11:10–11:20.
- **Prima di misurare**, si annotano i deploy di produzione e i giri del backup nelle finestre: il 20/10 la punta cadeva due minuti dopo un deploy e dentro il backup, e i numeri ne portavano il segno.
- **Le serie di 30 richieste** (misure 5 e 6) usano l'user agent `kidville-misura-fine-serie` e si fermano alla prima risposta `403` o `429`, contando quante ne sono arrivate prima (il 20/10: 23 × `200`, poi `403`). Le regole `s13-*` del firewall in «log» non bloccano; una passata a 429 sì, ed è un risultato da scrivere.
- **La misura 13** è il solo `SELECT count(*) FROM enrollment_submissions;`, con l'ora UTC.
- **Il risultato** va in un file nuovo, `docs/analisi-robustezza-{AAAA-MM-GG}.md` (la data della misura), con:
  - il titolo `# Analisi di robustezza — terza fotografia, fine della seconda serie ({GG/MM/AAAA})`;
  - un paragrafo con giorno, finestre, deploy e backup dentro le finestre;
  - la tabella delle 14 misure con le colonne della §4 del 20/10 (`#`, Misura, Valore, Giorno · ora UTC · finestra, Come si rimisura) e una colonna in più, «20/10», con il valore di allora;
  - la tabella per giorno della misura 7 (query 3) sui 14 giorni prima;
  - una sezione «Cosa è cambiato dal 20/10»: per ogni misura che si è mossa, «osservato» e «causa probabile» separati, e la sessione della serie che la spiega, se c'è.
- **Nessun dato personale**: solo conteggi, millisecondi, codici, nomi di tabelle e di file; mai IP, email, token, nomi.

- [ ] **7. Il PRD**

```bash
grep -n "Robustezza 2, sessione 14" "PRD REGISTRO ELETTRONICO.md"
```

Atteso: una riga, il titolo della voce della 14. Due righe sotto, la riga **Stato** diventa:
- Uscita 2: `**Stato:** ✅ in produzione dal {data} (PR #{numero}, merge {sha corto}).` e in fondo alla voce si aggiunge `- **Misura dopo** ({finestra UTC}): …` con i numeri del punto 3;
- Uscita 1: `**Stato:** ✅ chiusa senza codice il {data} (PR #{numero}, merge {sha corto}).`

In tutte e due, in fondo alla voce: `- **Terza fotografia di fine serie:** `docs/analisi-robustezza-{AAAA-MM-GG}.md` ({giorno} {data}). {Una riga con le due o tre misure che si sono mosse di più.}`. Le voci del PRD che il punto 5 nomina si aggiornano come quel punto dice.

- [ ] **8. Niente dati nel diff, commit, PR**

```bash
cd /Users/lerri/kidville-web-s14-esito
git diff -U0 | grep -nE "eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" ; echo "righe sospette: fine elenco"
git add docs/analisi-robustezza-*.md docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git status --short
```

Atteso: nessuna riga prima di `righe sospette: fine elenco`. Un numero di versione con quattro parti (per esempio quello di Postgres nella misura 10) non è un indirizzo IP: si guarda e si va avanti; un IP vero si toglie. Se `git status --short` mostra file non aggiunti che il punto 5 ha cambiato (per esempio `docs/cicd.md`), aggiungili per nome. Poi:

```bash
git commit -m "$(cat <<'EOF'
Robustezza 2: esito della sessione 14 e terza fotografia di fine serie

Riga 14 allo stato finale, misure maturate tardi delle sessioni prima,
terza fotografia con le 14 misure del 20/10, misurate nello stesso modo.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push -u origin robustezza2/s14-esito
gh pr create --base main --head robustezza2/s14-esito \
  --title "Robustezza 2: esito della sessione 14 e terza fotografia di fine serie" \
  --body "$(cat <<'EOF'
## Cosa cambia
Solo documenti: lo stato finale della riga 14, le misure maturate tardi delle sessioni prima, la terza fotografia di fine serie in `docs/analisi-robustezza-{AAAA-MM-GG}.md`, il PRD.

## Misure (sola lettura)
{le righe principali del punto 3, se Uscita 2, e della terza fotografia}

## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Prima di lanciarlo, sostituisci i valori fra graffe.

- [ ] **9. CI verde su tutti i job, merge del titolare, pulizia**

```bash
gh pr checks {numero PR} --repo erricoluigi17/kidville-web --watch
```

Atteso: ogni job `pass`; un E2E `cancelled` si rilancia con `gh run rerun {id del run} --failed`. Il merge lo fa il titolare, a mano. Dopo il merge:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s14-esito
git -C /Users/lerri/kidville-web branch -D robustezza2/s14-esito
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s14-esito
```

Atteso: `git -C /Users/lerri/kidville-web branch -a --list '*s14*'` non stampa niente. La serie è chiusa.

---


## Autorevisione (fatta alla stesura, da ripetere alla fine)

**Copertura della specifica (§7, Sessione 14, e consegne della sessione):**

| Richiesta | Dove |
|---|---|
| Passo 0: p95 in punta 07:55–08:05 UTC e chiamate in 24 h, query 2 bis con il filtro su `/auth/v1/user`, giorno feriale | Passo 0.3-0.6 |
| Soglia T10: 300 ms oppure 200.000 | Passo 0.10 |
| Sotto soglia: «non serve», misura con data e ora UTC, riga nella tabella di stato | Uscita 1 (U1.4, U1.5); stato finale nel ramo `robustezza2/s14-esito` |
| Va scritto che riapre la decisione del 12/10, e si chiede al titolare prima del primo compito | Uscita 2 |
| Verificare che il token sia ES256; se no, nessun guadagno | Passo 0.2 → Uscita 1 «token non asimmetrico»; a runtime `ALGORITMI_LOCALI` + ripiego |
| `getClaims()` solo sulle letture in `require-staff.ts:272` e `profili.ts:103` | Compiti 5, 6, 7 |
| `require-staff.ts:337,706` | Compito 6: restano ad Auth (`sempreAlServer`) — vedi le note sotto |
| La cache delle chiavi esce dal middleware in un modulo condiviso (Edge e Node) | Compito 4 |
| `getUser()` su scritture, distruttive e `/api/me` | Compito 5 (`modoVerifica`); Compito 8 (i quattro `GET` che scrivono vanno ad Auth con `sempreAlServer`); Compito 9 (regole 1, 2, 6, 9, 10, 14) |
| Come il codice distingue lettura e scrittura | Compito 5, introduzione; Compito 2 (verbo) |
| Lock che impedisce a una scrittura di passare da `getClaims()` | Compito 9 |
| `risolviDaAuthUid` per richiesta nel contesto di `withRoute`, non `cache()` di React; stessa richiesta → una lettura, due richieste → due | Compiti 3 e 6 (`identita-per-richiesta.test.ts`) |
| Rischio: account disattivato valido in lettura fino alla scadenza del token, con la durata | Uscita 2; Passo 0.8; PRD |
| §5, prerequisiti: la PR della 7 mergiata e la sua migrazione applicata, verificate coi fatti; nessuna PR `robustezza2/` aperta salvo `-esito` | U1.1; Compito 1, Passo 1 |
| §5, chiusura della sessione rilasciata per ultima nel primo commit, dalla sua «Per la sessione dopo», con la fotografia delle migrazioni | U1.3; Compito 1, Passo 5 |
| §5, tabella di stato in due tempi: «in revisione» nella propria PR, stato finale dopo il merge | U1.4, U1.8; Compito 11, Passo 5; «Per la sessione dopo», punto 4 |
| §5, l'ultima sessione usa il ramo `robustezza2/s14-esito`; nessun altro ramo di soli documenti | U1.10; Compito 11, Passo 9; «Per la sessione dopo» |
| §5, «Misure di controllo»: la terza fotografia completa a fine serie, 14 misure, misurate nello stesso modo | «Per la sessione dopo», punto 6 |
| §6, sezione «Per la sessione dopo» | in fondo al piano, prima di questa |
| Ramo da `origin/main` in un worktree nuovo | U1.2; Compito 1, Passo 2 |
| Lock `offline-html-nativo` con `CI=1`; build con heap 8192 | Compito 1 Passo 7; Compito 11 Passo 1 |
| Rilascio: gate, CI su tutti i job, merge a mano del titolare, `SELECT` dopo il merge, misura «dopo» con data e ora UTC | Compito 11 (la lettura di `app_log` dopo il deploy, Passo 7); misura «dopo»: «Per la sessione dopo», punto 3 |
| Prova: `/auth/v1/user` sotto 30.000; `utenti` + `parents` sotto 150.000; p95 in punta contro il Passo 0 | «Per la sessione dopo», punto 3 (matura con la prima finestra di 24 h feriali dopo il deploy) |
| Indietro: Instant Rollback e revert | Ritorno indietro |
| Pulizia solo del ramo e del worktree della sessione | U1.10; Compito 11, Passo 8; «Per la sessione dopo», punto 9 |

**Segnaposto:** i soli valori fra graffe sono numeri, date e sha che esistono solo al momento della misura o della PR (`{p95}`, `{numero PR}`…), come nel piano della sessione 1. Nessun passo rimanda a un altro compito al posto del codice.

**Nomi coerenti fra i compiti:** `verbo` / `verboSicuro` / `verboGrezzo` (Compito 2); `ricordaPerRichiesta` (3, usata in 6); `chiaviDiFirma(scarica, segnala?)`, `intestazioneDelToken`, `ALGORITMI_LOCALI`, `CHIAVI_TTL_MS`, `CHIAVI_RIPROVA_MS`, `ChiaviFirma`, `ChiavePubblica` (4, usati in 5 e 9); `verificaSessione`, `modoVerifica`, `livelloErroreSessione`, `VERBI_DI_LETTURA`, `OpzioniVerifica` (`letturaDiPagina`, `sempreAlServer`), `EsitoSessione` (`uid`, `email`, `error`, `modo`) (5, usati in 6, 7, 8, 9); `risolviPerRichiesta` e `completo` (6); `opzioni: OpzioniVerifica` di `requireUser`, `requireStaff`, `requireDocente`, `utenteDellaRichiesta` e `resolveIdentity` (8, controllate in 9, regola 10); `SEMPRE_AL_SERVER` e `GET_CHE_SCRIVONO` (9, regola 14); esiti di log `chiavi-aggiornate`, `token-non-asimmetrico`, `chiave-non-disponibile`, `chiavi-illeggibili`, `verifica-locale-fallita` (5, Log, PRD, Compito 11). Ramo `robustezza2/s14-identita-condizionale` e cartella `/Users/lerri/kidville-web-s14-identita` uguali in Uscita 1, Compito 1 e Compito 11; ramo `robustezza2/s14-esito` e cartella `/Users/lerri/kidville-web-s14-esito` uguali in U1.10, Compito 11 (Passo 9) e «Per la sessione dopo»; ramo di revert `revert/s14-identita-condizionale`, fuori dal prefisso `robustezza2/` che le sessioni cercano.

**Note per il titolare e per chi esegue (scostamenti dalla specifica, dichiarati):**
- `require-staff.ts:706` (`requireSessioneAuth`, cambio password e PDF firmati) e `:337` (`resolveSessionAppId`, la pagina del modulo da firmare con OTP) restano ad Auth con `sempreAlServer`, anche in `GET`: è quello che la specifica di oggi chiede (§7, Sessione 14).
- **I quattro `GET` che scrivono vanno ad Auth (Compito 8).** La specifica tiene `getUser()` sulle scritture; quei quattro scrivono anche se il verbo è `GET`. Il piano lo ottiene passando `{ sempreAlServer: true }` ai loro gate (`requireUser`, `requireStaff`, `requireDocente`, che inoltrano le opzioni fino a `verificaSessione`), non con una `verificaSessione(supabase, { sempreAlServer: true })` nel corpo della route: lì `supabase` è il client di servizio, l'identità della route è quella del gate (con il ripiego sull'intestazione e il `try/catch` fuori da una richiesta), e una seconda verifica lascerebbe la prima in locale. Per quei quattro il costo resta quello di oggi.
- «`utenti` + `parents` sotto 150.000» difficilmente si raggiunge con questa sessione: la memoria per richiesta toglie solo i doppioni dentro la stessa richiesta (la conclusione del 12/10 era «un gate per richiesta»). La misura «dopo» («Per la sessione dopo», punto 3) lo misura e lo dice, senza codice in più.
- La specifica cita `src/middleware.ts` alle righe 207-283 (cache e commento) e 375-408 (chiavi e `getClaims`), che tornano col codice del 20/10. Il commento alle 221-225 («`fetchJwk` tiene le chiavi sull'ISTANZA») non è più vero con auth-js 2.112 (`GLOBAL_JWKS`), e quello alle 229-232 («`getClaims()` ripiega da solo su `getUser()`») vale per un JWKS vuoto, non per uno irraggiungibile: il Compito 4 li sostituisce.
