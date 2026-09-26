import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const getQuerySchema = z.object({
    alunno_id: zUuid,
    // Default dinamico (oggi) calcolato nel codice.
    date: zDataYMD.optional(),
});

// GET /api/diary/checkin?alunno_id=xxx&date=YYYY-MM-DD
// "Entrata" del Diario 0-6 (DL-040): orario di check-in letto dal modulo Presenze
// (read-only, niente evento eventi_diario duplicato). Service-role + lettura
// scoped per alunno/data. (Scoping di proprietà → S13, come il resto del Diario.)
export const GET = withRoute('diary/checkin:GET', async (request: NextRequest) => {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const alunnoId = q.data.alunno_id;
    // Giorno civile ITALIANO, non UTC: fra mezzanotte e le due il check-in
    // sarebbe letto sul giorno precedente (rilievo T27).
    const date = q.data.date ?? oggiFiscaleISO();

    // G1 — orario di entrata/stato presenza è un dato del minore: chiudiamo l'IDOR.
    // Il genitore solo i propri figli; lo staff solo i bambini del proprio plesso
    // (e della propria sezione, se educator); l'anonimo è 401.
    //
    // La seconda metà è del 2026-07-31: fino a quel giorno «staff/docenti
    // passano» era scritto qui e nel gate, e voleva dire che la cuoca di un
    // plesso leggeva l'orario d'ingresso di un bambino di un altro.
    const auth = await requireParentOfStudent(request, alunnoId);
    if (auth.response) return auth.response;

    const admin = await createAdminClient();
    const { data, error } = await admin
        .from('presenze')
        .select('orario_entrata, stato')
        .eq('alunno_id', alunnoId)
        .eq('data', date)
        .maybeSingle();

    if (error) {
        // PostgREST non lancia: l'errore sta nel valore di ritorno. Il messaggio del
        // database NON torna al browser (riecheggia colonne e filtri): va solo nel log.
        // Stesso codice e stessa frase della route sorella `GET /api/parent/presenze`, che
        // legge la stessa tabella: `PRESENZE_NON_LETTE` è dichiarato e tradotto in it/en.
        logErrore({ operazione: 'diary/checkin:GET', stato: 500, evento: 'db' }, error);
        return NextResponse.json(
            { error: 'Errore interno', codice: 'PRESENZE_NON_LETTE' },
            { status: 500 },
        );
    }

    // A1 (2026-09-26, decisione del titolare) — il genitore vede l'orario d'ingresso
    // SOLO sul ritardo: lì è quello registrato (o corretto) dal docente. Nido e
    // infanzia salvano comunque l'ora del tocco anche sul «presente», ma quell'ora non
    // deve nemmeno partire verso il browser: `orario_entrata` è null per ogni stato che
    // non sia 'ritardo' (presente, uscita anticipata, assente, appello non fatto).
    // Lo stato del giorno esce sempre (contratto in
    // docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/A1.md).
    const stato = (data?.stato as string | null | undefined) ?? null;
    return NextResponse.json({
        orario_entrata: stato === 'ritardo' ? (data?.orario_entrata ?? null) : null,
        stato,
    });
});
