import { test, expect } from '@playwright/test';
import { EMAILS, login } from './fixtures';
import itSchede from '../messages/it/crmSchede.json';
import itAgenda from '../messages/it/crmAgenda.json';
import itFollowUp from '../messages/it/crmFollowUp.json';

// ─────────────────────────────────────────────────────────────────────────────
// CRM DELLA SEGRETERIA — la prova di fumo dal browser vero
//
// I test delle API e dei componenti provano permessi, sedi, collegamento e
// statistiche uno per uno, con finti. Qui si prova che i pezzi stanno insieme su
// un database vero (quello della CI, con la migrazione `crm_segreteria`
// applicata): la segreteria della sede E2E crea una famiglia, le fissa una
// visita, la segna svolta dall'agenda e ritrova nella scheda il primo richiamo
// che il server ha pianificato da solo. Se una delle sette tabelle, una route o
// il gate di sede si rompe, questa catena si ferma nel punto esatto.
//
// DATI: tutti finti e unici per ogni giro (nome e telefono con l'istante), così
// un giro fallito a metà non sporca il successivo: la scheda nuova non coincide
// con nessuna vecchia, e l'ora della visita cambia da un giro all'altro (il
// database vieta due visite `in_programma` sovrapposte per la stessa persona).
//
// Il Service Worker è bloccato: con la cache offline una risposta vecchia
// potrebbe mascherare quella vera.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ serviceWorkers: 'block' });

// La CI E2E gira su `next dev`: le pagine compilano a freddo.
const RENDER = 60_000;
const AZIONE = 20_000;

/** La persona che riceve la visita: la segreteria della sede 1 nel seed E2E. */
const PERSONA = 'Sara Segreteria-E2E';

/**
 * Il giorno della visita: oggi a Roma, oppure lunedì se oggi è domenica — l'agenda mostra da lunedì a sabato
 * e di domenica apre già la settimana dopo. Così la visita cade SEMPRE nella settimana che l'agenda apre.
 */
function giornoDellaVisita(): string {
  const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  const d = new Date(`${oggi}T12:00:00Z`);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const gg = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${gg}/${mm}/${d.getUTCFullYear()}`;
}

/** Un orario diverso a ogni giro, fra le 08:00 e le 17:55, a passi di 5 minuti. */
function oraDellaVisita(adesso: number): string {
  const ora = 8 + (Math.floor(adesso / 60_000) % 10);
  const minuti = (Math.floor(adesso / 1000) % 12) * 5;
  return `${String(ora).padStart(2, '0')}:${String(minuti).padStart(2, '0')}`;
}

test('la segreteria crea una famiglia, fissa la visita, la segna svolta e trova il primo richiamo', async ({ page }) => {
  test.setTimeout(240_000);
  const adesso = Date.now();
  const famiglia = `Famiglia CRM-E2E ${adesso}`;
  const telefono = `+39 3${String(adesso).slice(-9)}`;
  const ora = oraDellaVisita(adesso);

  await login(page, EMAILS.segreteria);
  await page.waitForURL('**/admin', { timeout: RENDER });

  // ── 1. La scheda nuova ──────────────────────────────────────────────────────
  await page.goto('/admin/crm?tab=schede');
  await expect(page.getByRole('heading', { name: itSchede.elencoTitolo })).toBeVisible({ timeout: RENDER });
  await page.getByRole('button', { name: itSchede.elencoNuovaFamiglia }).click();

  await page.getByLabel(itSchede.formGenitore, { exact: true }).fill(famiglia);
  await page.getByLabel(itSchede.formTelefono1, { exact: true }).fill(telefono);
  await page.getByLabel(itSchede.nuovaBambinoNome, { exact: true }).fill('Bimbo Prova');
  await page.getByRole('button', { name: itSchede.nuovaCrea }).click();

  // Creata, la scheda si apre da sola nel pannello di dettaglio: il pulsante «Fissa una visita» esiste solo lì.
  const fissa = page.getByRole('button', { name: itSchede.visiteFissa });
  await expect(fissa).toBeVisible({ timeout: AZIONE });
  await expect(page.getByText(itSchede.visiteNessuna)).toBeVisible();

  // ── 2. La visita ────────────────────────────────────────────────────────────
  await fissa.click();
  const dialogoFissa = page.getByRole('dialog', { name: itAgenda.fissaTitolo });
  await expect(dialogoFissa).toBeVisible({ timeout: AZIONE });
  const quando = dialogoFissa.getByRole('group', { name: itAgenda.quando });
  await quando.getByLabel(itAgenda.giorno, { exact: true }).fill(giornoDellaVisita());
  await quando.getByLabel(itAgenda.ora, { exact: true }).fill(ora);
  // Le persone arrivano da una fetch: si aspetta che l'opzione ci sia, poi si sceglie.
  await expect(dialogoFissa.getByRole('option', { name: PERSONA })).toBeAttached({ timeout: AZIONE });
  await dialogoFissa.getByLabel(itAgenda.persona, { exact: true }).selectOption({ label: PERSONA });
  await dialogoFissa.getByRole('button', { name: itAgenda.fissaConferma }).click();

  await expect(dialogoFissa).toBeHidden({ timeout: AZIONE });
  await expect(page.getByText(itSchede.visiteCon.replace('{nome}', PERSONA)).first()).toBeVisible({ timeout: AZIONE });

  // ── 3. Svolta, dall'agenda ──────────────────────────────────────────────────
  await page.goto('/admin/crm?tab=agenda');
  await expect(page.getByRole('heading', { name: itAgenda.titolo })).toBeVisible({ timeout: RENDER });
  const aria = (azione: string) =>
    itAgenda.azioneAria.replace('{azione}', azione).replace('{famiglia}', famiglia).replace('{ora}', ora);
  const svolta = page.getByRole('button', { name: aria(itAgenda.azioneSvolto), exact: true });
  await expect(svolta).toBeVisible({ timeout: AZIONE });
  await svolta.click();

  const dialogoSvolta = page.getByRole('dialog', { name: itAgenda.svoltoTitolo });
  await expect(dialogoSvolta).toBeVisible({ timeout: AZIONE });
  // «Svolta da» propone chi riceveva la visita.
  await expect(dialogoSvolta.getByLabel(itAgenda.svoltoDa, { exact: true })).not.toHaveValue('');
  await dialogoSvolta.getByRole('button', { name: itAgenda.svoltoConferma }).click();
  await expect(dialogoSvolta).toBeHidden({ timeout: AZIONE });

  // Chiusa, la visita non offre più «Svolta»; resta il nome della famiglia per aprirne la scheda.
  const apri = page.getByRole('button', { name: itAgenda.apriScheda.replace('{famiglia}', famiglia), exact: true });
  await expect(apri).toBeVisible({ timeout: AZIONE });
  await expect(svolta).toHaveCount(0);

  // ── 4. Il primo richiamo, pianificato dal server ───────────────────────────
  await apri.click();
  await expect(page.getByText(itFollowUp.tipo_follow_up_1).first()).toBeVisible({ timeout: AZIONE });
});
