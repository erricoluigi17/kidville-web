# PDF autorizzazioni e riepilogo — piano di implementazione

**Obiettivo:** documento completo realmente archiviato dopo firma OTP, recupero dei pregressi e riepilogo leggibile con stato autorizzazione corretto.

**Architettura:** snapshot versionato dentro `signature_log`, servizio server idempotente per preparare e scaricare il PDF privato, renderer separati per documento completo e stampa interna. Nessuna nuova tabella; firma, sede e autorizzazione derivano dai dati autorevoli del server.

**Tecnologie:** Next.js 16 locale, TypeScript, Supabase, jsPDF, pdf-lib/carta intestata, Vitest e Playwright CI.

## Attività e gate

- [x] Motore snapshot/hash/PDF completo, persistenza reale, gestione dei guasti e route privata POST/GET; vietare firma fornita dal client nell'invio diretto. Test red-green per persistenza, sicurezza e recovery.
- [x] Revisione indipendente requisiti del backend, poi qualità/sicurezza; correggere e ricontrollare prima di proseguire.
- [x] Stato autorizzazione nel JSON `documents-merge`, formato PDF server leggibile, download del documento completo lato genitore e segreteria. Test su consensi, duplicati, cartaceo e interazioni UI.
- [x] Revisione indipendente requisiti di report/UI, poi qualità; correggere e ricontrollare.
- [x] Recupero batch idempotente delle firme storiche e integrazione dei file nei percorsi esistenti di oblio/cancellazione. Dry-run e test su guasti/ambiguità senza dati reali nelle fixture.
- [x] Revisione requisiti di recupero/oblio, poi qualità e revisione finale dell'intervento.
- [x] Renderizzare tutti i PDF di prova e ispezionare tutte le pagine; eseguire ESLint, typecheck, Vitest completo e build.
- [ ] PRD allineato, commit sul branch esistente, push e PR collegata; attendere CI qualità + E2E verdi.
- [ ] Merge e deploy; misure SQL aggiornate e recupero storico; verificare file reali e anomalie residue, versione distribuita, salute e workflow dopo deploy.
- [ ] Registrare risultati nel PRD e pulire i branch secondari solo dopo tutte le verifiche.

## Criteri di accettazione

La firma digitale accettata crea uno snapshot immutabile e un PDF completo realmente presente nello Storage. Un guasto del documento preserva la firma e si recupera senza OTP nuovo. Il genitore estraneo e lo staff di altre sedi non accedono ai file. Le compilazioni non firmate e i consensi obbligatori negati o mancanti non risultano autorizzati. Il riepilogo e il documento completo non hanno testo tagliato o sovrapposto, nemmeno con descrizioni lunghe e classi numerose. Le firme precedenti mantengono i loro metadati e dichiarano la ricostruzione. Nessuna evidenza o impronta viene inventata.

## Evidenze raccolte durante l’implementazione

- Backend: regressioni red-green su snapshot, Storage, guasti, recupero concorrente e accessi; revisione requisiti PASS e successiva revisione qualità/sicurezza PASS. Il download resta vincolato all’UID già verificato, senza fallback a identità fornita via header.
- PDF con dati fittizi: documento ordinario (1 pagina), storico (1), lungo (3), riepilogo con 86 alunni e descrizione lunga (6); tutte le 11 pagine renderizzate e ispezionate visivamente.
- Dipendenza del gate video locale: FFmpeg con filtri `zscale` e `tonemap` disponibile in `/opt/homebrew/opt/ffmpeg-full/bin`; la suite completa userà `KIDVILLE_VIDEO_FFMPEG_DIR`, senza saltare i test video.
- Report/UI: regressioni red-green su stato, PDF, download e interazioni; revisione requisiti PASS dopo aver chiuso la protocollazione dei percorsi storici simulati. Il file viene verificato dal server prima di abilitare e inviare il protocollo, con recupero senza OTP e revoca della disponibilità su guasto.
- Report/UI: revisione qualità PASS dopo regressioni sui rifiuti HTTP/rete del protocollo e sulla selezione esatta del numero nella modale. WebP non produce un successo simulato; il protocollo mantiene il requisito PDF esistente.
- Recupero/oblio: regressioni red-green su upload concorrente a cancellazione/revoca, percorso deterministico già salvato, guasto DB dopo upload, ponte account genitore, scansione condivisa nel lotto e alias di percorso su riferimenti esterni/protocollo. La simulazione usa un contesto ALS console-only: zero RPC di audit, diagnostica redatta attiva e propagazione degli errori applicativi preservata.
- Download client: preparazione e GET usano `conTetto` condiviso con limite di 120 secondi per generazione/caricamento e reti mobili; timeout recuperabile dalla stessa compilazione, senza nuove firme e senza esenzioni al lock.
- Concorrenza recupero/oblio: la riproduzione indipendente che lasciava `orphanedPdf=true` ora restituisce `recoveryReady=false`, `rowsAfter=0`, `orphanedPdf=false`. L’intento durevole precede lo Storage e il writer già avviato mantiene il proprio indice fino al rilascio; la revisione della gestione dei guasti e dei lease deve precedere i gate finali.
- Recupero/oblio: ricontrollo requisiti PASS su 134 test in 10 file, comprese 17 barriere per upload in volo, scadenza e successione dei writer, fence durante release, guasti DB/Storage, riferimenti condivisi e protocollo. La firma originaria e l’impronta restano uguali.
- Primo gate completo: 30.546 test verdi su 30.551; cinque failure individuati e corretti (vecchi test del riepilogo client, eccezione date non più necessaria, codice dell’errore Auth e inventario del solo URL fittizio di normalizzazione). Corretto anche il termine inglese `location` nel nuovo messaggio di sede. Nessun test viene saltato e i lock non vengono allentati.
- Simulazione reale del batch, senza scritture: 73 autorizzazioni firmate, 73 PDF mancanti e zero anomalie; SELECT aggregata conferma il tipo autorizzazione. Le misure si rifanno al momento dell’applicazione.
- Commit Storage tardivo dopo timeout: il guard mantiene lease e indice sugli esiti incerti; SDK reale e server loopback verificano anche il retry dopo commit e scadenza, con riga eliminata, PDF assente e nessun orfano. La patch ha 113 test mirati verdi, comprese 41 barriere/casi di fencing; il ricontrollo indipendente precede il rilascio.
- Recupero/oblio: ricontrollo finale requisiti PASS e successivo ricontrollo qualità PASS. Entrambi verificano 69 test in due suite e riproduzione indipendente con SDK reale sul commit tardivo; nessun PDF orfano al termine del retry. Il riepilogo e il download rispettano l’intento di cancellazione.
- Revisione finale delle integrazioni PASS: 96 test su otto file e prova Node24 completa in memoria, con PDF reale, evidenze originali preservate, precedenza della firma, oblio senza residui e recupero successivo impedito.
- Gate locali conclusivi: ESLint zero warning e typecheck exit 0; Vitest completo **30.602/30.602 test, 1.797/1.797 file**, exit 0; build e postbuild exit 0, artefatto senza segnaposto su 3.012 file JavaScript. Playwright resta alla CI isolata.
