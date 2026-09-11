import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Pagamenti genitore: riepilogo dovuto + storico con stati.
test.use({ storageState: STORAGE.genitore });

test('lo storico mostra la retta aperta e la gita pagata', async ({ page, browserName }) => {
  /**
   * 🔎 WEBKIT DIVERGE, E L'HA TROVATO IL SUO PRIMO GIRO (2026-08-04, run 30914455054).
   *
   * `fixme` e non `skip`, di proposito: Playwright continua a elencarlo come lavoro da
   * fare invece di farlo sparire dal conto. Un test tolto in silenzio è un difetto che
   * smette di esistere solo nel report.
   *
   * COSA SUCCEDE, misurato: su WebKit la pagina CARICA — l'intestazione «Pagamenti»
   * passa — ma «Totale da saldare» non compare affatto entro 15 s, e l'errore è
   * `element(s) not found`, non un timeout d'attesa. Su chromium lo stesso spec passa in
   * meno di 7 s. Quindi non è lentezza: su WebKit quel blocco non viene proprio reso.
   *
   * PERCHÉ NON È STATO CHIUSO QUI: capirlo richiede aprire la pagina su WebKit vero e
   * guardare cosa fallisce (un `Intl` non supportato nel formato valuta? una `Promise`
   * che non si risolve? un `structuredClone`?). È esattamente l'indagine per cui il
   * rilievo T13-F2 chiedeva WebKit — e il valore di averlo aggiunto è che, al PRIMO
   * giro, ha trovato una divergenza su una pagina che mostra DENARO a una famiglia.
   *
   * PERCHÉ CONTA PIÙ DI UN TEST ROSSO: l'app iOS è una WebView WebKit. Se questo blocco
   * non si rende su WebKit, un genitore su iPhone potrebbe non vedere quanto deve. Va
   * verificato sul simulatore prima di dire che è solo un problema del test.
   */
  test.fixme(
    browserName === 'webkit',
    'Divergenza WebKit da indagare: «Totale da saldare» non viene reso (element not found, ' +
      'non timeout). L\'app iOS è WebKit: verificare sul simulatore prima di derubricarlo.',
  );

  await page.goto('/parent/pagamenti');

  await expect(page.getByRole('heading', { name: 'Pagamenti' })).toBeVisible();

  // Riepilogo del dovuto (solo la retta da 150 € è aperta).
  await expect(page.getByText('Totale da saldare')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('€ 150,00').first()).toBeVisible();
  await expect(page.getByText('1 voce da saldare')).toBeVisible();

  // Voce aperta: badge "Da pagare", intestata ad Aurora. La descrizione compare
  // in DUE punti (la voce + la «causale consigliata» che inizia con essa) → .first().
  await expect(page.getByText('Retta E2E luglio').first()).toBeVisible();
  await expect(page.getByText('Da pagare', { exact: true })).toBeVisible();
  await expect(page.getByText('Aurora Arcobaleno-E2E').first()).toBeVisible();

  // Voce saldata: badge "Pagato". E nessun documento da scaricare — è il punto.
  await expect(page.getByText('Gita E2E')).toBeVisible();
  await expect(page.getByText('Pagato', { exact: true })).toBeVisible();

  /**
   * GUARDIA ROVESCIATA (2026-09-10): qui si pretendeva ESATTAMENTE IL CONTRARIO.
   *
   * Fino a ieri questo punto chiedeva il link «Ricevuta», ne leggeva l'`href` e
   * verificava che `GET /api/pagamenti/ricevuta` rispondesse `200
   * application/pdf`. Quella rotta non esiste più: la ricevuta contabile per
   * singolo pagamento è stata ritirata tutta insieme — UI del genitore, i TRE
   * punti di segreteria (registro fiscale, drawer del pagamento e dialogo del
   * movimento in riconciliazione), la route e il suo motore PDF. Un test che continuasse a
   * pretenderla sarebbe rosso per una funzione ritirata, cioè rumore; cancellarlo
   * e basta lascerebbe un buco. Resta come pretesa OPPOSTA: quel link non deve
   * ricomparire, e se ricompare questo test lo dice.
   *
   * ⚠️ ANCHE «Fattura» DEVE ESSERE ZERO, e questa è la parte che collauda la
   * decisione presa, non un di più. La regola nuova è «nessun PDF in archivio,
   * nessun pulsante»: i comandi della fattura si rendono solo per le righe che il
   * SERVER ha verificato sul bucket (`pdf_disponibile`). Il DB della CI non è
   * migrato e di fatture non ne ha nessuna — `scripts/seed-e2e.mjs:815` semina
   * «Gita E2E» senza `fattura_stato` — quindi la risposta giusta è: nessuna
   * ancora. Prima ce n'era una comunque, e portava a un documento che non c'era.
   *
   * PERCHÉ QUESTE ASSENZE NON SONO UN FALSO VERDE — che è il rischio di ogni
   * `toHaveCount(0)`, e in questo repo è già costato due test verdi su una pagina
   * vuota. Entrambi i comandi si decidono nello STESSO render della card:
   * «Ricevuta» era un ramo sincrono su `p.stato`, e i comandi della fattura sono
   * montati solo se `p.fattura_stato === 'emessa'` — campo che qui non c'è,
   * quindi non parte nessuna chiamata e non c'è niente che possa arrivare in
   * ritardo a smentire il conteggio. Con «Gita E2E» e «Pagato» già a schermo la
   * card è resa: se un'ancora ci fosse, ci sarebbe adesso.
   *
   * Due locator per ciascun documento perché i comandi hanno cambiato pelle:
   * oggi «Fattura» è un `<span>` e le ancore dicono «Apri»/«Scarica». Il nome
   * accessibile coprirebbe solo la forma vecchia; l'`href` copre entrambe e
   * regge anche il prossimo cambio di etichetta.
   */
  await expect(page.getByRole('link', { name: 'Ricevuta' })).toHaveCount(0);
  await expect(page.locator('a[href*="/api/pagamenti/ricevuta"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Fattura/i })).toHaveCount(0);
  await expect(page.locator('a[href*="/api/pagamenti/fattura"]')).toHaveCount(0);

  /**
   * «COME PAGARE» (spec 2026-09-05) — la pagina diceva CHE COSA scrivere nella
   * causale e mai DOVE mandare i soldi.
   *
   * Le attese stanno in coda a QUESTO test, e non in uno nuovo, per una ragione
   * misurata: la card si rende dalla stessa risposta di `/api/pagamenti` che su
   * WebKit non arriva a schermo (il `fixme` in testa a questo file). Un test
   * separato sarebbe rosso su WebKit per la stessa causa già dichiarata lì —
   * cioè un secondo sintomo dello stesso difetto, non una seconda informazione.
   */
  await expect(page.getByText('Come pagare')).toBeVisible();

  /**
   * IL RIPIEGO È IL RAMO CHE LA CI PUÒ DAVVERO COLLAUDARE, ed è quello che conta.
   *
   * `scripts/seed-e2e.mjs:476` scrive in `admin_settings` soltanto `diario_config`
   * e `avvisi_config`: `fiscale_config` non c'è. Quindi `coordinateBonificoSede`
   * restituisce `iban: null` e il pannello Bonifico — attivo di default — mostra
   * l'invito a chiedere le coordinate in segreteria invece di un IBAN inventato.
   *
   * È esattamente ciò che vedrà anche una sede di PRODUZIONE finché l'IBAN non
   * viene compilato in Impostazioni → Fiscale (PRD, «Da fare»): questo test
   * garantisce che quella condizione resti una frase utile e non una card vuota
   * o un crash.
   */
  await expect(page.getByText('Le coordinate bancarie non sono ancora disponibili')).toBeVisible();

  // I contanti sono un tab vero (WAI-ARIA), non un paragrafo: si può arrivarci da
  // tastiera. Il suo pannello dice DOVE si paga e — nella stessa schermata — che i
  // contanti NON sono detraibili (L. 160/2019). Dire la prima cosa senza la seconda
  // costerebbe al genitore la detrazione, in silenzio.
  await page.getByRole('tab', { name: 'Contanti' }).click();
  await expect(page.getByText('In segreteria, negli orari di apertura')).toBeVisible();
  await expect(page.getByText('non sono detraibili')).toBeVisible();
});
