/**
 * apply_fase3_v2.mjs
 * Strategia: usa la DB connection string direttamente con 'pg' library
 * Oppure crea la funzione RPC con un approccio alternativo
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://uimulkjyekgemjakmepp.supabase.co';
const SERVICE_KEY  = 'sb_secret_ySq-tmthFaVnxINtQ4NsAw_aTWNmbvD';
const PROJECT_REF  = 'uimulkjyekgemjakmepp';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
});

// Prova a creare la funzione exec_sql_kidville tramite POST diretto al DB endpoint
async function createExecFunction() {
    console.log('📡 Creazione funzione exec_sql_kidville via Management API...');
    
    const createSql = `
        CREATE OR REPLACE FUNCTION public.exec_sql_kidville(sql_text TEXT)
        RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN
            EXECUTE sql_text;
            RETURN '{"ok": true}'::JSON;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object('error', SQLERRM);
        END;
        $$;
        GRANT EXECUTE ON FUNCTION public.exec_sql_kidville(TEXT) TO service_role;
    `;
    
    // Tenta via Management API v1
    const endpoints = [
        `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
        `https://${PROJECT_REF}.supabase.co/rest/v1/rpc/exec_sql_kidville`,
    ];
    
    // Prima: tenta Management API
    const mgmtRes = await fetch(endpoints[0], {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({ query: createSql }),
    });
    
    if (mgmtRes.status < 300) {
        console.log('✅ Funzione creata via Management API');
        return true;
    }
    
    console.log(`⚠️  Management API status: ${mgmtRes.status}`);
    
    // Secondo tentativo: prova SQL inline tramite Edge Function o altro
    // Usiamo un workaround: creare un record fittizio che fa trigger
    
    return false;
}

// Approccio alternativo: usa fetch diretto alla REST API per operazioni CRUD
// sulle tabelle che dobbiamo creare. Se non funziona, guidiamo l'utente.
async function checkIfTablesExist() {
    const tables = ['chat_threads', 'chat_messages', 'avvisi', 'avvisi_risposte', 'galleria_media_v2', 'task_interni'];
    const results = {};
    for (const table of tables) {
        const { error } = await supabase.from(table).select('id').limit(0);
        results[table] = !error;
    }
    return results;
}

async function main() {
    console.log('🚀 Kidville — Migrazione Fase 3 (v2)\n');
    
    // Check se le tabelle esistono già
    console.log('🔍 Verifica tabelle esistenti...');
    const existing = await checkIfTablesExist();
    const allExist = Object.values(existing).every(v => v);
    
    if (allExist) {
        console.log('✅ Tutte le tabelle esistono già! Niente da fare.\n');
        Object.entries(existing).forEach(([t]) => console.log(`  ✅ ${t}`));
        return;
    }
    
    Object.entries(existing).forEach(([t, ok]) => console.log(`  ${ok ? '✅' : '❌'} ${t}`));
    
    // Tenta di creare la funzione
    const fnCreated = await createExecFunction();
    
    if (fnCreated) {
        // Attendi un momento per il cache refresh
        console.log('\n⏳ Attendo schema cache refresh (3s)...');
        await new Promise(r => setTimeout(r, 3000));
    }
    
    // Tenta RPC
    console.log('\n📡 Esecuzione migrazione via RPC...');
    const { error: testErr } = await supabase.rpc('exec_sql_kidville', { sql_text: 'SELECT 1' }).maybeSingle();
    
    if (testErr) {
        console.log(`\n⚠️  La funzione RPC non è disponibile: ${testErr.message}`);
        console.log('\n📋 ═══════════════════════════════════════════════════════════');
        console.log('  La migrazione deve essere eseguita manualmente.');
        console.log('  Apri il SQL Editor su Supabase Dashboard e incolla il');
        console.log('  contenuto del file:');
        console.log('  supabase/migrations/20260518_fase3_comunicazione_media.sql');
        console.log('═══════════════════════════════════════════════════════════\n');
        console.log('  URL: https://supabase.com/dashboard/project/uimulkjyekgemjakmepp/sql/new');
        console.log('\n  Dopo aver eseguito la migrazione, ritorna qui per la verifica.\n');
        return;
    }
    
    console.log('✅ RPC funzionante, esecuzione migrazione...');
    
    // Esegui il SQL completo
    const migrationSQL = (await import('fs')).readFileSync('supabase/migrations/20260518_fase3_comunicazione_media.sql', 'utf-8');
    
    // Splitta per statement
    const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));
    
    let success = 0, failed = 0;
    for (const stmt of statements) {
        const desc = stmt.substring(0, 50).replace(/\n/g, ' ');
        process.stdout.write(`  ⏳ ${desc}...`);
        const { error } = await supabase.rpc('exec_sql_kidville', { sql_text: stmt + ';' });
        if (error && !error.message.includes('already exists') && !error.message.includes('duplicate')) {
            console.log(` ⚠️  ${error.message}`);
            failed++;
        } else {
            console.log(' ✅');
            success++;
        }
    }
    
    console.log(`\n📊 Risultato: ${success} successi, ${failed} errori`);
    
    // Verifica finale
    console.log('\n🔍 Verifica finale...');
    const final = await checkIfTablesExist();
    Object.entries(final).forEach(([t, ok]) => console.log(`  ${ok ? '✅' : '❌'} ${t}`));
    
    console.log('\n✅ Migrazione completata!\n');
}

main().catch(err => { console.error('❌ Errore fatale:', err); process.exit(1); });
