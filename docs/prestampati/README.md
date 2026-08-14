# Prestampati — i 17 moduli che l'app deve generare

Questa cartella contiene i **modelli sorgente** dei prestampati Kidville: il testo esatto di
ciascun documento, cosa l'app precompila da sola, cosa il form chiede alla persona, come si firma
e dove finisce il PDF.

Dieci di questi modelli **esistono già** come `.docx` nell'archivio della scuola
(`SOCIETA/modulistica/modulistica_2026-07/`, set di luglio 2026) e qui sono trascritti alla
lettera: il testo non si reinventa, si porta in app. Cinque sono **nuovi**, scritti sulla stessa
linea — stessa intestazione, stesso blocco DATI DELL'ALUNNO/A, stesse formule di chiusura.

Gli altri prestampati censiti non stanno qui di proposito: o sono già dentro il modulo di
iscrizione, o vanno riscritti da capo ogni anno scolastico e non ha senso cablarli.

## Prima di tutto: la carta

**[00 — Carta intestata, impaginazione, firma e protocollo](00-impaginazione.md)** vale per tutti e
diciassette e va letto per primo. Fissa in millimetri la testata, il ritmo verticale, il blocco
firma e — per i certificati che escono dalla scuola — protocollo, firma del legale rappresentante e
blocco di verifica con impronta SHA-256.

## L'elenco

| # | Prestampato | Chi lo compila | Firma | `document_type` | Fonte |
|---|---|---|---|---|---|
| [05](05-scheda-sanitaria.md) | Scheda sanitaria | genitore | OTP | `scheda_sanitaria` | 📄 prestampato 01 |
| [06](06-autorizzazione-farmaci.md) | Autorizzazione somministrazione farmaci | genitore | OTP + accettazione direzione | `autorizzazione_farmaci` | 📄 prestampato 02 |
| [07](07-dieta-speciale.md) | Richiesta dieta speciale | genitore | OTP | `dieta_speciale` | 📄 prestampato 03 |
| [08](08-delega-ritiro.md) | Delega al ritiro | genitore (entrambi) | OTP × 2 | `delega_ritiro` | 📄 prestampato 04 |
| [09](09-permesso-entrata-uscita.md) | Permesso entrata posticipata / uscita anticipata | genitore | OTP | `permesso_orario` | 📄 prestampato 05 |
| [10](10-autorizzazione-uscita.md) | Autorizzazione uscita didattica / gita | genitore | OTP | `autorizzazione_uscita` | 📄 prestampato 06 — **generato a ogni gita creata** |
| [26-27](26-27-certificato-iscrizione-frequenza.md) | Certificato di iscrizione e frequenza | segreteria + self-service | legale rappr. | `certificato_iscrizione_frequenza` | 📄 prestampato 11 + app |
| [28](28-certificato-bonus-nido.md) | Certificato per Bonus Asilo Nido INPS | **anche il genitore, in automatico** | legale rappr. | `certificato_bonus_nido` | 📄 prestampato 12 |
| [30](30-nulla-osta.md) | Nulla osta al trasferimento | segreteria | legale rappr. | `nulla_osta` | 📄 prestampato 10 + app |
| [31](31-richiesta-disponibilita.md) | Richiesta disponibilità a istituto terzo | segreteria | legale rappr. | *(protocollo in uscita)* | 📄 prestampato 09 |
| [39](39-solleciti.md) | Solleciti di pagamento (3 livelli) | automatico | — | *(email + `solleciti`)* | ✅ già in app |
| [42](42-verbale-infortunio.md) | Verbale di infortunio + comunicazione | educatrice + direzione | direzione | `verbale_infortunio` | ➕ **nuovo** |
| [45](45-documento-valutazione-infanzia.md) | Documento di valutazione — infanzia | insegnante | OTP genitore | `valutazione_infanzia` | ➕ **nuovo** |
| [46](46-certificato-competenze.md) | Certificato delle competenze | insegnante | legale rappr. | `certificato_competenze` | ✅ già in app |
| [47](47-certificato-di-servizio.md) | Certificato di servizio (personale) | segreteria | legale rappr. | *(fascicolo personale)* | ➕ **nuovo** |
| [49](49-stampe-di-sezione.md) | Stampe di sezione (elenco, allergie, emergenze) | segreteria / insegnante | — | *(non archiviato)* | ➕ **nuovo** |
| [50](50-registro-presenze-mensile.md) | Registro presenze mensile firmabile | insegnante + direzione | direzione | `registro_presenze` | 🔶 parziale in app |

## Il nucleo comune — precompilato in tutti

Nessun modello richiede questi dati: l'app li ha già. Il blocco DATI DELL'ALUNNO/A dei prestampati
cartacei è **interamente** coperto da qui.

| Segnaposto | Origine |
|---|---|
| `{{alunno.cognome}}` `{{alunno.nome}}` | `alunni.cognome`, `alunni.nome` |
| `{{alunno.data_nascita}}` | `alunni.data_nascita` |
| `{{alunno.luogo_nascita}}` | `alunni.birth_city` + `alunni.birth_province` |
| `{{alunno.codice_fiscale}}` | `alunni.codice_fiscale` |
| `{{alunno.sezione}}` | `alunni.classe_sezione` |
| `{{alunno.allergie}}` | `alunni.allergies`, `alunni.allergeni` |
| `{{sede.*}}` — nome, indirizzo, CAP, città, provincia, cod. meccanografico | `scuole` + `scuole.config.anagrafica` |
| `{{scuola.ragione_sociale}}` `{{scuola.piva}}` `{{scuola.sede_legale}}` `{{scuola.legale_rappresentante}}` | `scuole.config.anagrafica` — **mai cablati nel codice**: il repo è pubblico e il CdA cambia |
| `{{genitore.*}}` — nome, cognome, CF, telefono, email, tipo e n. documento, residenza | `parents` via `student_parents` |
| `{{anno_scolastico}}` | `annoScolasticoCorrente()` |
| `{{data_oggi}}` `{{luogo_data}}` | `rigaLuogoData()` in `src/lib/certificati/self-service.ts` |
| `{{protocollo}}` | `protocolli` (solo documenti in uscita) |

**Un campo chiesto una volta non si richiede mai più.** Pediatra, ASL, contatti d'emergenza
entrano in anagrafica al primo modulo che li usa e dal secondo in poi sono prefill. È la
differenza fra digitalizzare un modulo e digitalizzare la segreteria.

## Cosa manca al database

| Serve a | Cosa aggiungere |
|---|---|
| 05 scheda sanitaria | pediatra (nome, telefono), ASL/studio, stato vaccinale, patologie croniche → colonne su `alunni` |
| 05 scheda sanitaria | contatti d'emergenza con ordine di chiamata → tabella nuova |
| 06 farmaci | terapie in corso + **registro delle dosi somministrate** → tabella nuova |
| 07 dieta | righe alimento → sostituzione → tabella nuova |
| 42 infortunio | tabella verbali + registro infortuni |
| 47 certificato di servizio | periodi di servizio del personale (già parziale in anagrafica personale) |

Il resto è tutto in `alunni`, `parents`, `scuole`, `delegates`, `student_documents`.

## Le regole che valgono per tutti e 17

1. **Un solo motore.** Modello + prefill + form del delta + PDF + firma + archiviazione. La carta
   intestata, il timbro e l'impaginazione sono quelli di `src/lib/protocolli/documento-pdf.ts`,
   non 17 generatori diversi.
2. **Firma del genitore = OTP**, sul flusso già collaudato di `forms_submissions`
   (`otp_secret`, `signature_log`, `is_signed`, `pdf_path`). Ogni firma scrive in
   `firme_documenti` e rende scaricabile la ricevuta FEA di `src/lib/fea/receipt-pdf.ts`.
3. **Il PDF finisce in `student_documents`** con il suo `document_type`, `expiry_date` dove ha
   senso (delega, certificato medico, permesso a periodo) — così le scadenze le vede già il cron
   di `src/app/api/notifiche/scadenze-documenti/route.ts` senza scrivere niente di nuovo.
4. **Ciò che esce dalla scuola si protocolla** (`protocolli` + `protocolli_allegati`): certificati,
   nulla osta, richiesta di disponibilità, certificato di servizio.
5. **Ogni lettura del fascicolo passa da `fascicolo_accessi_audit`.** Esiste già.
6. **05, 06, 07 e 42 contengono dati sanitari di minori** (art. 9 GDPR): bucket con oblio, mai nei
   log, redazione a lista bianca. Un allergene o un farmaco in `app_log` è un incidente, non un
   dettaglio.
7. **Ogni sede dichiara la propria.** `resolveScuolaScrittura` risponde 400 se l'utente ne ha più
   d'una e nessuna è indicata: un prestampato che "indovina" la sede archivia il documento nel
   plesso sbagliato in silenzio.

## Convenzioni dei modelli

- `{{campo}}` — precompilato dall'app, non chiesto.
- `[CAMPO: tipo]` — chiesto dal form.
- `☐` — casella che nel PDF si spunta da sé quando il dato è noto (es. la sede).
- Le righe con `RISERVATO A…` restano nel PDF: sono il pezzo che la segreteria compila dopo.
