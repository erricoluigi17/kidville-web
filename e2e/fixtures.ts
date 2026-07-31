import path from 'node:path';
import type { Page } from '@playwright/test';

// Deve restare allineato a scripts/seed-e2e.mjs (UUID fissi, credenziali).

/**
 * La password dei 4 account del seed E2E arriva dall'AMBIENTE, mai dal repo.
 * Copia TypeScript di `e2e/lib/e2e-password.mjs` (la testata di quel file spiega
 * perché un letterale qui è costato due sedi di produzione); la duplicazione è la
 * stessa già adottata in `e2e/primaria-360/config/accounts.ts`, perché gli spec
 * Playwright non importano moduli `.mjs` dello stesso repo.
 *
 * Fail-closed: senza variabile si fallisce SUBITO, con il messaggio che dice cosa
 * esportare — invece di sbattere più avanti contro un login che non riesce.
 */
function requireE2EPassword(): string {
  const valore = (process.env.KV_E2E_PASSWORD || '').trim();
  if (!valore) {
    throw new Error(
      "Manca la variabile d'ambiente KV_E2E_PASSWORD: è la password dei 4 account del seed E2E " +
        '(*.e2e@kidville.test) e NON è scritta nel repo. In locale prendila dal gestore di credenziali ' +
        "del titolare ed esportala prima di rilanciare:  export KV_E2E_PASSWORD='…'  — in CI arriva " +
        'dal secret GitHub CI_E2E_PASSWORD.',
    );
  }
  return valore;
}

export const PASSWORD = requireE2EPassword();

export const EMAILS = {
  admin: 'admin.e2e@kidville.test',
  docente: 'docente.e2e@kidville.test',
  genitore: 'genitore.e2e@kidville.test',
  doppio: 'doppio.e2e@kidville.test',
};

export const IDS = {
  SCUOLA: 'e2e00000-0000-4000-8000-000000000001',
  SEC_GIRASOLI: 'e2e00000-0000-4000-8000-000000000011',
  A1: 'e2e00000-0000-4000-8000-000000000101', // Aurora Arcobaleno-E2E
  A2: 'e2e00000-0000-4000-8000-000000000102', // Bruno Baleno-E2E
  ADMIN: 'e2e00000-0000-4000-8000-000000000201',
  DOCENTE: 'e2e00000-0000-4000-8000-000000000202',
  GENITORE: 'e2e00000-0000-4000-8000-000000000203',
};

export const STORAGE = {
  admin: path.join(__dirname, '.auth', 'admin.json'),
  docente: path.join(__dirname, '.auth', 'docente.json'),
  genitore: path.join(__dirname, '.auth', 'genitore.json'),
};

// Login dalla UI reale (/auth/login): sessione Supabase via cookie, niente header.
export async function login(page: Page, email: string, password: string = PASSWORD) {
  await page.goto('/auth/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Accedi' }).click();
}
