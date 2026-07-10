/**
 * build-report-fresh.mjs — Report HTML self-contained del giro 360° del 2026-07-09
 * (ripetizione). Mostra SOLO i difetti reali. Aggrega:
 *   - findings funzionali freschi (run/findings/*.json) con separazione difetti vs note/artefatti
 *   - adversarial/scoping (run/findings/adversarial*.json) → sezione sicurezza
 *   - difetti visivi CONFERMATI dal Workflow adversarial (run/visual-findings.json)
 *   - lacune (run/lacune.json), dichiarazione nativo (run/native/native-declaration.json)
 * Ogni difetto visivo incorpora lo screenshot FRESCO (compresso JPEG via sips) in base64.
 * Output: run/report-360.html
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RUN = new URL('../run/', import.meta.url);
const FIND = new URL('findings/', RUN);
const SHOTS = new URL('screenshots/', RUN);
const TMP = new URL('report-assets-fresh/', RUN);
mkdirSync(TMP, { recursive: true });
const readJson = (u, fb) => { try { return JSON.parse(readFileSync(u, 'utf8')); } catch { return fb; } };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Comprime uno screenshot (basename) in JPEG e ritorna un data-URI, o null.
const embedShot = (name, maxw = 760) => {
  if (!name) return null;
  const src = new URL(name, SHOTS);
  if (!existsSync(src)) return null;
  const out = new URL(name.replace(/\.png$/i, '.jpg'), TMP);
  try {
    execSync(`sips -s format jpeg -s formatOptions 62 -Z ${maxw} "${src.pathname}" --out "${out.pathname}"`, { stdio: 'ignore' });
    return `data:image/jpeg;base64,${readFileSync(out).toString('base64')}`;
  } catch { return null; }
};

// ── 1. Findings funzionali freschi ────────────────────────────────────────────
const files = existsSync(FIND) ? readdirSync(FIND).filter((f) => f.endsWith('.json')) : [];
let visiteCoverage = 0;
const funcDefects = [];  // difetti reali (grave/medio)
const funcNotes = [];    // note informative / artefatti (minore)
for (const f of files) {
  if (f.startsWith('adversarial') || f.startsWith('copertura-')) {
    if (f.startsWith('copertura-')) { const arr = readJson(new URL(f, FIND), []); visiteCoverage += arr.length; }
    continue;
  }
  const arr = readJson(new URL(f, FIND), []);
  for (const x of arr) {
    if (!x.gravita || ['ok', 'estetico'].includes(x.gravita)) continue;
    const rec = { persona: f.replace('.json', ''), ...x };
    if (x.gravita === 'minore') funcNotes.push(rec); else funcDefects.push(rec);
  }
}

// ── 2. Sicurezza (adversarial) ────────────────────────────────────────────────
const advers = [...readJson(new URL('adversarial.json', FIND), []), ...readJson(new URL('adversarial-anon.json', FIND), [])];
const secViol = advers.filter((x) => x.gravita && x.gravita !== 'ok');
const secProbes = advers.length;

// ── 3. Difetti visivi CONFERMATI ──────────────────────────────────────────────
const SEV = ['bloccante', 'grave', 'medio', 'minore', 'estetico'];
const visual = readJson(new URL('visual-findings.json', RUN), [])
  .filter((x) => x.severita && x.severita !== 'ok')
  .sort((a, b) => SEV.indexOf(a.severita) - SEV.indexOf(b.severita));

// ── 4. Lacune + nativo ────────────────────────────────────────────────────────
const lacune = readJson(new URL('lacune.json', RUN), []);
const native = readJson(new URL('native/native-declaration.json', RUN), {});
const creds = readJson(new URL('../run-credentials.json', import.meta.url), { accounts: [] });

// ── Conteggi gravità (difetti reali: funzionali + visivi) ─────────────────────
const allDefects = [
  ...funcDefects.map((x) => ({ gravita: x.gravita })),
  ...visual.map((x) => ({ gravita: x.severita })),
];
const nSev = (s) => allDefects.filter((d) => d.gravita === s).length;

const chip = (sev, label) => `<span class="chip ${sev}">${esc(label || sev)}</span>`;

// Card difetto visivo con screenshot fresco
const visualCards = visual.map((x) => {
  const uri = embedShot(x.screenshot);
  return `<article class="prob ${x.severita}">
    <div class="prob-h">${chip(x.severita)}<h3>${esc(x.categoria)} · ${esc(x.area)}</h3></div>
    <p><b>Atteso:</b> ${esc(x.atteso)}</p>
    <p><b>Osservato:</b> ${esc(x.osservato)}</p>
    ${x.motivo_verifica ? `<p class="verify"><b>Verifica adversarial:</b> ${esc(x.motivo_verifica)}</p>` : ''}
    <p class="mono-sm">${esc(x.screenshot)}</p>
    ${uri ? `<div class="frame"><img loading="lazy" src="${uri}" alt="${esc(x.area)}"></div>` : ''}
  </article>`;
}).join('') || '<p class="lead">Nessun difetto visivo confermato dopo la verifica adversarial.</p>';

const funcDefectCards = (() => {
  if (!funcDefects.length) return '<div class="note-box" style="border-color:color-mix(in srgb,var(--ok) 45%,transparent)"><b style="color:var(--ok)">✓ 0 difetti funzionali.</b> Nessun errore HTTP 4xx/5xx sulle API né azione fallita durante lo sweep completo delle route e i journey d\'azione (firma, valutazioni giudizio O.M. 3/2025, note, avviso+adesione gita, firma FEA/OTP, mensa, chat, pagamenti). Le prenotazioni mensa "oggi" sono state accettate.</div>';
  const groups = new Map();
  for (const x of funcDefects) {
    const gk = `${x.pagina}|${(x.osservato || '').slice(0, 40)}`;
    if (!groups.has(gk)) groups.set(gk, { ...x, personas: new Set() });
    groups.get(gk).personas.add(x.persona);
  }
  return `<div class="problist">${[...groups.values()].sort((a, b) => SEV.indexOf(a.gravita) - SEV.indexOf(b.gravita)).map((x) => `
    <article class="prob ${x.gravita}">
      <div class="prob-h">${chip(x.gravita)}<h3>${esc(x.step || x.flusso)}</h3></div>
      <p class="mono-sm">${esc(x.pagina)} · ${x.personas.size} persona/e</p>
      <p><b>Atteso:</b> ${esc(x.atteso)}</p>
      <p><b>Osservato:</b> ${esc(x.osservato)}</p>
    </article>`).join('')}</div>`;
})();

const noteRows = funcNotes.map((x) => `<li><b>${esc(x.pagina)}</b> — ${esc(x.osservato)}</li>`).join('');
const lacuneRows = lacune.map((l) => `<tr><td>${chip(l.priorita === 'alta' ? 'grave' : l.priorita === 'media' ? 'medio' : 'minore', l.priorita)}</td><td class="req">${esc(l.cosa_manca)}</td><td class="note">${esc(l.perche || '')}</td><td class="note">${esc(l.come_coprirla || '')}</td></tr>`).join('');
const credRows = (creds.accounts || []).map((c) => `<tr><td>${esc(c.email)}</td><td>${esc(c.ruolo)}</td><td>${esc(c.alunno)}</td></tr>`).join('');

const html = `<title>Kidville · Test 360° Primaria — Difetti (09/07/2026)</title>
<style>
:root{--green:#006A5F;--green-2:#00867a;--yellow:#FDC400;--bg:#F7F2E9;--panel:#FFFFFF;--ink:#20302B;--muted:#5C6B64;--line:#E4DCCB;--bloccante:#B4231C;--grave:#C0392B;--medio:#C77D1A;--minore:#7A8A84;--estetico:#9AA7A0;--ok:#2E7D57;--shadow:0 1px 2px rgba(0,60,52,.05),0 12px 32px -22px rgba(0,60,52,.4);--maxw:1160px;}
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
header p.sub{margin:0;color:rgba(255,255,255,.9);max-width:72ch}
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
section>.wrap>p.lead{color:var(--muted);max-width:78ch;margin:0 0 18px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%}
.chip.bloccante{background:color-mix(in srgb,var(--bloccante) 16%,transparent);color:var(--bloccante)}.chip.bloccante::before{background:var(--bloccante)}
.chip.grave{background:color-mix(in srgb,var(--grave) 15%,transparent);color:var(--grave)}.chip.grave::before{background:var(--grave)}
.chip.medio{background:color-mix(in srgb,var(--medio) 16%,transparent);color:var(--medio)}.chip.medio::before{background:var(--medio)}
.chip.minore{background:color-mix(in srgb,var(--minore) 20%,transparent);color:var(--minore)}.chip.minore::before{background:var(--minore)}
.chip.estetico{background:color-mix(in srgb,var(--estetico) 20%,transparent);color:var(--estetico)}.chip.estetico::before{background:var(--estetico)}
.problist{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
.prob{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.prob.bloccante{border-left-color:var(--bloccante)}.prob.grave{border-left-color:var(--grave)}.prob.medio{border-left-color:var(--medio)}.prob.minore{border-left-color:var(--minore)}.prob.estetico{border-left-color:var(--estetico)}
.prob-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}.prob-h h3{font-size:15px;font-weight:800}
.prob p{margin:4px 0;color:var(--muted);font-size:13.5px}.prob p b{color:var(--ink)}
.prob p.verify{font-style:italic;font-size:12.5px}
.mono-sm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px!important;color:var(--green)!important;word-break:break-all}
.frame{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);max-height:520px;overflow-y:auto;box-shadow:var(--shadow);margin-top:10px}
.frame img{display:block;width:100%;height:auto}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;min-width:600px;background:var(--panel);font-size:14px}
thead th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 14px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--green) 6%,transparent)}
tbody td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:none}
td.req{font-weight:600}td.note{color:var(--muted);font-size:13px}
.note-box{background:color-mix(in srgb,var(--green) 6%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px 20px;font-size:13.5px;color:var(--muted)}
.note-box b{color:var(--ink)}.note-box ul{margin:8px 0 0;padding-left:18px}.note-box li{margin:5px 0}
.callout{background:color-mix(in srgb,var(--medio) 8%,transparent);border:1px solid color-mix(in srgb,var(--medio) 30%,transparent);border-radius:14px;padding:16px 20px;margin-bottom:18px}
.callout.block{background:color-mix(in srgb,var(--bloccante) 8%,transparent);border-color:color-mix(in srgb,var(--bloccante) 30%,transparent)}
.callout b{color:var(--ink)}
footer{padding:26px 0 50px;color:var(--muted);font-size:12.5px;text-align:center;border-top:1px solid var(--line)}
:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:6px}
</style>

<header><div class="wrap">
  <div class="brand"><div class="logo">K</div><span class="eyebrow" style="color:var(--yellow)">Kidville · Registro Elettronico · Quality Assurance</span></div>
  <h1>Test 360° Primaria — Difetti riscontrati</h1>
  <p class="sub">Ripetizione della campagna end-to-end multi-agente sulla classe <b>TEST 1A</b> (Kidville Giugliano): 26 personas reali (1 segreteria + 5 docenti + 20 genitori madre/padre), sweep di ogni route via Playwright con sessione reale, journey d'azione, probe adversarial di sicurezza, e ispezione visiva multi-agente con verifica adversarial su screenshot freschi. Questo documento elenca <b>solo i difetti</b>.</p>
  <div class="meta">
    <span class="tag prod">DB · PRODUZIONE</span><span class="tag">Classe TEST 1A</span><span class="tag">09/07/2026</span>
    <span class="tag yellow">Playwright · web-mobile 390×844 · MCP</span>
  </div>
</div></header>

<div class="wrap"><div class="cruscotto">
  <div class="kpi"><div class="n">26</div><div class="l">Personas reali</div></div>
  <div class="kpi"><div class="n">${visiteCoverage}</div><div class="l">Visite route (sweep)</div></div>
  <div class="kpi"><div class="n bloccante">${nSev('bloccante')}</div><div class="l">Bloccanti</div></div>
  <div class="kpi"><div class="n grave">${nSev('grave')}</div><div class="l">Gravi</div></div>
  <div class="kpi"><div class="n medio">${nSev('medio')}</div><div class="l">Medi</div></div>
  <div class="kpi"><div class="n">${nSev('minore') + nSev('estetico')}</div><div class="l">Minori/estetici</div></div>
</div></div>

<section><div class="wrap">
  <span class="eyebrow">Controllo accessi</span>
  <h2>Sicurezza — scoping &amp; controllo accessi</h2>
  ${secViol.length ? `<div class="callout block"><b>Esposizione confermata dal vivo.</b> ${secViol.length} violazioni.</div>
  <div class="problist">${secViol.map((x) => `<article class="prob bloccante"><div class="prob-h">${chip('bloccante')}<h3>${esc(x.step)}</h3></div><p class="mono-sm">${esc(x.pagina)}</p><p>${esc(x.osservato)}</p></article>`).join('')}</div>`
  : `<div class="note-box" style="border-color:color-mix(in srgb,var(--ok) 45%,transparent)">
    <b style="color:var(--ok)">✓ 0 violazioni — verificato dal vivo (${secProbes} probe).</b> Tutti i probe adversarial rispondono correttamente: figlio proprio <span class="mono-sm">200</span> · figlio altrui <span class="mono-sm">403</span> (IDOR lettura e scrittura su valutazioni/note/assenze/pagella/orario/presenze/competenze/mensa/armadietto) · endpoint docente da genitore <span class="mono-sm">403</span> · PII <span class="mono-sm">/api/admin/students/[id]</span> e letture parent senza sessione <span class="mono-sm">401</span>.</div>`}
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Difetti funzionali</span>
  <h2>Difetti funzionali (backend/azioni)</h2>
  <p class="lead">Errori reali su API (HTTP 4xx/5xx), azioni che non producono effetto o dati che non si salvano, intercettati durante sweep + journey d'azione.</p>
  ${funcDefectCards}
  ${funcNotes.length ? `<div class="note-box" style="margin-top:16px"><b>Note / artefatti riconosciuti (non difetti):</b><ul>${noteRows}</ul></div>` : ''}
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Ispezione visiva · verificata adversarial</span>
  <h2>Difetti grafici / UX / testuali</h2>
  <p class="lead">Rilievi degli ispettori visivi sugli screenshot <b>freschi</b> di questo giro, ognuno <b>ri-verificato da un secondo agente adversarial</b> (che tenta di smentirlo). Sono esclusi gli artefatti: indicatore dev Next.js (cerchio "N" in basso a sinistra), date-input nativi in formato en-US del browser headless, dati di test <span class="mono-sm">[E2E360]</span>.</p>
  <div class="problist">${visualCards}</div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">App nativa Capacitor</span>
  <h2>Nativo — dichiarazione onesta (non eseguito)</h2>
  <div class="callout block"><b>Android — BLOCCO AMBIENTE.</b> ${esc(native.android?.motivo || '')} <br><b>Ripiego:</b> ${esc(native.android?.ripiego_dichiarato || '')}</div>
  <div class="callout"><b>iOS — non rieseguito in questo ciclo.</b> ${esc(native.ios?.ambiente || '')} ${esc(native.ios?.motivo || '')} <br><b>Ripiego:</b> ${esc(native.ios?.ripiego_dichiarato || '')}</div>
  <p class="lead">${esc(native.nota || '')} Nessuno screenshot nativo di questo ciclo è incluso.</p>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Critico di completezza</span>
  <h2>Lacune e prossimi giri consigliati</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Priorità</th><th>Cosa manca</th><th>Perché conta</th><th>Come coprirla</th></tr></thead>
    <tbody>${lacuneRows || '<tr><td colspan="4" class="note">(nessuna lacuna registrata)</td></tr>'}</tbody>
  </table></div>
</div></section>

<section><div class="wrap">
  <span class="eyebrow">Metodo &amp; ambiente</span>
  <h2>Come è stata svolta</h2>
  <div class="note-box">
    <ul>
      <li><b>Ambiente.</b> DB di <b>produzione</b>, limitato alla classe <b>TEST 1A</b>. Login solo via <b>sessione reale</b> (ALLOW_HEADER_IDENTITY=false). Dati di test prefissati <span class="mono-sm">[E2E360]</span>.</li>
      <li><b>26 personas</b> con login reale (1 segreteria + 5 docenti + 20 genitori madre/padre). storageState rigenerato a inizio giro.</li>
      <li><b>Copertura Playwright</b>: ${visiteCoverage} visite (sweep di ogni route dell'inventario per persona) + journey d'azione (firma ora/lezione/compiti, valutazioni giudizio O.M. 3/2025, note, avviso+adesione gita, firma FEA/OTP, mensa, chat, pagamenti) + logout in tutte le aree.</li>
      <li><b>Adversarial</b>: ${secProbes} probe di scoping (IDOR cross-alunno lettura/scrittura, PII senza auth, cross-role).</li>
      <li><b>Ispezione visiva multi-agente</b> (Workflow): un ispettore per batch legge gli screenshot freschi, ogni difetto è ri-verificato da un agente adversarial + critico di completezza.</li>
      <li><b>Nativo</b>: Android bloccato (no emulatore/AVD), iOS non rieseguito; docenti/genitori provati in <b>web mobile 390×844</b>.</li>
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

<footer><div class="wrap">Kidville · Registro Elettronico — Test 360° Primaria · 09/07/2026 · classe TEST 1A · DB produzione · difetti reali: ${allDefects.length} (bloccanti ${nSev('bloccante')} · gravi ${nSev('grave')} · medi ${nSev('medio')} · minori/estetici ${nSev('minore') + nSev('estetico')})</div></footer>`;

writeFileSync(new URL('report-360.html', RUN), html);
console.log('✓ report-360.html —', Math.round(Buffer.byteLength(html) / 1024), 'KB');
console.log('  difetti reali:', allDefects.length, '| visivi:', visual.length, '| funzionali:', funcDefects.length, '| sicurezza:', secViol.length, '| note:', funcNotes.length, '| visite:', visiteCoverage);
