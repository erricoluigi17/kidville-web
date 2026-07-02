import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertClasseNomeInScope } from '@/lib/auth/scope';

/**
 * GET /api/attendance/delegates?sezione=Girasoli
 *
 * Restituisce i delegati autorizzati al ritiro per gli alunni della sezione specificata.
 * I delegati sono dalla tabella `delegati` (vecchia) oppure `delegates` (nuova).
 */
export async function GET(request: NextRequest) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const sezione = request.nextUrl.searchParams.get('sezione');
    if (!sezione) {
        return NextResponse.json({ error: 'sezione obbligatoria' }, { status: 400 });
    }

    try {
        const scopeErr = await assertClasseNomeInScope(await createAdminClient(), auth.user, sezione);
        if (scopeErr) return scopeErr;

        const supabase = await createClient();

        // Prova prima la tabella `delegati` (schema originale)
        const { data: delegatiData, error: delegatiError } = await supabase
            .from('delegati')
            .select(`
                id,
                alunno_id,
                nome,
                relazione,
                foto_url,
                alunni!inner ( classe_sezione )
            `)
            .eq('alunni.classe_sezione', sezione);

        if (!delegatiError && delegatiData && delegatiData.length > 0) {
            return NextResponse.json(delegatiData);
        }

        // Fallback: tabella `delegates` (schema extended)
        const { data: delegatesData, error: delegatesError } = await supabase
            .from('delegates')
            .select(`
                id,
                student_id,
                first_name,
                last_name,
                document_number,
                alunni!inner ( classe_sezione )
            `)
            .eq('alunni.classe_sezione', sezione);

        if (!delegatesError && delegatesData) {
            // Mappa al formato atteso dal frontend
            const mapped = delegatesData.map((d: { id: string; student_id: string; first_name: string; last_name: string }) => ({
                id: d.id,
                alunno_id: d.student_id,
                nome: `${d.first_name} ${d.last_name}`,
                relazione: 'Delegato',
                foto_url: null,
            }));
            return NextResponse.json(mapped);
        }

        // Nessun delegato trovato — ritorna array vuoto (non errore)
        return NextResponse.json([]);
    } catch (err) {
        console.error('[/api/attendance/delegates] Error:', err);
        return NextResponse.json([]);
    }
}
