# Sessione 12 — Chat leggera — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** aprire o aggiornare l'elenco delle conversazioni deve costare poche richieste al database (≤ 5 per `GET`), non le ~150 di oggi con 37 conversazioni. In più, gli errori del realtime si devono poter separare fra interruzioni vere e riconnessioni riuscite.

**Architettura:** cinque interventi indipendenti, ciascuno col suo test.

1. Una RPC `public.chat_riepilogo_conversazioni(p_utente uuid)` restituisce in una chiamata la stessa forma che oggi `GET /api/chat/threads` costruisce con 4 letture per conversazione. La route la chiama e, se manca (`PGRST202`/`42883`) o si guasta, torna al percorso di prima.
2. L'`UPDATE` di `delivered_at` esce dalla `GET` e diventa `POST /api/chat/threads/consegnati`. La pagina chat lo chiede solo quando la lista mostra non letti nuovi.
3. I due orologi che scaricavano la stessa lista diventano uno: quello di `useConversazioneChat`, 30 s a pagina visibile e 5 min a pagina nascosta. `useUnreadNotifications` si limita a chiedere il permesso delle notifiche; conteggio, titolo e notifica del browser li fa `annunciaNonLetti` sulla lista già in mano.
4. Per ogni conversazione `chat/messages:POST` programma un solo giro di dispatch per finestra di 30 s.
5. Un `1006` del realtime non si logga subito. Se il canale rientra entro 60 s, resta la riga di rientro che esiste già; altrimenti parte il `warn` di prima.

**Tecnologie:**
- Next.js (App Router, route handler, `after()`) e Supabase (PostgREST, RPC in SQL).
- React 19 (hook, `useCallback`, ref).
- vitest, con jsdom e timer finti; PGlite per la migrazione vera su un Postgres vero.
- I lock di `__tests__/architecture/`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 12 (righe 701-729), con le regole comuni della §5 (righe 133-197), il formato della §6 («Apertura e chiusura», righe 237-243) e la riga della sessione 12 nella tabella di stato, che si trova con `grep -n "^| 12 |"` (mai per numero di riga).

---

## Mappa dei file

| File | Ruolo | Righe lette |
|---|---|---|
| `supabase/migrations/<S12_VERSION>_chat_riepilogo_conversazioni.sql` | **Crea** (Compito 2). La RPC di riepilogo, con guardia sulle 21 colonne, `SECURITY INVOKER`, `search_path` fisso; `EXECUTE` solo a `service_role` | modello ROLLBACK: `supabase/migrations/20261019223123_battiti_app_log_che_contano.sql:1-60` |
| `__tests__/lib/chat-riepilogo-conversazioni-sql.test.ts` | **Crea** (Compito 2). Migrazione vera su PGlite: ordine, non letti, ripieghi, permessi, seconda difesa RLS, guardia | modello: `__tests__/lib/chat-broadcast-privato-sql.test.ts:1-200` |
| `src/lib/chat/riepilogo-conversazioni.ts` | **Crea** (Compito 3). Modulo puro che interpreta la risposta della RPC: `ok`, `assente` (`info`), `guasto` (`error`) | — |
| `__tests__/lib/chat-riepilogo-conversazioni.test.ts` | **Crea** (Compito 3) | — |
| `src/app/api/chat/threads/route.ts` | **Modifica** (Compito 3). La `GET` chiama la RPC e conserva il ripiego; esce `marcaConsegnati` | 1-332 (la `GET` è 43-176) |
| `__tests__/api/chat-threads-riepilogo.test.ts` | **Crea** (Compito 3). ≤ 5 richieste, identità del gate, nessun `UPDATE`, ripiego a 150 | modello: `__tests__/api/chat-threads-sospensione.test.ts:1-81` |
| `__tests__/api/chat-threads-sospensione.test.ts` | **Modifica** (Compito 3). Il client finto riceve una `rpc` che risponde `PGRST202` | 1-81 |
| `__tests__/api/auth-gaps-m9.test.ts` | **Modifica** (Compito 3). Idem, e la `rpc` riceve l'id del gate | 20-30, 60-98, 190-206 |
| `src/app/api/chat/threads/consegnati/route.ts` | **Crea** (Compito 4). `POST`, corpo `{}`, identità del gate, `marcaConsegnati` | modello: `src/app/api/chat/threads/route.ts:178-332` |
| `__tests__/api/chat-threads-consegnati.test.ts` | **Crea** (Compito 4) | — |
| `__tests__/architecture/isolamento-sede-coverage.test.ts` | **Modifica** (Compito 4). Voce `AMMESSE` e tre contatori +1 | 166, 495-520, 756-830, 1072-1078, 1879-1900, 2518-2534, 2815-2828, 3188-3204 |
| `src/app/api/notifiche/route.ts` | **Modifica** (Compito 4). Solo il commento delle righe 65-69, che cita la consegna fatta dalla lista | 55-80 |
| `src/lib/chat/lista-conversazioni.ts` | **Crea** (Compito 5). La `GET` della lista come esito, senza `try` | — |
| `src/lib/chat/annuncio-non-letti.ts` | **Crea** (Compito 5). Totale, titolo della pagina, notifica del browser (spostati da `useUnreadNotifications`) | `src/components/features/chat/useUnreadNotifications.ts:1-146` |
| `src/lib/chat/consegna-conversazioni.ts` | **Crea** (Compito 5). Impronta dei non letti, decisione di consegna, `POST` | — |
| `__tests__/lib/chat-lista-conversazioni.test.ts`, `__tests__/lib/chat-annuncio-non-letti.test.ts`, `__tests__/lib/chat-consegna-conversazioni.test.ts` | **Crea** (Compito 5) | modelli: i due test di `useUnreadNotifications` qui sotto |
| `src/components/features/chat/useUnreadNotifications.ts` | **Riscrive** (Compito 6). Solo il permesso delle notifiche | 1-146 |
| `src/components/features/chat/useConversazioneChat.ts` | **Modifica** (Compito 6). Un orologio, `applicaLista` senza `try`, consegna esplicita | 1-130, 156-378, 474-490, 560-608, 618-690, 752-762 |
| `__tests__/components/useConversazioneChat-un-poller.test.tsx` | **Crea** (Compito 6) | modello: `__tests__/components/useConversazioneChat-contatore-chat.test.tsx:1-160` |
| `__tests__/components/useUnreadNotifications-permesso.test.tsx` | **Crea** (Compito 6) | — |
| `__tests__/components/useConversazioneChat-contatore-chat.test.tsx` | **Modifica** (Compito 6). Via `onUnreadChange`; il totale arriva dalla lista | 1-160, 268-292, 392-430 |
| `__tests__/components/useConversazioneChat.test.tsx` | **Modifica** (Compito 6). Nel test della raffica il server finto conta i non letti | 60-82, 336-353, 505-600, 684-720, 826-876 |
| `__tests__/pages/chat-stato-conversazione.test.tsx` | **Modifica** (Compito 6). Si trattiene solo la `POST` dei messaggi (precauzione) | 80-130, 205-225, 436-450 |
| `__tests__/components/useUnreadNotifications-riservatezza.test.tsx`, `__tests__/components/useUnreadNotifications-clic-notifica.test.tsx` | **Elimina** (Compito 6). I casi passano in `chat-annuncio-non-letti.test.ts` | 1-177, 1-133 |
| `src/lib/hooks/use-polling-visibile.ts`, `__tests__/lib/use-polling-visibile.test.tsx` | **Modifica** (Compito 6). Solo commenti | 20-60; 180-195 |
| `src/lib/chat/finestra-dispatch.ts` + `__tests__/lib/chat-finestra-dispatch.test.ts` | **Crea** (Compito 7) | — |
| `src/app/api/chat/messages/route.ts` | **Modifica** (Compito 7). `programmaDispatchChat` | 1-205 (la funzione è 110-198) |
| `__tests__/api/chat-messages-dispatch-anticipato.test.ts` | **Modifica** (Compito 7) | 1-346 |
| `src/lib/chat/esito-1006.ts` + `__tests__/lib/chat-esito-1006.test.ts` | **Crea** (Compito 8) | `src/lib/chat/stato-conversazione.ts:700-746` |
| `src/components/features/chat/useChatRealtime.ts` | **Modifica** (Compito 8) | 1-30, 100-350 |
| `__tests__/components/useChatRealtime-canale.test.ts` | **Modifica** (Compito 8) | 1-215, 330-464 |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica** (Compito 9), voce in cima; al Compito 1, lo Stato della voce della sessione chiusa | 1-34 |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica** (Compito 10): la riga della sessione 12 a «in revisione», trovata per contenuto; e, al Compito 1, la riga della sessione chiusa | 23-38, 133-197, 237-243, 701-729 |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` | **Rigenera** al Compito 1 (chiusura della sessione rilasciata per ultima), se quella aveva migrazioni. La migrazione di questa sessione la fotografa la sessione dopo («Per la sessione dopo») | `__tests__/fixtures/migrazioni-fotografia.mjs:1-40` |

**Letti e non toccati:**
- `src/lib/chat/delivered.ts:200-300`, per la firma ed esito di `marcaConsegnati`.
- `src/lib/db/guasto.ts:1-52`, per `rispostaGuastoDb`.
- `src/lib/validation/http.ts:104-121`, per `parseBody`.
- `src/lib/logging/client.ts:160-245`, per `livelloFetch` e `livelloEvento`.
- `src/lib/logging/logger.ts:188-230`, da cui risulta che `chat` e `push` persistono anche i successi.
- `src/lib/logging/redact.ts:250-256`, per la lista bianca: c'è `error_code`, non c'è `codice`.
- `src/lib/hooks/visibilita-pagina.ts:52-113` e `src/components/features/chat/ChatThreadList.tsx:16-28`.
- `src/lib/notifiche/triggers.ts:90-130` e `src/lib/push/dispatch.ts`, solo con ricerche mirate.
- `src/app/api/avvisi/[id]/risposte/route.ts:60-80`, per il modello `RPC_ASSENTE`.
- `__tests__/architecture/soglia-fotografia.ts:200-380`, per le guardie delle fotografie.
- `__tests__/architecture/errori-postgrest-guardati.test.ts:40-60` e `__tests__/architecture/vigilanza-chat-tracciata.test.ts:1-60`.
- `e2e/chat.spec.ts`: nessun E2E guarda la consegna.
- `docs/analisi-robustezza-2026-10-20.md:282-303` (il rapporto del 20/10) e, come modello di forma, il piano della sessione 11.

---

## Scelte di questo piano rispetto alla lettera della specifica

1. **Righe della specifica.** Dopo la revisione del 20/10 i quattro intervalli della specifica coincidono con il codice letto quel giorno:

   | Specifica | Codice letto il 20/10 |
   |---|---|
   | `src/app/api/chat/threads/route.ts:43-176` | la `GET`; il cuore va dalla 55 alla 171 |
   | `useConversazioneChat.ts:242-247,674` | il poller della lista; si chiude alla 676 |
   | `src/app/api/chat/messages/route.ts:110-198` | `programmaDispatchChat` |
   | `useChatRealtime.ts:301-310` | il ramo `CHANNEL_ERROR`/`TIMED_OUT` |

   Fra i piani della serie, nessuna sessione prima della 12 tocca questi quattro file; la sessione 2 tocca il lock `isolamento-sede-coverage`, che questo piano cambia al Compito 4. Il codice può comunque essersi spostato fra il 20/10 e il giorno in cui si esegue: ogni sostituzione di questo piano si fa per **contenuto** (il testo da cercare, il nome della funzione o del test), e i numeri di riga sono solo un aiuto (specifica §5, «Riferimenti al codice»).

2. **«L'`UPDATE` esce dalla `GET`».** È l'`UPDATE` di `delivered_at` fatto da `marcaConsegnati` (`threads/route.ts:66-70`), non di `read_at`.

3. **La RPC si chiama dentro la route.** Il lock `isolamento-sede-coverage` attribuisce ogni `.from(`/`.rpc(` allo span del suo handler. Un helper fuori dall'handler, o una chiamata nascosta in una libreria, finirebbe nello span `<modulo>` o fuori dalla vista del lock. Per questo `src/lib/chat/riepilogo-conversazioni.ts` non chiama nulla: interpreta soltanto la risposta. Anche le sospensioni restano dentro la `GET`, come chiusura interna.

4. **Ripiego.** La specifica (§5) chiede di reggere `PGRST202` e `42883` «solo su quella chiamata», con un insieme locale sul modello `RPC_ASSENTE` e una riga `info`. Il piano lo fa (`RPC_RIEPILOGO_ASSENTE`). In più, anche un guasto diverso della RPC (per esempio `57014`, o una risposta di forma inattesa) torna al percorso di prima, ma con una riga `error`: la lista delle conversazioni non deve svuotarsi per colpa del riepilogo. `src/lib/db/tolleranza-schema.ts` non si tocca.

5. **INVOKER e non DEFINER.** La chiama solo la route, col client `service_role`, che bypassa la RLS: una funzione proprietaria non aggiungerebbe niente. Con INVOKER, un `GRANT EXECUTE` dato per errore ad `authenticated` lascerebbe ancora la RLS di `chat_threads` come seconda difesa, e il test lo prova. L'`EXECUTE` è tolto a `PUBLIC`, `anon` e `authenticated`.

6. **«Un poller solo».** Gli orologi della **lista** erano due, con due `GET` identiche: `useConversazioneChat:674` e `useUnreadNotifications`, ogni 30 s e ogni 5 min a pagina nascosta. Ne resta uno, che a pagina nascosta rallenta a 5 min invece di fermarsi, perché è da nascosta che parte la notifica del browser. Il poller dei **messaggi** della conversazione aperta (`useConversazioneChat:678-690`) è un'altra risorsa e resta com'è.

7. **«Un solo dispatch per finestra di 30 s».** La finestra è per **conversazione** e per **istanza** della funzione, come dice la specifica (§7, «Sessione 12»): una mappa in memoria, che scade da sola dopo 30 s più un margine di 15 s. Il rapporto del 20/10 parlava di finestra «per sede», ed è per questo che la scelta resta una decisione del titolare (la 2, chiesta al Compito 1). Una finestra condivisa fra istanze richiederebbe una tabella o un lock nel database, cioè proprio il carico che questa sessione toglie. Fra istanze diverse si resta come oggi: la presa atomica di `eseguiDispatch` impedisce il doppione.

8. **«Un `1006` seguito da riconnessione riuscita non si scrive».** È la lettera della specifica di oggi, e il motivo è quello che dice lei: lato client `info` non esiste come riga persistita, `logClient` accetta solo `warn`/`error`. Il piano quindi non scrive niente subito.
   - Se il canale rientra entro 60 s, la riconnessione resta contata dalla riga `chat-realtime-rientrato: …` che `useConversazioneChat` già scrive.
   - Se non rientra, si scrive lo stesso `warn` `chat-realtime-errore: socket-chiuso-1006` di prima, con il numero di errori.
   - L'interruzione vera resta `warn`, non diventa `error`.
   - Gli altri motivi, compreso `trasporto`, si loggano subito come oggi.

9. **La misura «~150».** Dal codice: 1 lettura di `chat_threads`, più 1 `UPDATE` per blocco di 100 thread, più 1 lettura delle sospensioni, più 4·N. Con N = 37 fa 151. Nei log si misura come rapporto fra le letture uniche della `GET` e il numero di `GET` (Passo 0.4).

10. **Tabella di stato.** Nella propria PR la riga della sessione 12 (`grep -n "^| 12 |"`) diventa «in revisione», col numero della PR e il percorso del piano (§5, «La tabella di stato, in due tempi»). «In produzione», il commit di `main` e la misura «dopo» li scrive la sessione che apre dopo, eseguendo la sezione «Per la sessione dopo» in fondo a questo piano: niente PR-B separata e niente rami di soli documenti dopo il rilascio.

---

## Passo 0 — misura prima

Tutto in **sola lettura**:
- le query SQL si lanciano con lo strumento MCP `execute_sql`;
- quelle sui log di Supabase con `query_logs` (finestra con `iso_timestamp_start`/`iso_timestamp_end`, al massimo 24 h).

Chi ha scritto questo piano non ha accesso alla produzione: **nessun numero qui sotto è un risultato**. I valori del 20/10 citati vengono dalla specifica e dal rapporto (`docs/analisi-robustezza-2026-10-20.md:282-303`).

Ogni valore si annota in `${TMPDIR:-/tmp}/s12-misure.env`, una riga `S12_<NOME>='<valore>'` per misura, con il giorno della settimana, la data, l'ora UTC e la finestra. Finiranno nella PR e nel PRD.

**Mai un testo di messaggio**, nemmeno qui: si leggono solo conteggi, codici, nomi di tabelle e gettoni di log a cardinalità chiusa.

**Se una soglia qui sotto chiede di fermarsi**, la decisione non si riapre dentro il piano (§2 della specifica). Si scrive il fatto, con il suo numero, nella colonna «Note» della riga della sessione 12 della specifica (`grep -n "^| 12 |"`), e si avvisa il titolare.

- [ ] **0.1 — Ora e domande di iscrizione**

```sql
select now() at time zone 'utc' as adesso_utc;
SELECT count(*) FROM enrollment_submissions;
```

Annota `S12_ORA_PRIMA` e `S12_ISCRIZIONI_PRIMA`. Il conteggio va nel PRD (§5: «Prima di ogni migrazione»), e si ripete prima del merge (Compito 10, Passo 3).

- [ ] **0.2 — Conversazioni per utente**

```sql
with partecipanti as (
  select teacher_id as utente from chat_threads
  union all
  select parent_id as utente from chat_threads
), per_utente as (
  select utente, count(*) as conversazioni from partecipanti group by utente
)
select (select count(*) from chat_threads) as conversazioni_totali,
       count(*) as utenti_con_conversazioni,
       max(conversazioni) as massimo,
       percentile_disc(0.5) within group (order by conversazioni) as p50,
       percentile_disc(0.95) within group (order by conversazioni) as p95
from per_utente;
```

Annota i cinque numeri (il 20/10: 1.004 conversazioni, al massimo 37 per utente). Con il massimo, la formula del punto 9 delle «Scelte» dà le richieste della `GET` più pesante: 3 + 4·N.

- [ ] **0.3 — Le chiavi degli `edge_logs` (sonda)**

Con `query_logs`, finestra delle ultime 24 h:

```sql
select arrayJoin(mapKeys(log_attributes)) as chiave, count(*) as n
from logs
where source = 'edge_logs'
group by chiave
order by n desc
limit 80
```

Atteso: fra le chiavi compaiono `request.method`, `request.path`, `request.search` e `request.headers.x_client_info`.
- Se manca `request.search` ma c'è `request.url`, nel Passo 0.4 si sostituisce `toString(log_attributes['request.search'])` con `toString(log_attributes['request.url'])`. Le condizioni con `position(…)` restano le stesse.
- Se mancano sia `request.search` sia `request.url`, **ci si ferma**: senza il filtro sulla query string la `GET` della lista non si distingue dalle altre letture di `chat_threads`, e si avvisa il titolare con la query e il risultato.

- [ ] **0.4 — Richieste al database per una `GET` della lista (un giorno feriale intero)**

La finestra è l'ultimo giorno feriale completo, da 00:00 a 24:00 UTC. Va annotato quale. Con `query_logs`:

```sql
select
  countIf(v = 'GET'   and p = '/rest/v1/chat_threads'  and position(s, 'order=last_message_at.desc') > 0) as liste,
  countIf(v = 'GET'   and p = '/rest/v1/chat_messages' and position(s, 'select=content%2Csender_id%2Ccreated_at') > 0) as ultimi_messaggi,
  countIf(v = 'HEAD'  and p = '/rest/v1/chat_messages' and position(s, 'thread_id=eq.') > 0 and position(s, 'sender_id=neq.') > 0) as conteggi_non_letti,
  countIf(v = 'GET'   and p = '/rest/v1/conversazioni_sospensioni' and position(s, 'select=thread_id%2Csospesa_da%2Csospesa_verso%2Cmotivo%2Csospesa_il') > 0) as sospensioni,
  countIf(v = 'PATCH' and p = '/rest/v1/chat_messages' and position(s, 'delivered_at=is.null') > 0) as consegne,
  countIf(v = 'POST'  and p = '/rest/v1/rpc/chat_riepilogo_conversazioni') as riepiloghi
from (
  select toString(log_attributes['request.method']) as v,
         toString(log_attributes['request.path']) as p,
         toString(log_attributes['request.search']) as s
  from logs
  where source = 'edge_logs'
    and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
)
```

Come si leggono i numeri:
- **Le letture uniche della `GET`.** Due `select` compaiono solo in `src/app/api/chat/threads/route.ts:79` e `:118`: quella su `conversazioni_sospensioni` e l'«ultimo messaggio» su `chat_messages`. Sono le misure esatte. La lettura di `utenti` è condivisa con `tasks` e `avvisi/[id]`, e quella di `alunni` con altre route: per questo non si contano dai log.
- **`liste`** conta tutte le `GET` della lista, compresa quella che oggi parte da `useUnreadNotifications`.
- **Il rapporto da annotare.** `S12_RICHIESTE_PER_LISTA = (liste + 4·ultimi_messaggi + sospensioni) / liste + 1`. Il «+ 1» è l'`UPDATE`: uno per `GET`, per blocco di 100 thread. Le `consegne` misurate includono anche quelle di `/api/notifiche` e `chat/messages`, quindi non vanno nel rapporto.
- **Controllo di coerenza:** `conteggi_non_letti` deve stare vicino a `ultimi_messaggi`. Se ne dista più del 10 %, il filtro non è quello giusto: lo si annota e si avvisa il titolare prima di continuare.
- **`riepiloghi`** deve essere 0. Se non lo è, la funzione esiste già: vedi il Passo 0.7.

- [ ] **0.5 — Errori del realtime per giorno (client, 14 giorni)**

```sql
select giorno,
  coalesce(sum(occorrenze) filter (where messaggio = 'chat-realtime-errore: socket-chiuso-1006'), 0) as errori_1006,
  coalesce(sum(occorrenze) filter (where messaggio like 'chat-realtime-errore:%'
                                     and messaggio <> 'chat-realtime-errore: socket-chiuso-1006'), 0) as altri_errori,
  coalesce(sum(occorrenze) filter (where messaggio like 'chat-realtime-rientrato:%'), 0) as rientri,
  coalesce(sum(occorrenze) filter (where messaggio = 'chat-realtime-timeout'), 0) as timeout,
  coalesce(sum(occorrenze) filter (where messaggio like 'chat-non-letti-conteggio-fallito:%'), 0) as conteggi_falliti
from app_log
where sorgente = 'client'
  and giorno >= (now() at time zone 'utc')::date - 14
group by giorno
order by giorno;
```

E il dettaglio per gettone degli ultimi 7 giorni. I messaggi di questi log sono gettoni fissi, mai testo:

```sql
select messaggio, sum(occorrenze) as volte, count(distinct giorno) as giorni
from app_log
where sorgente = 'client'
  and (messaggio like 'chat-realtime-%' or messaggio like 'chat-non-letti-%')
  and giorno >= (now() at time zone 'utc')::date - 7
group by messaggio
order by volte desc;
```

Il 20/10 la specifica dava 288–378 errori `chat-realtime-errore%` per giorno feriale, e il rapporto 1.300 `trasporto` e 544 `socket-chiuso-1006` in 7 giorni. Annota, per i giorni feriali: errori `1006`, altri errori e rientri.

- [ ] **0.6 — I giri anticipati del dispatch per esito (server, 7 giorni)**

```sql
select giorno, contesto->'campi'->>'esito' as esito, sum(occorrenze) as volte
from app_log
where sorgente = 'server'
  and evento = 'push'
  and contesto->'campi'->>'esito' like 'dispatch-anticipato-%'
group by 1, 2
having giorno >= (now() at time zone 'utc')::date - 7
order by 1, 2;
```

Annota per giorno `avviato`, `superfluo` e `ok`. La proporzione dei `superfluo` è il «prima» del Compito 7.

- [ ] **0.7 — Lo schema: la funzione non c'è, le colonne sì, l'indice anche**

```sql
select to_regprocedure('public.chat_riepilogo_conversazioni(uuid)') as funzione_gia_presente;

select count(*) as colonne_trovate
from information_schema.columns
where table_schema = 'public'
  and (table_name::text, column_name::text) in (
    ('chat_threads','id'), ('chat_threads','teacher_id'), ('chat_threads','parent_id'),
    ('chat_threads','student_id'), ('chat_threads','last_message_at'),
    ('chat_messages','thread_id'), ('chat_messages','sender_id'), ('chat_messages','content'),
    ('chat_messages','created_at'), ('chat_messages','read_at'),
    ('utenti','id'), ('utenti','nome'), ('utenti','cognome'), ('utenti','ruolo'),
    ('utenti','first_name'), ('utenti','last_name'), ('utenti','role'),
    ('alunni','id'), ('alunni','nome'), ('alunni','cognome'), ('alunni','classe_sezione'));

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'chat_messages'
order by indexname;
```

**Soglie (ci si ferma se una non torna):**
- `funzione_gia_presente` deve essere `null`. Se non lo è, qualcuno l'ha già creata: si legge `select pg_get_functiondef('public.chat_riepilogo_conversazioni(uuid)'::regprocedure);` (§5, «Corpi delle funzioni presi dalla produzione»), ci si ferma e si porta il corpo al titolare.
- `colonne_trovate` deve essere **21**. Con meno, la guardia della migrazione salterebbe la creazione anche in produzione, e la route resterebbe per sempre sul ripiego.
- Fra gli indici ce ne deve essere uno la cui **prima** colonna è `thread_id`. Senza, ogni conversazione del riepilogo diventa una scansione: il costo per conversazione resterebbe quello di oggi, solo concentrato in una chiamata.

- [ ] **0.8 — Il costo nel database delle letture della chat**

```sql
select calls,
       round(total_exec_time)::bigint as ms_totali,
       round(mean_exec_time::numeric, 2) as ms_medi,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) as forma
from pg_stat_statements
where query ilike '%chat_threads%' or query ilike '%chat_messages%'
order by total_exec_time desc
limit 10;
```

Il testo è la forma normalizzata, con i parametri `$1`, e non contiene dati. Annota le prime cinque righe (`calls`, `ms_totali`): sono il «prima» del costo che la misura «dopo» confronterà.

---

## Compiti

Tutti i comandi partono da `/Users/lerri/kidville-web-s12-chat-leggera` (il worktree del Compito 1), salvo dove è scritto altro. Del riepilogo di vitest si legge sempre la riga `Test Files`, mai il codice d'uscita di una pipe.

### Compito 1 — Prerequisiti, worktree, chiusura della sessione precedente, decisioni

**File:**
- Modifica (Passo 6): `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la riga di stato della sessione chiusa nella specifica, lo Stato della sua voce nel PRD e gli altri file che nomina la sezione «Per la sessione dopo» del piano della sessione rilasciata per ultima. Se nessuna sessione `robustezza2/` è ancora rilasciata, nessuno.
- Modifica (Passo 7): la colonna «Note» della riga della sessione 12 nella specifica, con le risposte del titolare.

- [ ] **Passo 1: la specifica e questo piano sono su `main`?**

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo presente
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/plans/2026-10-20-robustezza2-s12-chat-leggera.md && echo presente
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep "^| 12 |"
```

Atteso: due volte `presente`, poi la riga della sessione 12, con `—` nella colonna «Dopo». Se manca un file, la PR #254 (solo documenti) non è ancora in `main`: chiedi al titolare di mergiarla prima di partire.

- [ ] **Passo 2: i prerequisiti**

La colonna «Dopo» della sessione 12 è vuota: non c'è una sessione da trovare mergiata, e resta solo il secondo controllo della specifica (§5, «Apertura di una sessione: i prerequisiti») — nessuna PR `robustezza2/` aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: nessuna riga. Se compare qualcosa, **fermati**: «una sessione alla volta» (§5). Quella sessione si chiude prima.

- [ ] **Passo 3: crea il worktree e il ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s12-chat-leggera /Users/lerri/kidville-web-s12-chat-leggera origin/main
cd /Users/lerri/kidville-web-s12-chat-leggera && git status -sb | head -3
```

Atteso: `## robustezza2/s12-chat-leggera...origin/main`, con l'albero pulito. Il nome del ramo è quello del file del piano senza la data: la sessione dopo lo usa per ritrovare questo piano.

- [ ] **Passo 4: `.env.local`**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s12-chat-leggera/.env.local
```

- [ ] **Passo 5: dipendenze**

```bash
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 6: chiudi la sessione rilasciata per ultima (prima di ogni codice)**

Quale sessione chiudere non si deduce da un numero: è la PR `robustezza2/` mergiata più di recente, esclusi i rami `-esito` (specifica §5, «Apertura di una sessione: la chiusura della precedente»).

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga, `<numero> robustezza2/sNN-<nome>`. Con l'ordine 1→14 è di solito la sessione 11, ma vale la riga stampata. **Se non stampa niente** (oppure stampa `null null`), nessuna sessione della serie è ancora rilasciata: questo passo si salta, e si va al Passo 7.

Altrimenti il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-<il ramo senza «robustezza2/»>.md`. Leggi **per intero** la sua sezione «Per la sessione dopo» (l'ultima prima dell'«Autorevisione») ed eseguila tutta, nell'ordine in cui la scrive: fotografie, voci da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) e dalle altre liste che nomina, la sua riga di stato a «in produzione» (la trovi col `grep -n "^| NN |"` che la sezione indica), il commit di `main`, la misura «dopo» se è già matura, lo Stato della sua voce nel PRD. Una misura che quella sezione dice «matura dal giorno …» la scrive la prima PR che tocca la specifica dopo quel giorno: se il giorno è passato, è questa. Il commit di `main` da scrivere:

```bash
git -C /Users/lerri/kidville-web log origin/main --oneline --grep "(#<numero stampato sopra>)" | head -1
```

La fotografia delle migrazioni si rigenera **sempre** quando la sessione chiusa aveva migrazioni, con questi comandi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql` sul progetto di produzione, in sola lettura, salva la risposta JSON in `${TMPDIR:-/tmp}/s12-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/s12-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed (1)`; le migrazioni delle sessioni rilasciate compaiono con la version del file. Le altre fotografie (indici unici, policy, chiavi esterne, tabelle per sede, bucket, schema delle candidature) si rigenerano **solo** se quella sezione le nomina, col comando che dà lei.

Poi il commit, il primo di questa sessione:

```bash
git status --short
git add -u
git status --short
git commit -m "$(cat <<'EOF'
Chiusura della sessione rilasciata per ultima, prima della sessione 12

Eseguita la sezione «Per la sessione dopo» del suo piano: fotografia delle
migrazioni rigenerata dalla produzione (e le altre che quella sezione nomina),
riga di stato a «in produzione» col commit di main, Stato della voce nel PRD.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: dopo `git add -u` ogni riga comincia con `M ` e i file sono solo quelli che la sezione nomina, più la specifica e il PRD; nessun file non tracciato nuovo.

- [ ] **Passo 7: le decisioni del titolare, prima di qualunque codice**

Chiedi al titolare le decisioni 1, 2 e 3 di «Decisioni che restano al titolare», in fondo a questo piano (specifica §7, «Sessione 12»: si chiedono al Compito 1). Il piano è scritto per il «sì» a tutte e tre. Le risposte vanno nella colonna «Note» della riga della sessione 12:

```bash
grep -n "^| 12 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola; si modifica quella, mai una riga presa per numero.

Con un «no» ci si ferma: la decisione non si riapre dentro il piano (§2). La risposta va comunque nelle «Note», si committa come qui sotto e si avvisa il titolare, che decide se rivedere prima la specifica. Il ramo porta già la chiusura della sessione precedente (Passo 6): non si cancella.

```bash
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Specifica della seconda serie: decisioni del titolare per la sessione 12

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Passo 8: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
```

Atteso: tutti i file verdi tranne, al massimo, `__tests__/architecture/offline-html-nativo.test.ts`. In un worktree nuovo quel lock è rosso perché la shell nativa non è sincronizzata, e si rilancia così:

```bash
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed (1)`. Un lock di fotografia rosso vuol dire, quasi sempre, una voce del Passo 6 saltata: rileggi quella sezione. Qualunque altro rosso va capito prima di toccare codice.

Leggi i tre contatori del lock d'isolamento come sono **adesso**, e annotali in `${TMPDIR:-/tmp}/s12-misure.env` (`S12_ROUTE_SERVICE_ROLE`, `S12_HANDLER_CONTROLLATI`, `S12_HANDLER_ESENTATI`). Servono al Compito 4:

```bash
grep -n "routeConServiceRole: \|handlerControllati: \|handlerEsentati: " __tests__/architecture/isolamento-sede-coverage.test.ts
```

Valgono i numeri letti qui, non quelli di un documento. Per orientarsi: il piano della sessione 2 li porta a 357, 555 e 107 (il 20/10 erano 363, 566 e 112); se ne trovi altri, un'altra sessione o un altro lavoro li ha cambiati, e il Compito 4 parte da quelli.

- [ ] **Passo 9: la build di partenza**

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: `✓ Compiled` e nessun `Error`. Senza heap a 8192 MB la build va in OOM su questa macchina.

---

## Migrazione

Una sola: `supabase/migrations/<S12_VERSION>_chat_riepilogo_conversazioni.sql`, con la version generata da `date -u +%Y%m%d%H%M%S` nel momento in cui si scrive il file. Così è posteriore a tutte quelle in `main`, e il lock `migrazioni-complete` («nessun file si intercala nella storia») resta verde.

- **Che cosa fa.** Crea `public.chat_riepilogo_conversazioni(p_utente uuid) RETURNS jsonb`: `LANGUAGE sql`, `STABLE`, `SECURITY INVOKER`, con `SET search_path = public, pg_temp`. Toglie `EXECUTE` a `PUBLIC`, `anon` e `authenticated` e lo dà a `service_role`. Non tocca dati, tabelle, policy né indici, e non scrive in `app_log`.
- **La guardia.** Un blocco `DO` controlla le 21 colonne lette. Se ne manca una (DB della CI non migrato), la funzione non si crea, scrive un `RAISE NOTICE`, e la route se ne accorge da `PGRST202`. Il codice regge il momento del merge (§5).
- **Chi la applica.** L'integrazione GitHub di Supabase, al merge, con la version del file. Mai `apply_migration` a mano.
- **Le guardie delle fotografie.** Nessuna la riconosce: nel testo eseguibile non ci sono `policy`, `row level security`, `drop table`, `unique`, `primary key`, `add constraint`, `references utenti`, né `scuola_id`. Quindi questa sessione non aggiunge voci a `MIGRAZIONI_ATTESE_AL_MERGE` (dopo la chiusura del Compito 1, Passo 6, di solito è `{}`), e il Compito 2 lo verifica. Dopo il merge la fotografia delle migrazioni va comunque rigenerata: la rigenera la sessione dopo, dalla sezione «Per la sessione dopo» in fondo a questo piano.
- **Prima del merge** si riconta `enrollment_submissions` (Compito 10, Passo 3).
- **ROLLBACK:** `DROP FUNCTION IF EXISTS public.chat_riepilogo_conversazioni(uuid);`, solo come migrazione nuova dentro una PR di revert (vedi «Ritorno indietro»).

### Compito 2 — La RPC di riepilogo, provata su un Postgres vero

**File:**
- Crea: `__tests__/lib/chat-riepilogo-conversazioni-sql.test.ts`
- Crea: `supabase/migrations/<S12_VERSION>_chat_riepilogo_conversazioni.sql`

- [ ] **Passo 1: scrivi il test che fallisce**

`__tests__/lib/chat-riepilogo-conversazioni-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * IL RIEPILOGO DELLE CONVERSAZIONI · LA MIGRAZIONE VERA, SU UN POSTGRES VERO.
 *
 * Robustezza 2, sessione 12 (S7). `GET /api/chat/threads` costruiva la lista con quattro letture per
 * conversazione: ~150 richieste al database con 37 conversazioni, ogni 30 s, per due orologi.
 * `public.chat_riepilogo_conversazioni(p_utente)` restituisce la stessa forma in una chiamata.
 *
 * Qui si prova che la forma è QUELLA di prima (ordine, ripieghi «?» e «unknown», non letti, ultimo
 * messaggio), che nessuno vede le conversazioni altrui (il filtro, i permessi, e la RLS come
 * seconda difesa se un GRANT sbagliato aprisse la porta), e che senza le colonne la migrazione
 * non si rompe: salta. PGlite è Postgres 17+; solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_chat_riepilogo_conversazioni.sql'))
if (!FILE) throw new Error('migrazione *_chat_riepilogo_conversazioni.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

/** uuid finti, leggibili nel rosso. */
const u = (n: number) => `f1200000-0000-4000-8000-${String(n).padStart(12, '0')}`
const D1 = u(1)
const D2 = u(2)
const G1 = u(11)
const G2 = u(12)
const A1 = u(21)
const A2 = u(22)
const T1 = u(31)
const T2 = u(32)
const T3 = u(33)
const T4 = u(34)
const NESSUNO = u(97)
const ALUNNO_FANTASMA = u(98)
const ESTRANEO = u(99)
const m = (n: number) => u(40 + n)

const RUOLO_GENERATO = `role text generated always as (
  case ruolo when 'genitore' then 'parent' when 'docente' then 'teacher' else ruolo end) stored`

/** Lo schema delle quattro tabelle lette, come in produzione. `conFirstName: false` = DB non migrato. */
async function schema(db: PGlite, { conFirstName }: { conFirstName: boolean }): Promise<void> {
  const firstName = conFirstName ? 'first_name text,' : ''
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role nologin bypassrls;

    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $uid$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $uid$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

    create table public.parents (id uuid primary key, auth_user_id uuid);
    create table public.utenti (
      id uuid primary key, nome text, cognome text, ruolo text, ${firstName} last_name text,
      ${RUOLO_GENERATO}
    );
    create table public.alunni (id uuid primary key, nome text, cognome text, classe_sezione text);
    create table public.chat_threads (
      id uuid primary key,
      teacher_id uuid not null,
      parent_id uuid not null,
      student_id uuid,
      last_message_at timestamptz,
      created_at timestamptz default now()
    );
    create table public.chat_messages (
      id uuid primary key,
      thread_id uuid not null references public.chat_threads(id),
      sender_id uuid not null,
      content text not null,
      read_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz default now()
    );
    grant select on all tables in schema public to authenticated, service_role;
  `)
}

/**
 * I dati. T1 = D1↔G1 (08:00), T2 = D1↔G2 (09:00), T3 = D2↔G2 (mai scritta), T4 = D1↔ESTRANEO con un
 * alunno che non esiste (07:00). Nomi vuoti e nulli per provare i ripieghi.
 */
async function dati(db: PGlite): Promise<void> {
  await db.exec(`
    insert into public.utenti (id, nome, cognome, ruolo, first_name, last_name) values
      ('${D1}', 'NomeD1', 'CognomeD1', 'docente', 'FirstD1', 'LastD1'),
      ('${D2}', 'NomeD2', 'CognomeD2', 'docente', null, null),
      ('${G1}', 'NomeG1', 'CognomeG1', 'genitore', 'FirstG1', ''),
      ('${G2}', '', 'CognomeG2', 'genitore', '', 'LastG2');
    insert into public.alunni (id, nome, cognome, classe_sezione) values
      ('${A1}', 'NomeA1', 'CognomeA1', 'Sez1'),
      ('${A2}', 'NomeA2', 'CognomeA2', null);
    insert into public.chat_threads (id, teacher_id, parent_id, student_id, last_message_at) values
      ('${T1}', '${D1}', '${G1}', '${A1}', '2026-10-20T08:00:00Z'),
      ('${T2}', '${D1}', '${G2}', '${A2}', '2026-10-20T09:00:00Z'),
      ('${T3}', '${D2}', '${G2}', '${A2}', null),
      ('${T4}', '${D1}', '${ESTRANEO}', '${ALUNNO_FANTASMA}', '2026-10-20T07:00:00Z');
    insert into public.chat_messages (id, thread_id, sender_id, content, read_at, delivered_at, created_at) values
      ('${m(1)}', '${T1}', '${D1}', 'testo finto 1', null, null, '2026-10-20T07:00:00Z'),
      ('${m(2)}', '${T1}', '${D1}', 'testo finto 2', null, '2026-10-20T07:15:00Z', '2026-10-20T07:10:00Z'),
      ('${m(3)}', '${T1}', '${D1}', 'testo finto 3', '2026-10-20T07:30:00Z', '2026-10-20T07:25:00Z', '2026-10-20T07:20:00Z'),
      ('${m(4)}', '${T1}', '${G1}', 'testo finto 4', null, null, '2026-10-20T08:00:00Z'),
      ('${m(5)}', '${T2}', '${G2}', 'testo finto 5', null, null, '2026-10-20T09:00:00Z');
  `)
}

type Riga = Record<string, unknown> & {
  id: string
  unread_count: number
  other_user: { first_name: string; last_name: string; role: string }
  student: { nome: string; cognome: string; classe_sezione: string | null }
  last_message: { content: string; sender_id: string; created_at: string } | null
}

async function riepilogo(db: PGlite, utente: string): Promise<Riga[]> {
  const { rows } = await db.query<{ r: Riga[] }>('select public.chat_riepilogo_conversazioni($1) as r', [utente])
  return rows[0].r
}

const perId = (righe: Riga[]) => Object.fromEntries(righe.map((r) => [r.id, r]))

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await schema(db, { conFirstName: true })
  await dati(db)
  await db.exec(MIGRAZIONE)
})

afterAll(async () => {
  await db.close()
})

describe('chat_riepilogo_conversazioni — la forma di prima, in una chiamata', () => {
  it('ordine per last_message_at decrescente, i null in testa (come `order(..., { ascending: false })`)', async () => {
    expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    expect((await riepilogo(db, G2)).map((r) => r.id)).toEqual([T3, T2])
    expect((await riepilogo(db, D1)).map((r) => r.id)).toEqual([T2, T1, T4])
    expect((await riepilogo(db, D2)).map((r) => r.id)).toEqual([T3])
    expect(await riepilogo(db, NESSUNO)).toEqual([])
  })

  it('i non letti sono i messaggi ALTRUI con read_at nullo (consegnati o no)', async () => {
    const g1 = perId(await riepilogo(db, G1))
    expect(g1[T1].unread_count).toBe(2)
    const d1 = perId(await riepilogo(db, D1))
    expect(d1[T1].unread_count).toBe(1)
    expect(d1[T2].unread_count).toBe(1)
    expect(d1[T4].unread_count).toBe(0)
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T2].unread_count, 'il proprio messaggio non è un non letto').toBe(0)
  })

  it('le chiavi sono quelle di `select(*)` più le quattro dell’arricchimento', async () => {
    const [riga] = await riepilogo(db, G1)
    expect(Object.keys(riga).sort()).toEqual([
      'created_at', 'id', 'last_message', 'last_message_at', 'other_user', 'parent_id',
      'student', 'student_id', 'teacher_id', 'unread_count',
    ])
    expect(Object.keys(riga.last_message ?? {}).sort()).toEqual(['content', 'created_at', 'sender_id'])
  })

  it('l’ultimo messaggio è il più recente del thread, e nessun messaggio vale null', async () => {
    const [t1] = await riepilogo(db, G1)
    expect(t1.last_message?.content).toBe('testo finto 4')
    expect(t1.last_message?.sender_id).toBe(G1)
    expect(Date.parse(t1.last_message?.created_at ?? '')).toBe(Date.parse('2026-10-20T08:00:00Z'))
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T3].last_message).toBeNull()
  })

  it('i ripieghi sono quelli di prima: stringa vuota e null cadono sul campo italiano, poi su «?» e «unknown»', async () => {
    const d1 = perId(await riepilogo(db, D1))
    expect(d1[T1].other_user).toEqual({ first_name: 'FirstG1', last_name: 'CognomeG1', role: 'parent' })
    expect(d1[T2].other_user).toEqual({ first_name: '?', last_name: 'LastG2', role: 'parent' })
    expect(d1[T4].other_user).toEqual({ first_name: '?', last_name: '?', role: 'unknown' })
    expect(d1[T4].student).toEqual({ nome: '?', cognome: '?', classe_sezione: '?' })
    expect(d1[T1].student).toEqual({ nome: 'NomeA1', cognome: 'CognomeA1', classe_sezione: 'Sez1' })
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T3].other_user).toEqual({ first_name: 'NomeD2', last_name: 'CognomeD2', role: 'teacher' })
    expect(g2[T3].student, 'un alunno trovato con la classe nulla resta null').toEqual({
      nome: 'NomeA2', cognome: 'CognomeA2', classe_sezione: null,
    })
  })
})

describe('chat_riepilogo_conversazioni — nessuno vede le conversazioni altrui', () => {
  it('INVOKER, search_path fisso', async () => {
    const { rows } = await db.query<{ prosecdef: boolean; proconfig: string[] }>(`
      select p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'chat_riepilogo_conversazioni'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].prosecdef).toBe(false)
    expect(rows[0].proconfig).toEqual(['search_path=public, pg_temp'])
  })

  it('EXECUTE: anon no, authenticated no, service_role sì', async () => {
    const firma = 'public.chat_riepilogo_conversazioni(uuid)'
    const { rows } = await db.query<{ anon: boolean; autenticato: boolean; servizio: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as autenticato,
              has_function_privilege('service_role', $1, 'EXECUTE') as servizio`,
      [firma],
    )
    expect(rows[0]).toEqual({ anon: false, autenticato: false, servizio: true })
  })

  it('una sessione `authenticated` non la può chiamare (42501)', async () => {
    await db.exec('begin')
    try {
      await db.exec('set local role authenticated')
      await expect(db.query('select public.chat_riepilogo_conversazioni($1)', [G1])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.exec('rollback')
    }
  })

  it('`service_role` la chiama, e il filtro restituisce solo le conversazioni di p_utente', async () => {
    await db.exec('begin')
    try {
      await db.exec('set local role service_role')
      expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    } finally {
      await db.exec('rollback')
    }
  })

  it('SECONDA DIFESA: con un GRANT sbagliato ad authenticated, la RLS di chat_threads nasconde le conversazioni altrui', async () => {
    await db.exec('begin')
    try {
      // La policy di produzione (migrazione 20261010221643, righe 171-174).
      await db.exec(`
        alter table public.chat_threads enable row level security;
        create policy chat_threads_select_participant on public.chat_threads for select to authenticated
          using ((teacher_id = (select auth.uid())) or (parent_id = (select auth.uid()))
            or (parent_id in (select parents.id from public.parents where parents.auth_user_id = (select auth.uid()))));
        grant execute on function public.chat_riepilogo_conversazioni(uuid) to authenticated;
      `)
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [G1])
      await db.exec('set local role authenticated')
      expect(await riepilogo(db, G2), 'G1 ha letto le conversazioni di G2 passando il suo id').toEqual([])
      expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    } finally {
      await db.exec('rollback')
    }
  })

  it('riapplicata, la migrazione non si rompe e non cambia niente', async () => {
    await db.exec(MIGRAZIONE)
    expect((await riepilogo(db, D1)).map((r) => r.id)).toEqual([T2, T1, T4])
  })
})

describe('chat_riepilogo_conversazioni — la guardia del DB non migrato', () => {
  it('senza `utenti.first_name` la migrazione passa e la funzione NON nasce (la route va sul ripiego)', async () => {
    const vecchio = new PGlite()
    try {
      await schema(vecchio, { conFirstName: false })
      await vecchio.exec(MIGRAZIONE)
      const { rows } = await vecchio.query<{ f: string | null }>(
        `select to_regprocedure('public.chat_riepilogo_conversazioni(uuid)')::text as f`,
      )
      expect(rows[0].f).toBeNull()
    } finally {
      await vecchio.close()
    }
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire**

```bash
npx vitest run __tests__/lib/chat-riepilogo-conversazioni-sql.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`, con l'errore `migrazione *_chat_riepilogo_conversazioni.sql non trovata`.

- [ ] **Passo 3: genera la version e scrivi la migrazione**

```bash
S12_VERSION=$(date -u +%Y%m%d%H%M%S)
echo "S12_VERSION='$S12_VERSION'" >> "${TMPDIR:-/tmp}/s12-misure.env"
echo "supabase/migrations/${S12_VERSION}_chat_riepilogo_conversazioni.sql"
```

Crea il file stampato con questo contenuto:

```sql
-- =============================================================================
-- IL RIEPILOGO DELLE CONVERSAZIONI IN UNA CHIAMATA — robustezza 2, sessione 12 (S7)
-- =============================================================================
--
-- Cosa fa
--   Crea public.chat_riepilogo_conversazioni(p_utente uuid) RETURNS jsonb: le conversazioni di
--   cui p_utente è teacher o parent, ciascuna con le colonne di chat_threads più other_user,
--   student, last_message e unread_count. È la stessa forma che GET /api/chat/threads costruiva
--   con quattro letture per conversazione (~150 richieste al database con 37 conversazioni).
--   Nessun dato, tabella, indice o permesso di tabella cambia.
--
-- Perché INVOKER e non DEFINER
--   La chiama solo la route, col client service_role, che bypassa la RLS: una funzione
--   proprietaria non aggiungerebbe niente. Con INVOKER, se un giorno qualcuno desse EXECUTE ad
--   authenticated per sbaglio, la RLS di chat_threads (solo i propri thread) resterebbe la
--   seconda difesa. E l'EXECUTE è tolto a PUBLIC, anon e authenticated.
--
-- Il filtro
--   p_utente lo passa la route dall'identità del gate (auth.user.id), mai dalla query string.
--   È lo stesso `or` di prima: teacher_id = p_utente oppure parent_id = p_utente.
--
-- I non letti
--   count(*) dei messaggi con sender_id <> p_utente e read_at nullo, come la HEAD di prima.
--   Il ripiego su un guasto non c'è più: o la chiamata riesce tutta, o la route torna al
--   percorso di prima e lo dice nei log.
--
-- La guardia
--   Se manca una delle 21 colonne lette (il DB della CI non è migrato), la funzione NON si crea
--   e resta un NOTICE. La route se ne accorge da PGRST202 e torna al percorso di prima.
--
-- Come si verifica
--   select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'chat_riepilogo_conversazioni';
--     -- prosecdef = false; proconfig = {"search_path=public, pg_temp"}
--   select has_function_privilege('anon', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE');
--     -- false, false, true
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.chat_riepilogo_conversazioni(uuid);
--   Solo come migrazione nuova dentro una PR di revert, mai applicata a mano. La funzione è
--   innocua: la route che non la chiama più non se ne accorge.
-- =============================================================================

DO $migrazione$
DECLARE
  attese constant text[] := array[
    'chat_threads.id', 'chat_threads.teacher_id', 'chat_threads.parent_id',
    'chat_threads.student_id', 'chat_threads.last_message_at',
    'chat_messages.thread_id', 'chat_messages.sender_id', 'chat_messages.content',
    'chat_messages.created_at', 'chat_messages.read_at',
    'utenti.id', 'utenti.nome', 'utenti.cognome', 'utenti.ruolo',
    'utenti.first_name', 'utenti.last_name', 'utenti.role',
    'alunni.id', 'alunni.nome', 'alunni.cognome', 'alunni.classe_sezione'
  ];
  mancanti text[];
BEGIN
  SELECT array_agg(voce ORDER BY voce) INTO mancanti
  FROM unnest(attese) AS voce
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(voce, '.', 1)
      AND c.column_name = split_part(voce, '.', 2)
  );

  IF mancanti IS NOT NULL THEN
    RAISE NOTICE 'chat_riepilogo_conversazioni non creata, colonne assenti: %', mancanti;
    RETURN;
  END IF;

  EXECUTE $def$
    CREATE OR REPLACE FUNCTION public.chat_riepilogo_conversazioni(p_utente uuid)
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = public, pg_temp
    AS $corpo$
      SELECT coalesce(
        jsonb_agg(
          to_jsonb(t) || jsonb_build_object(
            'other_user', jsonb_build_object(
              'first_name', coalesce(nullif(u.first_name::text, ''), nullif(u.nome::text, ''), '?'),
              'last_name',  coalesce(nullif(u.last_name::text, ''),  nullif(u.cognome::text, ''), '?'),
              'role',       coalesce(nullif(u.role::text, ''),       nullif(u.ruolo::text, ''), 'unknown')
            ),
            'student', CASE
              WHEN a.id IS NULL THEN jsonb_build_object('nome', '?', 'cognome', '?', 'classe_sezione', '?')
              ELSE jsonb_build_object('nome', a.nome, 'cognome', a.cognome, 'classe_sezione', a.classe_sezione)
            END,
            'last_message', ultimo.riga,
            'unread_count', non_letti.n
          )
          ORDER BY t.last_message_at DESC NULLS FIRST, t.id
        ),
        '[]'::jsonb
      )
      FROM public.chat_threads t
      LEFT JOIN public.utenti u
        ON u.id = CASE WHEN t.teacher_id = p_utente THEN t.parent_id ELSE t.teacher_id END
      LEFT JOIN public.alunni a
        ON a.id = t.student_id
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('content', m.content, 'sender_id', m.sender_id, 'created_at', m.created_at) AS riga
        FROM public.chat_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) ultimo ON true
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n
        FROM public.chat_messages m
        WHERE m.thread_id = t.id
          AND m.sender_id <> p_utente
          AND m.read_at IS NULL
      ) non_letti
      WHERE t.teacher_id = p_utente OR t.parent_id = p_utente
    $corpo$
  $def$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.chat_riepilogo_conversazioni(uuid) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.chat_riepilogo_conversazioni(uuid) TO service_role';
END
$migrazione$;
```

- [ ] **Passo 4: lancia il test**

```bash
npx vitest run __tests__/lib/chat-riepilogo-conversazioni-sql.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 passed (1)`, `Tests  12 passed (12)`.

- [ ] **Passo 5: i lock delle migrazioni e delle fotografie**

```bash
npx vitest run __tests__/architecture/ 2>&1 | tail -15
git diff --stat -- __tests__/architecture/soglia-fotografia.ts
```

Atteso: tutti verdi (con `CI=1` per `offline-html-nativo`, come al Compito 1), e nessuna modifica a `soglia-fotografia.ts`.

Se una guardia delle fotografie (`rls-per-sede`, `onconflict-arbitro`, `tracce-docente-dichiarate`) segnala la migrazione nuova, nel testo eseguibile è entrata una delle parole del paragrafo «Migrazione». Va tolta. **Non** si aggiunge una voce a `MIGRAZIONI_ATTESE_AL_MERGE` per far tacere la guardia.

- [ ] **Passo 6: commit**

```bash
git add __tests__/lib/chat-riepilogo-conversazioni-sql.test.ts "supabase/migrations/$(grep '^S12_VERSION=' "${TMPDIR:-/tmp}/s12-misure.env" | cut -d"'" -f2)_chat_riepilogo_conversazioni.sql"
git commit -m "$(cat <<'EOF'
Chat leggera: RPC chat_riepilogo_conversazioni (S7, sessione 12)

La lista delle conversazioni in una chiamata, con la forma di prima.
SECURITY INVOKER, search_path fisso, EXECUTE solo a service_role,
guardia sulle 21 colonne per il DB della CI. Provata su PGlite.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3 — La `GET` della lista usa il riepilogo, e non scrive più

**File:**
- Crea: `src/lib/chat/riepilogo-conversazioni.ts`
- Crea: `__tests__/lib/chat-riepilogo-conversazioni.test.ts`
- Crea: `__tests__/api/chat-threads-riepilogo.test.ts`
- Modifica: `src/app/api/chat/threads/route.ts:1-176`
- Modifica: `__tests__/api/chat-threads-sospensione.test.ts:35-71`
- Modifica: `__tests__/api/auth-gaps-m9.test.ts:65-86, 195-202`

- [ ] **Passo 1: il test del modulo che interpreta la risposta**

`__tests__/lib/chat-riepilogo-conversazioni.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { RPC_RIEPILOGO_ASSENTE, esitoRiepilogo } from '@/lib/chat/riepilogo-conversazioni'

const OP = 'chat/threads:GET'
const TA = 'dddddddd-0000-4000-8000-0000000000a1'

beforeEach(() => h.logEvento.mockClear())

describe('esitoRiepilogo — la risposta della RPC diventa ok, assente o guasto', () => {
  it('una lista di righe con id: ok, nessun log', () => {
    const righe = [{ id: TA, unread_count: 2 }]
    expect(esitoRiepilogo({ data: righe, error: null }, OP)).toEqual({ esito: 'ok', threads: righe })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('una lista vuota è ok (nessuna conversazione)', () => {
    expect(esitoRiepilogo({ data: [], error: null }, OP)).toEqual({ esito: 'ok', threads: [] })
  })

  it.each(['PGRST202', '42883'])('%s: la funzione non c’è → assente, riga `info` col codice', (codice) => {
    expect(RPC_RIEPILOGO_ASSENTE.has(codice)).toBe(true)
    expect(esitoRiepilogo({ data: null, error: { code: codice, message: 'x' } }, OP)).toEqual({ esito: 'assente' })
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'info', {
      operazione: OP,
      esito: 'riepilogo-non-installato',
      error_code: codice,
      ripiego: true,
    })
  })

  it.each(['57014', '42P01', '42703', 'PGRST203'])('%s: un guasto vero → guasto, riga `error` con l’errore intero', (codice) => {
    const errore = { code: codice, message: 'x' }
    expect(esitoRiepilogo({ data: null, error: errore }, OP)).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'chat',
      'error',
      { operazione: OP, esito: 'riepilogo-rpc-fallito', error_code: codice, ripiego: true },
      errore,
    )
  })

  it('un errore senza codice si dice «sconosciuto»', () => {
    esitoRiepilogo({ data: null, error: { message: 'x' } }, OP)
    expect(h.logEvento.mock.calls[0][2]).toMatchObject({ error_code: 'sconosciuto' })
  })

  it.each([
    ['un oggetto', { non: 'una lista' }],
    ['una riga senza id', [{ unread_count: 1 }]],
    ['niente del tutto', null],
  ])('forma inattesa (%s) → guasto, riga `error`', (_nome, data) => {
    expect(esitoRiepilogo({ data, error: null }, OP)).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', { operazione: OP, esito: 'riepilogo-forma-inattesa', ripiego: true })
  })
})
```

- [ ] **Passo 2: guardalo fallire**

```bash
npx vitest run __tests__/lib/chat-riepilogo-conversazioni.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 failed (1)`, `Failed to resolve import "@/lib/chat/riepilogo-conversazioni"`.

- [ ] **Passo 3: scrivi il modulo**

`src/lib/chat/riepilogo-conversazioni.ts`:

```ts
import { logEvento } from '@/lib/logging/logger';

/**
 * LA RISPOSTA DI `chat_riepilogo_conversazioni`, DECISA IN UN POSTO (robustezza 2, sessione 12 — S7).
 *
 * La RPC la chiama la route (`chat/threads:GET`), non questo modulo: il lock d'isolamento attribuisce
 * ogni `.rpc(` all'handler in cui sta scritta, e una chiamata nascosta qui finirebbe fuori dalla sua
 * vista. Qui si decide soltanto che cosa vuol dire la risposta:
 *
 *  · `ok`      — una lista di righe con `id`: la forma che la route restituisce al client;
 *  · `assente` — la funzione non c'è (`PGRST202` dalla schema cache di PostgREST, `42883` da Postgres):
 *                è il DB della CI, che non è migrato, o i minuti fra il merge e la ricarica della
 *                cache. Riga `info`, e la route torna al percorso di prima;
 *  · `guasto`  — qualunque altro errore, o una risposta di forma inattesa. Riga `error`, e la route
 *                torna lo stesso al percorso di prima: la lista delle conversazioni non si svuota
 *                per colpa del riepilogo.
 *
 * Insieme locale, sul modello di `RPC_ASSENTE` (`src/app/api/avvisi/[id]/risposte/route.ts:71`), come
 * chiede la §5 della specifica: `src/lib/db/tolleranza-schema.ts` non si allarga. `PGRST203` (due
 * funzioni con lo stesso nome) NON è «assente»: è uno schema rotto, ed esce come guasto.
 *
 * Nei log solo il codice (`error_code`, che la redazione lascia passare): mai il messaggio.
 */
export const RPC_RIEPILOGO_ASSENTE: ReadonlySet<string> = new Set(['PGRST202', '42883']);

export type RigaRiepilogo = Record<string, unknown> & { id: string };

export type EsitoRiepilogo = { esito: 'ok'; threads: RigaRiepilogo[] } | { esito: 'assente' } | { esito: 'guasto' };

function codiceDi(error: unknown): string {
    const codice = (error as { code?: unknown } | null)?.code;
    return typeof codice === 'string' && codice !== '' ? codice : 'sconosciuto';
}

function eUnaRiga(valore: unknown): valore is RigaRiepilogo {
    return typeof valore === 'object' && valore !== null && typeof (valore as { id?: unknown }).id === 'string';
}

export function esitoRiepilogo(risposta: { data: unknown; error: unknown }, operazione: string): EsitoRiepilogo {
    if (risposta.error) {
        const codice = codiceDi(risposta.error);
        if (RPC_RIEPILOGO_ASSENTE.has(codice)) {
            logEvento('chat', 'info', { operazione, esito: 'riepilogo-non-installato', error_code: codice, ripiego: true });
            return { esito: 'assente' };
        }
        logEvento('chat', 'error', { operazione, esito: 'riepilogo-rpc-fallito', error_code: codice, ripiego: true }, risposta.error);
        return { esito: 'guasto' };
    }
    if (!Array.isArray(risposta.data) || !risposta.data.every(eUnaRiga)) {
        logEvento('chat', 'error', { operazione, esito: 'riepilogo-forma-inattesa', ripiego: true });
        return { esito: 'guasto' };
    }
    return { esito: 'ok', threads: risposta.data };
}
```

- [ ] **Passo 4: il test del modulo passa**

```bash
npx vitest run __tests__/lib/chat-riepilogo-conversazioni.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 5: il test della route che fallisce**

`__tests__/api/chat-threads-riepilogo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * S7 — LA LISTA DELLE CONVERSAZIONI COSTA POCHE RICHIESTE, E NON SCRIVE (robustezza 2, sessione 12).
 *
 *  · col riepilogo installato: UNA chiamata `rpc` e UNA lettura delle sospensioni, comunque siano
 *    tante le conversazioni (prima: 3 + 4·N, cioè 151 con 37);
 *  · `p_utente` è l'id del GATE, anche se la query string ne porta un altro;
 *  · nessun UPDATE: la consegna è uscita dalla GET (`POST /api/chat/threads/consegnati`);
 *  · senza riepilogo (`PGRST202`) il percorso di prima, con una riga `info`; con un guasto, lo
 *    stesso percorso con una riga `error`.
 */

const IO = 'bbbbbbbb-0000-4000-8000-000000000c01'
const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000c02'
const DOCENTE = 'aaaaaaaa-0000-4000-8000-000000000c03'
const tid = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const N = 37

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  logEvento: vi.fn(),
  chiamate: [] as string[],
  argomentiRpc: [] as unknown[],
  rispostaRpc: { data: null, error: null } as { data: unknown; error: unknown },
  threads: [] as Record<string, unknown>[],
  sospensioni: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

const adminClient = {
  rpc(nome: string, argomenti: unknown) {
    h.chiamate.push(`rpc:${nome}`)
    h.argomentiRpc.push(argomenti)
    return Promise.resolve(h.rispostaRpc)
  },
  from(table: string) {
    h.chiamate.push(`from:${table}`)
    const b: Record<string, unknown> = {}
    for (const nome of ['select', 'or', 'eq', 'neq', 'order', 'limit', 'is', 'in']) b[nome] = () => b
    b.update = () => {
      h.chiamate.push(`update:${table}`)
      return b
    }
    b.maybeSingle = async () => ({ data: null, error: null })
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let esito: unknown = { data: null, error: null }
      if (table === 'chat_threads') esito = { data: h.threads, error: null }
      else if (table === 'conversazioni_sospensioni') esito = { data: h.sospensioni, error: null }
      else if (table === 'chat_messages') esito = { count: 0, error: null }
      return Promise.resolve(esito).then(ok, ko)
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { GET } from '@/app/api/chat/threads/route'

const richiesta = (query = '') => new Request(`http://localhost/api/chat/threads${query}`)

const rigaRiepilogo = (n: number) => ({
  id: tid(n),
  teacher_id: DOCENTE,
  parent_id: IO,
  student_id: null,
  last_message_at: null,
  other_user: { first_name: 'A', last_name: 'B', role: 'teacher' },
  student: { nome: '?', cognome: '?', classe_sezione: '?' },
  last_message: null,
  unread_count: n % 3,
})

const rigaThread = (n: number) => ({ id: tid(n), teacher_id: DOCENTE, parent_id: IO, student_id: null, last_message_at: null })

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.argomentiRpc = []
  h.sospensioni = []
  h.threads = Array.from({ length: N }, (_, i) => rigaThread(i + 1))
  h.rispostaRpc = { data: Array.from({ length: N }, (_, i) => rigaRiepilogo(i + 1)), error: null }
  h.requireUser.mockResolvedValue({ user: { id: IO, role: 'genitore', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue({ esito: 'ok', n: 0 })
})

describe('GET /api/chat/threads — col riepilogo', () => {
  it(`${N} conversazioni: una rpc e una lettura delle sospensioni, cioè ≤ 5 richieste`, async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as Array<Record<string, unknown>>
    expect(corpo).toHaveLength(N)
    expect(h.chiamate).toEqual(['rpc:chat_riepilogo_conversazioni', 'from:conversazioni_sospensioni'])
    expect(h.chiamate.length).toBeLessThanOrEqual(5)
    expect(corpo[1]).toMatchObject({ id: tid(2), unread_count: 2, sospensione: null })
  })

  it('p_utente è l’id del gate, anche con `?userId=` di un altro', async () => {
    await GET(richiesta(`?userId=${ALTRO}`))
    expect(h.argomentiRpc).toEqual([{ p_utente: IO }])
    expect(JSON.stringify(h.argomentiRpc)).not.toContain(ALTRO)
  })

  it('nessun UPDATE e nessuna consegna: la GET non scrive più', async () => {
    await GET(richiesta())
    expect(h.chiamate.some((c) => c.startsWith('update:'))).toBe(false)
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('il motivo della sospensione torna solo a chi ha sospeso', async () => {
    h.sospensioni = [
      { thread_id: tid(1), sospesa_da: IO, sospesa_verso: DOCENTE, motivo: 'motivo finto', sospesa_il: '2026-10-20T08:00:00Z' },
      { thread_id: tid(2), sospesa_da: DOCENTE, sospesa_verso: IO, motivo: 'motivo finto', sospesa_il: '2026-10-20T08:00:00Z' },
    ]
    const corpo = (await (await GET(richiesta())).json()) as Array<{ sospensione: { motivo: string | null } | null }>
    expect(corpo[0].sospensione?.motivo).toBe('motivo finto')
    expect(corpo[1].sospensione?.motivo).toBeNull()
    expect(corpo[2].sospensione).toBeNull()
  })
})

describe('GET /api/chat/threads — senza riepilogo, il percorso di prima', () => {
  it('PGRST202: le letture di prima (2 + 4·N = 150), una riga `info`, e ancora nessun UPDATE', async () => {
    h.rispostaRpc = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(N)
    expect(h.chiamate.filter((c) => c.startsWith('from:'))).toHaveLength(2 + 4 * N)
    expect(h.chiamate.some((c) => c.startsWith('update:'))).toBe(false)
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'info', expect.objectContaining({
      esito: 'riepilogo-non-installato', error_code: 'PGRST202', ripiego: true,
    }))
  })

  it('un guasto della RPC (57014): riga `error` con l’errore, e la lista arriva lo stesso', async () => {
    const errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    h.rispostaRpc = { data: null, error: errore }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(N)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', expect.objectContaining({ esito: 'riepilogo-rpc-fallito' }), errore)
  })

  it('una risposta di forma inattesa: riga `error`, e la lista arriva lo stesso', async () => {
    h.rispostaRpc = { data: { non: 'una lista' }, error: null }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', expect.objectContaining({ esito: 'riepilogo-forma-inattesa' }))
  })
})
```

- [ ] **Passo 6: guardalo fallire**

```bash
npx vitest run __tests__/api/chat-threads-riepilogo.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`. Le chiamate sono `from:chat_threads, …` invece di `rpc:…`, e `marcaConsegnati` risulta chiamata.

- [ ] **Passo 7: riscrivi la `GET`**

In `src/app/api/chat/threads/route.ts`:
- **togli** la riga 17, `import { marcaConsegnati } from '@/lib/chat/delivered';`;
- **aggiungi** dopo la riga 18 `import { esitoRiepilogo } from '@/lib/chat/riepilogo-conversazioni';`;
- **sostituisci** le righe 41-176, da `// GET /api/chat/threads` fino alla `});` che chiude la `GET`, con questo:

```ts
// GET /api/chat/threads
// Lista thread per l'utente autenticato (insegnante o genitore)
//
// S7 (robustezza 2, sessione 12): la lista arriva da `chat_riepilogo_conversazioni` in UNA chiamata,
// invece di quattro letture per conversazione (151 richieste con 37 conversazioni). Se la funzione
// manca o si guasta, il percorso di prima, con la sua riga di log (`esitoRiepilogo`). In nessuno
// dei due la GET scrive: la consegna è `POST /api/chat/threads/consegnati`.
export const GET = withRoute('chat/threads:GET', async (request: Request) => {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const userId = auth.user.id;

    try {
        const supabase = await createAdminClient();

        /**
         * Sospensioni ATTIVE (C5) in UNA sola query batched `thread_id IN (...)` — MAI una query
         * per-thread (sarebbe un N+1). Degrada pulito sul DB E2E CI non migrato (tabella assente →
         * nessuna sospensione).
         *
         * È una chiusura DENTRO l'handler, non una funzione di modulo: il lock d'isolamento attribuisce
         * ogni accesso al suo handler, e uno scritto fuori finirebbe nello span `<modulo>`.
         */
        const sospensioniAttive = async (threadIds: string[]): Promise<Map<string, SospensioneThread>> => {
            const mappa = new Map<string, SospensioneThread>();
            if (threadIds.length === 0) return mappa;
            const { data: sosp, error: sospErr } = await supabase
                .from('conversazioni_sospensioni')
                .select('thread_id, sospesa_da, sospesa_verso, motivo, sospesa_il')
                .in('thread_id', threadIds)
                .is('riaperta_il', null);
            if (sospErr) {
                // Tabella assente = nessuna sospensione. Un errore vero si logga (senza PII)
                // ma NON fa fallire la lista chat: la sospensione degrada a "nessuna".
                if (!schemaAssente(sospErr)) {
                    logEvento('chat', 'error', { operazione: 'chat/threads:GET', esito: 'sospensioni-lettura-fallita' }, sospErr);
                }
                return mappa;
            }
            for (const s of sosp ?? []) {
                const sospesaDa = s.sospesa_da as string;
                mappa.set(s.thread_id as string, {
                    sospesaDa,
                    sospesaVerso: s.sospesa_verso as string,
                    // PRIVACY: il motivo (testo libero) torna solo all'autore della sospensione.
                    motivo: userId === sospesaDa ? ((s.motivo as string | null) ?? null) : null,
                    sospesaIl: s.sospesa_il as string,
                });
            }
            return mappa;
        };

        // ── Il riepilogo: una chiamata. `p_utente` è l'identità del GATE, mai `?userId=`. ──
        const { data: righeRiepilogo, error: erroreRiepilogo } = await supabase.rpc('chat_riepilogo_conversazioni', {
            p_utente: userId,
        });
        const riepilogo = esitoRiepilogo({ data: righeRiepilogo, error: erroreRiepilogo }, 'chat/threads:GET');
        if (riepilogo.esito === 'ok') {
            const sospensioni = await sospensioniAttive(riepilogo.threads.map((t) => t.id));
            return NextResponse.json(riepilogo.threads.map((t) => ({ ...t, sospensione: sospensioni.get(t.id) ?? null })));
        }

        // ── Il RIPIEGO: il percorso di prima, per il DB della CI e per un riepilogo guasto. ──
        // Cerca thread dove l'utente è teacher o parent
        const { data: threads, error } = await supabase
            .from('chat_threads')
            .select('*')
            .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`)
            .order('last_message_at', { ascending: false });

        if (error) {
            logErrore({ operazione: 'chat/threads:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const threadIds = (threads ?? []).map((t) => t.id as string);
        const sospensioniMap = await sospensioniAttive(threadIds);

        // Le quattro letture per thread ARRICCHISCONO la lista, non la decidono: la lista è
        // `threads`, già letta e già controllata. Un dettaglio mancante non deve svuotare la
        // schermata: si degrada al ripiego («?», 0, nessun ultimo messaggio) e lo si DICE. Una riga
        // per tipo di lettura, non per thread: a database giù, quaranta thread farebbero centosessanta
        // righe uguali.
        const guastiArricchimento = new Map<string, unknown>();
        const annotaGuasto = (esito: string, err: unknown) => {
            if (err && !guastiArricchimento.has(esito)) guastiArricchimento.set(esito, err);
        };

        // Arricchisci con nomi degli interlocutori e conteggio non letti
        const enrichedThreads = await Promise.all(
            (threads ?? []).map(async (thread) => {
                // Prendi l'ultimo messaggio
                const { data: lastMsg, error: errUltimo } = await supabase
                    .from('chat_messages')
                    .select('content, sender_id, created_at')
                    .eq('thread_id', thread.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                annotaGuasto('ultimo-messaggio-non-letto', errUltimo);

                // Conta messaggi non letti (inviati dall'altro)
                const { count: unreadCount, error: errNonLetti } = await supabase
                    .from('chat_messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('thread_id', thread.id)
                    .neq('sender_id', userId)
                    .is('read_at', null);
                annotaGuasto('non-letti-non-contati', errNonLetti);

                // Prendi i nomi dalla tabella utenti
                const otherUserId = thread.teacher_id === userId ? thread.parent_id : thread.teacher_id;
                const { data: otherUser, error: errInterlocutore } = await supabase
                    .from('utenti')
                    .select('nome, cognome, ruolo, first_name, last_name, role')
                    .eq('id', otherUserId)
                    .maybeSingle();
                annotaGuasto('interlocutore-non-letto', errInterlocutore);

                const { data: student, error: errAlunno } = await supabase
                    .from('alunni')
                    .select('nome, cognome, classe_sezione')
                    .eq('id', thread.student_id)
                    .maybeSingle();
                annotaGuasto('alunno-non-letto', errAlunno);

                return {
                    ...thread,
                    other_user: otherUser
                        ? {
                            first_name: otherUser.first_name || otherUser.nome || '?',
                            last_name: otherUser.last_name || otherUser.cognome || '?',
                            role: otherUser.role || otherUser.ruolo || 'unknown',
                        }
                        : { first_name: '?', last_name: '?', role: 'unknown' },
                    student: student ?? { nome: '?', cognome: '?', classe_sezione: '?' },
                    last_message: lastMsg ?? null,
                    unread_count: unreadCount ?? 0,
                    sospensione: sospensioniMap.get(thread.id as string) ?? null,
                };
            })
        );

        for (const [esito, err] of guastiArricchimento) {
            guastoLetturaAccessoria('chat', 'chat/threads:GET', esito, err);
        }

        return NextResponse.json(enrichedThreads);
    } catch (error) {
        logErrore({ operazione: 'chat/threads:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
```

Il percorso di ripiego è quello di prima, riga per riga, meno le righe 66-70 (`marcaConsegnati`). Il blocco delle sospensioni (72-100) è diventato `sospensioniAttive`, con la stessa logica.

- [ ] **Passo 8: i due test esistenti che costruiscono il client a mano**

Il loro client finto non ha `rpc`: la `GET` lancerebbe `TypeError` e risponderebbe 500. Ricevono una `rpc` che risponde `PGRST202`, e così continuano a provare il percorso di prima, che è il loro oggetto.

In `__tests__/api/chat-threads-sospensione.test.ts`, dentro `const adminClient = { … }`, aggiungi prima di `from(table: string) {`:

```ts
  // S7: senza riepilogo installato. Questo file prova il percorso di PRIMA (le sospensioni batched).
  rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'funzione assente' } }),
```

In `__tests__/api/auth-gaps-m9.test.ts`, dentro la factory di `vi.mock('@/lib/supabase/server-client', …)`:
- prima di `return {`, aggiungi:

```ts
  // S7: la GET della chat chiama prima il riepilogo. Qui risponde «non installato» (PGRST202), e si
  // registra la chiamata per provare che riceve l'id del gate.
  const rpcNonInstallata = async (nome: string, argomenti: unknown) => {
    h.calls.push(['rpc', nome, argomenti])
    return { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
  }
```

- e cambia `createAdminClient: async () => ({ from: builder }),` in `createAdminClient: async () => ({ from: builder, rpc: rpcNonInstallata }),`.

Nel test `chat/threads GET filtra i thread con l'id del gate, mai con quello in query` (righe 195-202), aggiungi prima della `})` che lo chiude:

```ts
    const rpcCall = h.calls.find(([t]) => t === 'rpc')
    expect(JSON.stringify(rpcCall)).toContain(UUID_A)
    expect(JSON.stringify(rpcCall)).not.toContain(UUID_B)
```

- [ ] **Passo 9: tutti i test della route, e i tipi**

```bash
npx vitest run __tests__/api/chat-threads-riepilogo.test.ts __tests__/api/chat-threads-sospensione.test.ts __tests__/api/auth-gaps-m9.test.ts __tests__/lib/chat-riepilogo-conversazioni.test.ts 2>&1 | tail -10
npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  4 passed (4)` due volte, e `tsc` senza output. Il lock d'isolamento non cambia: `chat/threads:GET` è già in `AMMESSE` (riga 1075), e la chiusura `sospensioniAttive` resta nel suo span.

- [ ] **Passo 10: commit**

```bash
git add src/lib/chat/riepilogo-conversazioni.ts __tests__/lib/chat-riepilogo-conversazioni.test.ts src/app/api/chat/threads/route.ts __tests__/api/chat-threads-riepilogo.test.ts __tests__/api/chat-threads-sospensione.test.ts __tests__/api/auth-gaps-m9.test.ts
git commit -m "$(cat <<'EOF'
Chat leggera: la GET della lista usa il riepilogo e non scrive più (S7)

Una rpc e una lettura delle sospensioni al posto di 3 + 4·N richieste.
Ripiego sul percorso di prima con PGRST202/42883 (info) e con un
guasto (error). L'UPDATE di delivered_at esce dalla GET.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — La consegna esplicita: `POST /api/chat/threads/consegnati`

**File:**
- Crea: `src/app/api/chat/threads/consegnati/route.ts`
- Crea: `__tests__/api/chat-threads-consegnati.test.ts`
- Modifica: `__tests__/architecture/isolamento-sede-coverage.test.ts` (voce subito dopo `'chat/threads:GET': 'scope conversazione…` in `AMMESSE`; i contatori `routeConServiceRole`, `handlerControllati`, `handlerEsentati`, trovati per nome: la sessione 2 cambia lo stesso file e sposta le righe del 20/10, 1075, 2530, 2825 e 3200)
- Modifica: `src/app/api/notifiche/route.ts:65-69` (commento)

- [ ] **Passo 1: il test che fallisce**

`__tests__/api/chat-threads-consegnati.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * S7 — LA CONSEGNA DEI MESSAGGI È UNA RICHIESTA A SÉ (robustezza 2, sessione 12).
 *
 * Prima la faceva `GET /api/chat/threads` a ogni giro: una lettura che scriveva. Adesso la pagina
 * la chiede quando la lista mostra non letti nuovi. Le garanzie restano quelle di prima: i thread
 * sono quelli di cui si è teacher o parent, con l'id del GATE; il corpo non porta niente.
 */

const IO = 'bbbbbbbb-0000-4000-8000-000000000d01'
const TA = 'dddddddd-0000-4000-8000-000000000d0a'
const TB = 'dddddddd-0000-4000-8000-000000000d0b'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  logErrore: vi.fn(),
  chiamate: [] as string[],
  filtriOr: [] as string[],
  righe: [] as Array<{ id: string }>,
  errore: null as null | { code: string; message: string },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))

const adminClient = {
  from(table: string) {
    h.chiamate.push(`from:${table}`)
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.or = (filtro: string) => {
      h.filtriOr.push(filtro)
      return b
    }
    b.update = () => {
      h.chiamate.push(`update:${table}`)
      return b
    }
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(h.errore ? { data: null, error: h.errore } : { data: h.righe, error: null }).then(ok, ko)
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/threads/consegnati/route'

const richiesta = (corpo: unknown = {}) =>
  new Request('http://localhost/api/chat/threads/consegnati', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.filtriOr = []
  h.righe = [{ id: TA }, { id: TB }]
  h.errore = null
  h.requireUser.mockResolvedValue({ user: { id: IO, role: 'genitore', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue({ esito: 'ok', n: 0 })
})

describe('POST /api/chat/threads/consegnati', () => {
  it('senza sessione: 401, e nessuna lettura', async () => {
    h.requireUser.mockResolvedValue({ response: Response.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await POST(richiesta())
    expect(res.status).toBe(401)
    expect(h.chiamate).toEqual([])
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('consegna sui thread di cui si è teacher o parent, con l’id del gate e senza limite temporale', async () => {
    const res = await POST(richiesta())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consegna: 'ok' })
    expect(h.filtriOr).toEqual([`teacher_id.eq.${IO},parent_id.eq.${IO}`])
    expect(h.marcaConsegnati).toHaveBeenCalledTimes(1)
    expect(h.marcaConsegnati.mock.calls[0][1]).toEqual({ userId: IO, threadIds: [TA, TB] })
    expect(h.chiamate.some((c) => c.startsWith('update:')), 'l’UPDATE lo fa marcaConsegnati, non la route').toBe(false)
  })

  it('zero conversazioni: nessuna scrittura', async () => {
    h.righe = []
    const res = await POST(richiesta())
    expect(await res.json()).toEqual({ consegna: 'ok' })
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('la lettura dei thread fallisce: 500 LETTURA_FALLITA, e il guasto è loggato', async () => {
    h.errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(richiesta())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
    expect(h.logErrore).toHaveBeenCalledWith(
      { operazione: 'chat/threads/consegnati:POST', stato: 500, evento: 'db:chat_threads' },
      h.errore,
    )
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('il corpo non può portare niente: 400, nessuna lettura', async () => {
    const res = await POST(richiesta({ threadIds: [TA] }))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
  })

  it('l’UPDATE si ferma a metà: 200 con `fermati` (il guasto lo registra marcaConsegnati)', async () => {
    h.marcaConsegnati.mockResolvedValue({ esito: 'fermati', n: 0 })
    const res = await POST(richiesta())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consegna: 'fermati' })
  })
})
```

- [ ] **Passo 2: guardalo fallire**

```bash
npx vitest run __tests__/api/chat-threads-consegnati.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 failed (1)`, `Failed to resolve import "@/app/api/chat/threads/consegnati/route"`.

- [ ] **Passo 3: scrivi la route**

`src/app/api/chat/threads/consegnati/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { rispostaGuastoDb } from '@/lib/db/guasto';
import { marcaConsegnati } from '@/lib/chat/delivered';

/**
 * LA CONSEGNA ESPLICITA DEI MESSAGGI DELLA CHAT (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 la faceva `GET /api/chat/threads`: ogni apertura della lista, e ogni giro dei due
 * orologi della pagina chat, finiva con un UPDATE di `delivered_at` su TUTTI i thread dell'utente.
 * Una lettura che scriveva, ogni 30 s, anche quando non c'era niente da consegnare.
 *
 * Adesso la pagina la chiede solo quando la lista mostra non letti nuovi (`serveConsegna`, in
 * `@/lib/chat/consegna-conversazioni`). Il lavoro è quello di prima, con le stesse garanzie:
 *  · l'identità è quella del GATE, mai un dato del client: il corpo deve essere `{}`;
 *  · i thread sono quelli di cui si è teacher o parent, letti qui con lo stesso `or` della lista;
 *  · nessun limite temporale (`creatiFinoA` assente), come faceva la lista.
 *
 * I LOG. `withRoute` registra la richiesta. Un guasto della lettura dei thread è un 500 con
 * `logErrore` (`rispostaGuastoDb`). Un guasto dell'UPDATE lo registra `marcaConsegnati`, e la
 * risposta dice `fermati`. Nessuna riga persistita per il successo: la consegna non è fra gli eventi
 * critici, e la sua prova è la doppia spunta che il mittente vede.
 */
const bodySchema = z.object({}).strict();

export const POST = withRoute('chat/threads/consegnati:POST', async (request: Request) => {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const corpo = await parseBody(request, bodySchema);
    if ('response' in corpo) return corpo.response;

    const userId = auth.user.id;
    const supabase = await createAdminClient();

    const { data: righe, error } = await supabase
        .from('chat_threads')
        .select('id')
        .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`);
    if (error) return rispostaGuastoDb('chat/threads/consegnati:POST', 'db:chat_threads', error);

    const threadIds = (righe ?? []).map((r) => r.id as string);
    if (threadIds.length === 0) return NextResponse.json({ consegna: 'ok' });

    const esito = await marcaConsegnati(supabase, { userId, threadIds });
    return NextResponse.json({ consegna: esito.esito });
});
```

- [ ] **Passo 4: il test passa**

```bash
npx vitest run __tests__/api/chat-threads-consegnati.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 5: il lock d'isolamento, prima rosso**

```bash
npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts 2>&1 | grep -E "chat/threads/consegnati|Expected|Received|Test Files" | head -20
```

Atteso: rosso. Fra le violazioni compare `chat/threads/consegnati:POST`, e i tre contatori (`routeConServiceRole`, `handlerControllati`, `handlerEsentati`) cambiano. Annota i valori «Received».

- [ ] **Passo 6: la voce in `AMMESSE` e i contatori (decisione 1 del titolare)**

Trova per contenuto la voce della `GET` della lista dentro `AMMESSE` (il 20/10 era la riga 1075; la sessione 2 toglie altre voci dallo stesso oggetto e i numeri cambiano):

```bash
grep -n "'chat/threads:GET': 'scope conversazione" __tests__/architecture/isolamento-sede-coverage.test.ts
```

Atteso: una riga, `'chat/threads:GET': 'scope conversazione: solo i thread di cui si è teacher o parent',`. Subito dopo quella riga aggiungi:

```ts
    // S7, robustezza 2 sessione 12 (2026-10-20): l'UPDATE di `delivered_at` è uscito da
    // `chat/threads:GET` ed è diventato questa richiesta. Stesso scope della GET, riga per riga:
    // i thread di cui si è teacher o parent, con l'id del gate; il corpo è `{}`.
    'chat/threads/consegnati:POST': 'scope conversazione: si consegnano solo i messaggi dei thread di cui si è teacher o parent',
```

Ognuno dei tre contatori sale **di 1** rispetto al valore letto e annotato al Compito 1, Passo 8 (`S12_ROUTE_SERVICE_ROLE`, `S12_HANDLER_CONTROLLATI`, `S12_HANDLER_ESENTATI`): rileggili adesso, prima di scrivere, con `grep -n "S12_ROUTE_SERVICE_ROLE\|S12_HANDLER_" "${TMPDIR:-/tmp}/s12-misure.env"`. Con i numeri che la sessione 2 lascia sarebbe 357 → 358, 555 → 556, 107 → 108, ma vale il valore letto, non questo esempio. Il nuovo valore deve coincidere con il «Received» del Passo 5. Se un contatore si muove di più o di meno di 1, **ci si ferma**: la route tocca qualcosa che il piano non ha previsto.

I tre contatori si trovano per nome (`grep -n "routeConServiceRole: \|handlerControllati: \|handlerEsentati: " __tests__/architecture/isolamento-sede-coverage.test.ts`), non per numero di riga. Sopra ciascuno aggiungi una riga di commento:
- sopra `routeConServiceRole:` → `// {valore} → {valore + 1} il {data}: \`chat/threads/consegnati\` (S7, robustezza 2 sessione 12).`
- sopra `handlerControllati:` → `// {valore} → {valore + 1} il {data}: \`chat/threads/consegnati:POST\` (vedi sopra).`
- sopra `handlerEsentati:` → `// {valore} → {valore + 1} il {data}: ENTRA \`chat/threads/consegnati:POST\`. Non è un pezzo di lock tolto: è l'UPDATE uscito da \`chat/threads:GET\` (già esentata, stesso scope) per diventare una richiesta a sé. Decisione del titolare, piano della sessione 12.`

I valori fra graffe sono quelli misurati e la data è quella del giorno.

```bash
npx vitest run __tests__/architecture/ 2>&1 | tail -10
```

Atteso: tutti verdi (con `CI=1` per `offline-html-nativo`).

- [ ] **Passo 7: il commento di `/api/notifiche` che citava la lista**

In `src/app/api/notifiche/route.ts` sostituisci le righe 65-69, da `* L'unica eccezione sono le righe NATE PRIMA della colonna,` fino a `* niente.`, con:

```ts
 * L'unica eccezione sono le righe NATE PRIMA della colonna, già lette e mai consegnate: con zero
 * non letti questa GET non le tocca (se ce n'è almeno uno, l'UPDATE sui thread le prende insieme
 * alle altre). Fino al 2026-10-20 la doppia spunta gliela metteva comunque l'apertura della lista
 * chat; dalla sessione 12 di robustezza 2 la lista non scrive più, e la consegna senza limite
 * temporale è `POST /api/chat/threads/consegnati`, che la pagina chat chiede solo quando ci sono non
 * letti. Sono messaggi che il destinatario ha già letto: nessuno aspetta più niente.
```

- [ ] **Passo 8: commit**

```bash
git add src/app/api/chat/threads/consegnati/route.ts __tests__/api/chat-threads-consegnati.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts src/app/api/notifiche/route.ts
git commit -m "$(cat <<'EOF'
Chat leggera: la consegna esplicita, POST /api/chat/threads/consegnati (S7)

L'UPDATE di delivered_at uscito dalla GET della lista. Corpo vuoto,
identità del gate, stessi thread della lista. Una voce in AMMESSE con
lo scope della GET; i tre contatori del lock salgono di 1.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — Tre moduli per il client: la lista, l'annuncio, la consegna

**File:**
- Crea: `src/lib/chat/lista-conversazioni.ts`, `__tests__/lib/chat-lista-conversazioni.test.ts`
- Crea: `src/lib/chat/annuncio-non-letti.ts`, `__tests__/lib/chat-annuncio-non-letti.test.ts`
- Crea: `src/lib/chat/consegna-conversazioni.ts`, `__tests__/lib/chat-consegna-conversazioni.test.ts`

Sono funzioni di modulo senza stato React, così il hook (Compito 6) non ha bisogno di `try`. Sono moduli separati da `useUnreadNotifications` per un motivo preciso: cinque test di pagina sostituiscono quel file con una factory che espone solo `useUnreadNotifications`, e un nome nuovo importato da lì li farebbe esplodere.

- [ ] **Passo 1: i tre test che falliscono**

`__tests__/lib/chat-lista-conversazioni.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/logging/client', () => ({
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { scaricaListaConversazioni } from '@/lib/chat/lista-conversazioni'

const IO = 'aaaaaaaa-0000-4000-8000-0000000000e1'

function rispondi(risposta: Partial<Response> | Error) {
  const f = vi.fn(async (_url: string) => {
    if (risposta instanceof Error) throw risposta
    return risposta as Response
  })
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('scaricaListaConversazioni — un esito, mai un rifiuto', () => {
  it('una lista: { lista }, con l’URL di prima', async () => {
    const f = rispondi({ ok: true, status: 200, json: async () => [{ id: 'th-a' }] })
    expect(await scaricaListaConversazioni(IO)).toEqual({ lista: [{ id: 'th-a' }] })
    expect(f).toHaveBeenCalledWith(`/api/chat/threads?userId=${IO}`)
  })

  it.each([500, 401])('HTTP %i: { guasto: http-<stato>, http }', async (stato) => {
    rispondi({ ok: false, status: stato, json: async () => ({}) })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: `http-${stato}`, http: stato })
  })

  it('rete giù: la classe dell’errore, mai il messaggio (che porta l’URL con l’id)', async () => {
    rispondi(new TypeError(`Failed to fetch /api/chat/threads?userId=${IO}`))
    const esito = await scaricaListaConversazioni(IO)
    expect(esito).toEqual({ guasto: 'TypeError', http: null })
    expect(JSON.stringify(esito)).not.toContain(IO)
  })

  it('corpo che non è JSON: SyntaxError', async () => {
    rispondi({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: 'SyntaxError', http: null })
  })

  it('JSON che non è una lista: forma-inattesa', async () => {
    rispondi({ ok: true, status: 200, json: async () => ({ error: 'x' }) })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: 'forma-inattesa', http: null })
  })
})
```

`__tests__/lib/chat-annuncio-non-letti.test.ts`. I casi vengono da `useUnreadNotifications-riservatezza.test.tsx` e `useUnreadNotifications-clic-notifica.test.tsx`, che il Compito 6 toglie:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL TOTALE DEI NON LETTI, IL TITOLO DELLA PAGINA E LA NOTIFICA DEL BROWSER (S7, sessione 12).
 *
 * Era `useUnreadNotifications`, con un suo orologio e una sua GET della lista. Ora è una funzione che
 * lavora sulla lista già scaricata da `useConversazioneChat`. Le decisioni di prima restano, e
 * restano provate qui:
 *  · RISERVATEZZA (spec 2026-09-24, W1): il titolo è SEMPRE «Nuovo messaggio in chat», senza testo,
 *    senza nome, senza conteggio, e senza `body`;
 *  · CLIC (2026-09-15): porta davanti la finestra e apre la conversazione più recente con non letti;
 *  · nessuna notifica a pagina a fuoco, a permesso negato, o se il totale non è salito;
 *  · il costruttore che lancia (Chrome Android) si registra col solo nome dell'errore.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { TITOLO_NOTIFICA_CHAT, annunciaNonLetti, totaleNonLetti } from '@/lib/chat/annuncio-non-letti'
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread'

const A = 'dddddddd-0000-4000-8000-0000000000a1'
const B = 'dddddddd-0000-4000-8000-0000000000b2'
const C = 'dddddddd-0000-4000-8000-0000000000c3'

/** Segnaposti riconoscibili: se compaiono in una notifica, il dato è trapelato. */
const NOME = 'NomeSegnaposto'
const TESTO = 'testo segnaposto del messaggio riservato'

class NotificaFinta {
  static permission: NotificationPermission = 'granted'
  static create: NotificaFinta[] = []
  static lancia: Error | null = null
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public titolo: string,
    public opzioni?: NotificationOptions,
  ) {
    if (NotificaFinta.lancia) throw NotificaFinta.lancia
    NotificaFinta.create.push(this)
  }
}

const riga = (id: string, nonLetti: number) => ({
  id,
  unread_count: nonLetti,
  other_user: { first_name: NOME, last_name: NOME },
  last_message: { content: TESTO },
})

const aSchermo = (n: NotificaFinta) => JSON.stringify({ titolo: n.titolo, opzioni: n.opzioni ?? null })

const pagineMontate: Array<() => void> = []
let focus: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  NotificaFinta.create = []
  NotificaFinta.lancia = null
  NotificaFinta.permission = 'granted'
  vi.stubGlobal('Notification', NotificaFinta)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  document.title = 'prima del giro'
  h.logClient.mockClear()
})

afterEach(() => {
  while (pagineMontate.length) pagineMontate.pop()!()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('totaleNonLetti', () => {
  it('somma solo i numeri finiti e positivi', () => {
    expect(totaleNonLetti([riga(A, 2), riga(B, 3)])).toBe(5)
    expect(totaleNonLetti([{ id: A, unread_count: -1 }, { id: B, unread_count: Number.NaN }, { id: C, unread_count: null }, { id: 'x' }])).toBe(0)
  })
})

describe('annunciaNonLetti — riservatezza', () => {
  it('un messaggio nuovo: «Nuovo messaggio in chat», nessun corpo, né nome né testo, tag di prima', () => {
    expect(annunciaNonLetti([riga(A, 1)], 0)).toBe(1)
    expect(NotificaFinta.create).toHaveLength(1)
    const n = NotificaFinta.create[0]
    expect(n.titolo).toBe(TITOLO_NOTIFICA_CHAT)
    expect(n.titolo).toBe('Nuovo messaggio in chat')
    expect(n.opzioni?.body).toBeUndefined()
    expect(aSchermo(n)).not.toContain(NOME)
    expect(aSchermo(n)).not.toContain('segnaposto')
    expect(n.opzioni?.tag).toBe('kidville-chat')
  })

  it('più conversazioni: lo stesso titolo, senza conteggio', () => {
    annunciaNonLetti([riga(A, 2), riga(B, 3)], 0)
    expect(NotificaFinta.create).toHaveLength(1)
    expect(aSchermo(NotificaFinta.create[0])).not.toMatch(/\d+ nuovi messaggi/)
  })
})

describe('annunciaNonLetti — quando NON parte', () => {
  it('il totale non è salito: nessuna notifica, ma il titolo sì', () => {
    expect(annunciaNonLetti([riga(A, 3)], 3)).toBe(3)
    expect(NotificaFinta.create).toHaveLength(0)
    expect(document.title).toBe('(3) Kidville')
  })

  it('nessun non letto: titolo «Kidville», nessuna notifica', () => {
    expect(annunciaNonLetti([riga(A, 0)], 0)).toBe(0)
    expect(document.title).toBe('Kidville')
    expect(NotificaFinta.create).toHaveLength(0)
  })

  it('pagina a fuoco: nessuna notifica', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    annunciaNonLetti([riga(A, 1)], 0)
    expect(NotificaFinta.create).toHaveLength(0)
    expect(document.title).toBe('(1) Kidville')
  })

  it('permesso negato: nessuna notifica', () => {
    NotificaFinta.permission = 'denied'
    annunciaNonLetti([riga(A, 1)], 0)
    expect(NotificaFinta.create).toHaveLength(0)
  })

  it('il costruttore lancia: warn «push» col solo nome dell’errore', () => {
    NotificaFinta.lancia = new TypeError(`Illegal constructor ${TESTO}`)
    annunciaNonLetti([riga(A, 1)], 0)
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'push',
      messaggio: 'chat-notifica-browser-non-mostrata: TypeError',
    })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('segnaposto')
  })
})

describe('annunciaNonLetti — il clic e la chiusura', () => {
  it('il clic porta davanti la finestra e apre la più recente con non letti', () => {
    const pagina = vi.fn()
    pagineMontate.push(ascoltaAperturaThread(pagina))
    annunciaNonLetti([riga(A, 0), riga(B, 2), riga(C, 1)], 0)
    const n = NotificaFinta.create[0]
    n.onclick!()
    expect(pagina.mock.calls).toEqual([[B]])
    expect(focus).toHaveBeenCalledTimes(1)
    expect(n.close).toHaveBeenCalled()
  })

  it('senza una pagina chat in ascolto il clic porta solo la finestra davanti, senza errori né log', () => {
    annunciaNonLetti([riga(A, 1)], 0)
    const n = NotificaFinta.create[0]
    expect(() => n.onclick!()).not.toThrow()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('si chiude da sola dopo 5 s', () => {
    vi.useFakeTimers()
    annunciaNonLetti([riga(A, 1)], 0)
    const n = NotificaFinta.create[0]
    vi.advanceTimersByTime(4_999)
    expect(n.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(n.close).toHaveBeenCalledTimes(1)
  })
})
```

`__tests__/lib/chat-consegna-conversazioni.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { URL_CONSEGNA, fotografiaNonLetti, inviaConsegna, serveConsegna } from '@/lib/chat/consegna-conversazioni'

const riga = (id: string, nonLetti: number, ultimo = '2026-10-20T08:00:00.000Z') => ({
  id,
  unread_count: nonLetti,
  last_message_at: ultimo,
})

beforeEach(() => h.logClient.mockClear())
afterEach(() => vi.unstubAllGlobals())

describe('serveConsegna — solo quando la lista mostra non letti NUOVI', () => {
  it('prima lista con non letti: sì; senza: no', () => {
    expect(serveConsegna(null, [riga('a', 1), riga('b', 0)])).toBe(true)
    expect(serveConsegna(null, [riga('a', 0)])).toBe(false)
  })

  it('la stessa lista di prima: no', () => {
    const lista = [riga('a', 2), riga('b', 0)]
    expect(serveConsegna(fotografiaNonLetti(lista), lista)).toBe(false)
  })

  it('un thread con non letti cambia impronta (più non letti, o un messaggio più recente): sì', () => {
    const prima = fotografiaNonLetti([riga('a', 2)])
    expect(serveConsegna(prima, [riga('a', 3)])).toBe(true)
    expect(serveConsegna(prima, [riga('a', 2, '2026-10-20T08:05:00.000Z')])).toBe(true)
  })

  it('un thread passa a zero: no (non c’è niente da consegnare)', () => {
    expect(serveConsegna(fotografiaNonLetti([riga('a', 2)]), [riga('a', 0, '2026-10-20T08:05:00.000Z')])).toBe(false)
  })

  it('un thread nuovo con non letti: sì', () => {
    expect(serveConsegna(fotografiaNonLetti([riga('a', 0)]), [riga('a', 0), riga('n', 1)])).toBe(true)
  })
})

describe('inviaConsegna — una POST con corpo vuoto, che non rifiuta mai', () => {
  it('va all’URL della consegna, con `{}`; una risposta ok non logga', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }) as Response)
    vi.stubGlobal('fetch', f)
    await inviaConsegna('/parent/chat')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(URL_CONSEGNA)
    expect(URL_CONSEGNA).toBe('/api/chat/threads/consegnati')
    const verbo = init?.method
    expect(verbo).toBe('POST')
    expect(init?.body).toBe('{}')
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('una risposta non ok: warn con lo stato (il livello finale lo decide `livelloEvento`)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response))
    await inviaConsegna('/teacher/chat')
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'chat-consegna-non-riuscita: http-500',
      route: '/teacher/chat',
      stato: 500,
    })
  })

  it('rete giù: warn con la classe dell’errore, e la promessa si risolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(inviaConsegna('/parent/chat')).resolves.toBeUndefined()
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'chat-consegna-non-riuscita: TypeError',
      route: '/parent/chat',
    })
  })
})
```

- [ ] **Passo 2: guardali fallire**

```bash
npx vitest run __tests__/lib/chat-lista-conversazioni.test.ts __tests__/lib/chat-annuncio-non-letti.test.ts __tests__/lib/chat-consegna-conversazioni.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  3 failed (3)`, tutti con `Failed to resolve import`.

- [ ] **Passo 3: scrivi i tre moduli**

`src/lib/chat/lista-conversazioni.ts`:

```ts
import { nomeErrore } from '@/lib/logging/client';

/**
 * LA GET DELLA LISTA DELLE CONVERSAZIONI, COME ESITO (robustezza 2, sessione 12 — S7).
 *
 * Non rifiuta mai: restituisce la lista o il perché del guasto, come gettone (`http-<stato>`, la
 * classe dell'errore, `forma-inattesa`). Mai il `.message`: per una rete giù contiene l'URL con l'id.
 * Così chi la usa (`useConversazioneChat`) non ha bisogno di un `try`, e il compilatore di React non
 * ha un motivo per rinunciare al hook.
 *
 * `http` distingue chi ha risposto (il server, con il suo stato) da chi non ha risposto affatto
 * (`null`: rete, corpo illeggibile, forma inattesa). Il primo caso lo registra già il `fetch`
 * strumentato di `@/lib/logging/client`, con il livello di `livelloFetch`.
 *
 * L'URL è quello di prima, con `?userId=` che il server ignora: i test di pagina lo riconoscono così.
 */
export type EsitoListaConversazioni<T> = { lista: T[] } | { guasto: string; http: number | null };

export function scaricaListaConversazioni<T>(userId: string): Promise<EsitoListaConversazioni<T>> {
    return fetch(`/api/chat/threads?userId=${userId}`).then(
        (res): EsitoListaConversazioni<T> | Promise<EsitoListaConversazioni<T>> => {
            if (!res.ok) return { guasto: `http-${res.status}`, http: res.status };
            return res.json().then(
                (data: unknown): EsitoListaConversazioni<T> =>
                    Array.isArray(data) ? { lista: data as T[] } : { guasto: 'forma-inattesa', http: null },
                (err: unknown): EsitoListaConversazioni<T> => ({ guasto: nomeErrore(err), http: null }),
            );
        },
        (err: unknown): EsitoListaConversazioni<T> => ({ guasto: nomeErrore(err), http: null }),
    );
}
```

`src/lib/chat/annuncio-non-letti.ts`:

```ts
import { richiediAperturaThread } from '@/lib/chat/apertura-thread';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * IL TOTALE DEI NON LETTI, IL TITOLO DELLA PAGINA E LA NOTIFICA DEL BROWSER (robustezza 2, sessione 12).
 *
 * Fino al 2026-10-20 stava in `useUnreadNotifications`, che aveva un SUO orologio e scaricava la
 * stessa lista di `useConversazioneChat`: due GET identiche ogni 30 s. Adesso è una funzione che
 * lavora sulla lista che il hook ha appena applicato. Il comportamento è quello di prima.
 */

/**
 * Il testo della notifica del browser (decisione del titolare, spec 2026-09-24 «sei interventi»):
 * SEMPRE questo, senza il testo del messaggio né il nome del mittente. La notifica compare sullo
 * schermo di un computer che altri possono guardare (la scrivania della segreteria, il PC di casa):
 * il contenuto di una chat fra famiglia e scuola non ci deve comparire. Resta in italiano, come prima.
 */
export const TITOLO_NOTIFICA_CHAT = 'Nuovo messaggio in chat';
export const TITOLO_PAGINA = 'Kidville';
const CHIUSURA_NOTIFICA_MS = 5_000;

/** Della riga di `/api/chat/threads` qui servono SOLO l'id e i non letti. */
export interface ThreadNonLetti {
    id: string;
    unread_count?: number | null;
}

function nonLettiDi(t: ThreadNonLetti): number {
    const n = t.unread_count;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function totaleNonLetti(threads: readonly ThreadNonLetti[]): number {
    return threads.reduce((somma, t) => somma + nonLettiDi(t), 0);
}

/**
 * Aggiorna il titolo, e manda la notifica del browser se il totale è SALITO rispetto a `precedente`
 * (l'ultimo totale annunciato). Restituisce il totale, che il chiamante conserva per il giro dopo.
 * Non lancia mai.
 */
export function annunciaNonLetti(threads: readonly ThreadNonLetti[], precedente: number): number {
    const totale = totaleNonLetti(threads);
    if (totale > precedente) mandaNotificaBrowser(threads);
    aggiornaTitolo(totale);
    return totale;
}

function mandaNotificaBrowser(threads: readonly ThreadNonLetti[]): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Non notificare se la pagina è in primo piano.
    if (document.hasFocus()) return;

    // La conversazione più recente con non letti: serve solo al clic.
    const conNonLetti = threads.find((t) => nonLettiDi(t) > 0);

    try {
        // Nessun `body`: il testo del messaggio non compare, e nemmeno un conteggio o un nome.
        const notifica = new Notification(TITOLO_NOTIFICA_CHAT, {
            icon: '/favicon.ico',
            tag: 'kidville-chat',
            requireInteraction: false,
        });
        /**
         * Il clic apre la CONVERSAZIONE, non solo la finestra (2026-09-15): la richiesta va alla pagina
         * chat montata con lo stesso evento del tocco su una push (`richiediAperturaThread`). Se nessuna
         * pagina chat ascolta più, il clic porta davanti la finestra e basta.
         */
        notifica.onclick = () => {
            window.focus();
            if (conNonLetti) richiediAperturaThread(conNonLetti.id);
            notifica.close();
        };
        setTimeout(() => notifica.close(), CHIUSURA_NOTIFICA_MS);
    } catch (err) {
        // Il costruttore può lanciare: su Chrome Android `new Notification` è «Illegal constructor»
        // (lì si passa dal Service Worker). La notifica non esce, l'app va avanti: `warn`, col solo
        // nome dell'errore.
        logClient({
            livello: 'warn',
            evento: 'push',
            messaggio: `chat-notifica-browser-non-mostrata: ${nomeErrore(err)}`,
        });
    }
}

function aggiornaTitolo(totale: number): void {
    if (typeof document === 'undefined') return;
    document.title = totale > 0 ? `(${totale}) ${TITOLO_PAGINA}` : TITOLO_PAGINA;
}
```

`src/lib/chat/consegna-conversazioni.ts`:

```ts
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * QUANDO LA PAGINA CHAT CHIEDE LA CONSEGNA, E COME (robustezza 2, sessione 12 — S7).
 *
 * La consegna (`delivered_at`, la doppia spunta del mittente) la faceva la GET della lista a ogni
 * giro. Adesso è `POST /api/chat/threads/consegnati`, e parte solo quando serve: quando un thread
 * con non letti ha un'impronta diversa dalla lista precedente (più non letti, o un messaggio più
 * recente). Una lista uguale, o tutta letta, non consegna niente.
 */
export const URL_CONSEGNA = '/api/chat/threads/consegnati';

export interface ThreadConsegna {
    id: string;
    unread_count?: number | null;
    last_message_at?: string | null;
}

function impronta(t: ThreadConsegna): string {
    return `${t.unread_count ?? 0}|${t.last_message_at ?? ''}`;
}

function haNonLetti(t: ThreadConsegna): boolean {
    return typeof t.unread_count === 'number' && t.unread_count > 0;
}

/** L'impronta dei non letti di una lista, per confrontarla con la prossima. */
export function fotografiaNonLetti(lista: readonly ThreadConsegna[]): Map<string, string> {
    return new Map(lista.map((t) => [t.id, impronta(t)]));
}

export function serveConsegna(precedente: ReadonlyMap<string, string> | null, lista: readonly ThreadConsegna[]): boolean {
    return lista.some((t) => haNonLetti(t) && precedente?.get(t.id) !== impronta(t));
}

/**
 * La POST, con corpo vuoto: l'identità la decide il server dal gate. Non rifiuta mai.
 *
 * Una risposta non ok si dice con lo `stato`: il livello con cui lascia il dispositivo lo decide
 * `livelloEvento` di `@/lib/logging/client` (un 500 esce `error`, un 401 di sessione scaduta non esce
 * affatto). La rete giù si dice con la classe dell'errore, mai col messaggio.
 */
export function inviaConsegna(rotta: string): Promise<void> {
    return fetch(URL_CONSEGNA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    }).then(
        (res) => {
            if (res.ok) return;
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `chat-consegna-non-riuscita: http-${res.status}`,
                route: rotta,
                stato: res.status,
            });
        },
        (err: unknown) => {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `chat-consegna-non-riuscita: ${nomeErrore(err)}`,
                route: rotta,
            });
        },
    );
}
```

- [ ] **Passo 4: i tre test passano**

```bash
npx vitest run __tests__/lib/chat-lista-conversazioni.test.ts __tests__/lib/chat-annuncio-non-letti.test.ts __tests__/lib/chat-consegna-conversazioni.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)`; `tsc` senza output.

- [ ] **Passo 5: commit**

```bash
git add src/lib/chat/lista-conversazioni.ts src/lib/chat/annuncio-non-letti.ts src/lib/chat/consegna-conversazioni.ts __tests__/lib/chat-lista-conversazioni.test.ts __tests__/lib/chat-annuncio-non-letti.test.ts __tests__/lib/chat-consegna-conversazioni.test.ts
git commit -m "$(cat <<'EOF'
Chat leggera: lista, annuncio dei non letti e consegna come moduli (S7)

Funzioni di modulo senza try per il hook della chat: la GET della lista
come esito, il totale con titolo e notifica del browser (riservatezza e
clic di prima), e la decisione e la POST della consegna esplicita.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Un orologio solo per la lista

**File:**
- Riscrive: `src/components/features/chat/useUnreadNotifications.ts`
- Modifica: `src/components/features/chat/useConversazioneChat.ts` (righe 21, 54, 225-247, 252-301, 366-374, 670-676)
- Crea: `__tests__/components/useConversazioneChat-un-poller.test.tsx`, `__tests__/components/useUnreadNotifications-permesso.test.tsx`
- Modifica: `__tests__/components/useConversazioneChat-contatore-chat.test.tsx`, `__tests__/components/useConversazioneChat.test.tsx`, `__tests__/pages/chat-stato-conversazione.test.tsx`
- Elimina: `__tests__/components/useUnreadNotifications-riservatezza.test.tsx`, `__tests__/components/useUnreadNotifications-clic-notifica.test.tsx`
- Modifica (commenti): `src/lib/hooks/use-polling-visibile.ts:31-35`, `__tests__/lib/use-polling-visibile.test.tsx:187-188`, `src/components/features/chat/useChatRealtime.ts:140`

- [ ] **Passo 1: i due test nuovi, che falliscono**

`__tests__/components/useConversazioneChat-un-poller.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * UN OROLOGIO SOLO PER LA LISTA DELLA CHAT (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 la stessa `GET /api/chat/threads` partiva da due orologi: quello di
 * `useConversazioneChat` e quello di `useUnreadNotifications`, ogni 30 s ciascuno. E ogni GET faceva
 * anche un UPDATE di `delivered_at`. Qui si prova che:
 *  · la lista ha UN orologio: 30 s a pagina visibile, 5 minuti a pagina nascosta (non fermo: la
 *    notifica del browser parte da lì), e al ritorno ricarica subito;
 *  · il totale della pagina è la somma dei non letti della lista;
 *  · la consegna parte solo con non letti nuovi, una alla volta;
 *  · i guasti del conteggio restano detti.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@/components/features/chat/useChatRealtime', () => ({ useChatRealtime: () => {} }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

import { useConversazioneChat } from '@/components/features/chat/useConversazioneChat';

const IO = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const LISTA = '/api/chat/threads';
const CONSEGNA = '/api/chat/threads/consegnati';

function riga(id: string, nonLetti: number, ultimo = '2026-10-20T08:00:00.000Z') {
    return {
        id,
        teacher_id: 'doc-1',
        parent_id: IO,
        student_id: 'alu-1',
        other_user: { first_name: 'A', last_name: 'B', role: 'teacher' },
        student: { nome: 'N', cognome: 'C', classe_sezione: 'S' },
        last_message: null,
        last_message_at: ultimo,
        unread_count: nonLetti,
        sospensione: null,
    };
}

type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };

const rete = {
    threads: [] as unknown[],
    stato: 200,
    giu: false,
    trattieniConsegne: false,
    consegneTrattenute: [] as Array<() => void>,
    chiamate: [] as Array<{ verbo: string; percorso: string }>,
};

function fetchFinto(input: string, init?: { method?: string }): Promise<Risposta> {
    const percorso = String(input).split('?')[0];
    const verbo = init?.method ?? 'GET';
    rete.chiamate.push({ verbo, percorso });
    if (percorso === LISTA && verbo === 'GET') {
        if (rete.giu) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: rete.stato < 400, status: rete.stato, json: async () => rete.threads });
    }
    if (percorso === CONSEGNA && verbo === 'POST') {
        const risposta: Risposta = { ok: true, status: 200, json: async () => ({ consegna: 'ok' }) };
        if (!rete.trattieniConsegne) return Promise.resolve(risposta);
        return new Promise((fatto) => rete.consegneTrattenute.push(() => fatto(risposta)));
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
}

const conta = (verbo: string, percorso: string) =>
    rete.chiamate.filter((c) => c.verbo === verbo && c.percorso === percorso).length;

async function avanza(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
}

function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (nascosta ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

async function monta() {
    const vista = renderHook(() => useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' }));
    await avanza(0);
    return vista;
}

beforeEach(() => {
    vi.useFakeTimers();
    rete.threads = [riga('th-a', 0), riga('th-b', 0)];
    rete.stato = 200;
    rete.giu = false;
    rete.trattieniConsegne = false;
    rete.consegneTrattenute = [];
    rete.chiamate = [];
    h.logClient.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
});

afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('S7 — la lista ha UN orologio', () => {
    it('una GET al montaggio, poi una ogni 30 s: non due', async () => {
        const { unmount } = await monta();
        expect(conta('GET', LISTA)).toBe(1);
        await avanza(30_000);
        expect(conta('GET', LISTA), 'due orologi sulla stessa lista').toBe(2);
        await avanza(30_000);
        expect(conta('GET', LISTA)).toBe(3);
        unmount();
    });

    it('a pagina nascosta rallenta a 5 minuti, e al ritorno ricarica subito', async () => {
        const { unmount } = await monta();
        act(() => visibilita(true));
        await avanza(299_999);
        expect(conta('GET', LISTA), 'il ritmo veloce anche da nascosta').toBe(1);
        await avanza(1);
        expect(conta('GET', LISTA), 'da nascosta si è fermato: la notifica del browser non partirebbe più').toBe(2);
        act(() => visibilita(false));
        await avanza(0);
        expect(conta('GET', LISTA)).toBe(3);
        unmount();
    });

    it('il totale della pagina è la somma dei non letti della lista, e il titolo lo dice', async () => {
        rete.threads = [riga('th-a', 2), riga('th-b', 3)];
        const { result, unmount } = await monta();
        expect(result.current.nonLetti).toBe(5);
        expect(document.title).toBe('(5) Kidville');
        unmount();
    });
});

describe('S7 — la consegna esplicita parte solo con non letti nuovi', () => {
    it('una alla prima lista con non letti; nessuna se non cambia; una se cambia; nessuna se è tutto letto', async () => {
        rete.threads = [riga('th-a', 2), riga('th-b', 0)];
        const { unmount } = await monta();
        expect(conta('POST', CONSEGNA)).toBe(1);

        await avanza(30_000);
        expect(conta('POST', CONSEGNA), 'la stessa lista ha chiesto un’altra consegna').toBe(1);

        rete.threads = [riga('th-a', 3, '2026-10-20T08:05:00.000Z'), riga('th-b', 0)];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA)).toBe(2);

        rete.threads = [riga('th-a', 0, '2026-10-20T08:05:00.000Z'), riga('th-b', 0)];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA)).toBe(2);
        unmount();
    });

    it('senza non letti nessuna consegna, mai', async () => {
        const { unmount } = await monta();
        await avanza(90_000);
        expect(conta('POST', CONSEGNA)).toBe(0);
        unmount();
    });

    it('con una consegna in volo, due liste cambiate fanno UNA consegna in più, non due', async () => {
        rete.trattieniConsegne = true;
        rete.threads = [riga('th-a', 1)];
        const { unmount } = await monta();
        expect(conta('POST', CONSEGNA)).toBe(1);

        rete.threads = [riga('th-a', 2, '2026-10-20T08:01:00.000Z')];
        await avanza(30_000);
        rete.threads = [riga('th-a', 3, '2026-10-20T08:02:00.000Z')];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA), 'una seconda POST partita mentre la prima era in volo').toBe(1);

        rete.trattieniConsegne = false;
        await act(async () => {
            rete.consegneTrattenute.shift()?.();
        });
        await avanza(0);
        expect(conta('POST', CONSEGNA)).toBe(2);
        unmount();
    });
});

describe('S7 — i guasti del conteggio restano detti', () => {
    it('rete giù con la lista già in mano: warn «chat-non-letti-conteggio-fallito» con la classe e la pagina', async () => {
        const { unmount } = await monta();
        rete.giu = true;
        await avanza(30_000);
        expect(h.logClient.mock.calls.map((c) => c[0])).toContainEqual({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'chat-non-letti-conteggio-fallito: TypeError',
            route: '/parent/chat',
        });
        unmount();
    });

    it('un 500 con la lista in mano non scrive quel warn (lo registra già il fetch strumentato), e la lista resta', async () => {
        const { result, unmount } = await monta();
        rete.stato = 500;
        await avanza(30_000);
        const messaggi = h.logClient.mock.calls.map((c) => String((c[0] as { messaggio: string }).messaggio));
        expect(messaggi.some((m) => m.startsWith('chat-non-letti-conteggio-fallito'))).toBe(false);
        expect(result.current.statoThreads).toBe('pronto');
        expect(result.current.threads).toHaveLength(2);
        unmount();
    });
});
```

`__tests__/components/useUnreadNotifications-permesso.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * `useUnreadNotifications` DOPO LA SESSIONE 12: chiede il permesso delle notifiche, e basta.
 * Nessuna GET, nessun orologio: la lista la scarica `useConversazioneChat`, e l'annuncio lo fa
 * `annunciaNonLetti`. Una richiesta del permesso che fallisce non resta un rifiuto non gestito.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';

class NotificaFinta {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
}

const fetchFinta = vi.fn();

beforeEach(() => {
    NotificaFinta.permission = 'default';
    NotificaFinta.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', NotificaFinta);
    vi.stubGlobal('fetch', fetchFinta);
    fetchFinta.mockClear();
    h.logClient.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('useUnreadNotifications — solo il permesso', () => {
    it('lo chiede UNA volta, e non scarica niente', async () => {
        const r = renderHook(() => useUnreadNotifications({ enabled: true }));
        r.rerender();
        await waitFor(() => expect(NotificaFinta.requestPermission).toHaveBeenCalledTimes(1));
        expect(fetchFinta).not.toHaveBeenCalled();
        r.unmount();
    });

    it('permesso già deciso: nessuna richiesta', () => {
        NotificaFinta.permission = 'granted';
        renderHook(() => useUnreadNotifications({ enabled: true }));
        expect(NotificaFinta.requestPermission).not.toHaveBeenCalled();
    });

    it('`enabled` falso: niente', () => {
        renderHook(() => useUnreadNotifications({ enabled: false }));
        expect(NotificaFinta.requestPermission).not.toHaveBeenCalled();
    });

    it('la richiesta fallisce: warn «push» col solo nome dell’errore', async () => {
        NotificaFinta.requestPermission = vi.fn(async () => {
            throw new TypeError('riservato');
        });
        renderHook(() => useUnreadNotifications({ enabled: true }));
        await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1));
        expect(h.logClient).toHaveBeenCalledWith({
            livello: 'warn',
            evento: 'push',
            messaggio: 'chat-permesso-notifiche-non-chiesto: TypeError',
        });
    });
});
```

```bash
npx vitest run __tests__/components/useConversazioneChat-un-poller.test.tsx __tests__/components/useUnreadNotifications-permesso.test.tsx 2>&1 | tail -15
```

Atteso: `Test Files  2 failed (2)`.
- Nel primo falliscono almeno i test della consegna: oggi nessuna `POST /api/chat/threads/consegnati` esiste. Anche i conteggi delle GET possono non tornare, perché qui `useUnreadNotifications` non è mockato e il suo orologio scarica la stessa lista.
- Nel secondo fallisce almeno il test del rifiuto: oggi un `requestPermission` che rifiuta resta senza log.

- [ ] **Passo 2: riscrivi `useUnreadNotifications`**

Sostituisci **tutto** il contenuto di `src/components/features/chat/useUnreadNotifications.ts` con:

```ts
'use client';

import { useEffect } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * IL PERMESSO DELLE NOTIFICHE DEL BROWSER, E NIENT'ALTRO (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 questo hook aveva un SUO orologio: ogni 30 s (5 minuti a pagina nascosta) una
 * `GET /api/chat/threads` per sommare i non letti, accanto a quella identica della lista in
 * `useConversazioneChat`. Due GET della stessa lista per lo stesso utente, ciascuna da ~150 richieste
 * al database con 37 conversazioni.
 *
 * Adesso la lista la scarica un orologio solo, quello di `useConversazioneChat`, e il totale, il
 * titolo della pagina e la notifica del browser li fa `annunciaNonLetti` (`@/lib/chat/annuncio-non-letti`)
 * sulla lista che c'è già. Qui resta la richiesta del permesso, una volta.
 *
 * Il nome del file resta: cinque test di pagina lo sostituiscono con una factory che espone solo
 * `useUnreadNotifications`.
 */
export function useUnreadNotifications({ enabled }: { enabled: boolean }): void {
    useEffect(() => {
        if (!enabled) return;
        if (typeof window === 'undefined' || !('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        // `Promise.resolve`: su Safari vecchi `requestPermission` non restituisce una promessa.
        void Promise.resolve(Notification.requestPermission()).then(
            () => undefined,
            (err: unknown) => {
                logClient({
                    livello: 'warn',
                    evento: 'push',
                    messaggio: `chat-permesso-notifiche-non-chiesto: ${nomeErrore(err)}`,
                });
            },
        );
    }, [enabled]);
}
```

- [ ] **Passo 3: `useConversazioneChat` — import e costante**

Dopo la riga 21 (`import { useUnreadNotifications } from './useUnreadNotifications';`) aggiungi:

```ts
import { scaricaListaConversazioni, type EsitoListaConversazioni } from '@/lib/chat/lista-conversazioni';
import { annunciaNonLetti } from '@/lib/chat/annuncio-non-letti';
import { fotografiaNonLetti, inviaConsegna, serveConsegna } from '@/lib/chat/consegna-conversazioni';
```

Dopo `const FINESTRA_RICARICA_LISTA_MS = 2_000;` aggiungi:

```ts

/**
 * Il ritmo della lista a pagina NASCOSTA: 5 minuti, non fermo. È da nascosta che parte la notifica
 * del browser (`annunciaNonLetti` non la manda a pagina a fuoco); fermarlo la spegnerebbe. Era il
 * ritmo dell'orologio di `useUnreadNotifications`, che dalla sessione 12 non c'è più.
 */
const RITMO_LISTA_NASCOSTA_MS = 300_000;
```

- [ ] **Passo 4: `useConversazioneChat` — il totale, i ref e la consegna (righe 225-247)**

Sostituisci le righe 225-247, dal commento `⚠️ QUESTO TOTALE RESTA DENTRO LA PAGINA CHAT` fino alla `});` che chiude la chiamata a `useUnreadNotifications`, con:

```ts
    /**
     * ⚠️ IL TOTALE DELLA PAGINA CHAT RESTA DENTRO LA PAGINA CHAT, e NON va nello store della barra in basso.
     *
     * Dalla sessione 12 di robustezza 2 (S7) il totale lo calcola `annunciaNonLetti` sulla lista che
     * questo hook ha appena applicato: un orologio solo, non più due GET identiche ogni 30 s (questa e
     * quella di `useUnreadNotifications`, che oggi chiede soltanto il permesso delle notifiche).
     *
     * La tentazione di portarlo nello store resta, e resta sbagliata: se la RPC di riepilogo manca, la
     * route torna al percorso di prima, che trasforma l'errore del conteggio di UN thread in uno zero
     * (`unread_count: unreadCount ?? 0`). Un guasto parziale non si distingue da «quella conversazione è
     * tutta letta», e finirebbe nello store come un totale sbagliato PER DIFETTO — la bugia «hai letto
     * tutto».
     *
     * La fonte di verità dal server è quindi UNA: `chat_non_letti` di `GET /api/notifiche`, che su
     * qualunque errore risponde `null`. Fra un giro e l'altro della campanella il contatore si muove con
     * le VARIAZIONI locali — la PATCH dei letti, il `+1` del realtime — e con l'evento che fa ricaricare
     * la campanella.
     */
    useUnreadNotifications({ enabled: true });

    /** L'impronta dei non letti dell'ultima lista applicata: decide se serve una consegna. */
    const nonLettiServerRef = useRef<Map<string, string> | null>(null);
    /** Il totale dell'ultima lista applicata: la notifica del browser parte solo se sale. */
    const totaleAnnunciatoRef = useRef(0);
    /** La consegna esplicita: una POST in volo alla volta, e al più UNA in coda. */
    const consegnaRef = useRef<{ inVolo: boolean; ancora: boolean }>({ inVolo: false, ancora: false });

    /**
     * LA CONSEGNA ESPLICITA (S7). Fino al 2026-10-20 la faceva la GET della lista a ogni giro: una
     * lettura che scriveva `delivered_at` su tutti i thread anche senza niente da consegnare. Adesso
     * parte solo quando la lista mostra non letti nuovi (`serveConsegna`), con `POST
     * /api/chat/threads/consegnati`. Mai due insieme: se ne serve un'altra mentre una è in volo, la si
     * segna e parte UNA volta alla fine. `inviaConsegna` non rifiuta mai.
     */
    const chiediConsegna = useCallback(() => {
        const stato = consegnaRef.current;
        if (stato.inVolo) {
            stato.ancora = true;
            return;
        }
        stato.inVolo = true;
        const giro = (): void => {
            stato.ancora = false;
            void inviaConsegna(rotta).then(() => {
                if (stato.ancora) {
                    giro();
                    return;
                }
                stato.inVolo = false;
            });
        };
        giro();
    }, [rotta]);
```

- [ ] **Passo 5: `useConversazioneChat` — `applicaLista` e `scaricaThreads` (righe 252-301)**

Sostituisci le righe 252-301, dal commento `/** Una GET della lista, e l'applicazione della sua risposta. La chiama solo \`caricaThreads\`. */` fino alla `);` che chiude `scaricaThreads`, con:

```ts
    /**
     * L'applicazione di una risposta della lista. Non ha `try`: l'esito arriva già deciso da
     * `scaricaListaConversazioni`, che non rifiuta mai. Con un `try/finally` il compilatore di React
     * rinuncia al hook intero, e la regola `set-state-in-effect` smette di guardarlo.
     */
    const applicaLista = useCallback(
        (partitaAt: number, esito: EsitoListaConversazioni<ChatThread>): ChatThread[] | null => {
            let lista: ChatThread[] | null = null;
            if ('lista' in esito) {
                // Una risposta PARTITA prima di quella già applicata è più vecchia: non la sovrascrive.
                if (listaDaRef.current === null || partitaAt >= listaDaRef.current) {
                    listaDaRef.current = partitaAt;
                    impostaThreads(esito.lista);
                    onThreadsCaricatiRef.current?.(esito.lista);
                    // S7: consegna, totale, titolo e notifica sulla lista appena applicata.
                    const serve = serveConsegna(nonLettiServerRef.current, esito.lista);
                    nonLettiServerRef.current = fotografiaNonLetti(esito.lista);
                    const totale = annunciaNonLetti(esito.lista, totaleAnnunciatoRef.current);
                    totaleAnnunciatoRef.current = totale;
                    setNonLetti(totale);
                    if (serve) chiediConsegna();
                }
                listaCaricataRef.current = true;
                lista = threadsRef.current;
            } else if (listaCaricataRef.current && esito.http === null) {
                // La lista in mano resta, ma il conteggio di questo giro non c'è: lo si dice, col solo
                // gettone. Un `http-<stato>` no: lo registra già il `fetch` strumentato, col suo livello.
                logClient({ livello: 'warn', evento: 'fetch', messaggio: `chat-non-letti-conteggio-fallito: ${esito.guasto}`, route: rotta });
            }
            /**
             * D6 — «pronto» solo se una lista è arrivata, adesso o prima. Fino al 2026-09-14 un primo
             * caricamento fallito finiva comunque in «caricato», e la pagina diceva «Nessuna chat»: un
             * guasto di rete travestito da «non hai conversazioni». Con una lista già in mano, un polling
             * fallito non la svuota e non cambia niente a schermo.
             */
            if (listaCaricataRef.current) {
                statoThreadsRef.current = 'pronto';
                setStatoThreads('pronto');
            } else {
                if (statoThreadsRef.current !== 'errore') {
                    const guasto = 'guasto' in esito ? esito.guasto : 'sconosciuto';
                    logClient({ livello: 'warn', evento: 'fetch', messaggio: `chat-conversazioni-non-caricate: ${guasto}`, route: rotta });
                }
                statoThreadsRef.current = 'errore';
                setStatoThreads('errore');
            }
            return lista;
        },
        [rotta, impostaThreads, chiediConsegna],
    );

    /** Una GET della lista, e l'applicazione della sua risposta. La chiama solo `caricaThreads`. */
    const scaricaThreads = useCallback(
        (partitaAt: number): Promise<ChatThread[] | null> =>
            scaricaListaConversazioni<ChatThread>(userId ?? '').then((esito) => applicaLista(partitaAt, esito)),
        [userId, applicaLista],
    );
```

- [ ] **Passo 6: `useConversazioneChat` — «Riprova» (righe 366-374) e l'orologio (righe 670-676)**

Sostituisci `riprovaThreads`, cioè il commento `/** «Riprova» della lista che non si era caricata. */` e la `useCallback` che segue, con:

```ts
    /** «Riprova» della lista che non si era caricata. Senza `try`: `caricaThreads` non rifiuta per la rete. */
    const riprovaThreads = useCallback((): Promise<void> => {
        setRiprovando(true);
        return caricaThreads()
            .then(() => undefined)
            .finally(() => setRiprovando(false));
    }, [caricaThreads]);
```

Sostituisci il blocco `// ── I badge si aggiornano solo mentre qualcuno guarda ───────────────`, con le tre righe di commento che seguono e la chiamata `usePollingVisibile(() => { void caricaThreads(); }, 30_000);`, con:

```ts
    // ── La lista: UN orologio (S7, robustezza 2 sessione 12) ───────────
    // 30 secondi a pagina visibile. A pagina nascosta 5 minuti, non fermo: la notifica del browser
    // (`annunciaNonLetti`) parte proprio quando la pagina non è a fuoco. Fino al 2026-10-20 gli
    // orologi della lista erano due, questo e quello di `useUnreadNotifications`, con due GET
    // identiche. Il 7/9/2026 un genitore fermo sulla chat faceva ~11 richieste al minuto: vedi
    // `usePollingVisibile`.
    usePollingVisibile(
        () => {
            void caricaThreads();
        },
        30_000,
        { intervalloNascostoMs: RITMO_LISTA_NASCOSTA_MS },
    );
```

- [ ] **Passo 7: i test esistenti che parlavano del vecchio hook**

**Elimina** i due file i cui casi sono passati in `__tests__/lib/chat-annuncio-non-letti.test.ts`:

```bash
git rm __tests__/components/useUnreadNotifications-riservatezza.test.tsx __tests__/components/useUnreadNotifications-clic-notifica.test.tsx
```

In `__tests__/components/useConversazioneChat-contatore-chat.test.tsx`:
- in `vi.hoisted` togli la riga `unread: null as null | Record<string, unknown>,`;
- sostituisci il mock delle righe 55-59 con `vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }));`;
- togli la funzione `unread()` (righe 119-122) e la riga `h.unread = null;` (riga 154);
- sostituisci il test `…e lo stesso vale per il totale LOCALE dell’hook, quello dell’intestazione della pagina chat` (righe 275-288) con:

```tsx
    it('…e lo stesso vale per il totale LOCALE dell’hook, quello dell’intestazione della pagina chat', async () => {
        // S7: il totale arriva dalla lista (2 + 3), non più da un secondo orologio.
        rete.threads = [{ ...TA, unread_count: 2 }, TB];
        const { vista } = await apparato();
        expect(vista.result.current.nonLetti).toBe(5);

        act(() => vista.result.current.apri(TB as never));
        await scorri();
        expect(vista.result.current.nonLetti, "l'apertura ha sottratto dal totale locale").toBe(5);

        await act(async () => {
            await vista.result.current.segnaLetti(['m-1', 'm-2', 'm-3']);
        });
        expect(vista.result.current.nonLetti).toBe(2);
    });
```

- sostituisci il blocco finale, dal commento `⚠️ IL TOTALE DI \`useUnreadNotifications\` NON DEVE ENTRARE NELLO STORE` (il `/**` alla riga 397, il testo alla 398) alla fine del file, con:

```tsx
/**
 * ⚠️ IL TOTALE DELLA LISTA NON DEVE ENTRARE NELLO STORE, e questo è il lock.
 *
 * Dalla sessione 12 di robustezza 2 il totale della pagina chat lo calcola `annunciaNonLetti` sulla
 * lista di `chat/threads:GET`. Se la RPC di riepilogo manca, la route torna al percorso di prima, che
 * trasforma l'errore del conteggio di UN thread in uno zero (`unread_count: unreadCount ?? 0`): un
 * guasto parziale resta indistinguibile da «quella conversazione è tutta letta», e finirebbe nello
 * store come un totale sbagliato PER DIFETTO.
 *
 * La fonte di verità dal server resta UNA: `GET /api/notifiche`, che su qualunque errore risponde
 * `null`. Il totale della lista serve solo alla pagina chat, dove convive con la lista da cui è nato.
 */
describe('useConversazioneChat → il totale della pagina chat resta nella pagina chat', () => {
    it('il totale della lista aggiorna la pagina e NON il contatore della barra in basso', async () => {
        rete.threads = [{ ...TA, unread_count: 4 }, TB];
        const { store, vista } = await apparato();

        expect(vista.result.current.nonLetti).toBe(7);
        expect(
            store.chatNonLetti(),
            'Il totale di `chat/threads:GET` è finito nello store: col ripiego quella route conta 0 anche ' +
                'quando il conteggio di un thread FALLISCE, quindi un guasto parziale scriverebbe un numero ' +
                'più basso del vero sulla barra di ogni schermata.',
        ).toBeNull();
    });
});
```

In `__tests__/components/useConversazioneChat.test.tsx`, nel test `una raffica in background costa UNA ricarica nella finestra, e la rimandata parte alla fine` (righe 837-876):
- sostituisci la costante `arriva` (righe 843-849) con:

```tsx
        const arriva = (n: number) => {
            // S7: il server finto conta i non letti come quello vero. La lista ricaricata porta il
            // totale, e un finto che dicesse sempre zero misurerebbe sé stesso, non il codice.
            rete.threads = rete.threads.map((t) => (t.id === 'th-b' ? { ...t, unread_count: n } : t));
            act(() =>
                realtime().onThreadUnread(
                    'th-b',
                    segnale({ id: `m-r${n}`, thread_id: 'th-b', sender_id: 'doc-1', created_at: new Date(Date.UTC(2026, 9, 12, 10, n, 0)).toISOString() }),
                ),
            );
        };
```

- subito dopo `expect(conta('GET', '/api/chat/threads'), 'cinque segnali nella stessa finestra: cinque GET della lista').toBe(prima + 1);` aggiungi:

```tsx
        expect(result.current.nonLetti, 'i +1 locali dei segnali strozzati, prima che la lista arrivi').toBe(6);
```

- sostituisci il commento `E il TOTALE ha contato tutti e sei, …` (righe 866-874) con:

```tsx
        /**
         * E il TOTALE dopo la ricarica rimandata è quello del server, che conta tutti e sei.
         *
         * Dalla sessione 12 il totale della pagina lo riscrive ogni lista applicata (`annunciaNonLetti`):
         * il `+1` locale copre i millisecondi prima che la lista arrivi, e la lista porta il numero vero.
         * Se la ricarica rimandata non partisse, il totale resterebbe quello locale fino al giro dopo.
         */
```

Il `expect(result.current.nonLetti).toBe(6);` finale resta.

In `__tests__/pages/chat-stato-conversazione.test.tsx`, nel test `l’INSERT del realtime arriva PRIMA della 201 …` (righe 438-460), per precauzione si trattiene solo la `POST` dei messaggi e non anche quella della consegna:
- sostituisci **l'intera riga 441**, che trattiene ogni POST, con:

```tsx
        rete.trattieni = (verbo, url) => verbo === 'POST' && url.startsWith('/api/chat/messages');
```

- sostituisci **l'intera riga 447**, l'attesa che una POST sia trattenuta, con:

```tsx
        await waitFor(() => expect(rete.trattenute.some((r) => r.url.startsWith('/api/chat/messages'))).toBe(true));
```

- [ ] **Passo 8: i commenti che citavano il vecchio orologio**

- In `src/lib/hooks/use-polling-visibile.ts`, righe 31-35, la frase `` `useUnreadNotifications` è l'unico punto che manda la notifica del browser quando la pagina non è a fuoco. `` diventa: `` dalla sessione 12 di robustezza 2 è la lista della chat in `useConversazioneChat`, da cui `annunciaNonLetti` manda la notifica del browser quando la pagina non è a fuoco. ``
- In `__tests__/lib/use-polling-visibile.test.tsx`, righe 187-188, il commento diventa: `` // È il caso della lista della chat (`useConversazioneChat`): da nascosta `annunciaNonLetti` manda la notifica del browser, e spegnere l'orologio la spegnerebbe. ``
- In `src/components/features/chat/useChatRealtime.ts`, riga 140, `Il polling (30 s, fermo a pagina nascosta) resta come rete quando il Realtime non c'è.` diventa: `` Il polling resta come rete quando il Realtime non c'è: la lista ogni 30 s (5 minuti a pagina nascosta), i messaggi della conversazione aperta ogni 30 s (fermi a pagina nascosta). ``

- [ ] **Passo 9: i test della chat**

```bash
npx vitest run __tests__/components/useConversazioneChat-un-poller.test.tsx __tests__/components/useUnreadNotifications-permesso.test.tsx __tests__/components/useConversazioneChat-contatore-chat.test.tsx __tests__/components/useConversazioneChat.test.tsx __tests__/pages/ __tests__/lib/use-polling-visibile.test.tsx 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
npx eslint src/components/features/chat/ src/lib/chat/ __tests__/components/ --max-warnings 0 2>&1 | tail -10
```

Atteso: tutti i file verdi; `tsc` ed `eslint` senza output.

- [ ] **Passo 10: il compilatore di React sul hook**

```bash
R="react-hooks/to""do"
npx eslint src/components/features/chat/useConversazioneChat.ts --rule "{\"$R\":\"error\"}" 2>&1 | tail -20
grep -n "const caricaPrecedenti = \|const invia = \|        } finally {" src/components/features/chat/useConversazioneChat.ts
npx eslint src/components/features/chat/useChatRealtime.ts --rule "{\"$R\":\"error\"}" 2>&1 | tail -5
```

Atteso:
- **`useConversazioneChat.ts`.** Le eventuali segnalazioni («try/finally non supportato») cadono **solo** dentro `caricaPrecedenti` e `invia`: i loro `finally` sono gli unici due che restano, e il `grep` ne mostra le righe. Nessuna segnalazione dentro `applicaLista`, `scaricaThreads`, `riprovaThreads` o `chiediConsegna`.
- **Ciò che il controllo non può dire.** Finché quei due `finally` restano, il compilatore rinuncia al hook intero, e `set-state-in-effect` su questo file non si può verificare. Lo si scrive nel PRD come osservato; non si corregge qui, perché è fuori dal perimetro di S7.
- **`useChatRealtime.ts`.** Nessuna segnalazione.

- [ ] **Passo 11: commit**

```bash
git add src/components/features/chat/useUnreadNotifications.ts src/components/features/chat/useConversazioneChat.ts src/components/features/chat/useChatRealtime.ts src/lib/hooks/use-polling-visibile.ts __tests__/lib/use-polling-visibile.test.tsx __tests__/components/useConversazioneChat-un-poller.test.tsx __tests__/components/useUnreadNotifications-permesso.test.tsx __tests__/components/useConversazioneChat-contatore-chat.test.tsx __tests__/components/useConversazioneChat.test.tsx __tests__/pages/chat-stato-conversazione.test.tsx
git commit -m "$(cat <<'EOF'
Chat leggera: un orologio solo per la lista, consegna solo con non letti (S7)

La lista della chat ha un orologio (30 s, 5 min a pagina nascosta) al
posto di due GET identiche. Totale, titolo e notifica del browser da
annunciaNonLetti sulla lista già in mano; useUnreadNotifications chiede
solo il permesso. La consegna esplicita parte solo con non letti nuovi,
una alla volta. Nessun try nel caricamento della lista.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — Un solo giro di dispatch per finestra di 30 s

**File:**
- Crea: `src/lib/chat/finestra-dispatch.ts`, `__tests__/lib/chat-finestra-dispatch.test.ts`
- Modifica: `src/app/api/chat/messages/route.ts` (righe 49-56 commento, 110-198 `programmaDispatchChat`)
- Modifica: `__tests__/api/chat-messages-dispatch-anticipato.test.ts` (righe 28, 98, 135-148, 279-310, più tre test nuovi)

- [ ] **Passo 1: il test della finestra, che fallisce**

`__tests__/lib/chat-finestra-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  MARGINE_FINESTRA_MS,
  apriFinestraDispatch,
  azzeraFinestreDispatch,
  chiudiFinestraDispatch,
} from '@/lib/chat/finestra-dispatch'

const A = 'dddddddd-0000-4000-8000-0000000000a1'
const B = 'dddddddd-0000-4000-8000-0000000000b2'
const ATTESA = 30_000
const T0 = 1_000_000

beforeEach(() => azzeraFinestreDispatch())

describe('la finestra del dispatch anticipato, per conversazione', () => {
  it('il primo messaggio la apre e riceve un gettone', () => {
    expect(apriFinestraDispatch(A, ATTESA, T0)).toEqual(expect.any(Number))
  })

  it('un altro messaggio della stessa conversazione dentro la finestra non ne apre un’altra', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 29_000)).toBeNull()
  })

  it('un’altra conversazione ha la sua finestra', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(B, ATTESA, T0 + 1)).not.toBeNull()
  })

  it('chiusa col suo gettone si riapre; un gettone sbagliato non la chiude', () => {
    const gettone = apriFinestraDispatch(A, ATTESA, T0)!
    chiudiFinestraDispatch(A, gettone + 1)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 1)).toBeNull()
    chiudiFinestraDispatch(A, gettone)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 2)).not.toBeNull()
  })

  it('scade da sola dopo attesa + margine: un giro che non arriva in fondo non la blocca per sempre', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(A, ATTESA, T0 + ATTESA + MARGINE_FINESTRA_MS - 1)).toBeNull()
    expect(apriFinestraDispatch(A, ATTESA, T0 + ATTESA + MARGINE_FINESTRA_MS)).not.toBeNull()
  })

  it('azzera le chiude tutte (serve ai test, come se fossero istanze nuove)', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    azzeraFinestreDispatch()
    expect(apriFinestraDispatch(A, ATTESA, T0 + 1)).not.toBeNull()
  })
})
```

```bash
npx vitest run __tests__/lib/chat-finestra-dispatch.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 failed (1)`, `Failed to resolve import`.

- [ ] **Passo 2: scrivi la finestra**

`src/lib/chat/finestra-dispatch.ts`:

```ts
/**
 * UN SOLO GIRO DI DISPATCH ANTICIPATO PER CONVERSAZIONE, PER FINESTRA (robustezza 2, sessione 12 — S7).
 *
 * Ogni messaggio della chat programmava con `after()` un giro di `eseguiDispatch` 30 s dopo. In una
 * raffica di tre messaggi in dieci secondi partivano tre giri, e dalla fase 8 i due in più si fermano
 * sì («superfluo»), ma solo DOPO aver letto la coda. Qui il secondo messaggio non programma niente:
 * la sua notifica (una sola per conversazione, per il `debounce`) la spedisce il giro già in attesa.
 *
 * LA FINESTRA SI CHIUDE PRIMA DI LEGGERE LA CODA, non alla fine del giro (`chiudiFinestraDispatch`
 * in `chat/messages:POST`). Un messaggio che arriva mentre il giro sta già lavorando programma il suo:
 * nessuna notifica resta senza giro, e nessuna parte più tardi di prima.
 *
 * Per ISTANZA della funzione: una mappa in memoria. Fra istanze diverse si resta come prima, e la presa
 * atomica di `eseguiDispatch` impedisce il doppione. Una finestra condivisa vorrebbe una tabella, cioè
 * il carico che questa sessione toglie.
 *
 * Scade da sola dopo l'attesa più `MARGINE_FINESTRA_MS`: se `after()` non arriva in fondo (istanza
 * fermata, eccezione nel timer), il messaggio dopo non resta senza giro per sempre.
 */
export const MARGINE_FINESTRA_MS = 15_000;

const finestre = new Map<string, { gettone: number; scade: number }>();
let ultimoGettone = 0;

/** Apre la finestra della conversazione e restituisce il gettone, o `null` se ce n'è già una aperta. */
export function apriFinestraDispatch(threadId: string, attesaMs: number, ora: number = Date.now()): number | null {
    for (const [id, finestra] of finestre) {
        if (finestra.scade <= ora) finestre.delete(id);
    }
    if (finestre.has(threadId)) return null;
    const gettone = ++ultimoGettone;
    finestre.set(threadId, { gettone, scade: ora + attesaMs + MARGINE_FINESTRA_MS });
    return gettone;
}

/** Chiude la finestra, solo se è ancora quella del gettone (non quella aperta da un giro dopo). */
export function chiudiFinestraDispatch(threadId: string, gettone: number): void {
    if (finestre.get(threadId)?.gettone === gettone) finestre.delete(threadId);
}

/** Per i test: come un'istanza nuova. */
export function azzeraFinestreDispatch(): void {
    finestre.clear();
}
```

```bash
npx vitest run __tests__/lib/chat-finestra-dispatch.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 3: i test della route, che falliscono**

In `__tests__/api/chat-messages-dispatch-anticipato.test.ts`:
- dopo la riga 28 (`const THREAD = …`) aggiungi `const ALTRO_THREAD = 'dddddddd-0000-4000-8000-000000000026'`;
- dopo `import { POST } from '@/app/api/chat/messages/route'` aggiungi `import { azzeraFinestreDispatch } from '@/lib/chat/finestra-dispatch'`;
- in `beforeEach` (righe 135-148), come prima istruzione dopo `vi.clearAllMocks()`, aggiungi `azzeraFinestreDispatch()`. Il `beforeEach` riassegna già `h.after.mockImplementation(…)` (righe 141-142) a ogni test: per questo il `mockImplementationOnce` del test nuovo vale per una chiamata sola;
- sostituisci il test `una raffica di tre messaggi programma tre giri, …` (righe 279-291) con:

```ts
  it('S7: due messaggi nella stessa finestra programmano UN giro; il secondo lo dice a `info`', async () => {
    for (const content of ['uno', 'due']) {
      const res = await POST(postReq({ thread_id: THREAD, content }))
      expect(res.status).toBe(201)
    }
    // Entrambe le notifiche sono accodate: il giro unico spedisce quella che resta.
    expect(h.notificaEvento).toHaveBeenCalledTimes(2)
    expect(h.after).toHaveBeenCalledTimes(1)
    const [gia] = righe('dispatch-anticipato-gia-programmato')
    expect(gia?.[0]).toBe('push')
    expect(gia?.[1]).toBe('info')
    expect(gia?.[2]).toMatchObject({ operazione: 'chat/messages:POST', threadId: THREAD })

    vi.useFakeTimers()
    await eseguiProgrammato()
    expect(h.eseguiDispatch).toHaveBeenCalledTimes(1)
    expect(h.eseguiDispatch).toHaveBeenCalledWith({ origine: 'chat' })
  })
```

- nel test `🔴 fase 8: la raffica fa UN giro solo — …` (righe 293-310) sostituisci la prima riga (`for (const content of ['uno', 'due', 'tre']) await POST(postReq({ thread_id: THREAD, content }))`) con:

```ts
    // Tre istanze diverse della funzione: ognuna ha la sua finestra (S7), e il «superfluo» della
    // fase 8 resta la difesa fra istanze.
    for (const content of ['uno', 'due', 'tre']) {
      await POST(postReq({ thread_id: THREAD, content }))
      azzeraFinestreDispatch()
    }
```

- prima della `})` che chiude il `describe('POST /api/chat/messages — la push parte 30 s dopo il messaggio', …)` (riga 332) aggiungi:

```ts
  it('S7: dopo il giro la finestra si riapre — il messaggio successivo programma il suo', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    vi.useFakeTimers()
    await eseguiProgrammato()
    vi.useRealTimers()
    await POST(postReq({ thread_id: THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(h.programmati).toHaveLength(2)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })

  it('S7: `after()` che lancia non lascia la finestra aperta — il messaggio dopo programma il suo giro', async () => {
    h.after.mockImplementationOnce(() => {
      throw new Error('`after` was called outside a request scope')
    })
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    expect(righe('dispatch-anticipato-non-programmato')).toHaveLength(1)
    await POST(postReq({ thread_id: THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(h.programmati).toHaveLength(1)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })

  it('S7: la finestra è per conversazione — un altro thread nello stesso istante programma il suo giro', async () => {
    await POST(postReq({ thread_id: THREAD, content: 'uno' }))
    await POST(postReq({ thread_id: ALTRO_THREAD, content: 'due' }))
    expect(h.after).toHaveBeenCalledTimes(2)
    expect(righe('dispatch-anticipato-gia-programmato')).toHaveLength(0)
  })
```

```bash
npx vitest run __tests__/api/chat-messages-dispatch-anticipato.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`. Il test dei due messaggi trova `after` chiamato 2 volte; quello di `after()` che lancia passa già. Gli altri restano verdi.

- [ ] **Passo 4: `programmaDispatchChat` usa la finestra**

In `src/app/api/chat/messages/route.ts`:
- dopo la riga 27 (`import { eseguiDispatch } from '@/lib/push/dispatch';`) aggiungi `import { apriFinestraDispatch, chiudiFinestraDispatch } from '@/lib/chat/finestra-dispatch';`;
- nel commento di `ATTESA_DISPATCH_CHAT_MS` (righe 49-56), sostituisci le righe 53-55, da ` * dell'ultimo. I giri programmati dai messaggi successivi trovano la notifica già presa e non` fino a ` * ogni 5 minuti che parte nello stesso secondo.`, con:

```ts
 * dell'ultimo. Dalla sessione 12 di robustezza 2 i messaggi successivi della stessa conversazione,
 * dentro la finestra, non programmano un altro giro (`@/lib/chat/finestra-dispatch`): la loro
 * notifica la spedisce quello già in attesa. Fra istanze diverse resta la presa atomica di
 * `eseguiDispatch`, che impedisce il doppione anche col cron ogni 5 minuti che parte nello stesso
 * secondo.
```


- **non** toccare `const ATTESA_DISPATCH_CHAT_MS = 30_000;`: il lock del test lo cerca così, riga 344;
- in `programmaDispatchChat` (righe 110-198) fai tre modifiche.

**(a)** Subito dopo `const operazione = 'chat/messages:POST';`:

```ts
    // S7: UN giro per conversazione per finestra. Il messaggio che trova la finestra aperta non
    // programma niente: la sua notifica la spedisce il giro già in attesa.
    const gettone = apriFinestraDispatch(threadId, ATTESA_DISPATCH_CHAT_MS);
    if (gettone === null) {
        logEvento('push', 'info', {
            operazione,
            esito: 'dispatch-anticipato-gia-programmato',
            threadId,
            msg: `${operazione}: un giro anticipato per questa conversazione è già in attesa, la notifica parte con quello`,
        });
        return;
    }
```

**(b)** Dentro `giro`, subito dopo `await new Promise<void>((fatto) => setTimeout(fatto, ATTESA_DISPATCH_CHAT_MS));`, e quindi **prima** di `if (!(await notificaDelThreadInCoda(threadId, operazione))) {`:

```ts
            // La finestra si chiude QUI, prima di leggere la coda: un messaggio che arriva da adesso
            // in poi programma il suo giro, perché questo ha già cominciato a guardare.
            chiudiFinestraDispatch(threadId, gettone);
```

Nel `catch (err)` di `giro`, come prima istruzione, `chiudiFinestraDispatch(threadId, gettone);`.

**(c)** Nel `catch (err)` attorno ad `after(giro)`, come prima istruzione, `chiudiFinestraDispatch(threadId, gettone);`.

- [ ] **Passo 5: i test passano**

```bash
npx vitest run __tests__/api/chat-messages-dispatch-anticipato.test.ts __tests__/lib/chat-finestra-dispatch.test.ts __tests__/lib/push-dispatch-durata.test.ts 2>&1 | tail -10
npx vitest run __tests__/api/ 2>&1 | grep -E "chat-messages|Test Files" | tail -15
```

Atteso: `Test Files  3 passed (3)`; poi tutti i file `chat-messages-*` verdi. Gli altri file mockano `after` a modo loro, ma ciascuno con un solo messaggio per test, e la finestra si apre al più una volta.

Se un file di `__tests__/api/chat-messages-*` manda più messaggi della stessa conversazione nello stesso test e conta le chiamate ad `after`, aggiungi `import { azzeraFinestreDispatch } from '@/lib/chat/finestra-dispatch'` e `azzeraFinestreDispatch()` nel suo `beforeEach`. Annota il file nel messaggio di commit.

- [ ] **Passo 6: commit**

```bash
git add src/lib/chat/finestra-dispatch.ts __tests__/lib/chat-finestra-dispatch.test.ts src/app/api/chat/messages/route.ts __tests__/api/chat-messages-dispatch-anticipato.test.ts
git commit -m "$(cat <<'EOF'
Chat leggera: un solo giro di dispatch per conversazione per finestra (S7)

Il secondo messaggio della stessa conversazione dentro i 30 s non
programma un altro giro (riga info dispatch-anticipato-gia-programmato).
La finestra si chiude prima di leggere la coda, e anche se after() o
il giro lanciano; scade da sola dopo 45 s.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — Il `1006` che rientra non è un guasto

**File:**
- Crea: `src/lib/chat/esito-1006.ts`, `__tests__/lib/chat-esito-1006.test.ts`
- Modifica: `src/components/features/chat/useChatRealtime.ts` (righe 7, 139-160, 174-178, 223-229, 283-310, 340-349)
- Modifica: `__tests__/components/useChatRealtime-canale.test.ts` (righe 350-387, più un `describe` nuovo)

- [ ] **Passo 1: il test delle decisioni, che fallisce**

`__tests__/lib/chat-esito-1006.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ATTESA_ESITO_1006_MS, MOTIVO_1006, decidiLogErroreCanale, decidiScadenza1006 } from '@/lib/chat/esito-1006'

describe('il 1006 aspetta il suo esito; ogni altro motivo si logga subito', () => {
  it('socket-chiuso-1006 → aspetta-esito', () => {
    expect(MOTIVO_1006).toBe('socket-chiuso-1006')
    expect(decidiLogErroreCanale(MOTIVO_1006)).toBe('aspetta-esito')
  })

  it.each(['trasporto', 'connessione-persa', 'socket-chiuso-1000', 'socket-chiuso-1011', 'join-rifiutato-token', 'nessun-motivo'])(
    '%s → subito',
    (motivo) => {
      expect(decidiLogErroreCanale(motivo)).toBe('subito')
    },
  )

  it('alla scadenza: nulla se l’interruzione è chiusa, logga se è aperta e la pagina si vede, riarma se è nascosta', () => {
    expect(decidiScadenza1006({ interruzioneAperta: false, paginaVisibile: true })).toBe('nulla')
    expect(decidiScadenza1006({ interruzioneAperta: false, paginaVisibile: false })).toBe('nulla')
    expect(decidiScadenza1006({ interruzioneAperta: true, paginaVisibile: true })).toBe('logga')
    expect(decidiScadenza1006({ interruzioneAperta: true, paginaVisibile: false })).toBe('riarma')
  })

  it('l’attesa è un minuto: oltre i rientri di realtime-js (1, 2, 5, 10 s, poi ogni 10 s)', () => {
    expect(ATTESA_ESITO_1006_MS).toBe(60_000)
  })
})
```

```bash
npx vitest run __tests__/lib/chat-esito-1006.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 failed (1)`, `Failed to resolve import`.

- [ ] **Passo 2: scrivi le decisioni**

`src/lib/chat/esito-1006.ts`:

```ts
/**
 * IL 1006 CHE RIENTRA DA SOLO NON È UN GUASTO (robustezza 2, sessione 12 — S7).
 *
 * `socket closed: 1006` è la chiusura anomala del WebSocket: la rete del telefono che cambia, il
 * sistema che sospende la scheda, un proxy che taglia. realtime-js rientra da solo dopo 1, 2, 5, 10 s
 * e poi ogni 10 s, e quasi sempre ci riesce. Fino al 2026-10-20 ogni interruzione aperta da un 1006
 * scriveva SUBITO un `warn` `chat-realtime-errore: socket-chiuso-1006`: 544 in 7 giorni, mescolati
 * alle interruzioni vere.
 *
 * Adesso si aspetta l'esito. Se il canale rientra entro `ATTESA_ESITO_1006_MS`, del 1006 resta la riga
 * di rientro (`chat-realtime-rientrato: …`, con il numero di errori), che `useConversazioneChat` già
 * scrive: è una riconnessione. Se allo scadere l'interruzione è ancora aperta e la pagina si vede, si
 * scrive il `warn` di prima: è un'interruzione vera. A pagina nascosta si riarma, perché lì il canale
 * chiuso è il sistema che risparmia, non un guasto che qualcuno vede.
 *
 * Gli altri motivi (anche `trasporto`) si loggano subito come prima: una decisione per volta.
 */
export const MOTIVO_1006 = 'socket-chiuso-1006';
export const ATTESA_ESITO_1006_MS = 60_000;

export type DecisioneErroreCanale = 'subito' | 'aspetta-esito';

export function decidiLogErroreCanale(motivo: string): DecisioneErroreCanale {
    return motivo === MOTIVO_1006 ? 'aspetta-esito' : 'subito';
}

export type DecisioneScadenza1006 = 'nulla' | 'logga' | 'riarma';

export function decidiScadenza1006({
    interruzioneAperta,
    paginaVisibile,
}: {
    interruzioneAperta: boolean;
    paginaVisibile: boolean;
}): DecisioneScadenza1006 {
    if (!interruzioneAperta) return 'nulla';
    return paginaVisibile ? 'logga' : 'riarma';
}
```

```bash
npx vitest run __tests__/lib/chat-esito-1006.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 3: i test del canale, che falliscono**

In `__tests__/components/useChatRealtime-canale.test.ts`:

**(a)** Sostituisci il test `CHANNEL_ERROR ripetuti: UN log per interruzione, col gettone nel MESSAGGIO e senza il testo dell’errore` (righe 350-387) con lo stesso test su un motivo che si logga subito. Il 1006 ha ora il suo `describe`:

```ts
    it('CHANNEL_ERROR ripetuti: UN log per interruzione, col gettone nel MESSAGGIO e senza il testo dell’errore', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));

        // Un motivo che si logga SUBITO (il 1006 aspetta il suo esito: vedi il describe S7 più sotto).
        const err = new Error('channel error: connection lost (riservato-zeta)', { cause: { code: 1006, reason: 'riservato-zeta' } });
        act(() => stato('CHANNEL_ERROR', err));
        vi.setSystemTime(new Date('2026-09-14T10:00:05.000Z'));
        act(() => stato('CHANNEL_ERROR', err));

        expect(logClient, 'un log per ogni errore: la serie misura i tentativi, non le interruzioni').toHaveBeenCalledTimes(1);
        const evento = logClient.mock.calls[0][0] as { messaggio: string; campi?: Record<string, unknown> };
        // Il gettone sta nel MESSAGGIO: i campi non entrano nell'impronta di app_log né nel
        // throttle del client, quindi un motivo scritto lì si vedrebbe solo la prima volta al giorno.
        expect(evento).toMatchObject({ livello: 'warn', evento: 'react', messaggio: 'chat-realtime-errore: connessione-persa', route: '/parent/chat' });
        expect(JSON.stringify(evento)).not.toContain('riservato-zeta');
        for (const valore of Object.values(evento.campi ?? {})) expect(typeof valore).toBe('number');

        vi.setSystemTime(new Date('2026-09-14T10:00:30.000Z'));
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);
        expect(cb.onRiconnesso).toHaveBeenCalledWith({
            riconnessoAt: Date.parse('2026-09-14T10:00:30.000Z'),
            ms: 30_000,
            errori: 2,
        });

        // Un SUBSCRIBED senza interruzione in mezzo non è un rientro.
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);

        // Una nuova interruzione si logga di nuovo.
        act(() => stato('CHANNEL_ERROR', new Error('channel error: transport failure')));
        expect(logClient).toHaveBeenCalledTimes(2);
        expect((logClient.mock.calls[1][0] as { messaggio: string }).messaggio).toBe('chat-realtime-errore: trasporto');
    });
```

**(b)** In fondo al file aggiungi:

```ts
describe('useChatRealtime — S7: un 1006 che rientra è una riconnessione, non un guasto', () => {
    afterEach(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    const errore1006 = () => new Error('socket closed: 1006 (riservato-zeta)', { cause: { code: 1006, reason: 'riservato-zeta' } });

    it('1006 e SUBSCRIBED entro 10 s: nessun log d’errore, e il rientro arriva a chi ascolta', async () => {
        vi.useFakeTimers();
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));
        act(() => stato('CHANNEL_ERROR', errore1006()));
        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        act(() => stato('SUBSCRIBED'));
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(logClient).not.toHaveBeenCalled();
        expect(cb.onRiconnesso).toHaveBeenCalledWith(expect.objectContaining({ errori: 1 }));
    });

    it('1006 senza rientro: niente prima del minuto, poi UN log col gettone e gli errori contati', async () => {
        vi.useFakeTimers();
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));
        act(() => stato('CHANNEL_ERROR', errore1006()));
        act(() => stato('CHANNEL_ERROR', errore1006()));
        act(() => {
            vi.advanceTimersByTime(59_999);
        });
        expect(logClient).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(logClient).toHaveBeenCalledTimes(1);
        const evento = logClient.mock.calls[0][0];
        expect(evento).toMatchObject({
            livello: 'warn',
            evento: 'react',
            messaggio: 'chat-realtime-errore: socket-chiuso-1006',
            route: '/parent/chat',
            campi: { errori: 2 },
        });
        expect(JSON.stringify(evento)).not.toContain('riservato-zeta');
    });

    it('a pagina nascosta il log aspetta che la pagina torni visibile', async () => {
        vi.useFakeTimers();
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        act(() => stato('CHANNEL_ERROR', errore1006()));
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(logClient).not.toHaveBeenCalled();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(logClient).toHaveBeenCalledTimes(1);
    });

    it('smontato prima del minuto: nessun log', async () => {
        vi.useFakeTimers();
        const { unmount } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('SUBSCRIBED'));
        act(() => ultimo().stato?.('CHANNEL_ERROR', errore1006()));
        unmount();
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(logClient).not.toHaveBeenCalled();
    });

    it('un 1006 rientrato e poi un’interruzione vera: si logga solo quella vera', async () => {
        vi.useFakeTimers();
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));
        act(() => stato('CHANNEL_ERROR', errore1006()));
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        act(() => stato('SUBSCRIBED'));
        act(() => stato('CHANNEL_ERROR', new Error('channel error: transport failure')));
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        const messaggi = logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toEqual(['chat-realtime-errore: trasporto']);
    });
});
```

```bash
npx vitest run __tests__/components/useChatRealtime-canale.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`. Falliscono i test S7 che si aspettano niente prima del minuto: oggi il 1006 si logga subito. Il test riscritto al punto (a) passa già.

- [ ] **Passo 4: `useChatRealtime` aspetta l'esito del 1006**

In `src/components/features/chat/useChatRealtime.ts`:

**(a)** Dopo la riga 7 (`import type { ChatThread } from './ChatThreadList';`) aggiungi:

```ts
import { ATTESA_ESITO_1006_MS, MOTIVO_1006, decidiLogErroreCanale, decidiScadenza1006 } from '@/lib/chat/esito-1006';

type RifTimer = { current: ReturnType<typeof setTimeout> | null };
type RifInterruzione = { current: { da: number; errori: number } | null };

/** Spegne il log rimandato di un 1006, se c'è. Funzione di modulo: nessuno stato React. */
function annullaRinvio(rinvio: RifTimer): void {
    if (rinvio.current !== null) {
        clearTimeout(rinvio.current);
        rinvio.current = null;
    }
}

/**
 * Arma il log rimandato di un 1006 (S7, `@/lib/chat/esito-1006`): parte solo se, allo scadere,
 * l'interruzione è ancora aperta e la pagina si vede. A pagina nascosta si riarma. Il SUBSCRIBED che
 * chiude l'interruzione, il cambio di utente e lo smontaggio lo annullano.
 */
function armaRinvio1006(rinvio: RifTimer, interruzione: RifInterruzione, rotta: () => string): void {
    annullaRinvio(rinvio);
    rinvio.current = setTimeout(() => {
        rinvio.current = null;
        const decisione = decidiScadenza1006({
            interruzioneAperta: interruzione.current !== null,
            paginaVisibile: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        });
        if (decisione === 'riarma') {
            armaRinvio1006(rinvio, interruzione, rotta);
            return;
        }
        if (decisione === 'nulla') return;
        logClient({
            livello: 'warn',
            evento: 'react',
            messaggio: `chat-realtime-errore: ${MOTIVO_1006}`,
            route: rotta(),
            campi: { errori: interruzione.current?.errori ?? 1 },
        });
    }, ATTESA_ESITO_1006_MS);
}
```

**(b)** Nel commento di testata di `useChatRealtime`, prima della riga `Il polling … resta come rete quando il Realtime non c'è.` (aggiornata al Compito 6), aggiungi:

```ts
 * ─── IL 1006 CHE RIENTRA (S7, robustezza 2 sessione 12, 2026-10-20) ──────────
 *
 * Un'interruzione aperta da `socket-chiuso-1006` non si logga subito: si aspetta un minuto. Se il
 * canale rientra prima, resta la riga di rientro di `useConversazioneChat` (è una riconnessione); se
 * no, il `warn` di sempre (è un'interruzione vera). Il perché e le regole stanno in
 * `@/lib/chat/esito-1006`. Gli altri motivi si loggano subito, come sopra.
 *
```

**(c)** Dopo `const timerRicreaRef = useRef<ReturnType<typeof setTimeout> | null>(null);` (riga 177) aggiungi:

```ts
    /**
     * Il log rimandato di un 1006 (S7). Vive fuori dall'effect, come l'interruzione che racconta: la
     * ricreazione del canale non lo deve spegnere. Lo spengono il rientro, il cambio di utente e lo
     * smontaggio.
     */
    const rinvio1006Ref = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => annullaRinvio(rinvio1006Ref), []);
```

**(d)** Nel blocco `if (utenteRef.current !== userId) {` (righe 223-229), dopo `abbandonatoRef.current = false;` aggiungi `annullaRinvio(rinvio1006Ref);`.

**(e)** Nel ramo `SUBSCRIBED`, subito dopo `interruzioneRef.current = null;` aggiungi:

```ts
                    annullaRinvio(rinvio1006Ref);
```

**(f)** Sostituisci il ramo `if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { … }` (righe 301-310) con:

```ts
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    if (!segnaInterruzione()) return;
                    if (status === 'TIMED_OUT') {
                        logClient({ livello: 'warn', evento: 'react', messaggio: 'chat-realtime-timeout', route: cb.rotta });
                        return;
                    }
                    const motivo = motivoErroreCanale(err);
                    if (decidiLogErroreCanale(motivo) === 'aspetta-esito') {
                        // S7: un 1006 che rientra entro il minuto è una riconnessione, e la conta già
                        // `chat-realtime-rientrato`. Si scrive l'errore solo se allo scadere è ancora giù.
                        armaRinvio1006(rinvio1006Ref, interruzioneRef, () => callback.current.rotta);
                        return;
                    }
                    logClient({ livello: 'warn', evento: 'react', messaggio: `chat-realtime-errore: ${motivo}`, route: cb.rotta });
                    return;
                }
```

Il cleanup dell'effect (righe 340-349) **non** annulla il rinvio: un CLOSED inatteso ricrea il canale, e l'interruzione aperta resta da raccontare.

- [ ] **Passo 5: i test del canale passano, e il compilatore non segnala niente**

```bash
npx vitest run __tests__/components/useChatRealtime-canale.test.ts __tests__/lib/chat-esito-1006.test.ts __tests__/components/useConversazioneChat.test.tsx 2>&1 | tail -10
R="react-hooks/to""do"
npx eslint src/components/features/chat/useChatRealtime.ts --rule "{\"$R\":\"error\"}" --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)`; `eslint` e `tsc` senza output.

- [ ] **Passo 6: commit**

```bash
git add src/lib/chat/esito-1006.ts __tests__/lib/chat-esito-1006.test.ts src/components/features/chat/useChatRealtime.ts __tests__/components/useChatRealtime-canale.test.ts
git commit -m "$(cat <<'EOF'
Chat leggera: un 1006 che rientra non è un errore realtime (S7)

L'interruzione aperta da socket-chiuso-1006 si logga solo se dopo 60 s
il canale è ancora giù e la pagina si vede; il rientro resta contato da
chat-realtime-rientrato. Gli altri motivi si loggano subito come prima.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Log

| Dove | Evento · livello | `esito` o messaggio | Campi (solo conteggi, codici, uuid) | Quando |
|---|---|---|---|---|
| `src/lib/chat/riepilogo-conversazioni.ts` | `chat` · `info`, persistito | `riepilogo-non-installato` | `operazione`, `error_code` (`PGRST202`/`42883`), `ripiego: true` | la RPC manca (DB della CI, minuti dopo il merge) |
| idem | `chat` · `error`, persistito, con l'errore | `riepilogo-rpc-fallito` | `operazione`, `error_code`, `ripiego: true` | qualunque altro guasto della RPC |
| idem | `chat` · `error`, persistito | `riepilogo-forma-inattesa` | `operazione`, `ripiego: true` | la risposta non è una lista di righe con `id` |
| `src/app/api/chat/threads/route.ts` | come prima | `db` (500), `sospensioni-lettura-fallita`, le righe di `guastoLetturaAccessoria` | come prima | percorso di ripiego |
| `src/app/api/chat/threads/consegnati/route.ts` | `withRoute` · ogni richiesta; `logErrore` · `error` 500 | evento `db:chat_threads` | `operazione`, `stato` | lettura dei thread fallita; un guasto dell'UPDATE lo registra `marcaConsegnati` (`OP_MARCA`) |
| `src/app/api/chat/messages/route.ts` | `push` · `info`, persistito | `dispatch-anticipato-gia-programmato` | `operazione`, `threadId`, `msg` | un messaggio trova la finestra della conversazione aperta |
| `src/components/features/chat/useConversazioneChat.ts` | client `fetch` · `warn` | `chat-non-letti-conteggio-fallito: <classe>` (prima in `useUnreadNotifications`, ora con `route`) | — | GET della lista senza risposta, con una lista già in mano |
| idem | client `fetch` · `warn` | `chat-conversazioni-non-caricate: <gettone>` | — | come prima |
| `src/lib/chat/consegna-conversazioni.ts` | client `fetch` · `warn` (con `stato`: lo filtra `livelloEvento`) | `chat-consegna-non-riuscita: http-<stato>` oppure `: <classe>` | `stato` | la POST della consegna fallisce |
| `src/lib/chat/annuncio-non-letti.ts` | client `push` · `warn` | `chat-notifica-browser-non-mostrata: <classe>` (spostata) | — | il costruttore di `Notification` lancia |
| `src/components/features/chat/useUnreadNotifications.ts` | client `push` · `warn` | `chat-permesso-notifiche-non-chiesto: <classe>` (nuova: prima il rifiuto restava non gestito) | — | `requestPermission` rifiuta |
| `src/components/features/chat/useChatRealtime.ts` | client `react` · `warn` | `chat-realtime-errore: socket-chiuso-1006` **solo** se dopo 60 s il canale è ancora giù a pagina visibile | `errori` | interruzione vera; la riconnessione resta `chat-realtime-rientrato: …` |

Le chiavi nuove nei campi sono `ripiego` (booleano) ed `error_code`, che è già nella lista bianca della redazione. Nessuna chiave entra nella lista bianca, e nessun log porta testi, nomi o il `.message` di un errore.

---

## PRD

### Compito 9 — Voce di changelog nel PRD

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md:1` (la voce nuova va **in cima**, sopra la prima `## `)

- [ ] **Passo 1: scrivi la voce**

Inserisci in cima al PRD il blocco qui sotto. I valori fra parentesi graffe sono quelli **misurati** nel Passo 0, con la loro ora, e non si copiano da nessun documento.

```markdown
## 🛡️ Changelog — Robustezza 2, sessione 12: la chat leggera — {data UTC} (branch `robustezza2/s12-chat-leggera`)

**Stato:** 🟡 PR aperta, in attesa del merge a mano del titolare. Specifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` §7, sessione 12; piano: `docs/superpowers/plans/2026-10-20-robustezza2-s12-chat-leggera.md`. Una migrazione: `{S12_VERSION}_chat_riepilogo_conversazioni.sql`, applicata dall'integrazione al merge.

- **Misura prima ({giorno} {data} {ora} UTC, sola lettura):**
  - domande di iscrizione {0.1};
  - conversazioni {0.2}, utenti con conversazioni {0.2}, massimo per utente {0.2}, p50/p95 {0.2};
  - nel giorno feriale {data della finestra}: GET della lista {0.4 liste}, richieste al database per GET {0.4 rapporto} (dal codice 3 + 4·N, cioè 151 con 37);
  - errori realtime per giorno feriale: `socket-chiuso-1006` {0.5}, altri {0.5}, rientri {0.5};
  - giri anticipati superflui sul totale {0.6}.
- **S7 — il riepilogo in una chiamata.**
  - `public.chat_riepilogo_conversazioni(p_utente)` restituisce la lista con la forma di prima: ordine, ripieghi «?»/«unknown», ultimo messaggio, non letti.
  - È `SECURITY INVOKER`, con `search_path` fisso; `EXECUTE` solo a `service_role`, e la RLS di `chat_threads` resta come seconda difesa. Una guardia sulle 21 colonne la salta sul DB della CI.
  - `GET /api/chat/threads` fa una chiamata e una lettura delle sospensioni.
  - Ripiego sul percorso di prima con `PGRST202`/`42883` (riga `info` `riepilogo-non-installato`) e con ogni altro guasto (riga `error`).
- **S7 — la consegna esplicita.** L'UPDATE di `delivered_at` esce dalla GET e diventa `POST /api/chat/threads/consegnati` (corpo `{}`, identità del gate). La pagina chat lo chiede solo quando la lista mostra non letti nuovi, una richiesta alla volta. Nel lock d'isolamento entra una voce nuova, con lo scope della GET; i tre contatori salgono di 1.
- **S7 — un orologio solo.**
  - La lista della chat ha un orologio: 30 s a pagina visibile, 5 minuti a pagina nascosta, ricarica al ritorno.
  - `useUnreadNotifications` chiede solo il permesso delle notifiche.
  - Totale, titolo della pagina e notifica del browser li fa `annunciaNonLetti` sulla lista già in mano, con le stesse regole di riservatezza e di clic.
- **S7 — un giro per finestra.** `chat/messages:POST` programma un solo giro di dispatch per conversazione ogni 30 s (riga `info` `dispatch-anticipato-gia-programmato`). La finestra si chiude prima di leggere la coda, e scade da sola dopo 45 s. È per istanza.
- **S7 — il 1006 che rientra.** Un'interruzione aperta da `socket-chiuso-1006` si logga solo se dopo 60 s il canale è ancora giù e la pagina si vede. La riconnessione resta contata da `chat-realtime-rientrato`.
- **Osservato, non corretto:** in `useConversazioneChat` restano due `try/finally` (`caricaPrecedenti`, `invia`), e per questo il compilatore di React rinuncia al hook intero.
- **Da fare dopo il merge:** la misura «dopo» sul primo giorno feriale intero dopo il deploy, con richieste per GET ≤ 5, `ultimi_messaggi` ≈ 0 e il 1006 separato dai rientri, e la fotografia delle migrazioni rigenerata dalla produzione. Le scrive la sessione dopo, dalla sezione «Per la sessione dopo» del piano.
```

- [ ] **Passo 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: robustezza 2, sessione 12 (chat leggera)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 10 — Gate, PR con la migrazione mostrata, merge del titolare, verifica

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (riga **Stato** della voce del Compito 9, a «in revisione»)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, la riga della sessione 12 (`grep -n "^| 12 |"`), a «in revisione»
- Niente fotografie: quella delle migrazioni la rigenera la sessione dopo («Per la sessione dopo»)

- [ ] **Passo 1: gate completo**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -15
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso:
- eslint e tsc senza output;
- vitest: tutti i file verdi; se l'unico rosso è `offline-html-nativo`, si rilancia con `CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts`;
- build: `✓ Compiled` e nessun `Error`.

Leggi le righe di riepilogo, non il codice d'uscita di una pipe. E2E: gira in CI, mai in locale.

- [ ] **Passo 2: log presenti sul codice toccato**

```bash
grep -n "riepilogo-non-installato\|riepilogo-rpc-fallito\|riepilogo-forma-inattesa" src/lib/chat/riepilogo-conversazioni.ts
grep -n "withRoute('chat/threads/consegnati:POST'\|rispostaGuastoDb" src/app/api/chat/threads/consegnati/route.ts
grep -n "dispatch-anticipato-gia-programmato" src/app/api/chat/messages/route.ts
grep -n "chat-consegna-non-riuscita" src/lib/chat/consegna-conversazioni.ts
grep -n "chat-non-letti-conteggio-fallito" src/components/features/chat/useConversazioneChat.ts
grep -n "chat-permesso-notifiche-non-chiesto" src/components/features/chat/useUnreadNotifications.ts
grep -n "MOTIVO_1006" src/components/features/chat/useChatRealtime.ts
```

Atteso: almeno una riga per ciascun comando.

- [ ] **Passo 3: le misure del giorno della PR (sola lettura)**

Rifai il Passo 0.1 (ora e `SELECT count(*) FROM enrollment_submissions;`) e il Passo 0.7 (funzione assente, 21 colonne). Annota `S12_ISCRIZIONI_PR` con l'ora UTC: va nel corpo della PR qui sotto. Se la funzione nel frattempo esiste, o le colonne non sono 21, ci si ferma (soglie del Passo 0.7).

- [ ] **Passo 4: push e PR, con la migrazione mostrata**

````bash
git push -u origin robustezza2/s12-chat-leggera
S12_VERSION=$(grep '^S12_VERSION=' "${TMPDIR:-/tmp}/s12-misure.env" | cut -d"'" -f2)
CORPO="${TMPDIR:-/tmp}/s12-corpo-pr.md"
cat > "$CORPO" <<'EOF'
## Cosa cambia (S7, robustezza 2 sessione 12)
- **Il riepilogo in una chiamata.** `GET /api/chat/threads` chiama `chat_riepilogo_conversazioni(p_utente)` e legge le sospensioni: 2 richieste invece di 3 + 4·N. Ripiego sul percorso di prima con `PGRST202`/`42883` (`info`) e con ogni altro guasto (`error`).
- **La consegna esplicita.** L'UPDATE di `delivered_at` esce dalla GET: `POST /api/chat/threads/consegnati`, corpo `{}`, identità del gate. La pagina la chiede solo con non letti nuovi. Una voce nuova in `AMMESSE` del lock d'isolamento (decisione del titolare).
- **Un orologio solo** per la lista della chat (30 s; 5 min a pagina nascosta). `useUnreadNotifications` chiede solo il permesso; totale, titolo e notifica del browser da `annunciaNonLetti`.
- **Un giro di dispatch per conversazione per finestra di 30 s** (`dispatch-anticipato-gia-programmato`).
- **Il 1006 che rientra entro 60 s non si logga come errore**; la riconnessione resta in `chat-realtime-rientrato`.

## Misure (sola lettura)
- Prima ({S12_ORA_PRIMA} UTC): conversazioni {0.2}, massimo per utente {0.2}; GET della lista nel giorno feriale {0.4 liste}, richieste al DB per GET {0.4 rapporto}; errori `1006` / altri / rientri per giorno feriale {0.5}.
- Domande di iscrizione il giorno della PR: {S12_ISCRIZIONI_PR} ({ora} UTC).

## Migrazione (la applica l'integrazione al merge; mostrata qui prima)
EOF
{ echo '```sql'; cat "supabase/migrations/${S12_VERSION}_chat_riepilogo_conversazioni.sql"; echo '```'; echo; cat <<'EOF'
## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
} >> "$CORPO"
gh pr create --base main --head robustezza2/s12-chat-leggera \
  --title "Robustezza 2, sessione 12: chat leggera (riepilogo in una chiamata, consegna esplicita, un orologio)" \
  --body-file "$CORPO"
````

Prima di lanciare `gh pr create`, sostituisci nel file i valori fra graffe con quelli misurati, e rileggi il file intero. Annota il numero della PR che `gh` stampa.

- [ ] **Passo 5: CI verde su tutti i job**

```bash
gh pr checks {numero PR} --watch
```

Atteso: ogni job `pass`, compreso `DB migrate (CI)`, che applica la migrazione al DB della CI: la guardia la rende innocua se le colonne mancano.
- Un job `cancelled` del gruppo E2E non è un rosso: succede quando più PR partono di fila, e si rilancia con `gh run rerun {id del run} --failed`, una PR alla volta.
- «CI verde» vuol dire **tutti** i job.

- [ ] **Passo 6: lo stato nel PRD e nella tabella di stato dice «in revisione», e si committa**

Nella voce del Compito 9 la riga **Stato** diventa `🔀 in revisione: PR #{numero}, CI verde, merge a mano del titolare.` Poi la tabella di stato della specifica:

```bash
grep -n "^| 12 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola. In quella riga (mai una riga presa per numero), colonne «Stato», «PR» e «Piano»: `da fare` → `in revisione` (queste parole, non «PR aperta» né «in corso»), `—` → `#{numero}`, `` `s12-chat-leggera` `` → `` `docs/superpowers/plans/2026-10-20-robustezza2-s12-chat-leggera.md` ``. Le «Note» tengono quello che il Compito 1 ci ha scritto. **Mai** «in produzione» su questa riga in questa PR: lo scrive la sessione che apre dopo, eseguendo la sezione «Per la sessione dopo» di questo piano (specifica §5, «La tabella di stato, in due tempi»).

```bash
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Sessione 12 di robustezza 2 in revisione: PRD e tabella di stato

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Poi aspetta di nuovo la CI (Passo 5).

- [ ] **Passo 7: merge — lo fa il titolare, a mano**

Avvisa il titolare con il link della PR, i numeri del Passo 0 e il blocco SQL già nel corpo. **Mai** auto-merge, **mai** `gh pr merge` da chi esegue. Annota l'istante UTC del merge e lo sha:

```bash
gh pr view {numero PR} --json mergedAt,mergeCommit
```

- [ ] **Passo 8: la `SELECT` che conferma la migrazione, e il deploy**

```sql
select version, name
from supabase_migrations.schema_migrations
where name = 'chat_riepilogo_conversazioni';

select p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as autenticato,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as servizio
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'chat_riepilogo_conversazioni';
```

Atteso:
- una riga con `version` = `S12_VERSION`;
- `prosecdef` = `false`, `proconfig` = `{"search_path=public, pg_temp"}`, `anon` = `false`, `autenticato` = `false`, `servizio` = `true`.

Se la prima query non restituisce righe, la migrazione non è stata applicata. **Non** la si applica a mano (`migrazione_in_pr_applicata_dall_integrazione`): si avvisa il titolare. Il codice intanto lavora sul ripiego, e la chat funziona.

```bash
curl -s https://app.kidville.it/api/health/qualita | head -c 400
```

Atteso: `versione` uguale allo sha del commit di merge.

- [ ] **Passo 9: un'ora dopo il deploy, il riepilogo è in uso**

```sql
select contesto->'campi'->>'esito' as esito,
       contesto->'campi'->>'error_code' as codice,
       sum(occorrenze) as volte,
       max(visto_l_ultima) as ultima
from app_log
where sorgente = 'server' and evento = 'chat'
  and contesto->'campi'->>'esito' like 'riepilogo-%'
  and visto_l_ultima >= '{istante del merge, UTC}'
group by 1, 2
order by volte desc;
```

Atteso: nessuna riga, oppure solo `riepilogo-non-installato` con `ultima` entro 15 minuti dal merge (la schema cache di PostgREST). Le altre due possibilità:
- se `riepilogo-non-installato` continua oltre 15 minuti, **ci si ferma**. `NOTIFY pgrst, 'reload schema'` è una scrittura e si fa solo col sì del titolare, mostrandogli prima l'istruzione;
- se compare `riepilogo-rpc-fallito` o `riepilogo-forma-inattesa`, si annota `codice` e `volte` e si avvisa il titolare. La lista funziona sul ripiego; il ritorno indietro è una sua decisione.

Con il riepilogo in uso, si fa la pulizia del ramo della sessione:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s12-chat-leggera
git -C /Users/lerri/kidville-web branch -D robustezza2/s12-chat-leggera
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s12-chat-leggera
```

Si cancellano solo il ramo e il worktree di questa sessione. I rami con una PR aperta di altre sessioni **non** si toccano. Niente rami di soli documenti dopo il rilascio: la riga di stato a «in produzione», il commit di `main`, la fotografia delle migrazioni, la misura «dopo» e lo Stato nel PRD li scrive la sessione dopo, dalla sezione «Per la sessione dopo» in fondo a questo piano.

- [ ] **Passo 10: la misura «dopo» — dove sta e quando matura**

La misura «dopo» (la Prova della specifica: richieste per `GET` ≤ 5, errori realtime separati fra interruzioni e riconnessioni) si fa sul **primo giorno feriale intero dopo il deploy**, da 00:00 a 24:00 UTC: **matura alle 00:00 UTC del giorno seguente**. Le query, l'atteso e chi le scrive stanno nella sezione «Per la sessione dopo», punto 2: le esegue la sessione dopo, se a quel momento apre; altrimenti la prima PR che tocca la specifica dopo quel giorno. Questa sessione non apre rami per scriverla. Se il titolare vuole i numeri prima, chi esegue può lanciare le stesse query in sola lettura e riferirglieli, senza scriverli nel repository.

---

## Ritorno indietro

**Subito:** il titolare fa l'Instant Rollback di Vercel al deploy precedente. La funzione resta nel database ed è innocua: il codice di prima non la chiama. Nessun dato è cambiato.

**Poi, la PR di revert.** Su un ramo nuovo, da `origin/main` con l'albero pulito. Il ramo sta **fuori** dal prefisso `robustezza2/`: la chiusura della precedente cerca la PR `robustezza2/` mergiata per ultima e ne apre il piano, e un `robustezza2/s12-revert` la manderebbe a un piano che non esiste (specifica §5: nessun altro nome di ramo nella serie). La sezione «Per la sessione dopo» controlla proprio questo ramo prima di scrivere «in produzione».

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web worktree add -b revert/s12-chat-leggera /Users/lerri/kidville-web-s12-revert origin/main
cd /Users/lerri/kidville-web-s12-revert && git revert --no-edit {sha del commit di merge della PR}
```

Il revert toglie anche il file della migrazione. La funzione **resta** nel database: il registro delle migrazioni ha la sua riga, e il lock `migrazioni-complete` («ogni migrazione applicata ha il suo file») diventerebbe rosso. Le strade sono due:
- **tenere il file** e la funzione: nella PR di revert si riporta il file con `git checkout {sha del merge} -- supabase/migrations/<S12_VERSION>_chat_riepilogo_conversazioni.sql`. È la strada consigliata, perché la funzione è innocua;
- **toglierla**, solo se lo chiede il titolare: si tiene il file e si aggiunge una migrazione **nuova** con la version da `date -u +%Y%m%d%H%M%S`, il cui contenuto è il blocco ROLLBACK dell'intestazione (`DROP FUNCTION IF EXISTS public.chat_riepilogo_conversazioni(uuid);`). Mai applicata a mano, e prima si riconta `enrollment_submissions`.

Poi gate (Compito 10, Passo 1), PR con un corpo che dice cosa torna indietro e perché, CI verde su tutti i job (Passo 5) e merge a mano del titolare (Passo 7). La riga della sessione 12 nella tabella di stato non si tocca qui: la chiude la sessione dopo, che trova il ramo `revert/s12-chat-leggera` mergiato («Per la sessione dopo», punto 4). Il PRD riceve una voce datata che dice cosa è tornato com'era e perché.

**Tornare indietro su un pezzo solo.** Con lo squash i compiti non sono commit separati su `main`. Su un ramo nuovo si riportano i file alla versione di prima del merge:

```bash
git checkout {sha del commit di main prima del merge} -- {percorso del file}
```

Quattro casi tipici:
- **Il 1006 nasconde troppo:** si riportano `src/components/features/chat/useChatRealtime.ts` e `__tests__/components/useChatRealtime-canale.test.ts`; `src/lib/chat/esito-1006.ts` e il suo test si tolgono nello stesso commit.
- **La finestra del dispatch ritarda una push:** si riportano `src/app/api/chat/messages/route.ts` e il suo test; `finestra-dispatch` si toglie.
- **Il riepilogo dà una lista diversa:** si riporta solo la `GET` di `src/app/api/chat/threads/route.ts` **senza** `marcaConsegnati`, cioè il percorso di ripiego senza la chiamata `rpc`. La consegna resta alla POST.
- **Il client e la consegna non tornano da soli.** Il client di prima si aspetta che la GET consegni, e il server nuovo non lo fa più. Riportare solo il client lascerebbe i messaggi senza doppia spunta fino a `/api/notifiche`. Client e `GET` tornano insieme, oppure non torna nessuno dei due.

**Cosa si riperde tornando indietro:** le ~150 richieste per GET, due volte ogni 30 s, e l'UPDATE a ogni lista. Prima di farlo si rilancia il Passo 0.4 per avere il numero in mano.

---

## Per la sessione dopo

Questa sezione la esegue **chi apre la prima sessione dopo il rilascio della 12**, quando il suo Compito 1 trova `robustezza2/s12-chat-leggera` come PR `robustezza2/` mergiata per ultima, nel **primo commit** della sua sessione, dal suo worktree. Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Sulla produzione si fanno **solo letture** (`execute_sql` e `query_logs`, solo `SELECT`); si scrive solo nel repository. Mai un testo di messaggio della chat: si leggono solo conteggi, codici e gettoni di log a cardinalità chiusa.

Il numero e l'istante del merge della sessione 12, e il commit di `main`, che servono sotto:

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s12-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git log origin/main --oneline --grep "(#<numero stampato sopra>)" | head -1
```

**1. La migrazione e la sua fotografia.** La sessione 12 ha una migrazione: `<version>_chat_riepilogo_conversazioni.sql`. Prima si conferma che l'integrazione l'ha applicata con la version del file:

```bash
git ls-tree --name-only origin/main supabase/migrations/ | grep "_chat_riepilogo_conversazioni\.sql$"
```

```sql
select version, name
from supabase_migrations.schema_migrations
where name = 'chat_riepilogo_conversazioni';
```

Atteso: un file, e una riga con la stessa version del nome del file. Se la query non restituisce righe, o la version è diversa, **fermati** e avvisa il titolare: la migrazione non si applica mai a mano, e una version diversa da quella del file è il caso descritto in `migrazione_in_pr_applicata_dall_integrazione` (la memoria del progetto).

Poi la fotografia delle migrazioni:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql`, in sola lettura, salva la risposta JSON in `${TMPDIR:-/tmp}/chiusura-s12-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/chiusura-s12-migrazioni.json"
grep -c '"name": "chat_riepilogo_conversazioni"' __tests__/fixtures/migrazioni-applicate-snapshot.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -6
```

Atteso: `1`, poi `Test Files  2 passed (2)`.

**Nient'altro da rigenerare né da togliere.** La migrazione crea solo una funzione: niente policy, indici unici, chiavi esterne, colonne `scuola_id`, bucket. Nessun'altra fotografia si rigenera per la sessione 12, e la sessione 12 non ha aggiunto voci a `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) né ad altre liste «fino alla chiusura».

**2. La misura «dopo» (la Prova della specifica).** Si fa sul **primo giorno feriale intero dopo l'istante del merge**, da 00:00 a 24:00 UTC, e **matura alle 00:00 UTC del giorno seguente**. Prima di quel momento non si scrive niente: si scrive solo «misura dopo: matura dal <giorno> 00:00 UTC» nelle «Note» della riga della sessione 12, e la scrive la prima PR che tocca la specifica dopo quel giorno. I log di Supabase si tengono pochi giorni: se quel giorno non è più leggibile con `query_logs`, si usa l'ultimo giorno feriale intero ancora leggibile, e si scrive quale.

I numeri «prima» per il confronto stanno nella voce del PRD della sessione 12, al punto «Misura prima» (`grep -n "Robustezza 2, sessione 12" "PRD REGISTRO ELETTRONICO.md"`).

(a) **Richieste al database per una `GET` della lista.** Con `query_logs`, finestra di quel giorno (`iso_timestamp_start` 00:00, `iso_timestamp_end` 24:00 UTC):

```sql
select
  countIf(v = 'GET'   and p = '/rest/v1/chat_threads'  and position(s, 'order=last_message_at.desc') > 0) as liste,
  countIf(v = 'GET'   and p = '/rest/v1/chat_messages' and position(s, 'select=content%2Csender_id%2Ccreated_at') > 0) as ultimi_messaggi,
  countIf(v = 'GET'   and p = '/rest/v1/conversazioni_sospensioni' and position(s, 'select=thread_id%2Csospesa_da%2Csospesa_verso%2Cmotivo%2Csospesa_il') > 0) as sospensioni,
  countIf(v = 'PATCH' and p = '/rest/v1/chat_messages' and position(s, 'delivered_at=is.null') > 0) as consegne,
  countIf(v = 'POST'  and p = '/rest/v1/rpc/chat_riepilogo_conversazioni') as riepiloghi
from (
  select toString(log_attributes['request.method']) as v,
         toString(log_attributes['request.path']) as p,
         toString(log_attributes['request.search']) as s
  from logs
  where source = 'edge_logs'
    and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
)
```

Se `liste`, `ultimi_messaggi` e `sospensioni` escono tutti a 0 insieme, la chiave `request.search` può essersi chiamata `request.url`: si sostituisce `toString(log_attributes['request.search'])` con `toString(log_attributes['request.url'])` e si rilancia.

(b) **Errori del realtime per giorno** (client, 14 giorni):

```sql
select giorno,
  coalesce(sum(occorrenze) filter (where messaggio = 'chat-realtime-errore: socket-chiuso-1006'), 0) as errori_1006,
  coalesce(sum(occorrenze) filter (where messaggio like 'chat-realtime-errore:%'
                                     and messaggio <> 'chat-realtime-errore: socket-chiuso-1006'), 0) as altri_errori,
  coalesce(sum(occorrenze) filter (where messaggio like 'chat-realtime-rientrato:%'), 0) as rientri
from app_log
where sorgente = 'client'
  and giorno >= (now() at time zone 'utc')::date - 14
group by giorno
order by giorno;
```

(c) **I giri anticipati del dispatch** (server, 7 giorni):

```sql
select giorno, contesto->'campi'->>'esito' as esito, sum(occorrenze) as volte
from app_log
where sorgente = 'server'
  and evento = 'push'
  and contesto->'campi'->>'esito' like 'dispatch-anticipato-%'
group by 1, 2
having giorno >= (now() at time zone 'utc')::date - 7
order by 1, 2;
```

(d) **Il riepilogo è in uso, non il ripiego:**

```sql
select contesto->'campi'->>'esito' as esito,
       contesto->'campi'->>'error_code' as codice,
       sum(occorrenze) as volte,
       max(visto_l_ultima) as ultima
from app_log
where sorgente = 'server' and evento = 'chat'
  and contesto->'campi'->>'esito' like 'riepilogo-%'
  and visto_l_ultima >= '<istante del merge, UTC>'
group by 1, 2
order by volte desc;
```

**Atteso** (specifica §7, «Sessione 12», «Prova»):
- `riepiloghi` dello stesso ordine delle `liste` di prima; `liste` e `ultimi_messaggi` vicini a 0 (solo i ripieghi);
- richieste al database per `GET` = `(riepiloghi + sospensioni) / riepiloghi` **≤ 5** (dal codice 2; prima ~150 con 37 conversazioni);
- `consegne` più basse di prima;
- per i giorni feriali, `errori_1006` più bassi di prima e `rientri` presenti: le due serie separano interruzioni vere e riconnessioni. **Osservato** e **causa probabile** si scrivono separati;
- `dispatch-anticipato-gia-programmato` presente, `dispatch-anticipato-superfluo` in proporzione più basso di prima;
- in (d) nessuna riga, oppure solo `riepilogo-non-installato` entro 15 minuti dal merge.

Se le richieste per `GET` sono sopra 5, o (d) mostra `riepilogo-rpc-fallito` / `riepilogo-forma-inattesa`, si scrivono i numeri osservati nelle «Note» e si avvisa il titolare: non si corregge niente dentro la chiusura.

**3. Da sapere, nessuna azione qui: cosa la sessione 12 lascia alla 14.** Dalla sessione 12 la `GET` di `src/app/api/chat/threads/route.ts` chiama la RPC `public.chat_riepilogo_conversazioni(p_utente uuid)`: `STABLE`, `SECURITY INVOKER`, `search_path` fisso, `EXECUTE` solo a `service_role`, con ripiego sul percorso di prima. La sessione 14 la mette nel suo lock. In più esiste una route nuova, `POST /api/chat/threads/consegnati` (`src/app/api/chat/threads/consegnati/route.ts`), esentata nel lock `isolamento-sede-coverage` con lo scope della `GET`.

**4. La riga di stato.**

```bash
grep -n "^| 12 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Prima, un controllo: la sessione 12 non deve essere tornata indietro.

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:revert/s12-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: nessuna riga. Se ne stampa una, la PR di revert (ramo `revert/s12-chat-leggera`, sezione «Ritorno indietro») è in `main`: «Stato» resta `in revisione`, in coda alle «Note» si scrive «tornata indietro, PR #<numero del revert>», i punti sotto si saltano e si avvisa il titolare. La fotografia del punto 1 resta comunque: la funzione è nel database anche dopo il revert.

Nella riga trovata (mai per numero di riga): «Stato» `in revisione` → `in produzione`; in coda alle «Note», il commit di `main` (`` commit `<sha corto>` ``), la conferma della migrazione del punto 1 (version e ora UTC della `SELECT`) e, se matura, la misura del punto 2 con giorno, ora UTC e finestra.

**5. Il PRD.** La voce `## 🛡️ Changelog — Robustezza 2, sessione 12: la chat leggera` (si trova con `grep -n "Robustezza 2, sessione 12" "PRD REGISTRO ELETTRONICO.md"`): la riga **Stato** diventa `✅ in produzione dal <giorno> (PR #<numero>, commit <sha corto>); migrazione applicata dall'integrazione, verificata alle <ora> UTC; fotografia rigenerata.`; se la misura del punto 2 è matura, il punto «Da fare dopo il merge» diventa «**Misura dopo** (<giorno e ora UTC>, finestra …)» con i numeri osservati.

---

## Autorevisione (fatta alla stesura, da ripetere alla fine)

**Copertura della §7, sessione 12 (righe 701-729), della §5 (righe 133-197) e della §6, «Apertura e chiusura» (righe 237-243), nella specifica riletta la sera del 20/10:**

| Specifica | Dove |
|---|---|
| Obiettivo: l'elenco costa poche query, non ~4 per conversazione ogni 30 s | Compiti 2-3 (una chiamata) e 6 (un orologio) |
| Misura prima: richieste al DB per una `GET` (~150 con 37) | Passo 0.2 (N) e 0.3-0.4 (rapporto dai log, con sonda delle chiavi); formula nelle «Scelte», punto 9 |
| Misura prima: `chat-realtime-errore%` per giorno feriale (288–378) | Passo 0.5, separato in `1006`, altri, rientri |
| `threads/route.ts:43-176` (la `GET`): RPC di riepilogo; su `PGRST202`/`42883` ripiego con riga `info`, su ogni altro guasto o forma inattesa ripiego con riga `error` | Compito 2 (migrazione, PGlite) e 3 (route, `RPC_RIEPILOGO_ASSENTE` sul modello `RPC_ASSENTE`; `esitoRiepilogo`) |
| L'`UPDATE` esce dalla `GET` e diventa una richiesta esplicita | Compito 3 (tolto, provato «nessun update») e 4 (`POST /api/chat/threads/consegnati`) |
| `useConversazioneChat.ts:242-247,674`: un poller solo | Compito 6 |
| `messages/route.ts:110-198` (`programmaDispatchChat`): un solo dispatch per finestra di 30 s, per conversazione e per istanza | Compito 7 |
| `useChatRealtime.ts:301-310`: un `1006` seguito da riconnessione riuscita non si scrive; dopo 60 s ancora giù resta il `warn` | Compito 8, e «Scelte», punto 8 |
| Decisioni del titolare chieste al Compito 1 (esente nuova nel lock, uno in più del numero lasciato dalla sessione 2; finestra per conversazione; `1006` rientrato non scritto) | Compito 1, Passo 7; «Decisioni che restano al titolare», 1-3 |
| Effetto visibile: i messaggi nati prima di `delivered_at` non ricevono più la doppia spunta all'apertura dell'elenco | Compito 4 (commento di `/api/notifiche`); decisione 5 |
| Rischio: contatori dei non letti sbagliati | Compito 2 (non letti su PGlite), 6 (somma, `segnaLetti`, raffica col server che conta), lock dello store nel contatore-chat |
| Rischio: notifiche della chat in ritardo | Compito 7: la finestra si chiude prima di leggere la coda; tre test sulla riapertura |
| Indietro: revert; la RPC è innocua | «Ritorno indietro», con il caso del file di migrazione e del lock |
| Prova: da ~150 a ≤ 5; errori separati fra interruzioni vere e riconnessioni | Compito 3 (test: 2 chiamate con 37 thread); la misura sta in «Per la sessione dopo», punto 2 |
| §5: un ramo per volta, merge a mano, `SELECT` di conferma, pulizia | Compito 1 (Passi 2-3) e 10 (Passi 7-9) |
| §5 e §6: prerequisiti (colonna «Dopo» vuota: solo nessuna PR `robustezza2/` aperta, salvo `-esito`) | Compito 1, Passo 2 |
| §5 e §6: chiusura della sessione rilasciata per ultima nel primo commit, con la fotografia delle migrazioni | Compito 1, Passo 6 |
| §5: tabella di stato in due tempi («in revisione» qui, «in produzione» dalla sessione dopo) | Compito 10, Passo 6; «Per la sessione dopo», punto 4 |
| §6: la sezione «Per la sessione dopo» | «Per la sessione dopo» (migrazione e fotografia, misura che matura, la RPC per la 14, riga di stato, PRD) |
| §5: riferimenti al codice per contenuto; riga di stato trovata col grep sul numero della sessione | Compiti 1, 4 (lock d'isolamento per nome) e 10 |
| §5: codice che regge il merge (`PGRST202`, `42883`, solo su quella chiamata) | Compito 3, `esitoRiepilogo` |
| §5: ROLLBACK nell'intestazione, migrazione nuova solo in un revert | Compito 2 (intestazione) e «Ritorno indietro» |
| §5: `enrollment_submissions` prima della migrazione, nel PRD con data e ora | Passo 0.1, Compito 10 Passo 3, Compito 9 |
| §5: gate con `CI=1` e heap a 8192; mai E2E in locale | Compiti 1 e 10 |
| §5: repository pubblico, dati di minori | Passo 0 solo conteggi e gettoni; test con dati finti; log senza testi |

**Segnaposto.** Nessuna parte rimandata. Le parentesi graffe stanno solo nei valori che si misurano (Passo 0, numero della PR, sha, istanti, contatori letti al Compito 1), come nel modello della sessione 11.

**Coerenza dei nomi:**
- Compito 2: `public.chat_riepilogo_conversazioni(p_utente uuid)`, il file `<S12_VERSION>_chat_riepilogo_conversazioni.sql`, la riga `S12_VERSION` nel file delle misure.
- Compito 3: `RPC_RIEPILOGO_ASSENTE`, `esitoRiepilogo`, `EsitoRiepilogo`, `RigaRiepilogo` e la chiusura `sospensioniAttive`.
- Compito 4: `chat/threads/consegnati:POST`, `bodySchema`, la risposta `{ consegna: 'ok' | 'fermati' }`.
- Compito 5:
  - `scaricaListaConversazioni` ed `EsitoListaConversazioni`;
  - `annunciaNonLetti`, `totaleNonLetti`, `TITOLO_NOTIFICA_CHAT`, `TITOLO_PAGINA` e `ThreadNonLetti`;
  - `URL_CONSEGNA`, `fotografiaNonLetti`, `serveConsegna`, `inviaConsegna` e `ThreadConsegna`.
- Compito 6: `RITMO_LISTA_NASCOSTA_MS`, `nonLettiServerRef`, `totaleAnnunciatoRef`, `consegnaRef`, `chiediConsegna`, `applicaLista`, più `scaricaThreads` e `riprovaThreads` riscritte.
- Compito 7: `apriFinestraDispatch`, `chiudiFinestraDispatch`, `azzeraFinestreDispatch` e `MARGINE_FINESTRA_MS`.
- Compito 8:
  - in `src/lib/chat/esito-1006.ts`: `MOTIVO_1006`, `ATTESA_ESITO_1006_MS`, `decidiLogErroreCanale` e `decidiScadenza1006`;
  - in `useChatRealtime.ts`: `annullaRinvio`, `armaRinvio1006` e `rinvio1006Ref`.
- Nei test nuovi il parametro HTTP si chiama `verbo`.

---

## Decisioni che restano al titolare

Le prime tre si chiedono al Compito 1, Passo 7. Il piano è scritto per il «sì».

1. **Una voce nuova in `AMMESSE` del lock d'isolamento** per `chat/threads/consegnati:POST`, con `handlerEsentati` che sale di 1: uno in più del numero che la sessione 2 lascia (107 → 108). Il numero vero è quello letto al Compito 1, Passo 8, e il Compito 4 parte da lì. Il commento del lock dice che quel numero «cala solo quando un debito viene pagato». Qui non si toglie un presidio: l'UPDATE esce da una route già esentata, con lo stesso scope. L'alternativa è non fare la POST e lasciare la consegna a `/api/notifiche` (`consegnaSeInAttesa`, con il suo limite temporale) e a `chat/messages`. In quel caso però la §7 («diventa una richiesta esplicita») non sarebbe soddisfatta.
2. **La finestra del dispatch è per conversazione e per istanza**, non «per sede» come diceva il rapporto: una finestra condivisa vorrebbe una tabella o un lock nel database. Fra istanze diverse resta la difesa di oggi (presa atomica, giro «superfluo»).
3. **Il 1006 che rientra non si scrive affatto**, perché lato client non c'è un `info` persistito. La riconnessione resta contata da `chat-realtime-rientrato`, e l'interruzione vera resta un `warn`, non un `error`. L'attesa è di 60 s; a pagina nascosta il log aspetta che la pagina torni visibile, e se la scheda si chiude prima non si scrive mai.
4. **`trasporto` (1.300 in 7 giorni il 20/10) resta fuori dal rinvio.** È la serie più grande, ma il suo meccanismo è un altro. Un rinvio anche per lei è una decisione separata, da prendere dopo la misura «dopo».
5. **I messaggi nati prima della colonna `delivered_at`, già letti e mai consegnati**, non ricevono più la doppia spunta all'apertura della lista. La riceveranno alla prima consegna esplicita di quel thread, cioè quando arriva un non letto. Sono messaggi già letti dal destinatario.
6. **Il 500 della `GET` nel ripiego espone ancora `error.message`** (`threads/route.ts:63` il 20/10, `return NextResponse.json({ error: error.message }, { status: 500 });` dopo la lettura di `chat_threads`). Resta com'era: la specifica (§7, «Sessione 13») vuole che le risposte `error.message` delle route autenticate si sistemino quando una sessione **successiva alla 13** tocca il loro file, con la funzione che la 13 introduce, e che le sessioni prima della 13 non le tocchino. Il numero di risposte senza `codice` del file resta 5 (`errori-con-codice` e la sua allowlist).
7. **`NOTIFY pgrst, 'reload schema'`** si lancia solo col sì del titolare, se dopo 15 minuti dal merge la funzione risulta ancora «non installata» (Compito 10, Passo 9).
8. **I due `try/finally` rimasti** in `caricaPrecedenti` e `invia` tengono spento il compilatore di React su tutto `useConversazioneChat`. Si scrive nel PRD come osservato; toglierli è un lavoro a parte.
