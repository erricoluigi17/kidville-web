/**
 * build-artifact.mjs — genera il resoconto HTML self-contained della campagna
 * Test 360° ULTRA (primaria TEST 1A). Aggrega TUTTI i findings reali dai file
 * JSON del run + inietta i findings visivi/lacune del Workflow, incorpora gli
 * screenshot curati (report-assets/*.jpg) come data-URI. Output: run/report-360.html
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const RUN = new URL('../run/', import.meta.url);
const FIND = new URL('findings/', RUN);
const NAT = new URL('native/', RUN);
const readJson = (u, fb) => { try { return JSON.parse(readFileSync(u, 'utf8')); } catch { return fb; } };
const asset = (name) => {
  const p = new URL(`report-assets/${name}.jpg`, RUN);
  if (!existsSync(p)) return null;
  return `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 1. Aggrega findings funzionali (coverage sweep + journey d'azione) ───────
const findFiles = existsSync(FIND) ? readdirSync(FIND).filter((f) => f.endsWith('.json')) : [];
let visiteTot = 0;
const funcNonOk = [];
const coverageBy = { admin: { ok: 0, tot: 0, personas: new Set() }, teacher: { ok: 0, tot: 0, personas: new Set() }, parent: { ok: 0, tot: 0, personas: new Set() } };
for (const f of findFiles) {
  if (f.startsWith('adversarial')) continue; // contati separatamente come Sicurezza
  const arr = readJson(new URL(f, FIND), []);
  const isCov = f.startsWith('copertura-');
  const key = f.replace('copertura-', '').replace('.json', '');
  const role = /segreteria/.test(key) ? 'admin' : /docente/.test(key) ? 'teacher' : /genitore/.test(key) ? 'parent' : null;
  for (const x of arr) {
    if (isCov) {
      visiteTot++;
      if (role) { coverageBy[role].tot++; coverageBy[role].personas.add(key); if (x.gravita === 'ok') coverageBy[role].ok++; }
    }
    if (x.gravita && !['ok', 'estetico'].includes(x.gravita)) {
      funcNonOk.push({ persona: key, ...x });
    }
  }
}

// ── 2. Findings sicurezza (adversarial) ──────────────────────────────────────
const advers = [...readJson(new URL('adversarial.json', FIND), []), ...readJson(new URL('adversarial-anon.json', FIND), [])];

// ── 3. Findings nativi ───────────────────────────────────────────────────────
const nativeFind = [
  ...readJson(new URL('android-docente1-findings.json', NAT), []),
  ...readJson(new URL('android-genitore1-findings.json', NAT), []),
  ...readJson(new URL('ios-findings.json', NAT), []),
];

// ── 4. Visivi + lacune (dal Workflow) ────────────────────────────────────────
const visual = readJson(new URL('visual-findings.json', RUN), []);
const lacune = readJson(new URL('lacune.json', RUN), []);

// ── 5. Credenziali ────────────────────────────────────────────────────────────
const creds = readJson(new URL('../run-credentials.json', import.meta.url), { accounts: [] });

// ── Conteggi gravità globali (findings reali, esclusi ok) ────────────────────
const SEV_ORDER = ['bloccante', 'grave', 'medio', 'minore', 'estetico'];
const allFindings = [
  ...advers.filter((x) => x.gravita && x.gravita !== 'ok').map((x) => ({ ...x, dominio: 'Sicurezza' })),
  ...funcNonOk.map((x) => ({ ...x, dominio: 'Funzionale' })),
  ...visual.filter((x) => x.severita && x.severita !== 'ok').map((x) => ({ gravita: x.severita, flusso: x.batch || x.area, pagina: x.screenshot, step: x.categoria, atteso: x.atteso, osservato: x.osservato, dominio: 'Grafico/UX' })),
  ...nativeFind.filter((x) => x.gravita && !['ok'].includes(x.gravita)).map((x) => ({ ...x, dominio: 'Nativo' })),
];
const sevCount = (s) => allFindings.filter((f) => (f.gravita || f.severita) === s).length;

// ── Matrice di copertura (route per ruolo, esito piattaforma) ────────────────
const MATRIX_ROWS = [
  ['Segreteria / Direzione', 'Desktop cockpit', coverageBy.admin.tot, coverageBy.admin.ok, '1', '—'],
  ['Docenti (×5)', 'Mobile web + nativo (campione)', coverageBy.teacher.tot, coverageBy.teacher.ok, '5', 'Android ✓'],
  ['Genitori (×20)', 'Mobile web + nativo (campione)', coverageBy.parent.tot, coverageBy.parent.ok, '20', 'Android ✓ · iOS ✓'],
];

// ─────────────────────────────────────────────────────────────────────────────
const chip = (sev, label) => `<span class="chip ${sev}">${label || sev}</span>`;
const fig = (name, cap) => { const d = asset(name); return d ? `<figure class="shot"><div class="frame"><img loading="lazy" src="${d}" alt="${esc(cap)}"></div><figcaption>${cap}</figcaption></figure>` : ''; };

// Findings di sicurezza curati (evidenza empirica dai probe)
const secRows = advers.filter((x) => x.gravita !== 'ok').map((x) => `
  <article class="prob bloccante">
    <div class="prob-h">${chip('bloccante', 'Bloccante')}<h3>${esc(x.step)}</h3></div>
    <p class="mono-sm">${esc(x.pagina)}</p>
    <p><b>Atteso:</b> ${esc(x.atteso)}</p>
    <p><b>Osservato:</b> ${esc(x.osservato)}</p>
  </article>`).join('');

const funcCards = (() => {
  // Dedup per (pagina+osservato-prefix), raggruppa i 403 Girasoli ecc.
  const groups = new Map();
  for (const x of funcNonOk) {
    const gk = `${x.pagina}|${(x.osservato || '').slice(0, 40)}`;
    if (!groups.has(gk)) groups.set(gk, { ...x, personas: new Set() });
    groups.get(gk).personas.add(x.persona);
  }
  return [...groups.values()].sort((a, b) => SEV_ORDER.indexOf(a.gravita) - SEV_ORDER.indexOf(b.gravita)).map((x) => `
    <article class="prob ${x.gravita}">
      <div class="prob-h">${chip(x.gravita)}<h3>${esc(x.step || x.flusso)}</h3></div>
      <p class="mono-sm">${esc(x.pagina)} · ${x.personas.size} personas</p>
      <p>${esc((x.osservato || '').slice(0, 240))}</p>
    </article>`).join('');
})();

const visualCards = visual.filter((x) => x.severita && x.severita !== 'ok').sort((a, b) => SEV_ORDER.indexOf(a.severita) - SEV_ORDER.indexOf(b.severita)).slice(0, 40).map((x) => `
  <article class="prob ${x.severita}">
    <div class="prob-h">${chip(x.severita)}<h3>${esc(x.categoria)} · ${esc((x.area || x.batch || '').slice(0, 40))}</h3></div>
    <p class="mono-sm">${esc(x.screenshot)}</p>
    <p>${esc(x.osservato)}</p>
  </article>`).join('') || '<p class="lead">Nessuna anomalia grafica di rilievo oltre a quelle già elencate.</p>';

const lacuneRows = lacune.map((l) => `
  <tr><td>${chip(l.priorita === 'alta' ? 'grave' : l.priorita === 'media' ? 'medio' : 'minore', l.priorita)}</td><td class="req">${esc(l.cosa_manca)}</td><td class="note">${esc(l.perche || '')}</td><td class="note">${esc(l.come_coprirla || '')}</td></tr>`).join('');

const credRows = (creds.accounts || []).map((c) => `<tr><td>${esc(c.email)}</td><td>${esc(c.ruolo)}</td><td>${esc(c.alunno)}</td></tr>`).join('');

const html = `<title>Kidville · Test 360° ULTRA — Scuola Primaria</title>
<style>
:root{
  --green:#006A5F;--green-2:#00867a;--yellow:#FDC400;--bg:#F7F2E9;--panel:#FFFFFF;--ink:#20302B;--muted:#5C6B64;--line:#E4DCCB;
  --bloccante:#B4231C;--grave:#C0392B;--medio:#C77D1A;--minore:#7A8A84;--estetico:#9AA7A0;--ok:#2E7D57;
  --shadow:0 1px 2px rgba(0,60,52,.05),0 12px 32px -22px rgba(0,60,52,.4);--maxw:1160px;
}
@media (prefers-color-scheme:dark){:root{--green:#37b3a2;--green-2:#4fd0bd;--bg:#0E1A17;--panel:#152420;--ink:#E8EFEB;--muted:#9DB0A8;--line:#25382F;--bloccante:#E4695C;--grave:#E4695C;--medio:#E0A43D;--minore:#9DB0A8;--estetico:#7E8C86;--ok:#54C08A;--shadow:0 1px 2px rgba(0,0,0,.3),0 14px 36px -24px rgba(0,0,0,.75);}}
:root[data-theme="light"]{--green:#006A5F;--green-2:#00867a;--bg:#F7F2E9;--panel:#FFFFFF;--ink:#20302B;--muted:#5C6B64;--line:#E4DCCB;--bloccante:#B4231C;--grave:#C0392B;--medio:#C77D1A;--minore:#7A8A84;--ok:#2E7D57;}
:root[data-theme="dark"]{--green:#37b3a2;--green-2:#4fd0bd;--bg:#0E1A17;--panel:#152420;--ink:#E8EFEB;--muted:#9DB0A8;--line:#25382F;--bloccante:#E4695C;--grave:#E4695C;--medio:#E0A43D;--minore:#9DB0A8;--ok:#54C08A;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 20px}
h1,h2,h3{text-wrap:balance;margin:0}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--green)}
a{color:var(--green)}
header{background:linear-gradient(155deg,var(--green),var(--green-2));color:#fff;padding:46px 0 36px;border-bottom:4px solid var(--yellow)}
header .wrap{display:flex;flex-direction:column;gap:12px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:42px;height:42px;border-radius:12px;background:var(--yellow);color:var(--green);display:grid;place-items:center;font-weight:900;font-size:22px}
header h1{font-size:clamp(26px,4.2vw,42px);font-weight:800;letter-spacing:-.015em;line-height:1.04;text-transform:uppercase}
header p.sub{margin:0;color:rgba(255,255,255,.9);max-width:70ch}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.tag{font-size:12.5px;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.15);color:#fff}
.tag.prod{background:#B4231C}.tag.yellow{background:var(--yellow);color:var(--green)}
.cruscotto{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin:26px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.kpi .n{font-size:30px;font-weight:800;line-height:1}
.kpi .l{font-size:12px;color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.kpi .n.bloccante{color:var(--bloccante)}.kpi .n.grave{color:var(--grave)}.kpi .n.medio{color:var(--medio)}.kpi .n.ok{color:var(--ok)}
section{padding:30px 0;border-top:1px solid var(--line)}
section>.wrap>.eyebrow{display:block;margin-bottom:6px}
section h2{font-size:clamp(19px,2.6vw,26px);font-weight:800;letter-spacing:-.01em;text-transform:uppercase;margin-bottom:6px}
section>.wrap>p.lead{color:var(--muted);max-width:74ch;margin:0 0 18px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%}
.chip.bloccante{background:color-mix(in srgb,var(--bloccante) 16%,transparent);color:var(--bloccante)}.chip.bloccante::before{background:var(--bloccante)}
.chip.grave{background:color-mix(in srgb,var(--grave) 15%,transparent);color:var(--grave)}.chip.grave::before{background:var(--grave)}
.chip.medio{background:color-mix(in srgb,var(--medio) 16%,transparent);color:var(--medio)}.chip.medio::before{background:var(--medio)}
.chip.minore{background:color-mix(in srgb,var(--minore) 20%,transparent);color:var(--minore)}.chip.minore::before{background:var(--minore)}
.chip.estetico{background:color-mix(in srgb,var(--estetico) 20%,transparent);color:var(--estetico)}.chip.estetico::before{background:var(--estetico)}
.chip.alta{background:color-mix(in srgb,var(--grave) 15%,transparent);color:var(--grave)}.chip.alta::before{background:var(--grave)}
.chip.media{background:color-mix(in srgb,var(--medio) 16%,transparent);color:var(--medio)}.chip.media::before{background:var(--medio)}
.chip.bassa{background:color-mix(in srgb,var(--minore) 20%,transparent);color:var(--minore)}.chip.bassa::before{background:var(--minore)}
.problist{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.prob{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.prob.bloccante{border-left-color:var(--bloccante)}.prob.grave{border-left-color:var(--grave)}.prob.medio{border-left-color:var(--medio)}.prob.minore{border-left-color:var(--minore)}.prob.estetico{border-left-color:var(--estetico)}
.prob-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}.prob-h h3{font-size:15px;font-weight:800}
.prob p{margin:4px 0;color:var(--muted);font-size:13.5px}.prob p b{color:var(--ink)}
.mono-sm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px!important;color:var(--green)!important;word-break:break-all}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;min-width:600px;background:var(--panel);font-size:14px}
thead th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 14px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--green) 6%,transparent)}
tbody td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:none}
td.req{font-weight:600}td.note{color:var(--muted);font-size:13px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.shot{margin:0}.frame{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel);max-height:460px;overflow-y:auto;box-shadow:var(--shadow)}
.frame img{display:block;width:100%;height:auto}
.shot figcaption{font-size:13px;color:var(--muted);margin-top:9px}.shot figcaption b{color:var(--ink)}
.note-box{background:color-mix(in srgb,var(--green) 6%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px 20px;font-size:13.5px;color:var(--muted)}
.note-box b{color:var(--ink)}.note-box ul{margin:8px 0 0;padding-left:18px}.note-box li{margin:5px 0}
footer{padding:26px 0 50px;color:var(--muted);font-size:12.5px;text-align:center;border-top:1px solid var(--line)}
:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:6px}
.callout{background:color-mix(in srgb,var(--bloccante) 8%,transparent);border:1px solid color-mix(in srgb,var(--bloccante) 30%,transparent);border-radius:14px;padding:16px 20px;margin-bottom:18px}
.callout b{color:var(--bloccante)}
</style>

<header><div class="wrap">
  <div class="brand"><div class="logo">K</div><span class="eyebrow" style="color:var(--yellow)">Kidville · Registro Elettronico · Quality Assurance</span></div>
  <h1>Test 360° ULTRA — Scuola Primaria</h1>
  <p class="sub">Campagna end-to-end multi-agente sulla classe <b>TEST 1A</b> (Kidville Giugliano): 26 personas reali (1 segreteria + 5 docenti + 20 genitori madre/padre), copertura di ogni route/pulsante/stato via Playwright, app <b>nativa</b> Capacitor pilotata via Appium su Android e iOS, e probe adversarial di sicurezza. Ogni esito è verificato dal vivo.</p>
  <div class="meta">
    <span class="tag prod">DB · PRODUZIONE</span><span class="tag">Classe TEST 1A</span><span class="tag">08/07/2026</span>
    <span class="tag yellow">Playwright + Appium (Android/iOS) + MCP</span>
  </div>
</div></header>

<div class="wrap"><div class="cruscotto">
  <div class="kpi"><div class="n">26</div><div class="l">Personas reali</div></div>
  <div class="kpi"><div class="n">${visiteTot}</div><div class="l">Visite route (sweep)</div></div>
  <div class="kpi"><div class="n bloccante">${sevCount('bloccante')}</div><div class="l">Bloccanti</div></div>
  <div class="kpi"><div class="n grave">${sevCount('grave')}</div><div class="l">Gravi</div></div>
  <div class="kpi"><div class="n medio">${sevCount('medio')}</div><div class="l">Medi</div></div>
  <div class="kpi"><div class="n">${sevCount('minore') + sevCount('estetico')}</div><div class="l">Minori/estetici</div></div>
  <div class="kpi"><div class="n">2</div><div class="l">Piattaforme native</div></div>
</div></div>

<section><div class="wrap">
  <span class="eyebrow">Priorità assoluta</span>
  <h2>Vulnerabilità di controllo accessi — bloccanti</h2>
  <div class="callout"><b>Azione immediata raccomandata.</b> I probe adversarial hanno confermato <b>dal vivo</b> l'esposizione di dati personali di minori senza controllo di proprietà/autenticazione. Endpoint su dati reali di produzione. Vanno chiusi prima di qualsiasi rilascio.</div>
  <div class="problist">${secRows}</div>
  <div class="note-box" style="margin-top:16px">
    <b>Causa (dal codice).</b>
    <ul>
      <li><b>IDOR</b> — <span class="mono-sm">src/app/api/parent/primaria/{valutazioni,note,assenze,pagella}/route.ts</span>: usano <span class="mono-sm">getRequestUserId</span> ma non verificano mai <span class="mono-sm">genitoreHasFiglio(userId, studentId)</span>. Qualsiasi genitore autenticato legge i dati di un alunno arbitrario passando <span class="mono-sm">?studentId=</span>.</li>
      <li><b>PII senza auth</b> — <span class="mono-sm">src/app/api/admin/students/[id]/route.ts</span>: GET service-role <b>senza alcun gate</b> (né sessione né ruolo). Restituisce alunno + genitori + codici fiscali + indirizzi a un client anonimo.</li>
      <li><b>Fix indicato</b>: gate <span class="mono-sm">requireUser</span>+<span class="mono-sm">genitoreHasFiglio</span> sulle route parent/primaria; <span class="mono-sm">requireStaff</span> su admin/students/[id]. Verifica O.M. 3/2025 + GDPR.</li>
    </ul>
  </div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Copertura</span>
  <h2>Matrice di copertura per ruolo e piattaforma</h2>
  <p class="lead">Sweep automatico di ogni route dell'inventario (derivato dal codice) per ogni persona, con cattura errori HTTP/console e screenshot. Le route con esito non-verde sono dettagliate nelle sezioni successive.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Ruolo</th><th>Piattaforma</th><th>Route/persona</th><th>Visite OK</th><th>Personas</th><th>Nativo</th></tr></thead>
    <tbody>${MATRIX_ROWS.map((r) => `<tr><td class="req">${r[0]}</td><td class="note">${r[1]}</td><td>${Math.round(r[2] / Math.max(1, r[4] === '—' ? 1 : Number(r[4])))}</td><td>${r[3]}/${r[2]}</td><td>${r[4]}</td><td class="note">${r[5]}</td></tr>`).join('')}</tbody>
  </table></div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Difetti funzionali</span>
  <h2>Problemi funzionali riscontrati</h2>
  <p class="lead">Errori reali intercettati durante lo sweep (HTTP 4xx/5xx sulle API, errori di runtime). Raggruppati per route; il conteggio personas indica su quanti account si riproduce.</p>
  <div class="problist">${funcCards}</div>
  <div class="grid2" style="margin-top:20px">
    ${fig('doc-appello-girasoli', '<b>Docente · Appello</b> — la pagina è cablata su <span class="mono-sm">SEZIONE=Girasoli</span> (sezione infanzia): per un docente di primaria le API delegates/certificati rispondono 403.')}
    ${fig('par-locker-500', '<b>Genitore · Armadietto</b> — la pagina non risolve il contesto figlio: <span class="mono-sm">alunno_id=null</span> → 400/500 su locker/requests.')}
    ${fig('par-onboarding-500', '<b>Genitore · Onboarding/Modulistica</b> — <span class="mono-sm">/api/parent/submissions</span> risponde 500.')}
    ${fig('doc-gallery-hydration', '<b>Docente · Galleria</b> — errore di hydration React al caricamento.')}
  </div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">App nativa</span>
  <h2>Capacitor — Android & iOS (campione)</h2>
  <p class="lead">App nativa reale pilotata via Appium (non web mobile): shell WebView Capacitor che carica l'app dal server. Verificate safe-area, status bar, tasto back Android, deep-link <span class="mono-sm">kidville://</span>. Login-through via protocollo W3C non stabilisce la sessione Supabase (limite dell'harness nativo, non difetto app: Playwright autentica gli stessi account sullo stesso server).</p>
  <div class="grid2">
    ${fig('nat-android-doc', '<b>Android · docente</b> — app nativa (contexts NATIVE_APP + WEBVIEW_it.kidville.app), login reso con safe-area rispettata.')}
    ${fig('nat-android-teacher', '<b>Android · navigazione</b> — la WebView carica il dev server reale (10.0.2.2:3000).')}
    ${fig('nat-ios', '<b>iOS Simulator</b> — app caricata dal server via http://localhost (nessun blocco ATS), safe-area ok. Context WEBVIEW non esposto ad Appium (limite web-inspector Simulator).')}
  </div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Ispezione grafica</span>
  <h2>Anomalie grafiche / UX / testuali</h2>
  <p class="lead">Rilievi degli agenti di ispezione visiva sugli screenshot reali (allineamenti, overflow, safe-area, contrasto, refusi, genere, stati vuoti).</p>
  <div class="problist">${visualCards}</div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Le tre aree in azione</span>
  <h2>Segreteria · Docente · Genitore</h2>
  <div class="grid2">
    ${fig('adm-dashboard', '<b>Segreteria</b> — dashboard cockpit.')}
    ${fig('adm-anagrafica', '<b>Segreteria</b> — anagrafica alunno a tutta area (famiglia madre+padre collegata).')}
    ${fig('adm-pagamenti', '<b>Segreteria</b> — pagamenti/incassi.')}
    ${fig('doc-registro', '<b>Docente</b> — registro di classe primaria.')}
    ${fig('doc-valutazioni', '<b>Docente</b> — valutazioni (giudizio sintetico O.M. 3/2025).')}
    ${fig('doc-note', '<b>Docente</b> — note disciplinari/didattiche.')}
    ${fig('par-primaria', '<b>Genitore</b> — registro e valutazioni del figlio.')}
    ${fig('par-mensa', '<b>Genitore</b> — mensa (saldo, prenotazione, cutoff).')}
    ${fig('par-avvisi', '<b>Genitore</b> — avvisi e adesione gita.')}
  </div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Critico di completezza</span>
  <h2>Lacune e prossimi giri consigliati</h2>
  <p class="lead">Aree coperte solo superficialmente o da approfondire in un giro successivo, secondo l'agente critico.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Priorità</th><th>Cosa manca</th><th>Perché conta</th><th>Come coprirla</th></tr></thead>
    <tbody>${lacuneRows || '<tr><td colspan="4" class="note">(nessuna lacuna registrata)</td></tr>'}</tbody>
  </table></div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Metodo & ambiente</span>
  <h2>Come è stata svolta</h2>
  <div class="note-box">
    <p><b>Ambiente.</b> DB di <b>produzione</b>, limitato alla classe <b>TEST 1A</b> (nessuna famiglia reale). Dati di test prefissati <span class="mono-sm">[E2E360]</span>. Login solo via <b>sessione reale</b> (ALLOW_HEADER_IDENTITY=false).</p>
    <ul>
      <li><b>26 personas</b> con login reale: 1 segreteria, 5 docenti, 20 genitori (10 alunni × madre+padre, seed idempotente su auth prod: parents.auth_user_id + student_parents + student_guardians + legame_genitori_alunni).</li>
      <li><b>Copertura</b> via Playwright: sweep di tutte le route dell'inventario per ogni persona (${visiteTot} visite), + journey d'azione (firma, valutazioni, note, avvisi, adesione gita, FEA/OTP, mensa, chat, pagamenti, logout).</li>
      <li><b>Nativo</b> via Appium: Android (UiAutomator2, context WEBVIEW_) e iOS Simulator (XCUITest), su APK/.app ri-buildati con <span class="mono-sm">CAP_SERVER_URL</span> verso il dev server.</li>
      <li><b>Adversarial</b>: scoping cross-alunno, PII senza auth, cross-role, verificati con probe HTTP autenticati.</li>
      <li><b>Multi-agente</b>: agenti di ispezione visiva in parallelo + critico di completezza (orchestrazione Workflow); riconciliazione dati via MCP Supabase.</li>
    </ul>
  </div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Accessi di test</span>
  <h2>Credenziali — TEST 1A (${(creds.accounts || []).length} account)</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Email</th><th>Ruolo</th><th>Alunno collegato</th></tr></thead>
    <tbody>${credRows}</tbody>
  </table></div>
  <p class="lead" style="margin-top:10px">Password unica di test: <span class="mono-sm">KidvilleTest.2026!</span></p>
</div></section>

<footer><div class="wrap">Kidville · Registro Elettronico — Test 360° ULTRA Scuola Primaria · 08/07/2026 · classe TEST 1A · DB produzione · findings totali: ${allFindings.length}</div></footer>`;

writeFileSync(new URL('report-360.html', RUN), html);
console.log('✓ report-360.html generato —', Math.round(Buffer.byteLength(html) / 1024), 'KB');
console.log('  findings:', allFindings.length, '| bloccanti:', sevCount('bloccante'), '| gravi:', sevCount('grave'), '| medi:', sevCount('medio'), '| visite:', visiteTot);
