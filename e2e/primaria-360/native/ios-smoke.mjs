/**
 * ios-smoke.mjs — pilota l'APP NATIVA su iOS Simulator via Appium (XCUITest),
 * verifica la shell nativa (WKWebView Capacitor), switch al context WEBVIEW_,
 * cattura screenshot nativi. Nessuna dipendenza extra (client W3C via fetch).
 *
 * Prereq: simulatore booted + App.app installata + appium :4723 + dev server :3000.
 * Uso: node e2e/primaria-360/native/ios-smoke.mjs <appPath>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:4723';
const [appPath] = process.argv.slice(2);
const OUT = new URL('../run/native/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[ios]', ...a);
let seq = 0;
const findings = [];

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}
async function shot(id, label) {
  seq += 1;
  const name = `ios-${String(seq).padStart(2, '0')}-${label}.png`;
  const b64 = await req('GET', `/session/${id}/screenshot`);
  writeFileSync(new URL(name, OUT), Buffer.from(b64, 'base64'));
  log('shot', name);
  return name;
}

async function main() {
  log('creo sessione XCUITest (build WDA al primo avvio, può richiedere minuti)…');
  const caps = {
    capabilities: {
      alwaysMatch: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:deviceName': 'iPhone 17 Pro',
        'appium:bundleId': 'it.kidville.app',
        'appium:autoWebview': false,
        'appium:newCommandTimeout': 300,
        'appium:noReset': true,
        'appium:usePrebuiltWDA': false,
      },
      firstMatch: [{}],
    },
  };
  if (appPath) caps.capabilities.alwaysMatch['appium:app'] = appPath;
  const session = await req('POST', '/session', caps);
  const id = session.sessionId;
  log('sessione', id);
  try {
    await new Promise((r) => setTimeout(r, 8000));
    await shot(id, 'native-launch');
    let contexts = [];
    for (let i = 0; i < 12; i++) {
      contexts = await req('GET', `/session/${id}/contexts`).catch(() => []);
      if (Array.isArray(contexts) && contexts.some((c) => String(c).startsWith('WEBVIEW'))) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    log('contexts', JSON.stringify(contexts));
    const web = (contexts || []).find((c) => String(c).startsWith('WEBVIEW'));
    findings.push({ key: 'ios', gravita: web ? 'ok' : 'medio', step: 'shell nativa iOS', osservato: `Contesti: ${JSON.stringify(contexts)}${web ? '' : ' — WEBVIEW non esposto (verifica ATS/web-inspector)'}` });
    if (web) {
      await req('POST', `/session/${id}/context`, { name: web });
      const url = await req('GET', `/session/${id}/url`).catch(() => '');
      log('webview url', url);
      findings.push({ key: 'ios', gravita: String(url).includes(':3000') ? 'ok' : 'medio', step: 'WebView carica dev server', osservato: `URL: ${url}` });
      await req('POST', `/session/${id}/context`, { name: 'NATIVE_APP' }).catch(() => {});
      await shot(id, 'native-webview');
    }
    // deep-link
    try {
      execSync('xcrun simctl openurl booted "kidville://parent"');
      await new Promise((r) => setTimeout(r, 3000));
      await shot(id, 'deeplink');
      findings.push({ key: 'ios', gravita: 'ok', step: 'deep-link kidville:// (iOS)', osservato: 'openurl gestito dalla shell' });
    } catch (e) { findings.push({ key: 'ios', gravita: 'minore', step: 'deep-link iOS', osservato: String(e).slice(0, 120) }); }
  } finally {
    await req('DELETE', `/session/${id}`).catch(() => {});
    writeFileSync(new URL('ios-findings.json', OUT), JSON.stringify(findings, null, 2));
    log('FINE. findings', findings.length);
  }
}
main().catch((e) => { console.error('[ios] ERRORE:', e.message); writeFileSync(new URL('ios-findings.json', OUT), JSON.stringify([{ key: 'ios', gravita: 'medio', step: 'run', osservato: e.message }, ...findings], null, 2)); process.exit(1); });
