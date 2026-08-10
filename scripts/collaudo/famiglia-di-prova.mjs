#!/usr/bin/env node
/**
 * Crea (o rimuove) UNA famiglia di prova completa nell'anagrafica, per collaudare la
 * fatturazione fino in fondo. Zero dipendenze oltre a `@supabase/supabase-js`.
 *
 * PERCHÉ SERVE. Il collaudo su dati veri ha misurato che su 60 pagamenti nessuno è
 * fatturabile: i codici fiscali in anagrafica sono valori di semina lunghi 14 caratteri,
 * e la fattura elettronica ne pretende 16 formalmente corretti. È la risposta giusta —
 * il sistema si rifiuta di emettere invece di produrre scarti — ma lascia il percorso
 * completo non collaudato. Questa famiglia lo percorre tutto: genitore → legame →
 * minore → pagamento incassato → sezionale → causale → XML → XSD.
 *
 * NON SONO PERSONE VERE, E NON DEVONO SEMBRARLO A CHI GUARDA IL DATABASE. I nomi sono
 * inventati e il cognome è «Collaudo»: chi apre l'anagrafica capisce subito cosa sono.
 * I codici fiscali sono però FORMALMENTE VALIDI — carattere di controllo compreso —
 * perché lo SdI verifica il formato del `CodiceFiscale` del cessionario (errore 00305) e
 * un codice finto renderebbe il collaudo una prova di niente.
 *
 * ⚠️ SCRIVE SUL DATABASE DI PRODUZIONE. È l'unica cosa in questa cartella che lo fa.
 * Tutto ciò che crea è rimovibile con `--rimuovi`, e i record portano un marcatore
 * (il cognome «Collaudo») che li rende ritrovabili anche a distanza di mesi.
 *
 * USO
 *   node scripts/collaudo/famiglia-di-prova.mjs --crea
 *   node scripts/collaudo/famiglia-di-prova.mjs --rimuovi
 *
 * Credenziali: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY dall'ambiente (la chiave in
 * `.env.local` NON è di questo progetto: si legge dalla CLI, vedi il collaudo).
 */
import { createClient } from '@supabase/supabase-js';

// Il marcatore è il COGNOME, non una colonna dedicata: `alunni` non ha un campo note
// (verificato su information_schema prima di scrivere), e inventarne uno per il collaudo
// avrebbe voluto dire una migrazione per una famiglia finta. «Collaudo» come cognome è
// inequivocabile per chi apre l'anagrafica e si ritrova sia sul minore sia sul genitore.
const COGNOME_MARCATORE = 'Collaudo';
/**
 * La sede NON si cabla: la vieta il lock `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`,
 * e la ragione è che un uuid scritto a mano sopravvive alla sede che descrive — dal
 * 2026-07-29 le sedi sono tre, e uno script che ne nomina una sola archivia i dati nel
 * plesso sbagliato in silenzio. Si riceve da `--scuola <uuid>` o da `KV_SCUOLA_ID`;
 * senza, si DERIVA: la prima sede operativa che non sia quella fittizia della CI.
 */
async function risolviSede() {
    const daRiga = process.argv.includes('--scuola')
        ? process.argv[process.argv.indexOf('--scuola') + 1]
        : process.env.KV_SCUOLA_ID;
    if (daRiga) return daRiga;
    const sedi = esigi('schools', await db.from('schools').select('id, nome').order('nome'));
    const vera = (sedi ?? []).find((s) => !String(s.id).startsWith('e2e00000'));
    if (!vera) { console.error('nessuna sede reale trovata'); process.exit(1); }
    console.log(`sede dedotta: ${vera.nome}`);
    return vera.id;
}

// ─────────────────────────────────────────── codice fiscale, con checksum vero
const VOCALI = 'AEIOU';
const CONSONANTI = 'BCDFGHJKLMNPQRSTVWXYZ';
const MESI = 'ABCDEHLMPRST';
const PARI = Object.fromEntries([...'0123456789'].map((c, i) => [c, i]).concat([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [c, i])));
const DISPARI = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };

const soloLettere = (s) => s.toUpperCase().normalize('NFD').replace(/[^A-Z]/g, '');

/** Le tre lettere del cognome: consonanti, poi vocali, poi X a riempire. */
function terzettoCognome(cognome) {
    const c = soloLettere(cognome);
    const cons = [...c].filter((x) => CONSONANTI.includes(x));
    const voc = [...c].filter((x) => VOCALI.includes(x));
    return (cons.join('') + voc.join('') + 'XXX').slice(0, 3);
}

/** Il nome: con 4+ consonanti si prendono la 1ª, la 3ª e la 4ª — non le prime tre. */
function terzettoNome(nome) {
    const c = soloLettere(nome);
    const cons = [...c].filter((x) => CONSONANTI.includes(x));
    if (cons.length >= 4) return cons[0] + cons[2] + cons[3];
    const voc = [...c].filter((x) => VOCALI.includes(x));
    return (cons.join('') + voc.join('') + 'XXX').slice(0, 3);
}

function carattereControllo(quindici) {
    let somma = 0;
    for (let i = 0; i < 15; i++) {
        const ch = quindici[i];
        // Le posizioni si contano da 1: la 1ª è DISPARI.
        somma += (i % 2 === 0) ? DISPARI[ch] : PARI[ch];
    }
    return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[somma % 26];
}

/**
 * Codice fiscale completo. `comune` è il codice catastale (es. E932 = Giugliano in
 * Campania, H501 = Roma): non si inventa, si prende da quello vero della persona.
 */
function codiceFiscale({ nome, cognome, sesso, anno, mese, giorno, comune }) {
    const gg = sesso === 'F' ? giorno + 40 : giorno;
    const base =
        terzettoCognome(cognome) +
        terzettoNome(nome) +
        String(anno).slice(-2).padStart(2, '0') +
        MESI[mese - 1] +
        String(gg).padStart(2, '0') +
        comune.toUpperCase();
    return base + carattereControllo(base);
}

// ─────────────────────────────────────────── la famiglia
const GENITORE = {
    first_name: 'Ferdinando',
    last_name: 'Collaudo',
    sesso: 'M',
    anno: 1988, mese: 4, giorno: 12, comune: 'E932',
    residence_address: 'Via Antica Giardini',
    residence_street_number: '5',
    residence_city: 'Giugliano in Campania',
    zip_code: '80014',
    residence_province: 'NA',
};
const MINORE = {
    nome: 'Ginevra',
    cognome: 'Collaudo',
    sesso: 'F',
    // Compie 3 anni il 2027-09-14, cioè DOPO il 30 aprile dell'anno scolastico 2026/27:
    // il sezionale atteso è «Asilo». Se un giorno la regola cambiasse, questo collaudo
    // se ne accorgerebbe.
    anno: 2024, mese: 9, giorno: 14, comune: 'E932',
    data_nascita: '2024-09-14',
};

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
    console.error('Servono SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nell\'ambiente.');
    process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST NON lancia: si controlla sempre `{ error }` di ritorno. */
function esigi(nome, { data, error }) {
    if (error) { console.error(`✗ ${nome}: ${error.message}`); process.exit(1); }
    return data;
}

async function rimuovi() {
    // In ordine inverso alle dipendenze. `fatture_emesse` è WORM: se il collaudo avesse
    // prodotto un documento a registro, la cancellazione del pagamento fallirebbe con
    // ON DELETE RESTRICT — ed è giusto così, un registro fiscale non si ripulisce.
    const alunni = esigi('alunni', await db.from('alunni').select('id').eq('cognome', COGNOME_MARCATORE)) ?? [];
    for (const a of alunni) {
        esigi('pagamenti', await db.from('pagamenti').delete().eq('alunno_id', a.id));
        esigi('student_parents', await db.from('student_parents').delete().eq('student_id', a.id));
    }
    esigi('alunni.delete', await db.from('alunni').delete().eq('cognome', COGNOME_MARCATORE));
    const parents = esigi('parents', await db.from('parents').select('id').eq('last_name', COGNOME_MARCATORE)) ?? [];
    for (const p of parents) esigi('parents.delete', await db.from('parents').delete().eq('id', p.id));
    console.log(`rimossi: ${alunni.length} minori, ${parents.length} genitori (e i loro pagamenti)`);
}

async function crea() {
    // `parents` usa first_name/last_name, `alunni` usa nome/cognome: la funzione parla
    // una lingua sola e la traduzione si fa qui, dove si vede.
    const cfGenitore = codiceFiscale({ ...GENITORE, nome: GENITORE.first_name, cognome: GENITORE.last_name });
    const cfMinore = codiceFiscale(MINORE);

    const genitore = esigi('parents.insert', await db.from('parents').insert({
        first_name: GENITORE.first_name,
        last_name: GENITORE.last_name,
        fiscal_code: cfGenitore,
        residence_address: GENITORE.residence_address,
        residence_street_number: GENITORE.residence_street_number,
        residence_city: GENITORE.residence_city,
        zip_code: GENITORE.zip_code,
        residence_province: GENITORE.residence_province,
        intestatario_default: true,
    }).select('id').single());

    const minore = esigi('alunni.insert', await db.from('alunni').insert({
        scuola_id: sede,
        nome: MINORE.nome,
        cognome: MINORE.cognome,
        data_nascita: MINORE.data_nascita,
        codice_fiscale: cfMinore,
    }).select('id').single());

    esigi('student_parents.insert', await db.from('student_parents').insert({
        student_id: minore.id,
        parent_id: genitore.id,
        relation_type: 'padre',
        is_primary: true,
    }));

    const pagamento = esigi('pagamenti.insert', await db.from('pagamenti').insert({
        alunno_id: minore.id,
        scuola_id: sede,
        descrizione: 'Retta mensile',
        importo: 330,
        scadenza: '2026-09-05',
        stato: 'pagato',
        importo_pagato: 330,
        periodo_competenza: '2026-09-01',
    }).select('id').single());

    console.log('famiglia di prova creata:');
    console.log(`  genitore  ${genitore.id}   CF lungo ${cfGenitore.length} (valido)`);
    console.log(`  minore    ${minore.id}   CF lungo ${cfMinore.length} (valido), nato ${MINORE.data_nascita}`);
    console.log(`  pagamento ${pagamento.id}   330,00 € stato «pagato»`);
    console.log(`  sezionale atteso: Asilo (compie 3 anni dopo il 30 aprile 2027)`);
    console.log(`\nper ritrovarli o rimuoverli: cognome «${COGNOME_MARCATORE}»`);
}

const azione = process.argv[2];
if (azione === '--crea') await crea();
else if (azione === '--rimuovi') await rimuovi();
else { console.error('Uso: --crea | --rimuovi'); process.exit(1); }
