-- ═══════════════════════════════════════════════════════════════════════════════
-- Note disciplinari e firme docenti: `authenticated` non ci scrive più
-- Collaudo sicurezza del 2026-07-31 (tester-opus-sicurezza, rilievo F1).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. La migrazione `20260731094558` di stamattina ha tolto sei policy di
-- scaffolding palesi (`auth.role() = 'authenticated'`). Sotto ne è rimasta una più
-- sottile, PREESISTENTE, che nessuno aveva guardato:
--
--     "Maestre possono gestire le proprie note"  ON note_disciplinari
--     "Maestre possono gestire le proprie firme" ON firme_docenti
--     FOR ALL TO authenticated
--     USING (maestra_id = auth.uid()) WITH CHECK (maestra_id = auth.uid())
--
-- Il `WITH CHECK` vincola l'AUTORE a sé stesso, e nient'altro: non il RUOLO
-- dell'autore (in Supabase ogni utente con una sessione è `authenticated`, genitori
-- compresi), non la SEDE dell'alunno, non che l'autore insegni in quella sezione.
-- E `maestra_id` non ha una FK verso `utenti`, quindi nemmeno lo schema aiuta.
--
-- Risultato, DIMOSTRATO con INSERT reali in transazioni annullate (nessuna riga è
-- rimasta: note=60, firme=18 invariati):
--   · un GENITORE ha scritto una nota disciplinare su un minore che non è suo figlio;
--   · la segreteria di AVERSA ha scritto una nota sul fascicolo di un minore di
--     GIUGLIANO — cioè attraverso il confine fra sedi che questo audit esiste per
--     chiudere.
-- La contro-prova è passata: impersonare un docente vero (`maestra_id` di un altro)
-- viene negato con `42501`. Non è quindi un buco di impersonazione — è peggio in un
-- senso e meglio nell'altro: la riga porta il nome dell'attaccante, ma la riga esiste.
--
-- PERCHÉ TOGLIERE IL PERMESSO E NON SOLO STRINGERE LA POLICY. Verificato file per
-- file: in tutto `src/` queste due tabelle sono toccate da 15 punti, TUTTI
-- server-side con `createAdminClient` (service-role, che scavalca la RLS). Nessun
-- client di sessione le scrive: gli unici che parlano con Postgres dal browser sono
-- la chat realtime, i banner del genitore, l'import/export (SELECT su `alunni`) e
-- `syncEngine` (upsert su `presenze`). Quindi il permesso di scrittura per
-- `authenticated` non serve a nessun percorso di prodotto: è superficie e basta.
--
-- Difesa in profondità, due strati indipendenti:
--   1. REVOKE del privilegio  → PostgREST rifiuta prima ancora di valutare la RLS;
--   2. la policy `FOR ALL` diventa `FOR SELECT` → anche se un domani un GRANT
--      rientrasse (Supabase li concede per default alle tabelle nuove), non
--      esisterebbe nessuna policy che permetta una scrittura.
-- Le SELECT restano identiche: il docente continua a vedere le proprie note e le
-- proprie firme, il genitore quelle dei figli, lo staff quelle della propria sede.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Il privilegio ─────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.note_disciplinari FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.firme_docenti     FROM anon, authenticated;

-- ── 2. Le policy: da «gestire» a «vedere» ────────────────────────────────────
DROP POLICY IF EXISTS "Maestre possono gestire le proprie note"  ON public.note_disciplinari;
DROP POLICY IF EXISTS "Maestre possono gestire le proprie firme" ON public.firme_docenti;

-- Il docente vede le note che ha scritto. Solo lettura: la scrittura passa dalla
-- route (`requireDocente` + scope di sezione + `withRoute`), che è l'unico posto in
-- cui si può verificare che l'alunno sia nella sua classe e nella sua sede.
CREATE POLICY "Maestre vedono le proprie note"
  ON public.note_disciplinari FOR SELECT TO authenticated
  USING (maestra_id = (SELECT auth.uid()));

CREATE POLICY "Maestre vedono le proprie firme"
  ON public.firme_docenti FOR SELECT TO authenticated
  USING (maestra_id = (SELECT auth.uid()));
