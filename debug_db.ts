import { createAdminClient } from './src/lib/supabase/server-client';

async function debug() {
    const supabase = await createAdminClient();
    const { count, error } = await supabase.from('alunni').select('*', { count: 'exact', head: true });
    console.log('STUDENTS COUNT:', count, error);
    
    const { data: students } = await supabase.from('alunni').select('*').limit(5);
    console.log('SAMPLE STUDENTS:', students);
}

debug();
