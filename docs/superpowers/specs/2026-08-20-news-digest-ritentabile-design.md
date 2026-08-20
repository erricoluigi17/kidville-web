# Il digest mensile: ritentabile, e per la stessa ragione sorvegliabile

**Data**: 2026-08-20 · **Scadenza dura**: 1° settembre 2026, 08:00 UTC · **Stato**: specifica, non implementata

---

## Il difetto, in tre pezzi che sembrano tre e sono uno

`news-digest` (`supabase/migrations/20260720191525_news_cron.sql:109`) è schedulato **`'0 8 1 * *'`**:
una volta al mese, il primo, alle 08:00 UTC. Chiama `/api/news/cron/run`, che finisce in
`src/lib/news/digest.ts`.

### A · Un'edizione respinta per quota viene marcata come inviata lo stesso

`digest.ts:389-393` scorre **tutti** i destinatari senza tetto. `sendEmailDetailed` distingue da
sempre due fallimenti — `src/lib/email/send.ts:232-247` ritorna `{ ok: false, rinviabile: true }`
sul `429`, e il commento accanto spiega che *«un rifiuto definitivo consuma un tentativo, un `429`
rinvia»*. **Il digest non guarda quel campo.** Poi `digest.ts:396-403` marca `inviata_il`
incondizionatamente.

Conseguenza: il giorno in cui Resend dice «hai finito la quota di oggi», l'edizione del mese
risulta **inviata** a chi non l'ha ricevuta, e `inviata_il IS NULL` — la guardia che decide se
rispedire — non sarà mai più vera. Il digest è perso **in silenzio**, e nessun log dice «a 400
famiglie non è arrivato».

### B · Il ramo prudente accanto cita un cron che non esiste

`digest.ts:376-387` — il ramo «non si è potuto nemmeno tentare» — fa la cosa giusta: **non marca**.
Ma la ragione scritta accanto è:

> *«lasciandola in coda riparte al giro successivo (il cron gira ogni giorno) appena il database
> torna leggibile»*

**`news-digest` non gira ogni giorno.** Gira il primo del mese. Quello che gira ogni dieci minuti è
`news-tick` (`*/10 * * * *`, dieci righe sopra nella stessa migrazione), che è un altro lavoro.
Un'edizione lasciata in coda da quel ramo non riparte domani: riparte **il primo del mese dopo**.

La cautela è giusta; la ragione scritta accanto no — ed è la ragione che il prossimo leggerà per
decidere se fidarsi. È la stessa classe di difetto che `CLAUDE.md` chiama *«un documento che
descrive una protezione che non c'è più è peggio di nessun documento»*.

### C · `/api/health` è cieco su questo lavoro

`news-digest` non compare né in `JOB_CRON` né in `JOB_CRON_NON_SORVEGLIATI`
(`src/lib/health/controlli.ts`). Non è una svista sorvegliabile: **è strutturale**. `app_log`
conserva **30 giorni**, quindi la finestra necessaria a un lavoro mensile (~32 giorni) supera la
conservazione — il battito precedente sparisce prima che arrivi il successivo. È esattamente la
ragione già scritta per `notifiche-retention` e `iscrizioni-retention`, che infatti stanno fra i
**non** sorvegliati.

### La radice unica

Nessuno dei tre pezzi sa **quanto tempo passa prima del prossimo tentativo**. A marca e perde
l'edizione per sempre; B non marca e la perde per un mese credendo di rimandarla a domani; C non
può guardare perché la cadenza è più lunga della memoria. **Una cadenza mensile è la causa comune.**

---

## Quanto è urgente: la misura, non la proiezione

Il piano precedente diceva *«~500 email contro un tetto di 100/giorno»*. **Misurato il 2026-08-20
alle 12:24, oggi è falso**: `emailFamiglie` scrive ai genitori dei bambini **a registro**, e a
registro ci sono **31 iscritti** con **37 legami** in `student_parents`. Oggi il 1° settembre non
sfonderebbe nessun tetto.

**Diventa vero verso il 28 agosto.** L'importazione delle iscrizioni crea davvero righe in `alunni`
e `student_parents` (`src/lib/iscrizioni/import/esegui.ts`), procede a ~90 email al giorno dal
22/08, e **403 domande × 1,23 ≈ 496 account** si esauriscono in circa sei giorni.

🔑 La scadenza regge, ma **per una ragione diversa da quella scritta**. Chi legge deve sapere quale,
altrimenti al prossimo controllo troverà 37 dove si aspettava 500 e concluderà che il problema non
esiste.

---

## La correzione, com'è stata COSTRUITA — e perché non è quella che questa specifica prevedeva

> ⚠️ **Le due righe qui sotto sostituiscono il disegno originale di questa sezione.** La prima
> stesura proponeva di portare `news-digest` da mensile a giornaliero, e presentava la cosa come
> l'unica strada. Scrivendo il codice è emerso che la cadenza **non è il perno**: il perno è che
> `generaEInviaDigest` lavora su **un mese solo**, quello che il chiamante gli passa. Con quel vincolo,
> anche una cadenza giornaliera non avrebbe ripescato niente — avrebbe solo riguardato lo stesso mese
> più spesso. La correzione vera è nel **chiamante**, e non richiede nessuna migrazione.

### 1 · Rispettare `rinviabile`, e riprendere da dove si era arrivati

`src/lib/news/digest.ts`. Al primo `res.rinviabile` ci si **ferma** (la quota è finita: continuare
colleziona altri 429 e, col throttle di 500 ms, occupa la route per minuti a vuoto) e **non si marca**
`inviata_il`. Si salva l'avanzamento in `destinatari_count`.

🔑 **Nessuna colonna nuova, e non è un ripiego.** `destinatari_count` assume il significato «a quanti
è arrivata FINORA», che a edizione completa coincide col totale — cioè con ciò che ha sempre voluto
dire. Perché l'offset significhi qualcosa, `emailFamiglie` restituisce ora l'elenco **ordinato**:
PostgREST non promette un ordine, e un offset dentro un elenco che cambia ordine salterebbe famiglie
diverse a ogni giro.

⚠️ **Il prezzo, dichiarato**: se fra due giri l'elenco cambia, l'offset è approssimato. Una famiglia
iscritta nel frattempo che ordina prima dell'offset non riceve quell'edizione — ed è il **verso
giusto** dell'errore, perché è il digest di un mese in cui quella famiglia non c'era. Il verso
sbagliato (spedire due volte) resta possibile solo se un indirizzo cambia. Fra una mail doppia e una
comunicazione istituzionale persa, si è scelto il fastidio.

### 2 · Ripescare le edizioni rimaste in coda

`src/app/api/news/cron/run/route.ts`. Dopo il mese corrente, `eseguiDigest` cerca le edizioni con
`inviata_il IS NULL` e le lavora. **Senza questo pezzo il punto 1 non serve a niente**: «non marcare»
avrebbe solo cambiato il modo di perdere l'edizione, da «marcata e mai rispedita» a «in coda e mai
riguardata».

Ed è anche ciò che ripara il ramo prudente **preesistente** (database illeggibile, notifiche
disattivate): il suo commento prometteva una ripresa che non è mai avvenuta.

⚠️ **Tetto a sei mesi, di proposito**: senza, un'edizione irrecuperabile (una sede chiusa, un mese
senza destinatari validi) verrebbe ritentata a ogni giro per sempre, col costo che cresce in silenzio.

### 3 · Dichiarare il lavoro a `/api/health`

`news-digest` non era **in nessuna delle due liste** di `src/lib/health/controlli.ts`, che è lo stato
peggiore: «lasciato fuori apposta» e «dimenticato» diventano indistinguibili, ed è esattamente ciò che
le due costanti esistono per separare.

Va in **`JOB_CRON_NON_SORVEGLIATI`**, non in `JOB_CRON`, e la ragione è strutturale, non di gusto:
`app_log` conserva **30 giorni**, la finestra di un lavoro mensile è ~32, quindi il battito precedente
sparisce prima che arrivi il successivo e l'allarme suonerebbe ogni mese su un lavoro sano. È la stessa
ragione già scritta per `notifiche-retention` e `iscrizioni-retention`.

### Cosa NON è stato fatto, e resta scritto

**La cadenza resta mensile.** Portarla a `'0 8 * * *'` richiede una migrazione, e una migrazione va
*applicata*: `apply_migration` non è disponibile in questa sessione e `migrate.yml` è fermo in `waiting`
dal 16/08. Con la correzione qui sopra la cadenza mensile **non perde più niente** — un'edizione a metà
riparte il primo del mese dopo e riprende dall'offset. La cadenza giornaliera resta desiderabile per due
ragioni, entrambe misurabili: accorcerebbe l'attesa da un mese a un giorno, e renderebbe il lavoro
**sorvegliabile** da `/api/health` (`finestraMs: 26 * ORA`), togliendolo dai non sorvegliati.

⚠️ **L'ordine, se un giorno si fa**: `controlli.ts` porta già la lezione pagata l'11/08/2026 su
`candidature-retention` — *«applicare la migrazione PRIMA del deploy apre una finestra in cui il
database chiama codice che non c'è»*. Prima il codice, poi la migrazione, poi la fotografia, poi il
nome in `JOB_CRON`.

---

## Cosa resta al titolare, e non lo decide un agente

La correzione qui sopra fa in modo che **nessun digest venga perso in silenzio**. Non decide
**quanto** si è disposti a spendere:

| Strada | Costo | Effetto |
|---|---|---|
| Lasciare il tetto a 100/giorno | zero | Il digest a ~500 famiglie si completa in **~5 giorni**. Chi è in fondo alla lista lo riceve il 5 settembre. |
| Alzare il piano Resend | denaro | Parte tutto il 1° settembre. |
| Spostare il digest | zero | Non risolve: 500 destinatari restano 500. |

Con la correzione, la prima strada è **accettabile e onesta**; senza, è una perdita silenziosa. È
questa la differenza che il codice può fare da solo — il resto è una decisione commerciale.

---

## Verifica — eseguita, non promessa

| Cosa | Come è stata provata | Esito |
|---|---|---|
| Un `429` a metà non marca l'edizione | `__tests__/lib/news/digest-quota.test.ts` — finto che ritorna `rinviabile: true` al 3° invio | ✅ `inviata_il` resta `null` |
| Il ciclo si FERMA al primo `429` | stesso file | ✅ 3 invii tentati, non 5 |
| Lo dice, coi due numeri | stesso file | ✅ log `warn` · `esito: rimandata-quota` · `inviate: 2` · `mancanti: 3` |
| Il secondo giro RIPRENDE, non ricomincia | stesso file, stesso `db` due volte | ✅ secondo giro: `f3, f4, f5` — mai `f1` |
| Un rifiuto **definitivo** non ferma niente | un `403` in mezzo | ✅ 5 invii, edizione marcata, `errori_count: 1`, nessun `rimandata-quota` |
| L'elenco è ordinato | database che li ritorna mescolati | ✅ invii in ordine alfabetico |
| Un'edizione arretrata viene ripescata | `__tests__/api/news-cron.test.ts` | ✅ agosto (corrente) + luglio (arretrato) |
| Il mese appena lavorato non si rifà | stesso file, **a doppio senso** | ✅ agosto una volta sola, luglio comunque ripescato |
| Oltre 6 mesi si lascia perdere | gennaio 2025 fra le pendenti | ✅ ignorato |
| La stessa coppia su più sedi = una volta | tre righe stesso mese | ✅ una chiamata |
| La lettura fallita si DICE | `42703` iniettato | ✅ `warn` · `arretrate-non-lette`, il giro non muore |

### 🔑 I test sono stati ROTTI apposta, uno per uno

Un test verde al primo colpo non prova niente: prova solo che è verde. In questo repo un lock si era
già **immunizzato col proprio commento**, e nessuno se n'era accorto perché era sempre stato verde.

Quindi, dopo averli scritti, **il difetto è stato reinserito** e si è misurato quali diventavano rossi:

| Difetto reinserito | Test rossi |
|---|---|
| `else if (res.rinviabile)` → `else if (false)` | **3 su 5** in `digest-quota` |
| `arretrate.push(...)` rimosso | **4 su 5** in `news-cron` |

I test che **restano verdi** sono quelli che sorvegliano l'altra direzione (un `403` non deve fermare
niente; l'ordinamento; la lettura fallita) — e vanno letti così, non come copertura mancante. È per
questo che il test «il mese appena lavorato non si rifà» è stato **riscritto a doppio senso**: nella
prima stesura restava verde anche col ripescaggio spento del tutto, e un verde che non distingue
«funziona» da «non c'è» è peggio di nessun test.

### Il gate

`npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build` — tutti verdi
sul codice di questa consegna. `GET https://app.kidville.it/api/health` → `stato: ok` prima e dopo.
