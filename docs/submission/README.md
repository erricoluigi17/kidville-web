# Cartella submission — i tre bloccanti A1 · A2 · A3

Tre documenti, uno per bloccante. Ognuno è **autosufficiente**: contiene la ricerca, le scelte
già fatte con la motivazione, e in fondo una checklist operativa.

**Come si usano**: leggi, correggi ciò con cui non sei d'accordo, e rispondi alle voci marcate
🟡 **DECISIONE** / **DOMANDA**. Da lì in poi eseguo io tutto quello che è lavoro di codice.

### Serie A — App Store (iOS)

| # | Documento | Chi lo esegue | Decisioni aperte |
|---|---|---|---|
| **A1** | [Stato di operatore commerciale (DSA)](A1-dsa-operatore-commerciale.md) | tu, in App Store Connect | **2** |
| **A1-bis** | [**D-U-N-S: richiesta e conversione account**](A1b-duns-richiesta.md) ⚡ | tu | ✅ **richiesto il 26/07** |
| **A2** | [App Privacy labels](A2-app-privacy-labels.md) | tu a schermo, io sul manifest | **3** |
| **A3** | [Dossier per il legale](A3-dossier-legale.md) | un legale, con questo fascicolo | **9 domande** |

### Serie C — Google Play (scheda oggi vuota)

| # | Documento | Chi lo esegue | Decisioni aperte |
|---|---|---|---|
| **C1** | [Account Play, D-U-N-S e percorso critico](C1-account-play-e-tempi.md) | tu, in Play Console | **2** |
| **C2** | [Lavoro tecnico: `.aab` firmato](C2-build-aab.md) | io — ~1 ora | — |
| **C3** | [Scheda: testi e grafica](C3-scheda-testi-grafica.md) | io, con la tua approvazione dei testi | — |
| **C4** | [Conformità: Data safety, salute, pubblico, IARC](C4-conformita-pubblico.md) | tu a schermo, tutto già deciso qui | — |
| **C5** | [🔴 **Sviluppo obbligatorio**](C5-sviluppo-obbligatorio.md) | io — ✅ decisione presa, pronto a partire | — |

> ⚡ **A1-bis è nato dopo**, quando la ricerca sul D-U-N-S ha trovato una cosa che ribalta il
> conto: **l'account non va rifatto, si converte** — i 99 € già pagati restano validi e il
> lavoro già fatto su App Store sopravvive tutto. Ha dentro i dati precompilati e il testo del
> ticket già pronto. **È il documento da aprire per primo.**

### Prompt pronti

| File | A cosa serve |
|---|---|
| [**PROMPT-CONTINUA.md**](prompts/PROMPT-CONTINUA.md) ⭐ | **riprendere tutto in una chat nuova** — stato, decisioni, coda di lavoro, trappole |
| [prompt-ticket-apple.md](prompts/prompt-ticket-apple.md) | aprire il ticket di conversione Apple con l'estensione Chrome |
| [prompt-c5-sviluppo.md](prompts/prompt-c5-sviluppo.md) | far implementare C5 in una sessione dedicata |

---

## L'ordine giusto — e perché non è 1, 2, 3

```
   OGGI, in parallelo, costo ~zero
   ├── A1 · Controllo 1 → cerca il D-U-N-S della cooperativa      (5 min, gratis)
   │     └── se manca, richiedilo: 5 gg lav. – 2 settimane che corrono da sole
   └── A3 · incarica il legale                                     (è il più lungo)
                                    │
   ┌────────────────────────────────┘
   │  A3 chiude → si sa cosa dice davvero l'informativa
   ▼
   A2 · etichetta + privacy manifest         (devono dire quanto dice /privacy)
   ▼
   A1 · Passo 5 → certifichi ad Apple la conformità al diritto UE
        ⚠️ NON firmarlo prima che il legale abbia confermato che è vero
   ▼
   invio in revisione
```

**Le due cose da far partire oggi** sono la ricerca del D-U-N-S e l'incarico al legale: sono le
uniche con un tempo d'attesa che non dipende da noi. Tutto il resto è lavoro che si fa mentre
quelle due maturano.

---

## Le tre cose emerse dalla ricerca che cambiano il quadro

1. **🔴 Linea guida 5.1.1(ix)** — un'app che tratta dati sanitari di minori *«should be submitted
   by a legal entity […] and not by an individual developer»*. L'account oggi è a nome di
   persona fisica. **Il vincolo di allora (mancava il D-U-N-S) non esiste più: è gratuito.**
   → A1 §0

2. **🔴 I dati DSA finiscono pubblici** sulla scheda App Store — indirizzo, telefono, email. E
   con un account Individual **il nome del venditore è già il tuo**, perché Apple non accetta
   nomi commerciali. → A1 §0 e §2

3. **🔴 I Termini di servizio non li accetta nessuno.** La casella dell'onboarding copre solo la
   privacy: la clausola di limitazione di responsabilità su cui conteresti **con ogni
   probabilità non ti protegge**. → A3 §3 bis, lacuna E

---

## Ciò che nel prodotto è già solido

Perché non si perda nel mezzo delle lacune:

- **consenso privacy con spunta obbligatoria e data registrata** all'onboarding del genitore;
- la **liberatoria fotografica è fatta valere dal codice**: una foto di gruppo non si pubblica
  se anche un solo bambino taggato non ce l'ha;
- **cancellazione dell'account richiedibile in-app** — è anche il requisito 5.1.1(v) di Apple;
- **logging con redazione a lista bianca** e conservazione a 30 giorni;
- **nessun tracciamento, nessuna pubblicità, nessun SDK di analytics** — e non è un'opinione:
  è verificabile riga per riga.
