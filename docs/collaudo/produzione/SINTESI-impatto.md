# Sintesi — cosa hanno davvero incontrato i tester fra il 6 e il 20 agosto 2026

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit e verificata
> da un secondo revisore, dei difetti che gli utenti dell'app potevano incontrare nella finestra del
> test chiuso.

Fonte: `00-INVENTARIO-difetti-6-20-agosto.md` e i dodici `impatto-profilo-NN-*.md`. Tutti e dodici
sono stati **respinti al primo giro** da un revisore indipendente e poi corretti. Le correzioni hanno
quasi sempre **accorciato** l'elenco: molti difetti dell'inventario sono nati e morti dentro lo stesso
rilascio e in produzione non sono mai esistiti.

**La cosa da leggere per prima è questa: l'elenco è corto perché è stato verificato.** Su 71 voci
numerate della PARTE A, **13 non sono sopravvissute in nessuno dei dodici documenti** — nemmeno in
uno. Non sono state dimenticate: sono state misurate e tolte, con il comando che lo dimostra.

Ogni numero di questo file è il risultato di un comando eseguito il 2026-08-20, non di un ricordo.

---

## In una tabella: quanti difetti per profilo

Conteggio eseguito sui file, non sui riassunti:

```
# righe tenute in tabella, per documento
awk -F'|' '/^## I difetti che questo profilo poteva incontrare/{on=1;next} \
           on&&/^## /{on=0} on&&/^\|/{print $2}' impatto-profilo-NN-*.md \
  | grep -v '^ *#' | grep -v -- '---' | grep -c .
```

| # | Profilo | Righe **tenute** in tabella | Voci d'inventario **escluse** con prova |
|---|---|---|---|
| 01 | genitore, infanzia (3-6), Giugliano | 12 | 18 |
| 02 | genitore, scuola primaria | 10 | 17 |
| 03 | genitore con due figli (infanzia + primaria) | 12 | 15 |
| 04 | genitore, Kidville Aversa | 21 | 9 |
| 05 | genitore, Kidville Cesa | 17 | 9 |
| 06 | genitore che iscrive un figlio per la prima volta | 6 | 9 |
| 07 | maestra, sezione infanzia | 4 | 4 |
| 08 | maestra, scuola primaria | 8 | 2 |
| 09 | segreteria, Giugliano (sede singola) | 14 | 15 |
| 10 | segreteria su più sedi | 24 | 4 |
| 11 | Direzione | 19 | 11 |
| 12 | persona che si candida da «Lavora con noi» | 5 | 12 |
| | **Totale** | **152** | **125** |

**Come sono contate le due colonne**, perché senza la definizione i numeri non valgono niente:

- *Tenute* = righe di dati della tabella «I difetti che questo profilo poteva incontrare». Comprende
  le righe senza numero d'inventario (una sola, nel profilo 11) e le righe `C.1`.
- *Escluse con prova* = voci d'inventario **nominate una per una** (un numero, oppure `C.1`) che il
  documento dichiara non incontrabili da quel profilo, con la ragione. **Non** sono contate le
  esclusioni in blocco (`n. 27-33`, `n. 34-60`, `n. 62-71`, PARTE B, PARTE C.2), che sono comunque
  presenti in quasi tutti i documenti: contarle una per una gonfierebbe la colonna di centinaia di
  voci senza aggiungere una verifica.
- Le 152 righe **non** sono 152 difetti: contengono ripetizioni fra profili. Deduplicate diventano
  **60**, ed è la tabella della sezione successiva.

Due note di lettura che il conteggio da solo nasconde:

- il **profilo 07** ha solo 4 esclusioni nominate, ma tiene **fuori dalla tabella** altre quattro voci
  in una sezione a parte («I difetti che questo profilo subiva senza poterli vedere»: n. 9, 24, 28,
  33), e di una di quelle — la n. 9 — dichiara che *in produzione non è mai potuta accadere*;
- il **profilo 08** ha solo 2 esclusioni nominate perché il suo perimetro è quasi tutto escluso in
  blocco; una delle due, la n. 32, è una **ritrattazione contro sé stesso** (l'aveva messa in tabella).

---

## L'elenco unico, deduplicato, ordinato per gravità

60 voci distinte sulle 152 righe. Le date sono **timbri di commit**: la pagina servita arriva da
1 minuto a 2 minuti e mezzo dopo (misura in fondo). Dove un documento ha misurato l'ora di
servibilità, la riporto fra parentesi.

**⚠️** = voce **contestata**: almeno un documento la tiene in tabella e almeno un altro la esclude
con una misura. Il dettaglio sta nella sezione «Dove i dodici documenti si contraddicono».

### Bloccanti

| # | Difetto | Chi lo incontrava | Finestra in produzione | Commit |
|---|---|---|---|---|
| 1 | Otto rotte del genitore rispondevano **500 con corpo vuoto**: scrivere alla maestra, inviare un modulo, chiedere il codice di firma, rispondere a un avviso, comunicare/annullare/giustificare un'assenza. Turbopack compilava il ramo `: null` di un ternario nella stringa `"TURBOPACK unreachable"` | 01 · 02 · 03 · 04 · 05 · 07 | ≥29/07 → **08/08 22:54** | `f59854ab` |
| 2 | **«Comunica un'assenza» non era mai stata utilizzabile da nessuno**: il pulsante compariva ai non-primaria, la rotta rispondeva 403 «solo primaria». Prova: 0 notifiche `assenza_comunicata` da sempre | 01 · 02 · 03 · 04 · 05 | sempre → **08/08 22:54** | `f59854ab` |
| 3 | Il pulsante d'invio dell'assenza **coperto dalla barra di navigazione**: si toccava e si finiva sul Diario | 01 · 03 · 04 · 05 | ≤06/08 → **08/08 22:54** | `f59854ab` |
| 5 | Il campo «Motivo» **sotto il piede appiccicato** su schermi 640-731 px: si toccava il campo e si premeva Invia | 01 · 03 · 04 · 05 | **08/08 22:54 → 09/08 00:38** (1h 44m 17s, di notte) | `7ef10e87` |
| 13 | `/parent/primaria/assenze` su **«Caricamento…» per sempre**; e una lettura fallita mostrata come **«nessuna assenza»** | 02 · 03 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 15 | Con l'**Alto Contrasto** acceso i due campi del modulo erano **bianchi su bianco**; conferma non annunciata; il formato `gg/mm/aaaa` che spariva digitando | 01 · 02 · 04 · 05 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 18 | Una data malformata dal database **faceva cadere l'intera schermata**; e l'elenco storico non portava l'anno | 02 · 03 · 04 · 05 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 20 | **«Caricamento…» per sempre** quando un pezzo del programma non arrivava: nessun messaggio, nessun pulsante. `ChunkErrorBoundary` esisteva e **non era montato da nessuna parte** | 01 · 02 · 03 · 04 · 05 · 06 · 07 · 12 | **04/08 16:45 → 15/08 00:25** (servibile 00:27:29) | `0e8480a3` |
| 21 | **Con due figli, il certificato usciva intestato al bambino sbagliato**: il tab «Certificati» usava sempre `children[0]`, ignorando il selettore in cima alla stessa pagina | 03 · 04 | ≤14/08 → **15/08 00:25** | `0e8480a3` |
| 22 | Il certificato scaricato dalla famiglia portava **banda verde inventata, «KIDVILLE SCHOOLS», indirizzo doppio e la firma di un «Dirigente Scolastico»** che in una cooperativa non esiste | 01 · 02 · 03 · 04 · 05 · 09 | ≤06/08 → **16/08 11:31** (servibile 11:33:50) ⚠️ | `0974424a` |
| 24 | **Il modulo di autorizzazione alla gita non compariva mai**, nemmeno quando la gita c'era; orari vuoti quando usciva; la notifica apriva la schermata sbagliata | 01 · 02 · 03 · 04 · 05 (+07 dal lato di chi la pubblicava) | ≤15/08 → **16/08 11:31** | `0974424a` |
| 26 | Domanda d'iscrizione inviata dal modulo pubblico e **nessuna ricevuta**: 387 domande registrate, 381 con email valida = **381 ricevute mai partite** | 01 · 03 · 04 · 05 · 06 · 12 | preesist. → **15/08 02:48** (servibile 02:50:57) | `b43a556e` |
| 27 | **«Alunno non trovato»** quando era la lettura del database ad essere fallita; e una lettura fallita delle sezioni assegnate letta come «nessuna sezione», che chiudeva la porta alla maestra giusta | 07 · 08 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 28 | Al browser di docente, segreteria e Direzione arrivavano — **senza essere mostrati** — il motivo sanitario del minore, la nota d'appello e la firma del genitore con **email, IP e user-agent**; su due rotte finivano anche in `audit_scritture_docente`, conservato per anni | 08 · 11 (+10, in prosa) | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 33 | **Un genitore innocente veniva accusato**: un guasto di lettura diventava un 403 «questo non è tuo figlio» e accendeva il contatore IDOR contro una famiglia che non aveva fatto niente. Gate di 20 rotte | 02 · 08 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 34 | **Nessuna scansione di documento d'identità del personale era più apribile, in nessuna delle tre sedi** — e la frase mostrata era quella di un tentativo abusivo: «non esiste, oppure appartiene a un'altra sede» | 09 · 10 · 11 | 12/08 (ora **non provata**) → **13/08 02:24** (servibile 02:27:01) | `d7af75b6` |
| 35 | **503 su ogni apertura di fascicolo del personale** | 09 · 10 · 11 | idem | `d7af75b6` |
| 37 | **Sette pagine** (contabilità, news, mensa, modulistica, primaria, impostazioni, SIDI) dicevano «Hai più sedi attive. Scegline una sola dal menu in alto» — **e quel menu non si montava affatto**. E la potatura del cookie cancellava la sede già scelta | 10 · 11 | preesist. → **13/08 02:24** | `d7af75b6` |
| 38 | **«Elimina Alunno (GDPR)» falliva su 28 bambini su 33** con un 409 tecnico | 10 · 11 | preesist. → **13/08 02:24** | `d7af75b6` |
| 39 | Si confermava un'anonimizzazione **irreversibile** leggendo «file da rimuovere: 3» — dentro c'erano **pagelle e certificati medici** che nessuna riga nominava; se il dry-run falliva **il bottone rosso restava attivo**; e l'altro pannello mostrava i numeri **di un bambino diverso** | 10 · 11 | preesist. → **13/08 02:24** | `d7af75b6` |
| 40 | **La scheda del genitore non salvava niente**: ogni «Salva» falliva **dal 5 luglio**. Prova: 255 `update` riusciti e **zero** con `entita_tipo='genitori'` | 09 · 10 | **05/07 → 11/08 10:16** (servibile 10:18:07) | `a9dcc6d8` |
| 41 | I prestampati firmati dalla Scuola rifiutavano di uscire chiedendo un campo che **in nessuna schermata esisteva**; e `legale_rappresentante` **veniva cancellata al primo salvataggio** | 04 · 09 · 10 · 11 | 15/08 00:25 → **15/08 12:12** (servibile 12:13:13) — **e resta aperto** finché i campi non sono compilati sede per sede | `0e0ba538` |
| 42 | La carta intestata trascinata nel tab «Template Certificati ODT» diceva «caricato» e **al primo aggiornamento spariva tutto**: i tre `onChange` salvavano solo il nome del file in uno `useState` | 09 · 10 | preesist. → **16/08 11:31** | `0974424a` |
| 47 | **«Prendo in considerazione questa candidatura» consegnava nello stesso clic le chiavi del registro di 33 minori**: creava un account `educator` e ne spediva la password a un indirizzo arrivato da un modulo pubblico anonimo. Mentre approvare l'anagrafica vera **non spediva niente** | 10 · 11 · 12 | **11/08 10:16 → 15/08 19:23** (4 giorni e 9 ore) | `fcc51fc8` |
| 50 | **Una spunta su un modulo pubblico e anonimo dava a qualcuno l'elenco delle classi di primaria — cioè i bambini.** `utenti.gradi` è uno scope di autorizzazione e arrivava da una casella del form, applicata anche a un account preesistente | 10 · 11 ⚠️ | 11/08 10:16 → **15/08 19:23** (porta candidature) · 12/08 07:09 (porta anagrafica) | `fcc51fc8` · `65e3631c` |
| 51 | `POST /api/admin/adults`: `role` era `z.string()` libero sotto `requireStaff` — la segreteria si sarebbe potuta creare un `admin`. Nessun sintomo a schermo: nessun pulsante ci portava | 10 · 11 | mesi → **11-12/08** | `a9dcc6d8` · `65e3631c` |
| 57 | Chi caricava la scansione della propria carta d'identità e chiudeva la pagina la lasciava **nel bucket senza nessuna riga che la nominasse**: invisibile alla conservazione, non cancellabile su richiesta | 09 · 10 · 11 | 12/08 → **12-13/08** | `65e3631c` · `d7af75b6` |
| 64 | Sul modulo d'iscrizione un campo sbagliato aveva **lo stesso identico bordo** di uno giusto: l'errore lo sapeva solo lo screen reader. La veste unica stava lì **dal 30/05** | 06 | 30/05 → **11/08 10:16** | `a9dcc6d8` |
| 68 | **Il curriculum non si poteva allegare**, e tre caselle obbligatorie sulle fasce d'età rendevano **impossibile candidarsi** a collaboratrici, cucina e segreteria | 12 | 11/08 10:16 → **15/08 02:48** | `b43a556e` |
| — | Una candidatura rimasta a metà diceva «Approvazione rimasta a metà · l'account docente **È STATO CREATO**» e spegneva sia «Approva» sia «Rifiuta»: **da lì non si usciva più** *(voce senza numero d'inventario)* | 11 | 11/08 10:16 → **15/08 19:23** | `fcc51fc8` |
| C.1 | **La tabella `candidature_sedi` è stata pubblica**, creata senza `enable row level security`: con la chiave `anon` che sta nel bundle di chiunque apra il sito, `GET /rest/v1/candidature_sedi` rispondeva con le righe — **quante candidature ha ricevuto ogni plesso**, e il motivo di rifiuto scritto a mano. Nello stesso giro il trigger era `SECURITY DEFINER` senza `REVOKE` | 09 · 11 · 12 | **20/08 ~00:50 → ~01:27** (≥36m11s, l'istante d'apertura **non è provato**) | `ddfe3b0e` — **non su `main`** |

**Bloccanti contestati** (un documento li tiene, un altro li esclude con una misura — vedi la sezione
delle contraddizioni):

| # | Difetto | Tenuto da | Escluso da | Commit |
|---|---|---|---|---|
| 4 ⚠️ | Toccando «Leggi l'informativa» **partiva la comunicazione dell'assenza** | 04 · 05 | 01 | `f59854ab` |
| 6 ⚠️ | Il messaggio di rifiuto nasceva **dietro** il piede appiccicato: si premeva Invia e non cambiava un pixel | 04 · 05 | 01 · 02 · 03 | `f59854ab` |
| 9 ⚠️ | **Comunicando un'assenza il genitore sovrascriveva l'appello già fatto dalla maestra** | 04 · 08 | 01 · 02 · 03 · 07 | `f59854ab` |
| 10 ⚠️ | Annullando un'assenza si cancellava **una presenza di qualunque giorno passato** | 04 · 08 | 01 · 02 · 03 | `f59854ab` |
| 11 ⚠️ | Ricomunicando lo stesso giorno, il **motivo sanitario del minore** veniva sovrascritto o azzerato in silenzio | 04 | 01 · 02 · 03 | `f59854ab` |
| 44 ⚠️ | Una pratica del personale ferma in `in_approvazione` **non aveva nessuna uscita**: tre comandi spenti su tre | 10 | 09 · 11 | `65e3631c` |
| 46 ⚠️ | Premendo «Carica il fronte» e incappando in un 503 si leggeva **la frase di un'altra schermata** | 11 | 09 · 10 | `d7af75b6` |
| 48 ⚠️ | Approvare **una cuoca** avrebbe creato un account `educator` che legge l'anagrafica dei bambini | 10 | 11 · 12 | `b43a556e` |
| 49 ⚠️ | La Segreteria di una sede poteva farsi aprire **il curriculum di chi si era proposto a un'altra**, e la riga di sorveglianza attribuiva la lettura alla candidatura sbagliata | 09 · 10 · 11 | 12 | `b43a556e` |
| 53 ⚠️ | Il registro presenze **tagliava i nomi dei bambini a metà parola**, senza puntini e senza avviso | 10 | 09 | `0974424a` |
| 55 ⚠️ | Tre fogli di **carta intestata** — marchio, filigrana, P.IVA, le tre sedi — spediti a un fornitore, consegnati a una famiglia, allegati a un ente, con sopra due righe di conteggio | 10 | 09 | `0974424a` |
| 58 ⚠️ | Il gate di forma sul percorso del documento del personale **non veniva mai eseguito** | 09 · 11 | 10 | `d7af75b6` |

### Fastidiosi

| # | Difetto | Chi lo incontrava | Finestra in produzione | Commit |
|---|---|---|---|---|
| 14 | Il pulsante primario, **mentre si aspetta**, era illeggibile: contrasto **1,20:1** (→ 5,75:1). Su tutta l'app | 01 · 02 · 04 · 05 | **29/06 14:08** → 08/08 22:54 | `f59854ab` |
| 16 | Col telefono in inglese, **«Value must be … or later» dentro un'app italiana**, in una bolla di sistema | 01 · 04 · 05 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 19 | Chi ha **un figlio per grado** vedeva due prodotti diversi: menu diverso, linguetta diversa, e la stessa piastrella che portava a un modulo da una parte e a nessun modulo dall'altra | 03 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 23 | Il certificato protocollato usciva di **due pagine**, la seconda con la sola firma e tredici centimetri di vuoto | 04 · 05 | 15-16/08 → **16/08 11:31** | `0974424a` |
| 29 | Il registro contava come «passata» un'assenza **futura** («2 A» e «10 ore» per una sola); e sull'appello di **primaria** fra mezzanotte e le due si apriva — e si **salvava** — sul giorno prima | 07 (metà) · 08 | ≤07/08 → **08/08 22:54** | `f59854ab` |
| 31 ⚠️ | Sulle uscite/gite, 12 messaggi d'errore erano frasi italiane nude, senza codice: in app inglese restavano muti | 08 (marcato *latente*) | preesist. → **15/08 00:25** | `0e8480a3` |
| 36 | Il cruscotto Scadenze dichiarava mancante una scansione **che nell'archivio c'era**, con `ok: true` e nessun errore | 09 · 10 · 11 | 12/08 → **13/08 02:24** | `d7af75b6` |
| 43 | Il pannello **«Sala d'Attesa» era irraggiungibile da mesi**: non stava in nessun elenco | 09 · 10 | mesi → **16/08 11:31** | `0974424a` |
| 52 ⚠️ | Il certificato per il Bonus Nido era **irrilasciabile proprio alla famiglia sospesa per morosità** — che è quella che lo chiede | 10 | 09 | `0e8480a3` |
| 56 ⚠️ | Salvare l'anagrafica di sede **rispondeva 400**: il tetto di 20 caratteri sul codice meccanografico era tarato su UN codice, e Giugliano e Cesa ne hanno due (23 caratteri) | 09 · 10 | 05 | `0974424a` |
| 59 | `/anagrafica-personale` chiedeva **una sola faccia** del documento — e residenza e firma stanno sul retro — mentre la tabella era vuota: 0 righe, 12 `educator` senza scheda | 09 · 10 · 11 | 12/08 07:09 → **13/08 02:24** | `d7af75b6` |
| 60 | Le caselle di consenso avevano **la label che inglobava l'intero corpo dell'informativa**: toccare il testo per rileggerlo **spuntava il consenso** (area 328×373 px, label di 564 caratteri) | 06 · 10 · 11 | preesist. → **12/08 07:09** | `65e3631c` |
| 65 | Un campo vuoto sembrava già compilato: segnaposto e valore a **1,01:1**, e **1,00:1** in Alto Contrasto | 06 | ≤10/08 → 11/08 10:16 **in Alto Contrasto**; in luce normale solo **mitigato** (→1,28:1) | `a9dcc6d8` |
| 66 | Sulla schermata dove si sceglie **il plesso del proprio figlio**, il contorno fra una sede e l'altra era a **1,10:1**: a occhio non esisteva (→ 5,82:1) | 01 · 04 · 05 · 06 | **29/07 14:54** → 11/08 10:16 | `a9dcc6d8` |
| 7 ⚠️ | Dopo l'elenco delle assenze la pagina continuava a scorrere su **una schermata e mezza di nulla** (documento 2147 px, contenuto fino a 754) | 05 | 01 · 04 | `f59854ab` |

### Cosmetici

| # | Difetto | Chi lo incontrava | Finestra in produzione | Commit |
|---|---|---|---|---|
| 30 ⚠️ | La data nell'unica notifica prodotta per il docente era **ISO grezza** (`2026-08-09T…Z`) | 08 | 07 | `f59854ab` |

---

## I difetti che sembravano veri e non lo erano

È la sezione che dà credibilità a tutto il resto, e va letta come il vero prodotto di questo lavoro.

### Tredici voci dell'inventario non sono sopravvissute in NESSUNO dei dodici documenti

Su 71 numeri della PARTE A, **13 non compaiono in nemmeno una delle 152 righe tenute**:

```
n. 8 · 12 · 17 · 25 · 32 · 45 · 61 · 62 · 63 · 67 · 69 · 70 · 71
```

| # | Perché è caduto | Comando che lo dimostra |
|---|---|---|
| 8 · 17 | La barra verde che sparisce nella Dynamic Island e il calendario che si apre da solo sono **difetti di iPhone**. Il test chiuso di cui parlano i dodici documenti è quello di **Google Play**, su Android | rilievi misurati su `_UICalendarDateViewCell`, cioè iOS |
| 12 | «L'app diceva di aver tolto il motivo e non lo toglieva»: **nato e morto dentro `f59854ab`** — il componente che lo conteneva non esisteva in produzione | `git ls-tree -r 29da34b4 \| grep ComunicaAssenzaCard` → **vuoto** |
| 25 | Ogni «Scarica il certificato» che riemetteva bruciando un numero WORM: scatta **solo fra le 00:00 e le 02:00 del 1° agosto**, quando UTC ed Europe/Rome cadono ai due lati del confine di mese. **Cinque giorni prima** dell'inizio del test | `src/lib/anno-scolastico.ts:25-27` — `m >= 8 ? y/y+1 : y-1/y` |
| 32 | La barra dei docenti disallineata di 2 px: **la variabile a cui si sarebbe disallineata non esisteva** al commit precedente, e nasce con la correzione stessa | `git grep -c "kv-bottomnav-h" 29da34b4` → **vuoto** |
| 45 | Il pannello «Sede & Intestazione» che riscriveva sopra ciò che si stava digitando: **il pannello nasce nel commit che lo corregge** | `git log --diff-filter=A -- …/AnagraficaSedeSettings.tsx` → `0e0ba538` |
| 61 | Il codice fiscale di un minore mandato a un fornitore esterno: **non dal modulo pubblico**. La chiamata viveva solo in tre moduli di `admin/`, raggiungibili da `/admin/students/new` | `git grep -l fiscalCodeApi a9dcc6d8^ -- src` → 3 file, tutti in `components/features/admin/` |
| 62 · 63 · 67 · 70 · 71 | Il riepilogo che non riepilogava, «Modifica» di sola andata, il selettore `.doc`/`.docx`, l'estetica da portale amministrativo, i quattro rilievi di accessibilità: **`/lavora-con-noi` non esisteva in produzione prima dell'11/08 10:16**, e tutti e cinque sono nati e morti dentro il commit che lo ha pubblicato | `git log --all --diff-filter=A -- src/app/lavora-con-noi/page.tsx` → **una sola riga**, `a9dcc6d8`; riscontro indipendente in `public/sw.js:174` |
| 69 | Il 500 all'invio della candidatura per colonne mancanti: è un **rosso di CI dentro `b43a556e`**. Sul database di produzione le colonne nuove c'erano già (migrazione `20260814225302` applicata prima) | `git show --stat b43a556e` |

### Le voci che un revisore ha tolto contro sé stesso

Non è un dettaglio di stile: sono i casi in cui l'autore aveva già scritto la riga e poi l'ha smontata.

- **profilo 08, n. 32** — l'aveva in tabella. `git rev-list --parents -n 1 f59854ab` → un solo
  genitore; `git grep -c "kv-bottomnav-h" 29da34b4` → vuoto. *«È un difetto nato e chiuso dentro lo
  stesso squash, cioè la stessa regola che applico al ramo e che non avevo applicato al mio stesso
  commit.»* Nel merito la descrizione era anche sbagliata: lo scarto era su **entrambe** le barre.
- **profilo 12, n. 49** — l'aveva in tabella. La rotta che riceve i curriculum e la funzione che ne
  convalida il percorso **nascono con la correzione**: `git log --all --diff-filter=A --
  src/app/api/iscrizione/insegnanti/upload/route.ts` → solo `b43a556e`. Niente CV in produzione,
  niente da far uscire.
- **profilo 10, n. 45, 46 e 58** — tutti e tre tolti dalla tabella: *«è lo stesso errore ripetuto tre
  volte — attribuire a un utente il difetto di una schermata che, in quel momento, non era ancora sul
  suo telefono.»*
- **profilo 03, coda del n. 19** — la frase «solo una delle due schermate diceva fino a quando si può
  ritirare un'assenza» è caduta: `git grep -i "registra l.appello" 29da34b4 -- src` → **vuoto**. In
  produzione non lo diceva **nessuna** delle due, e non c'era comunque niente da ritirare.
- **profilo 07, metà del n. 29** — ritirata la parte «apro l'appello prima delle due di notte e trovo
  il registro di ieri»: l'appello 0-6 calcola la data con l'orologio **locale** e la manda al server
  sia in lettura sia in scrittura. Quella metà era vera, ma sulla **primaria** e sul cruscotto.
- **profilo 09, nota al n. 22** — ritirata l'affermazione «lo sportello era l'**unica** porta»: la
  seconda porta è nata nello stesso rilascio ed è quella della famiglia
  (`parent/modulistica/page.tsx:847`).

### Due numeri dell'inventario che erano sbagliati, e sono stati corretti misurando

- **`ChunkErrorBoundary` (n. 20)**: l'inventario dice «esisteva dal 03/08 con 11 test verdi».
  Misurato: `git log --all --diff-filter=A --format='%h %ci' -- '…/ChunkErrorBoundary.tsx'` →
  **`d244eea7`, 2026-08-04 16:45**; e `git show 0e8480a3:__tests__/components/ChunkErrorBoundary.test.tsx | grep -cE "^\s*(it|test)\("` → **10**, non 11.
  I profili 02 e 06 l'hanno misurato; i profili 05, 07 e 12 hanno ripetuto il dato dell'inventario.
- **Il ritmo del modulo d'iscrizione e la platea del n. 66**: «≈9 invii l'ora» e «375 famiglie» sono
  **commenti nel sorgente, non misure**. Il profilo 06 ha rifatto i conti: 387 domande in trenta
  giorni fanno **~13 al giorno**, e il passo della sede esiste solo dal 29/07 14:54 mentre al 31/07 le
  domande erano già 227 — quindi le famiglie che quella schermata l'hanno vista sono **almeno 160**,
  non 375. A nove all'ora, nei soli sei giorni fra il 6 e l'11 agosto ne sarebbero arrivate più del
  totale.

---

## Dove i dodici documenti si contraddicono

Le dichiaro invece di sceglierne una in silenzio, come prescritto. Dove un comando risolve la
contraddizione, lo scrivo: **risolvere non è scegliere in silenzio**.

### 1. I difetti delle assenze del 7-8 agosto: n. 4, 6, 7, 9, 10, 11, 12

**La contraddizione più grossa, e riguarda sette righe.** I profili **01, 02, 03** li escludono
tutti: sono nati dentro il ciclo di correzione della PR #74 e arrivati in produzione **già chiusi**,
nello squash `f59854ab` dell'8 agosto. I profili **04 e 05** ne tengono cinque in tabella (4, 6, 7,
9, 10, 11), e il profilo **08** tiene 9 e 10.

Misura eseguita adesso, allo stato in produzione il 6 agosto (`29da34b4`):

```
git ls-tree -r --name-only 29da34b4 | grep ComunicaAssenzaCard   →  vuoto
git show 29da34b4:src/app/api/parent/presenze/comunica-assenza/route.ts | grep -c 'export const DELETE'   →  0
```

Il componente non esisteva e **la rotta non aveva nessun `DELETE`**: i n. 10 e 12 (annullamento) non
erano fisicamente raggiungibili, e i n. 9 e 11 richiedono che un genitore *possa* comunicare
un'assenza — cosa che il n. 2 dell'inventario dimostra non essere mai avvenuta (0 notifiche
`assenza_comunicata` da sempre). Il profilo **07** lo scrive per esteso: *«difetto reale nel codice,
mai capitato a una maestra»*. **Le esclusioni di 01/02/03 reggono; le righe di 04, 05 e 08 no.**

### 2. n. 22 — da quando era rotto il certificato della famiglia

I profili **01, 02 e 03** dichiarano che «KIDVILLE SCHOOLS» era già in produzione **il 6 agosto**,
cioè per tutta la finestra; l'inventario apre la finestra al **15/08**; il profilo **05** scrive nella
prosa che è durato **35 ore**.

```
git grep -c "KIDVILLE SCHOOLS" 29da34b4 -- 'src/app/(dashboard)/parent/modulistica/page.tsx'   →  2
```

**Hanno ragione 01, 02 e 03.** Il profilo 09 non è in contraddizione: parla della porta dei
prestampati (`src/lib/prestampati/impaginazione.ts`), nata il 15/08, che è un'altra porta sullo stesso
difetto.

### 3. n. 56 — il 400 sull'anagrafica di sede

Il profilo **05** lo esclude: il commit che alza il tetto (`3721f884`, 16/08 01:35) **non è su nessun
branch**, quindi «il rifiuto è nato e morto dentro la lavorazione della PR #88». I profili **09 e 10**
lo tengono.

```
git branch --contains 0e0ba538 | grep -w main                                  →  main
git show 0e0ba538:src/lib/scuole/anagrafica.ts | grep codice_meccanografico     →  z.string().max(20)
git show 0e0ba538:…/CampiAnagraficaSede.tsx | grep meccanografico               →  il campo c'è, riga 66
git show 0974424a:src/lib/scuole/anagrafica.ts | grep codice_meccanografico     →  z.string().max(60)
```

**Hanno ragione 09 e 10.** Il campo e il tetto da 20 caratteri sono stati **insieme su `main`** dalle
12:12 del 15/08 alle 11:31 del 16/08: circa **23 ore in produzione**. Che `3721f884` non stia su un
branch dice quando il difetto è stato riparato *sul ramo*, non che lo stato rotto non fosse servito.
È la trappola opposta a quella della regola dello squash, ed è utile che si sia manifestata.

### 4. n. 44 e n. 48 — tenuti dal profilo 10, esclusi dagli altri

```
git log --all --diff-filter=A -- 'src/components/features/admin/*PratichePersonale*' \
                                 'src/app/api/admin/pratiche-personale/route.ts'   →  65e3631c
git show a9dcc6d8:src/lib/forms/insegnanti-template.ts | grep -c cuoca             →  0
git show b43a556e:src/lib/forms/insegnanti-template.ts | grep -c cuoca             →  4
```

**Hanno ragione 09, 11 e 12.** Il pannello Pratiche nasce nel commit che lo corregge; e prima del
15/08 **nessuna cuoca poteva candidarsi**, quindi non c'era nessuna cuoca da approvare.

### 5. n. 46 e n. 58 — chi li tiene e chi li toglie

```
git log --all --diff-filter=A -- 'src/app/api/admin/anagrafica-personale/scansione/route.ts'  →  d7af75b6
git log --all --diff-filter=A -- 'src/lib/personale/percorso-documento.ts'                     →  d7af75b6
```

Entrambi i file **nascono in `d7af75b6`, che è la correzione**. Il profilo 10 li toglie ed ha ragione;
il profilo 11 tiene il 46 e il 58, il profilo 09 tiene il 58 (pur avendo tolto il 46 con questo stesso
comando).

### 6. n. 49 — il curriculum di un'altra sede

```
git log --all --diff-filter=A -- 'src/app/api/iscrizione/insegnanti/upload/route.ts' \
                                 'src/lib/candidature/percorso-cv.ts'   →  b43a556e
```

**Ha ragione il profilo 12**: fino al 15/08 in produzione **non esisteva un solo curriculum** da far
uscire. È notevole che il profilo **09 citi la stessa misura** — *«0 candidature con curriculum, 0
file archiviati»* — e tenga comunque la riga in tabella: la prova era in mano, non è stata applicata.

### 7. n. 50 — quanto è larga l'esclusione del profilo 09

Il profilo 09 lo esclude **per tutti i profili**: *«Nessun tester di nessun profilo poteva
incontrarlo»*, perché `pratiche-personale/route.ts` nasce già corretto.

```
git show a9dcc6d8:src/app/api/admin/candidature-insegnanti/route.ts | grep -n gradi   →  righe 116, 121, 127, 163, 328, 609, 610, 628
```

**Hanno ragione 10 e 11 sulla seconda porta.** La rotta delle **candidature** scriveva `gradi`
sull'account creato ed è stata su `main` dall'11/08 al 15/08. L'esclusione di 09 vale per la porta
dell'anagrafica, non per l'altra.

### 8. n. 53 e n. 55 — il registro e la carta intestata

```
git log --all --diff-filter=A -- 'src/lib/presenze/registro-pdf.ts'   →  0974424a
git log --all --diff-filter=A --name-only -- 'src/lib/carta/'         →  0974424a (7 percorsi)
```

**Ha ragione il profilo 09**, che li esclude: il motore del registro e la carta intestata vera
nascono nel commit che li corregge. Nessun foglio con marchio, filigrana e P.IVA è mai uscito verso un
fornitore, una famiglia o un ente. Il profilo 10 li tiene entrambi in tabella.

### 9. n. 31 — le dodici frasi mute delle uscite/gite

Entrambi i documenti del docente hanno misurato la stessa cosa — `grep -rn "api/teacher/uscite" src/`
non trova **nessun chiamante** — e ne hanno tratto conclusioni opposte: il profilo **07** lo esclude,
il profilo **08** lo tiene marcandolo *latente* e scrivendo *«non ho potuto provare che un tester le
abbia potute leggere a schermo»*. **La misura è la stessa; è il criterio a divergere.**

### 10. Quanto è durata la falla C.1

Il profilo **12** scrive **37 minuti** come fatto. I profili **04 e 11** dicono 36 minuti fra i due
commit e dichiarano che **l'istante di apertura non è provato** — la migrazione era stata applicata al
database *prima* di essere committata, e l'autore della chiusura parla di «un'ora».

```
git show -s --format='%ci' e8319816   →  2026-08-20 00:50:56
git show -s --format='%ci' ddfe3b0e   →  2026-08-20 01:27:07     (36m11s)
```

**Hanno ragione 04 e 11**: 36m11s è un **minimo**, non la durata.

### 11. n. 30, n. 52, n. 7 — divergenze minori, stesso schema

- **n. 30** (data ISO nella notifica al docente): il profilo 07 lo esclude perché *nessuna notifica
  di quel tipo è mai partita* prima che la data fosse già corretta; il profilo 08 lo tiene.
- **n. 52** (Bonus Nido irrilasciabile alla famiglia sospesa): il profilo 09 lo chiama *«difetto
  evitato in partenza»* — lo sportello nasce il 15/08 già con la regola giusta; il profilo 10 lo tiene.
- **n. 7** (schermata e mezza di vuoto): tenuto dal profilo 05, escluso da 01 (l'elenco non esisteva)
  e da 04 (cosmetico).

---

## I difetti ancora aperti al 20 agosto 2026

Verificati **sul codice di `main` di oggi**, che è ciò che gira in produzione: l'ultimo commit
rilasciato è `b87ee964` del **17/08 01:35**, e dal 18 al 20 agosto la produzione non è più cambiata.

| Cosa | Stato verificato | Comando |
|---|---|---|
| **Il modulo pubblico promette credenziali che non arrivano più.** Il riquadro «Dopo l'invio» dice ancora: *«se la candidatura viene accolta, le credenziali di accesso arrivano via email all'indirizzo che hai scritto qui»*. Dal 15/08 19:23 quell'email non parte più: è il n. 47 rovesciato — non una password di troppo, ma **un'attesa che non finisce** | **APERTO** | `git show main:messages/it/public.json \| grep -c candContestoCredenziali` → **1**; `git show main:…/CandidaturaInsegnanteWizard.tsx \| grep -n candContestoCredenziali` → **riga 1907** |
| **Il pannello della Direzione promette la stessa cosa.** `candIntro` dice ancora «approvarne una da INSEGNANTE crea l'account docente e manda le credenziali»: `fcc51fc8` ha cambiato l'operazione e **non ha toccato la frase** | **APERTO** | `git show main:messages/it/adminAltro.json \| grep -o '"candIntro": "[^"]*"'` |
| **Una lettura fallita delle sezioni di un docente esce ancora come «nessuna sezione».** Il rilascio dell'8 agosto ha dato al guasto **una traccia**, non un esito diverso: `sezioniDiUtente` logga l'errore e poi ritorna comunque `(data ?? [])`. È il residuo dichiarato dal profilo 07: *«ciò che è finito è il silenzio, non il sintomo»* | **APERTO** | `git show main:src/lib/sezioni/docenti.ts` → riga 178, `if (error) segnalaLetturaFallita(…)` seguito da `return (data ?? []).map(…)` |
| **n. 65 in luce normale: mitigato, non chiuso.** Segnaposto e valore passano da 1,01:1 a **1,28:1**; a distinguerli resta soprattutto il corsivo. Il sorgente stesso argomenta che 1,30:1 è il tetto ottenibile senza scendere sotto 4,5:1 sul fondo: è un limite di progetto dichiarato, non una svista | **APERTO (mitigato)** | `git show main:src/app/globals.css` → blocco `--color-kidville-hint`: «1,28:1 col valore #006A5F (era 1,01:1)» |
| **n. 41, la coda.** I prestampati continuano a rifiutarsi finché **i tre legali rappresentanti e le tre autorizzazioni comunali** non vengono compilati sede per sede. Il campo esiste dal 15/08 12:12; se nessuno lo riempie, il rifiuto è identico | **DICHIARATO APERTO, NON VERIFICABILE DA QUI** — richiede una lettura del database di produzione, che questo lavoro non prevede | dichiarato dal profilo 09 nella propria sezione «cosa non sono riuscito a stabilire» |
| **La chiusura di C.1 non è codice rilasciato.** `ddfe3b0e` **non è su `main`**: la protezione vive nel database di produzione, applicata a mano. Finché quel ramo non viene rilasciato, il codice su `main` non contiene la riga che la accende | **APERTO come divario codice/database** | `git branch --contains ddfe3b0e` → solo `feat/candidature-multisede` |

---

## Le tre cose che questo lavoro ha insegnato sul metodo

**1. Un difetto nato e morto dentro lo stesso squash in produzione non è mai esistito — e il modo di
saperlo è un comando, non una lettura del messaggio di commit.**
I commit su `main` sono squash merge (`git rev-list --parents -n 1 <hash>` → un solo genitore), e la
produzione è cambiata **17 volte**, non di continuo. La forma operativa che i dodici documenti hanno
usato più di ogni altra è una sola riga:

```
git log --all --diff-filter=A -- <file>
```

**se il commit che fa nascere il file è lo stesso che lo corregge, quel difetto non è mai stato sul
telefono di nessuno.** Ha smontato 13 voci su 71 da solo. Ma va usato sul **file giusto**: il n. 56
dimostra il rovescio — il tetto stava su `main` da luglio e il campo per violarlo è arrivato il 15
agosto, quindi lo stato rotto è stato servito per 23 ore anche se il commit che lo ripara non sta su
nessun branch.

**2. Fra il commit e la pagina servita c'è una build — e adesso è misurata, non più dichiarata
ignota.** Il profilo 09 l'ha letta da Vercel su sei rilasci di produzione (`repoPushedAt` contro
`ready`, tutti `target: production`, `READY`, alias `app.kidville.it`): **da 1m01s a 2m29s**. La
conseguenza va nella direzione scomoda e resta: **ogni guasto è durato un po' più di quanto scritto**,
mai meno. Ora però si sa di quanto, e non cambia nessuna conclusione.

**3. La sezione dell'inventario dice chi ha SEGNALATO il difetto, non chi lo SUBISCE.**
È la lezione del profilo 07, ed è quella che ha cambiato più righe di posto. Il n. 20 è una rete
montata su `src/app/layout.tsx`, cioè su tutta l'app, non «roba del genitore»: è finito nelle tabelle
di **otto** profili su dodici. Il n. 33 sta sotto «DOCENTE» ma la vittima è il genitore. I n. 9 e 10
stanno sotto «GENITORE» ma il danno cade sul registro della maestra. Il n. 1 sta sotto «GENITORE» ma
il gate che si rompeva gira su chiunque sia autenticato, quindi cadeva anche il «Invia» della maestra.
**Ogni riga va riportata al codice prima di escluderla per categoria.**

**4 — la quarta, trovata leggendo i dodici documenti: un numero scritto in un commento non è una
misura.** «≈9 invii l'ora», «375 famiglie», «esisteva dal 03/08 con 11 test verdi»: tre numeri presi
da commenti nel sorgente, tre numeri sbagliati. Il ritmo vero è ~13 al giorno, la platea è **almeno
160**, il componente nasce il **04/08** e i test sono **10**. Il commento invecchia insieme al codice
che descrive e nessuno lo rilegge; il comando no. Vale anche per i commenti scritti dai revisori
stessi: il numero «16 cambiamenti in produzione» circolava fra i primi documenti ed era sbagliato,
e `git log --first-parent main --since=… | wc -l` → **18** (cioè 17 cambiamenti dopo lo stato di
partenza) ha impiegato un secondo a dirlo.

---

## Cosa NON sappiamo

I limiti che i documenti dichiarano da sé, riportati senza attenuarli.

- **La gravità è nostra, non dei tester.** «Bloccante», «fastidioso», «cosmetico» sono giudizi presi
  dall'inventario e dai dodici documenti. **Nessun tester li ha espressi.** Questo file non contiene
  nessuna testimonianza, nessuna frase attribuita a una persona, nessuna prima persona che simuli un
  utente: dice cosa un utente **poteva** incontrare, non cosa ha incontrato.

- **Non sappiamo se qualcuno li ha davvero incontrati.** Il profilo 09 lo scrive con precisione: *«Il
  guasto è provato; l'uso no.»* Non esiste, in questi documenti, una sola prova che un tester abbia
  aperto una determinata schermata in una determinata ora.

- **Il fuso dei timbri di migrazione: due ore di incertezza, non un minuto.** Il timbro `194501` del
  12 agosto decide se il guasto peggiore della finestra (n. 34, 35, 36, 57, 58) è durato **6h40** o
  **4h40**. Nessuno l'ha provato. Il profilo 10 va oltre e rifiuta di scriverne l'ora: il nome di un
  file di migrazione dice quando quel file è stato **scritto**, non quando è stato **applicato**, e le
  tre migrazioni vicine distano 16 e 57 secondi — la firma di file creati in blocco, non di tre
  applicazioni distinte in produzione. **Provata è solo la chiusura.**

- **Il divario commit/deploy adesso è misurato, ma su sei rilasci su diciassette.** Il campione va da
  1m01s a 2m29s; gli altri undici non sono stati letti. Nessuna conclusione cambia, ma il numero non è
  esaustivo.

- **L'istante in cui la falla C.1 si è aperta non è provato.** La migrazione era stata applicata al
  database *prima* di essere committata: 36m11s fra i due commit sono un **minimo**. Chi ha chiuso il
  buco parla di «un'ora». La parte del trigger `SECURITY DEFINER` senza `REVOKE` è stata **letta nel
  testo della migrazione**, non provata contro il database.

- **Dodici verdetti su alcune righe non coincidono.** Undici punti di contraddizione dichiarati nella
  sezione apposita. Per otto di essi un comando eseguito qui indica quale documento regga; per il
  n. 31 la misura è identica nei due documenti ed è il **criterio** a divergere, e nessun comando lo
  dirime.

- **Il n. 1 non è misurato in nessun documento, ed è la riga più grave dell'elenco.** Il sorgente era
  corretto: il difetto stava nell'artefatto compilato. Il profilo 01 lo dichiara: *«È una deduzione
  solida, non una misurazione come le altre undici»* — la prova diretta sarebbe il pacchetto compilato
  dell'8 agosto, che non esiste più.

- **Lo stato dei dati di sede in produzione non è verificabile da qui.** Se a Giugliano, Aversa e Cesa
  i legali rappresentanti e le autorizzazioni siano stati compilati richiederebbe una lettura del
  database di produzione, fuori dal mandato di questo lavoro. Il n. 41 resta perciò dichiarato aperto
  senza una misura a sostegno.

- **Nessun dato personale in questo file.** Nessun nome, nessun indirizzo email di una persona,
  nessun codice fiscale, nessun telefono. Gli unici indirizzi citati altrove sono account di prova
  `@kidville.test`. I soli numeri sono conteggi, hash di commit, rapporti di contrasto e codici
  d'errore.

---

*Sintesi compilata il 2026-08-20 in sola lettura: nessun `git commit`, `add`, `push` o `checkout`;
nessuna scrittura sul database; nessun file toccato all'infuori di questo. Il profilo 09 è stato letto
due volte, all'inizio e subito prima della stesura: `md5` identico
(`a64bcfe2b9721cfacef4f61091c24bd7`), quindi non è cambiato fra le due letture. L'inventario invece
**è cambiato durante il lavoro**: la «seconda regola» dichiarava ignoto il ritardo di deploy e adesso
lo riporta misurato (1m01s–2m29s, rimandando al profilo 09). Questa sintesi usa la versione nuova.*
