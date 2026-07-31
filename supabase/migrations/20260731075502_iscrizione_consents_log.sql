-- Prova dei consensi raccolti dal modulo pubblico d'iscrizione.
--
-- Fino a oggi `/iscrizione` raccoglieva allergie, note mediche (BES, DSA,
-- patologie) e il documento d'identità del minore SENZA mostrare alcuna
-- informativa e senza registrare nulla. Non era una dimenticanza del filtro:
-- non esisteva proprio il posto dove scrivere la prova.
--
-- Stessa forma di `form_submissions.consents_log`, che è già documentata come
-- «evidenza legale GDPR, popolata server-side»: si riusa il meccanismo invece
-- di inventarne un secondo, così esiste UN solo modo di provare un consenso in
-- questo sistema.
--
-- Contenuto: uno snapshot per ciascun blocco di consenso del modello — id,
-- etichetta, TESTO AUTORITATIVO mostrato all'utente, esito e istante. Il testo
-- viene congelato dentro la riga perché la prova deve dire *cosa* è stato
-- accettato, non solo *che* qualcosa è stato accettato: se domani il modulo
-- cambia, le accettazioni di ieri restano leggibili per quello che erano.

ALTER TABLE public.enrollment_submissions
  ADD COLUMN IF NOT EXISTS consents_log jsonb;

COMMENT ON COLUMN public.enrollment_submissions.consents_log IS
  'Prova dei consensi raccolti all''invio: snapshot per blocco (id, label, testo mostrato, accepted, accepted_at) + versione dell''informativa, ip e user agent. Popolata SOLO server-side.';
