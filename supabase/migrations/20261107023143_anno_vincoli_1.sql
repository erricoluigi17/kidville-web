-- Anno scolastico · PR 2 · V1 · il vincolo `anno_id` presente, NON ancora convalidato.
--
-- Per ogni tabella del registro che esiste, ha `anno_id` e dove `anno_id` ammette ancora NULL:
--   CONSTRAINT <tabella>_anno_id_presente CHECK (anno_id IS NOT NULL [OR <colonna-sede> IS NULL]) NOT VALID
-- La parentesi `OR <colonna-sede> IS NULL` c'è solo sulle tabelle `sede_facoltativa` (la chiave della sede può
-- mancare: un avviso per tutte le sedi): una riga senza sede non ha un calendario da cui ricavare l'anno.
--
-- `NOT VALID`: Postgres controlla subito le righe NUOVE e quelle modificate, ma non scandisce la tabella. Ogni
-- `ACCESS EXCLUSIVE` dura pochi millisecondi. La convalida (che non blocca le scritture) e il `SET NOT NULL` sono in V2.
-- Se V2 non arriva, l'app lavora comunque: dopo il riempimento ogni scrittura di oggi riceve l'anno dal trigger.
--
-- Idempotente (un vincolo che c'è già, o una colonna già NOT NULL, si saltano). Nessun uuid di sede, nessuna lettura
-- di `schools.operativa`, ogni tabella dietro `to_regclass` (il DB della CI non le ha tutte).

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.* FROM public.anno_tabelle t ORDER BY t.tabella LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', r.tabella)) AND c.relkind IN ('r', 'p'))
               OR NOT public.anno_ha_colonna(r.tabella, 'anno_id');
    -- già NOT NULL (sections, frequenze…): niente da fare
    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = to_regclass(format('public.%I', r.tabella))
                             AND a.attname = 'anno_id' AND a.attnotnull AND NOT a.attisdropped);
    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_constraint k
                           WHERE k.conrelid = to_regclass(format('public.%I', r.tabella))
                             AND k.conname = r.tabella || '_anno_id_presente');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (anno_id IS NOT NULL%s) NOT VALID',
                   r.tabella, r.tabella || '_anno_id_presente',
                   CASE WHEN r.sede_facoltativa THEN format(' OR %I IS NULL', r.via_sede) ELSE '' END);
  END LOOP;
END
$mig$;
