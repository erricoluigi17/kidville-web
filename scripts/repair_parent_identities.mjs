#!/usr/bin/env node
/**
 * Riparazione una tantum: identità di accesso dei genitori "monchi" (S6bis).
 *
 * Contesto: fino al fix S6bis la creazione anagrafica scriveva SOLO la riga
 * `parents` (niente account auth, niente riga `utenti`, niente ponte
 * `parents.auth_user_id`), quindi "Rigenera credenziali" rispondeva 409 e il
 * genitore non poteva accedere. Questo script completa l'identità dei parents
 * esistenti con email e senza ponte:
 *   · riusa l'account `auth.users` con la stessa email se esiste, altrimenti lo
 *     crea (email confermata, password random NON comunicata: le credenziali
 *     reali si emettono poi da "Rigenera credenziali");
 *   · scrive `parents.auth_user_id` (UNIQUE: un conflitto → riga in errore);
 *   · crea la riga `utenti` ruolo 'genitore' SOLO se manca (un docente-genitore
 *     conserva il proprio ruolo staff).
 * Non invia NESSUNA email. Idempotente: al secondo giro non trova più nulla.
 *
 * Uso (dalla root del repo):
 *   node scripts/repair_parent_identities.mjs --scuola <uuid>            # DRY-RUN
 *   node scripts/repair_parent_identities.mjs --scuola <uuid> --apply    # esegue
 *
 * `--scuola` è OBBLIGATORIO e non ha default. Fino al 2026-07-31 c'era l'uuid di
 * Kidville Giugliano scritto a mano, con la motivazione «unica sede di
 * produzione»: dal 2026-07-29 le sedi sono TRE (Giugliano, Aversa, Cesa) e quel
 * default avrebbe scritto `utenti.scuola_id = Giugliano` anche per i genitori di
 * Aversa e Cesa — in silenzio, sul database di produzione, perché lo script
 * legge `.env.local`.
 *
 * Lo script agisce SOLO sui genitori che hanno almeno un figlio nella sede
 * indicata: con tre plessi va lanciato tre volte, una per sede. Un genitore
 * senza figli in quella sede viene saltato e riportato, mai agganciato «a
 * indovinare»: è la stessa regola dell'app — ogni scrittura dichiara la sua sede.
 *
 * Legge NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY da .env.local.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function firstEmail(emails) {
  if (Array.isArray(emails)) {
    const e = emails.find((x) => typeof x === 'string' && x.includes('@'));
    return e ? String(e).trim() : null;
  }
  if (typeof emails === 'string' && emails.includes('@')) return emails.trim();
  return null;
}

function randomPassword() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url') + 'Aa1!';
}

async function buildEmailIndex(admin) {
  const map = new Map();
  let page = 1;
  const PER_PAGE = 100;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    for (const u of users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (users.length < PER_PAGE) break;
    page++;
  }
  return map;
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
  const scuolaArg = process.argv.indexOf('--scuola');
  const scuolaId = scuolaArg > -1 ? (process.argv[scuolaArg + 1] ?? '').trim() : '';
  if (!UUID_RE.test(scuolaId)) {
    console.error(
      '❌ Manca --scuola <uuid>: la sede va DICHIARATA, non indovinata.\n' +
        '   Le sedi di produzione sono tre e questo script scrive utenti.scuola_id.\n' +
        '   Gli uuid si leggono da `select id, nome from scuole` (mai copiati da un file del repo).\n\n' +
        '      node scripts/repair_parent_identities.mjs --scuola <uuid> [--apply]',
    );
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // La sede esiste? Un uuid sbagliato creerebbe righe `utenti` appese al nulla.
  const { data: sede, error: errSede } = await admin
    .from('scuole').select('id, nome').eq('id', scuolaId).maybeSingle();
  if (errSede) throw new Error(`scuole: ${errSede.message}`);
  if (!sede) {
    console.error(`❌ Nessuna sede con id ${scuolaId}.`);
    process.exit(1);
  }

  // I genitori della SEDE: quelli con almeno un figlio iscritto lì. `parents` non
  // ha `scuola_id` (verificato: la sede del genitore si deriva dai figli), quindi
  // il legame passa da alunni → student_parents. Due query invece di un embed:
  // gli id per sede sono decine, e l'errore di PostgREST resta leggibile.
  const { data: alunniSede, error: errAlunni } = await admin
    .from('alunni').select('id').eq('scuola_id', scuolaId);
  if (errAlunni) throw new Error(`alunni: ${errAlunni.message}`);
  const idAlunni = (alunniSede ?? []).map((a) => a.id);

  const legami = new Set();
  if (idAlunni.length > 0) {
    const { data: sp, error: errSp } = await admin
      .from('student_parents').select('parent_id').in('student_id', idAlunni);
    if (errSp) throw new Error(`student_parents: ${errSp.message}`);
    for (const r of sp ?? []) legami.add(r.parent_id);
  }

  const { data: tuttiParents, error } = await admin
    .from('parents')
    .select('id, first_name, last_name, emails, auth_user_id')
    .is('auth_user_id', null)
    .order('created_at');
  if (error) throw new Error(error.message);

  // Fuori scope ⇒ NEGA. Un genitore senza figli nella sede indicata non si
  // ripara qui: lo si ripara lanciando lo script sulla SUA sede.
  const parents = (tuttiParents ?? []).filter((p) => legami.has(p.id));
  const fuoriSede = (tuttiParents ?? []).length - parents.length;

  console.log(
    `${apply ? '🔧 APPLY' : '🔍 DRY-RUN'} — sede ${sede.nome} (${scuolaId})\n` +
      `   parents senza ponte auth con un figlio in questa sede: ${parents.length}` +
      `${fuoriSede > 0 ? ` · saltati perché di altre sedi (o senza figli): ${fuoriSede}` : ''}\n`,
  );

  const emailToId = await buildEmailIndex(admin);
  const report = { riparati: 0, authCreati: 0, authRiusati: 0, utentiCreati: 0, senzaEmail: 0, errori: 0 };

  for (const p of parents) {
    const label = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || p.id;
    const email = firstEmail(p.emails);
    if (!email) {
      report.senzaEmail++;
      console.log(`  ⚠️  ${label}: senza email → da completare in anagrafica prima di poter creare l'accesso`);
      continue;
    }
    const existingAuth = emailToId.get(email.toLowerCase()) ?? null;

    if (!apply) {
      console.log(`  · ${label} <${email}>: ${existingAuth ? `riusa auth ${existingAuth}` : 'crea auth nuovo'} + ponte + utenti(se manca)`);
      continue;
    }

    try {
      let authId = existingAuth;
      if (!authId) {
        const { data: cu, error: cErr } = await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          password: randomPassword(),
        });
        if (cErr || !cu?.user) throw new Error(`createUser: ${cErr?.message ?? 'fallito'}`);
        authId = cu.user.id;
        emailToId.set(email.toLowerCase(), authId);
        report.authCreati++;
      } else {
        report.authRiusati++;
      }

      const upd = await admin
        .from('parents')
        .update({ auth_user_id: authId })
        .eq('id', p.id)
        .is('auth_user_id', null)
        .select('id');
      if (upd.error) throw new Error(`ponte: ${upd.error.message}`);

      const { data: exUtente, error: exErr } = await admin.from('utenti').select('id').eq('id', authId).maybeSingle();
      if (exErr) throw new Error(`utenti(select): ${exErr.message}`);
      if (!exUtente) {
        const { error: insErr } = await admin.from('utenti').insert({
          id: authId,
          email,
          nome: (p.first_name ?? '').trim() || email.split('@')[0],
          cognome: (p.last_name ?? '').trim(),
          ruolo: 'genitore',
          scuola_id: scuolaId,
          attivo: true,
        });
        if (insErr) throw new Error(`utenti(insert): ${insErr.message}`);
        report.utentiCreati++;
      }

      report.riparati++;
      console.log(`  ✅ ${label} <${email}> → auth ${authId}${existingAuth ? ' (riusato)' : ' (creato)'}${exUtente ? '' : ' + riga utenti'}`);
    } catch (e) {
      report.errori++;
      console.log(`  ❌ ${label} <${email}>: ${e.message}`);
    }
  }

  console.log(`\nRiepilogo: ${JSON.stringify(report)}`);
  if (report.errori > 0) process.exit(2);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
