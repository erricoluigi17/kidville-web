# Anagrafiche della primaria da Argo — genitori collegati ai figli

**Data**: 2026-09-01 · **Stato**: approvato dal titolare in chat il 2026-09-01

## Perché esiste questo lavoro

La primaria di Kidville ha **76 alunni attivi** (Giugliano 36, Cesa 40) e le loro anagrafiche sono
buone, ma **le famiglie sono monche**. Misurato in produzione il 2026-08-31, solo conteggi:

| | Giugliano | Cesa | totale |
|---|---|---|---|
| alunni di primaria attivi | 36 | 40 | **76** |
| **con un solo genitore collegato** | 31 | 26 | **57** |
| con due o più | 5 | 14 | 19 |
| senza nessun genitore | 0 | 0 | 0 |

E un secondo guasto, più insidioso del primo perché **non si vede**:

> `student_parents.relation_type` è **`NULL` su tutti e 95** i legami della primaria — e su **586
> su 623** in tutto il database. Dove è valorizzato convivono **due vocabolari**: `mother`/`father`
> (26 righe) e `madre`/`padre` (11).

Conta perché `scripts/anagrafica-completa-2026.mjs` decide chi riceve un account con
`PARENTELE_GENITORE = new Set(['mother','father'])`: una parentela `NULL` o scritta in italiano
non è un errore, è un'**esclusione silenziosa**.

KinderTap non copre la primaria — era nido e infanzia. La fonte è **Argo**.

## Cosa c'è in Argo, misurato

Applicativo **Argo Alunni Web 4.25.0**, codice scuola `SP29900`, istituzione
`KIDVILLE - SCUOLA LA FAVOLA SOC. COOP GIUGLIANO IN CAMPANIA`, ordine `Scuola Primaria` (unico).

- **10 classi, a.s. 2025/2026**, su due corsi: A = 22·17·17·14·14 (84 alunni) · B = 17·15·18·12·17
  (79). **Totale 163.**
- **L'a.s. 2026/2027 in Argo è vuoto**: zero classi. Il passaggio all'anno non è stato fatto.
- `Altro → Esporta Dati → Esportazioni personalizzabili` espone un albero di campi con un ramo
  **`Dati anagrafici genitori`**: **45 campi**, su **tre posti adulto** — `Padre`, `Madre`,
  `Genitore` (tutore). Per ciascuno: cognome, nome, data nascita, comune e provincia di nascita,
  **codice fiscale**, indirizzo/comune/provincia/CAP di residenza, telefono, cellulare, **email**,
  titolo di studio, attività svolta.

### Le due conseguenze che cambiano il progetto

1. **Il «rischio numero uno» di KinderTap qui non esiste.** L'aggancio per nome era inevitabile là
   perché gli export non portavano i legami. In Argo padre e madre escono **sulla stessa riga del
   figlio**: il collegamento è nella struttura del file, non da ricostruire. E la parentela è
   **esplicita** nel nome della colonna — è la cura del `relation_type` `NULL`.
2. **Argo NON è la fonte della classe.** Le sue classi sono del 2025/26. Copiare anche la sezione
   retrocederebbe 76 bambini di un anno. Il perimetro e la classe restano di Kidville (gli elenchi
   2026/27 già caricati). Argo dà **anagrafica e genitori**, niente altro.

I 163 di Argo comprendono chi ha finito la quinta a giugno e non è più iscritto: il delta con i 76
non è un difetto, ma **va elencato** invece che ignorato — se qualcuno *doveva* esserci, si vede lì.

## Approccio scelto

**Esportazione personalizzabile → un Excel → uno script di riconciliazione.**

Scartate: l'XML *«Per Altra Istituzione Scolastica»* (formato proprietario, e porta **più dati del
necessario** — su anagrafiche di minori la minimizzazione non è un cavillo; resta come riserva se
all'export manca un campo) e la lettura **scheda per scheda** (163 schede: lento e con errori di
lettura, esattamente ciò che le ISTRUZIONI di KinderTap vietavano).

Lo script **riusa i moduli veri del prodotto** (`abbina`, `normalizzaNome`, `calcolaCodiceFiscale`,
`validaCodiceFiscale`) invece di riscriverli: una seconda copia diverge dalla prima al primo caso
limite, e diverge in silenzio.

## Regole di aggancio

Chiave **unica**: il **codice fiscale**, normalizzato (maiuscolo, senza spazi). Popolato su tutti e
76 gli alunni Kidville e obbligatorio in Argo. **Nessun aggancio per nome, in nessun caso.**

| esito | cosa succede |
|---|---|
| CF combacia | si scrive |
| CF non combacia | riga in `da-rivedere.xlsx`, **il database non si tocca** |
| CF duplicato o malformato | quella riga si ferma e lo dichiara — non «sceglie il primo» |

Il genitore si cerca per `parents.fiscal_code`: se esiste già — caso tipico dei **14 genitori con
più figli** — si riusa e si collega, non si duplica.

## Cosa si scrive

| tabella | cosa |
|---|---|
| `parents` (nuovi) | nome, cognome, CF, data e luogo di nascita, residenza completa, telefono, cellulare, email |
| `parents` (esistenti) | **solo le caselle vuote**: Argo non sovrascrive un dato già presente |
| `student_parents` | il legame mancante, e `relation_type` sui **95 legami oggi `NULL`** |
| `alunni` | solo le caselle vuote: comune/CAP di nascita e residenza (1 caso), `data_iscrizione` |

Vocabolario: **`father` / `mother`** — quello che lo script degli account già riconosce. Il terzo
posto adulto di Argo diventa un legame con parentela `tutore` e **nessun account**; il conteggio si
dichiara, non si decide di nascosto.

**Non si scrive**: la sezione (è dell'anno scorso), le allergie (Argo non le ha), gli alunni fuori
perimetro.

## Account e credenziali

Decisione del titolare del 2026-09-01, presa dopo aver visto l'alternativa: **anagrafica + account +
credenziali via email**, il giro completo.

**Ordine imposto: le email partono per ultime**, dopo che le scritture sono state verificate. Non è
una riduzione dello scope: un genitore agganciato al bambino sbagliato è un errore *silenzioso*
finché non arriva in casa a qualcuno la password del figlio di un altro, e a quel punto non è più
annullabile. Il recupero password autonomo in Kidville **non esiste**: chi perde la mail passa dalla
segreteria.

## Come si verifica

Prima della scrittura, a video: agganciati, non agganciati, genitori nuovi, genitori riusati.
Dopo la scrittura si **rieseguono le stesse query** del 2026-08-31 — `senza_genitori`,
`un_solo_genitore`, `parentela_ignota` — e i numeri attesi si dichiarano **prima**. Se uno non
torna, il lavoro si ferma **prima delle email**.

La corrispondenza **corso A/B → sede** non si deduce dall'ordine alfabetico: si **misura** dai
comuni di residenza dei due gruppi. È il metodo che ad Aversa ha trasformato «non si può dedurre»
in 73 riallineamenti su 73, e la ragione per cui non ci si fida: a KinderTap l'inferenza ovvia
(«La Favola» → Cesa) era sbagliata, ed è Aversa.

## Privacy

I file di lavoro vivono in **`~/argo-export/`, fuori dal repo pubblico**, e non si committano mai.
A schermo escono **solo conteggi e codici**: i nomi restano nei file. Nei log applicativi valgono
le regole di `AGENTS.md` — redazione a lista bianca, nessun dato personale.

## Cosa resta fuori, e va detto

- La **deriva di vocabolario** su `relation_type` (11 righe `madre`/`padre` fuori dalla primaria)
  si **segnala**, non si corregge: è fuori dal perimetro chiesto.
- Gli **87 alunni di Argo non presenti in Kidville** si elencano, non si creano.
