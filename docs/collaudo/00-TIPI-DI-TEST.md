# I tipi di collaudo che si fanno prima di mandare in produzione

> Ricerca del 2026-08-03 · vale per Kidville Web (Next.js + Supabase + app nativa Capacitor)
> Le fonti esterne sono in fondo. La colonna **Tester** rimanda ai prompt in `prompt/`.

Questo documento serve a due cose: elencare **tutti** i tipi di test che l'industria fa prima di un
rilascio, e dire **quali di questi Kidville copre già da solo** e quali invece richiedono un essere
umano (o un agente) che li esegua a mano. La seconda parte è quella che conta: un gate verde non
significa "collaudato", significa "nessuno dei controlli che sappiamo automatizzare è rosso".

---

## 0. La distinzione che regge tutto il resto

| | Cosa risponde | Esempio |
|---|---|---|
| **Verifica** (*verification*) | "il software è costruito bene?" | i test passano, il tipo è corretto, il lint è pulito |
| **Validazione** (*validation*) | "è il software giusto?" | un genitore riesce davvero a giustificare un'assenza |

Il gate automatico di questo repo (`eslint` · `tsc` · `vitest` · `build` · E2E in CI) è quasi tutto
**verifica**. I 20 tester del kit esistono per fare la **validazione**, più quella parte di verifica
che nessun test unitario può fare (il browser vero, il telefono vero, il database vero).

---

## 1. Test funzionali, per livello (la piramide)

| Tipo | Cosa isola | Chi lo fa qui | Tester |
|---|---|---|---|
| **Unit test** | una funzione/classe sola, dipendenze finte | `vitest`, automatico | 01 |
| **Component test** | un componente UI montato, senza rete | `vitest` + testing-library | 01 · 07 |
| **Integration test** | più moduli insieme (route + validazione + DB) | parzialmente `vitest` | 02 |
| **Contract test** | il contratto fra chi chiama e chi risponde (forma della risposta, codici HTTP) | **scoperto** — lo fa il tester 02 a mano | 02 |
| **System / E2E test** | l'applicazione intera, dal browser al database | Playwright in CI | 13 |

La piramide dice: molti unit, meno integration, pochissimi E2E. Il rischio che porta è che il vertice
sia **così** piccolo da non toccare mai i percorsi che gli utenti fanno davvero. Il tester 13 verifica
proprio questo: quali percorsi critici **non** hanno un E2E.

---

## 2. Test funzionali, per intento

| Tipo | Quando | Cosa cerca | Tester |
|---|---|---|---|
| **Smoke test** (o *build verification*) | subito dopo ogni build/deploy, dura minuti | "si accende?" — home, login, una pagina per area | 01 · 20 |
| **Sanity test** | dopo una correzione mirata | "quella cosa lì ora funziona?" | 19 |
| **Regression test** | prima di ogni rilascio | "ho rotto qualcosa che prima andava?" | 19 |
| **Visual regression** | quando cambia la UI | differenze di pixel/layout non volute | 08 |
| **Acceptance / UAT** | prima del sì finale | i criteri di accettazione del piano sono soddisfatti | 24 → confluito in 19 |
| **Exploratory test** | sempre, in parallelo | quello che nessuno ha pensato di scrivere in un caso di test | 07 · 18 |
| **Negative / boundary test** | sui form e sulle API | input vuoti, limiti, formati sbagliati, valori estremi | 02 |
| **Data migration test** | quando cambia lo schema | i dati vecchi sopravvivono alla migrazione | 03 |
| **Backward compatibility** | sempre, qui in particolare | il codice nuovo deve degradare bene sul DB **non** migrato della CI (`PGRST204`, `42703`) | 03 · 19 |

---

## 3. Test non funzionali

### 3.1 Prestazioni
| Variante | Domanda | Tester |
|---|---|---|
| **Load test** | regge il carico atteso? | 11 |
| **Stress test** | dove si rompe? | 11 (fuori scopo su prod) |
| **Spike test** | regge un picco improvviso? | 11 |
| **Soak / endurance** | dopo 8 ore perde memoria? | 11 |
| **Volume test** | regge con 10.000 righe invece di 100? | 11 |
| **Core Web Vitals** | l'utente *percepisce* lentezza? | 11 |

Soglie "buone" al 75° percentile del traffico reale: **LCP < 2,5 s · INP < 200 ms · CLS < 0,1**.

### 3.2 Sicurezza
| Tipo | Cosa fa | Tester |
|---|---|---|
| **SAST** | analisi statica del codice | 04 |
| **DAST** | attacco all'applicazione in esecuzione | 04 |
| **SCA / dependency scan** | librerie con CVE note (`npm audit`) | 01 |
| **Secret scanning** | chiavi e password finite nel repo (qui è **pubblico**) | 04 |
| **AuthN / AuthZ** | chi entra e cosa può fare: bypass, escalation di ruolo, IDOR | 04 |
| **Tenant isolation** | un utente di una sede vede i dati di un'altra? | **05** |
| **Injection** | SQL, XSS, template, header | 04 · 18 |
| **Security headers** | CSP, HSTS, X-Frame-Options, cookie flags | 04 |
| **Penetration test** | un umano che ci prova sul serio | fuori kit |

### 3.3 Conformità e privacy
Dato che in produzione ci sono **dati reali di minori**, questa non è una casella da spuntare: è la
categoria a rischio più alto. Comprende minimizzazione dei dati, base giuridica e consensi,
retention, diritto all'oblio, cosa finisce nei **log** (i log sono un archivio di dati personali a
tutti gli effetti: mai nomi/email/CF in chiaro, solo identificativi pseudonimizzati), e chi ha
accesso a cosa. → Tester **06**.

### 3.4 Le altre qualità
| Tipo | Cosa verifica | Tester |
|---|---|---|
| **Accessibilità** | WCAG 2.2 AA: contrasto ≥ 4,5:1, tastiera, focus visibile, screen reader, target ≥ 24px | 09 |
| **Usabilità** | l'utente capisce cosa fare senza spiegazioni | 07 |
| **Compatibilità** | Chromium / WebKit / Firefox, iOS e Android, viewport da 320px in su | 07 · 14 · 15 |
| **Localizzazione (L10n)** | testi, date, valute, layout che regge le stringhe lunghe | 10 |
| **Internazionalizzazione (i18n)** | chiavi mancanti, testo cablato non traducibile | 10 |
| **Osservabilità** | se si rompe in produzione, me ne accorgo? Il log dice *perché*? | 12 |
| **Resilienza / chaos** | il provider esterno cade, la rete è lenta: cosa vede l'utente? | 16 |
| **Offline / PWA** | service worker, cache, degradazione senza rete | 16 |
| **SEO / metadata** | title, description, Open Graph, sitemap, robots | 18 |

---

## 4. Test del *processo* di rilascio

Sono i controlli che non riguardano il codice ma il modo in cui il codice arriva agli utenti. È la
famiglia che si dimentica più spesso, ed è quella che produce i guasti più lunghi da spegnere.

| Tipo | Domanda | Tester |
|---|---|---|
| **Parità di ambiente** | le variabili d'ambiente di produzione ci sono **tutte** e sono giuste? | 20 |
| **Migrazioni + rollback** | la migrazione gira su un DB pieno? E se va male, come torno indietro? | 03 · 20 |
| **Piano di rollback** | esiste, ed è stato **provato**? | 20 |
| **Feature flag** | posso spegnere la funzione nuova senza un nuovo deploy? | 20 |
| **Canary / rollout graduale** | la espongo all'1% prima che al 100%? | 20 |
| **Smoke post-deploy** | i minuti dopo il rilascio: le rotte critiche rispondono 200? | 20 |
| **Monitoraggio sintetico + allarmi** | qualcuno mi sveglia se cade, o lo scopro dai genitori? | 12 · 20 |
| **Backup / restore** | il backup esiste ed è stato **ripristinato** almeno una volta? | 20 |

Il punto ricorrente in tutte le fonti: uno *smoke test* post-deploy dura minuti e valida la tecnica;
un *canary* dura ore o giorni e valida gli utenti veri. Servono entrambi, non sono alternativi.

---

## 5. Test specifici del mobile e degli store

Oltre a tutto quello sopra, un'app nativa ha una lista sua: installazione da zero **e aggiornamento
da versione precedente**, permessi (fotocamera, notifiche, biometria), ciclo di vita
background/foreground, notifiche push in ambiente **production** (non solo sandbox), offline, rete
2G, batteria, e la conformità alle policy dello store — che nel 2026 respinge soprattutto per
**dichiarazioni privacy incomplete**: App Privacy label lato Apple, sezione Data Safety lato Google.
Per un'app che tratta dati di minori valgono in più i requisiti CSAE (contenuti e segnalazione
in-app) e, in UE, gli obblighi informativi DSA. → Tester **14** (Android) e **15** (iOS).

---

## 6. Test dei contenuti (post, news, comunicati)

Se ciò che va in produzione è **un contenuto** e non solo codice, i controlli sono altri e si fanno
lo stesso: sanificazione dell'HTML dell'editor (XSS stored), embed di terze parti che possono
sparire o rallentare la pagina, anteprima Open Graph, testo alternativo delle immagini, peso delle
immagini, link rotti, refusi, data e fuso di pubblicazione, resa dell'email digest nei client, e —
se il contenuto è generato dagli utenti — moderazione e segnalazione. → Tester **18**.

---

## 7. Cosa il gate automatico di Kidville copre già, e cosa no

| Coperto dall'automatico | Scoperto: serve un tester |
|---|---|
| lint, tipi, unit/component test, build | contratti API, casi limite dei form |
| lock architetturali (`zod-coverage`, `logging-coverage`) | isolamento fra sedi su dati **veri** |
| E2E Playwright dei percorsi principali (in CI) | accessibilità reale, screen reader |
| — | prestazioni percepite, Core Web Vitals |
| — | privacy: cosa finisce davvero nei log di produzione |
| — | app nativa su telefono/simulatore |
| — | offline, provider esterni caduti |
| — | parità delle variabili d'ambiente, rollback, monitoraggio |
| — | contenuti: sanificazione, embed, anteprime |

**La regola pratica**: se un difetto è già capitato qui ed è passato col gate verde, quella
categoria va collaudata a mano. È successo con le email (403 loggato senza corpo), con
l'isolamento fra sedi (3424 test verdi, falle aperte), con la biometria Android (loop infinito, zero
test rossi). Tutte e tre stanno in questa colonna di destra.

---

## 8. Mappa: tipo di test → tester

| # | Tester | Copre |
|---|---|---|
| 01 | Gate formale e catena di build | lint, tipi, unit, build, SCA, peso del bundle, smoke |
| 02 | Backend e contratti API | integrazione, contratto, negativo/limiti, gate di ruolo, zod |
| 03 | Database e migrazioni | migrazione dati, retro-compatibilità, indici, advisor, rollback schema |
| 04 | Sicurezza applicativa | SAST, DAST, secret scanning, authn/authz, IDOR, injection, header |
| 05 | Isolamento fra sedi | multi-tenancy: il test che qui ha già trovato falle vere |
| 06 | Privacy e GDPR minori | minimizzazione, consensi, retention, oblio, PII nei log |
| 07 | Frontend e compatibilità | rendering, hydration, stati, console, responsive, cross-browser |
| 08 | Design system | token, coerenza visiva, regressione visiva |
| 09 | Accessibilità | WCAG 2.2 AA |
| 10 | Localizzazione | i18n/L10n, date, valute, tenuta del layout |
| 11 | Prestazioni | Core Web Vitals, query lente, carico, volume |
| 12 | Osservabilità | log, allarmi, tracciabilità di un guasto |
| 13 | E2E percorsi critici | system test, copertura dei percorsi utente |
| 14 | Mobile Android | installazione/aggiornamento, permessi, push, offline, policy Play |
| 15 | Mobile iOS | idem + App Privacy label, TestFlight |
| 16 | Offline e resilienza | service worker, provider caduti, rete lenta, retry |
| 17 | Notifiche ed email | push production, email transazionali, deliverability, resa |
| 18 | Contenuti e SEO | sanificazione, embed, OG, moderazione UGC, link rotti |
| 19 | Regressione sul diff | cosa è cambiato e cosa può essersi rotto, retro-compatibilità |
| 20 | Prontezza al rilascio | env parity, rollback, canary, smoke post-deploy, backup |

---

## Fonti

- [Deployment Testing Guide: From Staging to Production (2026) — TestGrid](https://testgrid.io/blog/deployment-testing/)
- [Web Application Testing Checklist 2026 — Testomat](https://testomat.io/blog/complete-web-application-testing-checklist/)
- [Best Practices for QA Release Readiness — Frugal Testing](https://www.frugaltesting.com/blog/best-practices-for-qa-release-readiness-a-complete-pre-launch-testing-guide)
- [30+ Types of Software Testing — TestGrid](https://testgrid.io/blog/types-of-software-testing/)
- [Types of Software Testing: A Complete Classification — QASphere](https://qasphere.com/blog/types-of-software-testing/2/)
- [Production Readiness Review — Google SRE Book](https://sre.google/sre-book/evolving-sre-engagement-model/)
- [Production readiness checklist — Port](https://www.port.io/blog/production-readiness-checklist-ensuring-smooth-deployments)
- [Production readiness checklist for dependable releases — DX](https://getdx.com/blog/production-readiness-checklist/)
- [Canary release vs smoke testing — Unleash](https://www.getunleash.io/blog/canary-release-vs-smoke-test)
- [8 Types of Deployment Strategies — Flagsmith](https://www.flagsmith.com/blog/deployment-strategies)
- [WCAG 2.2 Checklist: Complete 2026 Compliance Guide — Level Access](https://www.levelaccess.com/blog/wcag-2-2-aa-summary-and-checklist-for-website-owners/)
- [The Ultimate WCAG Accessibility Checklist — BrowserStack](https://www.browserstack.com/guide/wcag-compliance-checklist)
- [Core Web Vitals 2026: INP, LCP & CLS Thresholds](https://webhelpagency.com/blog/core-web-vitals-2026/)
- [How the Core Web Vitals thresholds were defined — web.dev](https://web.dev/articles/defining-core-web-vitals-thresholds)
- [The Complete First-Time App Review Guide for 2026 — Capgo](https://capgo.app/blog/first-time-app-review-guide/)
- [Google Play Store Submission Checklist 2026 — AppLaunchFlow](https://www.applaunchflow.com/blog/google-play-store-submission-checklist-2026)
- [GDPR Log Management: A Practical Guide for Engineers — Last9](https://last9.io/blog/gdpr-log-management/)
- [GDPR Logging and Monitoring (2026) — Konfirmity](https://www.konfirmity.com/blog/gdpr-logging-and-monitoring)
