import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const role = searchParams.get('role');
        const supabaseAdmin = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
        let query = supabaseAdmin.from('adults').select('*');
        if (role) {
            query = query.eq('role', role);
        }
        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json(data);
    } catch (err: any) {
        return NextResponse.json({ error: 'Errore interno del server', details: err.message }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { emails, first_name, last_name, role, ...otherData } = body;
        
        const primaryEmail = emails && emails.length > 0 ? emails[0] : null;

        if (!primaryEmail) {
            return NextResponse.json({ error: 'Primary Email is required for authentication' }, { status: 400 });
        }

        // 1. Invita l'utente tramite Supabase Auth (crea l'utente e invia email)
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(primaryEmail, {
            data: { first_name, last_name, role }
        });

        if (authError) {
             console.error('Error creating auth user:', authError);
             return NextResponse.json({ error: authError.message }, { status: 400 });
        }

        const userId = authData.user.id;

        // 2. Inserisci i dati anagrafici in 'adults'
        const { data: adultData, error: adultError } = await supabaseAdmin
            .from('adults')
            .insert({
                id: userId,
                first_name,
                last_name,
                role: role || 'parent',
                emails: emails,
                ...otherData
            })
            .select()
            .single();

        if (adultError) {
            console.error('Error creating adult record:', adultError);
            return NextResponse.json({ error: adultError.message }, { status: 500 });
        }

        return NextResponse.json(adultData, { status: 201 });

    } catch (err: any) {
        console.error('Error in POST /api/admin/adults:', err);
        return NextResponse.json({ error: 'Errore interno del server', details: err.message }, { status: 500 });
    }
}
