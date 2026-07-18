-- Blinda le RPC mensa: REVOKE dell'EXECUTE anche da anon/authenticated (non solo PUBLIC).
--
-- Registrata separatamente nel ledger di produzione (version 20260717221651) subito dopo la
-- RPC transazionale (20260717212758). In Supabase i ruoli anon/authenticated ricevono EXECUTE
-- via GRANT ESPLICITO (ALTER DEFAULT PRIVILEGES): un REVOKE ... FROM PUBLIC non li tocca, quindi
-- senza questo passo le due SECURITY DEFINER restavano chiamabili in anonimo via /rest/v1/rpc
-- con la sola anon key pubblica (un anonimo poteva scalare/riaccreditare ticket di qualsiasi alunno).
--
-- IDEMPOTENTE: il file 20260717212758 include già lo stesso REVOKE/GRANT; questo file mantiene il
-- ledger di produzione allineato ai file 1:1 (applicato via MCP in due passi).
REVOKE ALL ON FUNCTION public.scala_ticket_e_prenota(uuid, uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.riaccredita_ticket_e_disdici(uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scala_ticket_e_prenota(uuid, uuid, date, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.riaccredita_ticket_e_disdici(uuid, date, uuid) TO service_role;
