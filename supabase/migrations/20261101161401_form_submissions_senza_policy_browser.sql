-- S-1 (31/10/2026) · `form_submissions` non si legge e non si scrive più dal browser.
--
-- Le tre policy `fs_*` sono dell'era in cui il wizard dei moduli scriveva da sé
-- (`fs_insert_authenticated`, 2026-05). Da allora OGNI lettura e scrittura passa
-- da route server con il service-role, che le policy non le guarda: nessun
-- client di sessione tocca questa tabella (misurato il 31/10 su `src/`: 13 file,
-- tutti `createAdminClient`; nessuna vista, nessuna funzione SECURITY INVOKER,
-- tabella fuori dalla pubblicazione realtime).
--
-- Restavano però aperte a chiunque avesse una sessione, con la chiave anon che
-- sta nel bundle del browser e i grant pieni di `authenticated` (verificati in
-- produzione il 31/10):
--   · INSERT — una riga propria o senza intestatario, con QUALSIASI colonna:
--     `status='completed'`, `signed_at`, `signature_log`, `consents_log`,
--     `score`, `esito_ammissione`, la sede che si vuole. Cioè un modulo
--     «firmato» senza OTP, consensi mai dati, una compilazione nella sede di un
--     altro plesso — tutto ciò che `forms/submit` e `forms/send-otp` controllano;
--   · UPDATE — sulle proprie righe, le stesse colonne: il punteggio e l'esito di
--     graduatoria, lo stato di firma;
--   · SELECT — le proprie righe, compreso `otp_secret`: è lo sha256 di
--     `<submissionId>:<6 cifre>`, si ricava in un istante. Nella firma congiunta
--     (DL-031) il codice va al SECONDO genitore, e l'intestatario lo avrebbe
--     letto da qui firmando al suo posto.
--
-- Senza policy, con la RLS accesa, `anon` e `authenticated` non vedono niente;
-- il REVOKE toglie anche ciò che la RLS non copre (TRUNCATE) e fa sì che una
-- policy aggiunta per sbaglio domani non riapra la tabella da sola: servirebbe
-- anche un GRANT, cioè una scelta scritta. Il service-role non cambia.
--
-- Nessuna riga viene toccata.

DROP POLICY IF EXISTS fs_insert_authenticated ON public.form_submissions;
DROP POLICY IF EXISTS fs_select_owner ON public.form_submissions;
DROP POLICY IF EXISTS fs_update_owner ON public.form_submissions;

REVOKE ALL ON TABLE public.form_submissions FROM anon, authenticated;
