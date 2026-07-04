#!/usr/bin/env node
/**
 * Backfill allergeni strutturati dagli `alunni.allergies` a testo libero.
 *
 * Contesto: l'anagrafica sta passando dal testo libero `allergies` agli allergeni
 * strutturati `allergeni` (14 chiavi UE, usate per gli alert col menu mensa).
 * A runtime `allergeniAlunno()` inferisce già dal testo, ma conviene consolidare
 * il dato storico. Per ogni alunno con `allergies` valorizzato e `allergeni` vuoto:
 *   · inferisce le chiavi note (stesso algoritmo di inferisciAllergeniDaTesto);
 *   · il residuo NON mappabile (es. "fragole", "kiwi": non tra i 14 UE) viene
 *     appeso a `note_mediche` come "Allergie (testo storico): …" (idempotente);
 *   · le frasi di negazione ("Nessuna allergia nota") vengono ignorate.
 * `alunni.allergies` resta come colonna legacy read-only: il dato sorgente non
 * viene distrutto.
 *
 * Uso (dalla root del repo):
 *   node scripts/backfill_allergeni.mjs           # DRY-RUN: solo conteggi/anteprima
 *   node scripts/backfill_allergeni.mjs --apply   # applica gli UPDATE via PostgREST
 *
 * Idempotente: agisce solo su righe con `allergeni` vuoto e non ri-appende la
 * nota storica se già presente. Legge SUPABASE_URL/SERVICE_ROLE_KEY da .env.local.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// ── Tabella allergeni UE (mirror 1:1 di src/lib/mensa/allergeni.ts) ───────────
// La parità con la lib TS è garantita dal test __tests__/lib/allergeni-backfill.test.ts.
export const ALLERGENI = [
  { key: 'glutine', sinonimi: ['glutine', 'grano', 'frumento', 'gluten', 'farro', 'orzo', 'segale', 'avena', 'kamut', 'pane', 'pasta', 'farina'] },
  { key: 'crostacei', sinonimi: ['crostacei', 'crostaceo', 'gambero', 'gamberi', 'gamberetti', 'scampi', 'granchio', 'aragosta', 'mazzancolle'] },
  { key: 'uova', sinonimi: ['uovo', 'uova', 'albume', 'tuorlo', 'frittata', 'maionese'] },
  { key: 'pesce', sinonimi: ['pesce', 'merluzzo', 'tonno', 'salmone', 'acciughe', 'acciuga', 'alici', 'nasello', 'platessa', 'sgombro'] },
  { key: 'arachidi', sinonimi: ['arachide', 'arachidi', 'nocciolina', 'noccioline', 'burro di arachidi'] },
  { key: 'soia', sinonimi: ['soia', 'soja', 'tofu', 'edamame'] },
  { key: 'latte', sinonimi: ['latte', 'lattosio', 'latticini', 'formaggio', 'formaggi', 'burro', 'panna', 'yogurt', 'parmigiano', 'mozzarella', 'ricotta', 'besciamella', 'grana'] },
  { key: 'frutta_a_guscio', sinonimi: ['frutta a guscio', 'noci', 'noce', 'nocciola', 'nocciole', 'mandorla', 'mandorle', 'pistacchio', 'pistacchi', 'anacardi', 'pinoli', 'noci pecan', 'noci macadamia'] },
  { key: 'sedano', sinonimi: ['sedano'] },
  { key: 'senape', sinonimi: ['senape', 'mostarda'] },
  { key: 'sesamo', sinonimi: ['sesamo', 'tahin', 'tahini'] },
  { key: 'solfiti', sinonimi: ['solfiti', 'solfito', 'anidride solforosa', 'so2'] },
  { key: 'lupini', sinonimi: ['lupini', 'lupino'] },
  { key: 'molluschi', sinonimi: ['molluschi', 'mollusco', 'vongole', 'cozze', 'calamari', 'calamaro', 'polpo', 'seppia', 'seppie', 'lumache', 'ostriche'] },
];

const NOTA_STORICA_MARKER = 'Allergie (testo storico)';

/** Inferisce gli allergeni canonici dal testo libero. Ordine canonico. */
export function inferisciAllergeniDaTesto(testo) {
  if (!testo) return [];
  const t = String(testo).toLowerCase();
  const out = [];
  for (const a of ALLERGENI) {
    if (a.sinonimi.some((s) => t.includes(s))) out.push(a.key);
  }
  return out;
}

/** Frasi che indicano assenza di allergie: da NON backfillare. */
export function isNegazione(testo) {
  const low = String(testo ?? '').trim().toLowerCase();
  if (!low) return true;
  if (/\bnessun/.test(low)) return true;
  return ['no', 'none', 'n/a', 'na', '-', '/', '//', 'assente', 'assenti'].includes(low);
}

/** Spezza il testo libero in token grezzi (virgole, punti e virgola, slash, "e"). */
export function tokenizza(testo) {
  return String(testo ?? '')
    .split(/[,;\n/]+|\se\s/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pianifica il backfill di una riga alunno.
 * Ritorna { skip:true } per negazioni/testo vuoto, altrimenti
 * { allergeni, nota, cambia } dove `nota` è il nuovo note_mediche (o null).
 */
export function pianificaRiga({ allergies, note_mediche }) {
  const raw = String(allergies ?? '').trim();
  if (!raw || isNegazione(raw)) return { skip: true };

  const allergeni = inferisciAllergeniDaTesto(raw);
  // Residuo = token che non mappano su nessun allergene canonico (e non negazioni).
  const residuo = tokenizza(raw).filter((tok) => !isNegazione(tok) && inferisciAllergeniDaTesto(tok).length === 0);

  const esistente = String(note_mediche ?? '').trim();
  let nota = null;
  if (residuo.length > 0 && !esistente.includes(NOTA_STORICA_MARKER)) {
    const frase = `${NOTA_STORICA_MARKER}: ${residuo.join(', ')}`;
    nota = esistente ? `${esistente}\n${frase}` : frase;
  }

  const cambia = allergeni.length > 0 || nota !== null;
  return { skip: false, allergeni, nota, cambia };
}

// ── Runner (solo se eseguito come script, non all'import in test) ─────────────
function loadEnvLocal() {
  try {
    const txt = readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* opzionale */ }
}

async function main() {
  loadEnvLocal();
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('❌ Mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, allergies, note_mediche, allergeni')
    .not('allergies', 'is', null)
    .limit(5000);
  if (error) {
    console.error(`❌ Lettura alunni fallita: ${error.message}`);
    process.exit(2);
  }

  const candidati = (data ?? []).filter(
    (a) => String(a.allergies ?? '').trim() !== '' && (!Array.isArray(a.allergeni) || a.allergeni.length === 0)
  );

  let conAllergeni = 0, conNota = 0, saltati = 0;
  const anteprima = [];
  const daScrivere = [];
  for (const a of candidati) {
    const p = pianificaRiga(a);
    if (p.skip || !p.cambia) { saltati++; continue; }
    if (p.allergeni.length > 0) conAllergeni++;
    if (p.nota !== null) conNota++;
    const patch = { allergeni: p.allergeni };
    if (p.nota !== null) patch.note_mediche = p.nota;
    daScrivere.push({ id: a.id, patch });
    if (anteprima.length < 15) {
      anteprima.push(`  · ${a.cognome ?? ''} ${a.nome ?? ''}: "${a.allergies}" → [${p.allergeni.join(', ') || '—'}]${p.nota !== null ? ' (+nota storica)' : ''}`);
    }
  }

  console.log(`Alunni con allergies testo + allergeni vuoto: ${candidati.length}`);
  console.log(`  · con allergeni strutturati inferiti: ${conAllergeni}`);
  console.log(`  · con nota storica da appendere:      ${conNota}`);
  console.log(`  · saltati (negazione / nulla da fare): ${saltati}`);
  if (anteprima.length) {
    console.log('\nAnteprima:');
    console.log(anteprima.join('\n'));
  }

  if (daScrivere.length === 0) {
    console.log('\n✅ Niente da backfillare.');
    return;
  }
  if (!apply) {
    console.log(`\nDRY-RUN: nessuna modifica (${daScrivere.length} righe candidate).`);
    console.log('Per applicare: node scripts/backfill_allergeni.mjs --apply');
    return;
  }

  let ok = 0, ko = 0;
  for (const { id, patch } of daScrivere) {
    const { error: e } = await supabase.from('alunni').update(patch).eq('id', id);
    if (e) { ko++; console.error(`  ❌ ${id}: ${e.message}`); } else { ok++; }
  }
  console.log(`\n✅ Backfill applicato. Aggiornate ${ok} righe${ko ? `, ${ko} errori` : ''}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
