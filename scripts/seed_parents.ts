/**
 * Seed di sviluppo: collega dei genitori di prova ad alunni di prova.
 *
 * Esegui: export $(cat .env.local | xargs) && KV_SEED_CONFERMO=1 npx tsx scripts/seed_parents.ts
 *
 * ─── PERCHÉ QUESTO FILE È STATO RISCRITTO (2026-08-02) ───────────────────────
 *
 * Com'era: quattro coppie nome+cognome di bambini e di genitori, con i rispettivi
 * uuid, e il commento «alunni REALI della sezione Girasoli» — in un repository
 * PUBBLICO. Verificato in produzione: nessuno di quegli uuid e nessuna di quelle
 * coppie esiste più, azzerati dal reset del 2026-07-04. Quindi oggi non erano
 * dati personali.
 *
 * Ma «oggi non lo sono» è la misura sbagliata. Se il reset non ci fosse stato,
 * questo file sarebbe stato l'incidente del PRD ripetuto dentro uno script
 * committato — e chi legge un repo pubblico non ha modo di sapere che quei nomi
 * non corrispondono a nessuno: legge «alunni reali» e ci crede. I nomi qui sotto
 * sono ora SEGNAPOSTO INVENTATI, dichiarati tali, e non vanno mai ricopiati
 * dall'anagrafica.
 *
 * ─── E PERCHÉ NON PARTE PIÙ DA SOLO ──────────────────────────────────────────
 *
 * `.env.local` punta al database di PRODUZIONE, dove ci sono dati reali di
 * minori. Questo script scrive con la SERVICE ROLE KEY, cioè scavalcando ogni
 * gate applicativo. Un `npx tsx scripts/seed_parents.ts` battuto per sbaglio era,
 * fino a oggi, una scrittura silenziosa su produzione. Ora serve
 * `KV_SEED_CONFERMO=1`: non è una gran difesa, ma trasforma un incidente in una
 * decisione.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Coppie genitore↔alunno di PROVA. Nomi e uuid sono INVENTATI: nessuno di questi
 * valori corrisponde a una persona. Non sostituirli con nomi presi
 * dall'anagrafica — questo file è pubblico. Se servono legami su dati veri si
 * passa dall'interfaccia di segreteria, che lascia traccia in `logScrittura`.
 */
const LINKS = [
    {
        parent_id: '44444444-4444-4444-4444-444444444444',
        parent_name: 'Genitore di prova 1',
        student_id: '11111111-1111-4111-8111-000000000001',
        student_name: 'Alunno di prova 1',
    },
    {
        parent_id: '55555555-5555-5555-5555-555555555555',
        parent_name: 'Genitore di prova 2',
        student_id: '11111111-1111-4111-8111-000000000002',
        student_name: 'Alunno di prova 2',
    },
    {
        parent_id: '66666666-6666-6666-6666-666666666666',
        parent_name: 'Genitore di prova 3',
        student_id: '11111111-1111-4111-8111-000000000003',
        student_name: 'Alunno di prova 3',
    },
    {
        parent_id: '77777777-7777-7777-7777-777777777777',
        parent_name: 'Genitore di prova 4',
        student_id: '11111111-1111-4111-8111-000000000004',
        student_name: 'Alunno di prova 4',
    },
];

async function supabaseRpc(path: string, method: string, body?: unknown) {
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
    if (process.env.KV_SEED_CONFERMO !== '1') {
        console.error(
            'Rifiuto di partire. Questo script scrive con la SERVICE ROLE KEY sul database\n' +
            'indicato da NEXT_PUBLIC_SUPABASE_URL — che in questo repo, con .env.local, è la\n' +
            'PRODUZIONE, dove ci sono dati reali di minori.\n' +
            'Se sai cosa stai facendo: KV_SEED_CONFERMO=1 npx tsx scripts/seed_parents.ts',
        );
        process.exitCode = 1;
        return;
    }

    console.log('🔗 Collegamento genitori di prova → alunni di prova\n');

    for (const link of LINKS) {
        console.log(`👤 ${link.parent_name} → 👶 ${link.student_name}`);
        try {
            await supabaseRpc('legame_genitori_alunni', 'POST', {
                genitore_id: link.parent_id,
                alunno_id: link.student_id,
            });
            console.log('  ✅ Legame creato');
        } catch (e) {
            console.log(`  ⚠️ ${(e as { message?: string })?.message}`);
        }
        console.log('');
    }

    console.log('🎉 Legami di prova creati.');
}

main().catch(console.error);
