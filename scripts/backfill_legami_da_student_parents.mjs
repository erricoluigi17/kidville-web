#!/usr/bin/env node
/**
 * Backfill una tantum: `student_parents` → `legame_genitori_alunni`.
 *
 * IL PROBLEMA (misurato in produzione il 2026-07-29: 35 coppie runtime, 22
 * anagrafiche, 10 presenti SOLO in anagrafica). Il legame genitore↔bambino vive
 * storicamente in due tabelle, in due spazi-id diversi:
 *
 *   · `legame_genitori_alunni (genitore_id → utenti.id, alunno_id)`  — ACCOUNT
 *   · `student_parents (parent_id → parents.id, student_id)`         — ANAGRAFICA
 *
 * L'import delle iscrizioni scriveva solo la seconda; galleria, agenda, chat,
 * diario e pagamenti leggevano solo la prima. Risultato: genitori che non
 * vedevano il proprio figlio da nessuna parte, senza un solo errore a video.
 * Il codice ora scrive entrambe (A2) e legge dall'unione: questo script recupera
 * lo STORICO già in tabella.
 *
 * COSA FA
 *   1. conta le coppie presenti in ciascuna tabella e quelle mancanti nel runtime;
 *   2. inserisce SOLO le coppie convertibili, cioè quelle il cui `parents` ha un
 *      account (`auth_user_id` non nullo): `genitore_id` è un `utenti.id`, e senza
 *      ponte non esiste alcun id corretto da scrivere — inventarlo romperebbe la FK;
 *   3. ricconta, e riporta ESPLICITAMENTE quante coppie restano NON convertibili
 *      (adulti in anagrafica senza account: vanno prima completati, es. con
 *      `scripts/repair_parent_identities.mjs`).
 *
 * SICUREZZA
 *   · a secco (`--dry-run`) di DEFAULT: senza `--apply` non scrive nulla;
 *   · idempotente: `ON CONFLICT DO NOTHING` sulla PK `(genitore_id, alunno_id)`,
 *     e le righe già presenti non vengono nemmeno riproposte;
 *   · NON tocca `intestatario_fattura`/`percentuale_pagamento` dei legami esistenti.
 *     Le righe NUOVE nascono NON intestatarie (false/0): il backfill non deve
 *     spostare la fatturazione di nessuno. L'intestatario resta quello già
 *     configurato; se una famiglia non ne avesse alcuno, lo si imposta a mano
 *     dalla Segreteria (o resta il default famiglia `parents.intestatario_default`).
 *
 * USO (dalla root del repo)
 *   node scripts/backfill_legami_da_student_parents.mjs              # DRY-RUN
 *   node scripts/backfill_legami_da_student_parents.mjs --apply      # esegue
 *
 * Legge NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY da .env.local.
 * ⚠️ `.env.local` punta al DB di PRODUZIONE: il dry-run è la modalità normale.
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

const chiave = (genitoreId, alunnoId) => `${genitoreId}|${alunnoId}`;

/** Legge una tabella in pagine: le select PostgREST sono limitate a 1000 righe. */
async function leggiTutto(admin, tabella, colonne) {
  const PAGINA = 1000;
  const righe = [];
  for (let da = 0; ; da += PAGINA) {
    const { data, error } = await admin.from(tabella).select(colonne).range(da, da + PAGINA - 1);
    if (error) throw new Error(`${tabella}: ${error.message}`);
    righe.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) break;
  }
  return righe;
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
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // ─── 1. CONTEGGIO PRIMA ────────────────────────────────────────────────────
  const runtime = await leggiTutto(admin, 'legame_genitori_alunni', 'genitore_id, alunno_id');
  const anagrafica = await leggiTutto(admin, 'student_parents', 'student_id, parent_id');
  const parents = await leggiTutto(admin, 'parents', 'id, auth_user_id');

  const accountPerParent = new Map();
  for (const p of parents) if (p.auth_user_id) accountPerParent.set(p.id, p.auth_user_id);

  const giaPresenti = new Set(runtime.map((r) => chiave(r.genitore_id, r.alunno_id)));

  const daInserire = new Map(); // chiave → { genitore_id, alunno_id }
  let nonConvertibili = 0;
  const parentsSenzaAccount = new Set();
  let senzaAlunno = 0;

  for (const sp of anagrafica) {
    if (!sp.student_id || !sp.parent_id) { senzaAlunno++; continue; }
    const account = accountPerParent.get(sp.parent_id);
    if (!account) {
      // Adulto in anagrafica SENZA account: non esiste un `utenti.id` da scrivere.
      nonConvertibili++;
      parentsSenzaAccount.add(sp.parent_id);
      continue;
    }
    const k = chiave(account, sp.student_id);
    if (giaPresenti.has(k)) continue; // idempotenza: già nel runtime
    daInserire.set(k, { genitore_id: account, alunno_id: sp.student_id });
  }

  console.log(`${apply ? '🔧 APPLY' : '🔍 DRY-RUN (nessuna scrittura)'} — backfill legame_genitori_alunni\n`);
  console.log('PRIMA');
  console.log(`  legame_genitori_alunni : ${runtime.length} coppie`);
  console.log(`  student_parents        : ${anagrafica.length} coppie`);
  console.log(`  → convertibili mancanti: ${daInserire.size}`);
  console.log(`  → NON convertibili     : ${nonConvertibili} coppie (${parentsSenzaAccount.size} adulti senza account: parents.auth_user_id nullo)`);
  if (senzaAlunno > 0) console.log(`  → righe anagrafiche incomplete (student_id/parent_id nullo): ${senzaAlunno}`);

  if (daInserire.size === 0) {
    console.log('\nNiente da fare: il runtime contiene già tutte le coppie convertibili.');
    if (nonConvertibili > 0) {
      console.log(`⚠️  Restano ${nonConvertibili} coppie non convertibili: completare prima le identità con scripts/repair_parent_identities.mjs`);
    }
    return;
  }

  const righe = [...daInserire.values()].map((r) => ({
    ...r,
    // Righe NUOVE non intestatarie: il backfill non sposta la fatturazione.
    intestatario_fattura: false,
    percentuale_pagamento: 0,
  }));

  if (!apply) {
    console.log('\nCoppie che verrebbero inserite (genitore_id → alunno_id):');
    for (const r of righe) console.log(`  · ${r.genitore_id} → ${r.alunno_id}`);
    console.log(`\nRilancia con --apply per scrivere ${righe.length} righe.`);
    return;
  }

  // ─── 2. INSERIMENTO idempotente, a blocchi ─────────────────────────────────
  const BLOCCO = 200;
  let inserite = 0;
  let errori = 0;
  for (let i = 0; i < righe.length; i += BLOCCO) {
    const lotto = righe.slice(i, i + BLOCCO);
    const { error } = await admin
      .from('legame_genitori_alunni')
      .upsert(lotto, { onConflict: 'genitore_id,alunno_id', ignoreDuplicates: true });
    if (error) {
      errori += lotto.length;
      console.log(`  ❌ lotto ${i / BLOCCO + 1}: ${error.code ?? ''} ${error.message}`);
      continue;
    }
    inserite += lotto.length;
  }

  // ─── 3. CONTEGGIO DOPO ─────────────────────────────────────────────────────
  const runtimeDopo = await leggiTutto(admin, 'legame_genitori_alunni', 'genitore_id, alunno_id');
  console.log('\nDOPO');
  console.log(`  legame_genitori_alunni : ${runtimeDopo.length} coppie (prima: ${runtime.length}, +${runtimeDopo.length - runtime.length})`);
  console.log(`  righe proposte         : ${righe.length} · scritte senza errore: ${inserite} · in errore: ${errori}`);
  console.log(`  NON convertibili       : ${nonConvertibili} coppie (${parentsSenzaAccount.size} adulti senza account)`);
  if (nonConvertibili > 0) {
    console.log('  ⚠️  Quei genitori NON vedranno il figlio finché non avranno un account:');
    console.log('      completare le identità con scripts/repair_parent_identities.mjs, poi rilanciare questo backfill.');
  }
  if (errori > 0) process.exit(2);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
