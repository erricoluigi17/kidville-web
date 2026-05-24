import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/avvisi?scope=globale|classe&classe=xxx&parentId=xxx
// Lista avvisi con filtri
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const scope = searchParams.get('scope');
        const classe = searchParams.get('classe');
        const parentId = searchParams.get('parentId');
        const studentId = searchParams.get('studentId');

        const supabase = await createAdminClient();

        let query = supabase
            .from('avvisi')
            .select(`
                id,
                author_id,
                titolo,
                contenuto,
                tipo,
                target_scope,
                target_classes,
                scadenza,
                attachment_url,
                created_at
            `)
            .order('created_at', { ascending: false });

        if (scope) {
            query = query.eq('target_scope', scope);
        }

        const { data: avvisi, error } = await query;

        if (error) {
            console.error('Errore GET avvisi:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Filtra lato server per la classe se specificata
        let filtered = avvisi ?? [];
        if (classe) {
            filtered = filtered.filter(a =>
                a.target_scope === 'globale' ||
                (a.target_classes && a.target_classes.includes(classe))
            );
        }

        // Filtra per scadenza solo se è un genitore (parentId presente)
        if (parentId) {
            const todayStr = new Date().toISOString().split('T')[0];
            filtered = filtered.filter(a => !a.scadenza || a.scadenza >= todayStr);
        }

        // Arricchisci con conteggi risposte e info autore
        const enriched = await Promise.all(
            filtered.map(async (avviso) => {
                // Conta risposte
                const { count: lettiCount } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .not('letto_il', 'is', null);

                const { count: adesioni_si } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .eq('risposta', 'si');

                const { count: adesioni_no } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .eq('risposta', 'no');

                // Info autore
                const { data: author } = await supabase
                    .from('utenti')
                    .select('nome, cognome, ruolo, first_name, last_name, role')
                    .eq('id', avviso.author_id)
                    .single();

                // Se è un genitore, controlla se ha letto
                let myResponse = null;
                if (parentId) {
                    let rQuery = supabase
                        .from('avvisi_risposte')
                        .select('letto_il, risposta, risposto_il')
                        .eq('avviso_id', avviso.id)
                        .eq('parent_id', parentId);

                    if (studentId) {
                        rQuery = rQuery.eq('student_id', studentId);
                    }

                    const { data: resp } = await rQuery.limit(1).maybeSingle();
                    myResponse = resp;
                }

                return {
                    ...avviso,
                    author: author ? {
                        first_name: author.first_name || author.nome || '?',
                        last_name: author.last_name || author.cognome || '?',
                        role: author.role || author.ruolo || 'unknown',
                    } : { first_name: '?', last_name: '?', role: 'unknown' },
                    stats: {
                        letti: lettiCount ?? 0,
                        adesioni_si: adesioni_si ?? 0,
                        adesioni_no: adesioni_no ?? 0,
                    },
                    my_response: myResponse,
                };
            })
        );

        return NextResponse.json(enriched);
    } catch (error) {
        console.error('Errore API GET avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/avvisi
// Body: { author_id, titolo, contenuto, tipo, target_scope, target_classes?, scadenza?, attachment_url? }
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { author_id, titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url } = body;

        if (!author_id || !titolo || !contenuto) {
            return NextResponse.json(
                { error: 'author_id, titolo e contenuto sono obbligatori' },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        const { data, error } = await supabase
            .from('avvisi')
            .insert({
                author_id,
                titolo,
                contenuto,
                tipo: tipo ?? 'presa_visione',
                target_scope: target_scope ?? 'globale',
                target_classes: target_classes ?? null,
                scadenza: scadenza ?? null,
                attachment_url: attachment_url ?? null,
            })
            .select()
            .single();

        if (error) {
            console.error('Errore POST avvisi:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Errore API POST avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
