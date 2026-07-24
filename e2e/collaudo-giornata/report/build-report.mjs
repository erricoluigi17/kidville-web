/**
 * build-report.mjs — aggrega i findings degli agenti + screenshot in un unico
 * report HTML self-contained (screenshot base64 inline). Nessun asset esterno.
 *
 * Input:  run/findings/<persona>.json  = { persona, ruolo, device, ondata,
 *           findings: [ { dominio, tipo(W|R|N|NF), gravita, passo, atteso,
 *           ottenuto, oracoloUI, oracoloDB, screenshots:[path], note } ] }
 * Output: run/report-giornata.html
 * Uso:    node e2e/collaudo-giornata/report/build-report.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, dirname } from 'node:path';

const RUN = fileURLToPath(new URL('../run/', import.meta.url));
const FINDINGS = join(RUN, 'findings');
const OUT = join(RUN, 'report-giornata.html');

const GRAV = ['bloccante', 'grave', 'medio', 'minore', 'estetico', 'ok'];
const COLOR = { bloccante: '#b00020', grave: '#d93900', medio: '#c98a00', minore: '#3a6ea5', estetico: '#6b7280', ok: '#006A5F' };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function img64(p) {
  if (!p || !existsSync(p)) return null;
  const ext = extname(p).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

function load() {
  if (!existsSync(FINDINGS)) return [];
  return readdirSync(FINDINGS).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(readFileSync(join(FINDINGS, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function main() {
  const reports = load();
  const all = reports.flatMap((r) => (r.findings || []).map((x) => ({ ...x, persona: r.persona, ruolo: r.ruolo, device: r.device })));
  const count = Object.fromEntries(GRAV.map((g) => [g, all.filter((f) => (f.gravita || 'ok') === g).length]));

  const summary = GRAV.map((g) => `<span class="pill" style="background:${COLOR[g]}">${g}: ${count[g] || 0}</span>`).join(' ');

  const rows = all
    .sort((a, b) => GRAV.indexOf(a.gravita || 'ok') - GRAV.indexOf(b.gravita || 'ok'))
    .map((f) => {
      const shots = (f.screenshots || []).map(img64).filter(Boolean)
        .map((d) => `<img src="${d}" style="max-width:230px;border:1px solid #ddd;border-radius:6px;margin:4px">`).join('');
      return `<tr>
        <td><span class="pill" style="background:${COLOR[f.gravita || 'ok']}">${esc(f.gravita || 'ok')}</span></td>
        <td><b>${esc(f.persona)}</b><br><small>${esc(f.ruolo || '')} · ${esc(f.device || '')}</small></td>
        <td>${esc(f.dominio)} <small>(${esc(f.tipo || '')})</small></td>
        <td>${esc(f.passo)}</td>
        <td><b>atteso:</b> ${esc(f.atteso)}<br><b>ottenuto:</b> ${esc(f.ottenuto)}</td>
        <td><b>UI:</b> ${esc(f.oracoloUI || '—')}<br><b>DB:</b> ${esc(f.oracoloDB || '—')}${f.note ? `<br><i>${esc(f.note)}</i>` : ''}</td>
        <td>${shots || '—'}</td>
      </tr>`;
    }).join('');

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>Collaudo Giornata — Report</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#FEF1E4}
h1{color:#006A5F} .pill{color:#fff;border-radius:99px;padding:2px 9px;font-size:12px;white-space:nowrap}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden}
td,th{border-bottom:1px solid #eee;padding:8px;vertical-align:top;text-align:left}
th{background:#006A5F;color:#fff} tr:hover{background:#faf6ef}
.head{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px}
</style></head><body>
<div class="head"><h1>Collaudo «Giornata simulata» — Report</h1>
<p>Ambiente: <b>produzione</b> (app.kidville.it) · sede Kidville Giugliano · account/sezioni TEST.
Personas: ${reports.length} · Findings: ${all.length}</p>
<p>${summary}</p></div>
<table><thead><tr><th>Gravità</th><th>Persona</th><th>Dominio</th><th>Passo</th><th>Atteso / Ottenuto</th><th>Oracolo</th><th>Screenshot</th></tr></thead>
<tbody>${rows || '<tr><td colspan=7>Nessun finding registrato.</td></tr>'}</tbody></table>
</body></html>`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);
  console.log(`report → ${OUT} (${reports.length} personas, ${all.length} findings)`);
}
main();
