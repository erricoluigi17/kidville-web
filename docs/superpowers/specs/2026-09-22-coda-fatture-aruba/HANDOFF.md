# HANDOFF — Coda fatture Aruba (riprendere da qui)

> Documento per la sessione che riprende il lavoro. Stato aggiornato al **23/09/2026 15:55**.
> Leggere nell'ordine: questo file → `nucleo.md` → `contratto.md` (solo per la seconda consegna).

## 1. Cosa è in produzione

| Rilascio | PR | Merge | Cosa fa |
|---|---|---|---|
| **R1 — correzione urgente** | #159 | 23/09 12:07 (`11f59af1`), deploy 12:09 | Tolto il vincolo `UNIQUE (scuola_id, anno, numero)` che rifiutava dal registro fatture già partite. 409 `FATTURA_PARTITA_NON_REGISTRATA`. Tetto 50 sul salto del pavimento, con log del pavimento. 23505 distinto per vincolo. Script `scripts/numerazione-serie.mjs` (indagine) e `scripts/fatture-orfane.mjs` (registrazione delle orfane) |
| **Nucleo della coda** | #160 | 23/09 15:34 (`a447e4ce`), deploy 15:36:54, primo battito del cron alle 15:37:02, 8 secondi dopo il deploy (`niente-da-fare`, letto in `app_log`) | Coda persistente (`fatture_coda`, `fatture_coda_stato`); cron `fatture-coda-tick` ogni 5 minuti fuori dalle finestre della sync; lavoratore unico; 50/ora fail-closed; pausa 60 minuti su 429 e 15 minuti su esito incerto. Pagina «Coda fatture». Il lotto in riconciliazione accoda (fino a 500); il pulsante singolo accoda in testa |
| **PR-B** | PR-B, questo branch (`chore/coda-fatture-pr-b`) | — (non ancora rilasciata) | Cinque fotografie rigenerate dalla produzione dopo l'applicazione della migrazione del nucleo (migrazioni, policy, indici unici, FK, tabelle con `scuola_id`) e `MIGRAZIONI_ATTESE_AL_MERGE` svuotata; `fatture-coda-tick` in `JOB_CRON` con finestra di 30 minuti; lock `isolamento-sede` da 109 a 113 esenzioni, con quattro voci nuove in `AMMESSE` (`coda:GET`, `coda:<modulo>`, `coda/azioni:POST`, `video-uploads/[id]:<modulo>`); guardia degli script (`scripts/lib/aruba-lettura.mjs`) col ramo del nucleo: `fatture-orfane` e `numerazione-serie` partono solo a coda sospesa, fuori dalla pausa del lavoratore (429/esito incerto) e senza lavoratore attivo; questo HANDOFF |

**Come si usa oggi (segreteria)**
1. Contabilità → Pagamenti → Riconciliazione: seleziona le fatture, fai il pre-controllo, conferma. Le fatture **vanno in coda** e si può chiudere la pagina o spegnere il PC.
2. Il pulsante «Fattura» su un singolo pagamento lo mette in coda **in testa**: parte entro pochi minuti. **Eccezione**: con l'intestatario digitato a mano («Altro») il pulsante non accoda, usa ancora la `POST /api/pagamenti/fattura` diretta (vedi §3, punto a).
3. Il menu «Coda fatture» mostra avanzamento, errori e orario stimato. Da lì: «Togli», «Rimetti in coda» e, solo per l'admin, «Sospendi».
4. Ritmo massimo: **50 fatture l'ora**, limite del Tier 0 del contratto Aruba meno il margine per il pannello. 300 fatture richiedono circa 6 ore.

## 2. Cose ancora aperte di R1 (da fare per prime)

- [x] **Orfane registrate: 6 su 7** il 23/09 alle 17:08–17:11, a coda sospesa, con ogni scrittura mostrata (audit 516–521). **Resta FPR 2524/2026 DA DECIDERE**: su Aruba ha un doppione valido emesso fuori dall'app il 23/09. Decide il commercialista (nota di variazione); poi, se va registrata, si usa `node scripts/fatture-orfane.mjs --applica --solo 11d88888-6d63-44ab-ab94-241efc05e937` a coda sospesa.
- [x] **Indagine chiusa: causa H1** (documenti emessi fuori dall'app con il numero scritto a mano). 7 salti su 7 spiegati, contatori corretti (nessun `--allinea`). Buchi: FPR 2155–2514 e Asilo 2530–2538. 25 doppioni: 11 storici regolari, 13 invii esterni scartati dallo SdI, 1 valido (FPR 2524). Prospetto per il commercialista in `$LAVORO/indagine-r1/prospetto-numerazione-2026.txt`. Dettaglio nel PRD, changelog del 23/09.
- [ ] **Da fare col titolare**: fermare le emissioni a mano dal pannello Aruba, oppure dare a chi le fa il numero giusto per serie. Portare al commercialista prospetto, buchi e FPR 2524.
  - Correggere i contatori (`--allinea`) **solo** se P6 è falso.
  - Il prospetto dei buchi va al commercialista.
- [ ] PRD: sostituire «indagine in corso» con l'esito, quando la fase B2 l'avrà prodotto.
- Controprove già fatte (23/09): `$LAVORO/indagine-r1/controprove.json`. `$LAVORO = /Users/lerri/kidville-lavoro/coda-fatture-aruba`, fuori dal repo, permessi 700.

## 3. Seconda consegna (dal piano completo)

Il piano completo è in `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/`. Contiene `contratto.md` (unico, v4 + C0), i design `d1..d6`, `scomposizione.md` (49 fasi, 218 compiti) e `rilievi-residui.md`. Il nucleo è **un sottoinsieme semplificato**: prima di riprendere, riallineare contratto e scomposizione a ciò che il nucleo ha già costruito. Per esempio la tabella si chiama `fatture_coda`, non `fatture_coda_voci`, e non esistono `fatture_coda_invii` né il cancello condiviso.

### Rilievi emersi su questa PR (da chiudere nella seconda consegna)

Sei punti verificati al 23/09. I primi cinque, (a)-(e), riguardano il nucleo così com'è in produzione oggi — nessuno blocca il rilascio già fatto, ma vanno chiusi prima o durante la seconda consegna. Il sesto, (f), non è del nucleo: è un residuo che la fotografia rigenerata ha fatto vedere, e lo decide il titolare:

- **(a) L'eccezione «Altro»**: con l'intestatario digitato a mano (`tipo: 'persona'`, non un adulto già in archivio) `FatturaButton.tsx` usa ancora la `POST /api/pagamenti/fattura` diretta, fuori dalla coda — è una decisione del direttore (documentata nel changelog del PRD), non una dimenticanza: `zCorpoAccoda` accetta solo il ramo `adult` perché la coda non custodisce dati digitati nel browser. Conseguenza: quel ramo scavalca il lavoratore, può contendersi il `signin` Aruba (1/minuto) con un giro della coda, e consuma lo stesso secchio orario senza che il lavoratore lo sappia in anticipo. Va portato in coda quando questa avrà una forma per l'intestatario "a mano".
- **(b) `esito_messaggio` può contenere il nome di un genitore e resta dopo «Togli»**: la RPC `fatture_coda_togli` (righe 571-582 della migrazione `20260923102831_fatture_coda_nucleo.sql`) azzera `causale_manuale` e `intestatario_scelto`, ma **non** `esito_codice`/`esito_messaggio` — a differenza di `fatture_coda_rimetti`, che li azzera entrambi. Una voce tolta dopo un errore può quindi restare con un `esito_messaggio` che cita un nome in chiaro (messaggi d'errore Aruba/SDI). Da correggere: aggiungere `esito_codice = NULL, esito_messaggio = NULL` a `fatture_coda_togli`.
- **(c) La stima di fine mostra solo l'ora**: `CodaFatturePanel.tsx` formatta `stima_fine` con `ora()` (solo HH:MM, via `useDateFormat`), senza data. Con 300+ fatture in coda (≈6 ore o più) la stima può cadere il giorno dopo, e «finisce alle 03:12» senza data è ambiguo o sbagliato.
- **(d) Codice morto in `lotto-fatture.ts` e chiavi `reconLotto*` inutilizzate**: da quando `LottoFatturePanel.tsx` fa una sola `POST /coda` invece del vecchio ciclo a blocchi nel browser, sono rimaste senza chiamanti in `src/lib/pagamenti/lotto-fatture.ts`: `ATTESA_FRA_BLOCCHI_MS`, `DURATA_BLOCCO_STIMATA_MS`, `pausaDopo`, `PAUSA_DOPO_RIFIUTO_LOCALE_MS`, `pausaDopoBlocco`, `bloccoHaToccatoAruba`, `numeroInDubbio`, `stimaRimanenteMs`. In `messages/it/adminContabilita.json` restano 18 chiavi `reconLotto*` mai lette da nessun componente (`reconLottoAvanzamentoAttesa`, `reconLottoAvanzamentoInvio`, `reconLottoEmettiOra`, `reconLottoErroreEmissione`, `reconLottoFermatoGuasto`, `reconLottoFermatoSenzaNumero`, `reconLottoFermatoTrasporto`, `reconLottoGiaEmesse`, `reconLottoIgnote`, `reconLottoInCorsoTitolo`, `reconLottoInterrotto`, `reconLottoNonTentate`, `reconLottoNumero`, `reconLottoRiuscite`, `reconLottoSaltate`, `reconLottoStimaBreve`, `reconLottoStimaMinuti`, `reconLottoTetto`) — residuo della vecchia UI di avanzamento a blocchi. Le otto funzioni non hanno chiamanti nel codice di produzione, ma `__tests__/lib/lotto-fatture.test.ts` le importa: si tolgono **insieme** codice, i loro casi in quel test e chiavi i18n (`it` ed `en`), non spenti a metà — togliere solo il codice rompe il test, togliere solo il test lascia codice morto.
- **(e) Badge «In coda» sulle righe**: la lista Pagamenti/Riconciliazione mostra lo stato di fatturazione (chip col numero, «Scartata, da riemettere», «In attesa SDI», «Da fatturare»), ma **non** un badge quando quella riga ha già una voce attiva in `fatture_coda` (in attesa o in invio). Oggi l'unico modo per saperlo è aprire la pagina «Coda fatture» a parte. Va aggiunto come badge sulla riga stessa.
- **(f) In produzione c'è ancora la tabella `backup_diario_vuote_20260908`** (residuo, decisione del titolare): le fotografie rigenerate in questa PR (`tabelle-scuola-id.json`, `pg-policies-snapshot.json`) la mostrano in `public`, senza `scuola_id` ma **legata all'alunno** (`alunno_id`, `maestra_id`, `tipo_evento`, `dettagli`, `nota_libera`, `nota_bambino`, …). È la copia delle **437 righe vuote del diario** cancellate l'08/09 (PRD, voce della pulizia del diario), fatta perché il `DELETE` prendesse gli id dalla copia. RLS attiva, nessuna policy: non è leggibile dai client, ma è un dato di minori tenuto oltre il suo scopo. **Toglierla è una scrittura in produzione e non spetta a PR-B**: il titolare decide se tenerla ancora (e fino a quando) o farla cadere con una migrazione dedicata, che aggiornerà di nuovo le due fotografie.

### Da fare, in ordine di valore

1. **Notifiche**: fine gruppo, errori, scarti SdI, pausa 429. Campanella più push, mai nomi; gli admin ricevono anomalie e «Da verificare» (decisioni 20–21).
2. **Verifica automatica degli esiti incerti** su Aruba: confronto su 5 campi, «Rimanda» con lo stesso XML e numero entro 12 giorni, 3×429, ricollegamento dei doppioni 00404 (decisioni 15, 16, 20). Oggi un esito incerto diventa `errore/esito_incerto` e si controlla a mano sul pannello.
3. **Cancello Aruba condiviso con la sync SdI**, più il giornale dei numeri (`fatture_coda_invii`) prima dell'upload.
4. **«Fattura tutto il periodo»** (periodo, base della data, categorie, sedi; massimo 500).
5. **Selezione multipla nella lista Pagamenti** e **sezione «Pagamenti e fatture» nella scheda alunno**.
6. Livelli di testa (rimandate → ritrasmissioni → urgenti), «Urgente» sulle selezioni multiple, causale scritta a mano modificabile dalla pagina.
7. 410 sulle vecchie route d'emissione; conservazione a 24 mesi con pulizia; test cardine su PGlite completo; E2E nuovi.
8. Note di credito TD04 (progetto separato, decisione 4).
9. I cinque rilievi (a)-(e) di questa PR, elencati sopra; il (f) aspetta prima la decisione del titolare.

Materiale utile già scritto e **non** integrato: `$LAVORO/r2a-f1-parziale-modifiche.patch` e `r2a-f1-parziale-nuovi.tgz`. È la fase R2A-F1 del piano completo (contratto-db.ts, Aruba finto, moduli), mai approvata dal critico.

## 4. Decisioni del titolare

In `/Users/lerri/.claude/plans/voglio-velocizzare-la-fatturazione-generic-marshmallow.md`: 29 decisioni definitive più i default. Le più importanti per chi riprende:
- ritmo fisso a 50/ora;
- data del documento = giorno d'invio;
- numero preso all'invio;
- ogni emissione passa dalla coda (con l'eccezione dell'intestatario «Altro», §3.a, fino alla seconda consegna);
- tutta la segreteria vede tutta la coda;
- migrazioni solo dall'integrazione al merge;
- rilascio in autonomia;
- verifica dal vivo con fatture vere.

## 5. Metodo

Ogni fase è un Workflow: esecutori in parallelo su file disgiunti, poi un critico che verifica, rompe su una patch reversibile e fa il commit. Flussi riusabili:
- `esegui-fasi-coda-fatture` (legge la scomposizione);
- `nucleo-coda-fatture`.

Lezioni:
1. Il contratto unico va scritto **prima** dei progettisti in parallelo.
2. Il titolare chiede tempi brevi: consegne piccole e verificabili.
