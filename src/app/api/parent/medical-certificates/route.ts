import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333';

// POST: Caricamento certificato medico
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { student_id, file_path, notes, parent_id } = body;

    if (!student_id || !file_path) {
      return NextResponse.json({ error: 'student_id e file_path sono obbligatori' }, { status: 400 });
    }

    const currentParentId = parent_id || DEFAULT_PARENT_ID;
    const supabase = await createAdminClient();

    const record = {
      alunno_id: student_id,
      file_path: file_path,
      caricato_da: currentParentId,
      note: notes || '',
      giorni_coperti: [] // Vuoto all'inizio, verrà spuntato dall'insegnante
    };

    const { data, error } = await supabase
      .from('certificati_medici')
      .insert(record)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error('Errore POST /api/parent/medical-certificates:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// GET: Recupera i certificati caricati per un genitore (solo dettagli di base, per privacy)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get('parent_id') || DEFAULT_PARENT_ID;

    const supabase = await createAdminClient();

    const { data, error } = await supabase
      .from('certificati_medici')
      .select(`
        id,
        file_path,
        giorni_coperti,
        note,
        creato_il,
        alunno:alunni(nome, cognome)
      `)
      .eq('caricato_da', parentId)
      .order('creato_il', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Rimuoviamo il link diretto al file path nello storage per privacy (come da PRD: "Genitore non ha storico cumulativo")
    // O meglio, restituiamo solo i nomi dei file e lo stato dei giorni coperti.
    const securedData = data?.map(item => ({
      id: item.id,
      fileName: item.file_path.split('/').pop(),
      notes: item.note,
      giorni_coperti: item.giorni_coperti,
      creato_il: item.creato_il,
      alunno: item.alunno
    }));

    return NextResponse.json(securedData);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
