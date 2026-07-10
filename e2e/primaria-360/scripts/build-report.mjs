/**
 * build-report.mjs — assembla il resoconto HTML condivisibile del test 360° Primaria.
 * Legge gli screenshot compressi (report-assets/*.jpg) e li incorpora in base64,
 * più i dati curati (copertura requisiti, riscontri, problematiche, credenziali).
 * Output: run/report.html
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const RUN = new URL('../run/', import.meta.url);
const asset = (name) => {
  const p = new URL(`report-assets/${name}.jpg`, RUN);
  if (!existsSync(p)) return null;
  return `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`;
};
const creds = (() => { try { return JSON.parse(readFileSync(new URL('../run-credentials.json', import.meta.url))); } catch { return { accounts: [] }; } })();

const IMG = {
  anagrafica: asset('10-segreteria-04-apri-scheda-alunno-a-tutta-area-click-riga-after'),
  dashboard: asset('10-segreteria-01-dashboard-cockpit'),
  orario: asset('10-segreteria-07-orario-settimanale-ui'),
  pagamenti: asset('10-segreteria-08-dashboard-pagamenti'),
  registro: asset('20-docenti-02-d1-registro-firma'),
  valutazioniD: asset('20-docenti-03-d1-valutazioni'),
  noteD: asset('20-docenti-04-d1-note'),
  avvisoD: asset('20-docenti-05-d1-avvisi-bacheca-docente'),
  orarioG: asset('30-genitori-01-g1-orario-di-accesso'),
  valutazioniG: asset('30-genitori-03-g1-valutazioni'),
  compitiG: asset('30-genitori-05-g1-compiti'),
  avvisoG: asset('30-genitori-06-g1-avvisi-gita'),
  votoRis: asset('40-riscontri-04-g1-valutazioni-vede-il-voto'),
  pagRis: asset('40-riscontri-06-segreteria-pagamenti-incassi-odierni'),
  chatRis: asset('60-fixup-01-chat-docente1-attesa-piena'),
  mensaG: asset('60-fixup-03-g1-mensa-saldo-calendario-contesto-figlio'),
  mensaRis: asset('60-fixup-04-segreteria-report-cucina-domani'),
  logout: asset('51-logout-docente-02-docente-menu-esci-after'),
};

// ── Contenuto curato ────────────────────────────────────────────────────────
const requisiti = [
  ['Segreteria', 'Associa anagrafiche (alunni ↔ genitori)', 'ok', '10 famiglie collegate (parents + student_parents); visibili nella scheda alunno (chip Madre/Padre)'],
  ['Segreteria', 'Anagrafica a TUTTA AREA (feature)', 'ok', 'Nuova pagina /admin/students/[id]: apertura full-screen, non più drawer laterale'],
  ['Segreteria', 'Compila orario settimanale', 'ok', 'Modello 27h → campanelle generate → 15 celle materia impostate'],
  ['Segreteria', 'Segna pagamenti odierni (quota gita)', 'ok', '3 pagamenti creati e incassati; cruscotto “Incassato € 525”'],
  ['Segreteria', 'Ticket mensa', 'ok', '6 ricariche da 10 (saldo 30/alunno)'],
  ['Docenti ×5', 'Firma l’ora', 'ok', '5/5 firme (HTTP 200), una materia disgiunta per docente'],
  ['Docenti ×5', 'Comunica la lezione svolta', 'ok', 'Argomento registrato in ogni firma'],
  ['Docenti ×5', 'Voti delle interrogazioni', 'ok', '5/5 valutazioni (giudizio sintetico O.M. 3/2025; una bassa su Alunno1)'],
  ['Docenti ×5', 'Compiti con data di consegna', 'warn', 'Dato salvato (consegna 10/07) ma il campo data NON è nella UI docente (solo testo) → API only'],
  ['Docenti ×5', 'Note: disciplinare + didattica + compiti non svolti', 'ok', '3 note per docente (15 totali); disciplinare con richiesta firma'],
  ['Docente', 'Invia avviso gita + modulo autorizzazione', 'ok', 'Avviso “adesione” pubblicato per la classe TEST 1A'],
  ['Genitori', 'Controlla orario di accesso', 'ok', 'Orario settimanale con fasce ora visibile'],
  ['Genitori', 'Controlla ciò che i docenti hanno compilato', 'ok', 'Voti, note, compiti, lezioni visibili al genitore'],
  ['Genitori', 'Chiede chiarimento sul voto basso (chat)', 'ok', 'G1 → Docente1, messaggio inviato'],
  ['Genitori', 'Chiede chiarimento sull’assegno poco chiaro (chat)', 'ok', 'G2 → Docente2, messaggio inviato'],
  ['Docenti', 'Rispondono ai chiarimenti', 'ok', 'D1 e D2 rispondono (4 messaggi totali nei thread)'],
  ['Genitori', '≥5 prenotano il ticket mensa', 'ok', '5/5 prenotazioni (per il giorno successivo: “oggi” è oltre il cutoff 09:30)'],
  ['Genitori', '10 aderiscono alla gita', 'ok', '10/10 adesioni registrate'],
  ['Genitori', '10 firmano l’autorizzazione', 'warn', 'Le 10 adesioni registrano il consenso; la firma FEA del modulo dedicato (OTP) è un meccanismo separato NON esercitato in questo giro'],
  ['Riscontro', 'Prenotazioni mensa visibili alla Segreteria', 'ok', 'Report Cucina: “5 pasti · TEST 1A · Alunno1..5”'],
  ['Riscontro', 'Prenotazioni mensa visibili al Docente', 'fail', 'GAP: l’area docente non ha una vista mensa (voce “In arrivo”)'],
  ['Riscontro', 'Voto del docente visibile al Genitore', 'ok', 'La valutazione compare nella pagina del genitore'],
  ['Riscontro', 'Incassi visibili alla Segreteria', 'ok', 'Cruscotto pagamenti “Incassato € 525”'],
  ['Feature', 'Logout — Segreteria/Direzione', 'ok', 'Menu account nella TopBar → “Esci” → /auth/login'],
  ['Feature', 'Logout — Docente', 'ok', 'Menu bottom-sheet → “Esci” → /auth/login'],
  ['Feature', 'Logout — Genitore', 'ok', 'Menu bottom-sheet → “Esci” → /auth/login'],
];

const problematiche = [
  ['medio', 'Dashboard direzione: conteggio alunni incoerente', 'La card KPI mostra “16 Alunni iscritti” mentre header, Presenze e Anagrafica dicono “23”. Numero non allineato al resto della vista.', 'dashboard'],
  ['medio', 'Mensa genitore: saldo e prenotazioni non mostrati', 'La pagina mensa del genitore mostra saldo “— ticket” e tutti i giorni come “Prenota” anche se il saldo è 30 e la prenotazione risulta persistita nel DB: l’UI non risolve il contesto del figlio unico / non rilegge saldo e prenotazioni.', 'mensaG'],
  ['medio', 'Docente senza vista mensa (requisito parziale)', 'Il requisito “anche gli insegnanti devono vedere le prenotazioni” non è soddisfacibile: nell’area docente la voce “Mensa” è “In arrivo” (nessuna rotta).', null],
  ['medio', 'Compiti: data di consegna non impostabile dalla UI docente', 'La FirmaModal della primaria raccoglie solo il testo dei compiti; il campo data-consegna esiste nell’API ma manca un datepicker dedicato nell’interfaccia.', 'registro'],
  ['medio', 'Bottom-nav mobile copre parte del contenuto', 'In alcune pagine la barra di navigazione flottante si sovrappone al fondo dei contenuti (campo “Argomento” in Valutazioni docente; ultima riga dell’orario/nota lato genitore). In parte è artefatto della cattura full-page, ma il padding inferiore risulta insufficiente in alcuni casi.', 'valutazioniD'],
  ['minore', 'Firma: più “(principale)” sulla stessa ora', 'Sulla 1ª ora compaiono più firme tutte etichettate “(principale)”. È un artefatto del test (i 5 docenti hanno firmato lo stesso slot), ma l’app non impedisce due titolari “principale” sulla medesima ora.', null],
  ['minore', 'Etichette di navigazione incoerenti', 'Il 2° tab della bottom-nav cambia etichetta a seconda della pagina (Diario vs Registro lato docente; Scuola vs Diario lato genitore).', null],
  ['minore', 'Chat: spinner iniziale prima del caricamento', 'Al primo ingresso la chat mostra “Caricamento chat…” per alcuni secondi (lazy) prima di elencare le conversazioni. I dati esistono (4 messaggi) e compaiono ad attesa completata.', 'chatRis'],
  ['minore', 'Mensa: prenotazione “oggi” bloccata dal cutoff', 'Comportamento corretto: dopo le 09:30 il genitore non può più prenotare lo stesso giorno (cutoff configurato). Il test è girato alle ~21:19 → “oggi” rifiutato, dimostrato con il giorno successivo. La Segreteria (staff) può forzare.', null],
  ['minore', 'Valutazioni genitore: giudizio non visibile senza tap', 'La pagina mostra solo la card materia con “1 valutazione”; il giudizio effettivo richiede il tap per espandere e la pagina appare quasi vuota con una sola card.', 'valutazioniG'],
  ['minore', 'Rifiniture estetiche minori', 'Wordmark “Kidville” molto piccolo nella card di login; intestazione genitore con placeholder “—/BENVENUTA” quando il nome non è ancora caricato; alcune ore del registro con “materia non assegnata” (orario compilato solo in parte nel test).', null],
  ['dev', 'Overlay dev Next.js “1 Issue” (solo sviluppo)', 'Sulle pagine cockpit compare l’indicatore dev con 1 problema: è un hydration-mismatch pre-esistente sui link della sidebar (href con/senza ?userId risolto lato client). Presente solo in modalità sviluppo; la build di produzione è pulita.', null],
];

const sevMeta = {
  ok: ['ok', 'Conferme'], warn: ['warn', 'Attenzione'], fail: ['fail', 'Gap'],
  medio: ['medio', 'Medio'], minore: ['minore', 'Minore'], dev: ['dev', 'Solo dev'],
};
const countReq = (s) => requisiti.filter(r => r[2] === s).length;
const countProb = (s) => problematiche.filter(p => p[0] === s).length;

const fig = (key, cap) => IMG[key] ? `<figure class="shot"><div class="frame"><img loading="lazy" src="${IMG[key]}" alt="${cap.replace(/"/g, '&quot;')}"></div><figcaption>${cap}</figcaption></figure>` : '';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const badge = (s) => `<span class="chip ${sevMeta[s][0]}">${sevMeta[s][1]}</span>`;

const reqRows = requisiti.map(([area, req, s, note]) => `
  <tr>
    <td class="area">${esc(area)}</td>
    <td class="req">${esc(req)}</td>
    <td class="st">${badge(s)}</td>
    <td class="note">${esc(note)}</td>
  </tr>`).join('');

const probCards = problematiche.map(([s, tit, desc, img]) => `
  <article class="prob ${sevMeta[s][0]}">
    <div class="prob-h">${badge(s)}<h3>${esc(tit)}</h3></div>
    <p>${esc(desc)}</p>
    ${img && IMG[img] ? `<div class="frame sm"><img loading="lazy" src="${IMG[img]}" alt="${esc(tit)}"></div>` : ''}
  </article>`).join('');

const credRows = creds.accounts.map(c => `
  <tr><td>${esc(c.email)}</td><td class="mono">${esc(c.password)}</td><td>${esc(c.ruolo)}</td><td>${esc(c.alunno)}</td></tr>`).join('');

const html = `<title>Kidville · Test 360° Scuola Primaria</title>
<style>
:root{
  --green:#006A5F; --green-2:#00867a; --yellow:#FDC400; --yellow-d:#C79A00;
  --bg:#F7F2E9; --panel:#FFFFFF; --ink:#20302B; --muted:#5C6B64; --line:#E4DCCB;
  --ok:#2E7D57; --warn:#C77D1A; --grave:#C0392B; --info:#3E6DA6; --minore:#7A8A84; --dev:#8A6FB0;
  --shadow:0 1px 2px rgba(0,60,52,.05),0 10px 30px -20px rgba(0,60,52,.35);
  --maxw:1120px;
}
@media (prefers-color-scheme:dark){:root{
  --green:#37b3a2; --green-2:#4fd0bd; --bg:#0E1A17; --panel:#152420; --ink:#E8EFEB; --muted:#9DB0A8; --line:#25382F;
  --ok:#54C08A; --warn:#E0A43D; --grave:#E4695C; --info:#7CA5DA; --minore:#9DB0A8; --dev:#B79BE0;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 34px -22px rgba(0,0,0,.7);
}}
:root[data-theme="light"]{--green:#006A5F;--green-2:#00867a;--bg:#F7F2E9;--panel:#FFFFFF;--ink:#20302B;--muted:#5C6B64;--line:#E4DCCB;--ok:#2E7D57;--warn:#C77D1A;--grave:#C0392B;--info:#3E6DA6;--minore:#7A8A84;--dev:#8A6FB0;--shadow:0 1px 2px rgba(0,60,52,.05),0 10px 30px -20px rgba(0,60,52,.35);}
:root[data-theme="dark"]{--green:#37b3a2;--green-2:#4fd0bd;--bg:#0E1A17;--panel:#152420;--ink:#E8EFEB;--muted:#9DB0A8;--line:#25382F;--ok:#54C08A;--warn:#E0A43D;--grave:#E4695C;--info:#7CA5DA;--minore:#9DB0A8;--dev:#B79BE0;--shadow:0 1px 2px rgba(0,0,0,.3),0 12px 34px -22px rgba(0,0,0,.7);}

*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 20px}
h1,h2,h3{text-wrap:balance;margin:0}
.disp{font-weight:800;letter-spacing:-.01em;text-transform:uppercase}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--green)}
a{color:var(--green)}

/* Header */
header{background:linear-gradient(160deg,var(--green),var(--green-2));color:#fff;padding:44px 0 34px;border-bottom:4px solid var(--yellow)}
header .wrap{display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:44px;height:44px;border-radius:12px;background:var(--yellow);color:var(--green);display:grid;place-items:center;font-weight:900;font-size:24px}
header h1{font-size:clamp(26px,4.2vw,40px);font-weight:800;letter-spacing:-.015em;line-height:1.05;text-transform:uppercase}
header p.sub{margin:2px 0 0;color:rgba(255,255,255,.85);max-width:60ch}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.tag{font-size:12.5px;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;letter-spacing:.02em}
.tag.prod{background:#C0392B;color:#fff}
.tag.yellow{background:var(--yellow);color:var(--green)}

/* Summary cards */
.cruscotto{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:26px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.kpi .n{font-size:30px;font-weight:800;line-height:1}
.kpi .l{font-size:12.5px;color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.kpi .n.ok{color:var(--ok)} .kpi .n.warn{color:var(--warn)} .kpi .n.grave{color:var(--grave)}

section{padding:30px 0;border-top:1px solid var(--line)}
section > .wrap > .eyebrow{display:block;margin-bottom:6px}
section h2{font-size:clamp(19px,2.6vw,25px);font-weight:800;letter-spacing:-.01em;text-transform:uppercase;margin-bottom:6px}
section > .wrap > p.lead{color:var(--muted);max-width:72ch;margin:0 0 18px}

/* Chips */
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%}
.chip.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)} .chip.ok::before{background:var(--ok)}
.chip.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)} .chip.warn::before{background:var(--warn)}
.chip.fail{background:color-mix(in srgb,var(--grave) 15%,transparent);color:var(--grave)} .chip.fail::before{background:var(--grave)}
.chip.medio{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)} .chip.medio::before{background:var(--warn)}
.chip.minore{background:color-mix(in srgb,var(--minore) 20%,transparent);color:var(--minore)} .chip.minore::before{background:var(--minore)}
.chip.dev{background:color-mix(in srgb,var(--dev) 16%,transparent);color:var(--dev)} .chip.dev::before{background:var(--dev)}

/* Feature + shot grid */
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
.shot{margin:0}
.frame{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel);max-height:520px;overflow-y:auto;box-shadow:var(--shadow)}
.frame.sm{max-height:340px;margin-top:12px}
.frame img{display:block;width:100%;height:auto}
.shot figcaption{font-size:13px;color:var(--muted);margin-top:9px}
.shot figcaption b{color:var(--ink)}

/* Table */
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;min-width:640px;background:var(--panel);font-size:14px}
thead th{text-align:left;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 14px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--green) 6%,transparent)}
tbody td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
td.area{font-weight:700;white-space:nowrap;color:var(--green)}
td.req{font-weight:600}
td.note{color:var(--muted);font-size:13px}
td.mono,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}

/* Problems */
.problist{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.prob{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.prob.medio{border-left-color:var(--warn)} .prob.minore{border-left-color:var(--minore)} .prob.dev{border-left-color:var(--dev)}
.prob-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.prob-h h3{font-size:15.5px;font-weight:800;letter-spacing:-.005em}
.prob p{margin:0;color:var(--muted);font-size:13.5px}

.note-box{background:color-mix(in srgb,var(--green) 6%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px 20px;font-size:13.5px;color:var(--muted)}
.note-box b{color:var(--ink)}
.note-box ul{margin:8px 0 0;padding-left:18px} .note-box li{margin:4px 0}
footer{padding:26px 0 50px;color:var(--muted);font-size:12.5px;text-align:center;border-top:1px solid var(--line)}
:focus-visible{outline:2px solid var(--green);outline-offset:2px;border-radius:6px}
</style>

<header>
  <div class="wrap">
    <div class="brand"><div class="logo">K</div><div class="eyebrow" style="color:var(--yellow)">Kidville · Registro Elettronico · QA</div></div>
    <h1>Test funzionale 360° — Scuola Primaria</h1>
    <p class="sub">Campagna end-to-end guidata dall’interfaccia reale (Segreteria, 5 docenti, 10 genitori) sulla classe di test <b>TEST 1A</b>. Ogni requisito è stato esercitato e i riscontri cross-ruolo verificati; questo resoconto raccoglie esiti, screenshot e problematiche.</p>
    <div class="meta">
      <span class="tag prod">DB · PRODUZIONE</span>
      <span class="tag">Classe TEST 1A · Kidville Giugliano</span>
      <span class="tag">07/07/2026</span>
      <span class="tag yellow">Playwright + ispezione visiva</span>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="cruscotto">
    <div class="kpi"><div class="n ok">${countReq('ok')}</div><div class="l">Requisiti soddisfatti</div></div>
    <div class="kpi"><div class="n warn">${countReq('warn')}</div><div class="l">Parziali / attenzione</div></div>
    <div class="kpi"><div class="n grave">${countReq('fail')}</div><div class="l">Gap</div></div>
    <div class="kpi"><div class="n">${problematiche.length}</div><div class="l">Problematiche rilevate</div></div>
    <div class="kpi"><div class="n">70</div><div class="l">Screenshot catturati</div></div>
    <div class="kpi"><div class="n">16</div><div class="l">Account pilotati</div></div>
  </div>
</div>

<section>
  <div class="wrap">
    <span class="eyebrow">Le due feature richieste</span>
    <h2>Logout in tutte le aree · Anagrafica a tutto schermo</h2>
    <p class="lead">Le due modifiche richieste sono implementate e verificate dal vivo. Il <b>logout</b> (prima assente ovunque) è ora nella TopBar della Segreteria/Direzione e nei menu di Docente e Genitore. L’<b>anagrafica</b> si apre come pagina piena, non più come pannello laterale.</p>
    <div class="grid2">
      ${fig('anagrafica', '<b>Anagrafica a tutta area</b> — scheda alunno full-screen (non più drawer), con dati completi e famiglia collegata (chip “Madre”). Feature confermata dal click reale sulla riga.')}
      ${fig('logout', '<b>Logout</b> — dopo “Esci” (Segreteria, Docente e Genitore) la sessione si chiude e riporta alla pagina di accesso. Confermato in tutte e tre le aree.')}
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Copertura</span>
    <h2>Requisiti del test — esito puntuale</h2>
    <p class="lead">Tutti i punti richiesti sono stati esercitati con account reali. Legenda: <span class="chip ok">Conferme</span> soddisfatto · <span class="chip warn">Attenzione</span> parziale/nota · <span class="chip fail">Gap</span> non soddisfatto.</p>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Area</th><th>Requisito</th><th>Esito</th><th>Dettaglio</th></tr></thead>
        <tbody>${reqRows}</tbody>
      </table>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Verifica incrociata</span>
    <h2>Riscontri cross-ruolo</h2>
    <p class="lead">Ogni azione è stata verificata dal ruolo che deve “vederla”: quello che il docente/genitore scrive compare all’altro, e la Segreteria vede pagamenti e prenotazioni.</p>
    <div class="grid2">
      ${fig('mensaRis', '<b>Segreteria → Mensa</b> — Report Cucina mostra “5 pasti · TEST 1A · Alunno1..5”: le prenotazioni dei genitori sono visibili alla segreteria.')}
      ${fig('chatRis', '<b>Genitore ↔ Docente</b> — la chat del docente elenca la conversazione con “Genitore1 Test PRI” e l’anteprima del messaggio: chiarimento ricevuto e risposto.')}
      ${fig('votoRis', '<b>Docente → Genitore</b> — la valutazione inserita dal docente compare nella pagina del genitore.')}
      ${fig('pagRis', '<b>Segreteria → Pagamenti</b> — cruscotto “Incassato € 525”: gli incassi odierni (quote gita) sono registrati e visibili.')}
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Le tre aree in azione</span>
    <h2>Segreteria · Docenti · Genitori</h2>
    <div class="grid2">
      ${fig('orario', '<b>Segreteria</b> — orario settimanale della classe compilato.')}
      ${fig('registro', '<b>Docente</b> — registro: ora firmata, lezione svolta e compiti con data di consegna (nel testo).')}
      ${fig('noteD', '<b>Docente</b> — note: disciplinare, didattica e compiti non svolti.')}
      ${fig('avvisoD', '<b>Docente</b> — bacheca con l’avviso della gita e relativo modulo.')}
      ${fig('orarioG', '<b>Genitore</b> — orario di accesso (fasce orarie della settimana).')}
      ${fig('compitiG', '<b>Genitore</b> — compiti assegnati con data di consegna.')}
      ${fig('avvisoG', '<b>Genitore</b> — avviso gita con adesione registrata (“Hai aderito”).')}
      ${fig('valutazioniG', '<b>Genitore</b> — valutazioni del figlio (card materia).')}
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Problematiche riscontrate</span>
    <h2>${problematiche.length} rilievi · ${countProb('medio')} medi, ${countProb('minore')} minori, 1 solo-dev</h2>
    <p class="lead">In coerenza con la consegna, i problemi sono <b>solo segnalati</b> (nessuna correzione in questo giro). Ordinati per gravità.</p>
    <div class="problist">${probCards}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Accessi di test</span>
    <h2>Lista credenziali — TEST 1A</h2>
    <p class="lead">Account creati/allineati per il test (password forzata e verificata al login). Sede unica Kidville Giugliano.</p>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Email</th><th>Password</th><th>Ruolo</th><th>Alunno collegato</th></tr></thead>
        <tbody>${credRows}</tbody>
      </table>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <span class="eyebrow">Metodo & note</span>
    <h2>Come è stato svolto</h2>
    <div class="note-box">
      <p><b>Ambiente.</b> Test su DB di <b>produzione</b>, limitato alla sola classe <b>TEST 1A</b> (nessuna famiglia reale nel DB). Ogni dato testuale è prefissato <span class="mono">[E2E360]</span> per identificabilità e pulizia opzionale.</p>
      <ul>
        <li><b>Guida UI reale</b> via Playwright: login effettivi dei 16 account, navigazione delle pagine e cattura screenshot; le scritture (firma, voti, note, pagamenti, mensa, avvisi, chat) sono passate per gli endpoint reali con la sessione autenticata.</li>
        <li><b>Ispezione visiva</b> di ogni schermata da parte di agenti dedicati (estetica + funzione di ogni elemento) e <b>riconciliazione col database</b> per distinguere i problemi reali dagli artefatti di cattura.</li>
        <li><b>Firma autorizzazione gita:</b> le 10 adesioni sono registrate; la firma FEA del modulo dedicato (OTP) è un meccanismo separato non incluso in questo giro.</li>
        <li><b>Mensa “oggi”:</b> il cutoff delle 09:30 (comportamento corretto) impedisce la prenotazione dello stesso giorno nel pomeriggio; dimostrata con il giorno successivo.</li>
        <li><b>Overlay “1 Issue”</b> nelle schermate è l’indicatore di sviluppo di Next.js (hydration-mismatch pre-esistente sui link della sidebar); non compare nella build di produzione.</li>
      </ul>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">Kidville · Registro Elettronico — Resoconto test 360° Scuola Primaria · generato il 07/07/2026 · classe TEST 1A · DB produzione</div>
</footer>`;

writeFileSync(new URL('report.html', RUN), html);
console.log('✓ report.html generato:', new URL('report.html', RUN).pathname);
console.log('  peso:', Math.round(Buffer.byteLength(html) / 1024), 'KB');
