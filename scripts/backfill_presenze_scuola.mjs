#!/usr/bin/env node
/**
 * Backfill delle presenze storiche con `scuola_id` NULL (pendenza M8 → M9).
 *
 * Contesto: fino al fix M8 di /api/attendance/daily le righe di `presenze`
 * venivano inserite senza scuola_id/section_id; le query scoped per plesso
 * (aggregato presenze realtime M7) non le vedono. Il valore corretto è
 * derivabile dal legame presenze.alunno_id → alunni.scuola_id/section_id.
 *
 * Uso (dalla root del repo):
 *   node scripts/backfill_presenze_scuola.mjs           # DRY-RUN: solo conteggi, nessuna scrittura
 *   node scripts/backfill_presenze_scuola.mjs --apply   # applica l'UPDATE via RPC exec_sql
 *
 * Idempotente: agisce solo su righe con scuola_id IS NULL. Legge
 * SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY da .env.local.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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

const UPDATE_SQL = `
UPDATE presenze p
SET scuola_id  = a.scuola_id,
    section_id = COALESCE(p.section_id, a.section_id)
FROM alunni a
WHERE p.alunno_id = a.id
  AND p.scuola_id IS NULL;
`;

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

  // Fotografia dello stato (letture via PostgREST, nessuna scrittura)
  const { count: nulle, error: e1 } = await supabase
    .from('presenze')
    .select('id', { count: 'exact', head: true })
    .is('scuola_id', null);
  if (e1) {
    console.error(`❌ Lettura presenze fallita: ${e1.message}`);
    process.exit(2);
  }
  const { count: senzaSezione } = await supabase
    .from('presenze')
    .select('id', { count: 'exact', head: true })
    .is('section_id', null);

  console.log(`Presenze con scuola_id NULL: ${nulle}`);
  console.log(`Presenze con section_id NULL (info): ${senzaSezione ?? 'n.d.'}`);

  if (!nulle) {
    console.log('✅ Niente da backfillare.');
    return;
  }
  if (!apply) {
    console.log('\nDRY-RUN: nessuna modifica. SQL che verrebbe eseguito:');
    console.log(UPDATE_SQL);
    console.log('Per applicare: node scripts/backfill_presenze_scuola.mjs --apply');
    return;
  }

  const { error: e2 } = await supabase.rpc('exec_sql', { sql: UPDATE_SQL });
  if (e2) {
    console.error(`❌ UPDATE fallito: ${e2.message}`);
    process.exit(3);
  }

  // Verifica post-applicazione
  const { count: residue } = await supabase
    .from('presenze')
    .select('id', { count: 'exact', head: true })
    .is('scuola_id', null);
  console.log(`✅ Backfill applicato. Residue con scuola_id NULL: ${residue}`);
  if (residue) {
    console.log('⚠️  Righe residue: presenze di alunni senza scuola_id in anagrafica (da bonificare a mano).');
  }
}

main();
