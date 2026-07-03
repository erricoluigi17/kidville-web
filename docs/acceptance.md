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

Con i gate tecnici sopra tutti verdi, la **web app è completa al 100%** rispetto
al piano: si passa a M10 (app native Capacitor).
