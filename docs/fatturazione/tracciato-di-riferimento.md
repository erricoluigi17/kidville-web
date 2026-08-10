# Il tracciato di riferimento — come Kidville fattura davvero

Questo documento descrive, campo per campo, **come sono fatte le fatture che la segreteria emette
a mano dal pannello Aruba**. Serve a una cosa sola: le fatture emesse dal software devono uscire
**identiche**, perché convivono nelle stesse serie fiscali.

Ricavato il 2026-08-10 leggendo i tracciati veri via l'API ufficiale di Aruba
(`getByFilename`), non dall'anteprima grafica.

> ✅ **Rimisurato lo stesso giorno, e serviva.** I due campioni (`Asilo 2327/2026` e
> `FPR 1946/26`) sono stati riscaricati per decidere **quattro** punti su cui il codice e questo
> documento dicevano cose diverse. Ha vinto la misura, ed è sempre stata quella scritta qui:
> `RiferimentoNormativo` con `Art.` maiuscolo e l'anno a due cifre, `<Contatti><Email>` del
> cedente presente, `<Causale>` assente, `<DettaglioPagamento>` **senza IBAN** — e, si aggiunge
> ora, **senza `<Beneficiario>`**. Il codice le sbagliava tutte e quattro; oggi le rispetta e c'è
> un collaudo che ci gira sopra (`__tests__/lib/aruba/emissione-tracciato-reale.test.ts`).

> ⚠️ **Gli XML originali non stanno in questo repository e non ci devono entrare**: contengono nomi
> e codici fiscali di minori reali, e il repository è pubblico. Qui sotto c'è solo la *struttura*,
> con dati sintetici. Per riscaricare i campioni:
> `node scripts/aruba-campioni.mjs --out <cartella FUORI dal repo>` (lo script rifiuta una
> destinazione interna al repo).

## Lo scheletro, con dati sintetici

```xml
<?xml version="1.0" encoding="utf-8"?>
<FatturaElettronica versione="FPR12" xmlns="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader xmlns="">
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>IT</IdPaese>
        <IdCodice>01879020517</IdCodice>        <!-- P.IVA di Aruba PEC, non la nostra -->
      </IdTrasmittente>
      <ProgressivoInvio>2327</ProgressivoInvio> <!-- il numero NUDO, senza prefisso né anno -->
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>0000000</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>03394870616</IdCodice></IdFiscaleIVA>
        <CodiceFiscale>03394870616</CodiceFiscale>
        <Anagrafica><Denominazione>SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>VIA Silvio Pellico, 7</Indirizzo>
        <CAP>81030</CAP>
        <Comune>CESA</Comune>
        <Provincia>CE</Provincia>
        <Nazione>IT</Nazione>
      </Sede>
      <Contatti><Email>scuolamat.lafavola@virgilio.it</Email></Contatti>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>   <!-- SOLO il CF: mai IdFiscaleIVA -->
        <Anagrafica><Nome>MARIO</Nome><Cognome>ROSSI</Cognome></Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>VIA DELLE ROSE</Indirizzo>
        <NumeroCivico>43</NumeroCivico>
        <CAP>81030</CAP>
        <Comune>Teverola</Comune>
        <Provincia>CE</Provincia>
        <Nazione>IT</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody xmlns="">
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>2026-07-31</Data>
        <Numero>Asilo 2327/2026</Numero>       <!-- QUI il prefisso del sezionale -->
        <ImportoTotaleDocumento>250.00</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee>
        <NumeroLinea>1</NumeroLinea>
        <Descrizione>PAGAMENTO RETTA DEL MESE DI luglio 2026 PER LA FIGLIA MINORE ROSSI GIULIA C.F. RSSGLI24A41H501W</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>250.00</PrezzoUnitario>
        <PrezzoTotale>250.00</PrezzoTotale>
        <AliquotaIVA>0.00</AliquotaIVA>
        <Natura>N4</Natura>
      </DettaglioLinee>
      <DatiRiepilogo>
        <AliquotaIVA>0.00</AliquotaIVA>
        <Natura>N4</Natura>
        <ImponibileImporto>250.00</ImponibileImporto>
        <Imposta>0.00</Imposta>
        <RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>
      </DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>MP05</ModalitaPagamento>
        <DataScadenzaPagamento>2026-07-29</DataScadenzaPagamento>
        <ImportoPagamento>250.00</ImportoPagamento>
      </DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</FatturaElettronica>
```

## Le cose che si sbagliano se non si guarda il tracciato vero

| | Cosa fa la segreteria | L'errore facile |
|---|---|---|
| `ProgressivoInvio` | il numero **nudo**: `2327` | metterci `Asilo 2327/2026` |
| `Numero` | **col prefisso e l'anno**: `Asilo 2327/2026` | metterci solo `2327` |
| `DatiPagamento` | **senza IBAN**: solo condizioni, modalità, scadenza, importo | aggiungere `IBAN` «per completezza» — sarebbe una differenza |
| `DettaglioPagamento/Beneficiario` | **assente** | scriverci la denominazione del cedente, che è già nell'intestazione |
| `Causale` | **assente**: la descrizione sta solo nella riga | valorizzarlo perché il tracciato lo prevede |
| `RiferimentoNormativo` | `Esente Art. 10 DPR 633/72` | `Esente art. 10 DPR 633/1972` (minuscolo e anno a 4 cifre) |
| `CessionarioCommittente` | **solo** `CodiceFiscale` | aggiungere `IdFiscaleIVA` a un privato |
| `DatiBollo` | **assente**, anche sopra i 77,47 € | applicarlo perché la norma lo prevederebbe |
| `Contatti/Email` del cedente | presente | ometterlo |
| `Quantita` | `1.00`, due decimali | `1` |

### L'unica differenza VOLUTA, scritta qui perché non la scopra un controllo

Sulla `Sede` del **cedente** le fatture scritte a mano tengono il civico dentro l'indirizzo
(`<Indirizzo>VIA Silvio Pellico, 7</Indirizzo>`, nessun `<NumeroCivico>`), mentre il software
scrive i due elementi separati — come le stesse fatture già fanno per il **cessionario**.

È deliberato e non si allinea all'esistente per due ragioni: la configurazione tiene via e civico
in due campi (è ciò che il tracciato pretende e che una stringa unica non consente di ricavare),
e accorpandoli il civico rischierebbe di cadere nel troncamento a 60 caratteri dell'indirizzo.
Il contenuto informativo è identico e lo XSD accetta entrambe le forme.

Tutto il resto — dicitura dell'esenzione, contatti, causale, blocco pagamento — è **identico**,
e a tenerlo tale c'è `__tests__/lib/aruba/emissione-tracciato-reale.test.ts`, che misura il
documento prodotto dal motore e non ricopia questa tabella.

## Formato dei due sezionali

| Sezionale | Chi | Formato del `Numero` |
|---|---|---|
| `Asilo` | fascia 0-3, quella del bonus nido | `Asilo 2327/2026` — anno a **4** cifre |
| `FPR` | tutte le altre fasce | `FPR 1946/26` — anno a **2** cifre |

La numerazione è **unica per tutte e tre le sedi**: i sezionali distinguono la fascia d'età, non il plesso.

Il sezionale si sceglie dalla **data di nascita del minore**: se compie 3 anni **entro il 30 aprile**
dell'anno scolastico → `FPR`, se li compie dopo → `Asilo`. Il 30 aprile esatto conta come «entro».
Deciso una volta per anno scolastico, così non cambia a metà anno.

**Quale anno scolastico, esattamente.** «L'anno scolastico» qui sopra non è un modo di dire: è una
data di confine, e per un documento irreversibile va scritta. **Ai fini della fatturazione l'anno
scolastico comincia il 1° SETTEMBRE**: un documento datato 31 agosto 2026 appartiene al 2025/2026,
uno datato 1° settembre 2026 al 2026/2027 (`annoScolasticoDi` in `sezionale.ts`).

⚠️ **È un confine DIVERSO da quello del resto del prodotto, ed è voluto.**
`annoScolasticoCorrente()` in `src/lib/anno-scolastico.ts` fa partire l'anno dal **1° agosto**, e ha
ragione a farlo: risponde a *in quale anno sta operando la scuola oggi*, e ad agosto la scuola sta
già iscrivendo per settembre. Qui la domanda è un'altra — *a quale anno appartiene il documento che
sto emettendo* — e una fattura emessa ad agosto salda quasi sempre arretrati dell'anno che si è
appena chiuso, perché dell'anno nuovo non c'è ancora stato un giorno di scuola da fatturare.

Il prezzo di questa divergenza si paga in **agosto**, l'unico mese in cui le due regole rispondono
anni diversi, e si paga solo quando `periodo_competenza` manca. Vedi il punto 2.

Le due cose che restano da dire, perché sono quelle che si sbagliano:

**1. La data di nascita ha due fonti, e quando discordano vince l'ANAGRAFICA** (`alunni.data_nascita`),
non il codice fiscale. Fino al 2026-08-10 questo paragrafo diceva il contrario di ciò che il codice
faceva — «si sceglie dalla data ricavata dal codice fiscale» — ed erano due file committati nello
stesso lavoro che si contraddicevano su una decisione irreversibile verso lo SDI. Ora la regola è
una sola, ed è questa, per tre ragioni misurabili:

- `data_nascita` è una colonna `date`: il database rifiuta tutto ciò che non è una data.
  `codice_fiscale` è un `char(16)` che accetta qualunque testo. Contato in produzione il
  2026-08-10: **su 32 alunni, 14 hanno un codice fiscale valorizzato e solo 3 di forma valida**,
  mentre la data di nascita c'è su **32 su 32**;
- è il campo con cui il resto del prodotto ragiona sull'età del bambino (elenchi, certificati,
  deduplica delle iscrizioni): scegliere l'altro farebbe uscire una serie in disaccordo col resto
  della sua scheda;
- cambiare oggi il vincitore sposterebbe di serie bambini già fatturati.

Il codice fiscale non è ignorato: quando è leggibile fa da **controprova**. Se dice una data diversa
dall'anagrafica l'emissione scrive una riga `error` (`esito = 'sezionale-discordanza'`); se è
valorizzato ma illeggibile ne scrive un'altra (`esito = 'anagrafica-minore-illeggibile'`) — e
quest'ultimo caso conta, perché quello stesso codice sbagliato finisce **verbatim** nella
descrizione della riga qui sotto. Se mancano entrambi, non si emette.

**Un campo che si legge benissimo può comunque descrivere un'altra persona**: il caso vero è il
codice fiscale del *genitore* incollato nel campo del bambino (`…85T10…`: forma perfetta, dice
1985). Una data che un alunno non può avere — fuori dalla finestra *dal 1° settembre di diciotto
anni prima al 31 agosto di chiusura dell'anno scolastico* — **non è una fonte**: l'emissione scrive
`esito = 'anagrafica-minore-implausibile'` a livello `error` e, se è l'unica fonte rimasta, non
emette. Il secolo del codice fiscale (`26` = 1926 o 2026?) si scioglie contro **la fine dell'anno
scolastico che si sta fatturando**, non contro l'orologio: altrimenti la stessa fattura, rifatta
dopo uno scarto SDI, cambierebbe serie da sola.

Implementazione: `src/lib/fatturazione/sezionale.ts` → `sezionalePerMinore`.

**2. L'anno scolastico è quello del PERIODO CHE SI FATTURA**, non del giorno in cui si emette
(`pagamenti.periodo_competenza`). Una retta di maggio 2026 fatturata a settembre 2026 appartiene al
2025/2026: valutata sull'anno di emissione, il confine dei tre anni si sposta di dodici mesi e lo
stesso bambino esce sulla serie sbagliata. Quando `periodo_competenza` manca — **71 pagamenti su 98
al 2026-08-10** — si ripiega sulla data del documento e si scrive una riga `warn`
(`esito = 'anno-scolastico-da-data-documento'`). Implementazione: `annoScolasticoDiCompetenza`.

⚠️ **In agosto quel ripiego non decide da solo.** Agosto è l'unico mese in cui il confine di
fatturazione (1° settembre) e quello del resto del prodotto (1° agosto) rispondono anni diversi:
lo stesso pagamento senza `periodo_competenza`, emesso il 31 agosto o il 1° settembre, uscirebbe su
serie diverse per la coorte a cavallo del 30 aprile — un numero già consumato sul sezionale
sbagliato, che si rimedia solo con una nota di variazione. Perciò in agosto l'esito porta
`ambiguo: true` e l'emissione **si ferma**, con `motivo = 'periodo_competenza_mancante'` e
`esito = 'anno-scolastico-ambiguo'` nel log, **solo per i bambini in cui i due anni candidati danno
serie diverse**. Per tutti gli altri la fattura parte come sempre: si blocca dove la differenza
esiste, non l'intero mese. Si sblocca compilando «periodo di competenza» sul pagamento — che è dove
sta il dato mancante, non nell'anagrafica del bambino.

## La descrizione della riga

È l'unico posto dove il minore viene identificato, ed è ciò che permette al genitore la detrazione.
Forma in uso, tutta in maiuscolo tranne il mese:

```
PAGAMENTO RETTA DEL MESE DI <mese> <anno> PER <IL FIGLIO|LA FIGLIA> MINORE <COGNOME> <NOME> C.F. <codice fiscale>
```

Il genere («IL FIGLIO» / «LA FIGLIA») si ricava dal codice fiscale del minore: nelle posizioni del
giorno di nascita, un valore **maggiore di 40** indica il sesso femminile.

## Estrarre l'XML dal `.p7m`

Aruba firma i documenti in CAdES: `getByFilename` restituisce un involucro PKCS#7, non l'XML nudo.
Il contenuto è spezzato in **blocchi BER a lunghezza indefinita**, quindi *non* si estrae cercando
`<?xml` e affettando la stringa: le intestazioni dei blocchi finiscono dentro il testo e spezzano le
parole (si vede `As<byte>ilo` al posto di `Asilo`). Va usato un estrattore che capisca la struttura,
ad esempio `openssl cms -verify -noverify -inform DER -in <file>.p7m`.

## Il limite di chiamate

Aruba stroza a circa **60 richieste l'ora** (leaky bucket) e risponde **429 con una pagina HTML**,
non con un errore strutturato. Conseguenza per il prodotto: l'ultimo numero emesso si legge **una
volta per lotto**, mai una volta per fattura, altrimenti un'emissione massiva si interrompe a metà.
