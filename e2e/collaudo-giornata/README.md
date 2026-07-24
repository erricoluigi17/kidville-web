# Collaudo «Giornata simulata» — infra di esecuzione

Campagna E2E multi-ruolo eseguita da **agenti LLM che impersonano utenti reali**, contro
**produzione** (`https://app.kidville.it`, sede Kidville Giugliano), su account/sezioni **solo TEST**.
Piano di riferimento: `~/.claude/plans/prompt-atomico-zazzy-forest.md`.

## Principi

- **Ambiente**: tutto prod. Web (segreteria/direzione) via Chrome MCP; docenti/genitori via **Maestro**
  su emulatore Android + simulatore iOS (app con `CAP_SERVER_URL=https://app.kidville.it`).
- **Isolamento**: solo `*@kidville.test`, sezioni **TEST 1A** (`bb4e9f8a-…`) e **TEST Infanzia**
  (`219cab6a-…`). Ogni dato scritto porta il tag **`[E2E-GIORNATA]`** + data del run. Mai toccare
  l'admin reale né dati non-TEST.
- **Oracoli**: UI (screenshot) **+** DB (SQL read-only via Supabase MCP). OTP firme via MCP
  `kidville-mail` (Gmail `+tag`). Nessun «PASS» senza evidenza.

## Struttura

```
config/personas.mjs   cast (account reali, device, ruolo, scenario, inbox OTP)
config/data.mjs       ID sezioni/alunni TEST, modulo gita, quote, TAG
config/oracoli.mjs    query SQL read-only per dominio (oracolo DB)
seed/seed-giornata.mjs  seed idempotente [E2E-GIORNATA] (opzionali, legami, delegati, gita, quote)
briefs/*.md           brief per-agente: identità · passi (azione→dato→atteso→oracolo) · divieti
lib/state.mjs         handshake cross-ruolo (run/state.json)
report/build-report.mjs  findings/*.json + screenshot → run/report-giornata.html
run/                  (gitignored) findings, screenshots, state
```

## Esecuzione (fasi)

0. **Setup**: `node seed/seed-giornata.mjs` (seed prod) · avvio emulatore Android + install APK prod ·
   verifica app iOS su prod · login di ogni persona.
1. **Ondata 0-1 → 8**: gli agenti girano per ondata con barriere di sincronizzazione (§6.2 del piano).
2. **Report**: `node report/build-report.mjs` → `run/report-giornata.html`.
3. **Cleanup**: rimozione record `[E2E-GIORNATA]`; revoca sospensioni moroso di test.
