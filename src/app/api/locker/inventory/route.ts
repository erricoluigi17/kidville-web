import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const alunnoId = searchParams.get('alunno_id');
        const classeSezione = searchParams.get('classe_sezione');
        const supabase = await createClient();

        if (alunnoId) {
            const { data, error } = await supabase.from('armadietto').select('*').eq('alunno_id', alunnoId);
            if (error) throw error;
            return NextResponse.json(data);
        } else if (classeSezione) {
            const { data: alunni, error: errA } = await supabase.from('alunni').select('id, nome, cognome').eq('classe_sezione', classeSezione).eq('stato', 'iscritto');
            if (errA) throw errA;
            const { data: inv, error: errI } = await supabase.from('armadietto').select('*').in('alunno_id', alunni.map(a => a.id));
            if (errI) throw errI;
            return NextResponse.json(alunni.map(a => ({ ...a, inventario: (inv ?? []).filter(i => i.alunno_id === a.id) })));
        }
        return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();
        const { alunno_id, materiale, quantita } = body;

        if (!alunno_id || !materiale || quantita === undefined) {
            return NextResponse.json({ error: 'Dati mancanti' }, { status: 400 });
        }

        // 1. Recupera quantità attuale
        const { data: current } = await supabase
            .from('armadietto')
            .select('quantita')
            .eq('alunno_id', alunno_id)
            .eq('materiale', materiale)
            .maybeSingle();

        const currentQty = current?.quantita || 0;
        const newQty = currentQty + quantita;

        // 2. Upsert con la nuova quantità sommata
        const { data, error } = await supabase
            .from('armadietto')
            .upsert({
                alunno_id,
                materiale,
                quantita: newQty
            }, { onConflict: 'alunno_id,materiale' })
            .select()
            .single();

        if (error) throw error;
        return NextResponse.json({ success: true, data });
    } catch (err: any) {
        console.error('ERRORE POST /api/locker/inventory:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
