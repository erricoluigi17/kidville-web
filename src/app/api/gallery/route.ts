import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/gallery?studentId=xxx&classe=xxx&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante)
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const studentId = searchParams.get('studentId');
        const classe = searchParams.get('classe');
        const limit = parseInt(searchParams.get('limit') ?? '30');
        const offset = parseInt(searchParams.get('offset') ?? '0');

        const supabase = await createAdminClient();

        let query = supabase
            .from('galleria_media_v2')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        const { data: allMedia, error, count } = await query;

        if (error) {
            console.error('Errore GET gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        let filtered = allMedia ?? [];

        // Filtro per genitore: mostra solo media dove il figlio è taggato o broadcast
        if (studentId) {
            filtered = filtered.filter(m =>
                m.is_broadcast ||
                (m.tag_students && m.tag_students.includes(studentId))
            );
        }

        // Filtro per classe (insegnante): mostra broadcast per la classe
        if (classe) {
            filtered = filtered.filter(m =>
                !m.is_broadcast ||
                (m.target_classes && m.target_classes.includes(classe))
            );
        }

        // Arricchisci con info uploader
        const enriched = await Promise.all(
            filtered.map(async (media) => {
                const { data: uploader } = await supabase
                    .from('utenti')
                    .select('nome, cognome, first_name, last_name')
                    .eq('id', media.uploaded_by)
                    .single();

                return {
                    ...media,
                    uploader_name: uploader
                        ? `${uploader.first_name || uploader.nome} ${uploader.last_name || uploader.cognome}`
                        : 'Sconosciuto',
                };
            })
        );

        return NextResponse.json({ media: enriched, total: count ?? 0 });
    } catch (error) {
        console.error('Errore API GET gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/gallery
// Body: { uploaded_by, file_url, file_type?, caption?, tag_students?, is_broadcast?, target_classes? }
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            uploaded_by,
            file_url,
            file_type,
            caption,
            tag_students,
            is_broadcast,
            target_classes,
        } = body;

        if (!uploaded_by || !file_url) {
            return NextResponse.json(
                { error: 'uploaded_by e file_url sono obbligatori' },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        const { data, error } = await supabase
            .from('galleria_media_v2')
            .insert({
                uploaded_by,
                file_url,
                file_type: file_type ?? 'foto',
                caption: caption ?? null,
                tag_students: tag_students ?? [],
                is_broadcast: is_broadcast ?? false,
                target_classes: target_classes ?? null,
            })
            .select()
            .single();

        if (error) {
            console.error('Errore POST gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Errore API POST gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// DELETE /api/gallery?id=xxx
// Cancella un media (solo admin)
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        const { error } = await supabase
            .from('galleria_media_v2')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Errore DELETE gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Errore API DELETE gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
