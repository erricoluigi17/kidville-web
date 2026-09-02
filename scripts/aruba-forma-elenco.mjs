#!/usr/bin/env node
/**
 * Che FORMA ha l'elenco delle fatture emesse che Aruba ci restituisce? Sola lettura.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────────────
 * Il 2026-09-02, dalla schermata Contabilità di Kidville Aversa, l'emissione di una fattura
 * si è fermata con «Impossibile leggere l'ultimo numero della serie FPR da Aruba». Il log di
 * produzione dice esattamente cosa è successo, e non è nessuna delle spiegazioni comode:
 *
 *     aruba:signin           → 200
 *     aruba:findByUsername   → 200, 3311 documenti nell'anno 2026
 *     lettura del progressivo → ERRORE: nessuna etichetta nella forma attesa
 *                               «FPR <numero>/<anno>», primo valore non riconosciuto «(vuoto)»
 *
 * Cioè: Aruba risponde bene, i documenti arrivano, e il campo da cui leggiamo il numero
 * (`inv.number`, src/lib/aruba/client.ts:479) è `null`/`undefined` su tutti e 3.311.
 *
 * Il punto è che quella forma NON è mai stata misurata da questo repository. I test la
 * costruiscono da sé — `{ invoices: numeri.map(n => ({ number: n })) }` — quindi assumono
 * la risposta che dovrebbero dimostrare, e restano verdi qualunque cosa faccia Aruba.
 *
 * ─── L'ESPERIMENTO ──────────────────────────────────────────────────────────────────────
 * Fra `scripts/aruba-campioni.mjs`, che nell'agosto 2026 lesse correttamente «Asilo 2328/2026»,
 * e il codice di prodotto ci sono esattamente DUE differenze. Questo script le incrocia:
 *
 *        │ size=100          size=500
 *   ─────┼──────────────────────────────────
 *   senza│ A (lo script che   B
 *   vatc.│    funzionava)
 *   con  │ C                  D (il prodotto)
 *   vatc.│
 *
 *   · A/C leggono e B/D no  → il colpevole è `size`
 *   · A/B leggono e C/D no  → il colpevole è `vatcodeSender`
 *   · nessuna cella legge   → Aruba ha rinominato o tolto il campo, e le chiavi lo dicono
 *
 * ─── COSA STAMPA, E COSA NON STAMPERÀ MAI ───────────────────────────────────────────────
 * Questo repository è PUBBLICO e quei documenti sono intestati a genitori di minori reali.
 * Perciò si stampano soltanto:
 *   · i NOMI delle chiavi (`Object.keys`) — nomi di campo, non contenuti;
 *   · il VALORE solo delle chiavi che hanno la forma di un numero di documento
 *     (`FPR 1947/26`, `Asilo 2328/2026`, `1947`): non sono dati personali, sono il dato
 *     che stiamo cercando;
 *   · per tutte le altre chiavi: tipo e lunghezza, mai il contenuto.
 * Le credenziali si leggono da .env.local e non vengono mai stampate.
 *
 * ⚠️ Aruba strozza a ~60 richieste l'ora (leaky bucket) e il 429 arriva come pagina HTML, non
 * come JSON. Questo script fa 1 signin + 4 GET, con una pausa fra l'una e l'altra.
 *
 * USO
 *   node scripts/aruba-forma-elenco.mjs [--anno 2026] [--piva 03394870616]
 *
 * Senza `--piva` le celle C e D vengono saltate (servono la partita IVA del cedente, che è
 * quella che il prodotto passa come `vatcodeSender`).
 */
import { readFileSync } from 'node:fs';

const WS = 'https://ws.fatturazioneelettronica.aruba.it';
const AUTH = 'https://auth.fatturazioneelettronica.aruba.it';

/** Quanto si aspetta fra una chiamata e l'altra, per non riempire il secchio. */
const PAUSA_MS = 2500;

/**
 * La forma di un numero di documento: `FPR 1947/26`, `Asilo 2328/2026`, o il progressivo
 * nudo `1947`. Larga di proposito — qui non si sta validando, si sta CERCANDO: se una
 * chiave qualsiasi contiene qualcosa che somiglia a un numero di fattura, voglio vederla.
 */
const FORMA_NUMERO = /^[A-Za-z ]{0,12}\d{1,9}\s*\/?\s*\d{0,4}$/;

function caricaEnvLocale() {
    let testo;
    try {
        testo = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    } catch { return; }
    for (const riga of testo.split('\n')) {
        const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m || process.env[m[1]] !== undefined) continue;
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
}

function argomento(nome, predefinito) {
    const i = process.argv.indexOf(`--${nome}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : predefinito;
}

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

async function signin(username, password) {
    const res = await fetch(`${AUTH}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', username, password }).toString(),
    });
    if (!res.ok) throw new Error(`signin HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return String((await res.json()).access_token ?? '');
}

/**
 * Il ritratto di un elemento dell'elenco, senza dati personali.
 *
 * Per ogni chiave: se il valore ha la forma di un numero di documento lo stampa (è il dato
 * che cerchiamo, e non identifica nessuno); altrimenti stampa tipo e lunghezza. `null` e
 * `undefined` si distinguono, perché è esattamente la differenza che ha prodotto «(vuoto)».
 */
function ritratto(inv, indent = '  ', profondita = 0) {
    if (inv === null || typeof inv !== 'object') {
        return `${indent}⚠️  l'elemento NON è un oggetto: ${inv === null ? 'null' : typeof inv}` +
            (typeof inv === 'string' ? ` (${inv.length} car.)` : '');
    }
    const righe = [];
    for (const k of Object.keys(inv).sort()) {
        const v = inv[k];
        if (v === null) { righe.push(`${indent}${k.padEnd(24)} null`); continue; }
        if (v === undefined) { righe.push(`${indent}${k.padEnd(24)} undefined`); continue; }
        if (typeof v === 'object') {
            const forma = Array.isArray(v) ? `array[${v.length}]` : `oggetto{${Object.keys(v).length}}`;
            righe.push(`${indent}${k.padEnd(24)} ${forma}`);
            // Si scende di UN livello, e solo dove può stare il numero. `sender`/`receiver`
            // sono anagrafiche di persone reali: se ne stampano i nomi delle chiavi, mai i
            // valori — ci pensa già la regola di `ritratto`, ma la profondità li tiene fuori
            // dal caso interessante e il repository resta pulito.
            if (profondita === 0) {
                const dentro = Array.isArray(v) ? v[0] : v;
                if (dentro && typeof dentro === 'object') {
                    righe.push(ritratto(dentro, `${indent}    ↳ `, profondita + 1));
                }
            }
            continue;
        }
        const testo = String(v);
        if (FORMA_NUMERO.test(testo.trim())) {
            righe.push(`${indent}${k.padEnd(24)} ${typeof v} → «${testo}»   ← ha la forma di un numero`);
        } else {
            righe.push(`${indent}${k.padEnd(24)} ${typeof v}, ${testo.length} car.`);
        }
    }
    return righe.join('\n');
}

/** Una cella dell'esperimento: una sola chiamata a findByUsername. */
async function cella({ etichetta, token, username, anno, size, vatcodeSender }) {
    const qs = new URLSearchParams({
        username, page: '1', size: String(size),
        startDate: `${anno}-01-01`, endDate: `${anno}-12-31`,
    });
    if (vatcodeSender) qs.set('vatcodeSender', vatcodeSender);

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`${etichetta}   size=${size}   vatcodeSender=${vatcodeSender ? 'SÌ' : 'no'}`);
    console.log('═'.repeat(78));

    const res = await fetch(`${WS}/services/invoice/out/findByUsername?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
        console.log('  429 — Aruba ha strozzato le richieste (~60/ora). Aspetta e rilancia.');
        return { esito: '429' };
    }
    if (!res.ok) {
        console.log(`  HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
        return { esito: `HTTP ${res.status}` };
    }

    const json = await res.json();
    // Le due forme che il prodotto conosce (client.ts:478-479), stampate per com'è andata.
    const env = json.value ?? json;
    const chiaviBusta = env && typeof env === 'object' && !Array.isArray(env) ? Object.keys(env).sort() : null;
    console.log(`  HTTP 200 — busta: ${json.value !== undefined ? 'json.value' : 'json (nudo)'}` +
        (chiaviBusta ? `, chiavi: ${chiaviBusta.join(', ')}` : ', è un array'));

    const invoices = Array.isArray(env) ? env : (env.invoices ?? env.content ?? null);
    if (!Array.isArray(invoices)) {
        console.log('  ⚠️  né `invoices` né `content` sono un array: il prodotto qui leggerebbe [].');
        return { esito: 'nessun array' };
    }
    console.log(`  elementi: ${invoices.length}`);
    if (!invoices.length) return { esito: 'vuoto', elementi: 0 };

    console.log('\n  Primo elemento, campo per campo:');
    console.log(ritratto(invoices[0]));

    // La domanda che conta: quanti elementi hanno un `number` leggibile secondo il prodotto?
    const conNumber = invoices.filter((i) => i && typeof i === 'object' && i.number != null).length;
    // …e quanti ce l'hanno UN LIVELLO PIÙ SOTTO, dentro l'array `invoices` annidato.
    const conNumberAnnidato = invoices.filter((i) => i?.invoices?.[0]?.number != null).length;
    console.log(`\n  → elementi con \`invoices[0].number\` valorizzato: ${conNumberAnnidato}/${invoices.length}` +
        (conNumberAnnidato === invoices.length && invoices.length > 0 ? '   ✅ è QUI' : ''));
    const candidate = invoices[0] && typeof invoices[0] === 'object'
        ? Object.keys(invoices[0]).filter((k) => {
            const v = invoices[0][k];
            return v != null && typeof v !== 'object' && FORMA_NUMERO.test(String(v).trim());
        })
        : [];
    console.log(`\n  → elementi con \`number\` valorizzato: ${conNumber}/${invoices.length}` +
        (conNumber === 0 ? '   ⛔️ è il guasto' : '   ✅'));
    console.log(`  → chiavi candidate a portare il numero: ${candidate.length ? candidate.join(', ') : '(nessuna)'}`);
    return { esito: 'ok', elementi: invoices.length, conNumber, candidate };
}

async function main() {
    caricaEnvLocale();
    const username = process.env.ARUBA_USERNAME;
    const password = process.env.ARUBA_PASSWORD;
    if (!username || !password) {
        console.error('Mancano ARUBA_USERNAME / ARUBA_PASSWORD (ambiente o .env.local).');
        process.exit(1);
    }
    const anno = Number(argomento('anno', String(new Date().getFullYear())));
    const piva = argomento('piva', null);

    console.log(`Anno: ${anno}   ·   utenza: ${username.slice(0, 6)}…   ·   vatcodeSender: ${piva ? `${piva.slice(0, 4)}…` : 'non fornita (celle C e D saltate)'}`);
    console.log('Sola lettura: nessuna fattura viene emessa, nessun dato scritto.');

    const token = await signin(username, password);
    console.log('signin: ok');

    // `--celle A` limita l'esperimento a una sola chiamata: utile quando la matrice ha già
    // dato il suo verdetto e serve solo riguardare la forma senza consumare il secchio.
    const solo = argomento('celle', null);
    let celle = [
        { etichetta: 'A — come lo script che funzionava', size: 100 },
        { etichetta: 'B — solo size cambiato', size: 500 },
    ];
    if (piva) {
        celle.push({ etichetta: 'C — solo vatcodeSender aggiunto', size: 100, vatcodeSender: piva });
        celle.push({ etichetta: 'D — COME IL PRODOTTO', size: 500, vatcodeSender: piva });
    }
    if (solo) celle = celle.filter((c) => solo.includes(c.etichetta[0]));

    const esiti = [];
    for (const c of celle) {
        esiti.push({ etichetta: c.etichetta, ...(await cella({ ...c, token, username, anno })) });
        if (c !== celle[celle.length - 1]) await attendi(PAUSA_MS);
    }

    console.log(`\n${'═'.repeat(78)}\nRIEPILOGO\n${'═'.repeat(78)}`);
    for (const e of esiti) {
        const letto = e.conNumber === undefined ? '—' : `${e.conNumber}/${e.elementi}`;
        console.log(`  ${e.etichetta.padEnd(38)} ${String(e.esito).padEnd(12)} number leggibili: ${letto}`);
    }
    const leggono = esiti.filter((e) => e.conNumber > 0).map((e) => e.etichetta[0]);
    console.log(leggono.length === 0
        ? '\n  ⛔️ NESSUNA cella legge il numero: il campo è stato rinominato o tolto.\n     Guarda le «chiavi candidate» qui sopra: è lì che sta il nome nuovo.'
        : `\n  ✅ Leggono il numero le celle: ${leggono.join(', ')} — la differenza fra queste e le altre È la causa.`);
}

main().catch((e) => { console.error('\nErrore:', e.message); process.exit(1); });
