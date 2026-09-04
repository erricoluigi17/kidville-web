# La causale che nessuno ha mai emesso, e il fratello che paga senza che si veda

*Design — 2026-09-04*

## Il problema, misurato

Due richieste del titolare, e sotto ciascuna un difetto misurato in produzione, non dedotto.

### 1. La causale configurata non arrivava sulla fattura

Kidville Aversa aveva compilato il modello in Contabilità → Causali:

> `Pagamento retta del mese di {mese} {anno}. Per il figlio minore {nome_completo} C. F. {codice_fiscale}`

La fattura **FPR 1948/26**, trasmessa allo SDI il 2026-09-03, è uscita con `Retta 09/2026` — la nuda
`pagamenti.descrizione`.

**Non era l'emissione.** `emissione.ts` leggeva la configurazione, dalla sede giusta, e la applicava.
Il difetto stava **una schermata prima**: `FatturaButton.tsx` precompilava la casella «Causale
fattura» con la descrizione del pagamento (`useState(descrizione ?? '')`) e la spediva come
*correzione manuale della segreteria* — che per progetto batte qualunque modello. Chi premeva
«Emetti» senza svuotare il campo, cioè chiunque, annullava la configurazione senza saperlo.

Il segnaposto di quella stessa casella recitava «Lascia vuoto per usare il template delle
impostazioni»: **l'interfaccia descriveva il comportamento che si impediva da sola.**

Aggravante: la POST salvava quella stringa in `pagamenti.fattura_causale` e non l'azzerava mai. Il
pagamento restava congelato — cambiare il modello non avrebbe più avuto effetto su di lui.
In produzione erano 5 righe, tutte e cinque con `fattura_causale` **identico** a `descrizione`.

**Perché nessun test se n'era accorto**: non esisteva alcun test su `FatturaButton`. I test della
composizione erano corretti e verdi, e misuravano la metà giusta della catena.

### 2. «Paga il fratello» esisteva ovunque tranne dove serviva

`alunni.retta_a_carico_di` (self-FK, migrazione `20260816200528`) è rispettata da **entrambe** le
strade che generano le rette. Ma si poteva valorizzare **solo** dall'import delle iscrizioni: non
era in `patchBodySchema` né in `allowedFields` di `admin/students`. In produzione **44 alunni**
l'avevano valorizzata senza che nessuna schermata la mostrasse — e la route dell'import lo sapeva
già, tanto che il suo messaggio d'errore diceva *«Va corretto dalla scheda dell'alunno»*.

### 3. Quello che è saltato fuori cercando gli 0,01 €

Cinque alunni avevano un importo simbolico. Cercando di riallinearli:

| | situazione | esito |
|---|---|---|
| `f75f88c7` | due fratelli, uno solo paga davvero (450 €) | ✅ candidato unico, riallineato |
| `97b9efbb` | 🔴 il fratello da **250 €** è marcato a carico di **lui**, che ha 0,01 € | legame ROVESCIATO |
| altri tre | nessun fratello collegato | non deducibile, contrassegnati |

Sul secondo: i generatori saltano chi è a carico di un altro, quindi il fratello da 250 € non
generava nulla e la famiglia è stata addebitata di **0,01 € per settembre 2026**. Nove mesi sono
**2.250 €** che nessuno avrebbe mai chiesto. Nessun errore, nessun log, nessuna schermata.

## Le decisioni, e perché

### La composizione della causale vive in un posto solo

L'anteprima non ricalcola: chiama `componiCausalePagamento` (`src/lib/aruba/causale-pagamento.ts`),
lo stesso codice dell'emissione. Un'anteprima calcolata a parte sarebbe **peggio** del difetto che
chiude — la segreteria approverebbe un testo e ne spedirebbe un altro — e la divergenza non darebbe
nessun errore, perché `renderCausale` omette con grazia i segmenti coi segnaposto vuoti.

Il lock `__tests__/architecture/causale-fattura-un-motore-solo.test.ts` lo tiene: `causaleFattura`
si chiama da un modulo soltanto, e nessun file client la importa.

### Anteprima in sola lettura, «Personalizza» come atto deliberato

Scartate due alternative:

- **precompilare con la causale resa** (invece che con la descrizione): il testo sarebbe giusto, ma
  ogni emissione continuerebbe a scrivere `fattura_causale`, congelando il pagamento;
- **togliere del tutto la casella**: nessuna scappatoia, ma nemmeno una correzione al volo su un
  caso strano — e quelle servono.

Scelta: il modale mostra il testo **in sola lettura**, con l'origine («dal modello della tipologia»
/ «Predefinito della sede» / «modello di base» / «corretta a mano») e il conteggio `n/200` misurato
**sul tracciato** (`€`→`EUR`), non su `.length`. «Personalizza» sblocca. Se il testo torna identico
all'anteprima si spedisce `causale: null` lo stesso: non si congela un pagamento per un testo che
non corregge niente.

**Anteprima fallita ⇒ «Emetti» bloccato.** Emettere alla cieca su un documento irreversibile non è
un ripiego accettabile.

### La coppia legame/importo la scrive il server

Valorizzare `retta_a_carico_di` porta `importo_retta_mensile` a 0 **nella stessa update**. Sono due
facce dello stesso fatto: lasciarle al client vuol dire lasciarle divergere, ed è la coppia che in
produzione era già incoerente su tre righe. Lo zero **non** scende sui pagamenti già generati —
`riallineaImportoRetteFuture` rifiuta gli zeri di proposito, perché sulla colonna significa «default
di sede» e su un pagamento significherebbe «non deve niente».

Quattro guardie lato server, perché in anagrafica i due alunni sono righe indipendenti (nell'import
erano indici della stessa domanda): esiste · stessa sede · iscritto e non archiviato · non forma
catene né anelli.

### Il lato di chi paga resta in sola lettura

La scheda del pagante mostra «Paghi anche la retta di: …» ma non la modifica. La stessa relazione
modificabile da due schermate è una doppia strada per lo stesso dato. Serve solo a far vedere un
legame rovesciato guardando **una** delle due schede — ed è precisamente ciò che è mancato.

### La rete

Un anello si deve vedere **il mese dopo**, non fra un anno: l'anteprima delle rette contrassegna
l'importo simbolico e dice per quanti fratelli quel bambino paga, e la route logga in `warn` il
**conteggio** delle famiglie a totale sospetto — solo numeri e uuid di sede, mai nomi né codici
fiscali.

## Cosa NON è stato fatto, e perché

- **FPR 1948/26 resta com'è.** Il documento è fiscalmente valido: la causale è brutta, non illecita.
  Correggerla vorrebbe dire una nota di variazione, che è una decisione fiscale, non tecnica.
- **`FPR 1947/26` ha bruciato un numero** (`sdi_stato = 2`, «Errore upload»): nel sezionale FPR 2026
  c'è un buco, e non lo ha causato questo lavoro. Va a verbale.
- **Il legame rovesciato di Giugliano non è stato raddrizzato.** Cambia quanto una famiglia vera
  deve pagare: lo conferma una persona, dall'interfaccia che questo lavoro costruisce.
- **I tre 0,01 € senza fratello collegato restano.** Qualunque valore sarebbe stato **inventato**.
