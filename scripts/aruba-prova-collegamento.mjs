#!/usr/bin/env node
/**
 * Prova di collegamento ai Web Service di Aruba Fatturazione Elettronica — zero dipendenze.
 *
 * PERCHÉ ESISTE. Il codice di fatturazione (`src/lib/aruba/`) è completo da luglio, ma non è mai
 * stato collegato: la route risponde `503 credenziali-non-configurate` dal 29/07. Prima di
 * scrivere una riga in più bisogna sapere una cosa sola, e non è opinabile: **questo account
 * può parlare con le API, sì o no?**
 *
 * NON BASTA CHE IL LOGIN RIESCA. La documentazione Aruba dice che i Web Service sono riservati
 * alle utenze **Premium** (o alle utenze base collegate a una Premium con delega); il pacchetto
 * base dà solo il pannello web. Un account base può quindi:
 *   · superare il `signin` — perché l'autenticazione è la stessa del pannello;
 *   · e poi ricevere 401/403 alla PRIMA chiamata operativa.
 * Per questo lo script fa DUE passi: si autentica, e poi prova una chiamata vera in sola lettura
 * (`findByUsername`). È il secondo passo a dare la risposta.
 *
 * LA REGOLA DELLA CASA, APPLICATA QUI. `AGENTS.md` §"Logging obbligatorio" nasce da un guasto
 * vero: per mesi nessuna email è arrivata perché il codice registrava «403» senza il corpo della
 * risposta, che diceva *perché*. Questo script stampa **sempre il corpo intero** di ogni errore.
 * Uno status da solo non ha mai spiegato niente a nessuno.
 *
 * LA PASSWORD NON VIENE MAI STAMPATA, in nessun ramo, nemmeno troncata. Viene letta da
 * `ARUBA_PASSWORD` (ambiente o `.env.local`) e passata solo nel corpo della richiesta.
 * Il repository è PUBBLICO: qui non si scrive mai un segreto.
 *
 * USO
 *   node scripts/aruba-prova-collegamento.mjs            # demo, poi produzione
 *   node scripts/aruba-prova-collegamento.mjs demo       # solo ambiente di prova
 *   node scripts/aruba-prova-collegamento.mjs production # solo produzione (NON invia nulla: sola lettura)
 *
 * Esce 0 se almeno un ambiente ha superato ENTRAMBI i passi; 1 altrimenti.
 */
import { readFileSync } from 'node:fs';

const AMBIENTI = {
    demo: {
        auth: 'https://demoauth.fatturazioneelettronica.aruba.it',
        ws: 'https://demows.fatturazioneelettronica.aruba.it',
    },
    production: {
        auth: 'https://auth.fatturazioneelettronica.aruba.it',
        ws: 'https://ws.fatturazioneelettronica.aruba.it',
    },
};

/** Legge `.env.local` senza stamparlo. Non sovrascrive ciò che è già nell'ambiente. */
function caricaEnvLocale() {
    let testo;
    try {
        testo = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    } catch {
        return; // assente: si useranno le sole variabili d'ambiente
    }
    for (const riga of testo.split('\n')) {
        const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, chiave, grezzo] = m;
        if (process.env[chiave] !== undefined) continue;
        process.env[chiave] = grezzo.trim().replace(/^["']|["']$/g, '');
    }
}

/** Corpo della risposta, intero. È il punto di tutto lo script: mai solo lo status. */
async function corpo(res) {
    try {
        const t = await res.text();
        return t || '(corpo vuoto)';
    } catch (e) {
        return `(corpo illeggibile: ${e.message})`;
    }
}

/** Passo 1 — autenticazione. Ritorna il token, oppure null dopo aver spiegato il motivo. */
async function signin({ auth }, username, password) {
    const body = new URLSearchParams({ grant_type: 'password', username, password }).toString();
    let res;
    try {
        res = await fetch(`${auth}/auth/signin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
    } catch (e) {
        console.log(`   ✗ rete: ${e.message}`);
        return null;
    }
    if (!res.ok) {
        console.log(`   ✗ signin HTTP ${res.status} ${res.statusText}`);
        console.log(`     corpo: ${await corpo(res)}`);
        return null;
    }
    const json = JSON.parse(await res.text());
    const scadenza = Number(json.expires_in ?? 0);
    console.log(`   ✓ signin riuscito — token valido ${scadenza}s (${Math.round(scadenza / 60)} min)`);
    console.log(`     refresh_token: ${json.refresh_token ? 'presente' : 'ASSENTE'}`);
    return String(json.access_token ?? '');
}

/**
 * Passo 2 — chiamata operativa in SOLA LETTURA. È questa che distingue un account abilitato
 * ai Web Service da uno che ha solo il pannello: `findByUsername` non invia niente allo SDI,
 * elenca soltanto ciò che è già stato emesso.
 *
 * ─── LA FORMA DELLA RISPOSTA, MISURATA IL 2026-09-02 ───────────────────────────
 * È una PAGINA Spring Data — `{ content, number, size, numberOfElements, totalElements,
 * totalPages, first, last }` — i cui elementi NON sono fatture: sono DOCUMENTI (`filename`,
 * `idSdi`, `sender`, `receiver`), ognuno con le proprie fatture in un array ANNIDATO:
 *
 *     content[i].invoices[j].number  ===  «Asilo 2327/2026»
 *
 * ⚠️ `number` esiste anche sulla busta, ma è il numero di PAGINA. Perciò qui non si contano
 * solo i documenti: si scende in `invoices[]` e si stampa il primo numero letto. Contare gli
 * elementi dimostra che il Web Service risponde; leggere un numero dimostra che sappiamo
 * ancora dove sta — ed è la seconda cosa che il 2026-09-02 non era più vera.
 */
async function provaWebService({ ws }, token, username, anno) {
    const qs = new URLSearchParams({
        username,
        page: '1',
        size: '5',
        startDate: `${anno}-01-01`,
        endDate: `${anno}-12-31`,
    });
    let res;
    try {
        res = await fetch(`${ws}/services/invoice/out/findByUsername?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    } catch (e) {
        console.log(`   ✗ rete: ${e.message}`);
        return false;
    }
    if (!res.ok) {
        console.log(`   ✗ findByUsername HTTP ${res.status} ${res.statusText}`);
        console.log(`     corpo: ${await corpo(res)}`);
        if (res.status === 401 || res.status === 403) {
            console.log('');
            console.log('     ⚠️  Il login funziona ma la chiamata operativa no: è il quadro tipico di');
            console.log('         un\'utenza NON abilitata ai Web Service. I Web Service di Aruba sono');
            console.log('         riservati alle utenze Premium (o alle base collegate con delega).');
            console.log('         Va chiesto ad Aruba l\'attivazione, oppure si valuta un altro tramite.');
        }
        return false;
    }
    const testo = await res.text();
    let j;
    try {
        j = JSON.parse(testo);
    } catch {
        // Qui si arriva solo con un 2xx dal corpo NON JSON: un 429 ha `ok === false` ed è già
        // stato stampato per intero nel ramo qui sopra. Del corpo si mostra un pezzo perché,
        // non essendo JSON, non porta i campi della fattura; un JSON valido invece non si
        // stampa mai — dentro c'è `receiver.fiscalCode`, cioè un genitore vero.
        console.log(`   ⚠ risposta non JSON: ${testo.slice(0, 300)}`);
        return false;
    }
    const env = j.value ?? j;
    // `content` è la forma MISURATA (docs §4). `invoices` in cima NON è documentata: era la
    // forma che questo file INVENTAVA fino al 2026-09-02 e resta solo come ripiego, da
    // togliere il giorno in cui si misura che non serve. In entrambi i casi gli elementi
    // sono DOCUMENTI.
    const elenco = env.content ?? env.invoices;
    // Senza `?? []`: una busta senza elenco deve finire QUI, non diventare un array vuoto
    // che passa il controllo e stampa «0 documenti» come se fosse un dato.
    if (!Array.isArray(elenco)) {
        // Le CHIAVI, mai i valori: dicono dov'è finito l'elenco senza mostrare nessuno.
        console.log(`   ⚠ nessun elenco in «content» né in «invoices»; chiavi: ${Object.keys(env).join(', ')}`);
        return false;
    }
    let fatture = 0;
    let esempio = null;
    for (const doc of elenco) {
        // `invoices` è un ARRAY (più `FatturaElettronicaBody` nello stesso file): si scorre tutto.
        const dentro = Array.isArray(doc?.invoices) ? doc.invoices : [doc];
        for (const f of dentro) {
            if (!f || typeof f !== 'object' || f.number == null) continue;
            fatture++;
            if (esempio === null) esempio = String(f.number);
        }
    }
    console.log(`   ✓ WEB SERVICE ATTIVI — findByUsername ha risposto (${elenco.length} documenti nel campione ${anno}, ${fatture} fatture dentro)`);
    console.log(`     primo numero letto (${env.content ? 'content[].invoices[].number' : 'ripiego: invoices in cima'}): ${esempio ?? '(nessuno)'}`);
    if (elenco.length > 0 && esempio === null) {
        console.log('     ⚠️  documenti letti ma NESSUN numero: la forma è cambiata di nuovo e');
        console.log(`         l'emissione si fermerebbe. Chiavi del primo elemento: ${Object.keys(elenco[0] ?? {}).join(', ')}`);
    }
    return true;
}

async function main() {
    caricaEnvLocale();
    const username = process.env.ARUBA_USERNAME;
    const password = process.env.ARUBA_PASSWORD;

    if (!username || !password) {
        console.error('Mancano le credenziali. Servono, in `.env.local` o nell\'ambiente:');
        console.error('  ARUBA_USERNAME   (lo username dell\'utenza Premium del pannello Fatturazione Elettronica: non è scritto qui, il repository è pubblico)');
        console.error('  ARUBA_PASSWORD   (la password del pannello Fatturazione Elettronica)');
        console.error('');
        console.error('Nessun valore viene stampato da questo script.');
        process.exit(1);
    }

    const richiesti = process.argv[2] ? [process.argv[2]] : ['demo', 'production'];
    const anno = new Date().getFullYear();
    let almenoUno = false;

    console.log('Utenza e password: lette dall\'ambiente, mai stampate (questa uscita finisce nei referti, e il repository è pubblico).');
    console.log('');

    for (const nome of richiesti) {
        const amb = AMBIENTI[nome];
        if (!amb) {
            console.error(`Ambiente sconosciuto: ${nome}. Valori ammessi: demo, production.`);
            process.exit(1);
        }
        console.log(`── ${nome.toUpperCase()} ──`);
        console.log(`   auth: ${amb.auth}`);
        console.log(`   ws:   ${amb.ws}`);
        const token = await signin(amb, username, password);
        if (token) {
            const ok = await provaWebService(amb, token, username, anno);
            if (ok) almenoUno = true;
        }
        console.log('');
    }

    if (almenoUno) {
        console.log('ESITO: collegamento DIMOSTRATO. Si può procedere con il collaudo su demo.');
    } else {
        console.log('ESITO: collegamento NON dimostrato. Leggere i corpi degli errori qui sopra:');
        console.log('       dicono se è un problema di credenziali o di abilitazione ai Web Service.');
    }
    process.exit(almenoUno ? 0 : 1);
}

main();
