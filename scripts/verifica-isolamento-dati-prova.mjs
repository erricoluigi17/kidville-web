/**
 * verifica-isolamento-dati-prova.mjs — controlla che nessun dato di collaudo sia
 * tornato dentro una sede VERA.
 *
 * PERCHÉ ESISTE. Il 2026-08-24 tutti i dati di prova sono stati spostati in una
 * sede dedicata, perché fino a quel giorno vivevano dentro le sedi vere: il KPI
 * «Studenti iscritti» contava 22 bambini inesistenti a Giugliano, e
 * `Collaudo ProvaAversa` sedeva nella sezione REALE «3 ANNI» di Aversa — nel
 * registro di una maestra vera.
 *
 * ⚠️ PERCHÉ HA DUE CONTROLLI, E PERCHÉ IL SECONDO È NATO SUBITO DOPO IL PRIMO.
 * La prima stesura di questo file aveva solo il controllo A: cinque tabelle
 * scelte a mano. Rispondeva «✓ nessun dato di collaudo dentro una sede reale»
 * mentre **1.353 righe** erano rimaste indietro — 370 in `audit_scritture_docente`,
 * 89 in `pagamenti`, 66 in `mensa_ticket_movimenti`, 50 in `solleciti`, 96 in
 * `presenze`, e altre otto tabelle. Al KPI «Pagamenti scaduti» di Giugliano la
 * segreteria vedeva 24 morosità per € 2.710, di cui 23 per € 2.670 di bambini
 * che non esistono: il dato vero era **€ 40**.
 *
 * Non era un controllo assente: era un controllo che DAVA IL VERDE. È il guasto
 * peggiore, perché toglie a chi legge la voglia di guardare. Il rimedio non è
 * allungare la lista — la prossima tabella la dimenticherebbe di nuovo — ma
 * derivarla dallo schema. Da qui il controllo B.
 *
 *   A · MARCATORI — chi non ha un legame da seguire: un utente `@kidville.test`,
 *       una classe che si chiama «TEST», un bambino che si chiama «Collaudo»
 *       messo direttamente in una sede vera. Nessuna colonna lo tradisce: solo
 *       il nome. Questo controllo B non lo vedrebbe mai.
 *
 *   B · COERENZA (funzione `dati_prova_fuori_sede()`) — righe la cui `scuola_id`
 *       dice una sede REALE mentre l'entità a cui appartengono vive in una sede
 *       di collaudo. L'elenco delle tabelle è DERIVATO dallo schema: qualunque
 *       tabella nasca domani con `scuola_id` e un legame noto entra da sola.
 *
 * Nessuno dei due basta. Insieme coprono le due forme del difetto.
 *
 * SOLA LETTURA. Non scrive niente, mai.
 *
 * USO
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/verifica-isolamento-dati-prova.mjs
 *
 * USCITA
 *   0 = pulito · 1 = errore di lettura · 3 = dati di prova in sedi vere
 */
import { createClient } from '@supabase/supabase-js';

/** Il prefisso che marca una sede non reale. È un PREDICATO, non un uuid. */
const PREFISSO_NON_REALE = 'e2e00000';
/** Dominio di autenticazione degli account di collaudo. */
const DOMINIO_TEST = '@kidville.test';
/** I marcatori che tradiscono un record inventato in mezzo a bambini veri. */
const MARCATORI = /(^|\W)(test|collaudo|demo|e2e)(\W|$)|^alunno\d/i;

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const CHIAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !CHIAVE) {
  console.error('✗ Servono NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nell\'ambiente.');
  process.exit(1);
}
const db = createClient(URL, CHIAVE, { auth: { persistSession: false } });

/**
 * PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un guasto di
 * lettura diventerebbe un elenco vuoto, cioè «tutto pulito» — che è il modo
 * esatto in cui un verificatore smette di verificare senza dirlo a nessuno.
 */
function esito(cosa, res) {
  if (res.error) {
    console.error(`✗ ${cosa}: [${res.error.code ?? '—'}] ${res.error.message}`);
    process.exit(1);
  }
  return res.data ?? [];
}

const eNonReale = (id) => String(id ?? '').startsWith(PREFISSO_NON_REALE);

/** Gli id di autenticazione degli account di collaudo, presi da `auth.users`. */
async function idDiCollaudo() {
  const ids = new Set();
  for (let pagina = 1; ; pagina++) {
    const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) {
      console.error(`✗ auth.admin.listUsers (pagina ${pagina}): ${error.message}`);
      process.exit(1);
    }
    for (const u of data.users) {
      if ((u.email ?? '').toLowerCase().endsWith(DOMINIO_TEST)) ids.add(u.id);
    }
    // L'email di autenticazione NON coincide sempre con `utenti.email`: cinque
    // account di collaudo hanno in `utenti` una casella personale vera. Chi
    // cerca da `utenti.email` ne salta cinque e conclude «pulito».
    if (data.users.length < 200) return ids;
  }
}

const collaudo = await idDiCollaudo();
const nomiSede = new Map(esito('schools', await db.from('schools').select('id, nome')).map((s) => [s.id, s.nome]));
const sedeDi = (id) => `${nomiSede.get(id) ?? id}`;
const difetti = [];
const registri = [];

// ─── A · MARCATORI ───────────────────────────────────────────────────────────

for (const u of esito('utenti', await db.from('utenti').select('id, scuola_id'))) {
  if (collaudo.has(u.id) && !eNonReale(u.scuola_id)) {
    difetti.push(`utente di collaudo nella sede reale «${sedeDi(u.scuola_id)}»  (id ${u.id})`);
  }
}

for (const s of esito('sections', await db.from('sections').select('id, name, scuola_id'))) {
  if (!eNonReale(s.scuola_id) && MARCATORI.test(String(s.name ?? ''))) {
    difetti.push(`classe di prova «${s.name}» nella sede reale «${sedeDi(s.scuola_id)}»`);
  }
}

// Bambini inventati fra i bambini veri: è il rilievo che pesa di più, perché
// gonfia il KPI della segreteria e riempie il registro di una maestra.
for (const a of esito('alunni', await db.from('alunni').select('id, nome, cognome, scuola_id, stato'))) {
  if (eNonReale(a.scuola_id)) continue;
  if (MARCATORI.test(`${a.nome ?? ''} ${a.cognome ?? ''}`)) {
    difetti.push(`alunno con nome di prova nella sede reale «${sedeDi(a.scuola_id)}» (stato ${a.stato}, id ${a.id})`);
  }
}

// ─── B · COERENZA, derivata dallo schema ─────────────────────────────────────

for (const r of esito('dati_prova_fuori_sede()', await db.rpc('dati_prova_fuori_sede'))) {
  const riga = `${r.righe} righe in \`${r.tabella}\` (via ${r.colonna_legame}) risultano di una sede reale`;
  if (r.natura === 'registro_numerato') registri.push(riga);
  else difetti.push(riga);
}

// ─── Verdetto ────────────────────────────────────────────────────────────────

if (registri.length > 0) {
  console.log('\nℹ️  Registri NUMERATI — si segnalano, non si spostano:\n');
  for (const r of registri) console.log(`  · ${r}`);
  console.log(
    '\n  Protocolli (DPR 445), ricevute e fatture hanno numerazione sequenziale per sede:\n' +
    '  toglierne una lascia un BUCO, che in un registro legale o fiscale è peggio della\n' +
    '  riga di prova che contiene. Lì si annulla o si annota — è una decisione contabile.\n',
  );
}

if (difetti.length === 0) {
  console.log('✓ Nessun dato di collaudo dentro una sede reale.');
  process.exit(0);
}
console.error(`\n✗ ${difetti.length} rilievi — dati di collaudo dentro sedi reali:\n`);
for (const d of difetti) console.error(`  · ${d}`);
console.error('\nVanno spostati nella sede demo, non cancellati: sono agganciati agli account che Apple e Google usano.\n');
process.exit(3);
