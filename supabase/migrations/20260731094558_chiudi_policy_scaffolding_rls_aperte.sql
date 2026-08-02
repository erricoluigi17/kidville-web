-- Chiusura delle policy RLS di scaffolding lasciate da Supabase Studio.
--
-- Perché: registro_orario, note_disciplinari e firme_docenti avevano policy
-- PERMISSIVE con predicato `auth.role() = 'authenticated'` e ruolo {public}.
-- Sommandosi in OR alle policy corrette (che confrontano la sede o maestra_id),
-- concedevano a QUALUNQUE utente autenticato — genitore compreso, con la sola
-- chiave anon che sta nel bundle del browser — di:
--   · scrivere e cancellare il registro di qualsiasi sede;
--   · scrivere e modificare note disciplinari su qualsiasi minore;
--   · inserire firme docenti a nome di qualsiasi maestra (valore probatorio).
--
-- Nessun codice applicativo dipende da queste policy: le route usano il client
-- service-role, che scavalca la RLS. Verificato: nessuna scrittura client-side
-- su queste tre tabelle in tutto src/.
--
-- Restano attive le policy corrette, già presenti:
--   registro_orario   → «Maestre della scuola possono gestire il registro»
--                       (utenti.scuola_id = registro_orario.scuola_id)
--   note_disciplinari → «Maestre possono gestire le proprie note» (maestra_id = auth.uid())
--   firme_docenti     → «Maestre possono gestire le proprie firme» (maestra_id = auth.uid())
--
-- Applicata in produzione il 2026-07-31 (audit globale multi-sede).

DROP POLICY IF EXISTS "Enable insert for authenticated users" ON public.registro_orario;
DROP POLICY IF EXISTS "Enable update for authenticated users" ON public.registro_orario;
DROP POLICY IF EXISTS "Enable delete for authenticated users" ON public.registro_orario;

DROP POLICY IF EXISTS "Enable insert for authenticated users" ON public.note_disciplinari;
DROP POLICY IF EXISTS "Enable update for authenticated users" ON public.note_disciplinari;

DROP POLICY IF EXISTS "Enable insert for authenticated users" ON public.firme_docenti;
