# Sanatoria dei doppioni di alunni e dell'account orfano — 2026-09-14

> **Documento di una sanatoria GIÀ ESEGUITA**, in produzione, il 2026-09-14 fra le 09:10 e le 09:25 UTC,
> dentro un piano approvato dal titolare. Qui dentro ci sono solo uuid e conteggi: il repository è
> pubblico e i dati dietro queste righe sono di minori.

## Il fatto, in tre righe

Tre segnalazioni dalla segreteria:
- «ci sono due bambini uguali, genitori compresi»;
- «i genitori vedono ancora i bambini che abbiamo tolto dalle classi, con le rette doppie»;
- «non riesco a creare l'account di una dipendente dal suo modulo».

**Le prime due sono lo stesso difetto**: un refuso di **un carattere** nel codice fiscale del
bambino, in una delle due domande che la famiglia aveva inviato. L'import riconosce un bambino solo
per CF identico, quindi il refuso ha fatto nascere un secondo alunno, e a volte un secondo genitore.
Archiviare la copia non la toglie ai genitori: per scelta, l'archiviazione non tocca legami e rette.

**La terza** nasce da un oblio GDPR del 2026-09-02, che ha anonimizzato una scheda genitore creata in
fase di test ma ha lasciato vivi `utenti` e `auth.users`. Quell'account, mai usato, teneva occupata
l'email di una dipendente. L'approvazione della sua pratica del personale si fermava su
`email_gia_genitore` (409).

## Le misure — prima di scrivere

### M1 · Coppie di alunni con CF quasi identico nella stessa sede

Il calcolo di distanza e del carattere di controllo è stato fatto fuori dal database, con un
programma che stampava solo uuid e booleani: nessun CF è mai uscito dal DB in chiaro.

- CF a distanza ≤ 2, nella stessa sede, fra alunni non anonimizzati: **7 coppie**.
- In tutte e 7: distanza **1**, stesso nome, cognome e data di nascita, e **un CF su due col
  carattere di controllo errato**.
- La ricerca per nome e data di nascita trova **8** gruppi: le stesse 7 coppie più un gruppo la cui
  copia archiviata non ha CF, né legami, né rette, e quindi era già pulita.

```sql
-- gruppi per nome + cognome + data di nascita (normalizzati), stessa sede
WITH n AS (
  SELECT id, scuola_id,
         lower(regexp_replace(trim(nome),   '\s+', ' ', 'g')) AS n,
         lower(regexp_replace(trim(cognome),'\s+', ' ', 'g')) AS c,
         data_nascita, stato, section_id
  FROM alunni
  WHERE anonimizzato_il IS NULL
    AND scuola_id NOT IN ('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-00000000d000')
)
SELECT scuola_id, n, c, data_nascita, count(*) FROM n GROUP BY 1,2,3,4 HAVING count(*) > 1;
```

### M2 · Cosa i genitori vedevano

Doppioni già archiviati ma ancora legati a un genitore: **5**, ognuno con la retta di settembre
aperta.
- In 4 famiglie un genitore era collegato **solo** al doppione. Staccare i legami a mano gli avrebbe
  tolto il figlio.
- Una retta fantasma aveva già generato **2 solleciti**.
- **Una retta del doppione risultava PAGATA**: un bonifico riconciliato alle 08:52 UTC dello stesso
  giorno, mentre la retta della copia attiva restava scaduta.

Due coppie avevano **entrambe** le copie attive in classe.

La copia attiva aveva il CF errato in **5 casi su 7**. È il CF che finisce in fattura.

### M3 · L'account che bloccava la pratica del personale

`utenti` `0143f964-22f0-4fe8-93b3-df10dfc1d3db`:
- `ruolo='genitore'`, `last_sign_in_at` NULL;
- nessuna scheda `parents` viva;
- un solo legame, verso un alunno già anonimizzato;
- stessa email della pratica `pratiche_personale` `3edd96a6-ddf2-4f57-9020-a758fadeb6d9` (pending).

Fra i 31 riferimenti NO ACTION/RESTRICT verso `utenti`/`auth.users`, l'unico non vuoto era quel
legame. È **l'unico** account genitore del DB sopravvissuto a un oblio.

## Le coppie

| # | Resta | Doppione | CF valido su | Genitori aggiunti alla copia che resta | Rette del doppione |
|---|---|---|---|---|---|
| 1 | `db671114-f23d-4df7-a347-33bb7e682198` | `113c410d-396a-4650-9af7-5535abe79795` | doppione | 0 | retta **pagata** `bcb1e5e7-c8cf-418d-9120-032a89f24eac` spostata; retta scaduta della copia attiva `74447794-68a4-465d-ac15-fd92f49f8ee3` cancellata |
| 2 | `40365b9c-d43d-4834-9f3e-1c03bb688b4b` | `0a481a4d-85ed-4364-b59d-304eb5073f77` | doppione | 1 | 1 cancellata |
| 3 | `d2154def-daa9-41fa-bca4-8c19e585f837` | `6c974ccf-a13a-4f95-908a-ef87d8f0c899` | resta | 1 | 1 cancellata |
| 4 | `19ab9ebe-f3b7-4f90-be82-4f8c308b7a5c` | `a9ee80bf-0872-467b-9a78-4e4a690a402b` | resta | 1 | 1 cancellata |
| 5 | `87ffcaf1-8362-4790-baad-66eaa715b144` | `884c1e15-1acc-4149-a7ec-2489a0f1fc07` | doppione | 0 | 1 cancellata (con 2 solleciti, in CASCADE) |
| 6 | `ca65df18-ada4-4246-a566-cc41e9a7c635` | `f7af3a6f-25bd-4449-8f1e-d0c0e16f6b33` *(era attivo)* | doppione | 1 | 1 cancellata |
| 7 | `91f3274c-8ec8-4f95-b358-d97811690be1` | `2398f8db-ec83-4c18-a750-a7adb6be1787` *(era attivo)* | doppione | 0 | 1 cancellata |

Coppia 7: si è eliminata anche la scheda genitore doppia `eac419cd-02e0-4d0a-82a9-632be8d9afcd`:
- era nata dalla seconda domanda, con un refuso nel CF dell'adulto;
- non aveva account, e i riferimenti da transazioni, crediti, fatture, consensi, esiti d'import e
  guardians erano 0;
- una sorella (`c56b44c8-4cb4-426a-b8a6-47828818bcf2`), che è **una sola**, era collegata a entrambe
  le schede e resta collegata a quella vera.

**Decisione del titolare sui genitori aggiunti: chi paga resta chi paga oggi.** Il genitore spostato
entra con `intestatario_fattura=false`, `percentuale_pagamento=0` e `is_primary=false`: vede il figlio
nell'app ma non diventa intestatario.

## L'istruzione, per intero

Una transazione `DO $$ … $$` per famiglia, generata dallo stesso modello. Ogni guardia che non torna
solleva un'eccezione e annulla l'intera famiglia. Riportata qui quella della coppia 1, la più
completa. Le altre differiscono solo per gli uuid, per l'assenza del passo «retta pagata» e per il
passo 4 (archiviazione) nelle coppie 6 e 7.

```sql
do $$
declare n int; v_cf_dop text; v_cf_resta text; v_diff int;
begin
  -- G1: stessa sede, stesso nome+cognome+data di nascita; la copia che resta è iscritta e in classe
  perform 1 from alunni d join alunni r on r.id = 'db671114-f23d-4df7-a347-33bb7e682198'
   where d.id = '113c410d-396a-4650-9af7-5535abe79795' and d.scuola_id = r.scuola_id and d.data_nascita = r.data_nascita
     and lower(regexp_replace(trim(d.nome),'\s+',' ','g')) = lower(regexp_replace(trim(r.nome),'\s+',' ','g'))
     and lower(regexp_replace(trim(d.cognome),'\s+',' ','g')) = lower(regexp_replace(trim(r.cognome),'\s+',' ','g'))
     and r.stato = 'iscritto' and r.section_id is not null and r.anonimizzato_il is null and d.anonimizzato_il is null;
  if not found then raise exception 'G1: coppia non più riconoscibile'; end if;

  -- 1. legami: aggiunge alla copia che resta i genitori che mancano (vede, non paga), poi stacca il doppione
  insert into legame_genitori_alunni (genitore_id, alunno_id, intestatario_fattura, percentuale_pagamento)
  select l.genitore_id, '<resta>', false, 0 from legame_genitori_alunni l
   where l.alunno_id = '<doppione>'
     and not exists (select 1 from legame_genitori_alunni l2 where l2.alunno_id = '<resta>' and l2.genitore_id = l.genitore_id);
  insert into student_parents (student_id, parent_id, relation_type, is_primary)
  select '<resta>', sp.parent_id, sp.relation_type, false from student_parents sp
   where sp.student_id = '<doppione>'
     and not exists (select 1 from student_parents s2 where s2.student_id = '<resta>' and s2.parent_id = sp.parent_id);
  perform 1 from legame_genitori_alunni where alunno_id = '<resta>' and intestatario_fattura is true;
  if not found then raise exception 'G2: la copia che resta non ha nessun intestatario'; end if;
  delete from legame_genitori_alunni where alunno_id = '<doppione>';
  delete from student_parents where student_id = '<doppione>';
  update alunni set retta_a_carico_di = '<resta>' where retta_a_carico_di = '<doppione>';

  -- 2a. (solo coppia 1) la retta PAGATA del doppione passa alla copia che resta, al posto della scaduta
  perform 1 from pagamenti where id = 'bcb1e5e7-…' and alunno_id = '<doppione>' and stato = 'pagato';
  if not found then raise exception 'G3: la retta pagata non è più sul doppione'; end if;
  delete from pagamenti p where p.id = '74447794-…' and p.alunno_id = '<resta>' and <retta cancellabile>;
  -- (se non cancella esattamente 1 riga: eccezione)
  update pagamenti set alunno_id = '<resta>' where id = 'bcb1e5e7-…' and alunno_id = '<doppione>';

  -- 2b. rette del doppione senza soldi né documenti: cancellate; se ne resta una, eccezione
  delete from pagamenti p where p.alunno_id = '<doppione>' and <retta cancellabile>;
  perform 1 from pagamenti where alunno_id = '<doppione>';
  if found then raise exception 'G4: al doppione resta una retta con soldi o documenti'; end if;

  -- 3. codice fiscale: il valido passa dal doppione alla copia che resta
  --    guardie: entrambi lunghi 16, diversi in UNA sola posizione, e quello del doppione supera il
  --    carattere di controllo ricalcolato in SQL al momento della scrittura
  update alunni set codice_fiscale = null where id = '<doppione>';
  update alunni set codice_fiscale = v_cf_dop where id = '<resta>';

  -- 4. (coppie 6 e 7) il doppione ancora in classe si archivia come fa admin/students/archivia:POST
  update alunni set stato = 'ritirato', archiviato_il = now(), archiviato_motivo = 'altro',
         archiviato_section_id = section_id, archiviato_classe_sezione = classe_sezione,
         section_id = null, classe_sezione = null, gruppo_mensa_id = null
   where id = '<doppione>' and archiviato_il is null;
end $$;
```

`<retta cancellabile>` significa tutte queste condizioni insieme:
- `importo_pagato = 0` e `fattura_aruba_id IS NULL`;
- nessuna riga collegata in `incassi`, `riconciliazione_movimenti`, `fatture_emesse`,
  `ricevute_emesse`, `pagamenti_quote`, `divise_ordini`, `mensa_ticket_movimenti`;
- nessun pagamento figlio (`parent_payment_id`).

Nella coppia 1 `incassi` e `riconciliazione_movimenti` puntano a `pagamento_id` e hanno seguito la
retta senza essere toccati. Per quella retta non esisteva nessuna `ricevute_emesse`, tabella WORM.

Account orfano, in una sola transazione con le guardie di M3:
- l'account è ancora un genitore mai entrato;
- nessuna scheda viva e nessun alunno vivo collegato;
- la pratica è ancora pending, con la stessa email.

```sql
delete from legame_genitori_alunni where genitore_id = '0143f964-22f0-4fe8-93b3-df10dfc1d3db';
delete from auth.users where id = '0143f964-22f0-4fe8-93b3-df10dfc1d3db';   -- utenti segue in CASCADE
```

## La verifica DOPO

- 8 gruppi per nome e data: **1 sola copia attiva per gruppo**, **0 copie non attive** con legami,
  `student_parents` o rette.
- Gruppi con più di una copia attiva: **0**.
- Rette «Retta 09/2026» per ciascuna delle 8 copie che restano: **1**.
- CF delle copie che restano: tutte superano il carattere di controllo.
- Email della pratica `3edd96a6`: 0 righe in `utenti`, 0 in `auth.users`; la pratica è ancora
  `pending`.
- Battito in `app_log`: fingerprint `sql:sanatoria-doppioni-2026-09-14`, riga
  `3ec14712-05db-417d-81c8-8fc6b6014092`. Conteggi: 7 famiglie, 4 legami aggiunti, 7 rette
  cancellate, 1 spostata, 5 CF corretti, 2 doppioni archiviati, 1 scheda genitore e 1 account
  eliminati.

## Come si torna indietro

- **Legami**: ricostruibili dalla tabella qui sopra, perché i doppioni sono tutti archiviati e
  riattivabili. Rimetterli però riaprirebbe esattamente il difetto.
- **Rette cancellate**: non esistono più. Erano tutte «Retta 09/2026», scadute, senza incassi né
  documenti. Si rigenerano solo riattivando il doppione, perché la generazione esclude i ritirati.
- **Retta spostata**: `UPDATE pagamenti SET alunno_id = '113c410d-…' WHERE id = 'bcb1e5e7-…'`,
  dopo aver rigenerato la retta della copia attiva.
- **CF**: il valore errato che stava sulla copia attiva è stato sovrascritto e non è stato
  conservato. Era il refuso.
- **Account orfano** e **scheda genitore doppia**: cancellazioni definitive. Nessuno dei due era mai
  stato usato.

## Cosa questa sanatoria NON ha toccato

- La fattura già **emessa** sulla copia attiva della coppia 6: va verificato se riporta il CF errato
  del bambino. Non si riemette niente in automatico.
- Diario e presenze scritti dalle maestre sui doppioni: restano nell'archivio. Le righe dello stesso
  giorno collidono con quelle della copia buona e non si fondono.
- Le altre anagrafiche attive con il CF errato ma senza doppione: restano nel riquadro «Codici
  fiscali da verificare» di `/admin/students`.
- La causa radice, cioè l'import che crea il gemello e il modulo pubblico che non controlla il
  carattere di controllo: è corretta nel codice dello stesso rilascio.
