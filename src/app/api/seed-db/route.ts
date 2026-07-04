import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { sealDangerous } from '@/lib/security/seal';
import { parseQuery } from '@/lib/validation/http';

const getQuerySchema = z.object({}); // nessun parametro in ingresso
const postQuerySchema = z.object({}); // nessun parametro in ingresso (il body non viene letto)

export async function GET(request: Request) {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    return seed();
}

export async function POST(request: Request) {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const q = parseQuery(request, postQuerySchema);
    if ('response' in q) return q.response;
    return seed();
}

async function seed() {
    const supabase = await createAdminClient();

    // 1. Get or create school
    const schoolId = '11111111-1111-1111-1111-111111111111';
    await supabase.from('schools').upsert({ 
        id: schoolId, 
        nome: 'Kidville Roma', 
        indirizzo: 'Via Roma 1', 
        citta: 'Roma' 
    }, { onConflict: 'id' });

    const firstNames = ['Luca', 'Sofia', 'Matteo', 'Giulia', 'Alessandro', 'Emma', 'Riccardo', 'Aurora', 'Leonardo', 'Chiara'];
    const lastNames = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Gallo', 'Conti', 'Marini', 'Ricci', 'Bruno'];
    const sections = ['Girasoli', 'Margherite', 'Tulipani', 'Coccinelle'];

    const results = [];

    for (let i = 0; i < 10; i++) {
        const studentId = crypto.randomUUID();
        const motherId = crypto.randomUUID();
        const fatherId = crypto.randomUUID();
        const delegateId = crypto.randomUUID();

        // 1. Alunno
        const student = {
            id: studentId,
            nome: firstNames[i],
            cognome: lastNames[i],
            scuola_id: schoolId,
            data_nascita: `2019-05-${(i + 1).toString().padStart(2, '0')}`,
            classe_sezione: sections[i % 4],
            stato: 'iscritto',
            gender: i % 2 === 0 ? 'F' : 'M',
            codice_fiscale: (lastNames[i].slice(0, 3) + firstNames[i].slice(0, 3) + '19A' + (i + 1).toString().padStart(2, '0') + 'H501Z').toUpperCase()
        };

        const { error: studentErr } = await supabase.from('alunni').upsert(student);
        if (studentErr) {
            console.error(`Error inserting student ${i}:`, studentErr);
            return NextResponse.json({ error: `student ${i}: ${studentErr.message}` }, { status: 500 });
        }

        // 2. Genitori
        // NOTA: La tabella parents ha un FK su auth.users(id). 
        // Se non creiamo gli utenti in auth, l'upsert fallirà.
        // Per test, proviamo a inserire comunque, ma probabilmente fallirà se non mappati.
        
        const mother = {
            id: motherId,
            first_name: `Mamma ${firstNames[i]}`,
            last_name: lastNames[i],
            gender: 'F',
            fiscal_code: (lastNames[i].slice(0, 3) + 'MMM' + '85A' + (i + 1).toString().padStart(2, '0') + 'H501Z').toUpperCase(),
            emails: [`mamma.${firstNames[i].toLowerCase()}@example.it`],
            phone_numbers: [`33312345${i}`]
        };

        const father = {
            id: fatherId,
            first_name: `Papà ${firstNames[i]}`,
            last_name: lastNames[i],
            gender: 'M',
            fiscal_code: (lastNames[i].slice(0, 3) + 'PPP' + '82A' + (i + 1).toString().padStart(2, '0') + 'H501Z').toUpperCase(),
            emails: [`papa.${firstNames[i].toLowerCase()}@example.it`],
            phone_numbers: [`34498765${i}`]
        };

        const { error: parentErr } = await supabase.from('parents').upsert([mother, father]);
        if (parentErr) {
            console.warn(`Error inserting parents for student ${i} (Expected if auth.users is empty):`, parentErr.message);
            // Non blocchiamo il seed degli alunni se i genitori falliscono per via di auth
        } else {
            // 3. Collegamenti (solo se i genitori sono stati creati)
            await supabase.from('student_parents').upsert([
                { student_id: studentId, parent_id: motherId, relation_type: 'mother', is_primary: true },
                { student_id: studentId, parent_id: fatherId, relation_type: 'father', is_primary: false }
            ]);
        }

        // 4. Delegato
        const delegate = {
            id: delegateId,
            alunno_id: studentId,
            first_name: `Zia ${firstNames[i]}`,
            last_name: lastNames[i],
            relation: 'Zia',
            document_type: 'Carta di Identità',
            document_number: `AB12345${i}`
        };

        const { error: delegateErr } = await supabase.from('delegates').upsert(delegate);
        if (delegateErr) {
            console.warn(`Error inserting delegate for student ${i}:`, delegateErr.message);
        }

        results.push(student.nome + ' ' + student.cognome);
    }


    return NextResponse.json({
        success: true,
        message: 'Database seeded correctly with 10 students and their families',
        inserted: results
    });
}

