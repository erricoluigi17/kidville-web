/**
 * seed_armadietto_rest.mjs
 * Popola l'armadietto usando INSERT semplice (senza upsert)
 * per i due studenti reali di classe Girasoli.
 */

const SUPABASE_URL = 'https://uimulkjyekgemjakmepp.supabase.co';
const SERVICE_KEY  = 'sb_secret_ySq-tmthFaVnxINtQ4NsAw_aTWNmbvD';

const HEADERS = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
};

const ALUNNI = [
    { id: '6c69a221-1f2f-4e22-8b50-bedcb37e13bf', nome: 'Francesca Russo',   affidabile: 0.9 },
    { id: '28dbe4fc-a231-4b57-ab03-c7f205644205', nome: 'Federico Ferrari', affidabile: 0.72 },
];

const MATERIALI = [
    { nome: 'Pannolini', livello_allerta: 5, livello_emergenza: 2 },
    { nome: 'Crema',     livello_allerta: 3, livello_emergenza: 1 },
    { nome: 'Salviette', livello_allerta: 4, livello_emergenza: 2 },
];

function getWorkdays(year, month) {
    const days = [];
    const d = new Date(year, month - 1, 1);
    while (d.getMonth() === month - 1) {
        if (d.getDay() !== 0 && d.getDay() !== 6) days.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
    }
    return days;
}

function randomQty(mat, portato) {
    if (!portato) return 0;
    if (mat === 'Pannolini') return Math.floor(Math.random() * 8) + 4;
    if (mat === 'Crema')     return Math.floor(Math.random() * 5) + 2;
    return Math.floor(Math.random() * 15) + 5;
}

async function restPost(path, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text };
}

async function restDelete(path, filter) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${filter}`, {
        method: 'DELETE',
        headers: HEADERS,
    });
    return { status: r.status };
}

async function main() {
    console.log('🌱 Seeding armadietto — Maggio 2026\n');

    // Rimuovi i record già presenti per i due alunni (per evitare duplicati)
    console.log('🧹 Pulizia record esistenti...');
    for (const a of ALUNNI) {
        const r = await restDelete('armadietto', `alunno_id=eq.${a.id}`);
        console.log(`  🗑️  ${a.nome}: HTTP ${r.status}`);
    }

    const workdays = getWorkdays(2026, 5);
    const today = '2026-05-12';
    const pastDays = workdays.filter(d => d <= today);
    console.log(`\n📅 Giorni lavorativi passati: ${pastDays.length} (${pastDays[0]} → ${pastDays[pastDays.length - 1]})\n`);

    let totalInserted = 0;

    for (const alunno of ALUNNI) {
        console.log(`👤 ${alunno.nome}:`);
        for (const mat of MATERIALI) {
            const rows = pastDays.map(date => {
                const portato  = Math.random() < alunno.affidabile;
                const quantita = randomQty(mat.nome, portato);
                return {
                    alunno_id:         alunno.id,
                    nome_oggetto:      mat.nome,
                    materiale:         mat.nome,
                    quantita_residua:  quantita,
                    quantita,
                    date,
                    portato,
                    livello_allerta:   mat.livello_allerta,
                    livello_emergenza: mat.livello_emergenza,
                };
            });

            const { status, body } = await restPost('armadietto', rows);
            if (status >= 200 && status < 300) {
                console.log(`  ✅ ${mat.nome.padEnd(12)}: ${rows.length} record`);
                totalInserted += rows.length;
            } else {
                console.log(`  ⚠️  ${mat.nome}: HTTP ${status} — ${body.slice(0, 120)}`);
            }
        }
    }

    // Conta finale
    const r = await fetch(`${SUPABASE_URL}/rest/v1/armadietto?select=count`, {
        headers: { ...HEADERS, 'Prefer': 'count=exact' },
    });
    const cr = r.headers.get('content-range');
    console.log(`\n📊 Record totali in armadietto: ${cr ?? '?'}`);
    console.log(`✅ Inseriti in questo run: ${totalInserted}\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
