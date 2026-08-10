#!/usr/bin/env node
/**
 * Ricognizione delle fatture GIÀ EMESSE su Aruba, via API ufficiale. Sola lettura.
 *
 * PERCHÉ ESISTE. Le fatture che l'app emetterà devono uscire **identiche** a quelle che la
 * segreteria scrive a mano da diciotto mesi. L'unico modo onesto di garantirlo è leggere i
 * tracciati veri e confrontarli campo per campo, invece di dedurli da un'anteprima grafica.
 *
 * DOVE FINISCONO I FILE, E PERCHÉ NON NEL REPOSITORY. Gli XML contengono nomi e codici fiscali
 * di **minori reali** e dei loro genitori. Il repository è PUBBLICO. Quindi i campioni vengono
 * scritti in una cartella FUORI dal repo (lo scratchpad di sessione, passato con --out), si
 * leggono lì, e nel repo entra soltanto una fixture SINTETICA derivata: la struttura, mai le
 * persone. Non esiste un'anonimizzazione «abbastanza buona» da giustificare il contrario.
 *
 * COSA MISURA, oltre a scaricare:
 *   · quanti documenti per sezionale e qual è il numero PIÙ ALTO di ciascuno — è il dato che
 *     la numerazione dell'app deve rispettare per non collidere con le serie fiscali vere;
 *   · la distribuzione degli stati SDI, comprese le SCARTATE, che sono l'elenco degli errori
 *     che il software non deve ereditare.
 *
 * NOTA SUL .p7m. Aruba firma i documenti (CAdES): `getByFilename` restituisce l'involucro
 * PKCS#7, non l'XML nudo. L'XML si estrae senza verificare la firma — a noi serve il
 * contenuto, non la prova crittografica: si cerca il primo `<?xml` e l'ultimo tag di chiusura.
 *
 * USO
 *   node scripts/aruba-campioni.mjs --out /percorso/cartella [--anno 2026] [--quanti 6]
 *
 * Credenziali da ARUBA_USERNAME / ARUBA_PASSWORD (ambiente o .env.local). Mai stampate.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const WS = 'https://ws.fatturazioneelettronica.aruba.it';
const AUTH = 'https://auth.fatturazioneelettronica.aruba.it';

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

async function signin(username, password) {
    const res = await fetch(`${AUTH}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', username, password }).toString(),
    });
    if (!res.ok) throw new Error(`signin HTTP ${res.status}: ${await res.text()}`);
    return String((await res.json()).access_token ?? '');
}

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Elenco delle fatture emesse nell'anno.
 *
 * ⚠️ ARUBA STROZZA LE RICHIESTE, e lo fa presto: tier base ~60 richieste l'ora, algoritmo
 * leaky bucket, risposta **429 con una pagina HTML** (non JSON: chi si aspetta un errore
 * strutturato non capisce cosa è successo). Perciò: pagine piccole, una pausa fra l'una e
 * l'altra, tetto basso di pagine, e un messaggio esplicito sul 429.
 *
 * La stessa lezione vale per il PRODOTTO, non solo per questo script: leggere da Aruba
 * l'ultimo numero prima di OGNI fattura significa una chiamata per documento, e un'emissione
 * massiva verrebbe interrotta a metà. Si legge una volta per LOTTO.
 */
async function elenco(token, username, anno, maxPagine = 6) {
    const tutte = [];
    for (let pagina = 1; pagina <= maxPagine; pagina++) {
        const qs = new URLSearchParams({
            username, page: String(pagina), size: '100',
            startDate: `${anno}-01-01`, endDate: `${anno}-12-31`,
        });
        const res = await fetch(`${WS}/services/invoice/out/findByUsername?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 429) {
            console.error('\n⚠️  429: Aruba ha strozzato le richieste (tier base ~60/ora).');
            console.error('    Aspetta qualche minuto e rilancia. I documenti già letti:', tutte.length);
            if (!tutte.length) process.exit(1);
            break;
        }
        if (!res.ok) throw new Error(`findByUsername HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const j = await res.json();
        const env = j.value ?? j;
        const inv = env.invoices ?? env.content ?? [];
        if (!Array.isArray(inv) || !inv.length) break;
        tutte.push(...inv);
        if (inv.length < 100) break;
        await attendi(2500);
    }
    return tutte;
}

/** Il documento firmato, in base64. `includeFile=true` è ciò che restituisce il tracciato. */
async function scarica(token, filename) {
    const qs = new URLSearchParams({ filename, includeFile: 'true', includePdf: 'false' });
    const res = await fetch(`${WS}/services/invoice/out/getByFilename?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { errore: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const j = await res.json();
    const env = j.value ?? j;
    const b64 = env.file ?? env.dataFile ?? env.fileContent ?? null;
    if (!b64) return { errore: `nessun contenuto; chiavi: ${Object.keys(env).join(', ')}` };
    return { grezzo: Buffer.from(String(b64), 'base64') };
}

/**
 * Estrae l'XML dall'involucro PKCS#7 (CAdES) SENZA verificare la firma: a noi serve il contenuto,
 * non la prova crittografica.
 *
 * ⚠️ NON si estrae affettando la stringa fra `<?xml` e il tag di chiusura. Il contenuto CMS è
 * spezzato in **blocchi BER a lunghezza indefinita**, e le intestazioni dei blocchi finiscono
 * dentro il testo spezzando le parole: si ottiene `As<byte>ilo` al posto di `Asilo`, e un XML
 * che sembra giusto a occhio ma è corrotto. Serve un parser vero: `openssl cms`.
 */
function estraiXml(buf) {
    const tmp = join(tmpdir(), `aruba-p7m-${buf.length}-${buf.readUInt32BE(0)}.p7m`);
    writeFileSync(tmp, buf);
    try {
        for (const cmd of ['cms', 'smime']) {
            const r = spawnSync('openssl', [cmd, '-verify', '-noverify', '-inform', 'DER', '-in', tmp], {
                encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
            });
            const uscita = r.stdout?.toString('utf8') ?? '';
            if (r.status === 0 && uscita.includes('<FatturaElettronica')) return uscita;
        }
        return null;
    } finally {
        try { unlinkSync(tmp); } catch { /* il file temporaneo può già non esserci: irrilevante */ }
    }
}

const sezionaleDi = (numero) => (String(numero || '').match(/^([A-Za-z0-9]+)\s/) || [, '(senza prefisso)'])[1];
const progressivoDi = (numero) => {
    const m = String(numero || '').match(/(\d+)\s*\/\s*\d+\s*$/);
    return m ? parseInt(m[1], 10) : NaN;
};

async function main() {
    caricaEnvLocale();
    const username = process.env.ARUBA_USERNAME;
    const password = process.env.ARUBA_PASSWORD;
    if (!username || !password) {
        console.error('Mancano ARUBA_USERNAME / ARUBA_PASSWORD.');
        process.exit(1);
    }
    const out = argomento('out', null);
    if (!out) {
        console.error('Serve --out <cartella FUORI dal repository>: gli XML contengono dati di minori.');
        process.exit(1);
    }
    // La guardia confronta i percorsi RISOLTI, non le sottostringhe: la cartella di lavoro
    // temporanea di una sessione può chiamarsi «…-kidville-web» pur stando in /private/tmp,
    // e un controllo per sottostringa la rifiuterebbe a torto.
    const radiceRepo = resolve(new URL('..', import.meta.url).pathname);
    const destinazione = resolve(out);
    if (destinazione === radiceRepo || destinazione.startsWith(`${radiceRepo}/`)) {
        console.error(`RIFIUTO: --out è dentro il repository (${radiceRepo}), che è pubblico.`);
        console.error('Questi XML contengono nomi e codici fiscali di minori. Scegli una cartella esterna.');
        process.exit(1);
    }
    const anno = Number(argomento('anno', String(new Date().getFullYear())));
    const quanti = Number(argomento('quanti', '6'));

    const token = await signin(username, password);
    const fatture = await elenco(token, username, anno);
    console.log(`Documenti ${anno} letti dall'API: ${fatture.length}`);

    // Misure aggregate — nessun dato personale.
    const perSez = {};
    for (const f of fatture) {
        const s = sezionaleDi(f.number);
        const p = progressivoDi(f.number);
        perSez[s] ??= { quanti: 0, massimo: 0, esempio: null };
        perSez[s].quanti++;
        if (Number.isFinite(p) && p > perSez[s].massimo) { perSez[s].massimo = p; perSez[s].esempio = f.number; }
    }
    console.log('\nPer sezionale (il massimo è il numero che l\'app NON deve riusare):');
    for (const [s, v] of Object.entries(perSez)) {
        console.log(`  ${s.padEnd(16)} ${String(v.quanti).padStart(5)} documenti   max ${v.massimo}   es. "${v.esempio}"`);
    }
    const perStato = {};
    for (const f of fatture) perStato[String(f.state ?? f.status ?? '?')] = (perStato[String(f.state ?? f.status ?? '?')] || 0) + 1;
    console.log(`\nPer stato SDI: ${JSON.stringify(perStato)}`);

    // Campionamento: uno per sezionale, più i primi documenti diversi per stato.
    const scelti = [];
    for (const s of Object.keys(perSez)) {
        const f = fatture.find(x => sezionaleDi(x.number) === s);
        if (f) scelti.push(f);
    }
    for (const f of fatture) {
        if (scelti.length >= quanti) break;
        if (!scelti.includes(f)) scelti.push(f);
    }

    mkdirSync(out, { recursive: true });
    console.log(`\nScarico ${scelti.length} campioni in ${out}`);
    const indice = [];
    for (const [i, f] of scelti.entries()) {
        const nomeFile = f.filename ?? f.uploadFileName ?? f.fileName;
        if (!nomeFile) { console.log(`  ${i + 1}. (senza filename) — salto`); continue; }
        const { grezzo, errore } = await scarica(token, nomeFile);
        await attendi(2500); // vedi la nota sul 429 in `elenco`
        if (errore) { console.log(`  ${i + 1}. ${f.number} — ${errore}`); continue; }
        const xml = estraiXml(grezzo);
        if (!xml) { console.log(`  ${i + 1}. ${f.number} — XML non estratto dall'involucro`); continue; }
        const dest = join(out, `campione-${String(i + 1).padStart(2, '0')}.xml`);
        writeFileSync(dest, xml, 'utf8');
        console.log(`  ${i + 1}. ${f.number} → ${dest} (${xml.length} byte)`);
        indice.push({ numero: f.number, stato: f.state ?? f.status, file: dest });
    }
    writeFileSync(join(out, 'indice.json'), JSON.stringify(indice, null, 2), 'utf8');
    console.log('\nFatto. Ricorda: questi file NON entrano nel repository.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
