# Prompt atomico — chiudere il collaudo dei 20 tester (parte residua)

> Copia **tutto** il blocco qui sotto in una chat nuova. È auto-contenuto: non serve
> nessun contesto di sessioni precedenti.

---

Lavora su `/Users/lerri/kidville-web`. Parla italiano.

## Contesto

Nella notte fra il 2 e il 3 agosto 2026 sono girati **20 tester indipendenti** sul repo:
19 hanno consegnato, tutti `FAIL`, **95 rilievi**. Il 3 agosto ne sono stati chiusi e
rilasciati in produzione una parte (PR #63, squash `7b7cf49`): i 4 test rossi, la verifica
adversariale del lavoro interrotto, e 8 rilievi gravi di privacy/sicurezza.

**Il tuo compito è chiudere il resto**: i gruppi `G4` prestazioni, `G5` osservabilità,
`G6` residuo notifiche, `G7` rilascio/infrastruttura, `G8` interfaccia.

L'inventario completo dei 95 rilievi è in `docs/collaudo/risultati/000-SINTESI.md`
(fuori da git: può contenere estratti del DB di produzione). **Quel file ha in testa un
riquadro che dice cosa è già stato chiuso — leggilo per primo.**

## ⚠️ La regola che vale più di ogni altra qui dentro

**Non fidarti di nessun documento, compreso questo. Misura.**

Questo repo ha pagato tre volte lo stesso errore in una settimana: un documento che
descriveva un mondo che non c'era più. `CLAUDE.md` diceva «pre-lancio, nessun dato reale»
mentre arrivavano 9 domande l'ora; una docstring si dichiarava «non ancora chiamata»
mentre lo era; una migrazione dice «nessuna retention» mentre la route cancellava.

E il 3 agosto **tre operazioni hanno dichiarato successo senza fare niente**:
- una migrazione `REVOKE ... FROM anon` (il permesso viveva su `PUBLIC`: revocarlo da
  `anon` riesce, non avverte, e non toglie niente);
- un `npx tsc --noEmit | head -3; echo "TSC OK"` — il messaggio si stampa sempre;
- una bonifica che contava i file *selezionati* invece di quelli *cambiati*.

Tutte e tre smascherate solo **rileggendo lo stato DOPO l'operazione**. Fallo sempre.

Prima di correggere un rilievo, **verifica che sia ancora vero** (un `grep`, una `SELECT`,
un test che rimette il difetto). Diversi rilievi risultavano aperti ed erano già chiusi;
almeno uno risultava chiuso ed era aperto. E se un rilievo è **sbagliato nei fatti**,
dillo e correggilo invece di implementarlo alla cieca.

## Stato misurato il 2026-08-04 (verificalo, non fidartene)

Gate: `tsc` ✅ · `eslint --max-warnings 0` ✅ · `vitest` **705 file / 6812 test, 0 rossi** ✅ ·
`npm run build` ✅. Migrazioni disco ↔ produzione allineate a **94**. Advisor Supabase 0 ERROR.
`main` è l'unico branch attivo (esiste `origin/fix/multisede-audit-globale` con **58 commit
mai rilasciati**: NON cancellarlo).

Produzione: 264 domande d'iscrizione, 152 codici fiscali di minori, 93 marcate
`raccolta_senza_informativa`, 77 iscrizioni push, 3 news, 15 job `pg_cron`.

## Cosa resta, misurato — non è un elenco a memoria

### G5 · Osservabilità — **parti da qui, e non è teorico**

In `app_log` ci sono errori VERI degli ultimi 7 giorni che **nessuno legge** (0 file in
`.github/` o `vercel.json` interroga `app_log`, rilievo `T12-F1`):

| livello | rotta | occorrenze |
|---|---|---|
| error | `/api/iscrizione/upload` | **43** |
| error | `client:fetch` su `/iscrizione` | 42 |
| error | `client:js` su `/iscrizione` | 37 |
| error | `client:fetch` su `/parent/chat` | 41 |
| error | `client:fetch` su `/parent/avvisi` | 42 |
| error | `client:fetch` su `/api/logs` | 98 ← è il rilievo `T12-F2` |
| warn | `/api/iscrizione/sedi` | 115 |

`/api/iscrizione/upload` è la porta da cui **le famiglie caricano il documento d'identità
del bambino**: 43 errori lì dentro sono famiglie che non ci sono riuscite. **Guarda quelli
per primi**, prima di costruire qualunque allarme.

Aperti in `G5`: `T12-F1` (nessuno legge `app_log`), `T12-F2` (gli errori del browser sono
attribuiti a `/api/logs`, non alla pagina dove sono successi — sono le 98 righe qui sopra),
`T20-F5` (nessun endpoint di salute: `src/app/api/health` non esiste), `T20-F2`, `T12-F3`,
`T12-F4`.

### G7 · Rilascio — una riga che chiude una classe intera

`T01-F2`: **`npm run build` NON è in CI** (`.github/workflows/ci.yml` esegue `npm run gate`,
che è solo `tsc && vitest`). È il buco che ha permesso a un commit di esistere per un giorno
senza che nessuno sapesse se compilava. **Costa una riga.**

Altri: `T01-F3` (`.nvmrc` dice 22, il locale è v24), `T03-F4` (**4 delle ultime 5 migrazioni
non dicono come si torna indietro**), `T03-F5`, `T19-F1`, `T19-F2`, `T19-F3`, `T20-F1`,
`T20-F3`, `T20-F4` (`migrate.yml` è in `waiting` dal 29 luglio su tutte le run: l'ambiente
`production` chiede un revisore).

### G4 · Prestazioni

- `T11-F4` `/api/admin/iscrizioni` restituisce **ogni** domanda, senza paginazione né tetto.
- `T11-F5` **4 pagine** chiamano `?limit=1000` senza offset: oltre i 1000 alunni la lista
  tronca in silenzio (`admin/students`, `admin/mensa`, `admin/students/sezioni/[id]`,
  `admin/protocolli`).
- `T11-F6` `student_parents` e `legame_genitori_alunni` hanno **1 solo indice ciascuna** (la
  chiave primaria): la colonna con cui vengono interrogate non è indicizzata. **Migrazione.**
- `T11-F3` `/api/parent/students` chiamata più volte a ogni apertura della home genitore.
- `T11-F1` (LCP), `T11-m2` (prefetch), `T11-m3` (logo a 3840 px per 208).

*(`T11-F2`, l'N+1 degli avvisi, è già chiuso: `src/lib/avvisi/statistiche.ts`.)*

### G6 · Notifiche — residuo

`T17-F4` (il digest si marca «inviata» a zero destinatari se la lettura delle email
fallisce) e `T17-F5` (**il digest arriva a tutte le famiglie senza modo di non riceverlo**).
*(`T17-F1/F2/F3` sono già chiusi.)*

### G8 · Interfaccia — 30 voci

Frontend, design, accessibilità, lingua. Fra le più concrete: `T08-F1` (classi di utility
Kidville che non esistono → il colore non viene mai applicato), `T09-F1` (il focus da
tastiera finisce sotto l'overlay di caricamento), `T10-F1`/`T10-F2` (con l'app in inglese
l'errore arriva dal server in italiano), `T13-F1` (l'E2E copre il 23% delle pagine),
`T13-F2` (un solo motore di rendering, mentre l'app iOS è WebKit).

## Vincoli d'ambiente — non aggirarli

- **`.env.local` punta al database di PRODUZIONE.** `npm run e2e` e `npm run e2e:seed` in
  locale sono vietati: il seed scriverebbe su produzione. L'E2E si verifica **in CI**.
- Sul DB di produzione, in questa fase, fai **solo `SELECT`**. Le migrazioni si applicano
  con lo strumento MCP `apply_migration` + `get_advisors` (0 ERROR), e **si mostrano
  all'utente prima di applicarle** — «mostrare non è chiedere», ma è l'unica cosa rimasta
  fra un errore e 152 minori.
- **Il repository è pubblico**: mai segreti, mai PII reali in codice, test, PRD o commit.
- Si lavora su un **branch secondario**, mai su `main`. Ogni modifica aggiorna il
  **PRD** (`PRD REGISTRO ELETTRONICO.md`, voce di changelog datata) e porta i propri **log**
  (`AGENTS.md`, sezione «Logging obbligatorio»: niente `console.*`, ogni route in
  `withRoute`, il corpo dell'errore di un provider non si butta via, un `catch` che non
  logga è un bug).

## Due trappole della CI che ti faranno perdere un'ora

1. **`npm ci` si rompe se rigeneri il lockfile su macOS.** `npm install <pacchetto>` e
   `npm audit fix` scrivono la voce del binario nativo locale (`@next/swc-darwin-*`) come
   oggetto **vuoto** senza `version`: `npm install` la tollera, `npm ci` muore con
   `npm error Invalid Version:` e la CI cade in 10 secondi su tutti i job. Rimedio:
   `rm -rf node_modules package-lock.json && npm install`, **poi verifica con `npm ci` in
   locale** prima di spingere.
2. **L'E2E gira su `next dev`**, quindi il primo ingresso su una rotta paga la
   compilazione. Se un test cade per timeout, **non allargarlo prima di aver provato che la
   pagina funziona**: scarica il trace con
   `gh api repos/erricoluigi17/kidville-web/actions/artifacts/<id>/zip`, guarda se le
   chiamate API sono 200 e se la snapshot finale contiene l'elemento atteso.

## Come si lavora, e come si dimostra che è fatto

Per ogni correzione: **test che fallisce → codice → test verde → prova di validità**.
La prova di validità è rimettere il difetto e verificare che un test **di comportamento**
torni rosso. Se resta verde, il test è finto e va riscritto.

Su 19 correzioni verificate adversarialmente in questo collaudo, **11 non hanno retto al
primo giro** e **oltre 20 test si sono rivelati finti**. Le cinque manomissioni che hanno
scoperto quasi tutto, da riusare:

1. la funzione **chiamata** e il verdetto **buttato via** (`void gate`) → il lock che cerca
   il *nome* resta verde, solo i test di comportamento cadono;
2. il controllo presente ma sull'**oggetto sbagliato** (la sede di chi opera invece di
   quella del media) → 2295 test rimasero verdi;
3. l'**ordine invertito** fra due operazioni che un commento dichiara ordinate;
4. un tetto portato a un estremo assurdo **mantenendo l'ordine relativo** (×10) → suite verde;
5. la fixture che usa **lo stesso valore per due grandezze diverse**: separale e guarda se cade.

**Un lock che cerca un nome è una rete a maglie larghe.** Ciò che tiene sono i test di
comportamento.

Gate prima di dire «fatto»: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` ·
`npx vitest run` · **`npm run build`** · E2E verde in CI.

## Ordine consigliato

1. **`T01-F2`** — `npm run build` in CI. Una riga, chiude una classe di guasto.
2. **`G5`** — partendo dai 43 errori su `/api/iscrizione/upload`: capire **perché** le
   famiglie non riescono a caricare, poi costruire l'allarme. Oggi in produzione non c'è
   nessun rilevatore che non sia una telefonata.
3. **`G4`** — gli indici sulle due tabelle ponte (migrazione) e la paginazione.
4. **`G6`** residuo, poi **`G7`**, poi **`G8`**.

Prima di cominciare: **fai l'intervista**. Chiedimi cosa vuoi dentro e cosa fuori, e dove
mi fermo (branch verde, merge, o merge + deploy). Non dare per scontato l'ambito.

## Tre cose che NON sono tue: sono decisioni del titolare

Non agire su queste senza una risposta esplicita in chat:

1. **`T06-F5`** — 93 famiglie hanno compilato il modulo fra il 16 e il 31 luglio **senza che
   venisse mostrata l'informativa**. Testo e query per i 119 indirizzi sono pronti e **NON
   inviati** in `docs/privacy/2026-08-03-informativa-tardiva-93-domande.md`.
2. **`V3`** — due decisioni del titolare a un giorno di distanza si contraddicono sulle
   stesse 93 domande: «nessuna retention» (2026-07-31, migrazione `20260731165941`) e
   «24 mesi» (2026-08-01, `retention-iscrizioni/route.ts`). Oggi il codice **non cancella**
   e lo dice con un `warn`. Serve che il titolare scelga.
3. **`kv-test-password.txt`** — la password degli account TEST di **produzione** è in chiaro
   in `.claude/.ship-cycle/` (fuori da git, ma unica copia su quella macchina).

## Una cosa chiusa a metà, che non va spacciata per chiusa

**`V5`**: la scrittura anonima con client service-role su `GET /api/iscrizione/model` è
tolta davvero. Il **tetto per IP no**: `src/lib/security/rate-limit.ts` è una `Map` in
memoria **per-istanza**, e su Vercel le richieste si distribuiscono — misurato in
produzione, 61 richieste consecutive senza un solo 429. Il file stesso lo dichiara («il
tetto esatto richiede uno store condiviso: resta da fare»). Vale per **tutte** le porte
pubbliche del repo (`public/cancellazione-account`, `forms/send-otp`, `iscrizione/model`).
Se vuoi un tetto vero, è un lavoro suo e va deciso.
