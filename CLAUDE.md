@AGENTS.md

---

# Pipeline `/ship-cycle` — ciclo autonomo di rilascio

Si invoca con **`/ship-cycle <obiettivo>`**. Dopo il brainstorming e l'intervista iniziale gira da
sola — *pianifica → implementa → collauda → correggi* — finché tutti gli 11 tester non danno `PASS`,
o si ferma dopo 8 cicli. Il gate non è una promessa del modello: è cablato nell'hook `Stop`
(`.claude/hooks/verify_gate.sh`), che rilancia `eslint · tsc · vitest · build` a ogni tentativo di
fermarsi e blocca lo stop se qualcosa è rosso. Fuori da un `/ship-cycle` l'hook non fa nulla.

⚠️ **Costa molto**: 12 agenti su `claude-opus-5` a `effort: max`, fino a 8 cicli.

**Tutto il resto** — il diagramma del ciclo, la tabella dei 13 agenti, l'elenco dei file, i vincoli
d'ambiente che la pipeline rispetta (perché `npm run e2e` è in `deny` in locale, come si applicano le
migrazioni, il DB E2E della CI non migrato) — sta in **`.claude/commands/ship-cycle.md`**, che si
carica quando il comando parte.

Vie di fuga: `touch .claude/.ship-cycle/pausa` (l'hook smette di bloccare, resta armato) ·
`rm -rf .claude/.ship-cycle` (gate disarmato del tutto).

---

# «Tu sei il tester n. X» — kit di collaudo manuale in chat separate

Venti collaudi indipendenti, uno per chat, lanciati insieme. **Quando l'utente scrive «tu sei il
tester n. 7»** (o «tester 7», «sei il tester sette» — numeri da **01 a 20**): non fare domande e non
improvvisare. Apri `docs/collaudo/README.md`, poi `docs/collaudo/prompt/tester-07-*.md`, e segui
quel file alla lettera.

Le tre regole che non si derogano:

- **è un collaudo in sola lettura**: non si scrive codice, non si usa `git`, non si fa
  `npm install`, sul database di produzione si fanno **solo `SELECT`**, e nell'interfaccia si naviga
  senza salvare (il server locale `:3100` parla col DB di **produzione**);
- **le venti chat girano sullo stesso albero di lavoro**: un `git checkout` o un `npm install`
  sabota le altre diciannove. La suite intera e `npm run build` sono del tester 01, l'emulatore
  Android del 14, il simulatore iOS del 15;
- **un report solo, il proprio**, in `docs/collaudo/risultati/tester-NN-<slug>.md` — cartella esclusa
  da git perché può contenere estratti del DB di produzione. Mai dati personali, mai segreti:
  conteggi, uuid e codici d'errore.

`docs/collaudo/SINTESI.md` contiene il prompt che unisce i venti report in una lista unica di
difetti, deduplicata e ordinata, da cui parte la correzione.

---

# 🔴 IN PRODUZIONE CI SONO DATI REALI DI MINORI

La tabella `enrollment_submissions` contiene domande di iscrizione **vere**: codici fiscali di
minori, allergie e note mediche in testo libero. Il lancio commerciale non è avvenuto — **i dati
sono arrivati lo stesso**, e per due settimane questo file ha sostenuto il contrario perché nessuno
l'aveva più riletto da quando il modulo pubblico era andato online.

| | 31/07 | 04/08 | 20/08 | 02/09 | 04/09 | 19/09 |
|---|---|---|---|---|---|---|
| domande di iscrizione | 227 | 302 | 403 | 542 | 583 | **705** |
| codici fiscali distinti di minori | 152 | **324** | *non rimisurato* | 567 | *non rimisurato* | *non rimisurato* |

Sei misurazioni. Per tre volte di fila il ritmo di crescita era stato trovato **raddoppiato** rispetto
alla riga che lo stimava — ~6 al giorno, poi ~11, poi ~20 — e la lezione scritta qui era che invecchia
più in fretta la **stima di quanto in fretta invecchia**.

La misura del 19/09 rompe quella sequenza, e va detto invece di nasconderlo: 583 → 705 in quindici
giorni fa **~8 al giorno**, cioè *meno* della metà dell'ultima stima. Non è una smentita del
pericolo: è la prova che **il ritmo non si estrapola in nessuna delle due direzioni**, né verso l'alto
né verso il basso. L'unica cosa che vale è il conteggio del giorno in cui si legge. Mentre leggi, il
numero qui sopra è già vecchio.

**Non copiare quel 705. Contalo:**

```sql
SELECT count(*) FROM enrollment_submissions;
```

**Contare è una lettura, e le letture non chiedono mai conferma.** È la scrittura che si ferma a
chiedere — e quella query serve proprio a decidere se farla.

Le due caselle «non rimisurato» sono la parte onesta della tabella, e vanno lette invece che saltate:
contare le righe è lecito, *leggerle* è anagrafica di minori. Chi ha bisogno di quel numero usi un
`count(DISTINCT …)` eseguito dal database, che restituisce un intero e non trecento nomi. Scrivere lì
una stima sarebbe peggio del vuoto: è esattamente il modo in cui questo file è arrivato a dire il
falso per due settimane.

**Il repository è pubblico**: mai segreti, mai PII reali di famiglie o bambini in codice, test, PRD o
messaggi di commit.

## Permessi — stato al 2026-09-18

**Autonomia piena, e i prompt non arrivano più all'utente**: né in lettura né in scrittura, né sul
database di produzione, né su merge, `git push`, deploy o migrazioni. Le sessioni partono in
**`bypassPermissions`** (`permissions.defaultMode` in **`~/.claude/settings.json`**; quello di
progetto è stato **tolto** perché lo sovrascriveva), e i prompt che nessuna modalità auto-approva li
risolvono due hook committati: `.claude/hooks/auto_allow_permission.py` (evento `PermissionRequest`)
e `.claude/hooks/auto_approve_plan.py` (`PreToolUse` su `ExitPlanMode`, che **non** è più un punto di
controllo).

Restano accese le **22 regole `deny`** e **un solo** interruttore: `rm`/`rmdir` su percorsi critici —
radice, home, **la cartella di lavoro e i suoi genitori**. Vie di fuga per una sessione:
`KIDVILLE_PIANO_A_MANO=1` (riporta a mano l'approvazione del piano) ·
`KIDVILLE_AUTO_PERMESSI_ANCHE_RM=1` (toglie anche quell'ultimo prompt).

⚠️ Il blocco `autoMode` va in **`~/.claude/settings.json`**, mai in `.claude/settings.json`: ha scope
«User or managed», e da un file di progetto viene ignorato **in silenzio**. È stato nel posto
sbagliato per sedici giorni senza avere alcun effetto. Si verifica con `claude auto-mode config`,
non leggendo un paragrafo.

⚠️ Queste impostazioni si leggono all'**avvio**: dopo averle cambiate si riavvia **e si prova**.
*Una configurazione mai vista passare non è configurata.*

**Mostrare non è chiedere.** Non costa niente, ed è l'ultima cosa rimasta fra un errore e le famiglie
dietro quelle righe: chi sta per applicare una scrittura in produzione mostri prima l'istruzione.

📜 **Come ci si è arrivati** — i riquadri datati dal 31/07 al 18/09, con tutte le volte in cui questo
file ha detto il falso su sé stesso, i tre gate che sembravano armati e non lo erano, e le istruzioni
per tornare indietro: **`docs/storia-permessi-e-conferme.md`**.

---

Quando il lancio commerciale avverrà davvero, aggiorna anche il PRD.
