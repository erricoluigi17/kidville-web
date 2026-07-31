-- Il vincolo di unicità del registro non conteneva la sede.
--
-- Con un plesso solo il nome della classe era di fatto una chiave univoca. Da
-- quando le sedi sono tre, «2 ANNI» e «5 ANNI» esistono in due plessi diversi:
-- gli upsert con onConflict 'classe_sezione,data,ora_lezione'
-- (src/app/api/register/lessons/route.ts, src/app/api/primaria/registro/route.ts)
-- CONDIVIDEVANO la stessa riga fra le sedi. Argomento, compiti e firme del
-- «2 ANNI» di Aversa sovrascrivevano quelli di Cesa, in silenzio.
--
-- È l'unico difetto dell'audit che CORROMPE dati invece di esporli, ed è
-- invisibile in lettura: il gate di scope sulle due route c'era già.
--
-- Al 2026-07-30: 14 righe, 0 collisioni, 0 righe senza scuola_id — la
-- sostituzione del vincolo non ha nulla da riconciliare.

ALTER TABLE public.registro_orario
  DROP CONSTRAINT IF EXISTS unique_registro_orario;

ALTER TABLE public.registro_orario
  ADD CONSTRAINT unique_registro_orario
  UNIQUE (scuola_id, classe_sezione, data, ora_lezione);

COMMENT ON CONSTRAINT unique_registro_orario ON public.registro_orario IS
  'Include scuola_id: il nome della classe NON è una chiave univoca fra sedi (2026-07-30).';
