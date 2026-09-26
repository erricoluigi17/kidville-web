-- ─────────────────────────────────────────────────────────────────────────────
-- Modulo d'iscrizione pubblico: il codice fiscale OMOCODICO deve passare.
--
-- Richiesta del titolare (26/09/2026): esistono codici fiscali veri diversi da
-- quelli che l'app calcola. Il caso è l'omocodia: per distinguere due persone
-- con gli stessi dati, l'Agenzia sostituisce una o più cifre con le lettere
-- L M N P Q R S T U V (partendo da destra) e ricalcola il carattere di
-- controllo. Il modulo pubblico li respingeva con «Inserisci un codice fiscale
-- valido (16 caratteri)»: la famiglia non poteva inviare la domanda.
--
-- Il pattern nel codice (`src/lib/forms/enrollment-template.ts`,
-- `anagrafica-fields.ts`) è corretto nella stessa PR, ma la route pubblica usa
-- lo schema SALVATO in `form_models`, e quello attivo in produzione
-- (`f0000000-0000-4000-8000-000000000001`, il modello standard) contiene il
-- vecchio pattern in 2 punti (verificato con SELECT il 26/09/2026). Senza questa
-- migrazione il server continuerebbe a rifiutare.
--
-- Il pattern nuovo è lo stesso già in uso per il personale
-- (`personale-template.ts`): accetta le lettere omocodiche nelle sole posizioni
-- numeriche e limita il mese alle 12 lettere valide. Il carattere di controllo
-- lo verifica poi `validaCodiceFiscale`.
--
-- Si aggiornano TUTTI i modelli che contengono ancora il pattern vecchio, non
-- solo quello standard: un modulo personalizzato copiato dal modello ha lo
-- stesso difetto. Idempotente: il WHERE esclude le righe già corrette.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.form_models
SET schema = replace(
      schema::text,
      '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$',
      '^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$'
    )::jsonb,
    updated_at = now()
WHERE strpos(schema::text, '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$') > 0;
