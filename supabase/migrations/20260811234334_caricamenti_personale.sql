-- =============================================================================
-- IL REGISTRO DEI CARICAMENTI — l'oggetto che nessuna riga nomina ancora
--
-- ✅ APPLICATA il 2026-08-12, version `20260811234334`.
--    Verificato DOPO: la tabella c'è con RLS attiva e ZERO policy (solo service_role),
--    l'indice parziale sui sospesi c'è, `get_advisors(security)` → 0 ERROR e nessun WARN
--    nuovo. Prima dell'apply la tabella non esisteva mentre il bucket sì: era esattamente
--    lo stato descritto qui sotto, e ora non lo è più.
--
-- (storia) Questo file era stato scritto Scritta dall'agente che ha realizzato le due rotte pubbliche
--    di `/anagrafica-personale`, che non ha (e non deve avere) il permesso di
--    scrivere sullo schema di produzione. La applica chi rilascia, con lo
--    strumento MCP `apply_migration` + `get_advisors` (0 ERROR), e attesta qui in
--    testata la data con una riga «APPLICATA il AAAA-MM-GG».
--
--    ⚠️ IL NOME DEL FILE È PROVVISORIO (`20260811234334`) e va rinumerato con la
--    versione che lo strumento registra davvero in
--    `supabase_migrations.schema_migrations`: un file il cui nome non coincide
--    viene riapplicato dal `db push` successivo. Vale anche per le due sorelle
--    scritte in parallelo con lo stesso prefisso finto (`…999900`, `…999999`).
--    Questa deve restare DOPO `20260811205643_anagrafica_personale.sql`, che crea
--    `pratiche_personale` e il bucket `documenti_personale`.
--
--    ⚠️ E SUBITO DOPO AVERLA APPLICATA VA RIGENERATA LA FOTOGRAFIA DELLA RLS,
--    UNA VOLTA SOLA:
--        node scripts/rls-fotografia.mjs --sql
--        → esegui la query sul DB di produzione (sola lettura)
--        → node scripts/rls-fotografia.mjs < risposta.json
--    Questo file accende la RLS su una tabella nuova, quindi
--    `__tests__/architecture/rls-per-sede.test.ts` lo elenca come «posteriore alla
--    fotografia» e resta ROSSO finché lo scatto non comprende la tabella. L'ordine
--    non è invertibile: rigenerare PRIMA di applicare farebbe tacere il guard su uno
--    stato che non esiste — cioè lo renderebbe verde a vuoto, che è precisamente il
--    difetto contro cui quel guard è stato riscritto il 2026-08-04. Rigenerarla una
--    volta sola, alla fine, copre anche le due sorelle applicate nello stesso giro.
--
--    ⚠️ E PERCHÉ NON È RINVIABILE — misurato in produzione il 2026-08-12:
--        select ... from pg_class ... where relname='caricamenti_personale'  → 0
--        select count(*) from storage.buckets where id='documenti_personale' → 1
--    Cioè il BUCKET C'È GIÀ (lo crea `20260811205643`, applicata) e la tabella no.
--    Non sono due stati che viaggiano insieme, ed è l'esatto stato in cui le due
--    rotte pubbliche degradano peggio: `caricamentoReclamabile` risponde
--    `{ammesso: true, degradato: true}` per costruzione, quindi il punto 9-bis del
--    POST non verifica né che l'oggetto ESISTA né che sia di nessun altro — cioè
--    restano aperti tutti e due i buchi che la testata di quella rotta dichiara
--    chiusi, compreso quello che porta la Segreteria di un plesso a farsi firmare
--    il documento d'identità di una persona che non è sua. E il fallimento è
--    SILENZIOSO per chi compila (201 regolare): si vede solo interrogando `app_log`.
--    Dal 2026-08-12 la rotta di CARICAMENTO non degrada più aperta — col registro
--    assente ritira l'oggetto e risponde 500, invece di lasciare nel bucket una
--    carta d'identità che nessuna riga nomina — ma quello è un fail-loud, non una
--    riparazione: finché questa migrazione non è applicata il modulo non funziona.
--
-- ─── IL DIFETTO CHE CHIUDE, E NON È UN CASO DI ABUSO ────────────────────────
--
-- Il modulo `/anagrafica-personale` è un wizard di quattro passi. La scansione
-- del documento d'identità si carica al TERZO
-- (`POST /api/iscrizione/personale/upload`, che scrive subito nel bucket e
-- restituisce il percorso); i consensi e l'invio stanno al QUARTO
-- (`POST /api/iscrizione/personale`, che è ciò che crea la riga in
-- `pratiche_personale`).
--
-- Quindi CHIUNQUE carichi e poi chiuda la pagina lascia la fotografia della
-- propria carta d'identità nel bucket, a tempo indeterminato:
--   · senza il nome del file, che la rotta di caricamento butta via apposta
--     (il nome è quasi sempre `carta-identita-<cognome>.pdf`);
--   · e senza NESSUNA riga che dica di chi sia — cioè nemmeno identificabile per
--     cancellarla se quella persona la chiedesse.
--
-- È lo stato che `src/app/api/gdpr/retention-personale/route.ts` chiama, con
-- parole sue, «il modo peggiore di conservare un dato personale»: là quel ramo è
-- difeso con un `return` e un log a livello `error`, mentre qui lo stesso stato
-- si CREAVA per costruzione a ogni modulo abbandonato. E la retention non poteva
-- vederlo: parte da `pratiche_personale` e `anagrafica_personale`, quindi guarda
-- solo gli oggetti GIÀ referenziati, mai quelli orfani.
--
-- C'è anche una promessa scritta da mantenere. Il terzo consenso che
-- l'interessata spunta (`presa_visione_copia_documento`, testo in
-- `src/lib/forms/personale-template.ts`, archiviato con la sua versione dentro
-- `pratiche_personale.consents_log`) dice che la copia «è cancellata entro 12
-- mesi dalla cessazione del rapporto, ed entro 90 giorni se questa richiesta non
-- viene approvata». Per un oggetto orfano NESSUNO dei due termini decorre mai:
-- non c'è né una pratica né una cessazione da cui contare.
--
-- ─── PERCHÉ UN REGISTRO E NON UNA SCANSIONE DELLO STORAGE ──────────────────
--
-- L'altra strada era spazzare il bucket: elencare `documenti/` e togliere ciò che
-- nessuna riga nomina. Non regge, per come è fatto il percorso — che è
-- `documenti/<uuid>/<uuid>.<ext>`, due livelli, un oggetto per cartella. La
-- Storage API elenca UN prefisso per volta: `list('documenti')` restituisce le
-- CARTELLE, e per sapere cosa c'è dentro servirebbe una chiamata per ognuna.
-- Cioè N+1 richieste per un lavoro notturno, dove N cresce con ogni caricamento
-- mai completato: il lavoro comincerebbe a scadere proprio quando ha più da fare.
--
-- Il registro trasforma quella scansione in una `select` su un indice parziale, e
-- in più — è la parte che conta davvero — dà all'oggetto orfano UNA RIGA CHE LO
-- NOMINA. Senza, «cancellatemi la copia del documento» non ha una risposta
-- eseguibile.
--
-- ─── L'INVARIANTE: UN OGGETTO, UN PROPRIETARIO ─────────────────────────────
--
-- `20260811205643` lo dichiara come un fatto, nel commento su
-- `pratiche_personale.documento_path`: «Un oggetto, un proprietario — è ciò che
-- impedisce alla retention della pratica di cancellare il file che l'anagrafica
-- sta ancora usando». Nessuno però lo IMPONEVA: su quella colonna non c'è nessun
-- vincolo di unicità (solo `check length <= 200`), e la rotta pubblica accettava
-- il percorso guardandone la sola FORMA. Due pratiche potevano nominare lo stesso
-- oggetto, e la retention della prima avrebbe cancellato il file che la seconda
-- stava ancora usando.
--
-- Qui la chiave primaria su `percorso` insieme a `pratica_id` rende
-- l'appropriazione una cosa sola e verificabile: un percorso già collegato a una
-- pratica non è più reclamabile da nessun'altra. Ed è la stessa lettura che
-- dimostra che l'oggetto ESISTE davvero — il campo è `required: true` nel
-- template, ed è la ragione per cui il modulo esiste, ma senza registro si
-- soddisfaceva con una stringa inventata, la cui forma è per giunta documentata
-- in un repository PUBBLICO.
-- =============================================================================

create table if not exists public.caricamenti_personale (
  -- Il percorso È la chiave: un oggetto dello Storage è identificato da quello e
  -- da nient'altro, e una chiave surrogata avrebbe permesso due righe per lo
  -- stesso file — cioè avrebbe riaperto in tabella il difetto che questa tabella
  -- chiude.
  --
  -- Il `check` ripete i due vincoli che la rotta applica già in TypeScript
  -- (prefisso dedicato e tetto di 200 caratteri, lo stesso di
  -- `pratiche_personale.documento_path`). Non è ridondanza: qui il valore lo
  -- scrive una porta ANONIMA, e un vincolo che vive solo nell'applicazione vale
  -- finché ogni strada se lo ricorda.
  percorso    text primary key
              check (percorso like 'documenti/%' and length(percorso) <= 200),

  -- Da qui decorre la scadenza dell'oggetto NON reclamato. È l'istante del
  -- caricamento, non quello dell'invio: sono due momenti diversi ed è esattamente
  -- la loro distanza il buco che si sta chiudendo.
  caricato_il timestamptz not null default now(),

  -- NULL = nessuno l'ha ancora reclamato ⇒ l'oggetto è orfano e va spazzato.
  --
  -- `on delete cascade` e non `set null`: quando la conservazione cancella la
  -- pratica cancella anche il suo file, quindi la riga di registro non ha più
  -- niente da sorvegliare. Con `set null` tornerebbe «in sospeso» e la spazzata
  -- successiva cercherebbe di togliere un oggetto già tolto — non un danno, ma un
  -- lavoro che si ripresenta identico per sempre.
  --
  -- ⚠️ E NON si torna «in sospeso» all'APPROVAZIONE, che è il caso su cui è
  -- facile sbagliarsi: là `pratiche_personale.documento_path` torna NULL e
  -- l'anagrafica punta allo stesso oggetto, ma la RIGA della pratica resta. Il
  -- collegamento regge, e la spazzata continua a non vedere quel file — che è
  -- l'esito voluto, perché quel file adesso è di `anagrafica_personale`.
  pratica_id  uuid references public.pratiche_personale(id) on delete cascade
);

-- L'indice che la spazzata percorre. PARZIALE: le righe già collegate a una
-- pratica non le servono mai, e sono destinate a diventare la maggioranza.
create index if not exists caricamenti_personale_sospesi_idx
  on public.caricamenti_personale (caricato_il)
  where pratica_id is null;

-- RLS ABILITATA SENZA POLICY = solo service_role, come `pratiche_personale`.
-- Questa tabella è un elenco di percorsi verso fotografie di documenti
-- d'identità: è la CHIAVE con cui si firma ognuno di quegli oggetti, e non deve
-- essere leggibile da nessuna sessione autenticata, nemmeno da una docente.
alter table public.caricamenti_personale enable row level security;

comment on table public.caricamenti_personale is
  'Registro dei file caricati dal modulo pubblico /anagrafica-personale nel bucket privato documenti_personale. Esiste perché la scansione si carica al terzo passo del wizard e la pratica nasce al quarto: senza questo registro un modulo abbandonato lasciava nel bucket la fotografia di una carta d''identità che nessuna riga nominava — invisibile, non cancellata, e nemmeno identificabile per cancellarla su richiesta. Una riga con pratica_id NULL è un oggetto che nessuno ha ancora reclamato: si spazza dopo poche ore. Solo service_role: RLS abilitata senza policy.';

comment on column public.caricamenti_personale.percorso is
  'Percorso nel bucket documenti_personale, nella forma documenti/<uuid>/<uuid>.<ext> che produce SOLO iscrizione/personale/upload:POST. È chiave primaria, e questo è ciò che impone l''invariante «un oggetto, un proprietario» dichiarata nel commento di pratiche_personale.documento_path e che prima non era imposta da nessuna parte.';

comment on column public.caricamenti_personale.pratica_id is
  'La pratica che ha reclamato questo oggetto. NULL = in sospeso: nessuno lo nomina, e la spazzata lo toglie dal bucket insieme a questa riga. Valorizzato = l''oggetto ha un proprietario e non è più reclamabile da un''altra pratica.';
