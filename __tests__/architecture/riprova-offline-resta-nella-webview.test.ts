import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * T14-F2 — «Riprova» sulla schermata offline USCIVA DALL'APP.
 *
 * Il rilievo, dal collaudo Android del 2026-08-03: dalla schermata di ripiego nativo il
 * pulsante «Riprova» apriva `app.kidville.it` nel **browser di sistema**. L'utente usciva
 * dall'app, perdeva la sessione nativa (biometria, push, fotocamera) e si ritrovava in
 * Chrome — su PRODUZIONE, cioè sui dati veri delle famiglie, anche quando l'app che aveva
 * in mano era una build di collaudo puntata altrove.
 *
 * ── LA CAUSA RADICE, LETTA SUL SORGENTE DI CAPACITOR (non dedotta) ─────────────────────
 *
 * `mobile/www/offline.html` è servito da `server.errorPath`, cioè dallo SCHEMA LOCALE della
 * WebView (`https://localhost` su Android, `capacitor://localhost` su iOS — vedi
 * `Bridge.getErrorUrl()` e `CAPInstanceConfiguration.errorPathURL`). Quando la pagina fa
 * `location.href = 'https://app.kidville.it/'` sta quindi chiedendo alla WebView una
 * navigazione FUORI dalla propria origine, e Capacitor la sottopone a una decisione:
 *
 *   Android — `node_modules/@capacitor/android/…/com/getcapacitor/Bridge.java:389-417`
 *     Uri appUri = Uri.parse(appUrl);
 *     if (!(appUri.getHost().equals(url.getHost()) && url.getScheme().equals(appUri.getScheme()))
 *         && !appAllowNavigationMask.matches(url.getHost())) {
 *         getContext().startActivity(new Intent(Intent.ACTION_VIEW, url));   // ESCE
 *         return true;
 *     }
 *
 *   iOS — `node_modules/@capacitor/ios/…/WebViewDelegationHandler.swift:95-115`
 *     if let host = navURL.host, bridge.config.shouldAllowNavigation(to: host) { .allow }
 *     let isApplicationNavigation = navURL.absoluteString.starts(with: serverURL.absoluteString)
 *                                || navURL.absoluteString.starts(with: localURL.absoluteString)
 *     if !isApplicationNavigation, toplevelNavigation { UIApplication.shared.open(navURL) }  // ESCE
 *
 * Le due decisioni hanno una sola via d'uscita in comune, ed è quella che mancava:
 * **`server.allowNavigation`**. Senza, `appAllowNavigationMask` è `HostMask.Nothing` — non
 * corrisponde a niente (`HostMask.Parser.parse(null)`) — e la sola cosa che teneva l'utente
 * dentro l'app era la COINCIDENZA fra l'URL cablato nella pagina e `server.url`.
 *
 * Quella coincidenza non è garantita, ed è per questo che il tester l'ha vista rompersi:
 *   · in collaudo `CAP_SERVER_URL` è `http://10.0.2.2:3100` (emulatore) → host diverso → esce;
 *   · in una build fatta SENZA `CAP_SERVER_URL`, `appUrl` ripiega su `https://localhost`
 *     (è il ripiego documentato in `capacitor.config.ts`) → host diverso → esce.
 * Cioè: il pulsante restava dentro l'app solo in UNA delle tre configurazioni possibili, e
 * nessun test lo diceva.
 *
 * ── COSA PROVANO QUESTI TEST, E COSA NO ───────────────────────────────────────────────
 *
 * Qui non gira né Java né Swift: questi test RIPRODUCONO le due decisioni citate sopra e le
 * applicano alla configurazione vera (`capacitor.config.ts`) e all'URL vero (letto da
 * `mobile/www/offline.html`), in tutte e tre le configurazioni di `CAP_SERVER_URL`. Provano
 * che la configurazione soddisfa la condizione che il codice nativo valuta — non che la
 * WebView si comporti così su un telefono. La prova sul dispositivo non è stata eseguita
 * (vedi note del rilievo): `KV_TEST_PASSWORD` non è nell'ambiente e senza credenziali il
 * percorso non è collaudabile.
 *
 * I controlli NEGATIVI (un dominio estraneo DEVE ancora aprirsi nel browser, e nessuna
 * maschera jolly) sono la metà che conta: senza, `allowNavigation: ['*']` passerebbe questi
 * test e trasformerebbe la WebView in un browser aperto a qualunque sito — con dentro la
 * sessione di un genitore.
 */

const RADICE = process.cwd();
const OFFLINE = path.join(RADICE, 'mobile/www/offline.html');

/** L'URL che «Riprova» chiede alla WebView, letto dal file — non ricopiato qui. */
function urlDiRiprova(): string {
  const sorgente = fs.readFileSync(OFFLINE, 'utf8');
  const m = /URL_APP\s*=\s*['"]([^'"]+)['"]/.exec(sorgente);
  if (!m) throw new Error('mobile/www/offline.html non dichiara più un URL_APP riconoscibile');
  return m[1];
}

/**
 * `capacitor.config.ts` legge `process.env.CAP_SERVER_URL` al momento dell'import: per
 * valutarlo in una configurazione diversa serve rileggerlo da capo.
 */
async function configCon(capServerUrl: string | undefined): Promise<CapacitorConfig> {
  vi.resetModules();
  if (capServerUrl === undefined) vi.stubEnv('CAP_SERVER_URL', '');
  else vi.stubEnv('CAP_SERVER_URL', capServerUrl);
  return (await import('../../capacitor.config')).default;
}

/**
 * ── PERCHÉ QUI CI SONO DUE FUNZIONI E NON UNA (rilievo W9, 2026-08-03) ─────────────────
 *
 * La prima versione modellava le due piattaforme con una funzione sola, e faceva
 * `m.replace(/^https?:\/\//, '')`: cioè toglieva lo schema dalla maschera. **Non lo toglie
 * nessuna delle due implementazioni vere.** `HostMask.Util.splitAndReverse` (Android) e
 * `doesHost(_:match:)` (iOS) spezzano la maschera sui punti e confrontano i pezzi: con
 * `allowNavigation: ['https://app.kidville.it']` il primo pezzo è `https://app`, che non è
 * `app`, e la maschera non corrisponde su NESSUNA piattaforma. Il modello indulgente dava
 * per buona una configurazione che avrebbe rimesso il difetto in produzione; a salvare la
 * situazione era solo il fatto che la config, oggi, è scritta senza schema.
 *
 * Quindi: due porti fedeli, uno per piattaforma, wildcard compresi. Le due implementazioni
 * NON sono equivalenti (vedi il test sul segmento singolo), e un modello unico non può che
 * essere sbagliato per una delle due. Non è modellato il caso degenere degli host con
 * segmenti vuoti (`app..it`), dove `String.split` di Java, Swift e JavaScript divergono fra
 * loro: nessuna configurazione plausibile passa di lì.
 */

/** Android — `HostMask.Simple.matches` + `HostMask.Util.matches` (`util/HostMask.java`). */
function androidMaschera(maschere: string[] | undefined, host: string | null): boolean {
  // `HostMask.Parser.parse(null)` → `Nothing`, che non corrisponde a niente: è lo stato in
  // cui viveva il difetto, quando `allowNavigation` non c'era.
  if (!maschere || host === null) return false;
  const spezzaEInverti = (s: string) => s.split('.').reverse();
  return maschere.some((maschera) => {
    const pezziMaschera = spezzaEInverti(maschera);
    const pezziHost = spezzaEInverti(host);
    // `if (maskSize > 1 && hostSize != maskSize) return false;` — la lunghezza si controlla
    // SOLO se la maschera ha più di un pezzo. Con un pezzo solo il confronto si ferma
    // all'ultimo segmento: vedi il test dedicato, è una porta molto più larga di quanto sembri.
    if (pezziMaschera.length > 1 && pezziHost.length !== pezziMaschera.length) return false;
    const minimo = Math.min(pezziHost.length, pezziMaschera.length);
    for (let i = 0; i < minimo; i += 1) {
      const pezzoMaschera = pezziMaschera[i];
      if (pezzoMaschera === '*') continue;
      if (pezzoMaschera.toUpperCase() !== pezziHost[i].toUpperCase()) return false;
    }
    return true;
  });
}

/** iOS — `CAPInstanceConfiguration.doesHost(_:match:)` / `shouldAllowNavigation(to:)`. */
function iosMaschera(maschere: string[] | undefined, host: string | null): boolean {
  if (!maschere || host === null) return false;
  return maschere.some((maschera) => {
    if (maschera === '*') return true;
    const pezziHost = host.toLowerCase().split('.');
    const pezziMaschera = maschera.toLowerCase().split('.');
    // `guard hostComponents.count == patternComponents.count else { return false }`: iOS
    // pretende SEMPRE lo stesso numero di segmenti, anche con una maschera di un pezzo solo.
    if (pezziHost.length !== pezziMaschera.length) return false;
    return pezziMaschera.every((pezzo, i) => pezzo === '*' || pezzo === pezziHost[i]);
  });
}

/**
 * Android — `Bridge.launchIntent`: `true` significa «apro un Intent verso il browser di
 * sistema», cioè l'utente ESCE dall'app. È il valore che il difetto produceva.
 */
function androidEsceDallApp(destinazione: string, appUrl: string, config: CapacitorConfig): boolean {
  const url = new URL(destinazione);
  const app = new URL(appUrl);
  const stessaOrigine = app.hostname === url.hostname && url.protocol === app.protocol;
  return !stessaOrigine && !androidMaschera(config.server?.allowNavigation, url.hostname);
}

/**
 * iOS — `WebViewDelegationHandler.decidePolicyFor`: `true` significa
 * `UIApplication.shared.open(navURL)`, cioè Safari.
 */
function iosEsceDallApp(destinazione: string, serverUrl: string | undefined, config: CapacitorConfig): boolean {
  const url = new URL(destinazione);
  if (iosMaschera(config.server?.allowNavigation, url.hostname)) return false;
  // `CAPInstanceConfiguration.m:45-50` — localURL = «<scheme>://<hostname>», e serverURL
  // ripiega su localURL quando `server.url` non c'è.
  const localURL = 'capacitor://localhost';
  const serverURL = serverUrl ?? localURL;
  const navigazioneDellApp =
    destinazione.startsWith(serverURL) || destinazione.startsWith(localURL);
  return !navigazioneDellApp; // la navigazione di «Riprova» è sempre di main frame
}

/**
 * Le tre configurazioni in cui l'app viene davvero compilata. Il difetto viveva nelle
 * ultime due, ed è esattamente lì che il collaudo lo ha incontrato.
 */
const CONFIGURAZIONI = [
  { nome: 'produzione (CAP_SERVER_URL = app.kidville.it)', env: 'https://app.kidville.it' },
  { nome: 'collaudo su emulatore Android (10.0.2.2:3100)', env: 'http://10.0.2.2:3100' },
  { nome: 'build senza CAP_SERVER_URL (ripiego su webDir)', env: undefined },
] as const;

describe('T14-F2 — «Riprova» resta dentro la WebView, in ogni build', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(CONFIGURAZIONI)('Android · $nome: non parte alcun Intent verso il browser', async ({ env }) => {
    const config = await configCon(env);
    // Android: senza `server.url` l'app parte dallo schema locale (`https://localhost`).
    const appUrl = env ?? 'https://localhost';
    expect(androidEsceDallApp(urlDiRiprova(), appUrl, config)).toBe(false);
  });

  it.each(CONFIGURAZIONI)('iOS · $nome: non si apre Safari', async ({ env }) => {
    const config = await configCon(env);
    expect(iosEsceDallApp(urlDiRiprova(), env, config)).toBe(false);
  });

  it('l’host di «Riprova» è dichiarato in allowNavigation: i due file non possono divergere', async () => {
    // L'URL sta cablato in `offline.html` (la pagina non ha modo di conoscere `server.url`:
    // il bridge Capacitor NON è iniettato sull'origine locale quando `server.url` è remoto).
    // Che sia cablato è tollerabile solo finché la config lo riconosce: se domani il dominio
    // cambia in uno dei due file e non nell'altro, «Riprova» torna a uscire dall'app.
    const config = await configCon('https://app.kidville.it');
    const host = new URL(urlDiRiprova()).hostname;
    expect(config.server?.allowNavigation ?? []).toContain(host);
  });
});

describe('T14-F2 — la porta aperta resta stretta', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(CONFIGURAZIONI)(
    'Android · $nome: un dominio estraneo si apre ANCORA nel browser',
    async ({ env }) => {
      // Il difetto speculare, e sarebbe molto peggio dell'originale: un link a un sito
      // qualunque che si apre DENTRO l'app: stessa WebView, stessi cookie di sessione,
      // stessa barra assente. `allowNavigation` deve elencare host, non aprire tutto.
      const config = await configCon(env);
      const appUrl = env ?? 'https://localhost';
      expect(androidEsceDallApp('https://esempio-estraneo.invalid/pagina', appUrl, config)).toBe(true);
    },
  );

  it('nessuna maschera jolly in allowNavigation', async () => {
    const config = await configCon('https://app.kidville.it');
    for (const voce of config.server?.allowNavigation ?? []) {
      expect(voce, 'un `*` qui trasforma la WebView in un browser aperto').not.toContain('*');
    }
  });

  it('elenca solo host di Kidville, e nessun servizio di terzi', async () => {
    const config = await configCon('https://app.kidville.it');
    const voci = config.server?.allowNavigation ?? [];
    expect(voci.length).toBeGreaterThan(0);
    for (const voce of voci) {
      // Nessun `replace` dello schema: una voce come `https://app.kidville.it` non è un host
      // valido per Capacitor (vedi il gruppo qui sotto) e deve rompere anche questo controllo,
      // non essere ripulita per farla passare.
      expect(voce).toMatch(/(^|\.)kidville\.it$/);
    }
  });
});

describe('T14-F2 — il modello non è più indulgente del codice nativo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uno SCHEMA nella maschera non corrisponde: né Android né iOS lo tolgono', () => {
    // È il difetto del modello, non del prodotto: `mascheraCorrisponde` faceva
    // `.replace(/^https?:\/\//, '')` e dava per funzionante una configurazione che non
    // funziona su nessuna delle due piattaforme. Android spezza su `.` → il primo pezzo è
    // `https://app`; iOS fa lo stesso split. Un `allowNavigation: ['https://app.kidville.it']`
    // lascia la maschera senza corrispondenze e «Riprova» torna a uscire dall'app.
    expect(androidMaschera(['https://app.kidville.it'], 'app.kidville.it')).toBe(false);
    expect(iosMaschera(['https://app.kidville.it'], 'app.kidville.it')).toBe(false);
    expect(androidMaschera(['http://app.kidville.it'], 'app.kidville.it')).toBe(false);
    expect(iosMaschera(['http://app.kidville.it'], 'app.kidville.it')).toBe(false);
  });

  it('con lo schema nella maschera, «Riprova» uscirebbe davvero dall’app', () => {
    // La stessa cosa detta sulla decisione intera, non sul solo confronto: è la forma in cui
    // il difetto si vedrebbe addosso a un utente.
    const conSchema = { server: { allowNavigation: ['https://app.kidville.it'] } } as CapacitorConfig;
    expect(androidEsceDallApp('https://app.kidville.it/', 'http://10.0.2.2:3100', conSchema)).toBe(true);
    expect(iosEsceDallApp('https://app.kidville.it/', 'http://10.0.2.2:3100', conSchema)).toBe(true);
  });

  it('la configurazione vera elenca host, non URL', async () => {
    const config = await configCon('https://app.kidville.it');
    for (const voce of config.server?.allowNavigation ?? []) {
      expect(voce, '`allowNavigation` vuole un HOST: lo schema non viene tolto da nessuna piattaforma').not.toMatch(
        /:\/\//,
      );
    }
  });

  it('il confronto ignora maiuscole e minuscole, come le due implementazioni', () => {
    // Android confronta `toUpperCase()`, iOS `lowercased()`: un modello sensibile al caso
    // sarebbe stato più SEVERO del nativo, cioè avrebbe respinto config che funzionano.
    expect(androidMaschera(['APP.Kidville.IT'], 'app.kidville.it')).toBe(true);
    expect(iosMaschera(['APP.Kidville.IT'], 'app.kidville.it')).toBe(true);
  });

  it('una maschera di un segmento solo apre TUTTO il dominio di primo livello, ma solo su Android', async () => {
    // `HostMask.Simple.matches`: `if (maskSize > 1 && hostSize != maskSize) return false` —
    // con un pezzo solo il controllo di lunghezza non scatta e si confronta il solo ultimo
    // segmento. `allowNavigation: ['it']` farebbe entrare QUALSIASI sito `.it` dentro la
    // WebView dell'app, accanto ai cookie di sessione di un genitore e senza barra degli
    // indirizzi. iOS pretende invece lo stesso numero di segmenti e lo rifiuterebbe: è
    // esattamente il genere di asimmetria che un modello unico nascondeva.
    expect(androidMaschera(['it'], 'sito-estraneo.it')).toBe(true);
    expect(iosMaschera(['it'], 'sito-estraneo.it')).toBe(false);

    const config = await configCon('https://app.kidville.it');
    for (const voce of config.server?.allowNavigation ?? []) {
      expect(voce.split('.').length, 'una maschera di un segmento è un dominio intero aperto su Android').toBeGreaterThan(
        1,
      );
    }
  });
});
