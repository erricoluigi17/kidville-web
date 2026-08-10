-- L'email del cedente in `fiscale_config` — la chiave dimenticata dalla migrazione di ieri.
--
-- COSA MANCAVA E COME SI È VISTO. `20260809220000_fiscale_config_cedente` ha proposto
-- l'anagrafica della cooperativa a tutte le sedi, ma senza la chiave `email`. Il codice
-- invece la prevede da subito (`CEDENTE_COOPERATIVA.email` in
-- `src/lib/fatturazione/cedente.ts`, e `emissione.ts` logga `cedente-senza-email` quando
-- non c'è). Il difetto non ha fatto rumore: la fattura sarebbe uscita lo stesso, solo
-- **senza il blocco `<Contatti><Email>`** — cioè distinguibile a colpo d'occhio da quelle
-- che la segreteria scrive a mano sulla stessa serie fiscale, che ce l'hanno.
--
-- L'ha trovato il collaudo su dati veri (`scripts/collaudo/fattura-reale.collaudo.ts`)
-- stampando l'elenco dei tag del documento generato: `Contatti` non c'era. Un test che
-- confronta un XML atteso non l'avrebbe visto, perché l'atteso sarebbe stato scritto
-- sulla stessa configurazione incompleta.
--
-- L'indirizzo è quello che compare nei tracciati veri scaricati da Aruba il 2026-08-10.
-- È un recapito ISTITUZIONALE della cooperativa, non il dato personale di una persona.
--
-- Additiva e idempotente: tocca solo le righe che hanno già l'anagrafica (quindi non la
-- sede E2E, lasciata fuori dalla migrazione precedente) e a cui manca `email`.

update public.admin_settings
   set fiscale_config = fiscale_config || jsonb_build_object('email', 'scuolamat.lafavola@virgilio.it')
 where fiscale_config->>'denominazione' is not null
   and coalesce(btrim(fiscale_config->>'email'), '') = '';
