import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';

// GET /api/chat/config — config chat per il client (banner fuori orario, abilitazione).
// Leggibile da genitori e docenti: contiene solo parametri non sensibili.
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');
        const supabase = await createAdminClient();
        const cfg = await getModuleConfig<{
            abilitata_genitori: boolean;
            orario_docenti_da: string;
            orario_docenti_a: string;
            giorni_attivi: number[];
            broadcast_solo_admin: boolean;
            risposta_fuori_orario_msg: string;
        }>(supabase, 'chat_config', scuolaId);

        const now = new Date();
        const giorno = now.getDay() === 0 ? 7 : now.getDay(); // 1=lun … 7=dom
        const ora = now.toTimeString().slice(0, 5);
        const giorni = cfg.giorni_attivi ?? [1, 2, 3, 4, 5];
        const da = cfg.orario_docenti_da ?? '08:00';
        const a = cfg.orario_docenti_a ?? '17:00';
        const inOrario = giorni.includes(giorno) && ora >= da && ora <= a;

        return NextResponse.json({
            success: true,
            data: {
                abilitata_genitori: cfg.abilitata_genitori ?? true,
                in_orario: inOrario,
                orario_docenti_da: da,
                orario_docenti_a: a,
                giorni_attivi: giorni,
                broadcast_solo_admin: cfg.broadcast_solo_admin ?? true,
                risposta_fuori_orario_msg: cfg.risposta_fuori_orario_msg ?? '',
            },
        });
    } catch (err) {
        console.error('Errore API GET chat/config:', err);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
