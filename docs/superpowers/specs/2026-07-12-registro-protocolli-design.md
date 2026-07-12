# Piano — Registro Protocolli (Kidville)

## Contesto
Nuova funzione riservata a **admin + segreteria**: registro di protocollo della corrispondenza della scuola, conforme nella sostanza al DPR 445/2000. Flusso cardine: carichi un documento → il sistema assegna il numero e restituisce il file **timbrato** (segnatura a fascia) → originale e copia timbrata restano archiviati per sempre e scaricabili. Ogni funzione del perimetro è stata **approvata singolarmente dall'utente** (24 decisioni, tabella sotto). Requisiti trasversali: UX semplicissima, coerenza totale col design cockpit dell'app.

**Branch**: si continua su `fix/docente-primaria-home` (regola AGENTS.md). **PRD** da aggiornare nello stesso lavoro. Gate finali: `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run build` · E2E CI.

## Base normativa (ricerca online 2026-07-12)
DPR 445/2000: **art. 53** (registrazione non modificabile di numero/data/mittente-destinatario/oggetto/impronta + estremi doc. mittente se disponibili; esclusioni al c.5) · **art. 55** (segnatura contestuale: numero, data, ente) · **art. 57** (numero ≥7 cifre, azzeramento annuale) · **art. 54** + DPCM 3/12/2013 art. 8 (annullamento con dicitura visibile, motivo, operatore). Kidville è **paritaria (non PA)**: conformità sostanziale, senza adempimenti PA-only (conservazione accreditata, registro giornaliero automatico, segnatura XML) — confermato dall'utente.

## Decisioni approvate dall'utente (24/24 — nessuna funzione fuori tabella)
| # | Funzione | Decisione |
|---|---|---|
| 1 | Annullamento (segreteria e admin) | A norma art. 54: riga resta visibile, barrata "ANNULLATO", motivo obbligatorio + data + operatore. |
| 2 | Eliminazione totale (solo admin) | Hard delete IN TOTO: sparisce dal registro, file compresi. Implicazione comunicata e accettata: buco nella numerazione. |
| 3 | Tipi | Ingresso + Uscita + Interno. |
| 4 | Campi | Obbligatori di legge (numero, data/ora, mittente/destinatario, oggetto, impronta SHA-256) + mezzo di ricezione/invio, riferimenti doc. mittente (data + n. prot.), numero e descrizione allegati, note interne (modificabili). **Auto-compilazione dei campi leggendo il file dove possibile.** |
| 5 | Numerazione | `0000042/2026` — ≥7 cifre, azzeramento annuale, per sede. |
| 6 | Traccia eliminazione admin | **NESSUNA**, nemmeno log tecnico: il percorso delete non chiama `logScrittura`. |
| 7 | Formati | PDF + immagini JPG/PNG (immagini convertite in PDF e timbrate). Limite 25 MB; upload diretto allo storage (bypass limite ~4,5 MB Vercel). |
| 8 | Auto-compilazione | Estrazione testo PDF on-server (`unpdf`) + euristiche lettere italiane ("Oggetto:", "Prot. n. … del …", mittente, date). Niente AI/OCR: scansioni → campi manuali. |
| 9 | Segnatura | **Fascia in testa alla 1ª pagina** (pagina originale scalata ~0.92 con pdf-lib, mai nulla di coperto): logo + "KIDVILLE GIUGLIANO · Prot. n. 0000042/2026 · INGRESSO · del 12/07/2026 ore 09:41". |
| 10 | Conservazione | Originale intatto + copia timbrata, entrambi per sempre scaricabili. |
| 11 | Verifica integrità | Pulsante «Verifica integrità»: ricalcola impronta → "Integro ✓" / "NON corrisponde ⚠". |
| 12 | Ricerca | Ricerca libera + filtro anno+tipo + intervallo date + filtro categoria. Default anno corrente. |
| 13 | Export | PDF impaginato + XLSX, sui filtri attivi. |
| 14 | Registro giornaliero | Solo export on-demand del giorno (via filtri). Nessun job notturno. |
| 15 | Classificazione | Categorie configurabili; default: Alunni e famiglie · Personale · Amministrazione e contabilità · Enti e istituzioni · Fornitori · Sicurezza e privacy · Varie. |
| 16 | Allegati | Principale (timbrato) + allegati multipli conservati com'è (non timbrati); campo descrizione precompilato. |
| 17 | Duplicati | Avviso non bloccante se impronta già presente (mostra numero/data esistente). |
| 18 | Audit consultazioni | NO tracciamento download. |
| 19 | Registro di emergenza | SÌ: inserimento marcato "da emergenza" con data/ora dichiarata dell'evento + badge, accanto alla data reale. |
| 20 | Collegamenti | "Risponde a / collegato al prot. n. X", navigabile nei due sensi. |
| 21 | «Protocolla» su doc dell'app | Certificati competenze (uscita) + moduli firmati modulistica (ingresso), dal PDF già archiviato. |
| 22 | Documenti su richiesta | «Genera documento»: Certificato di frequenza · di iscrizione · Nulla osta · testo libero, su carta intestata, alunno selezionabile, protocollato in uscita in un click. |
| 23 | Statistiche | Card cockpit: registrazioni anno · ripartizione I/U/Int · ultimo numero. |
| 24 | Altro | Nessun'altra funzione (perimetro chiuso dall'utente). |

## Approcci valutati (sintesi trade-off → scelte)
- **Upload**: diretto client→storage con signed upload URL (scelto: file fino a 25 MB) vs multipart via API (scartato: limite body ~4,5 MB Vercel).
- **Immutabilità**: trigger WORM a livello DB, validi anche per service-role (scelto, modello registri fiscali) vs enforcement solo applicativo (scartato: aggirabile).
- **Estrazione campi**: euristiche su testo `unpdf` (scelta dall'utente) vs AI (scartata: costi/privacy) — `unpdf` scelto su pdf-parse/pdfjs-dist: build serverless di PDF.js senza worker/canvas, zero config su Vercel.
- **Timbro**: fascia con `pdf-lib` embedPage (scelta dall'utente) vs timbro sovrapposto vs pagina in coda.

## Architettura

### Nuove dipendenze
`pdf-lib` (modifica PDF esistenti — jsPDF sa solo generarne) + `unpdf` (estrazione testo). Entrambe pure-JS serverless-safe. Già presenti e riusati: jspdf/jspdf-autotable (export + documenti generati), xlsx (export), node:crypto (SHA-256).

### Migrazione `supabase/migrations/20260712150000_registro_protocolli.sql` (idempotente)
- `protocolli_categorie` (id, scuola_id, nome, ordine, attivo) + seed 7 categorie default per le scuole esistenti.
- `protocolli_numerazione` (scuola_id, anno, ultimo_numero, PK composita) + `prossimo_numero_protocollo(uuid,int)` SECURITY DEFINER — clone esatto di `prossimo_numero_ricevuta` (`20260710130000_contabilita_fiscale.sql:24-42`), REVOKE anon/authenticated, GRANT service_role.
- `protocolli`: id, scuola_id NOT NULL, anno, numero, tipo CHECK ('ingresso','uscita','interno'), data_registrazione timestamptz DEFAULT now(), oggetto NOT NULL, mittente, destinatario, mezzo, rif_prot_mittente, rif_data_mittente date, impronta_sha256 NOT NULL, categoria_id FK SET NULL, collegato_a_id FK (self) SET NULL, note_interne, emergenza bool, emergenza_dichiarata_il timestamptz, annullata_at/annullata_da/annullo_motivo, file_originale, file_timbrato, file_nome_originale, file_mime, file_size, allegati_descrizione, created_by, **UNIQUE(scuola_id, anno, numero)** + indice (scuola_id, anno DESC, numero DESC).
- `protocolli_allegati` (id, protocollo_id FK CASCADE, path, nome, mime, size, sha256, ordine).
- **Trigger WORM `worm_protocolli`** (modello `20260711150000_worm_registri_fiscali.sql:21-46`): DELETE consentito SOLO se `current_setting('app.protocollo_admin_delete', true)='on'`; UPDATE consentito solo su note_interne/categoria_id/collegato_a_id + transizione unica di annullamento (annullata_at NULL→NOT NULL, cambiano solo i 3 campi annullo). Trigger analogo su allegati (immutabili; DELETE solo via GUC → il CASCADE dell'eliminazione admin passa).
- **`protocollo_elimina(p_id uuid)`** SECURITY DEFINER: `set_config('app.protocollo_admin_delete','on',true)` + DELETE nella stessa transazione; ritorna i path dei file per la pulizia storage. REVOKE/GRANT come sopra.
- RLS deny-by-default + policy service_role + GRANT ALL service_role su tutte e 4 le tabelle (modello merchandise).
- Applicazione in prod via **MCP supabase `apply_migration`** (come le precedenti) + `get_advisors` 0 ERROR. Il DB E2E CI resta non migrato → degradazione sotto.

### Storage
Bucket privato `protocollo` lazy-create (`fileSizeLimit` 25 MB, mime pdf/jpeg/png — modello `fascicolo/route.ts:99-104`). Path: `staging/{uuid}-{nome}` → definitivi `{scuolaId}/{anno}/{numero7}-originale.{ext}`, `…-timbrato.pdf`, `…/allegati/{n}-{nome}`. Download SOLO signed URL (300s) via route con gate; mai `getPublicUrl`.

### Lib `src/lib/protocolli/` (pure e testabili)
- `segnatura.ts` — `formatNumeroProtocollo(n, anno)` → `0000042/2026`; `dataOraItaliana(d)` via `Intl.DateTimeFormat('it-IT', {timeZone:'Europe/Rome', …})` (runtime Vercel = UTC; anno di numerazione da `annoFiscale()` di `src/lib/format/fiscal-date.ts:13`); `testoSegnatura(...)`.
- `timbro.ts` — pdf-lib: `applicaSegnatura(pdfBytes, dati, logoPng)`: 1ª pagina ricreata stessa misura con `embedPage` dell'originale scalata ~0.92 ancorata in basso + fascia verde brand (~64pt) con logo e testi Helvetica; pagine successive copiate. `immagineInPdf(bytes, mime)` con `embedJpg`/`embedPng` su A4 (niente sharp).
- `assets.ts` — `LOGO_LIGHT_PNG_BASE64` inline (~20 KB da `public/logo-light.png` 620×209: la lettura fs da `public/` non è tracciata da Vercel → base64 è la via sicura).
- `estrai.ts` — `estraiTesto(buf)` con unpdf (`extractText(getDocumentProxy(...), {mergePages:true})`); `suggerisciCampi(testo)`: oggetto ("Oggetto:"), mittente (intestazione/prime righe), "Prot. n. X del Y" mittente, data documento. Scansioni → testo vuoto → campi vuoti, mai errore.
- `store.ts` — `PROTOCOLLO_BUCKET`, `ensureBucket`, `SCHEMA_MANCANTE` (set `['42P01','42703','PGRST200','PGRST204','PGRST205']`), `sha256()`, path helper, **`registraProtocollo(supabase, input)`**: prepara PDF → rpc numero → timbra in memoria → `move` staging→originale + upload timbrato → INSERT (retry 23505). Fallimento post-rpc = numero bruciato: accettato (i buchi sono ammessi dal design), numero preso a PDF già pronto per minimizzare.

### Route API — `src/app/api/admin/protocolli/**` (9 nuove; TUTTE `requireStaff(request, ['admin','segreteria'])` salvo nota + zod `parseBody`/`parseQuery` → lock zod-coverage soddisfatto)
1. `route.ts` — **GET** lista: filtri anno (default corrente)/tipo/categoria/da-a/ricerca (`.or` ilike su oggetto/mittente/destinatario), `resolveScuoleAttive`, `.range` paginato, stats (conteggi per tipo + ultimo numero); degrade `SCHEMA_MANCANTE` → `{success, data:[], nonMigrato:true}` (mai 500). **POST** registra: stagingPath + campi + allegati[] + emergenza; `resolveScuolaScrittura`; risponde con riga + signed URL del timbrato. **PATCH**: aggiorna note/categoria/collegato oppure annulla (motivo obbligatorio; segreteria+admin). **DELETE** `requireStaff(request, ['admin'])`: rpc `protocollo_elimina` → `storage.remove(paths)` — **nessun logScrittura** (decisione 6).
2. `upload-url/route.ts` — POST {nome,mime,size,scopo}: `rateLimit` (`src/lib/security/rate-limit.ts`), valida 25 MB + mime, `createSignedUploadUrl('staging/…')` → {path, signedUrl, token}; il client fa `fetch PUT` sull'URL firmato (fallback in implementazione: `uploadToSignedUrl`).
3. `analizza/route.ts` — POST {stagingPath}: download, sha256, **duplicati** (eq impronta, sedi attive → avviso con numero/data), immagine→PDF se serve (ritorna stagingPath convertito), estrazione+suggerimenti; mai 500 se l'estrazione fallisce.
4. `da-documento/route.ts` — POST {sorgente:'certificato_competenze'|'modulo_firmato', id}: pesca il PDF (`certificati-competenze` + `certificati_competenze.file_url`, `src/lib/competenze/certificato-store.ts:8,202-209`; `form_attachments` + `forms_submissions.pdf_path`, scritture in `api/teacher/modulistica/route.ts:120-161`) → registra (uscita/ingresso) con oggetto precompilato.
5. `genera-documento/route.ts` — POST {tipoDocumento:'frequenza'|'iscrizione'|'nulla_osta'|'libero', alunnoId, titolo?, corpo?}: alunno (`alunni`: nome/cognome/data_nascita/codice_fiscale/classe_sezione) + sede da `scuole.config.anagrafica` con `parseAnagraficaSede` (`src/lib/scuole/anagrafica.ts:35`) + riuso `buildCertificatoBody`/`buildIntestazioneSede`/`rigaLuogoData` (`src/lib/certificati/self-service.ts:21-58`, + nuovi testi nulla osta/libero) → jsPDF server (modello `src/lib/pdf/credentials-pdf.ts`) → registra in uscita → PDF timbrato.
6. `export/route.ts` — GET ?formato=xlsx|pdf + filtri lista: XLSX clone di `api/admin/merch/export/route.ts` (incl. `logScrittura` GDPR: convenzione esistente sugli export di dati personali — unica traccia prevista); PDF registro jsPDF+autotable con righe annullate barrate.
7. `categorie/route.ts` — GET (seed lazy default) / POST / PATCH titolario per scuola.
8. `file/route.ts` — GET ?id=&versione=originale|timbrato|allegato&allegatoId= → signed URL 300s.
9. `verifica/route.ts` — POST {id}: download originale → sha256 → confronto → {integro}.

### UI
- **Sidebar**: `src/components/features/admin/AdminSidebar.tsx` gruppo "Amministrazione" (righe 88-95): `{ href:'/admin/protocolli', label:'Protocollo', icon: Stamp, roles:['admin','segreteria'] }` (primo uso del campo `roles` già previsto; la difesa reale resta il gate API).
- **Pagina** `src/app/(dashboard)/admin/protocolli/page.tsx` (client, modello `admin/merchandise/page.tsx`):
  - `PageHeader` "Registro protocolli" + azioni [➕ Protocolla documento] [📄 Genera documento] [Export ▾];
  - `StatCard`: Registrazioni {anno} · In arrivo/In partenza/Interni · Ultimo numero;
  - `Toolbar`: ricerca + `CockpitSelect` anno/tipo/categoria + 2 `DateField` (da/a);
  - Tabella `TABLE/TH/TD/TROW`: Numero (mono) · Data · Tipo (`Badge`) · Oggetto · Mittente/Destinatario · Categoria · badge EMERGENZA / ANNULLATO (riga barrata + motivo nel dettaglio) · azione Scarica;
  - `Drawer` **Protocolla documento** in 3 passi guidati: (1) dropzone PDF/JPG/PNG con progress (upload diretto) → (2) campi **precompilati** dall'analisi + avviso duplicato giallo + tipo con parole piane ("In arrivo", "In partenza", "Interno") + categoria + mezzo + collegato a + allegati + toggle "da registro di emergenza" (con data/ora dichiarata) → (3) conferma: numero assegnato in grande + `SaveCheck` + [Scarica PDF timbrato];
  - `Drawer` **Genera documento**: tipo (frequenza/iscrizione/nulla osta/libero), alunno con ricerca, anteprima, [Genera e protocolla];
  - `Drawer` **dettaglio**: campi, impronta + [Verifica integrità], download originale/timbrato/allegati, collegamenti navigabili, [Annulla (motivo)] per tutti, [Elimina definitivamente] SOLO admin con conferma doppia;
  - `Drawer` **Titolario**: gestione categorie;
  - Empty-state cortese se lista vuota o `nonMigrato`; token semantici HC-safe (mai hex nudi; override alto contrasto se testo colorato su fondo colorato).
- **Integrazioni «Protocolla»**: `src/components/features/admin/CompetenzePanel.tsx` ~riga 237 (accanto a «Scarica PDF», stati generato/firmato); `src/app/(dashboard)/admin/modulistica/page.tsx` righe azioni classe ~536-542 → pannello submission firmate (GET `documents-merge`, `pdf_path` riga 68) con «Protocolla» per riga.

## Step di implementazione
0. **Spec**: copiare questo piano in `docs/superpowers/specs/2026-07-12-registro-protocolli-design.md` + commit su `fix/docente-primaria-home`.
1. `npm i pdf-lib unpdf`.
2. Migrazione SQL → apply via MCP supabase → advisors 0 ERROR.
3. Lib `src/lib/protocolli/` **con TDD**: prima i test (`__tests__/lib/protocolli-segnatura.test.ts`, `protocolli-estrai.test.ts`, `protocolli-timbro.test.ts`), poi implementazione.
4. Route API nell'ordine: upload-url → analizza → route.ts → file → verifica → categorie → export → da-documento → genera-documento (+ `__tests__/api/protocolli-route.test.ts`: 401/403, DELETE solo admin, degrade SCHEMA_MANCANTE).
5. Pagina UI + voce sidebar.
6. Integrazioni pulsanti «Protocolla» (competenze, modulistica).
7. E2E: aggiungere `/admin/protocolli` a `e2e/primaria-360/config/coverage-matrix.ts` (ADMIN_ROUTES, gruppo Amministrazione, `inNav:true` — altrimenti il critico di completezza segnala il mismatch) + nuovo `e2e/admin-protocolli.spec.ts` sul modello `admin-contabilita.spec.ts` (heading + empty-state, tollerante al DB CI non migrato).
8. PRD: changelog datato + tabella stato (esplicitare: fuori scope moduli legacy senza `pdf_path`).
9. Gate: eslint 0 warning · vitest verdi · build ok · push → E2E CI.

## Verifica end-to-end (dopo l'implementazione)
Dev server + account TEST admin (PRD ~riga 754, pwd `KidvilleTest.2026!`) su `/admin/protocolli`:
1. Carica un PDF >5 MB con riga "Oggetto:" → verifica upload diretto + campi precompilati → conferma → scarica timbrato: fascia con logo, `Prot. n. 0000001/2026`, ora italiana corretta.
2. Carica un JPG → conversione in PDF + timbro. 3. Ricarica lo stesso file → avviso duplicato non bloccante.
4. Annulla con motivo → riga visibile barrata. 5. Da admin: elimina → sparita, numerazione con buco, file rimossi.
6. Genera "Certificato di frequenza" per un alunno TEST → PDF intestato, protocollato in uscita, timbrato.
7. Protocolla un certificato competenze esistente e un modulo firmato. 8. Export XLSX + PDF con filtri.
9. [Verifica integrità] → Integro ✓. 10. Con utente segreteria: nessun pulsante elimina e DELETE API → 403; con docente: 403 e voce non in nav. 11. Alto contrasto: pagina leggibile.
(Playwright locale mirato solo se serve; attenzione al rate-limit login con run ravvicinati.)

## Rischi e mitigazioni
1. Formato esatto del PUT sull'URL firmato di upload: verificare in implementazione (fallback `uploadToSignedUrl`).
2. unpdf su scansioni → testo vuoto: degrada a campi vuoti (coperto da test).
3. Numero bruciato se fallisce dopo l'rpc: accettato (buchi ammessi), minimizzato prendendo il numero a PDF pronto.
4. Logo via base64 inline: evita il problema del tracing Vercel dei file in `public/`.
5. WORM vale anche per service_role: l'unico delete è la funzione col GUC transaction-scoped; testare che il secondo annullo venga rifiutato.
6. E2E CI su DB non migrato: la GET degrada (`nonMigrato`), spec dedicata tollerante.

## Fuori scope (esplicito)
Conservazione a norma accreditata, segnatura XML AgID, snapshot giornaliero automatico, OCR/AI, tracciamento download, audit interno su crea/annulla/elimina, protocollazione automatica email/PEC, moduli del sistema legacy senza `pdf_path`.

## File modello di riferimento
`supabase/migrations/20260711150000_worm_registri_fiscali.sql` (WORM) · `supabase/migrations/20260710130000_contabilita_fiscale.sql:17-42` (numerazione) · `src/app/api/admin/merch/export/route.ts` (route+XLSX+degrade) · `src/app/(dashboard)/admin/merchandise/page.tsx` (UI cockpit) · `src/lib/competenze/certificato-store.ts` (bucket privato) · `src/lib/certificati/self-service.ts` (testi certificati + intestazione) · `src/app/api/chat/upload/route.ts` (upload+rate-limit) · `src/app/api/primaria/fascicolo/file/route.ts` (signed URL).
