import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

/**
 * Il modulo dell'assenza si può TOCCARE dove lo si vede.
 *
 * ─── PERCHÉ QUESTO SPEC ESISTE ──────────────────────────────────────────────
 * Due collaudi di fila hanno trovato la stessa classe di difetto su questa
 * schermata, e nessun test del repo poteva vederla: il piede appiccicato che
 * porta il comando si SOLLEVA sopra il contenuto che lo precede, e ciò che
 * finisce là sotto resta visibile a metà ma non è più toccabile — il dito
 * atterra su quello che sta sopra.
 *
 *  · R19 (quinto collaudo): il link «Leggi l'informativa» era coperto dal
 *    pulsante. `adb shell input tap` sul link non apriva l'informativa: faceva
 *    partire la comunicazione dell'assenza. Un genitore che vuole capire come
 *    trattiamo un dato sanitario di suo figlio, invece, lo conferiva.
 *  · Subito dopo, la stessa cosa sul campo «Motivo».
 *
 * Nessuna delle due era visibile ai test unitari: jsdom non fa layout, quindi
 * «chi c'è sotto questo punto» è una domanda che si può porre solo a un browser
 * vero. Ed è l'unica domanda che conta — non «l'elemento esiste», non «è nel
 * DOM»: **chi riceve il tocco al centro di ciò che l'utente vede**.
 *
 * ─── COSA PRETENDE, E COSA NO ───────────────────────────────────────────────
 * Pretende che nessun elemento del modulo sia VISIBILE-MA-NON-TOCCABILE. Un
 * elemento del tutto coperto non è un difetto di questa famiglia: l'utente non
 * lo vede, scorre, e lo raggiunge — è il comportamento normale di un modulo più
 * lungo dello schermo. Misurato a 390×640 dopo la correzione del 2026-08-08: il
 * campo «Motivo» è coperto al 100% (zero pixel visibili), e lì non c'è inganno.
 * A 390×731 e 390×844 è scoperto e toccabile.
 */

test.use({ storageState: STORAGE.genitore });

/** Il centro di un elemento: chi lo riceve, il dito? */
async function chiRiceveIlTocco(page: import('@playwright/test').Page, selettore: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { esiste: false as const };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { esiste: true as const, reso: false as const };
    const sopra = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const piede = document.querySelector('.kv-piede-azione')?.getBoundingClientRect();
    // Quanti pixel dell'elemento sono davvero scoperti, in verticale.
    const scoperti = piede ? Math.max(0, Math.min(r.bottom, piede.top) - r.top) : Math.round(r.height);
    return {
      esiste: true as const,
      reso: true as const,
      suoi: sopra === el || el.contains(sopra),
      scoperti: Math.round(scoperti),
      altezza: Math.round(r.height),
      riceve: sopra ? `${sopra.tagName}:${(sopra.textContent ?? '').trim().slice(0, 30)}` : 'niente',
    };
  }, selettore);
}

// 731: iPhone «grande» in CSS px. 844: iPhone 14/15. Le due misure su cui il
// quinto collaudo ha fotografato il difetto.
for (const altezza of [731, 844]) {
  test(`390×${altezza}: link e campo del modulo assenza ricevono il proprio tocco`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: altezza });
    await page.goto('/parent/attendance');

    // POSITIVO prima del negativo: senza, tutto ciò che segue sarebbe verde su
    // una pagina che non ha caricato.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('textarea')).toBeVisible({ timeout: 20_000 });

    const link = await chiRiceveIlTocco(page, 'a[href="/privacy"]');
    expect(link.esiste, 'il link all’informativa è sparito dal modulo').toBe(true);
    expect(
      link,
      'il link «Leggi l’informativa» non riceve il proprio tocco: è coperto, e il dito finisce ' +
        `su «${'riceve' in link ? link.riceve : '?'}». È R19: il tocco sul link ESEGUE L'INVIO ` +
        'invece di aprire l’informativa, su un dato sanitario di un minore.',
    ).toMatchObject({ suoi: true });

    const campo = await chiRiceveIlTocco(page, 'textarea');
    expect(campo.esiste).toBe(true);
    if ('scoperti' in campo && (campo.scoperti ?? 0) > 0) {
      // Visibile: allora deve essere toccabile. Il caso vietato è «se ne vede un
      // pezzo e il dito va altrove».
      expect(
        campo,
        `del campo «Motivo» si vedono ${campo.scoperti}px su ${campo.altezza}, ma il tocco al ` +
          `centro finisce su «${campo.riceve}»: è visibile e non toccabile, che è la forma ` +
          'peggiore — l’utente crede di scrivere e invece preme un comando.',
      ).toMatchObject({ suoi: true });
    }
  });
}
