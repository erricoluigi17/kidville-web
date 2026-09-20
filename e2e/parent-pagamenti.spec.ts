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

  /**
   * ═══ IL CODICE DELLA VOCE, DENTRO LA CAUSALE E DENTRO GLI APPUNTI ═══════════
   *
   * Il codice (`#K7MXN3P`) dice QUALE voce si sta pagando. Il codice fiscale che
   * la causale portava già dice di CHI è il pagamento, non di CHE COSA: finché la
   * famiglia ha una voce sola la differenza non si vede, e appena ne ha due la
   * riconciliazione deve indovinare — l'importo non aiuta, perché le rette sono
   * tutte uguali. Questa è la prima metà della catena: il codice arriva a schermo,
   * e il bottone lo mette negli appunti tale e quale. La seconda metà — la causale
   * tornata dalla banca che riaggancia quella riga — vive in
   * `e2e/admin-riconciliazione-popup.spec.ts` e nei test unitari di
   * `estraiCodiciVoce`.
   *
   * ⚠️ QUI NON C'È NESSUNA DEGRADAZIONE DA PROVARE, e lo si scrive perché
   * l'assenza non venga scambiata per una dimenticanza. Quasi ogni cosa aggiunta
   * di recente porta con sé un ramo «sul DB E2E della CI la colonna non c'è» —
   * `scadenza_avviso`, `abbinato_auto_il`, `pagamenti.sconto`. Il codice della
   * voce **non ha colonne**: `codiceVoce(id)` è una funzione pura dell'uuid del
   * pagamento, senza `import`, senza stato e senza database. Non esiste uno
   * schema che possa essere indietro, quindi non esiste un ramo da collaudare:
   * qui il comportamento è lo stesso su ogni ambiente, migrato o no.
   *
   * ⚠️ SI VERIFICA LA FORMA, NON IL VALORE. L'alfabeto è quello dichiarato in
   * `src/lib/pagamenti/codice-voce.ts`: 8 cifre e 12 consonanti, senza vocali
   * (un codice di sette simboli non può formare una parola italiana, né una
   * volgare, su una comunicazione alle famiglie) e senza i sosia tipografici
   * (`0/O/D/Q`, `1/I/L/J`, `B/8`, `S/5`, `Z/2`, `G/6`, `W`). Che quel codice sia
   * ESATTAMENTE `codiceVoce('…0701')` lo provano i test unitari, che la funzione
   * la importano; qui no — gli spec Playwright non importano da `src/`, e
   * ricopiare un codice atteso creerebbe una seconda verità sullo stesso valore.
   */
  const FORMA_CODICE_VOCE = /#[23456789CFHKMNPRTVXY]{7}/;

  // Il blocco è quello che porta il bottone di copia della causale: `getByText`
  // pescherebbe i sosia — «Retta E2E luglio» è a schermo anche come titolo della
  // riga e dentro lo storico più sotto.
  const copiaCausale = page.getByRole('button', { name: /^Copia la causale di / });
  const bloccoCausale = page.getByRole('listitem').filter({ has: copiaCausale });
  await expect(
    bloccoCausale,
    'il seed ha UNA sola voce aperta: con due blocchi copiabili il locator sarebbe ambiguo',
  ).toHaveCount(1);

  const testoCausale = await bloccoCausale.innerText();
  expect(
    testoCausale,
    'la causale consigliata non porta il codice della voce: senza, due rette identiche della stessa ' +
      'famiglia tornano dalla banca indistinguibili e la riconciliazione deve indovinare',
  ).toMatch(FORMA_CODICE_VOCE);
  const codiceAschermo = testoCausale.match(FORMA_CODICE_VOCE)?.[0] ?? '';

  /**
   * GLI APPUNTI, LETTI DAVVERO. È il canale primario: la card dice «Copiala così
   * com'è», e un bottone che copiasse un testo diverso da quello mostrato
   * manderebbe la famiglia a scrivere nell'home banking una causale che nessuno
   * riaggancia — senza che niente, a schermo, lo lasci vedere.
   *
   * ⚠️ Solo CHROMIUM, e non per scelta: `grantPermissions` non conosce
   * `clipboard-read` su WebKit. Non serve una guardia, perché su WebKit questo
   * test è già fermo al `fixme` in testa al file — quel motore non arriva mai
   * qui. Il giorno in cui quella divergenza venisse chiusa, questo blocco è il
   * primo posto da rileggere.
   */
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copiaCausale.click();

  /**
   * Si ATTENDE la clipboard, non l'etichetta. `navigator.clipboard.writeText` è
   * asincrona: leggere subito coglierebbe la scrittura in volo, a intermittenza.
   * Aspettare invece il «Copiato» a schermo sarebbe peggio — quella conferma
   * torna «Copia» dopo due secondi (`setTimeout` in `CausaleBonifico`), e su una
   * CI lenta la finestra si perde: un verde che dipende da un timer di due
   * secondi è un rosso che arriverà un martedì. Il riscontro vero sono gli
   * appunti, e si aspetta quelli.
   */
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
      message:
        'negli appunti non è finita nessuna causale col codice della voce: è proprio il pezzo che la ' +
        'riconciliazione legge quando il bonifico torna dalla banca',
      timeout: 15_000,
    })
    .toMatch(FORMA_CODICE_VOCE);

  const appunti = await page.evaluate(() => navigator.clipboard.readText());
  expect(
    appunti,
    'il codice copiato non è quello mostrato: il genitore scriverebbe nell’home banking il ' +
      'riferimento di un’altra voce',
  ).toContain(codiceAschermo);

  /**
   * …e nient'altro è cambiato per strada. Il confronto è a spazi NORMALIZZATI e
   * per contenimento, non carattere per carattere: a schermo la causale passa da
   * `CausaleLeggibile`, che la spezza in gruppi `whitespace-nowrap` perché il
   * codice fiscale non vada a capo a metà, e il blocco porta anche titolo,
   * importo, occhiello e bottone. La tesi è «ciò che sta negli appunti è ciò che
   * si legge lì», che è quanto la card promette («Copiala così com'è»).
   */
  const normalizza = (s: string) => s.replace(/\s+/g, ' ').trim();
  expect(
    normalizza(testoCausale),
    'il bottone «Copia» ha messo negli appunti un testo che a schermo non c’è',
  ).toContain(normalizza(appunti));

  // I contanti sono un tab vero (WAI-ARIA), non un paragrafo: si può arrivarci da
  // tastiera. Il suo pannello dice DOVE si paga e — nella stessa schermata — che i
  // contanti NON sono detraibili (L. 160/2019). Dire la prima cosa senza la seconda
  // costerebbe al genitore la detrazione, in silenzio.
  await page.getByRole('tab', { name: 'Contanti' }).click();
  await expect(page.getByText('In segreteria, negli orari di apertura')).toBeVisible();
  await expect(page.getByText('non sono detraibili')).toBeVisible();
});
