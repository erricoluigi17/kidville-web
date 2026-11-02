import { test, expect, type Locator } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EMAILS, IDS, NOMI_SEDI, STORAGE, login } from './fixtures';
import { clienteDatabaseCi } from './helpers/database-ci';
import itAdmin from '../messages/it/votazioniAdmin.json';
import itGenitore from '../messages/it/votazioniGenitore.json';

// ─────────────────────────────────────────────────────────────────────────────
// VOTAZIONI DEI RAPPRESENTANTI — il giro completo dal browser vero
//
// I test delle API e dei componenti provano permessi, conteggi e stati uno per
// uno, con finti. Qui si prova che i pezzi stanno insieme su un database vero
// (quello della CI, con la migrazione `votazioni_rappresentanti` applicata):
//
//   1. la SEGRETERIA della sede E2E apre una votazione per la classe Girasoli
//      più il rappresentante d'istituto, con due candidati, scadenza domani
//      alle 18:00 (ora di Roma);
//   2. il GENITORE trova la card in home, la apre, vota in classe, vota
//      l'istituto e CAMBIA il voto dell'istituto;
//   3. la SEGRETERIA riapre il dettaglio: «chi ha votato chi» riporta la scelta
//      cambiata con la marca «modificato», poi chiude in anticipo;
//   4. il GENITORE ricarica e non ha più niente da votare.
//
// ─── CHI VOTA E CHI SI VOTA, e perché non è `genitore2` ──────────────────────
// Il piano nominava `genitore2` come candidato d'istituto, ma `genitore2` (Gilda)
// sta nella SEDE 2 (figlia Emma nella Girasoli della sede 2): la segreteria della
// sede 1 non può candidarla, e il POST risponderebbe `VOTAZIONE_CANDIDATO_NON_VALIDO`.
// Nella sede 1 i genitori con un account e un figlio iscritto sono due:
//   · `genitore` — Gaia Genitore-E2E, madre di Aurora (Girasoli);
//   · `doppio`   — Duccio Doppio-E2E, padre di Fiore (Margherite), ruolo `educator`.
// Sono i due candidati d'istituto. La scheda di CLASSE della Girasoli ha un solo
// avente diritto (Gaia: Bruno non ha nessun genitore con account), quindi lì non
// c'è una seconda scelta a cui passare: il CAMBIO di voto si prova sull'istituto,
// dove i candidati li sceglie lo spec e sono due.
//
// ─── I RETRY E LA PULIZIA ────────────────────────────────────────────────────
// `retries: 2` in CI, e per regola una classe sta in UNA sola votazione aperta
// (come l'istituto di una sede): un secondo giro sulla stessa classe risponderebbe
// 409 `VOTAZIONE_CLASSE_GIA_APERTA`. Perciò lo spec cancella da sé le votazioni
// delle due sedi E2E PRIMA di aprirne una (e dopo, rete di sicurezza: un'altra
// spec non deve ritrovarsi la card «Votazioni aperte» in home). Il seed fa lo
// stesso all'avvio della suite (`ripulisciVotazioniE2E`). Il titolo è unico per
// giro: un retry non può scambiare la votazione di prima per la sua.
//
// ─── SE LO SCHEMA MANCA ──────────────────────────────────────────────────────
// Il database della CI è un progetto separato che NON viene migrato da solo
// (`migrate-ci.yml`, a mano). Senza le tabelle lo spec SALTA con il motivo, invece
// di diventare un rosso che accusa il codice (le route rispondono 503
// `VOTAZIONI_NON_DISPONIBILI`, voluto).
//
// Il Service Worker è bloccato: con la cache offline una risposta vecchia
// potrebbe mascherare quella vera.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ serviceWorkers: 'block' });

// La CI E2E gira su `next dev`: le pagine e le route compilano a freddo.
const RENDER = 60_000;
const AZIONE = 30_000;

/**
 * I NOMI dei due genitori della sede 1, come li mostra il prodotto: «Cognome Nome».
 *
 * ⚠️ RICOPIATI da `scripts/seed-e2e.mjs` (`utenti`: Gaia/Genitore-E2E e Duccio/Doppio-E2E): gli spec
 * Playwright non importano moduli `.mjs`. Se là cambiano, qui la ricerca non trova nessuno.
 */
const NOME_GAIA = 'Genitore-E2E Gaia';
const NOME_DUCCIO = 'Doppio-E2E Duccio';
const CLASSE = 'Girasoli';
const ORA_SCADENZA = '18:00';

/** Le quattro tabelle del modulo e le colonne che lo spec e le route leggono: se una manca, lo schema è parziale. */
const TABELLE_VOTAZIONI: ReadonlyArray<readonly [string, string]> = [
  ['votazioni', 'id, scuola_id, titolo, scadenza, chiusa_il, rappresentante_istituto'],
  ['votazioni_classi', 'votazione_id, scuola_id, section_id'],
  ['votazioni_candidati', 'votazione_id, scuola_id, utente_id'],
  ['votazioni_voti', 'id, votazione_id, ambito, section_id, elettore_id, candidato_id, votato_il, aggiornato_il'],
];

/** I codici con cui PostgREST dice «a questo database manca un pezzo dello schema» (come `schemaVotazioniAssente`). */
const SCHEMA_ASSENTE = new Set(['PGRST205', '42P01', '42703', 'PGRST204']);

/**
 * Lo schema delle votazioni c'è? `null` se sì; altrimenti la frase che dice cosa manca.
 * Un errore che NON è «schema assente» (rete, permessi) non si scambia per uno schema assente: si lancia.
 */
async function schemaVotazioniMancante(db: SupabaseClient): Promise<string | null> {
  const mancanze: string[] = [];
  for (const [tabella, colonne] of TABELLE_VOTAZIONI) {
    const { error } = await db.from(tabella).select(colonne).limit(1);
    if (!error) continue;
    if (SCHEMA_ASSENTE.has(error.code ?? '')) {
      mancanze.push(`${tabella}: ${error.code}`);
      continue;
    }
    throw new Error(`lettura di ${tabella} non riuscita: ${error.code ?? 'SENZA_CODICE'} ${error.message}`);
  }
  return mancanze.length > 0 ? mancanze.join(' | ') : null;
}

/** Toglie le votazioni delle due sedi E2E (classi, candidati e voti se ne vanno per CASCADE). */
async function ripulisciVotazioniE2E(db: SupabaseClient): Promise<void> {
  const { error } = await db.from('votazioni').delete().in('scuola_id', [IDS.SCUOLA, IDS.SCUOLA2]);
  if (error) {
    throw new Error(`pulizia delle votazioni E2E non riuscita: ${error.code ?? 'SENZA_CODICE'} ${error.message}`);
  }
}

// Rete di sicurezza: dopo ogni giro, riuscito o no, nessuna votazione resta nelle sedi E2E. Se lo schema manca
// non c'è niente da pulire (e il test è stato saltato).
test.afterEach(async () => {
  const db = clienteDatabaseCi();
  if ((await schemaVotazioniMancante(db)) !== null) return;
  await ripulisciVotazioniE2E(db);
});

/** Il giorno dopo l'oggi di Roma, come lo scrive il campo «Giorno»: gg/mm/aaaa. */
function domaniDiRoma(): string {
  const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  const d = new Date(`${oggi}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const gg = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${gg}/${mm}/${d.getUTCFullYear()}`;
}

/** Cerca un genitore per nome nel dialogo «Apri una votazione» e lo sceglie come candidato d'istituto. */
async function aggiungiCandidato(dialogo: Locator, nome: string): Promise<void> {
  await dialogo.getByLabel(itAdmin.cercaGenitore, { exact: true }).fill(nome);
  // Il risultato arriva da una fetch dopo una breve pausa di scrittura: il click aspetta che il pulsante ci sia.
  await dialogo.getByRole('button', { name: nome, exact: true }).click({ timeout: AZIONE });
  await expect(
    dialogo.getByRole('button', { name: itAdmin.rimuoviCandidato.replace('{nome}', nome), exact: true }),
  ).toBeVisible({ timeout: AZIONE });
}

test('la segreteria apre le elezioni, il genitore vota e cambia voto, la segreteria vede chi ha votato chi e chiude', async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);

  // ── 0. Lo schema c'è? Se no, si salta con il motivo; se sì, si parte da una sede senza votazioni ──────────
  const db = clienteDatabaseCi();
  const mancante = await schemaVotazioniMancante(db);
  test.skip(
    mancante !== null,
    'Il database della CI non ha lo schema delle votazioni — non è un difetto del codice. ' +
      'Va applicata con il workflow «DB migrate (CI)» (`migrate-ci.yml`, a mano) la migrazione ' +
      '`*_votazioni_rappresentanti.sql`. Mancanze rilevate: ' +
      mancante,
  );
  await ripulisciVotazioniE2E(db);

  const titolo = `Elezione E2E ${Date.now()}`;
  const giornoScadenza = domaniDiRoma();
  const titoloClasse = itAdmin.schedaClasse.replace('{nome}', CLASSE);
  const titoloIstituto = itAdmin.schedaIstituto.replace('{nomeSede}', NOMI_SEDI.scuola);
  const didascalia = (scheda: string) => itAdmin.chiCaption.replace('{scheda}', scheda);

  // ── 1. LA SEGRETERIA APRE LA VOTAZIONE ─────────────────────────────────────────────────────────────────
  await login(page, EMAILS.segreteria);
  await page.waitForURL('**/admin', { timeout: RENDER });
  await page.goto('/admin/votazioni');

  const nuova = page.getByRole('button', { name: itAdmin.nuovaVotazione, exact: true });
  await expect(nuova).toBeVisible({ timeout: RENDER });
  await nuova.click();

  const form = page.getByRole('dialog', { name: itAdmin.formTitolo, exact: true });
  await expect(form).toBeVisible({ timeout: AZIONE });

  await form.getByLabel(itAdmin.formTitoloCampo, { exact: true }).fill(titolo);

  // Le classi arrivano da una fetch: si aspetta che la casella ci sia, poi si spunta UNA sola classe.
  const casellaClasse = form.getByRole('checkbox', { name: CLASSE, exact: true });
  await expect(casellaClasse).toBeVisible({ timeout: AZIONE });
  await casellaClasse.check();

  const interruttore = form.getByRole('switch', { name: itAdmin.istitutoEtichetta, exact: true });
  await interruttore.click();
  await expect(interruttore).toHaveAttribute('aria-checked', 'true');

  await aggiungiCandidato(form, NOME_GAIA);
  await aggiungiCandidato(form, NOME_DUCCIO);

  // La scadenza: domani alle 18:00 di Roma. Il giorno preimposta le 23:59, poi l'ora si corregge a mano.
  const scadenza = form.getByRole('group', { name: itAdmin.scadenzaLegenda, exact: true });
  await scadenza.getByLabel(itAdmin.giorno, { exact: true }).fill(giornoScadenza);
  await scadenza.getByLabel(itAdmin.ora, { exact: true }).fill(ORA_SCADENZA);
  // POSITIVO: se il campo avesse cambiato forma, il `fill` sarebbe finito altrove e il pulsante sotto resterebbe spento.
  await expect(scadenza.getByLabel(itAdmin.ora, { exact: true })).toHaveValue(ORA_SCADENZA);

  const apri = form.getByRole('button', { name: itAdmin.apriVotazione, exact: true });
  await expect(apri).toBeEnabled();
  await apri.click();

  // Creata, la votazione si apre da sola nel pannello di dettaglio (`?id=<uuid>`) e compare nell'elenco «Aperta».
  const dettaglio = page.getByRole('dialog', { name: titolo, exact: true });
  await expect(dettaglio).toBeVisible({ timeout: AZIONE });
  await expect(page).toHaveURL(/[?&]id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  const riga = page.getByRole('row').filter({ has: page.getByRole('button', { name: titolo, exact: true }) });
  await expect(riga).toBeVisible({ timeout: AZIONE });
  await expect(riga).toContainText(itAdmin.statoAperta);
  await expect(riga).toContainText(CLASSE);
  await expect(riga).toContainText(itAdmin.piuIstituto);
  // La scadenza scritta è quella che il server ha salvato: stesso giorno, stessa ora di Roma.
  await expect(riga).toContainText(giornoScadenza);
  await expect(riga).toContainText(ORA_SCADENZA);

  // Il pannello ha le due schede: la classe e l'istituto.
  await expect(dettaglio.getByRole('heading', { name: titoloClasse, exact: true })).toBeVisible({ timeout: AZIONE });
  await expect(dettaglio.getByRole('heading', { name: titoloIstituto, exact: true })).toBeVisible();

  const votazioneId = new URL(page.url()).searchParams.get('id') ?? '';
  const nelDb = await db.from('votazioni').select('id, scuola_id, chiusa_il').eq('id', votazioneId);
  expect(nelDb.error, 'la votazione appena creata si rilegge dal database').toBeNull();
  expect(nelDb.data).toHaveLength(1);
  expect(nelDb.data?.[0]?.scuola_id, 'è della sede E2E, quella della segreteria').toBe(IDS.SCUOLA);
  expect(nelDb.data?.[0]?.chiusa_il, 'è aperta: nessuna chiusura a mano').toBeNull();

  // ── 2. IL GENITORE VOTA ────────────────────────────────────────────────────────────────────────────────
  const contestoGenitore = await browser.newContext({
    storageState: STORAGE.genitore,
    serviceWorkers: 'block',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  });
  try {
    const famiglia = await contestoGenitore.newPage();

    // La card in home compare solo quando c'è qualcosa da votare: 2 schede (la classe e l'istituto).
    await famiglia.goto('/parent');
    const card = famiglia.getByRole('link', { name: itGenitore.cardTitolo });
    await expect(card).toBeVisible({ timeout: RENDER });
    await expect(card).toContainText(/2 schede/);
    await card.click();
    await famiglia.waitForURL('**/parent/votazioni**', { timeout: RENDER });

    const schedaClasse = famiglia.getByRole('region', {
      name: itGenitore.schedaTitoloClasse.replace('{classe}', CLASSE),
      exact: true,
    });
    const schedaIstituto = famiglia.getByRole('region', {
      name: itGenitore.schedaTitoloIstituto.replace('{nomeSede}', NOMI_SEDI.scuola),
      exact: true,
    });
    await expect(schedaClasse).toBeVisible({ timeout: RENDER });
    await expect(schedaIstituto).toBeVisible();

    // La scadenza è in ora di Roma: le 18:00 scritte dalla segreteria sono le 18:00 lette dal genitore.
    const frase = new RegExp(itGenitore.schedaScadenza.replace('{data}', '.+').replace('{ora}', ORA_SCADENZA));
    await expect(schedaClasse.getByText(frase)).toBeVisible();
    await expect(schedaIstituto.getByText(frase)).toBeVisible();

    // 2a. Classe: si sceglie il primo candidato dell'elenco (nella Girasoli è l'unico avente diritto) e si vota.
    const primoDellaClasse = schedaClasse.getByRole('radio').first();
    await expect(primoDellaClasse).toBeVisible();
    const sceltoInClasse = await primoDellaClasse.evaluate((el) => (el.closest('label')?.textContent ?? '').trim());
    expect(sceltoInClasse, 'il candidato di classe ha un nome').not.toBe('');
    await primoDellaClasse.check();
    await schedaClasse.getByRole('button', { name: itGenitore.votaAzione, exact: true }).click();
    await expect(schedaClasse.getByText(itGenitore.votoRegistrato, { exact: true })).toBeVisible({ timeout: AZIONE });
    await expect(
      schedaClasse.getByText(itGenitore.haiVotato.replace('{nome}', sceltoInClasse), { exact: true }),
    ).toBeVisible();
    // Dopo il primo voto il pulsante cambia nome: è la prova che la scheda sa di avere già una scelta.
    await expect(schedaClasse.getByRole('button', { name: itGenitore.cambiaVoto, exact: true })).toBeVisible();

    // 2b. Istituto: prima Gaia…
    await schedaIstituto.getByRole('radio', { name: NOME_GAIA, exact: true }).check();
    await schedaIstituto.getByRole('button', { name: itGenitore.votaAzione, exact: true }).click();
    await expect(schedaIstituto.getByText(itGenitore.haiVotato.replace('{nome}', NOME_GAIA), { exact: true })).toBeVisible({
      timeout: AZIONE,
    });

    // 2c. …poi ci ripensa: sceglie Duccio e preme «Cambia voto». Vale l'ultimo.
    await schedaIstituto.getByRole('radio', { name: NOME_DUCCIO, exact: true }).check();
    await schedaIstituto.getByRole('button', { name: itGenitore.cambiaVoto, exact: true }).click();
    await expect(
      schedaIstituto.getByText(itGenitore.haiVotato.replace('{nome}', NOME_DUCCIO), { exact: true }),
    ).toBeVisible({ timeout: AZIONE });
    await expect(schedaIstituto.getByText(itGenitore.votoRegistrato, { exact: true })).toBeVisible();

    // Sul database: UNA riga per scheda (due in tutto), quella dell'istituto aggiornata e puntata su Duccio,
    // quella di classe mai cambiata. «Cambia voto» è un update, non un secondo voto.
    const voti = await db
      .from('votazioni_voti')
      .select('ambito, section_id, candidato_id, aggiornato_il')
      .eq('votazione_id', votazioneId)
      .eq('elettore_id', IDS.GENITORE);
    expect(voti.error, 'i voti del genitore si rileggono dal database').toBeNull();
    expect(voti.data, 'una riga per scheda: il cambio di voto non ne crea una seconda').toHaveLength(2);
    const votoIstituto = voti.data?.find((v) => v.ambito === 'istituto');
    const votoClasse = voti.data?.find((v) => v.ambito === 'classe');
    expect(votoIstituto?.candidato_id, "l'ultimo voto d'istituto è Duccio").toBe(IDS.DOPPIO);
    expect(votoIstituto?.aggiornato_il, "il voto d'istituto è stato cambiato").not.toBeNull();
    expect(votoClasse?.section_id, 'il voto di classe è sulla Girasoli').toBe(IDS.SEC_GIRASOLI);
    expect(votoClasse?.aggiornato_il, 'il voto di classe non è mai stato cambiato').toBeNull();

    // ── 3. LA SEGRETERIA VEDE CHI HA VOTATO CHI, E CHIUDE ─────────────────────────────────────────────────
    // Dall'elenco, come farebbe una persona: il titolo apre il pannello (e scrive `?id=` nell'indirizzo).
    await page.goto('/admin/votazioni');
    const titoloInElenco = page.getByRole('button', { name: titolo, exact: true });
    await expect(titoloInElenco).toBeVisible({ timeout: RENDER });
    await titoloInElenco.click();
    await expect(dettaglio).toBeVisible({ timeout: AZIONE });

    // Classe Girasoli: Gaia ha votato, senza marca «modificato».
    const tabellaClasse = dettaglio.getByRole('table', { name: didascalia(titoloClasse), exact: true });
    await expect(tabellaClasse).toBeVisible({ timeout: AZIONE });
    const rigaClasse = tabellaClasse.getByRole('row').filter({ hasText: NOME_GAIA });
    await expect(rigaClasse).toBeVisible();
    await expect(rigaClasse.getByRole('cell').nth(1)).toHaveText(sceltoInClasse);
    await expect(rigaClasse.getByText(itAdmin.modificato, { exact: true })).toHaveCount(0);
    await expect(dettaglio.getByText(itAdmin.esitoEletto.replace('{nome}', sceltoInClasse), { exact: true })).toBeVisible();

    // Istituto: la scelta CAMBIATA (Duccio, non più Gaia) con la marca «modificato».
    const tabellaIstituto = dettaglio.getByRole('table', { name: didascalia(titoloIstituto), exact: true });
    await expect(tabellaIstituto).toBeVisible();
    const rigaIstituto = tabellaIstituto.getByRole('row').filter({ hasText: NOME_GAIA });
    await expect(rigaIstituto).toBeVisible();
    await expect(rigaIstituto.getByRole('cell').nth(1)).toHaveText(NOME_DUCCIO);
    await expect(rigaIstituto.getByText(itAdmin.modificato, { exact: true })).toBeVisible();
    await expect(dettaglio.getByText(itAdmin.esitoEletto.replace('{nome}', NOME_DUCCIO), { exact: true })).toBeVisible();

    // Chiude in anticipo: «Chiudi ora» chiede conferma, «Sì, chiudi» la dà.
    await dettaglio.getByRole('button', { name: itAdmin.azioneChiudi, exact: true }).click();
    await dettaglio.getByRole('button', { name: itAdmin.chiudiConferma, exact: true }).click();
    await expect(dettaglio.getByText(itAdmin.chiusaFatto, { exact: true })).toBeVisible({ timeout: AZIONE });
    // Il badge del pannello e quello della riga dell'elenco passano a «Chiusa».
    await expect(dettaglio.getByText(itAdmin.statoChiusa, { exact: true })).toBeVisible({ timeout: AZIONE });
    await expect(riga).toContainText(itAdmin.statoChiusa);
    // Chiusa a mano non si chiude di nuovo né si proroga (e con dei voti dentro non si elimina).
    await expect(dettaglio.getByRole('button', { name: itAdmin.azioneChiudi, exact: true })).toHaveCount(0);
    await expect(dettaglio.getByRole('button', { name: itAdmin.azioneProroga, exact: true })).toHaveCount(0);
    await expect(dettaglio.getByRole('button', { name: itAdmin.azioneElimina, exact: true })).toHaveCount(0);

    const chiusa = await db.from('votazioni').select('chiusa_il').eq('id', votazioneId);
    expect(chiusa.error, 'la chiusura si rilegge dal database').toBeNull();
    expect(chiusa.data?.[0]?.chiusa_il, 'chiusa a mano: chiusa_il è valorizzata').not.toBeNull();

    // ── 4. IL GENITORE RICARICA: NIENTE DA VOTARE ─────────────────────────────────────────────────────────
    await famiglia.goto('/parent/votazioni');
    await expect(famiglia.getByRole('heading', { name: itGenitore.vuotoTitolo, exact: true })).toBeVisible({
      timeout: RENDER,
    });
    await expect(famiglia.getByRole('region', { name: itGenitore.schedaTitoloClasse.replace('{classe}', CLASSE) })).toHaveCount(0);
  } finally {
    await contestoGenitore.close();
  }
});
