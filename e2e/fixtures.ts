import path from 'node:path';
import type { Page } from '@playwright/test';

// Deve restare allineato a scripts/seed-e2e.mjs (UUID fissi, credenziali).
export const PASSWORD = 'KidvilleE2E.2026!';

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
  await page.getByRole('button', { name: 'Entra' }).click();
}
