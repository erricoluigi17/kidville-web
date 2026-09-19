import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { ALL_ACCOUNTS, PASSWORD, AUTH_DIR, RUN_DIR, storagePath, idsPath } from './config/accounts';

// Login UI reale per i 16 account di test (sessione Supabase via cookie +
// identità applicativa in localStorage). Salva storageState per riuso e
// risolve l'appId (da /api/me) per il deep-link ?userId= sulle pagine profonde.

// ─── 🔴 LO STATO DI UN RUN MUORE COL RUN ─────────────────────────────────────
//
// `run/state.json` è la staffetta fra i journey (id dell'avviso gita, thread
// chat, alunni col ticket). Non ha scadenza e nessuno lo cancellava: questa
// config NON ha `globalSetup` (playwright.primaria360.config.ts:3) e in tutto
// `primaria-360/` non esisteva un solo `rmSync`. Un id rimasto lì da un run di
// due mesi prima è TRUTHY, e un id truthy fa passare l'unica asserzione dura di
// `30-genitori` (`expect(avvisoId).toBeTruthy()`) mentre le dieci adesioni
// vanno su un avviso morto: contatore a zero, rilievi tutti `gravita:'grave'`
// (che non fanno cadere niente) e journey VERDE avendo collaudato zero. È la
// forma esatta della data cablata, rientrata dalla porta accanto — e basta
// lanciare `30-genitori` da solo, cioè come si fa quando si itera, oppure far
// morire `20-docenti` prima della riga che scrive l'id.
//
// Si cancella QUI perché questo è l'unico file che gira SEMPRE per primo: il
// progetto `journeys` lo ha come `dependencies`, anche quando si esegue un solo
// journey con `-g`. Così un id residuo non può esistere, e `toBeTruthy()`
// diventa una misura vera invece di una formalità. Il `?? null` scritto da
// `20-docenti` resta come seconda rete per il caso «pubblicazione fallita
// dentro lo stesso run».
setup('login account TEST 1A (26 personas)', async ({ browser }) => {
  setup.setTimeout(360_000); // 26 login reali sequenziali
  fs.rmSync(path.join(RUN_DIR, 'state.json'), { force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const ids: Record<string, string> = {};

  for (const acc of ALL_ACCOUNTS) {
    const ctx = await browser.newContext({ locale: 'it-IT', timezoneId: 'Europe/Rome' });
    const page = await ctx.newPage();
    await page.goto('/auth/login');
    await page.locator('#email').fill(acc.email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Accedi' }).click();

    // Profilo singolo per tutti gli account di test → nessun picker; attende il landing.
    await expect(page).toHaveURL(acc.landing, { timeout: 30_000 });

    // appId applicativo (utenti.id / parents.id) per il deep-link ?userId=.
    const me = await page.evaluate(async () => {
      try { const r = await fetch('/api/me'); return r.ok ? await r.json() : null; } catch { return null; }
    });
    if (me?.id) ids[acc.key] = String(me.id);

    await ctx.storageState({ path: storagePath(acc.key) });
    await ctx.close();
    // eslint-disable-next-line no-console
    console.log(`  ✓ login ${acc.key} (${acc.email})${me?.id ? ' appId ' + String(me.id).slice(0, 8) : ''}`);
  }

  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));
  expect(Object.keys(ids).length).toBeGreaterThanOrEqual(10);
});
