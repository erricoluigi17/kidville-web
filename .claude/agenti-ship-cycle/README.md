# Gli undici tester di `/ship-cycle` — in deposito, non cancellati

Questi agenti **non sono in `.claude/agents/`**, e quindi **non compaiono nell'elenco degli agenti
disponibili**. È deliberato: l'elenco entra nel contesto **a ogni sessione**, anche quando la
pipeline non gira, e gli undici tester costavano ~1.800 token al giorno per un comando che non si
usa più da settimane.

## 🔴 Finché stanno qui, `/ship-cycle` NON funziona

Il comando li invoca per nome. Con questa cartella in deposito il ciclo parte, pianifica, implementa
— e poi non trova nessun tester da lanciare. **Prima di riaccendere la pipeline, rimettili al loro
posto:**

```bash
git mv .claude/agenti-ship-cycle/tester-opus-*.md .claude/agents/
```

E poi **riavvia la sessione**: l'elenco degli agenti si costruisce all'avvio. Per rimetterli in
deposito, lo stesso comando al contrario.

## Cosa è rimasto in `.claude/agents/`

`esecutore-opus` e `scrittore-di-piani`: due descrizioni brevi, utili anche fuori dalla pipeline
(implementare gli step di un piano, scrivere un piano). Sono ~150 token, e si tengono.

## Cosa NON è cambiato

- I permessi in `.claude/settings.json` (`Agent(tester-opus-…)`) sono rimasti: sono inerti finché gli
  agenti sono qui, e tornano validi appena li rimetti in `.claude/agents/`.
- L'hook del gate `.claude/hooks/verify_gate.sh` non legge questi file: legge
  `.claude/.ship-cycle/report-testers.json`, cioè i verdetti, non le definizioni.
- Il corpo degli agenti è intatto: nessuna riga tolta, solo la cartella cambiata.

## Perché non sono stati cancellati

Contengono il metodo di collaudo di undici categorie — backend, frontend, design, debug, mobile
Android e iOS, log, sicurezza, privacy, localizzazione, accessibilità — scritto una riga alla volta
sui difetti veri di questo progetto. Non è materiale che si riscrive a memoria.
