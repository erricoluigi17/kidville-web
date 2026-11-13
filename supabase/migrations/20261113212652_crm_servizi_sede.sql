-- CRM segreteria · Servizi offerti dalla sede
-- Decisione del titolare (13/11/2026): l'assistente decide se una sede accoglie un bambino dell'età
-- indicata da un ELENCO FISSO di servizi per sede, non dalle sezioni dell'anno scolastico.
--   nido: tutte le sedi · infanzia: tutte le sedi · primaria: solo Giugliano e Cesa (Aversa no).
-- Una sede senza righe non offre nessun servizio: la richiesta passa a una persona.
-- Idempotente. La applica l'integrazione al merge, con il sì del titolare.

CREATE TABLE IF NOT EXISTS public.crm_servizi_sede (
  scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  grado     public.school_type_enum NOT NULL,
  PRIMARY KEY (scuola_id, grado)
);

ALTER TABLE public.crm_servizi_sede ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crm_servizi_sede FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_servizi_sede TO service_role;

COMMENT ON TABLE public.crm_servizi_sede IS
  'CRM segreteria: i servizi (nido, infanzia, primaria) che ogni sede offre, per decidere se accoglie l''età indicata dall''assistente. Non dipende dall''anno scolastico. RLS accesa e nessuna policy: la legge solo il service-role.';

-- Valori iniziali, per nome di sede. Una sede che non esiste in questo ambiente non produce righe.
-- La sede Demo (collaudo) li ha tutti e tre.
INSERT INTO public.crm_servizi_sede (scuola_id, grado)
SELECT s.id, g.grado::public.school_type_enum
  FROM public.schools s
  JOIN (VALUES
    ('Kidville Giugliano', 'nido'), ('Kidville Giugliano', 'infanzia'), ('Kidville Giugliano', 'primaria'),
    ('Kidville Aversa',    'nido'), ('Kidville Aversa',    'infanzia'),
    ('Kidville Cesa',      'nido'), ('Kidville Cesa',      'infanzia'), ('Kidville Cesa',      'primaria')
  ) AS g(nome, grado) ON g.nome = s.nome
UNION
SELECT s.id, g.grado::public.school_type_enum
  FROM public.schools s
 CROSS JOIN (VALUES ('nido'), ('infanzia'), ('primaria')) AS g(grado)
 WHERE s.nome ILIKE '%demo%'
ON CONFLICT DO NOTHING;
