import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET: Recupera i certificati medici per gli alunni di una specifica classe
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const className = searchParams.get('class_name');

    if (!className) {
      return NextResponse.json({ error: 'class_name è obbligatorio' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // 1. Recupera gli ID degli alunni della classe
    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome')
      .eq('classe_sezione', className);

    if (studErr || !students) {
      return NextResponse.json({ error: studErr?.message || 'Errore alunni' }, { status: 500 });
    }

    const studentIds = students.map(s => s.id);

    if (studentIds.length === 0) {
      return NextResponse.json([]);
    }

    // 2. Carica i certificati medici per questi alunni
    const { data: certs, error: certErr } = await supabase
      .from('certificati_medici')
      .select('*')
      .in('alunno_id', studentIds)
      .order('creato_il', { ascending: false });

    if (certErr) {
      return NextResponse.json({ error: certErr.message }, { status: 500 });
    }

    // Unisce le info dello studente al certificato
    const results = certs.map(c => {
      const student = students.find(s => s.id === c.alunno_id);
      return {
        ...c,
        nome_alunno: student?.nome || '',
        cognome_alunno: student?.cognome || ''
      };
    });

    return NextResponse.json(results);
  } catch (err: any) {
    console.error('Errore GET /api/teacher/medical-certificates:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// PATCH: Spunta i giorni di assenza coperti dal certificato medico
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { certificate_id, giorni_coperti } = body;

    if (!certificate_id || !Array.isArray(giorni_coperti)) {
      return NextResponse.json({ error: 'certificate_id e giorni_coperti[] sono obbligatori' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    const { data, error } = await supabase
      .from('certificati_medici')
      .update({ giorni_coperti })
      .eq('id', certificate_id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    console.error('Errore PATCH /api/teacher/medical-certificates:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
