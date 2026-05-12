/**
 * seed_mock_data.mjs
 * Popola l'armadietto con dati mock realistici per tutto maggio 2026
 * per i due studenti principali della classe Girasoli.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://uimulkjyekgemjakmepp.supabase.co';
const SERVICE_KEY  = 'sb_secret_ySq-tmthFaVnxINtQ4NsAw_aTWNmbvD';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
});

// Alunni reali trovati nel DB
const ALUNNI = [
    { id: '6c69a221-1f2f-4e22-8b50-bedcb37e13bf', nome: 'Francesca Russo' },
    { id: '28dbe4fc-a231-4b57-ab03-c7f205644205', nome: 'Federico Ferrari' },
];

const MATERIALI = ['Pannolini', 'Crema', 'Salviette'];

// Genera giorni lavorativi di maggio 2026
function getWorkdaysInMonth(year, month) {
    const days = [];
    const d = new Date(year, month - 1, 1);
    while (d.getMonth() === month - 1) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) {
            days.push(d.toISOString().slice(0, 10));
        }
        d.setDate(d.getDate() + 1);
    }
    return days;
}

// Quantità simulate realistiche per materiale
function mockQty(materiale, portato) {
    if (!portato) return 0;
    if (materiale === 'Pannolini') return Math.floor(Math.random() * 8) + 4;  // 4-12
    if (materiale === 'Crema')     return Math.floor(Math.random() * 5) + 2;  // 2-7
    if (materiale === 'Salviette') return Math.floor(Math.random() * 15) + 5; // 5-20
    return 5;
}

async function seed() {
    console.log('🌱 Seeding dati mock armadietto — Maggio 2026\n');

    const workdays = getWorkdaysInMonth(2026, 5);
    console.log(`📅 Giorni lavorativi in maggio: ${workdays.length}`);

    // Filtra solo i giorni <= oggi (12 maggio)
    const today = '2026-05-12';
    const pastDays = workdays.filter(d => d <= today);
    console.log(`📅 Giorni fino ad oggi: ${pastDays.length} (${pastDays[0]} → ${pastDays[pastDays.length - 1]})\n`);

    let totalInserted = 0;
    let totalSkipped  = 0;

    for (const alunno of ALUNNI) {
        console.log(`👤 ${alunno.nome}:`);

        for (const materiale of MATERIALI) {
            const rows = [];

            for (const date of pastDays) {
                // Francesca: più affidabile (90% portato)
                // Federico: meno affidabile (75% portato)
                const threshold = alunno.nome.includes('Francesca') ? 0.1 : 0.25;
                const portato   = Math.random() > threshold;
                const quantita  = mockQty(materiale, portato);

                rows.push({
                    alunno_id: alunno.id,
                    nome_oggetto: materiale,
                    materiale,
                    quantita_residua: quantita,
                    quantita,
                    date,
                    portato,
                    livello_allerta: materiale === 'Pannolini' ? 5 : 3,
                    livello_emergenza: materiale === 'Pannolini' ? 2 : 1,
                });
            }

            const { error } = await supabase
                .from('armadietto')
                .upsert(rows, {
                    onConflict: 'alunno_id,materiale,date',
                    ignoreDuplicates: false,
                });

            if (error) {
                console.log(`  ⚠️  ${materiale}: ${error.message}`);
                totalSkipped += rows.length;
            } else {
                console.log(`  ✅ ${materiale.padEnd(12)}: ${rows.length} record`);
                totalInserted += rows.length;
            }
        }
    }

    console.log(`\n✅ Totale inseriti/aggiornati: ${totalInserted}`);
    if (totalSkipped > 0) console.log(`⚠️  Saltati: ${totalSkipped}`);

    // Verifica finale
    const { data: finalCount, error: countErr } = await supabase
        .from('armadietto')
        .select('id', { count: 'exact', head: true });

    const count = finalCount === null ? '?' : countErr ? 'N/A' : 'ok';
    const { count: total } = await supabase
        .from('armadietto')
        .select('*', { count: 'exact', head: true });

    console.log(`\n📊 Totale record in tabella: ${total ?? '?'}`);
    console.log('\n🎉 Seeding completato!');
}

seed().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
});
