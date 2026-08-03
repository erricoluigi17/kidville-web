# Tester n. 18 — Contenuti pubblicati (news, post, comunicati) e metadati

Sei **il tester n. 18**. Fai **un solo collaudo**: quello che viene *pubblicato* — i post della sezione
News, gli embed, le anteprime, la moderazione. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; **non pubblicare
niente, non salvare bozze, non inviare digest**: i lettori sono genitori veri. Non fermi né riavvii il
server su `:3100`.

---

## Il pezzo di prodotto che ti riguarda

- **Libreria** `src/lib/news/`: `sanitizza.ts` (sanificazione HTML con `sanitize-html` + render
  TipTap→HTML), `instagram.ts` (shortcode, URL di embed, health-check), `digest-email.ts` e
  `digest.ts` (digest mensile), `gate-consenso.ts`, `consenso-foto.ts`, `permanenza-consenso.ts`,
  `foto-nel-post.ts`, `media-bozza.ts`, `target.ts`, `notifiche.ts`.
- **Editor** `src/components/features/admin/news/` (TipTap) e **UI condivisa**
  `src/components/features/news/` (`InstagramEmbed`, `VideoEmbed`, `NewsCard`, …).
- **API** `src/app/api/news/` — 14 route, fra cui `[id]/pubblica`, `[id]/approva`, `digest/genera`,
  `instagram/valida`, `upload`, `cron/run`.
- **Flusso**: bozza → proposta → programmata → pubblicata. Il feed del genitore è derivato dal server
  ed è **fail-closed**.

---

## Che cosa devi verificare

### 1. Sanificazione dell'HTML (XSS memorizzato)
È il rischio numero uno di un editor ricco: quello che un redattore incolla viene salvato e poi
mostrato a tutti i genitori.
```bash
npx vitest run $(grep -rl "sanitizza" __tests__ | head -20)
```
Leggi `src/lib/news/sanitizza.ts` e verifica **quali tag e attributi sono ammessi**. Poi prova la
funzione in isolamento (uno script tuo, in una cartella temporanea, che la importa) con i classici:
`<script>`, `<img onerror=…>`, `<a href="javascript:…">`, `<iframe src=…>`, `<svg onload=…>`,
`<style>`, attributi `on*`, `data:` URI, HTML annidato e malformato, entità doppie
(`&lt;script&gt;` che ridiventa `<script>` dopo due passaggi).

**Attenzione al doppio passaggio**: TipTap→HTML e poi sanificazione — verifica in che **ordine**
avvengono. Sanificare prima e renderizzare dopo lascia la porta aperta.

### 2. Gli embed di terze parti
Instagram e video: uno `<iframe>` verso l'esterno è codice altrui dentro la tua pagina.
- l'URL di embed si costruisce solo da uno shortcode **validato**, o accetta URL arbitrari?
- che succede se Instagram risponde lentamente o male? La pagina rallenta per tutti?
- l'iframe ha `sandbox`, `referrerpolicy`, `loading="lazy"`?
- la CSP permette esattamente quei domini, o è aperta?

### 3. Le foto dei bambini
È la parte più delicata: un post con la foto di un minore il cui genitore non ha dato il consenso è un
incidente serio.
```bash
npx vitest run __tests__/architecture/consensi-foto-revocabili.test.ts
grep -rn "gate-consenso\|foto-nel-post\|permanenza-consenso" src/ | head -20
```
Verifica per lettura: il gate del consenso è applicato **su tutte e tre** le strade che pubblicano
(non su due su tre — è l'errore ricorrente di questo repo); una revoca del consenso agisce **anche sui
post già pubblicati**; l'upload ha un tetto di dimensione e un elenco chiuso di tipi
(lock `upload-pubblico-con-tetto`, `allegati-mime-dichiarati`).

### 4. Moderazione dei contenuti degli utenti
C'è una sezione `admin/moderazione`. Verifica per lettura: cosa può segnalare un utente, chi lo vede,
quanto ci mette. Per gli store — un'app che tratta minori deve avere una politica sui contenuti **e
uno strumento di segnalazione dentro l'app** (requisiti CSAE, in vigore da gennaio 2026). Se non c'è,
è un rilievo di conformità, non un dettaglio di prodotto.

### 5. Metadati e anteprime
Per le pagine pubbliche e per un post pubblicato:
```bash
curl -s http://localhost:3100/ | grep -iE "<title|og:|twitter:|description|canonical" | head -20
curl -s http://localhost:3100/robots.txt ; curl -s http://localhost:3100/sitemap.xml | head -5
```
Verifica: `<title>` sensato e diverso per pagina, `description`, `og:title`/`og:description`/`og:image`
(dimensione giusta, e **nessuna foto di minore** in un'anteprima pubblica), `canonical`, `lang="it"`,
`robots.txt` che non indicizza le aree private.

### 6. Editoriale
Su tre post già pubblicati (in lettura): refusi evidenti, link rotti (`curl -I` su ogni link uscente),
immagini senza testo alternativo, immagini troppo pesanti, data e ora di pubblicazione coerenti col
fuso `Europe/Rome`, e la resa del post nel **digest email** (che è un altro contesto, con altre regole).

### 7. Il digest
`src/lib/news/digest.ts` esclude la sede E2E dai destinatari: verifica che sia ancora vero, e che il
digest di una sede non contenga post di un'altra.

---

## La prova di validità (obbligatoria)

- La tua prova di XSS: passa alla funzione di sanificazione una stringa **innocua** — deve uscire
  intatta. Se anche quella viene stravolta, stai chiamando la funzione sbagliata e i tuoi "passa"
  non valgono.
- I link rotti: metti in lista un URL che **sai** essere morto (`https://example.invalid`) e verifica
  che il tuo controllo lo segnali.

## Verdetto

| | Quando |
|---|---|
| **PASS** | nessun payload XSS sopravvive, embed limitati e sandboxati, gate del consenso su tutte le strade di pubblicazione, metadati completi e senza foto di minori, digest per sede corretto |
| **FAIL** | un payload che sopravvive alla sanificazione, una foto senza consenso, un embed che accetta URL arbitrari, un digest che attraversa le sedi |
| **BLOCCATO** | non riesci ad aprire l'area news |

## Il tuo report

`docs/collaudo/risultati/tester-18-contenuti.md` — front-matter con `tester: 18`,
`categoria: contenuti`. Elenca **i payload provati** con l'esito di ciascuno (senza incollare HTML
eseguibile). Nei warning: i link uscenti senza `rel="noopener"`, le immagini pesanti, i metadati
mancanti, i refusi.
