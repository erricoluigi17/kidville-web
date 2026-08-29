# Super prompt per Claude Design — sistema email transazionali Kidville

> Copia tutto ciò che sta sotto la riga e incollalo in Claude Design come primo messaggio.
> È autosufficiente: non richiede accesso al repository.
>
> Revisione 2 — A (credenziali) e B (codici) sono state fuse in **una sola email ciascuna**.
> Totale: **12 email** invece di 19.

---

# Progetta il sistema completo delle email transazionali di Kidville

## 1. Chi siamo e chi legge

Kidville è un servizio educativo 0–6 anni con **tre sedi** — Kidville Giugliano, Kidville Aversa,
Kidville Cesa — gestite dalla cooperativa «Scuola dell'infanzia La Favola». Ogni sede ha nome,
indirizzo, telefono ed email propri: **il nome della sede non è mai sottinteso**, perché un
genitore che legge solo «Kidville» non sa a quale plesso è iscritto suo figlio.

Le email arrivano a tre pubblici diversi:

| Pubblico | Chi è | Registro |
|---|---|---|
| **Famiglie** | genitori di bambini da 0 a 6 anni e della primaria | **«tu»**, caldo, diretto, mai burocratico |
| **Personale** | maestre, educatrici, candidate | **«lei»**, cortese e professionale |
| **Segreteria** | operatori interni | asciutto, informativo, zero cerimonie |

⚠️ **Due email di questo sistema vanno a più pubblici insieme** (la A e la B: vedi sotto). Per
quelle il registro non può essere né «tu» né «lei»: va usata la **forma impersonale**, ed è il
problema di scrittura più difficile dell'intero incarico. Ci torniamo alla sezione 6.

Tutto in **italiano (it-IT)**, tranne una email bilingue IT/EN (indicata sotto).
Date `12 marzo 2026` nel corpo, `12/03/2026` nelle tabelle. Valuta `€ 1.234,56`.

## 2. Cosa devi consegnare

1. **Un layout master unico** — intestazione, area contenuto, piè di pagina — da cui derivano
   tutte le email. Deve reggere sia un'email di quattro righe (un codice di verifica) sia una di
   due schermate (la ricevuta d'iscrizione).
2. **Dodici email** costruite su quel layout (elenco completo alla sezione 6).
3. Per **ognuna delle dodici**: la versione **HTML** *e* il suo **gemello in testo semplice**.
   Non è un extra: il servizio d'invio spedisce multipart e il testo semplice è ciò che vedono i
   client che rifiutano l'HTML. Il gemello deve dire le stesse cose, non essere un riassunto.
4. **Una pagina d'anteprima** che mostri tutte le email affiancate, così si vedono come sistema.
5. Un **blocco di componenti riusabili**: il bottone principale, il riquadro del codice, il
   riquadro della password, la tabella di riepilogo dati, il riquadro d'avviso, la linea del
   tempo a tappe, il piè di pagina.

## 3. Vincoli tecnici — l'email non è il web

Questi non sono suggerimenti: un'email che li viola si rompe in Outlook o in Gmail.

- **Impaginazione a tabelle** (`<table role="presentation">`), niente flexbox, niente grid,
  niente `position`.
- **CSS inline su ogni elemento.** Gmail rimuove `<style>` dall'head e nessun client supporta le
  variabili CSS: gli esadecimali vanno scritti a mano, uno per uno.
- **Larghezza 600px**, che degrada a schermo pieno sotto i 480px. Leggibile fino a 320px.
- **Niente webfont**: usa lo stack di sistema
  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
  Il font del brand (Maven Pro) non arriva nelle email: non provarci.
- **Niente SVG, niente JavaScript, niente `background-image`** su elementi che portano contenuto.
- **Le immagini sono bloccate di default** in mezzo mondo: nessun testo dentro un'immagine, `alt`
  su tutto, e l'email deve avere senso completo a immagini spente. Il logo sta su
  `https://app.kidville.it/logo-kidville.png` — se non carica, al suo posto deve comparire la
  scritta «Kidville», non un rettangolo vuoto.
- **Bottoni a prova di Outlook** (fallback VML per le versioni desktop).
- **Modalità scura**: Outlook e Apple Mail invertono i colori da soli. Scegli combinazioni che
  reggono l'inversione e aggiungi `color-scheme` / `supported-color-schemes`. Un testo scuro su
  fondo scuro invertito è il difetto più comune.
- **Preheader** (la riga d'anteprima nella casella) su ogni email, nascosta nel corpo, scritta a
  mano email per email. Non deve mai essere la ripetizione dell'oggetto.
- **Accessibilità**: contrasto minimo 4,5:1 su tutto il testo, `lang="it"`, gerarchia dei titoli
  reale, link con testo parlante (mai «clicca qui»).

## 4. Palette del brand — «Clay Village»

| Ruolo | Esadecimale |
|---|---|
| Verde principale | `#006A5F` |
| Verde scuro (hover/pressed) | `#00544B` |
| Verde tenue (fondi) | `#E8F5F3` |
| Giallo accento | `#FDC400` |
| Giallo tenue | `#FFF8E1` |
| Crema (sfondo pagina) | `#FEF1E4` |
| Bianco (schede) | `#FFFFFF` |
| Testo | `#1F2937` |
| Testo secondario | `#6B7280` |
| Errore | `#E53935` — su fondo `#FDECEC`, testo `#C62828` |
| Successo | `#43A047` — su fondo `#E7F3E8`, testo `#1B5E20` |
| Avviso | `#E6720A` — su fondo `#FBEFE2`, testo `#A64F09` |
| Informativo | `#2A6FDB` — su fondo `#E9F1FB`, testo `#1D4FA8` |

⚠️ **Giallo `#FDC400` su verde `#006A5F` è 4,05:1: non basta per il testo.** Va bene per bordi,
icone e riempimenti, non per parole che qualcuno deve leggere. Sul verde il testo è bianco.

Forme: angoli arrotondati generosi (12–16px sulle schede, 8–10px sui bottoni), ombre assenti (i
client email le mangiano), molto respiro verticale. L'aria è parte del brand.

## 5. Il piè di pagina, uguale su tutte

In ordine: **nome della sede** che scrive (`{sede_nome}`), **indirizzo** (`{sede_indirizzo}`),
**telefono** (`{sede_telefono}`), **email** (`{sede_email}`), la ragione sociale «Scuola
dell'infanzia La Favola soc. coop.», il link all'**informativa privacy** (`{url_privacy}`) e la
riga che spiega **perché** il destinatario riceve quel messaggio (`{motivo_invio}`, cambia per
categoria — i valori sono indicati email per email alla sezione 6).

Le email di servizio (credenziali, codici, solleciti) **non** portano un link di disiscrizione:
sono comunicazioni necessarie al rapporto in corso. Il **digest mensile delle news sì**, e va
progettato.

## 6. Le dodici email

Il segnaposto si scrive `{cosi}`. Ogni email eredita `{sede_nome}` e i campi del piè di pagina.
Dieci esistono già come testo semplice e vanno rivestite; **la 11 e la 12 sono nuove e le
progetti da zero** (specifica dettagliata alla sezione 7).

---

### A · Email 1 — Credenziali di accesso · UNA SOLA, IDENTICA PER TUTTI

**Oggetto:** `Credenziali di accesso — Kidville`
**Variabili:** `{nome}` `{email}` `{password}` `{url_login}` `{sede_nome}`

Questa singola email viene inviata in **quattro momenti diversi**, e il testo **non cambia mai**:

1. a un **genitore**, quando la sua domanda d'iscrizione viene approvata;
2. a un **genitore**, quando la segreteria lo inserisce a mano in anagrafica;
3. a un **genitore**, quando chiede che la password gli venga rigenerata;
4. a una **maestra**, quando la sua candidatura viene accolta e le si apre l'area del personale.

Da qui discendono tre vincoli che governano tutta la scrittura di questa email:

**a) Registro impersonale, obbligatorio.** Va sia a un genitore (a cui diamo del «tu») sia a una
dipendente (a cui diamo del «lei»). Una email sola non può dare del tu e del lei insieme, e
scegliere uno dei due significa suonare sgarbati con metà dei destinatari. **La soluzione è
costruire ogni frase in forma impersonale**, evitando del tutto la seconda persona: non «accedi
da qui» né «acceda da qui», ma «l'accesso avviene da questo indirizzo»; non «cambia la password»
ma «al primo accesso è necessario impostare una nuova password». Riscrivi finché non resta
nessuna seconda persona singolare, e finché il testo non suona comunque **umano e accogliente**,
non da modulo ministeriale. È la parte più difficile di tutto l'incarico: dedicaci attenzione
vera e proponi due o tre alternative per le frasi chiave.

**b) Non può dire perché è arrivata.** Poiché è la stessa per un'iscrizione approvata, un
inserimento manuale, una password rigenerata e un'assunzione, **non può contenere né «benvenuto»,
né «la sua candidatura è stata accolta», né «la password è stata reimpostata»**: sarebbero false
in tre casi su quattro. L'apertura deve essere vera in tutti e quattro — qualcosa come «ecco le
credenziali per accedere all'area riservata di {sede_nome}» — e proprio perché non spiega
l'occasione, **deve compensare con orientamento**: dire chiaramente cos'è l'area riservata, cosa
ci si trova dentro, e chiudere con «se non è stato richiesto questo accesso, contattare la
segreteria». Quest'ultima riga non è cortesia: è l'unico presidio contro un invio a un indirizzo
sbagliato.

**c) `{nome}` può essere vuoto.** Il nome non è sempre noto. Il saluto deve degradare senza
sembrare rotto e senza tradire il registro: progetta la variante con nome e quella senza, e se la
seconda risulta fredda, **considera di eliminare del tutto il saluto** e aprire direttamente con
il contenuto — spesso è la scelta migliore in forma impersonale.

🔒 **La password è il contenuto più delicato dell'intero sistema.** Riquadro dedicato, carattere
monospaziato, testo selezionabile, mai dentro un'immagine, mai dentro un link, mai spezzato su
due righe. Accanto: l'email di accesso (`{email}`), altrettanto leggibile — le due cose si copiano
insieme. Sotto: il bottone verso `{url_login}` e l'avviso di impostare una nuova password al
primo accesso.

**`{motivo_invio}`:** «Questo messaggio è stato inviato perché è stato aperto o aggiornato un
accesso all'area riservata di {sede_nome}.»

---

### B · Email 2 — Codice di verifica · UNA SOLA, IDENTICA PER TUTTE LE OCCASIONI

**Oggetto:** `Il tuo codice di verifica — Kidville`
**Variabili:** `{codice}` (sei cifre) `{operazione}` `{minuti_validita}` `{sede_nome}`

Va sempre e solo a un **genitore**, quindi qui il «tu» è corretto e naturale.

Una sola email copre **cinque occasioni**, e l'unica cosa che cambia è `{operazione}`, che
completa la frase «Il tuo codice per **{operazione}** è:». I cinque valori reali sono:

| Occasione | `{operazione}` |
|---|---|
| firma del modulo pubblico d'iscrizione | `firmare la domanda d'iscrizione` |
| firma di un modulo dall'area genitori | `firmare il modulo` |
| giustifica di un'assenza | `confermare la giustifica dell'assenza` |
| presa visione di una nota disciplinare | `confermare la presa visione della nota` |
| ricezione della pagella | `confermare la ricezione della pagella` |

**Progetta e mostra l'anteprima con tutti e cinque i valori**: il più lungo è quasi il triplo del
più corto e l'impaginazione deve reggerli entrambi senza che il codice scivoli sotto la piega.

Requisiti duri per questa email:

- **il codice è l'unica cosa che conta.** Grande, monospaziato, cifre distanziate, contrasto
  massimo, il primo elemento sotto l'intestazione. Nient'altro deve competere con lui;
- **deve essere leggibile in anteprima nella casella, senza aprire l'email.** Il preheader
  contiene il codice stesso. È il gesto reale: la gente lo legge dalla notifica del telefono e
  non apre mai il messaggio;
- **nessun bottone e nessun link che completi l'operazione.** È un antifurto contro il phishing:
  chi riceve il codice deve tornare da sé nell'app. L'unica eccezione ammessa è un link alla
  pagina d'aiuto nel piè di pagina;
- riga esplicita: «Se non hai richiesto tu questo codice, ignora questo messaggio e avvisa la
  segreteria di {sede_nome}»;
- **validità** dichiarata con `{minuti_validita}`, mai «pochi minuti»;
- **il gemello in testo semplice deve funzionare identico**, perché è quello che la maggioranza
  vede davvero.

**`{motivo_invio}`:** «Questo codice è stato richiesto dall'area riservata di {sede_nome}.»

---

### C · Solleciti di pagamento — tre livelli che salgono di tono

| # | Oggetto | Quando parte | Tono |
|---|---|---|---|
| 3 | `Promemoria pagamento — {descrizione}` | 3 giorni dalla scadenza | gentile, «se hai già pagato ignora questo messaggio» |
| 4 | `Sollecito di pagamento — {descrizione}` | 10 giorni | fermo ma cortese |
| 5 | `Secondo sollecito — {descrizione}` | 20 giorni | serio, invita a contattare la segreteria |

**Variabili:** `{alunno}` `{descrizione}` `{scadenza}` `{residuo}` `{giorni_ritardo}` `{iban}`
`{causale}` — destinatario: la famiglia, quindi «tu».

Ciascuna contiene un **riquadro di riepilogo** (descrizione, scadenza, giorni di ritardo, importo
residuo) e i **dati per il bonifico** (IBAN e causale, entrambi in monospaziato selezionabile: si
copiano dentro l'home banking).

La progressione di gravità si legge **nel colore e nella gerarchia visiva, non nel volume delle
parole**: il terzo sollecito non urla, è solo più netto e più breve. Tieni presente chi legge —
una famiglia che porta lì il proprio figlio ogni mattina e che rivedrà quelle persone in faccia
domani. Un tono da recupero crediti è, qui, un errore di progettazione.

**`{motivo_invio}`:** «Ricevi questo messaggio perché risulta un pagamento non ancora saldato
presso {sede_nome}.»

---

### D · Documenti del personale in scadenza — due destinatari, due varianti ciascuno

| # | Oggetto | A chi |
|---|---|---|
| 6 | `Il tuo documento d'identità scade il {scadenza}` · **oppure** · `Il tuo documento d'identità risulta scaduto` | alla dipendente interessata |
| 7 | `Personale: documento d'identità in scadenza` · **oppure** · `Personale: documento d'identità scaduto` | alla segreteria |

**Variabili:** `{nome}` `{tipo_documento}` `{scadenza}`.

Ognuna ha **due varianti** — *in scadenza* e *già scaduto* — che devono distinguersi a colpo
d'occhio: la seconda usa il colore d'avviso, la prima resta neutra. Progetta e mostra tutte e
quattro le combinazioni.

Alla dipendente: registro cortese, spiega cosa fare (portare o inviare copia del documento
rinnovato in segreteria) e perché serve. **Non compaiono mai il numero del documento né il codice
fiscale.**
Alla segreteria: asciutta, dice chi, che documento e che data. Nient'altro.

**`{motivo_invio}`:** alla dipendente «Ricevi questo messaggio perché in Segreteria di
{sede_nome} è depositato un tuo documento in scadenza.» / alla segreteria «Notifica automatica di
sorveglianza documenti — {sede_nome}.»

---

### E · Email 8 — Esito negativo di una candidatura

**Oggetto:** `Esito della tua candidatura — Kidville`
**Variabili:** `{nome}` `{sede_nome}` — destinataria: una candidata, quindi **«lei»**.

È l'email più delicata del sistema: **deve chiudere una porta senza sbatterla.** Ringrazia
davvero, non per formula. **Non dà nessuna motivazione** — quello che si dice in segreteria non è
quello che si scrive alla persona. Accenna alla conservazione del curriculum per posizioni future,
se autorizzata. Breve: quattro o cinque righe. Nessun bottone, nessuna azione richiesta.

Visivamente: la più sobria di tutte. Niente giallo, niente festa, niente icone. Il rispetto qui
si esprime togliendo.

**`{motivo_invio}`:** «Ricevi questo messaggio perché hai inviato una candidatura a {sede_nome}.»

---

### F · Email 9 — Conferma della richiesta di cancellazione dell'account

**Oggetto:** `Conferma la richiesta di cancellazione — Kidville`
**Variabili:** `{url_conferma}`

**Bilingue italiano + inglese**, le due versioni una sotto l'altra, separate da un divisore
visibile e con un'etichetta di lingua. Non tradurre in due colonne: sui telefoni è illeggibile.

Contiene: il link di conferma (bottone + URL in chiaro sotto, perché alcuni client rompono i
bottoni), la **validità di 1 ora** dichiarata, e l'avviso «se non hai richiesto tu la
cancellazione, ignora questo messaggio: senza conferma non verrà avviata alcuna richiesta».

Registro: neutro-formale in entrambe le lingue. È un atto giuridico, non una comunicazione di
servizio: la sobrietà è il messaggio.

**`{motivo_invio}`:** «Questo messaggio è stato inviato in risposta a una richiesta di
cancellazione account.»

---

### G · Email 10 — Digest mensile delle news

**Oggetto:** `Kidville News — {mese} {anno}`
**Variabili:** `{mese}` `{anno}` `{sede_nome}` e la lista `{articoli}`, ciascuno con categoria,
titolo, estratto (~160 caratteri) e link.

Va a **tutte le famiglie della sede**. Elenco di schede-articolo su fondo bianco, ognuna con
etichetta di categoria, titolo, estratto e bottone «Leggi in app».

**Deve reggere da 1 a 20 articoli**: progetta e mostra entrambi gli estremi. Con un solo articolo
non deve sembrare un errore; con venti non deve diventare un muro — introduci un ritmo (categorie
raggruppate, alternanza di fondo, separatori).

È l'unica email del sistema con il **link di disiscrizione** nel piè di pagina, che va progettato:
visibile senza essere un invito.

**`{motivo_invio}`:** «Ricevi questa comunicazione perché il tuo bambino è iscritto a
{sede_nome}.»

---

### H · Le due nuove — specifica alla sezione 7

| # | Oggetto proposto | A chi |
|---|---|---|
| 11 | `Abbiamo ricevuto l'iscrizione di {nome_bambino}` | alla famiglia, subito dopo l'invio del modulo pubblico |
| 12 | `Abbiamo ricevuto la tua candidatura — Kidville` | alla candidata, subito dopo l'invio del modulo insegnanti |

## 7. Specifica delle due email nuove

### Email 11 · Ricevuta d'iscrizione

Oggi una famiglia compila il modulo pubblico, firma con un codice e **non riceve niente**. Nessuna
conferma, nessun riepilogo, nessuna idea di cosa succederà. Sono centinaia di domande vere ogni
mese, e la prima impressione della scuola è un silenzio.

Registro: **«tu»**, caldo. È il primo contatto in assoluto con la famiglia.

L'email deve fare quattro cose, **in quest'ordine**:

1. **rassicurare.** «L'abbiamo ricevuta» deve essere la prima cosa visibile, senza scorrere e
   senza caricare immagini;
2. **dare una prova.** Numero di pratica `{numero_pratica}` e data e ora d'invio `{data_invio}`,
   in un riquadro compatto che si possa **fotografare e mostrare allo sportello**. Progettalo
   pensando a uno screenshot: deve stare tutto in un colpo d'occhio;
3. **riepilogare cosa è stato dichiarato.** Solo ed esclusivamente: nome del bambino
   `{nome_bambino}`, sede scelta `{sede_nome}`, fascia d'età o sezione `{sezione}`, genitore
   richiedente `{nome_genitore}`.
   ⚠️ **Nient'altro.** Niente codice fiscale, niente data di nascita, niente allergie, niente note
   mediche, niente indirizzo di casa, niente recapiti. Sono dati di un minore e questa email
   finisce in una casella di posta che non controlliamo, spesso condivisa in famiglia;
4. **dire cosa succede adesso.** I passi successivi con tempi realistici — la segreteria esamina
   la domanda, la famiglia viene ricontattata, all'approvazione arrivano le credenziali dell'area
   genitori — più il recapito della sede per segnalare un errore nei dati.

Progetta anche una **linea del tempo a tre tappe** — «Ricevuta» → «In esame» → «Approvata» — con
la prima attiva e le altre due spente. Fa capire in un colpo d'occhio a che punto è la pratica.
A tabelle, senza immagini, leggibile anche in testo semplice (nel gemello diventa qualcosa come
`[✓] Ricevuta  →  [ ] In esame  →  [ ] Approvata`).

**`{motivo_invio}`:** «Ricevi questo messaggio perché è stata inviata una domanda d'iscrizione a
{sede_nome}.»

### Email 12 · Conferma della candidatura

Stessa logica, altro registro: **«lei»**, professionale, breve. Metà della lunghezza della 11.

Contiene: conferma della ricezione, data d'invio `{data_invio}`, sede per cui ci si è candidate
`{sede_nome}`, e un riepilogo minimo di quanto inviato — `{nome}`, ruolo `{ruolo}`, e gli allegati
**come conteggio** («curriculum e 1 documento allegato»), **mai il contenuto né i nomi dei file**.

La parte che conta davvero è un'**aspettativa onesta sui tempi**: entro quanto si riceve una
risposta, e il fatto che una risposta arriva **in ogni caso**, anche negativa. È la promessa che
la 8 poi mantiene.

Chiude con una riga sulla conservazione dei dati e il rimando all'informativa privacy.
**Nessun bottone d'azione**: non c'è niente da fare, ed è esattamente il messaggio.

**`{motivo_invio}`:** «Ricevi questo messaggio perché hai inviato una candidatura a {sede_nome}.»

## 8. Riservatezza — vale su tutte e dodici

Il destinatario di queste email **spesso non è chi ne è oggetto**: la segreteria riceve email che
parlano di una dipendente, un genitore riceve email che parlano di suo figlio, e la casella di
posta di famiglia la leggono in due o in tre. Sempre:

- **mai** codici fiscali, allergie, diagnosi, note mediche, disabilità, voti o valutazioni dentro
  un'email;
- **mai** il nome di un bambino nell'oggetto di un'email che non va alla sua famiglia;
- **mai** il numero di un documento d'identità;
- il minimo indispensabile per far capire di cosa si parla, e non una riga in più.

## 9. Come consegnare

**Un file HTML unico e autosufficiente** che contenga:

1. la **pagina d'anteprima** con tutte e dodici le email, ognuna in una cornice larga 600px,
   raggruppate per categoria (A–H), con un indice cliccabile in testa;
2. per le email con varianti, **tutte le varianti affiancate**: i cinque valori di `{operazione}`
   della email 2, le quattro combinazioni della D, il digest con 1 e con 20 articoli, la email 1
   con e senza `{nome}`;
3. un interruttore **chiaro / scuro**, per verificare la tenuta in modalità scura;
4. un interruttore **immagini attive / immagini bloccate**;
5. per ogni email, sotto l'anteprima, il **codice HTML pronto da copiare** e il **gemello in testo
   semplice**, in due blocchi affiancati;
6. in testa alla pagina, la **libreria dei componenti** riusabili con il loro codice.

Prima di consegnare, verifica ogni email contro la sezione 3, punto per punto. Un template che si
rompe in Outlook non è un template.

---

## Prima di iniziare

Sulla **email 1** — quella impersonale che va sia ai genitori sia alle maestre — proponi **due o
tre versioni alternative delle frasi chiave** prima di finalizzare: è il punto in cui questo
sistema può suonare accogliente oppure burocratico, e la differenza sta in tre o quattro frasi.

Se qualcos'altro è ambiguo o in conflitto, chiedi **prima** di progettare. Se è solo una scelta di
gusto, decidi tu e motivala in una riga sotto l'email.
