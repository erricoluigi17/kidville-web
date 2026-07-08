-- Fase D (voce 6 test 360°): una sola firma "principale" per riga di registro.
--
-- Problema: sulla stessa ora/materia possono comparire più firme tutte
-- 'principale' (nessun vincolo lo impediva). L'API ora blocca a livello
-- applicativo un secondo 'principale' di docente diverso; qui aggiungiamo il
-- vincolo a DB come backstop.
--
-- Idempotente: la de-dup è ripetibile (dopo la prima esecuzione non ci sono più
-- duplicati) e l'indice usa IF NOT EXISTS.

-- 1) De-dup difensivo: se una registro_id ha più firme 'principale', conserva la
--    più vecchia (firmato_il, poi id) e declassa le altre a 'compresenza'.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY registro_id
           ORDER BY firmato_il ASC, id ASC
         ) AS rn
  FROM public.firme_docenti
  WHERE tipo_compresenza = 'principale'
)
UPDATE public.firme_docenti f
SET tipo_compresenza = 'compresenza'
FROM ranked r
WHERE f.id = r.id
  AND r.rn > 1;

-- 2) Indice parziale unico: al più una firma 'principale' per riga di registro.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_firma_principale_per_registro
  ON public.firme_docenti (registro_id)
  WHERE tipo_compresenza = 'principale';
