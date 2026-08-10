#!/usr/bin/env node
/**
 * Collauda il percorso di INVIO ad Aruba senza che l'emissione di un documento vero sia
 * fisicamente possibile.
 *
 * ─── IL PROBLEMA, DETTO ONESTAMENTE ─────────────────────────────────────────────
 * `dryRun: true` esiste nelle API v2 di Aruba e la documentazione dice: «la fattura
 * attraverserà le fasi di validazione ma non verrà inviata a SdI». Bene. Ma **non si può
 * dimostrare che venga rispettato su un documento valido senza rischiare, se non lo fosse,
 * di emetterne uno vero** — e una fattura partita è partita: si corregge solo con una nota
 * di variazione.
 *
 * ─── LA SOLUZIONE: RENDERE IL DANNO IMPOSSIBILE, NON IMPROBABILE ────────────────
 * Il documento che si carica ha un `CedentePrestatore` con una **partita IVA diversa dalla
 * nostra**. Serve a una cosa sola: qualunque cosa faccia `dryRun`, un documento che non è
 * intestato alla cooperativa **non può diventare una fattura della cooperativa**. Aruba lo
 * rifiuta in modo sincrono (il mittente non corrisponde all'utenza) e lo SdI lo rifiuterebbe
 * comunque (chi trasmette non è autorizzato per quella partita IVA).
 * Così si esercita tutto il percorso — autenticazione, serializzazione, upload, lettura della
 * risposta e del suo CORPO — senza che l'esito peggiore sia un documento fiscale.
 *
 * Alla fine ricontrolla l'elenco delle fatture inviate: se il conteggio è cambiato, lo dice.
 *
 * USO
 *   node scripts/collaudo/upload-dryrun.mjs <percorso-di-un-xml-valido>
 *
 * Credenziali da ARUBA_USERNAME / ARUBA_PASSWORD (ambiente o .env.local). Mai stampate.
 */
import { readFileSync } from 'node:fs';

const AUTH = 'https://auth.fatturazioneelettronica.aruba.it';
const WS = 'https://ws.fatturazioneelettronica.aruba.it';
const PIVA_NOSTRA = '03394870616';
/**
 * Una partita IVA formalmente valida ma NON nostra. `00000000000` verrebbe rifiutata dallo
 * schema prima ancora di arrivare al controllo sul mittente, e il collaudo non misurerebbe
 * il pezzo che interessa. Questa supera il formato e fallisce sul mittente: esattamente dove
 * vogliamo che fallisca.
 */
const PIVA_ESTRANEA = '01234567897';

function caricaEnvLocale() {
    try {
        const testo = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8');
        for (const riga of testo.split('\n')) {
            const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
            if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* assente: si usano le sole variabili d'ambiente */ }
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

async function quanteInviate(token, username, anno) {
    const qs = new URLSearchParams({ username, page: '1', size: '5', startDate: `${anno}-01-01`, endDate: `${anno}-12-31` });
    const res = await fetch(`${WS}/services/invoice/out/findByUsername?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return `(non leggibile: HTTP ${res.status})`;
    const j = await res.json();
    const env = j.value ?? j;
    return (env.invoices ?? env.content ?? []).length;
}

async function main() {
    caricaEnvLocale();
    const username = process.env.ARUBA_USERNAME;
    const password = process.env.ARUBA_PASSWORD;
    const percorso = process.argv[2];
    if (!username || !password) { console.error('Mancano ARUBA_USERNAME / ARUBA_PASSWORD.'); process.exit(1); }
    if (!percorso) { console.error('Serve il percorso di un XML valido.'); process.exit(1); }

    let xml = readFileSync(percorso, 'utf8');
    if (!xml.includes(PIVA_NOSTRA)) {
        console.error(`L'XML non contiene la nostra partita IVA: non è il documento atteso.`);
        process.exit(1);
    }
    // La sostituzione è ciò che rende il collaudo innocuo. Se un giorno qualcuno la togliesse
    // «per provare davvero», starebbe emettendo una fattura vera.
    xml = xml.replaceAll(PIVA_NOSTRA, PIVA_ESTRANEA);
    console.log(`documento reso INNOCUO: cedente ${PIVA_NOSTRA} → ${PIVA_ESTRANEA}`);

    const token = await signin(username, password);
    console.log('✓ signin');

    const anno = new Date().getFullYear();
    const prima = await quanteInviate(token, username, anno);

    const res = await fetch(`${WS}/services/invoice/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
            dataFile: Buffer.from(xml, 'utf-8').toString('base64'),
            senderPIVA: PIVA_ESTRANEA,
            skipExtraSchema: false,
            dryRun: true,
        }),
    });
    const testo = await res.text();
    console.log(`\nupload → HTTP ${res.status}`);
    console.log(`corpo: ${testo.slice(0, 700)}`);

    const dopo = await quanteInviate(token, username, anno);
    console.log(`\nfatture nell'elenco: prima ${prima} · dopo ${dopo}`);
    if (prima === dopo) console.log('✓ NESSUN documento nuovo: niente è partito.');
    else console.log('⚠️ il conteggio è CAMBIATO: verificare subito sul pannello.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
