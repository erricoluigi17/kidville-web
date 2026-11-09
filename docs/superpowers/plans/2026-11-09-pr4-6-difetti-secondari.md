# PR 4.6 · difetti secondari annotati (non corretti in questa PR)

- `genera-servizi/route.ts` non è stato toccato: l'SQL (`servizi_da_generare`, `genera_servizi_anno`) risolve l'anno da sé. Il pannello Genera rette non mostra ancora un riepilogo per i servizi come per le rette.
- Il servizio ha un listino ma nessuna schermata nella scheda Rette (vuole una categoria): oggi si imposta solo dalla scheda Quote.
- `mesi_effettivi` della route `rette` è per voce (`retta`, `servizio`), non un array unico come nel piano.
- La strada storica di `genera-rette` (database senza schema dell'anno) conserva il ripiego a 150 di proposito; va tolta quando tutti i DB hanno le migrazioni M46a/M46b.
- Il GET di `genera-rette` risponde 404 su `ANNO_NON_TROVATO`: nessun E2E lo tocca, ma un chiamante esterno che passa un mese fuori da ogni anno lo vedrà.
- PGlite è Postgres 18, la produzione 17: le migrazioni M46a/M46b non sono state provate sul 17.
