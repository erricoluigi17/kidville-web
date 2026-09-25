# Caricamento affidabile di foto e video

Spec approvata il 2026-09-25. Ambito: Galleria docenti su web e shell iOS/Android, con regressioni dei moduli condivisi. Si conserva Supabase Storage e la conversione server esistente.

## Evidenze iniziali

Letture di produzione del 25/09: 57 occorrenze `fotocamera-errore` il 24–25/09 con codice `plist_photo_library_add`; 22 job rifiutati `OUTPUT_FPS_INVALID`; tre `UPLOAD_ABBANDONATO`. Sono conteggi del momento, non soglie né stime. Nessun contenuto personale è stato scaricato. La versione iOS 1.1 build 5 risulta `WAITING_FOR_REVIEW`, la 1.0 build 4 è pubblica.

La riproduzione sintetica VFR locale mantiene 150 frame e gli stessi PTS, ma cambia la media da 25 a circa 25,139665: il confronto dello 0,1% rifiuta il risultato. La durata dell'ultimo campione richiede verifica distinta. La riproduzione locale FFmpeg 8.1.2 non sostituisce la build Linux pinnata del runner.

## Comportamento richiesto

- Selezione: errori distinguibili, annullamento normale, alternativa HTML tramite nuovo gesto per binari incompatibili; MIME assente riconosciuto dal contenuto oppure rifiuto visibile.
- Foto: coda persistente per file con autore e sede originali, UUID stabile, fase e percorso; conservazione dei fallimenti e ripresa dei soli passaggi incompleti. Limite di 30 firme/10 minuti per utente, attesa `Retry-After` visibile.
- Pubblicazione foto: `upload_id` opzionale per compatibilità; unicità autore autenticato/sede/UUID, risposta identica ai replay, conflitto se il contenuto cambia. Record e destinatari atomici, notifiche non duplicate. Nessun ripiego non idempotente se manca lo schema.
- Video: apertura distingue trasferimento necessario, originale già presente e stati terminali. Riconciliazione dopo TUS e fra `caricato`/`conferma`, firme rinnovabili, assenza di esecuzioni concorrenti, account/canale/sede isolati. Nessuna pubblicazione al rientro senza destinatari scelti.
- Conversione: verifica temporale tramite frame decodificati, PTS normalizzati, timebase e ultimo campione; ramo oltre 60 fps distinto. Restano obbligatori decode completo, durata, audio, colore e dimensioni. Evidenze complete confinate al sandbox.
- Osservabilità: stato, codice, UUID, byte e tempi; niente nomi, percorsi firmati, token, tag o contenuti personali nei log.

## Accettazione

Lotto di 31 foto, NAT condiviso, errori parziali, risposte perse dopo PUT/POST, replay concorrenti, riavvio e cambio account/sede; interruzione in ogni confine video, firma scaduta e originale completo. Fixture VFR/HEVC/HDR/verticali/senza audio/oltre 60 e controprove frame mancanti, accelerazione, troncamento e perdita audio. Percorso docente → pubblicazione → genitore autorizzato su web/iOS/Android, con dati sintetici isolati.

## Rilascio

Branch `codex/fix-caricamenti-media`; migrazioni additive mostrate e misurate prima di applicarle. PRD e log fanno parte della consegna. Merge solo con lint, TypeScript, Vitest, build ed E2E CI verdi e verifica finale del coordinatore. La disponibilità sugli store è distinta dal deploy web; il percorso alternativo deve funzionare sulle app già installate.
