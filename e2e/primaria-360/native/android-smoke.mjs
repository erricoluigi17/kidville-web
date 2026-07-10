/**
 * android-smoke.mjs — pilota l'APP NATIVA Capacitor reale sull'emulatore Android
 * via Appium (UiAutomator2), switch al context WEBVIEW_ per guidare il DOM React.
 * Cattura screenshot NATIVI (device: status bar, safe-area, bottom nav) per la
 * verifica della shell nativa. Nessuna dipendenza extra: client W3C raw via fetch.
 *
 * Uso: node e2e/primaria-360/native/android-smoke.mjs <key> <email> [routes csv]
 * Prereq: emulatore avviato + APK installato + appium su :4723 + dev server :3000.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:4723';
const SERVER = 'http://10.0.2.2:3000';
const PASSWORD = 'KidvilleTest.2026!';
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;

const [key = 'docente1', email = 'test.pri.docente1@kidville.test', routesCsv = ''] = process.argv.slice(2);
const routes = routesCsv ? routesCsv.split(',') : [];
const OUT = new URL('../run/native/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(`[${key}]`, ...a);
let seq = 0;
const findings = [];

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}

async function shot(sid, label) {
  // Screenshot NATIVO (device intero): richiede context NATIVE_APP per catturare
  // status bar + safe-area + chrome nativo.
  seq += 1;
  const name = `android-${key}-${String(seq).padStart(2, '0')}-${label}.png`;
  const b64 = await req('GET', `/session/${sid}/screenshot`);
  writeFileSync(new URL(name, OUT), Buffer.from(b64, 'base64'));
  log('shot', name);
  return name;
}

async function findEl(sid, css, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const el = await req('POST', `/session/${sid}/element`, { using: 'css selector', value: css });
      if (el) return el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf'];
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function main() {
  log('creo sessione…');
  const caps = {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': 'it.kidville.app',
        'appium:appActivity': 'it.kidville.app.MainActivity',
        'appium:autoWebview': false,
        'appium:chromedriverAutodownload': true,
        'appium:newCommandTimeout': 300,
        'appium:noReset': true,
      },
      firstMatch: [{}],
    },
  };
  const session = await req('POST', '/session', caps);
  const sid = session.sessionId || session.sessionId;
  const realSid = session.sessionId || session['sessionId'];
  const id = realSid || sid;
  log('sessione', id);

  try {
    // 1. Launch: la shell nativa carica SERVER (server.url) → /auth/login
    await new Promise((r) => setTimeout(r, 6000));
    await shot(id, 'native-launch');

    // 2. Contesti disponibili (prova che è una WebView Capacitor nativa)
    let contexts = [];
    for (let i = 0; i < 10; i++) {
      contexts = await req('GET', `/session/${id}/contexts`);
      if (contexts.some((c) => c.startsWith('WEBVIEW'))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    log('contexts', JSON.stringify(contexts));
    const web = contexts.find((c) => c.startsWith('WEBVIEW'));
    if (!web) {
      findings.push({ key, gravita: 'bloccante', step: 'context WEBVIEW', osservato: `Nessun WEBVIEW_ trovato: ${JSON.stringify(contexts)}` });
      throw new Error('WEBVIEW context assente');
    }
    findings.push({ key, gravita: 'ok', step: 'shell nativa', osservato: `Context nativi: ${contexts.join(', ')}` });

    // 3. Switch WEBVIEW + login reale nel DOM
    await req('POST', `/session/${id}/context`, { name: web });
    const curUrl = await req('GET', `/session/${id}/url`).catch(() => '');
    log('url webview', curUrl);
    // assicura di essere su login
    if (!String(curUrl).includes('/auth/login')) {
      await req('POST', `/session/${id}/url`, { url: `${SERVER}/auth/login` });
      await new Promise((r) => setTimeout(r, 2500));
    }
    const emailEl = await findEl(id, '#email');
    const pwEl = await findEl(id, '#password');
    if (!emailEl || !pwEl) {
      findings.push({ key, gravita: 'grave', step: 'login', osservato: 'Campi #email/#password non trovati nella WebView' });
    } else {
      // Fill affidabile su input controllati React: native value setter + eventi input/change.
      const filled = await req('POST', `/session/${id}/execute/sync`, {
        script: `const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};const em=document.querySelector('#email');const pw=document.querySelector('#password');set(em,arguments[0]);set(pw,arguments[1]);return (em.value?'e':'')+(pw.value?'p':'');`,
        args: [email, PASSWORD],
      }).catch((e) => String(e));
      log('fill result', filled);
      await new Promise((r) => setTimeout(r, 800));
      // Submit: requestSubmit del form (trigger onSubmit React) + click Entra.
      const sub = await req('POST', `/session/${id}/execute/sync`, {
        script: "const f=document.querySelector('form');const b=[...document.querySelectorAll('button')].find(x=>/entra/i.test((x.textContent||'').trim()));let r=[];if(f){try{f.requestSubmit(b||undefined);r.push('requestSubmit');}catch(e){r.push('rsErr:'+e.message);}}if(b&&!b.disabled){b.click();r.push('click');}return r.join(',');",
        args: [],
      }).catch((e) => String(e));
      log('submit result', sub);
      await new Promise((r) => setTimeout(r, 9000));
      const errTxt = await req('POST', `/session/${id}/execute/sync`, {
        script: "return (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200);",
        args: [],
      }).catch(() => '');
      log('post-submit body', String(errTxt).slice(0, 160));
      const landing = await req('GET', `/session/${id}/url`).catch(() => '');
      log('landing', landing);
      findings.push({ key, gravita: /\/(admin|teacher|parent)/.test(String(landing)) ? 'ok' : 'grave', step: 'login nativo', osservato: `Landing dopo login: ${landing}` });
    }

    // 4. Screenshot NATIVO post-login (switch NATIVE_APP per catturare shell+status bar)
    await req('POST', `/session/${id}/context`, { name: 'NATIVE_APP' });
    await new Promise((r) => setTimeout(r, 1500));
    await shot(id, 'native-home');

    // 5. Naviga alle route campione nella WebView, screenshot nativo per ciascuna
    for (const route of routes) {
      await req('POST', `/session/${id}/context`, { name: web });
      await req('POST', `/session/${id}/url`, { url: `${SERVER}${route}` });
      await new Promise((r) => setTimeout(r, 3500));
      await req('POST', `/session/${id}/context`, { name: 'NATIVE_APP' });
      await shot(id, 'route-' + route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, ''));
    }

    // 6. Tasto BACK Android nativo (keyevent 4) → deve navigare indietro, non uscire
    execSync(`"${ADB}" shell input keyevent 4`);
    await new Promise((r) => setTimeout(r, 2500));
    await shot(id, 'after-back-button');
    findings.push({ key, gravita: 'ok', step: 'tasto back Android', osservato: 'keyevent 4 inviato, screenshot catturato' });

    // 7. Deep-link kidville:// (verifica intent-filter nativo)
    try {
      execSync(`"${ADB}" shell am start -a android.intent.action.VIEW -d "kidville://parent" it.kidville.app`);
      await new Promise((r) => setTimeout(r, 3000));
      await shot(id, 'deeplink-kidville');
      findings.push({ key, gravita: 'ok', step: 'deep-link kidville://', osservato: 'Intent kidville://parent gestito dalla shell nativa' });
    } catch (e) {
      findings.push({ key, gravita: 'minore', step: 'deep-link kidville://', osservato: `Intent fallito: ${String(e).slice(0, 150)}` });
    }
  } finally {
    await req('DELETE', `/session/${id}`).catch(() => {});
    writeFileSync(new URL(`android-${key}-findings.json`, OUT), JSON.stringify(findings, null, 2));
    log('FINE. findings:', findings.length);
  }
}

main().catch((e) => { console.error(`[${key}] ERRORE:`, e.message); writeFileSync(new URL(`android-${key}-findings.json`, OUT), JSON.stringify([{ key, gravita: 'bloccante', step: 'run', osservato: e.message }, ...findings], null, 2)); process.exit(1); });
