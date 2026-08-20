-- =============================================================================
-- «QUESTA COPIA AL PLESSO È GIÀ PARTITA» — una data, non un booleano.
--
-- ─── PERCHÉ SERVE ────────────────────────────────────────────────────────────
-- Dal 2026-08-20 ogni candidatura recapita al plesso una copia del modulo col
-- curriculum in allegato. Ma le 42 candidature arrivate PRIMA di quel rilascio
-- non l'hanno mai ricevuta, e due di quelle arrivate dopo l'hanno persa per il
-- difetto del destinatario multiplo (PR #94).
--
-- Serve quindi un inoltro dell'arretrato, e un inoltro senza memoria è
-- un'arma puntata sulle caselle delle sedi: due clic = 84 email. Questa colonna
-- è la memoria.
--
-- ─── PERCHÉ UNA DATA E NON UN `boolean` ──────────────────────────────────────
-- `true` dice «è partita». Una data dice «è partita, e quando» — che è ciò che
-- serve quando fra un mese qualcuno chiederà «la sede dice che non le è mai
-- arrivata niente». Un booleano non risponde a quella domanda; `null` e una
-- data la coprono entrambe senza aggiungere una seconda colonna.
--
-- ─── IL BACKFILL, E PERCHÉ NON INDOVINA ──────────────────────────────────────
-- Nessun backfill automatico su base temporale. La tentazione era «tutte quelle
-- dopo le 10:44 di oggi hanno ricevuto la copia», ma NON è vero: le due rivolte
-- a due plessi hanno preso 422 proprio in quella finestra. Una regola che sbaglia
-- su due righe su quattro non è una regola, è una scommessa — e il prezzo di
-- sbagliare qui è una candidatura che nessuno riceve mai.
--
-- Le poche righe provabilmente consegnate vengono marcate UNA PER UNA dalla
-- rotta di inoltro, con l'esito vero del provider in mano. Chi riceve un doppione
-- vede due volte la stessa candidata; chi non riceve niente non sa che esiste.
-- Fra i due errori non c'è simmetria.
-- =============================================================================

alter table public.candidature_insegnanti
  add column if not exists copia_inviata_il timestamptz;

comment on column public.candidature_insegnanti.copia_inviata_il is
  'Istante in cui la copia della candidatura è stata accettata dal provider email per la casella del plesso. NULL = mai partita (o partita e rifiutata). Serve a rendere ripetibile senza danno l''inoltro dell''arretrato: senza, un secondo clic raddoppia le email verso le sedi. Scritta solo dopo un esito positivo vero, mai dedotta da una data.';

-- L'indice serve alla sola domanda che questa colonna riceve: «quali non sono
-- ancora partite?». Parziale, perché le righe già inviate non vanno mai cercate
-- per questa via e tenerle nell'indice sarebbe peso senza lettori.
create index if not exists candidature_insegnanti_copia_da_inviare
  on public.candidature_insegnanti (creata_il)
  where copia_inviata_il is null;

notify pgrst, 'reload schema';
