# Prompt atomico — Implementazione C5

> Da incollare in una **nuova chat** aperta su `/Users/lerri/kidville-web`.
> Autosufficiente: non presuppone nulla della conversazione precedente.

---

```
Implementa il punto C5 della submission su Google Play. La specifica completa,
già decisa e approvata dal titolare, è in docs/submission/C5-sviluppo-obbligatorio.md:
LEGGILA PER INTERA PRIMA DI SCRIVERE CODICE. Leggi anche AGENTS.md e CLAUDE.md, che
sono le regole di progetto e vanno rispettate tutte.

PERCHÉ ESISTE QUESTO LAVORO
Sono due requisiti della User Data policy e della UGC policy di Google Play che oggi
non sono soddisfatti. Senza, l'app NON è pubblicabile su Play. Non è rifinitura: è
sviluppo che blocca il rilascio.

═══════════════════════════════════════════════════════════════════
PARTE 1 — Pagina pubblica di cancellazione account
═══════════════════════════════════════════════════════════════════
Google richiede DUE percorsi di cancellazione: uno in-app (esiste già:
/parent/profilo → POST /api/parent/account/richiesta-cancellazione) e uno via
risorsa WEB pubblica. Il secondo non esiste.

ATTENZIONE: docs/store-submission.md §3 suggeriva di indicare /assistenza. È SBAGLIATO
e l'ho già corretto in quel file: /assistenza non nomina mai la cancellazione.

Da fare:
- nuova rotta pubblica /cancellazione-account (server component, come /privacy e /termini)
- aggiungerla a PUBLIC_PREFIXES in src/lib/auth/middleware-rules.ts
- riusare il testo già esistente in messages/it/profilo.json → chiave `eliminaSpiegazione`
  (copre già prerequisiti e retention per obbligo di legge: è esattamente ciò che
  Google chiede). Versione EN in messages/en/
- la pagina deve: caricarsi senza errori; avere il percorso di cancellazione PROMINENTE;
  riportare il nome dell'app come appare sulla scheda; permettere di AVVIARE la richiesta
  senza login e senza rimandare all'app; esplicitare prerequisiti e retention

VINCOLO DI SICUREZZA — non negoziabile:
la pagina NON deve cancellare nulla. Deve REGISTRARE UNA RICHIESTA che la Direzione
evade, esattamente come fa oggi il percorso in-app. La conferma passa da una email di
verifica prima che la richiesta diventi lavorabile. È una pagina pubblica: senza questo
è una superficie d'attacco per cancellare l'account altrui.

═══════════════════════════════════════════════════════════════════
PARTE 2 — Segnalazione, sospensione conversazione, gate dei Termini
═══════════════════════════════════════════════════════════════════

CONTESTO VERIFICATO NEL CODICE (non ipotizzarlo diversamente):
- src/app/api/chat/contacts/route.ts: il docente scrive SOLO ai genitori degli alunni
  della sua sezione; il genitore SOLO alle maestre della sezione dei suoi figli
- genitore ↔ genitore NON esiste
- la galleria: l'upload passa da requireDocente, i genitori guardano soltanto
- la conversazione è identificata da ${parent.id}:${student.id} — è legata a UN BAMBINO

2a — SEGNALAZIONE (richiesta dalla UGC policy)
- segnalare un CONTENUTO (messaggio in chat, media in galleria, voce di diario)
- segnalare un UTENTE
- entrambe «readily accessible» e «clearly labeled»: devono essere raggiungibili senza
  cercarle, con un'etichetta esplicita
- le segnalazioni arrivano alla Direzione

2b — SOSPENSIONE DELLA CONVERSAZIONE — decisione già presa dal titolare, NON riaprirla
Menu ⋮ della conversazione → «Sospendi conversazione» → conferma + motivo (facoltativo)

  EFFETTO IMMEDIATO
    • l'altra parte non può più scrivere in quella conversazione
    • chi sospende non riceve più messaggi né notifiche da lì
    • l'altra parte vede «Conversazione sospesa»   ← DICHIARATO, non silenzioso
    • la DIREZIONE riceve una notifica e può mediare

  RESTA ATTIVO (sono canali diversi dalla chat, e devono continuare a funzionare)
    ✓ avvisi e circolari   ✓ giustifiche   ✓ diario   ✓ galleria   ✓ push della scuola

  RIAPERTURA: da chi ha sospeso in qualsiasi momento, oppure dalla Direzione

  SIMMETRICO: funziona identico se è la maestra a sospendere verso un genitore

  VINCOLI:
  - la sospensione è PER CONVERSAZIONE (${parent.id}:${student.id}), NON per utente.
    Un genitore con due figli in sezioni diverse sospende un rapporto, non tutta la scuola
  - la notifica alla Direzione passa dal Centro Notifiche ESISTENTE (nuovo tipo di evento
    col suo toggle), non da un canale nuovo
  - il MOTIVO è testo libero scritto da un genitore su un rapporto con una maestra:
    va REDATTO nei log (@/lib/logging/redact), MAI in chiaro. Vale la regola 8 di AGENTS.md

2c — GATE DEI TERMINI (richiesto dalla UGC policy)
Accettazione dei Termini NON SALTABILE prima che l'utente carichi o invii UGC.
Avere /termini raggiungibile dal menu NON soddisfa il requisito.

Oggi in /parent/onboarding la casella copre SOLO la privacy: il POST manda
{ consensi: { privacy } } e i Termini non li accetta nessuno.

Da fare: aggiungere i Termini alla casella di accettazione, e REGISTRARE DATA E VERSIONE
del testo accettato in parents.consensi_gdpr.
⚠️ Questo chiude anche la «lacuna E» di docs/submission/A3-dossier-legale.md: senza
accettazione, la clausola di limitazione di responsabilità dei Termini non produce effetto
(art. 1341 c.c. e artt. 33-36 Codice del Consumo). Non è solo compliance Google.

═══════════════════════════════════════════════════════════════════
REGOLE DI PROGETTO — tutte obbligatorie
═══════════════════════════════════════════════════════════════════
- Branch secondario, MAI su main. Il branch corrente è feat/dossier-submission:
  continua lì (AGENTS.md punto 1 + memoria «branch_workflow_rule»)
- Ogni route API nasce avvolta in withRoute('gruppo/route:METODO', …) — c'è un lock
  che fallisce se un export HTTP resta nudo
- Validazione zod su ogni route (lock zod-coverage)
- MAI console.* in src/ — si usa @/lib/logging/logger (logOk, logErrore, logEvento)
- PostgREST NON lancia: ritorna { error }. Un try/catch attorno a await supabase.from(…)
  non scatta mai. Controlla SEMPRE il valore di ritorno
- Un catch che non logga è un bug
- MAI dati personali nei log: la redazione è a lista bianca
- Migrazioni con lo strumento MCP apply_migration + get_advisors (0 ERROR)
- i18n: l'app è BILINGUE it/en, next-intl con cataloghi per-namespace
  messages/<loc>/<ns>.json. Ogni stringa nuova va in ENTRAMBE le lingue
- utenti.role è una colonna GENERATA da ruolo: non scriverla mai
- TDD: test prima dell'implementazione
- Il PRD «PRD REGISTRO ELETTRONICO.md» va aggiornato nello stesso lavoro
- Il repository è privato ma NON metterci mai segreti né PII reali di famiglie o bambini

GATE — devono essere tutti verdi prima di dire «fatto»:
  npx eslint . --max-warnings 0
  npx tsc --noEmit          ← la CI lo fa sui __tests__; build e vitest locali NON lo colgono
  npx vitest run
  npm run build
⚠️ NON lanciare npm run e2e in locale: .env.local punta al DB di PRODUZIONE e il seed
   scriverebbe lì dentro. L'E2E si verifica in CI.

═══════════════════════════════════════════════════════════════════
COSA NON TOCCARE
═══════════════════════════════════════════════════════════════════
- il grafo dei contatti della chat: è corretto così
- il gate delle foto in src/lib/gallery/privacy.ts (blocca le foto di gruppo se un solo
  bambino taggato non ha la liberatoria): funziona, non va riscritto
- allowBackup="false" e la configurazione di backup Android
- minifyEnabled false: R8 romperebbe i plugin Capacitor in silenzio
- la logica di oblio GDPR esistente in src/lib/gdpr/esegui.ts

═══════════════════════════════════════════════════════════════════
CRITERI DI ACCETTAZIONE
═══════════════════════════════════════════════════════════════════
1. /cancellazione-account raggiungibile SENZA login, in it e en, e registra una richiesta
   con verifica via email — senza cancellare nulla direttamente
2. Segnalazione contenuto e segnalazione utente disponibili e chiaramente etichettate
3. Sospensione conversazione funzionante nei due versi, con notifica alla Direzione,
   riapribile, per conversazione e non per utente
4. Avvisi, giustifiche, diario, galleria e push continuano a funzionare a conversazione
   sospesa — con un test che lo dimostra
5. Onboarding: senza accettare i Termini non si prosegue; data e versione registrate
6. Il motivo della sospensione NON compare in chiaro in app_log — con un test che lo dimostra
7. Migrazione applicata, get_advisors 0 ERROR
8. Gate verde: eslint 0, tsc 0, vitest tutti verdi, build ok
9. PRD aggiornato

Alla fine fammi un riepilogo di cosa hai fatto, cosa hai deciso da solo e cosa è rimasto
aperto. Se durante il lavoro trovi che una delle specifiche qui sopra è sbagliata o
impossibile, FERMATI e dimmelo invece di aggirarla.
```
