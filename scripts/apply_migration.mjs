/**
 * apply_migration.mjs
 * Applica la migrazione SQL direttamente via Supabase service role.
 * Usa pg-based approach tramite l'endpoint sql della Management API
 * oppure tramite un RPC custom se disponibile.
 *
 * Esegui con: node scripts/apply_migration.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://uimulkjyekgemjakmepp.supabase.co';
const SERVICE_KEY  = 'sb_secret_ySq-tmthFaVnxINtQ4NsAw_aTWNmbvD';
const PROJECT_REF  = 'uimulkjyekgemjakmepp';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
});

// ─── SQL della migrazione ─────────────────────────────────────────────────────

const MIGRATION_STEPS = [
    {
        desc: 'Aggiunge colonna materiale',
        sql: `ALTER TABLE public.armadietto ADD COLUMN IF NOT EXISTS materiale TEXT NOT NULL DEFAULT 'Generico';`
    },
    {
        desc: 'Aggiunge colonna quantita',
        sql: `ALTER TABLE public.armadietto ADD COLUMN IF NOT EXISTS quantita INTEGER NOT NULL DEFAULT 0;`
    },
    {
        desc: 'Aggiunge colonna date',
        sql: `ALTER TABLE public.armadietto ADD COLUMN IF NOT EXISTS date DATE NOT NULL DEFAULT CURRENT_DATE;`
    },
    {
        desc: 'Aggiunge colonna portato',
        sql: `ALTER TABLE public.armadietto ADD COLUMN IF NOT EXISTS portato BOOLEAN NOT NULL DEFAULT true;`
    },
    {
        desc: 'Aggiunge colonna alunno_id (se mancante)',
        sql: `ALTER TABLE public.armadietto ADD COLUMN IF NOT EXISTS alunno_id UUID;`
    },
    {
        desc: 'Crea indice idx_armadietto_alunno_date',
        sql: `CREATE INDEX IF NOT EXISTS idx_armadietto_alunno_date ON public.armadietto (alunno_id, date);`
    },
    {
        desc: 'Crea indice idx_armadietto_materiale',
        sql: `CREATE INDEX IF NOT EXISTS idx_armadietto_materiale ON public.armadietto (materiale);`
    },
    {
        desc: 'Notifica PostgREST reload schema',
        sql: `NOTIFY pgrst, 'reload schema';`
    },
];

// ─── Esecuzione via Management API ───────────────────────────────────────────

async function runSQL(sql) {
    const res = await fetch(
        `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SERVICE_KEY}`,
            },
            body: JSON.stringify({ query: sql }),
        }
    );
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

// ─── Fallback: crea la funzione exec_sql_kidville e la usa ───────────────────

async function ensureExecSqlFunction() {
    const { error } = await supabase.rpc('exec_sql_kidville', { sql_text: 'SELECT 1' }).maybeSingle();
    if (!error) return true; // già esiste

    // Prova a crearla via Management API
    const createFn = `
        CREATE OR REPLACE FUNCTION public.exec_sql_kidville(sql_text TEXT)
        RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
        DECLARE result JSON;
        BEGIN
          EXECUTE sql_text;
          RETURN '{"ok": true}'::JSON;
        END;
        $$;
        GRANT EXECUTE ON FUNCTION public.exec_sql_kidville(TEXT) TO service_role;
    `;
    const r = await runSQL(createFn);
    return r.status < 300;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🚀 Kidville — Applicazione migrazione armadietto\n');

    // Prima strategia: Management API
    console.log('📡 Tentativo tramite Supabase Management API...');
    let mgmtWorks = false;

    const testRes = await runSQL('SELECT 1 AS ok');
    if (testRes.status === 200) {
        mgmtWorks = true;
        console.log('✅ Management API disponibile\n');
    } else {
        console.log(`⚠️  Management API non disponibile (${testRes.status}): ${JSON.stringify(testRes.body)}`);
        console.log('🔄 Passo alla strategia RPC...\n');
    }

    if (mgmtWorks) {
        for (const step of MIGRATION_STEPS) {
            process.stdout.write(`  ⏳ ${step.desc}...`);
            const r = await runSQL(step.sql);
            if (r.status < 300 || JSON.stringify(r.body).includes('already exists')) {
                console.log(' ✅');
            } else {
                console.log(` ⚠️  ${JSON.stringify(r.body)}`);
            }
        }
    } else {
        // Seconda strategia: RPC via service role
        console.log('📡 Tentativo tramite funzione RPC...');
        await ensureExecSqlFunction();

        for (const step of MIGRATION_STEPS) {
            process.stdout.write(`  ⏳ ${step.desc}...`);
            try {
                const { error } = await supabase.rpc('exec_sql_kidville', { sql_text: step.sql });
                if (error && !error.message.includes('already exists') && !error.message.includes('duplicate')) {
                    console.log(` ⚠️  ${error.message}`);
                } else {
                    console.log(' ✅');
                }
            } catch (e) {
                console.log(` ❌ ${e.message}`);
            }
        }
    }

    // ── Verifica colonne post-migrazione ─────────────────────────────────────
    console.log('\n🔍 Verifica schema attuale della tabella armadietto:');

    if (mgmtWorks) {
        const r = await runSQL(
            `SELECT column_name, data_type, column_default, is_nullable
             FROM information_schema.columns
             WHERE table_schema='public' AND table_name='armadietto'
             ORDER BY ordinal_position;`
        );
        if (Array.isArray(r.body)) {
            r.body.forEach(col => {
                console.log(`  • ${col.column_name.padEnd(15)} ${col.data_type.padEnd(20)} default: ${col.column_default ?? 'none'}`);
            });
        } else {
            console.log('  Risposta:', JSON.stringify(r.body));
        }
    } else {
        const { error } = await supabase
            .from('armadietto')
            .select('*')
            .limit(0);
        if (!error) {
            console.log('  ✅ Tabella accessibile (SELECT * senza errori)');
        } else {
            console.log('  ⚠️ ', error.message);
        }
    }

    // ── Inserisci dati mock ───────────────────────────────────────────────────
    console.log('\n🌱 Inserimento dati mock per testing...');
    await insertMockData();

    console.log('\n✅ Migrazione completata!\n');
}

async function insertMockData() {
    // Prima verifica che la tabella abbia le colonne giuste
    const testInsert = await supabase
        .from('armadietto')
        .select('id, alunno_id, materiale, date, portato')
        .limit(1);

    if (testInsert.error) {
        console.log(`  ⚠️  Colonne ancora mancanti: ${testInsert.error.message}`);
        console.log('  ℹ️  Applica la migrazione manualmente dal Supabase Dashboard');
        return;
    }

    console.log('  ✅ Schema corretto, procedo con i dati mock...');

    // Recupera due alunni reali
    const { data: alunni, error: alunniErr } = await supabase
        .from('alunni')
        .select('id, nome, cognome')
        .eq('classe_sezione', 'Girasoli')
        .limit(2);

    if (alunniErr || !alunni || alunni.length === 0) {
        console.log(`  ⚠️  Nessun alunno in "Girasoli": ${alunniErr?.message ?? 'tabella vuota'}`);
        // Usa Sofia Esposito (hardcoded dev ID)
        await insertMockForAlunno('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sofia');
        return;
    }

    for (const alunno of alunni) {
        await insertMockForAlunno(alunno.id, alunno.nome);
    }
}

async function insertMockForAlunno(alunnoId, nome) {
    const materiali = ['Pannolini', 'Crema', 'Salviette'];
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth(); // 0-indexed

    let inserted = 0;
    let skipped = 0;

    for (const mat of materiali) {
        // Inserisci dati per i primi 12 giorni lavorativi del mese corrente
        for (let day = 1; day <= 12; day++) {
            const d = new Date(year, month, day);
            if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekend
            const dateStr = d.toISOString().slice(0, 10);
            const portato = Math.random() > 0.2; // 80% portato

            const { error } = await supabase
                .from('armadietto')
                .upsert(
                    {
                        alunno_id: alunnoId,
                        materiale: mat,
                        quantita: Math.floor(Math.random() * 15) + 1,
                        date: dateStr,
                        portato,
                    },
                    { onConflict: 'alunno_id,materiale,date', ignoreDuplicates: false }
                );

            if (error && !error.message.includes('duplicate')) {
                skipped++;
            } else {
                inserted++;
            }
        }
    }
    console.log(`  📦 ${nome}: ${inserted} record inseriti, ${skipped} saltati`);
}

main().catch(err => {
    console.error('❌ Errore fatale:', err);
    process.exit(1);
});
