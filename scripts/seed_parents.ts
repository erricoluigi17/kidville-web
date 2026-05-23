/**
 * Seed aggiuntivo: collega i genitori già creati agli alunni effettivi della sezione Girasoli.
 *
 * Esegui: export $(cat .env.local | xargs) && npx tsx scripts/seed_parents.ts
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Genitori già creati → associamo ognuno a un alunno reale della sezione Girasoli
const LINKS = [
    {
        parent_id: '44444444-4444-4444-4444-444444444444',
        parent_name: 'Marco Ricci',
        student_id: '6c69a221-1f2f-4e22-8b50-bedcb37e13bf',  // Federico Ferrari
        student_name: 'Federico Ferrari',
    },
    {
        parent_id: '55555555-5555-5555-5555-555555555555',
        parent_name: 'Laura Conti',
        student_id: 'c486c4bb-a23d-4992-ad88-0dc7a71d13cc',  // Chiara Esposito
        student_name: 'Chiara Esposito',
    },
    {
        parent_id: '66666666-6666-6666-6666-666666666666',
        parent_name: 'Giuseppe Ferrara',
        student_id: 'dc617529-e80d-4084-9041-fb28e864089f',  // Tommaso Bianchi
        student_name: 'Tommaso Bianchi',
    },
    {
        parent_id: '77777777-7777-7777-7777-777777777777',
        parent_name: 'Francesca Martini',
        student_id: 'f39a512c-1f00-41af-9710-a3d002c7f4a2',  // Sara Romano
        student_name: 'Sara Romano',
    },
];

async function supabaseRpc(path: string, method: string, body?: any) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal,resolution=merge-duplicates',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return res;
}

async function main() {
    console.log('🔗 Collegamento genitori → alunni reali (sezione Girasoli)\n');

    for (const link of LINKS) {
        console.log(`👤 ${link.parent_name} → 👶 ${link.student_name}`);
        try {
            await supabaseRpc('legame_genitori_alunni', 'POST', {
                genitore_id: link.parent_id,
                alunno_id: link.student_id,
            });
            console.log('  ✅ Legame creato');
        } catch (e: any) {
            console.log(`  ⚠️ ${e.message}`);
        }
        console.log('');
    }

    console.log('🎉 Tutti i legami creati! I genitori ora appariranno nella lista contatti della chat.');
}

main().catch(console.error);
