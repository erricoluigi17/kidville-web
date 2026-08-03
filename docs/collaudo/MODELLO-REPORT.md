# Modello di report — lo stesso per tutti e 20 i tester

Copia questo schema. Il blocco YAML in testa serve alla sintesi finale per contare e ordinare i
rilievi senza rileggere tutto: **compilalo sempre**, anche quando il verdetto è `PASS`.

Percorso del file: `docs/collaudo/risultati/tester-NN-<slug>.md` (il nome esatto è in fondo al tuo
prompt). Un solo file, il tuo.

---

```markdown
---
tester: 07
categoria: frontend
verdetto: PASS            # PASS | FAIL | BLOCCATO
bloccanti: 0
gravi: 2
minori: 5
warning: 3
data: 2026-08-03
bersaglio: http://localhost:3100
commit: 45491e6
---

# Tester n. 07 — Frontend e compatibilità

## COMANDI / FLOW ESEGUITI
- `npx vitest run __tests__/components` → 102 file, 0 rossi
- login come genitore su `/parent` → 12 pagine visitate, console pulita su 9
- viewport 320 / 768 / 1440 px su 6 pagine → 2 tracimazioni orizzontali
- motore WebKit su `/parent/pagamenti` → differenza di resa nel selettore data

## PROVA DI VALIDITÀ
Come ho dimostrato che questo collaudo *saprebbe* fallire:
- ho puntato il controllo della console su una pagina con un errore noto → l'ha visto
- ho ristretto il viewport a 280 px → la tracimazione è comparsa anche dove prima taceva

## VERDETTO
FAIL

## FALLIMENTI

### F1 — <titolo breve, una riga>
- **Cosa**: cosa non funziona, e per chi (quale ruolo, quale schermata)
- **Dove**: `percorso/file.ts:123` · rotta `/api/...` · schermata `/parent/...`
- **Errore esatto**: il messaggio, lo status, la misura. Copiato, non parafrasato.
- **Causa radice**: perché succede. Se non l'hai isolata, scrivilo: «ipotesi non verificata».
- **Come riprodurre**: 1. … 2. … 3. …
- **Cosa serve per sistemarlo**: la correzione minima che chiuderebbe il difetto
- **Gravità**: bloccante | grave | minore

### F2 — …

## WARNING (si compila ANCHE se il verdetto è PASS)
- contrasto al limite su …
- commento obsoleto in `src/lib/logging/with-route.ts:7` (dice 239 route, sono 282)
- …

## ALTRUI
Difetti che ho incrociato ma che appartengono a un altro tester (una riga ciascuno, senza indagare):
- sembra un problema di accessibilità sul menu → tester 09
- …

## NON VERIFICATO
Cosa del mio perimetro è rimasto scoperto, e perché:
- i percorsi di scrittura (creazione avviso, salvataggio presenze): richiedono scrittura sul
  database di produzione, vietata dalle regole comuni
- …
```

---

## Le tre parole del verdetto

| | Quando si usa |
|---|---|
| **PASS** | hai verificato, hai fatto la prova di validità, non hai trovato difetti nel tuo perimetro. I warning restano warning. |
| **FAIL** | almeno un fallimento confermato, di qualunque gravità. Un `minore` confermato è comunque `FAIL`. |
| **BLOCCATO** | non hai potuto verificare: manca un ambiente, un permesso, una credenziale, un dato. Scrivi cosa serve per sbloccarti. |

## Le tre gravità

| | Significa |
|---|---|
| **bloccante** | non si rilascia così: perdita o esposizione di dati, funzione principale rotta, guasto su dati di minori |
| **grave** | si rilascia solo con una decisione consapevole: funzione secondaria rotta, difetto visibile agli utenti, rischio concreto |
| **minore** | si può rilasciare e correggere dopo: cosmetico, di margine, o su un percorso raro |

Nel dubbio fra due livelli, scegli il **più alto** e spiega il dubbio: chi legge la sintesi può
declassare, ma non può indovinare un rilievo che hai minimizzato.

## Quattro errori che rendono un report inutile

1. **Parafrasare l'errore.** Copia lo status, il codice, il messaggio. `403` non dice niente,
   `403 "the domain is not verified"` dice tutto — è esattamente il difetto che qui è rimasto
   nascosto per mesi.
2. **Scrivere «dovrebbe», «probabilmente», «sembra» senza dirlo.** Se è un'ipotesi, etichettala.
3. **Fermarsi al sintomo.** «La pagina è vuota» non è un rilievo; «la pagina è vuota perché la
   route risponde 500 quando `scuola_id` è nullo» lo è.
4. **Mettere dati personali o segreti nel report.** Conteggi, uuid, nomi di colonna: sì.
   Nomi, email, codici fiscali, allergie, password, token: mai. Il repo è pubblico.
