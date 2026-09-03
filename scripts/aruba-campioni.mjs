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
 *   · quante fatture per sezionale (un file può portarne più d'una) e qual è il numero PIÙ
 *     ALTO di ciascuna FRA QUELLE LETTE. ⚠️ NON è il massimo della serie: `elenco` legge al
 *     più `maxPagine` × 100 documenti (600, contro i 3.311 del 2026 misurati il 2026-09-02),
 *     si ferma al tetto, dopo un 429 prosegue con ciò che ha, e nessuno ha mai verificato in
 *     che ORDINE Aruba restituisca l'elenco. Il massimo vero lo legge il PRODOTTO
 *     (`arubaUltimiNumeriFattura` in `src/lib/aruba/client.ts`, che scorre tutte le pagine):
 *     questo numero serve a un confronto di massima, mai a inizializzare una serie;
 *   · la distribuzione degli stati SDI, comprese le SCARTATE, che sono l'elenco degli errori
 *     che il software non deve ereditare.
 *
 * NOTA SUL .p7m. Aruba firma i documenti (CAdES): `getByFilename` restituisce l'involucro
 * PKCS#7, non l'XML nudo. L'XML si estrae con `openssl cms -verify -noverify` (vedi
 * `estraiXml`), senza verificare la firma — a noi serve il contenuto, non la prova
 * crittografica. NON affettando la stringa fra `<?xml` e il tag di chiusura: i blocchi BER a
 * lunghezza indefinita spezzano il testo e producono un XML corrotto che a occhio sembra sano.
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
/** Una ogni cinque secondi: il limite pubblicato per le ricerche è 12 al minuto per IP. */
const PAUSA_MS = 5000;

/**
 * Elenco dei DOCUMENTI emessi nell'anno.
 *
 * ─── LA FORMA VERA, MISURATA IL 2026-09-02 ─────────────────────────
 * `findByUsername` risponde con una PAGINA Spring Data — `{ content, number, size,
 * numberOfElements, totalElements, totalPages, first, last }` — e i suoi elementi NON sono
 * fatture: sono DOCUMENTI (`filename`, `idSdi`, `docType`, `sender`, `receiver`), ognuno con
 * le proprie fatture in un array ANNIDATO. Numero e stato stanno lì dentro:
 *
 *     content[i].invoices[j].number  ===  «Asilo 2327/2026»
 *     content[i].invoices[j].status
 *
 * ⚠️ `number` esiste anche sulla BUSTA, ma è il numero di PAGINA: non è un progressivo.
 * Questo script guardava `env.invoices` per primo e poi `f.number` sul documento: su 3.311
 * documenti del 2026 quel campo era `undefined` su tutti e 3.311, e le misure che stampa
 * (massimo per sezionale, distribuzione degli stati) sarebbero uscite tutte vuote.
 *
 * ⚠️ ARUBA STROZZA LE RICHIESTE, e lo fa presto. Limiti PUBBLICATI (SLA §3 di
 * https://fatturazioneelettronica.aruba.it/apidoc/docs.html, per IP e al minuto): ricerca
 * fatture 12, upload 30, autenticazione 1; leaky bucket, rifiuto immediato con **429 e una
 * pagina HTML** (non JSON: chi si aspetta un errore strutturato non capisce cosa è successo),
 * nessun `Retry-After` documentato (gli header del 429 misurato il 2026-09-02 non sono mai
 * stati registrati). Il «~60 all'ora» che questo file citava è il Tier 0 degli UPLOAD
 * riusciti (§7.3) e non riguarda le ricerche. Perciò: pagine piccole, `PAUSA_MS` fra una
 * richiesta e l'altra (12 al minuto = una ogni 5 s), tetto basso di pagine, e un messaggio
 * esplicito sul 429.
 *
 * La stessa lezione vale per il PRODOTTO, non solo per questo script: leggere da Aruba
 * l'ultimo numero prima di OGNI fattura significa una chiamata per documento, e un'emissione
 * massiva verrebbe interrotta a metà. Si legge una volta per LOTTO.
 *
 * Restituisce `{ documenti, totale }`: `totale` è `totalElements` della busta, così chi legge
 * l'uscita vede quanto dell'anno è rimasto fuori.
 */
async function elenco(token, username, anno, maxPagine = 6) {
    const documenti = [];
    let totale = null; // `totalElements` della busta (docs §4): quanti documenti ha l'anno, non quanti ne leggiamo
    for (let pagina = 1; pagina <= maxPagine; pagina++) {
        const qs = new URLSearchParams({
            username, page: String(pagina), size: '100',
            startDate: `${anno}-01-01`, endDate: `${anno}-12-31`,
        });
        const res = await fetch(`${WS}/services/invoice/out/findByUsername?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 429) {
            console.error('\n⚠️  429: Aruba ha strozzato le richieste (ricerche: 12 al minuto per IP, leaky bucket).');
            console.error('    Aspetta qualche minuto e rilancia. I documenti già letti:', documenti.length);
            if (!documenti.length) process.exit(1);
            break;
        }
        if (!res.ok) throw new Error(`findByUsername HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const j = await res.json();
        const env = j.value ?? j;
        // Solo un numero vero: `Number(null)` e `Number('')` valgono 0 e avrebbero fatto
        // dire «letti N su 0» senza far scattare l'avviso sul campione parziale.
        if (totale === null && typeof env.totalElements === 'number' && Number.isFinite(env.totalElements)) totale = env.totalElements;
        // `content` è la forma MISURATA (docs §4). `invoices` in cima NON è documentata: era la
        // forma che questo file INVENTAVA fino al 2026-09-02 e resta solo come ripiego, da
        // togliere il giorno in cui si misura che non serve. In entrambi i casi gli elementi
        // sono DOCUMENTI.
        const dellaPagina = env.content ?? env.invoices;
        if (!Array.isArray(dellaPagina)) {
            // Le CHIAVI, mai i valori: dicono dov'è finito l'elenco senza mostrare nessuno.
            console.log(`⚠ pagina ${pagina}: nessun elenco in «content» né in «invoices»; chiavi: ${Object.keys(env).join(', ')}`);
            break;
        }
        if (!dellaPagina.length) break;
        documenti.push(...dellaPagina);
        if (dellaPagina.length < 100) break;
        await attendi(PAUSA_MS);
    }
    return { documenti, totale };
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

/**
 * Le fatture contenute in UN documento dell'elenco, ciascuna col `filename` del documento
 * che la porta — perché il download è `getByFilename`, e il nome del file sta sul documento
 * mentre numero e stato stanno sulla fattura annidata.
 *
 * ⚠️ `invoices` è un ARRAY: il tracciato FatturaPA ammette più `FatturaElettronicaBody`
 * nello stesso file. Sul campione vero ce n'era sempre uno solo, ma fermarsi a `[0]` sarebbe
 * assumere un'altra volta qualcosa che non è stato misurato — ed è l'errore che ha prodotto
 * il guasto del 2026-09-02. Il ramo senza `invoices` resta per un elenco già piatto.
 */
function fattureDelDocumento(doc) {
    if (!doc || typeof doc !== 'object') return [];
    const filename = doc.filename ?? doc.uploadFileName ?? doc.fileName ?? null;
    const dentro = Array.isArray(doc.invoices) ? doc.invoices : [doc];
    return dentro
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({ numero: f.number ?? null, stato: f.status ?? f.state ?? null, filename }));
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
    const { documenti, totale } = await elenco(token, username, anno);
    const fatture = documenti.flatMap(fattureDelDocumento);
    const suTotale = totale === null ? ' (totale non dichiarato dalla busta)' : ` su ${totale}`;
    console.log(`Documenti ${anno} letti dall'API: ${documenti.length}${suTotale} — fatture dentro: ${fatture.length}`);
    if (totale === null || documenti.length < totale) {
        // Il massimo di un CAMPIONE non è il massimo della serie: detto qui, dove si legge
        // l'uscita, e non solo nella testata.
        console.error(`⚠️  Letti ${documenti.length} documenti${suTotale}: i massimi qui sotto sono di un CAMPIONE, non della serie. Il massimo vero lo legge il prodotto, che scorre tutte le pagine.`);
    }

    // Misure aggregate — nessun dato personale.
    const perSez = {};
    for (const f of fatture) {
        const s = sezionaleDi(f.numero);
        const p = progressivoDi(f.numero);
        perSez[s] ??= { quanti: 0, massimo: 0, esempio: null };
        perSez[s].quanti++;
        if (Number.isFinite(p) && p > perSez[s].massimo) { perSez[s].massimo = p; perSez[s].esempio = f.numero; }
    }
    console.log('\nPer sezionale (massimo FRA LE FATTURE LETTE: un confronto di massima, NON il tetto della serie):');
    for (const [s, v] of Object.entries(perSez)) {
        // «fatture» e non «documenti»: dopo l'appiattimento si conta ciò che ha un numero,
        // e un solo file può portarne più d'una.
        console.log(`  ${s.padEnd(16)} ${String(v.quanti).padStart(5)} fatture   max ${v.massimo}   es. "${v.esempio}"`);
    }
    const perStato = {};
    for (const f of fatture) perStato[String(f.stato ?? '?')] = (perStato[String(f.stato ?? '?')] || 0) + 1;
    console.log(`\nPer stato SDI: ${JSON.stringify(perStato)}`);

    // Campionamento: uno per sezionale, più i primi documenti diversi per stato.
    // Si sceglie per FILE e non per fattura: `getByFilename` scarica il documento intero, e
    // due fatture dello stesso file costerebbero due chiamate identiche su un'API che strozza.
    const scelti = [];
    const giaScelti = new Set();
    const aggiungi = (f) => {
        if (!f || !f.filename || giaScelti.has(f.filename)) return;
        giaScelti.add(f.filename);
        scelti.push(f);
    };
    for (const s of Object.keys(perSez)) aggiungi(fatture.find(x => sezionaleDi(x.numero) === s));
    for (const f of fatture) {
        if (scelti.length >= quanti) break;
        aggiungi(f);
    }

    mkdirSync(out, { recursive: true });
    console.log(`\nScarico ${scelti.length} campioni in ${out}`);
    const indice = [];
    for (const [i, f] of scelti.entries()) {
        const { grezzo, errore } = await scarica(token, f.filename);
        await attendi(PAUSA_MS); // vedi la nota sul 429 in `elenco`
        if (errore) { console.log(`  ${i + 1}. ${f.numero} — ${errore}`); continue; }
        const xml = estraiXml(grezzo);
        if (!xml) { console.log(`  ${i + 1}. ${f.numero} — XML non estratto dall'involucro`); continue; }
        const dest = join(out, `campione-${String(i + 1).padStart(2, '0')}.xml`);
        writeFileSync(dest, xml, 'utf8');
        console.log(`  ${i + 1}. ${f.numero} → ${dest} (${xml.length} byte)`);
        indice.push({ numero: f.numero, stato: f.stato, file: dest });
    }
    writeFileSync(join(out, 'indice.json'), JSON.stringify(indice, null, 2), 'utf8');
    console.log('\nFatto. Ricorda: questi file NON entrano nel repository.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
