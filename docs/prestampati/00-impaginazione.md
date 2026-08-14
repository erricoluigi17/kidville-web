# 00 — Carta intestata, impaginazione, firma e protocollo

Vale per **tutti e diciassette**. Un prestampato che si impagina da sé è un prestampato che fra sei
mesi non somiglia agli altri: le misure stanno qui, in millimetri, e chi ne scrive uno nuovo le
riusa invece di sceglierle.

La base non è nuova: è `src/lib/protocolli/documento-pdf.ts`, che già oggi produce la carta
intestata dei documenti su richiesta, più `applicaSegnatura()` di `src/lib/protocolli/timbro.ts`
per il timbro di protocollo. Questo documento estende quel motore ai moduli con campi da compilare
e vi aggiunge il blocco di firma.

---

## 1. Il foglio

| | |
|---|---|
| Formato | A4 verticale, 210 × 297 mm, unità `mm` |
| Margini | 22 mm a sinistra e a destra · larghezza utile **166 mm** |
| Font | Helvetica (base PDF: nessun font da incorporare, nessun rischio di ripiego silenzioso) |
| Colori | verde `#006A5F` · inchiostro `#2D2D2D` · grigio `#646464` · giallo `#FDC400` (solo filetti) |

### La testata, identica su ogni modulo

```
┌──────────────────────────────────────────────────┐  y=0
│  ██ banda verde piena, alta 30 mm                │
│  [logo Kidville 44 × 14,8 mm a x=14, y=7,5]      │
└──────────────────────────────────────────────────┘  y=30

           Scuola dell'Infanzia "La Favola" Soc. Coop.     ← 9 pt grigio, centrato
           Via … — 8xxxx Città (XX)                        ← righe REALI dal DB
           Cod. Mecc. XXXXXXXXXX                           ← omesse se mancanti
                                                            y=38, passo 4,5 mm

              TITOLO DEL DOCUMENTO                         ← 16 pt verde grassetto
        ─────────────────────────────────                  ← filetto verde, x 40→170
                                                            y ≥ 58
```

Le righe di intestazione della sede vengono da `buildIntestazioneSede()` e **si omettono quando il
dato manca**: mai una riga vuota, mai un valore inventato. È la disciplina già in uso nei
certificati, e resta.

### Il piede, identico su ogni modulo

- 8 pt corsivo grigio, centrato a `y=287`: *«Documento generato dal registro elettronico Kidville»*
- se le pagine sono più d'una, a destra: `Pagina n di m`
- nessun altro elemento: il piede non è il posto per avvisi, note o loghi di terzi.

---

## 2. Il ritmo verticale — dove «lineare» diventa una misura

Tutti i moduli scorrono con lo stesso passo. Chi legge due prestampati diversi deve riconoscere lo
stesso foglio, non due impaginazioni cugine.

| Elemento | Misura |
|---|---|
| Corpo del testo | 12 pt, interlinea **6,2 mm** |
| Spazio prima di un titolo di sezione | 10 mm |
| Titolo di sezione (`DATI DELL'ALUNNO/A`) | 10 pt, verde, maiuscolo, spaziatura lettere +0,4 · filetto grigio sottile sotto, per tutta la larghezza utile |
| Spazio dopo il filetto | 5 mm |
| Riga di campo | 6,5 mm di passo |
| Etichetta del campo | 10 pt grigio |
| Valore precompilato | 11 pt inchiostro **grassetto** |
| Riga da compilare a penna | filetto grigio a 0,2 mm, che arriva a fine colonna |
| Casella `☐` | quadrato 3,5 mm, bordo 0,3 mm, allineato alla base del testo |
| Blocco firma | mai sopra `y=150`, mai sotto `y=240` |

### Due colonne, quando servono

I campi brevi (data di nascita, telefono, sezione) stanno **su due colonne**: la prima a `x=22`, la
seconda a `x=110`, larghe 78 mm ciascuna. I campi lunghi (indirizzo, dinamica, note) occupano
l'intera larghezza. Non si mescolano su una stessa riga un campo a colonna e uno intero: la riga
successiva riparte sempre dalla colonna sinistra.

### Le tabelle ripetibili

Delegati (n. 08), alimenti e sostituzioni (n. 07), registro delle dosi (n. 06), periodi di servizio
(n. 47): intestazione in 9 pt maiuscolo grigio su fondo `#F5F1EA`, righe alte 7 mm, filetto grigio
fra una riga e l'altra, nessun bordo verticale. Almeno **tre righe vuote** anche quando i dati sono
meno: un modulo consegnato deve poter essere completato a penna.

### Quando il contenuto non ci sta

Si va a pagina nuova **per blocchi interi**: un titolo di sezione non resta orfano in fondo alla
pagina, una tabella non si spezza sulla prima riga. Le pagine successive alla prima **non ripetono
la banda verde**: ripetono l'intestazione della sede in 8 pt e il titolo del documento in corsivo,
per non far perdere il filo a chi sfoglia una copia stampata.

---

## 3. Il blocco di firma

Due varianti, e la differenza non è estetica: dice **chi risponde di quel foglio**.

### a. Documenti della famiglia — n. 05 … 10

```
Luogo e data                                Firma del genitore/tutore
Cesa, 13 agosto 2026                        ┌──────────────────────────────┐
                                            │ Firmato con OTP il 13/08/2026 │
                                            │ alle 10:24 — codice verificato│
                                            │ Riferimento firma: a3f9…c1     │
                                            └──────────────────────────────┘
```

Non una riga vuota da firmare a penna: il documento **è già firmato**, e il riquadro lo attesta.
Riporta metodo, data e ora, e il riferimento della firma — mai l'hash dell'OTP, mai l'email, mai
l'indirizzo IP: quelli stanno nella ricevuta FEA (`src/lib/fea/receipt-pdf.ts`), che è un altro
documento e si scarica a parte.

### b. Documenti della scuola — n. 26·27, 28, 30, 31, 47

```
Luogo e data                          IL LEGALE RAPPRESENTANTE
Cesa, 13 agosto 2026                        Errico Cesario

                              Firma autografa sostituita a mezzo stampa
                              ai sensi dell'art. 3, c. 2 D.Lgs n. 39/93
```

**Nessuna immagine di firma, ed è la scelta giusta — non un ripiego.** La dicitura del
D.Lgs 39/93 è esattamente la norma che *sostituisce* il tratto autografo con l'indicazione a
stampa del nominativo del responsabile: un documento prodotto da un sistema automatizzato è valido
**perché** porta quella formula, non nonostante l'assenza della firma. Stamparle insieme —
scarabocchio e «firma sostituita» — è una contraddizione nei termini: o la firma c'è, o è
sostituita.

C'è anche una ragione pratica che pesa quanto la prima. Una firma scansionata dentro PDF che
escono a centinaia di famiglie **è estraibile in dieci secondi** e riutilizzabile su qualunque
foglio. Non metterla in un asset è un rischio che non si corre, non una funzione che manca.

Misure del blocco:

| Riga | Composizione |
|---|---|
| `IL LEGALE RAPPRESENTANTE` | 10 pt, maiuscolo, spaziatura +0,4, centrato nella colonna destra |
| Nome | 12 pt grassetto, centrato, da `scuole.config.anagrafica.legale_rappresentante` |
| Dicitura, due righe | 8 pt corsivo grigio, centrate, interlinea 3,5 mm, a 6 mm sotto il nome |

Il nome **non è cablato nel codice**: viene dalla configurazione di sede. Il repository è pubblico,
e soprattutto il CdA cambia — un nome scritto in un file `.ts` è un nome che un giorno sarà
sbagliato in venti documenti nello stesso momento. La dicitura, invece, è una costante di legge e
sta nel codice: cambia solo se cambia la norma.

---

## 4. Firma e protocollo sui certificati di iscrizione e frequenza

I due certificati (n. 26·27) e, con loro, il bonus nido (28), il nulla osta (30), la richiesta di
disponibilità (31) e il certificato di servizio (47) escono dalla scuola e vanno verso un ente.
Portano quindi **tre cose insieme**, e nessuna delle tre sostituisce le altre.

### 4.1 Il numero di protocollo, in testa

Riga a `y=52`, sotto l'intestazione di sede e sopra il titolo, allineata a sinistra:

```
Prot. n. 0000123/2026 del 13/08/2026
```

Il numero si consuma **solo quando il documento lo emette la segreteria**. Il certificato che il
genitore si scarica da sé in `/parent/modulistica` non consuma numerazione: è una copia a uso della
famiglia, e su di essa al posto del protocollo compare la dicitura *«Copia a uso della famiglia —
non protocollata»*. Due fogli che si somigliano ma dicono cose diverse devono dirlo, o il primo
finisce a un ente al posto del secondo.

La numerazione è quella già in produzione: `protocolli_numerazione`, per sede e per anno, con la
fascia di segnatura di `applicaSegnatura()` apposta **dopo** la generazione — che rimpicciolisce la
pagina invece di coprirla, e quindi non nasconde mai una riga del certificato.

### 4.2 La firma del legale rappresentante

Blocco `b` del §3: firma grafica, nome dalla configurazione, qualifica.

### 4.3 Il blocco di verifica, in fondo

Riquadro a 8 pt grigio, sopra il piede di pagina:

```
┌────────────────────────────────────────────────────────────────────┐
│ Documento emesso dal registro elettronico e registrato al          │
│ protocollo n. 0000123/2026 del 13/08/2026.                         │
│ Impronta SHA-256: a3f9c1e07b4d2856…                                │
│ Verificabile su app.kidville.it/verifica con il numero e l'impronta.│
└────────────────────────────────────────────────────────────────────┘
```

L'impronta si calcola sul PDF **prima** della fascia di segnatura ed è la stessa che finisce in
`protocolli.impronta_sha256`, colonna che esiste già. È ciò che rende il certificato verificabile
da chi lo riceve: chiunque abbia il foglio può confrontare numero e impronta.

### 4.4 Cosa regge questo certificato — detto una volta

Tre presidi, e nessuno dei tre è la firma autografa:

1. **la formula del D.Lgs 39/93**, che è ciò che rende valido un documento prodotto da un sistema
   automatizzato senza sottoscrizione;
2. **il numero di protocollo**, che lo àncora a un registro con la sua numerazione per sede e anno;
3. **l'impronta SHA-256**, che lo rende verificabile: se qualcuno altera il PDF, l'impronta non
   torna più.

**Non è una firma digitale qualificata** ai sensi dell'art. 24 del CAD, e non deve fingersi tale:
quella richiede un certificato intestato alla persona e produce un PAdES. Per questo sul documento
**non va scritta la dicitura «firmato digitalmente»** — su un foglio destinato a un ente sarebbe
un'affermazione non vera, ed è il tipo di frase che nessuno verifica finché non la verifica
qualcuno. Le due formule si escludono: o «firma autografa sostituita a mezzo stampa», o «firmato
digitalmente». Mai entrambe.

⚠️ **Una precisazione sul D.Lgs 39/93, perché sia detta e non scoperta.** L'art. 3 c. 2 parla degli
atti prodotti dai sistemi informativi automatizzati **delle amministrazioni pubbliche**. Una
cooperativa che gestisce scuole paritarie è un soggetto privato che svolge un servizio pubblico:
l'uso della formula è prassi diffusa e consolidata — banche, aziende e moltissime paritarie la
usano — ma la norma, alla lettera, è scritta per la PA. È la formula che la Scuola già adotta sui
propri documenti, quindi si mantiene; se un ente dovesse contestarla, la risposta non è cambiare
dicitura ma passare alla firma qualificata.

Se un giorno la firma qualificata servisse davvero — un certificato verso INPS o USR che la
richieda espressamente — la strada più breve passa da dove siamo già: **Aruba**, con cui la Scuola
ha già un rapporto per la fatturazione elettronica, offre la firma remota via API. Il blocco
`4.2` diventerebbe allora un PAdES vero, e solo in quel momento la dicitura del CAD sarebbe lecita
— al posto di quella del 39/93, non insieme.

---

## 5. Cosa deve verificare il test

Un lock su questa specifica costa poco e vale molto, perché l'impaginazione è la prima cosa che
diverge in silenzio. Il minimo:

1. ogni prestampato generato ha la banda verde a `y=0…30` e il logo alla stessa posizione;
2. il corpo comincia a `x=22` e non supera i 166 mm di larghezza;
3. il blocco firma cade fra `y=150` e `y=240`;
4. il piede è presente su **ogni** pagina, e la numerazione compare se le pagine sono più d'una;
5. i documenti del §4 portano protocollo, firma e blocco di verifica — e la copia self-service del
   genitore porta invece la dicitura «non protocollata»;
6. nessun PDF contiene la stringa «firmato digitalmente» finché non esiste una firma qualificata.
