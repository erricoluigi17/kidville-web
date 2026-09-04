import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE, attendiFineCaricamento } from './fixtures';
import { sondaDom, type EsitoSonda } from './lib/sonda-contrasto';

/**
 * CRAWLER DI CONTRASTO — le schermate autenticate, nelle DUE modalità.
 *
 * ─── IL BUCO CHE CHIUDE ─────────────────────────────────────────────────────
 * Otto lock in jsdom sorvegliano il contrasto, ma su una LISTA CHIUSA di 23
 * componenti; e `axe` non calcola il contrasto senza layout (lo dichiara
 * `__tests__/a11y/smoke.axe.test.tsx:10`). Le pagine pubbliche sono state
 * misurate a mano una volta. Le schermate AUTENTICATE — genitore, docente,
 * segreteria — non le ha mai misurate nessuno: è lì che il 2026-09-04 sono
 * state trovate 1098 scritte a 2,27:1 e 81 utility grigie fuori dai token.
 *
 * ─── PERCHÉ GIRA DUE VOLTE ──────────────────────────────────────────────────
 * In Alto Contrasto i token NON si ribaltano nelle classi Tailwind: `@theme
 * inline` inlina l'hex. L'Alto Contrasto è dipinto superficie per superficie a
 * mano — ~141 regole in `globals.css` che agganciano 17 classi `kv-*` su 81
 * usate. La passata in `data-contrast="high"` non verifica che i token si
 * ribaltino: verifica **quali superfici sono coperte e quali no**. È l'unico
 * modo di saperlo, e nessun test in jsdom può farlo.
 *
 * ─── COME SI LEGGE UN ROSSO ─────────────────────────────────────────────────
 * I numeri della baseline sono ESATTI: se salgono hai peggiorato, se scendono
 * hai bonificato e devi scrivere il numero nuovo. Il credito non speso non si
 * accumula — è lo spazio in cui il difetto rientra restando verde, ed è già
 * successo in questo repo (`testo-muted-allowlist`, 73 occorrenze di slack).
 */

const BASELINE = path.resolve(__dirname, '../docs/superpowers/contrasto-schermate-baseline.json');

type Veste = keyof typeof STORAGE;
interface Rotta { rotta: string; storage: Veste; viewport: 'mobile' | 'desktop'; }

/**
 * Le rotte sono scelte per SUPERFICIE, non per funzione: interessa quali gusci,
 * card, tabelle e fasce di stato vanno in scena, non cosa fanno.
 * Il genitore si misura a 390×844 perché è una WebView su telefono: misurarlo a
 * 1440 sarebbe misurare uno schermo che non esiste.
 */
const ROTTE: Rotta[] = [
  { rotta: '/parent',              storage: 'genitore', viewport: 'mobile'  }, // AppBar, HeroCard, BottomNav
  { rotta: '/parent/pagamenti',    storage: 'genitore', viewport: 'mobile'  }, // fasce di stato e importi
  { rotta: '/parent/gallery',      storage: 'genitore', viewport: 'mobile'  }, // gradienti sulle foto: prova che i saltati si CONTANO
  { rotta: '/parent/modulistica',  storage: 'genitore', viewport: 'mobile'  }, // elenchi e campi
  { rotta: '/teacher',             storage: 'docente',  viewport: 'desktop' },
  { rotta: '/teacher/modulistica', storage: 'docente',  viewport: 'desktop' },
  { rotta: '/admin',               storage: 'admin',    viewport: 'desktop' }, // sidebar, topbar, KPI, grafici
  { rotta: '/admin/students',      storage: 'admin',    viewport: 'desktop' }, // StudentTable + StudentRowCard
  { rotta: '/admin/pagamenti',     storage: 'admin',    viewport: 'desktop' },
];

const VIEWPORT = { mobile: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;

interface VoceBaseline {
  rotta: string;
  nodiMinimi: number;
  normale: number;
  altoContrasto: number;
  saltati: { gradiente: number; composizione: number; fondoIgnoto: number };
}
interface Baseline { aggiornato: string; rotte: VoceBaseline[] }

const baseline: Baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const vocePer = (r: string) => baseline.rotte.find((v) => v.rotta === r);

/** Ricopiato da `src/lib/accessibility/cookie.ts` — gli spec non importano da `src/`. */
const CONTRAST_COOKIE = 'kv_contrast';

async function armaAltoContrasto(context: BrowserContext, baseURL: string) {
  await context.addCookies([{
    name: CONTRAST_COOKIE,
    value: 'high',
    domain: new URL(baseURL).hostname,
    path: '/',
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 31_536_000,
  }]);
}

async function misura(page: Page, url: string): Promise<EsitoSonda> {
  const risposta = await page.goto(url, { waitUntil: 'load' });
  expect(risposta?.ok(), `la rotta ${url} non ha risposto 2xx`).toBe(true);
  await attendiFineCaricamento(page);
  return page.evaluate(sondaDom, { autotest: false });
}

for (const { rotta, storage, viewport } of ROTTE) {
  test.describe(`contrasto · ${rotta} (${viewport})`, () => {
    test.use({ storageState: STORAGE[storage], viewport: VIEWPORT[viewport] });

    test(`${rotta} — modalità normale e Alto Contrasto`, async ({ page, context, baseURL }) => {
      const voce = vocePer(rotta);

      // ── passata 1: modalità normale ──────────────────────────────────────
      const normale = await misura(page, rotta);
      // ⚠️ In modalità normale l'attributo è ASSENTE, non "normal":
      // `layout.tsx` scrive `data-contrast={highContrast ? "high" : undefined}`.
      expect(await page.locator('html').getAttribute('data-contrast')).toBeNull();

      // ── passata 2: Alto Contrasto ────────────────────────────────────────
      await armaAltoContrasto(context, baseURL!);
      const alto = await misura(page, rotta);

      // Tre asserzioni di attivazione, non una: «una modalità mai vista attiva
      // non è testata». (1) l'SSR ha letto il cookie…
      expect(await page.locator('html').getAttribute('data-contrast')).toBe('high');
      // (2) …e il FOGLIO DI STILE è arrivato. Un attributo senza CSS è una
      // modalità finta, e sarebbe passata inosservata.
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
      // (3) le coppie misurate devono DIFFERIRE fra le due passate. Se fossero
      // identiche staremmo eseguendo due volte lo stesso test senza saperlo.
      const insieme = (e: EsitoSonda) => e.fallimenti.map((f) => f.firma).sort().join('\n');
      if (normale.fallimenti.length || alto.fallimenti.length) {
        expect(insieme(alto), 'le due modalità danno lo stesso identico esito: il cookie non sta facendo niente').not.toBe(insieme(normale));
      }

      // ── la sonda non è cieca ─────────────────────────────────────────────
      const minimi = voce?.nodiMinimi ?? 1;
      expect(normale.esaminati, `la pagina ha reso ${normale.esaminati} nodi di testo (attesi ≥ ${minimi}): non è pulita, è VUOTA`).toBeGreaterThanOrEqual(minimi);
      expect(alto.esaminati).toBeGreaterThanOrEqual(minimi);

      // ── confronto con la baseline ────────────────────────────────────────
      const misurato = {
        rotta,
        nodiMinimi: Math.min(normale.esaminati, alto.esaminati),
        normale: normale.fallimenti.length,
        altoContrasto: alto.fallimenti.length,
        saltati: normale.saltati,
      };
      if (!voce) {
        // Non si passa in silenzio: si FALLISCE stampando il JSON da incollare.
        // Una modalità «osserva e non può fallire» è decorazione, e resterebbe accesa.
        throw new Error(
          `Rotta non in baseline. Incolla questa voce in docs/superpowers/contrasto-schermate-baseline.json:\n` +
            JSON.stringify(misurato, null, 2) +
            `\n\nDettaglio normale:\n${normale.fallimenti.slice(0, 20).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n')}` +
            `\n\nDettaglio Alto Contrasto:\n${alto.fallimenti.slice(0, 20).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n')}`,
        );
      }
      const spiega = (e: EsitoSonda) => e.fallimenti.slice(0, 12).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n');
      expect(
        normale.fallimenti.length,
        `modalità NORMALE, ${rotta}: dichiarati ${voce.normale}, misurati ${normale.fallimenti.length}.\n` +
          `Se è SALITO hai aggiunto un contrasto sotto soglia. Se è SCESO hai bonificato: scrivi il numero nuovo, ` +
          `non lasciare credito non speso.\n${spiega(normale)}`,
      ).toBe(voce.normale);
      expect(
        alto.fallimenti.length,
        `ALTO CONTRASTO, ${rotta}: dichiarati ${voce.altoContrasto}, misurati ${alto.fallimenti.length}.\n` +
          `Qui un rosso quasi sempre significa che una superficie non ha la sua regola ` +
          `\`[data-contrast="high"]\` scritta a mano.\n${spiega(alto)}`,
      ).toBe(voce.altoContrasto);
      expect(
        normale.saltati,
        `Sfondi non calcolabili su ${rotta}: il numero è cambiato. Non è di per sé un difetto — un ` +
          `gradiente rende lo sfondo indecidibile — ma se una superficie prima misurata ora è saltata, ` +
          `il crawler ha smesso di guardarla e nessuno se ne accorgerebbe.`,
      ).toEqual(voce.saltati);
    });
  });
}

test.describe('contrasto · controllo positivo', () => {
  test.use({ storageState: STORAGE.genitore, viewport: VIEWPORT.mobile });

  /**
   * Gira A OGNI RUN, in CI. Inietta quattro sonde note nella pagina vera e
   * pretende che la sonda dia loro esiti DIVERSI: è la risposta al mock che
   * risponde uguale a tutto — difetto che in questo repo è già passato con
   * 13.254 test verdi.
   */
  test('la sonda distingue il sano dal rotto, e sa dire «non lo so»', async ({ page }) => {
    await page.goto('/parent', { waitUntil: 'load' });
    await attendiFineCaricamento(page);
    const esito = await page.evaluate(sondaDom, { autotest: true });
    const cp = esito.controlloPositivo!;
    expect(cp.sano, '#000 su #fff (21:1) non deve risultare rotto').toBe(1);
    expect(cp.rotti, '#BBB su #fff e un inchiostro semitrasparente devono risultare rotti').toBe(2);
    expect(cp.gradiente, 'il testo sotto un gradiente va SALTATO e contato, non segnalato e non ignorato').toBe(1);
    // …e la serializzazione della funzione regge: se si rompesse, `esaminati`
    // sarebbe 0 e questo test direbbe perché, invece di degradare in silenzio.
    expect(esito.esaminati, 'la sonda non ha esaminato nulla: probabile ReferenceError nella serializzazione').toBeGreaterThan(0);
  });
});
