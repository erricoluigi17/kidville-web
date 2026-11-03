import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Chat genitore↔maestra: nuova conversazione, messaggio, allegato immagine,
// e verifica lato docente. Il seed azzera i thread E2E a ogni run.

/**
 * ⚠️ IL TRACE ANCHE DEL PRIMO TENTATIVO, e serve per una ragione precisa.
 *
 * `playwright.config.ts` usa `trace: 'on-first-retry'`, che è la scelta giusta per
 * la suite: i trace pesano e i retry bastano quasi sempre. Qui no. Il fallimento di
 * questa spec si manifesta **al primo tentativo** — arriva all'allegato e il
 * messaggio non compare — mentre nei retry il test muore molto prima, sul click del
 * contatto: a quel punto una conversazione con la maestra ESISTE già (il seed non
 * si rifà fra un tentativo e l'altro), quindi la modale «Nuova Chat» è vuota e
 * `getByText('Dora Docente-E2E').first()` risolve sulla riga della LISTA, che sta
 * sotto la tendina della modale e non si può cliccare.
 *
 * Conseguenza: il trace conservato descrive un tentativo in cui l'upload non è mai
 * partito — verificato, zero `setInputFiles` in tutto il file — e del fallimento
 * vero non resta nessuna traccia di rete. `retain-on-failure` conserva anche il
 * primo, ed è l'unico modo per vedere la risposta della POST dell'allegato senza
 * eseguire l'E2E in locale (che è in `deny`: il seed scriverebbe sul database di
 * produzione).
 *
 * Si toglie quando il difetto è chiuso: è uno strumento di diagnosi, non un presidio.
 */
test.use({ trace: 'retain-on-failure' });

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * ⚠️ IL TETTO DI 30 s NON BASTAVA, ED È MISURATO — non una precauzione.
 *
 * La CI E2E gira su `next dev` (vedi `playwright.config.ts`): questa è la PRIMA
 * spec a colpire `/parent/chat`, `/api/chat/contacts`, `/api/chat/threads` e
 * `/api/chat/messages`, che compilano A FREDDO. Il tetto per test di Playwright,
 * qui non dichiarato, era quello di default: **30 secondi**.
 *
 * Le misure, dallo storico della CI:
 *   · su `main`, tre run verdi di fila: **15,6 s · 14,2 s · 18,4 s**;
 *   · sul ramo che ha introdotto il gate di abbinamento
 *     (`@/lib/chat/rubrica`, un modulo NUOVO nel grafo di due route):
 *     **29,2 s · 30,4 s · 30,0 s**, cioè il tetto, tre volte su tre.
 *
 * E i tre fallimenti non erano lo stesso: uno alla riga dell'allegato, due sul
 * `click` del contatto. **Non era un'asserzione a cadere: era il budget a
 * finire**, e cadeva dove capitava. Un test che fallisce in punti diversi a
 * ogni giro sta dicendo «sono lento», non «il prodotto è rotto».
 *
 * Il rimedio è lo stesso già scritto — con la stessa motivazione — in testa a
 * `e2e/teacher-attendance.spec.ts`, che a questo problema era già arrivato: un
 * tetto esplicito e generoso, che NON cambia una sola asserzione. Il lavoro vero
 * (leggere solo ciò che serve nel gate) è stato fatto in `rubrica.ts`; questo è
 * il margine per il cold-compile, che non dipende da noi.
 */
test.describe('lato genitore', () => {
  test.use({ storageState: STORAGE.genitore });

  test('nuova chat con la maestra: messaggio + allegato', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const pngPath = testInfo.outputPath('allegato.png');
    writeFileSync(pngPath, PNG_1PX);

    await page.goto('/parent/chat');
    await expect(page.getByRole('heading', { name: 'Messaggi' })).toBeVisible({
      timeout: 15_000,
    });

    // Contatto = maestra della sezione della figlia (utenti_sezioni).
    await page.getByRole('button', { name: 'Nuova Chat' }).click();
    const contatto = page.getByText('Dora Docente-E2E').first();
    await expect(contatto).toBeVisible({ timeout: 15_000 });

    // ── E CHI NON DEVE COMPARIRE, NON COMPARE ────────────────────────────────
    //
    // «Quando clicchi su nuova chat, non devono proprio comparire le altre
    // persone.» Fino al 2026-09-07 non era vero: un fallback consegnava al
    // genitore TUTTI i docenti di TUTTE le sedi appena un figlio non aveva
    // sezione — misurato in produzione, 63 nomi di 5 plessi, 9 dei quali
    // disattivati. `Diana Docente2-E2E` insegna in SEDE 2: è la controprova che
    // il filtro c'è, e va PRIMA del click perché dopo la modale si chiude.
    //
    // ⚠️ È un'asserzione NEGATIVA e va guardata con sospetto: passerebbe anche
    // con la modale vuota. Per questo la riga sopra pretende che la maestra
    // GIUSTA sia visibile — le due insieme dicono «queste sì, quelle no».
    await expect(page.getByText('Diana Docente2-E2E')).toHaveCount(0);

    await contatto.click();

    // Messaggio di testo.
    const input = page.getByPlaceholder(/Scrivi un messaggio/).first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('Ciao maestra! Messaggio E2E.');
    await page.getByRole('button', { name: 'Invia messaggio' }).first().click();
    // Il testo compare anche nella preview del thread: basta la prima occorrenza.
    await expect(page.getByText('Ciao maestra! Messaggio E2E.').first()).toBeVisible();

    // Allegato immagine: input file nascosto → chip di anteprima → invio.
    await page.locator('input[type="file"]').first().setInputFiles(pngPath);
    // Chip di anteprima (emoji e nome sono nodi separati: match sul nome).
    await expect(page.getByText('allegato.png').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Invia messaggio' }).first().click();
    // Messaggio-allegato inviato: testo "📎 Allegato" nel thread e <img>
    // dell'immagine nel DOM (il PNG di test 1×1 ha box a dimensione zero,
    // quindi niente toBeVisible sull'immagine stessa).
    await expect(page.getByText('📎 Allegato').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByAltText('Allegato').first()).toBeAttached();

    // ── LA FOTO SI APRE A TUTTO SCHERMO (2026-11-03) ─────────────────────────
    //
    // Fino a ieri toccare la miniatura non faceva niente. Ora è un pulsante («Apri la foto a
    // tutto schermo») che apre `VisoreFotoChat`: un dialogo a tutto schermo con «Scarica» (e,
    // per il genitore, «Condividi»).
    //
    // `.first()` sul pulsante regge perché `ChatMessageArea` è montata DUE volte (pannello
    // desktop `hidden md:flex` e conversazione mobile `md:hidden`) ma `getByRole` NON vede
    // l'elemento nascosto con `display: none`: a 1280 px resta solo la miniatura del desktop,
    // a un telefono solo quella del mobile. Mai due visibili insieme, quindi `.first()` non può
    // cadere su quella sbagliata (e il tocco apre comunque un visore solo).
    //
    // ⚠️ `dispatchEvent('click')` E NON `click()`, ed è la stessa ragione del `toBeAttached` che
    // sta sull'immagine poche righe sopra: il PNG di test 1×1 può avere un box VUOTO, e il
    // pulsante-miniatura contiene solo quell'immagine, quindi ne erediterebbe il box vuoto. Un
    // `click()` fa i controlli di azionabilità di Playwright (visibile, stabile, riceve gli
    // eventi) e su un box vuoto scadrebbe in CI: il titolare si troverebbe la CI rossa per la
    // dimensione di una fixture, non per un difetto del prodotto. `getByRole` non scarta
    // l'elemento per la sola dimensione zero (lo scarta se è nascosto con `display: none`,
    // `visibility` o `aria-hidden`), quindi qui basta aspettare che il pulsante sia ALLEGATO al
    // DOM e consegnargli l'evento. Il vero tocco di un utente (mouse, Tab + Invio/Spazio) lo
    // coprono i test di unità (`chat-visore-foto`); questo E2E prova l'integrazione: pulsante →
    // dialogo con «Scarica» → Escape lo chiude.
    const apriLaFoto = page.getByRole('button', { name: 'Apri la foto a tutto schermo' }).first();
    await expect(apriLaFoto).toBeAttached({ timeout: 15_000 });
    await apriLaFoto.dispatchEvent('click');

    // Il dialogo si cerca per NOME («Foto 1 di 1 della conversazione»), non per solo ruolo:
    // `getByRole('dialog')` nudo fallirebbe in modalità stretta alla prima altra finestra di
    // dialogo che la pagina dovesse avere (un avviso, un consenso), e il test direbbe «due
    // elementi» invece di «il visore non si è aperto». Il nome è quello che il visore dà da sé
    // (`chatFotoConversazione`), mai il nome del mittente.
    const visore = page.getByRole('dialog', { name: /della conversazione/ });
    await expect(visore).toBeVisible({ timeout: 15_000 });
    await expect(visore.getByRole('button', { name: /Scarica/i })).toBeVisible();

    // «Condividi» NON si asserisce: Chromium headless su Linux non condivide file
    // (`navigator.canShare({ files })` è falso) e in quel caso il pulsante non compare, per
    // scelta del progetto. Qui si prova ciò che c'è su qualunque browser: aprire e poter
    // scaricare. Condividi lo coprono i test di unità (`condividi-media`, `useAzioniMedia`).

    // Escape chiude il visore e la conversazione resta lì.
    await page.keyboard.press('Escape');
    await expect(visore).toBeHidden();
  });
});

test.describe('lato docente', () => {
  test.use({ storageState: STORAGE.docente });

  test('la maestra vede la conversazione e il messaggio', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/teacher/chat');
    await expect(page.getByText('Messaggi con le famiglie')).toBeVisible({ timeout: 15_000 });

    const thread = page.getByText('Gaia Genitore-E2E').first();
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await thread.click();

    await expect(page.getByText('Ciao maestra! Messaggio E2E.').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
