import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function GET() {
    return seed();
}

export async function POST() {
    return seed();
}

async function seed() {
    const supabase = await createAdminClient();

    // 1. Crea la scuola
    const { data: school, error: schoolErr } = await supabase
        .from('schools')
        .upsert({ id: '11111111-1111-1111-1111-111111111111', nome: 'Kidville Roma', indirizzo: 'Via Roma 1', citta: 'Roma' }, { onConflict: 'id' })
        .select()
        .single();
    if (schoolErr) return NextResponse.json({ error: `school: ${schoolErr.message}` }, { status: 500 });

    const schoolId = school.id;

    // 2. Crea l'insegnante
    await supabase.from('utenti').upsert({
        id: '22222222-2222-2222-2222-222222222222',
        email: 'maestra.anna@kidville.it',
        password_segreta: 'hashed_placeholder',
        nome: 'Anna',
        cognome: 'Verdi',
        ruolo: 'maestra',
        scuola_id: schoolId,
    }, { onConflict: 'id' });

    // 3. Crea gli alunni
    const studentsData = [
        { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nome: 'Sofia', cognome: 'Esposito', data_nascita: '2022-03-15', note_mediche: 'Lattosio, Frutta secca', classe_sezione: 'Girasoli', scuola_id: schoolId, stato: 'iscritto' },
        { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', nome: 'Leonardo', cognome: 'Ricci', data_nascita: '2022-05-20', note_mediche: null, classe_sezione: 'Girasoli', scuola_id: schoolId, stato: 'iscritto' },
        { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', nome: 'Emma', cognome: 'Conti', data_nascita: '2022-01-10', note_mediche: 'Glutine', classe_sezione: 'Girasoli', scuola_id: schoolId, stato: 'iscritto' },
        { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', nome: 'Matteo', cognome: 'Ferrara', data_nascita: '2021-11-05', note_mediche: null, classe_sezione: 'Girasoli', scuola_id: schoolId, stato: 'iscritto' },
        { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', nome: 'Giulia', cognome: 'Martini', data_nascita: '2022-07-22', note_mediche: null, classe_sezione: 'Girasoli', scuola_id: schoolId, stato: 'iscritto' },
    ];

    await supabase.from('alunni').upsert(studentsData, { onConflict: 'id' });

    // 4. Inventario Armadietto (Tabella: armadietto)
    const inventoryData = [
        { alunno_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', materiale: 'Pannolini', quantita: 4, unita: 'pz', livello_allerta: 5, livello_emergenza: 2 },
        { alunno_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', materiale: 'Pannolini', quantita: 1, unita: 'pz', livello_allerta: 5, livello_emergenza: 2 },
        { alunno_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', materiale: 'Pannolini', quantita: 15, unita: 'pz', livello_allerta: 5, livello_emergenza: 2 },
        { alunno_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', materiale: 'Salviette', quantita: 8, unita: 'pz', livello_allerta: 3, livello_emergenza: 1 },
    ];
    
    for (const inv of inventoryData) {
        await supabase.from('armadietto').upsert(inv, { onConflict: 'alunno_id,materiale' });
    }

    return NextResponse.json({
        success: true,
        message: 'Database seeded correctly using table "armadietto"',
        studentsCount: studentsData.length,
        inventoryCount: inventoryData.length
    });
}
