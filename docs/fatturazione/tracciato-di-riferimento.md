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
data di confine, e per un documento irreversibile va scritta. Dalla PR 4.1 dell'anno scolastico il
confine è **uno solo per tutto il prodotto**, fatturazione compresa: quello del **calendario della
sede** (`anni_sede`) e, dove la sede non ne ha uno (o il database non è ancora migrato, come quello
della CI), il predefinito del **1° SETTEMBRE**. Un documento datato 31 agosto 2026 appartiene al
2025/2026, uno datato 1° settembre 2026 al 2026/2027 (`annoDelGiorno` in `src/lib/anno-scolastico.ts`).

Fino a quella PR non era così: la fatturazione usava il 1° settembre (`annoScolasticoDi`, tolta). Il
1° agosto valeva per `annoScolasticoCorrente` e le sue due copie (anche quelle tolte), mentre storici,
rette, appello e statistiche contavano già dal 1° settembre. Ad agosto il ripiego sulla data del
documento era «ambiguo» e fermava l'emissione. **Quella divergenza non esiste più**: agosto appartiene
sempre all'anno che si chiude, per tutti, e la serie si decide.

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
1985). Una data che un alunno non può avere — fuori dalla finestra *dal primo giorno di diciotto
anni prima (`inizioAnno`) all'ultimo giorno dell'anno scolastico che si fattura (`fineAnno`)*, cioè col
calendario predefinito dal 1° settembre al 31 agosto — **non è una fonte**: l'emissione scrive
`esito = 'anagrafica-minore-implausibile'` a livello `error` e, se è l'unica fonte rimasta, non
emette. Il secolo del codice fiscale (`26` = 1926 o 2026?) si scioglie contro **la fine dell'anno
scolastico che si sta fatturando**, non contro l'orologio: altrimenti la stessa fattura, rifatta
dopo uno scarto SDI, cambierebbe serie da sola.

Implementazione: `src/lib/fatturazione/sezionale.ts` → `sezionalePerMinore`.

**2. L'anno scolastico è quello della VOCE che si fattura**, non del giorno in cui si emette. Una retta
di maggio 2026 fatturata a settembre 2026 appartiene al 2025/2026: valutata sull'anno di emissione, il
confine dei tre anni si sposta di dodici mesi e lo stesso bambino esce sulla serie sbagliata. L'ordine
con cui `emettiFatturaPagamento` (`src/lib/aruba/emissione.ts`, passo 3) sceglie l'anno è questo:

1. **l'anno della voce** (`pagamenti.anno_id`, assegnato dal database dalla competenza, altrimenti dalla
   scadenza, altrimenti dalla creazione), tradotto in anno d'apertura attraverso il calendario della sede;
2. se la voce non ha `anno_id`, o il calendario non lo conosce, o lo schema è indietro: il **periodo di
   competenza** (`pagamenti.periodo_competenza`, dal giorno 1 del mese) letto con la regola unica del
   calendario (`annoScolasticoDiCompetenza`);
3. se manca anche quello — **71 pagamenti su 98 al 2026-08-10** —: il **giorno del documento** (giorno
   fiscale di Roma), con la stessa regola. Solo in questo caso l'emissione scrive una riga `warn`
   (`esito = 'anno-scolastico-da-data-documento'`).

**Agosto non ferma più l'emissione.** Il motivo `periodo_competenza_mancante` e l'esito
`anno-scolastico-ambiguo` sono stati tolti dal compito 4.1.S3: con una regola sola non c'è più un
anno «candidato» da scegliere fra due. Sul database della CI, dove `pagamenti.anno_id` non c'è
(errore `42703`), la lettura della voce si rifà senza la colonna e si scrive un `info`
(`esito = 'anno-della-voce-non-disponibile'`); poiché lì manca anche il calendario (`PGRST205`), se ne
aggiunge un secondo (`calendario-non-disponibile`), e se la voce non ha la competenza anche il `warn`
`anno-scolastico-da-data-documento`. In tutto due `info` e nessuna riga `error`: la fattura parte come prima.

Per i test: `__tests__/lib/aruba/emissione-anno-della-voce.test.ts`, `__tests__/lib/fatturazione/`.

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
