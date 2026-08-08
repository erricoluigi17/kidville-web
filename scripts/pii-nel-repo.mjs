#!/usr/bin/env node
/**
 * Cerca nei file TRACCIATI del repository i nomi e i cognomi che in produzione
 * appartengono a persone vere — bambini iscritti e loro genitori.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────
 * Il 2026-08-08 in `e2e/collaudo-giornata/FINDINGS-CORREZIONE.md` — file
 * tracciato di un repository PUBBLICO — sono stati trovati il nome e il cognome
 * di una bambina che risulta ALUNNA ISCRITTA, insieme al valore della sua colonna
 * `allergies` (dato sulla salute, art. 9 GDPR), e in un'altra riga dello stesso
 * file il nome proprio di un'altra bambina. Erano lì da mesi. Nessun controllo
 * del gate poteva vederli: il lock che gira in `vitest`
 * (`__tests__/architecture/pii-nei-file-tracciati.test.ts`) è OFFLINE per
 * costruzione, quindi non sa come si chiamano i bambini veri e può cercare solo la
 * FORMA del difetto — un valore accanto al nome di una colonna, un file di esito
 * di collaudo entrato nell'indice.
 *
 * Questo script è l'altra metà: sa i nomi perché li chiede al database, e per
 * questo NON può stare nel gate. Si lancia a mano, prima di un rilascio o dopo una
 * campagna di collaudo.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────
 *   node scripts/pii-nel-repo.mjs                 # nomi MASCHERATI nell'output
 *   node scripts/pii-nel-repo.mjs --mostra-nomi   # in chiaro (solo a schermo)
 *   node scripts/pii-nel-repo.mjs --min 5         # soglia di lunghezza del token
 *
 * Legge `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
 * da `.env.local`. Fa SOLO letture (`select`), non scrive niente sul database.
 *
 * ⚠️ NON SCRIVE NESSUN FILE, e non è una dimenticanza: uno script che cerca dati
 * personali e ne deposita l'elenco su disco fabbrica esattamente il difetto che
 * sta cercando. L'output va letto a schermo. Se serve conservarlo, si conserva la
 * versione mascherata (quella predefinita), che porta i percorsi e i numeri di riga
 * — cioè tutto ciò che serve per intervenire — e nessun nome.
 *
 * ─── LIMITI, DICHIARATI ────────────────────────────────────────────────────
 *  · cerca token di almeno 4 caratteri: i nomi più corti (Ada, Leo, Bea) non
 *    entrano, perché sotto quella soglia le collisioni con parole comuni rendono
 *    l'elenco illeggibile e quindi inutile;
 *  · toglie dai token le parole che in italiano sono anche di uso comune (elenco
 *    `PAROLE_COMUNI` qui sotto): un cognome che coincide con una parola comune
 *    NON viene cercato, ed è un buco consapevole;
 *  · guarda solo i file di TESTO tracciati: uno screenshot con un elenco di alunni
 *    passa indisturbato;
 *  · guarda l'albero di lavoro, non la STORIA di git: ciò che è già stato
 *    pubblicato in un commit precedente resta pubblicato.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const RADICE = process.cwd();

const ESTENSIONI = new Set([
  '.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yml', '.yaml', '.sql', '.sh', '.html', '.csv',
]);

/**
 * Parole che sono anche cognomi ma che compaiono ovunque in un repository
 * italiano: cercarle produrrebbe migliaia di righe e nessuno leggerebbe più
 * l'elenco. Ogni voce è un buco dichiarato.
 */
const PAROLE_COMUNI = new Set([
  'bianco', 'bianchi', 'rossi', 'rosso', 'verde', 'verdi', 'grasso', 'lungo',
  'monte', 'monti', 'costa', 'campo', 'campi', 'sala', 'sale', 'porta', 'porte',
  'ferro', 'oro', 'sole', 'luna', 'stella', 'stelle', 'fiore', 'fiori', 'prova',
  'test', 'demo', 'nuovo', 'nuova', 'santo', 'santa', 'buono', 'bello', 'grande',
  'piccolo', 'primo', 'prima', 'terzo', 'gioia', 'pace', 'vita', 'sede', 'sedi',
  'aversa', 'cesa', 'giugliano', 'kidville', 'favola', 'villa', 'casa', 'corte',
  // Aggiunte MISURATE il 2026-08-08, e il motivo è più interessante della lista:
  // nelle domande di iscrizione il campo `nome` non contiene sempre un nome. In
  // alcune righe porta il testo di un'etichetta del modulo, e da lì escono token
  // come «della» (4.568 riscontri nel repo), «dell», «colonna», «dello». Non sono
  // cognomi di nessuno: sono parole finite in un campo anagrafico. Se un giorno il
  // modulo verrà ripulito, questa lista si accorcia.
  'della', 'dell', 'dello', 'delle', 'degli', 'colonna', 'comune', 'core', 'altrui',
  'doppio', 'padre', 'madre', 'figlio', 'figlia', 'nome', 'cognome', 'data', 'dati',
]);

/**
 * Le anagrafiche di PROVA che vivono in produzione («Alunno Collaudo»,
 * «ProvaAversa», gli account `test.*`): i loro token combaciano con parole che nel
 * repo compaiono migliaia di volte e sommergerebbero l'elenco. Si escludono, ed è
 * un buco dichiarato — se un giorno un bambino vero si chiamasse davvero così,
 * questo strumento non lo vedrebbe.
 */
const DATI_DI_PROVA = /^(alunn|alunno|collaud|prova|test|demo|esempio|e2e|genitor|docent|maestr)/i;

function caricaEnvLocale() {
  if (!existsSync('.env.local')) return;
  const testo = readFileSync('.env.local', 'utf8');
  for (const riga of testo.split('\n')) {
    const t = riga.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const chiave = t.slice(0, i).trim();
    const valore = t.slice(i + 1).trim();
    if (!(chiave in process.env)) process.env[chiave] = valore;
  }
}

/** I file tracciati, che sono l'unico perimetro che conta: il repo è pubblico. */
function fileTracciati() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: RADICE, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => ESTENSIONI.has(extname(f)));
}

/** «Aurora  Rossi» → ['aurora', 'rossi']: si spezza, si abbassa, si sfoltisce. */
function tokenDi(valore, minimo) {
  if (typeof valore !== 'string') return [];
  return valore
    .normalize('NFC')
    .split(/[^\p{L}]+/u)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length >= minimo && !PAROLE_COMUNI.has(p));
}

/** Nome mascherato: «Aurora» → «A•••••». Il default, per non riscrivere il difetto. */
function maschera(token) {
  return `${token[0].toUpperCase()}${'•'.repeat(Math.max(1, token.length - 1))}`;
}

async function main() {
  caricaEnvLocale();
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chiave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chiave) {
    console.error(
      '❌ Mancano SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY.\n' +
        '   Vanno in .env.local. La chiave vera del progetto si legge con:\n' +
        '   supabase projects api-keys --project-ref <ref> --experimental',
    );
    process.exit(1);
  }
  const mostra = process.argv.includes('--mostra-nomi');
  const iMin = process.argv.indexOf('--min');
  const minimo = iMin >= 0 ? Number(process.argv[iMin + 1]) || 4 : 4;

  const supabase = createClient(url, chiave, { auth: { persistSession: false } });

  // ── 1. I nomi veri, dal database. Solo SELECT. ────────────────────────────
  const token = new Map(); // token → da quale tabella viene
  const aggiungi = (valore, tabella) => {
    for (const t of tokenDi(valore, minimo)) {
      if (DATI_DI_PROVA.test(t)) continue;
      if (!token.has(t)) token.set(t, tabella);
    }
  };

  const { data: alunni, error: erroreAlunni } = await supabase
    .from('alunni')
    .select('nome, cognome')
    .limit(20000);
  if (erroreAlunni) {
    console.error(`❌ lettura di alunni fallita: ${erroreAlunni.code} ${erroreAlunni.message}`);
    process.exit(1);
  }
  for (const a of alunni ?? []) {
    aggiungi(a.nome, 'alunni');
    aggiungi(a.cognome, 'alunni');
  }

  // `parents` non ha `nome`/`cognome`: le colonne sono `first_name`/`last_name`.
  // Sembra un dettaglio e non lo è — con i nomi sbagliati PostgREST risponde
  // `42703` e la scansione prosegue con MENO nomi, cioè con meno riscontri, cioè
  // sembrando più pulita di quanto sia.
  const { data: genitori, error: erroreGenitori } = await supabase
    .from('parents')
    .select('first_name, last_name')
    .limit(20000);
  if (erroreGenitori) {
    // Non è fatale, ma si DICHIARA: un risultato parziale spacciato per completo
    // è peggio di un errore.
    console.error(
      `⚠️  lettura di parents fallita (${erroreGenitori.code} ${erroreGenitori.message}): ` +
        'la ricerca prosegue SENZA i nomi dei genitori. Il risultato è parziale.',
    );
  }
  for (const g of genitori ?? []) {
    aggiungi(g.first_name, 'parents');
    aggiungi(g.last_name, 'parents');
  }

  // Le domande di iscrizione: è il bacino più grande di nomi VERI (centinaia di
  // bambini che non sono ancora in `alunni`), e il nome trovato nel repo l'8 agosto
  // stava anche qui. `data` è un JSON con due array, `children` e `adults`.
  const { data: domande, error: erroreDomande } = await supabase
    .from('enrollment_submissions')
    .select('data')
    .limit(5000);
  if (erroreDomande) {
    console.error(
      `⚠️  lettura di enrollment_submissions fallita (${erroreDomande.code} ` +
        `${erroreDomande.message}): risultato parziale, mancano i nomi delle domande.`,
    );
  }
  // Chiave ESATTA, non «contiene». Con la forma larga si pescano anche i `name`
  // dello SCHEMA del modulo (le etichette delle domande: «dati anagrafici», «dati
  // del genitore»…) e il token «dati» finisce a 4.566 riscontri, sommergendo i
  // nomi veri. Misurato il 2026-08-08, prima e dopo.
  const CHIAVE_DI_NOME = /^(nome|cognome|nome_completo|first_?name|last_?name|full_?name|surname|child_?name|parent_?name)$/i;
  const raccogli = (nodo) => {
    if (Array.isArray(nodo)) {
      nodo.forEach(raccogli);
      return;
    }
    if (!nodo || typeof nodo !== 'object') return;
    for (const [k, v] of Object.entries(nodo)) {
      if (typeof v === 'string' && CHIAVE_DI_NOME.test(k)) aggiungi(v, 'domande');
      else if (v && typeof v === 'object') raccogli(v);
    }
  };
  for (const d of domande ?? []) raccogli(d.data);

  if (token.size === 0) {
    console.error('❌ Nessun nome letto dal database: lo strumento non sta guardando niente.');
    process.exit(1);
  }
  console.log(
    `Nomi e cognomi distinti letti da produzione: ${token.size} ` +
      `(alunni + genitori + domande di iscrizione, token di almeno ${minimo} caratteri, ` +
      'esclusi quelli che sono evidentemente dati di prova)',
  );

  // ── 2. Controllo POSITIVO, prima di fidarsi del risultato ─────────────────
  // La lezione del collaudo del 2026-08-07: una scansione che non sta leggendo
  // niente restituisce «0 occorrenze», e «0 occorrenze» si legge «tutto pulito».
  const files = fileTracciati();
  const prova = files.includes('README.md') && readFileSync(join(RADICE, 'README.md'), 'utf8').length > 0;
  if (!prova) {
    console.error('❌ Controllo positivo fallito: non sto leggendo i file del repo.');
    process.exit(1);
  }
  console.log(`File di testo tracciati da scandire: ${files.length}\n`);

  // ── 3. La scansione ───────────────────────────────────────────────────────
  const regex = new RegExp(`\\b(${[...token.keys()].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'giu');
  /** token → righe trovate. Si raccoglie tutto e si stampa DOPO: serve il conteggio. */
  const perToken = new Map();
  for (const f of files) {
    // Il file di questo script contiene l'elenco delle parole comuni: se lo si
    // scandisse, si accuserebbe da solo.
    if (f === 'scripts/pii-nel-repo.mjs') continue;
    const percorso = join(RADICE, f);
    if (!existsSync(percorso)) continue;
    readFileSync(percorso, 'utf8')
      .split('\n')
      .forEach((riga, i) => {
        for (const t of new Set([...riga.matchAll(regex)].map((m) => m[1].toLowerCase()))) {
          if (!perToken.has(t)) perToken.set(t, []);
          perToken.get(t).push(`${f}:${i + 1}`);
        }
      });
  }

  // ── 4. Il rapporto, ordinato per QUANTO è raro il riscontro ───────────────
  // Un nome che compare in 800 righe non è una persona: è una parola del progetto
  // (le anagrafiche di PROVA in produzione si chiamano «Alunno Collaudo», e i loro
  // token combaciano con `alunni`, `collaudo`, i nomi delle sezioni…). Le righe che
  // contano sono quelle RARE, e vanno in cima: un cognome vero in un repository
  // compare una volta o due, in un report che qualcuno ha incollato.
  const SOGLIA_DETTAGLIO = 20;
  const ordinati = [...perToken.entries()].sort((a, b) => a[1].length - b[1].length);
  const rari = ordinati.filter(([, righe]) => righe.length <= SOGLIA_DETTAGLIO);
  const diffusi = ordinati.filter(([, righe]) => righe.length > SOGLIA_DETTAGLIO);

  console.log(`── DA GUARDARE (token con al massimo ${SOGLIA_DETTAGLIO} riscontri) ──`);
  if (rari.length === 0) console.log('   nessuno');
  for (const [t, righe] of rari) {
    console.log(`\n${mostra ? t : maschera(t)} [${token.get(t)}] — ${righe.length} riscontri`);
    for (const r of righe) console.log(`   ${r}`);
  }

  if (diffusi.length > 0) {
    console.log(
      `\n── DIFFUSI, quasi certamente parole del progetto e non persone ──\n` +
        '   (controllarne una a campione prima di archiviarli: la soglia è una comodità, ' +
        'non una prova)',
    );
    for (const [t, righe] of diffusi) {
      console.log(`   ${mostra ? t : maschera(t)} [${token.get(t)}] — ${righe.length} riscontri`);
    }
  }

  const daGuardare = rari.reduce((n, [, righe]) => n + righe.length, 0);
  console.log(
    `\n${daGuardare === 0 ? '✅' : '🔴'} ${daGuardare} riscontri da guardare ` +
      `(${perToken.size} token distinti in tutto). ` +
      (daGuardare === 0
        ? 'Nessun nome raro di produzione nei file tracciati.'
        : 'Un nome e un cognome accostati non sono una coincidenza. Il repository è PUBBLICO.') +
      (mostra ? '\n⚠️  Output IN CHIARO: non salvarlo su disco e non incollarlo in un file del repo.' : ''),
  );
  process.exit(daGuardare === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
