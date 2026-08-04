#!/usr/bin/env node
/**
 * Client minimo per l'App Store Connect API — zero dipendenze.
 *
 * PERCHÉ ESISTE. La submission di Kidville si fa da riga di comando (non c'è una CI
 * nativa, e la console si pilota a mano solo quando serve). Ogni sessione precedente ha
 * riscritto questo client da capo dentro un `node -e`, e ogni volta ha ripagato le stesse
 * due trappole. Adesso sta in un file, con le trappole scritte accanto al codice che le
 * evita.
 *
 * DOVE STANNO LE CREDENZIALI — mai in questo repository, che è PUBBLICO:
 *   · chiave privata  ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8   (chmod 600)
 *   · issuer id       ~/.appstoreconnect/issuer_id                          (chmod 600)
 *   · key id          variabile ASC_KEY_ID, oppure il nome del solo .p8 presente
 * Il JWT e l'issuer non vengono MAI stampati: un identificativo che finisce in un log
 * finisce in una trascrizione, e una trascrizione circola.
 *
 * LE DUE TRAPPOLE CHE FANNO FALLIRE IN SILENZIO
 *   1. la firma JWS deve essere raw `r||s` (`dsaEncoding: 'ieee-p1363'`). OpenSSL produce
 *      DER per impostazione predefinita e Apple risponde 401 senza spiegare perché;
 *   2. `aud` deve essere esattamente `appstoreconnect-v1`.
 * E una terza, che non è di firma ma di lettura: **un 401 restituisce comunque un JSON
 * sensato**. Si controlla lo stato HTTP, non la presenza del corpo.
 *
 * USO
 *   node scripts/asc-api.mjs GET  /v1/apps
 *   node scripts/asc-api.mjs GET  '/v1/apps/6794883055/appStoreVersions?limit=5'
 *   echo '{"data":{...}}' | node scripts/asc-api.mjs PATCH /v1/appStoreVersions/<id> -
 *   node scripts/asc-api.mjs stato          # riepilogo della scheda Kidville
 *
 * Esce con codice 1 se la risposta non è 2xx, così `&&` in shell si comporta bene.
 */
import { createSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://api.appstoreconnect.apple.com';
const DIR = join(homedir(), '.appstoreconnect');
const APP_ID_KIDVILLE = '6794883055';

function leggiCredenziali() {
  let keyId = process.env.ASC_KEY_ID;
  if (!keyId) {
    const chiavi = readdirSync(join(DIR, 'private_keys')).filter((f) => /^AuthKey_.+\.p8$/.test(f));
    if (chiavi.length !== 1) {
      throw new Error(
        `Attese 1 chiave in ${DIR}/private_keys, trovate ${chiavi.length}. Imposta ASC_KEY_ID.`,
      );
    }
    keyId = chiavi[0].replace(/^AuthKey_|\.p8$/g, '');
  }
  const issuerId = (process.env.ASC_ISSUER_ID || readFileSync(join(DIR, 'issuer_id'), 'utf8')).trim();
  if (!/^[0-9a-f-]{36}$/i.test(issuerId)) {
    throw new Error(`Issuer id assente o malformato. Attesa una uuid in ${DIR}/issuer_id`);
  }
  const privateKey = readFileSync(join(DIR, 'private_keys', `AuthKey_${keyId}.p8`), 'utf8');
  return { keyId, issuerId, privateKey };
}

function creaToken({ keyId, issuerId, privateKey }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const adesso = Math.floor(Date.now() / 1000);
  const testa = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  // aud: valore letterale preteso da Apple. exp oltre 20 minuti viene rifiutato.
  const corpo = b64({ iss: issuerId, iat: adesso, exp: adesso + 900, aud: 'appstoreconnect-v1' });
  const firma = createSign('sha256')
    .update(`${testa}.${corpo}`)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url'); // raw r||s, non DER
  return `${testa}.${corpo}.${firma}`;
}

let tokenInCache = null;
export async function chiamata(metodo, percorso, corpo = null) {
  tokenInCache ??= creaToken(leggiCredenziali());
  const res = await fetch(BASE + percorso, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${tokenInCache}`,
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(corpo ? { body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) } : {}),
  });
  const testo = await res.text();
  let json = null;
  try {
    json = testo ? JSON.parse(testo) : null;
  } catch {
    /* risposta non JSON: la si restituisce come testo, non si nasconde */
  }
  return { stato: res.status, ok: res.ok, json, testo };
}

/** Riepilogo leggibile della scheda: è la prima cosa da guardare a ogni ripresa. */
async function stato() {
  const righe = [];
  const app = await chiamata('GET', `/v1/apps/${APP_ID_KIDVILLE}`);
  if (!app.ok) return { stato: app.stato, righe: [`GET /v1/apps/${APP_ID_KIDVILLE} -> ${app.stato}`, app.testo.slice(0, 400)] };
  const a = app.json.data.attributes;
  righe.push(`APP  ${a.name}  bundle=${a.bundleId}  sku=${a.sku}  locale=${a.primaryLocale}`);

  const versioni = await chiamata('GET', `/v1/apps/${APP_ID_KIDVILLE}/appStoreVersions?limit=5`);
  for (const v of versioni.json?.data ?? []) {
    righe.push(
      `VER  ${v.attributes.versionString}  stato=${v.attributes.appStoreState}  ` +
        `rilascio=${v.attributes.releaseType}  id=${v.id}`,
    );
    const b = await chiamata('GET', `/v1/appStoreVersions/${v.id}/build`);
    righe.push(`     build agganciata: ${b.json?.data ? `${b.json.data.attributes.version} (${b.json.data.id})` : 'NESSUNA'}`);
  }

  const build = await chiamata('GET', `/v1/builds?filter[app]=${APP_ID_KIDVILLE}&limit=10&sort=-uploadedDate`);
  for (const b of build.json?.data ?? []) {
    righe.push(
      `BLD  ${b.attributes.version}  ${b.attributes.processingState}  ` +
        `crittografia=${b.attributes.usesNonExemptEncryption}  scade=${String(b.attributes.expirationDate).slice(0, 10)}  ` +
        `scaduta=${b.attributes.expired}`,
    );
  }

  // Il percorso è `/v2/appAvailabilities/{appId}/territoryAvailabilities`, e l'id della
  // risorsa È l'id dell'app. Se risponde 404 la disponibilità non è mai stata impostata:
  // non è un errore di lettura, è una configurazione mancante che blocca l'invio.
  const disp = await chiamata('GET', `/v2/appAvailabilities/${APP_ID_KIDVILLE}/territoryAvailabilities?limit=200`);
  if (disp.stato === 404) {
    righe.push('DISP nessuna disponibilità impostata (404) — blocca l\'invio');
  } else if (disp.ok) {
    const terr = disp.json.data ?? [];
    // Gli id sono base64 di {"s":"<appId>","t":"ITA"}: il codice paese non è l'id.
    const paese = (t) => {
      try {
        return JSON.parse(Buffer.from(t.id, 'base64url').toString()).t;
      } catch {
        return t.id;
      }
    };
    const disponibili = terr.filter((t) => t.attributes.available).map(paese);
    righe.push(`DISP ${disponibili.length} territori su ${terr.length}: ${disponibili.join(', ') || 'nessuno'}`);
    // ⚠️ È l'UNICO modo di leggere lo stato DSA da programma: non esiste endpoint per
    // dichiararlo, ma qui si vede se sta bloccando, e per quali territori.
    const bloccati = terr.filter((t) => (t.attributes.contentStatuses ?? []).some((s) => s.startsWith('TRADER_STATUS')));
    if (bloccati.length) {
      righe.push(`DSA  ${bloccati.length} territori con TRADER_STATUS_* — fra cui ${bloccati.map(paese).slice(0, 5).join(', ')}…`);
    }
  } else {
    righe.push(`DISP non leggibile (${disp.stato})`);
  }
  return { stato: 200, righe };
}

const [, , metodo, percorso, corpoArg] = process.argv;
if (!metodo) {
  console.error('uso: node scripts/asc-api.mjs <GET|POST|PATCH|DELETE> <percorso> [- per corpo da stdin]');
  console.error('     node scripts/asc-api.mjs stato');
  process.exit(2);
}

if (metodo === 'stato') {
  const r = await stato();
  r.righe.forEach((x) => console.log(x));
  process.exit(r.stato === 200 ? 0 : 1);
}

let corpo = null;
if (corpoArg === '-') corpo = readFileSync(0, 'utf8');
else if (corpoArg) corpo = corpoArg;

const r = await chiamata(metodo.toUpperCase(), percorso, corpo);
console.log(`${metodo.toUpperCase()} ${percorso} -> ${r.stato}`);
if (r.json) console.log(JSON.stringify(r.json, null, 1));
else if (r.testo) console.log(r.testo.slice(0, 2000));
process.exit(r.ok ? 0 : 1);
