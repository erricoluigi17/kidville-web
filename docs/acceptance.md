# Checklist di accettazione — GATE FINALE WEB (M9.8)

Piano "app 100%" (`docs/piano-app-100.md`), branch `feat/app-completion`.
Eseguita il 2026-07-03 a chiusura della milestone M9. Ogni voce è stata
verificata con il comando indicato sull'albero del commit finale.

## Gate tecnici

- [x] **TypeScript**: `npx tsc --noEmit` → 0 errori
- [x] **Lint a zero (repo intero)**: `npx eslint . --max-warnings 0` → exit 0
      (include `src`, `supabase`, `__tests__`, `scripts`, `e2e`,
      `playwright.config.ts`, `public/sw.js`; storico in `docs/lint-baseline.md`)
- [x] **Unit/integration**: `npx vitest run` → 667 test / 113 file, 0 failed
- [x] **Build di produzione**: `npm run build` → ok, 243 pagine
- [x] **E2E**: `npm run e2e` (seed idempotente + Playwright) → 31/31 verdi
      su 16 spec (auth, role-routing, parent ×3, teacher ×4, admin ×5,
      iscrizione pubblica, chat) — verificati anche fuori orario chat
      (banner attivo)

## Qualità trasversale (M9)

- [x] Hotspot lib tipizzati (`persist-submission`, `media/processing`; `offline/db` già a zero)
- [x] Edge functions senza `@ts-ignore`/`any` (document-expiry-alert, locker-reminder)
- [x] Sweep lint a zero in 4 batch per directory (commit `lint(sweep 1..4)`)
- [x] Gap auth pre-esistenti (segnalati in M3) chiusi su 11 route + 16 test di
      regressione (`__tests__/api/auth-gaps-m9.test.ts`)
- [x] `/api/me` dedup: 1 `getUser` + 2 query parallele (lock nel test)
- [x] jsPDF/xlsx on-demand nei 4 siti client; export verificati in dev con
      download reali (spec Playwright temporanea, poi rimossa)
- [x] Loghi/mascotte su `next/image` a resa identica (bounding box misurati in
      dev: 28/18/152/144 px); media utente restano `<img>` con disable motivato
- [x] React.memo: skip documentato con criteri di riapertura (`docs/perf-notes.md`)
- [x] Docs finali: README (integrazioni gated SIDI/Aruba/Resend/VAPID/Claude) +
      `docs/env.md` aggiornato

## Fuori dal gate web (tracciati, non bloccanti)

- [x] **Backfill DB produzione**: 63 presenze storiche con `scuola_id NULL`
      (10 anche senza `section_id`) — APPLICATO il 2026-07-03 previa conferma
      esplicita del committente (`scripts/backfill_presenze_scuola.mjs --apply`,
      verifica post: 0 righe residue)
- [ ] Verifica live SDI (gated su credenziali Aruba del committente)
- [ ] Egress reale SIDI/Piattaforma Unica (gated su accreditamento ministeriale)
- [ ] Email reali (gated su `RESEND_API_KEY`), push reali (gated su chiavi VAPID)
- [ ] pg_cron solleciti (rinviato: regola cron da definire col committente)

## M10 — App native Capacitor (gate finale, 2026-07-04)

Milestone finale del piano app-100. Gate M10.7 verificato sull'albero del commit
di chiusura:

- [x] **Gate web invariato**: `tsc` 0 · `eslint . --max-warnings 0` exit 0 ·
      `vitest run` 752/752 (123 file) · `next build` ok · `npm run e2e` 31/31
      (l'app web NON regredisce: Capacitor è una shell addizionale)
- [x] **Progetti nativi committati**: `ios/` (SPM, `App.xcodeproj`) e `android/`
      con icone/splash generate dal logo (`@capacitor/assets`), `npx cap sync`
      pulito (3 plugin: app, push-notifications, status-bar)
- [x] **Build locali reali**: Android `assembleDebug` (JDK 21) → APK ~7,2 MB;
      iOS `xcodebuild -sdk iphonesimulator` → BUILD SUCCEEDED (vedi `docs/mobile.md`)
- [x] **Push native gated**: token nativi registrati (`platform` su
      `push_subscriptions`, migr. 20260766); invio FCM/APNs con degrado pulito
      (`fcm_non_configurato`) senza credenziali
- [x] **Adattamenti webview senza cambi visivi web**: safe-area, StatusBar, back
      button Android, deep link `kidville://` — tutti gated su `.cap-native`/
      `isNativeApp()`, mai attivi nel browser

### Gated su credenziali/account esterni (M10)

- [ ] Pubblicazione App Store (account Apple Developer) e Google Play (Play Console)
- [ ] Invio push reale FCM/APNs (progetto Firebase + `FCM_*`)
- [ ] URL HTTPS pubblico per `CAP_SERVER_URL` di produzione (dipende dal deploy)

Con M10 il piano **"app 100%" è completo (M0…M10)**: web app al 100% + app native
iOS/Android pronte, con la sola pubblicazione store subordinata agli account esterni.
