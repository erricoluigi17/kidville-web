import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

/**
 * GET /api/attendance/delegates?sezione=Girasoli
 *
 * Restituisce i delegati autorizzati al ritiro per gli alunni della sezione specificata.
 * Unica fonte: la tabella `delegates`.
 *
 * ── PERCHÉ NON SI SONDA PIÙ `delegati` ───────────────────────────────────────
 * Questa route interrogava prima la tabella `delegati` (schema originale) e ripiegava su
 * `delegates`. Ma `delegati` NON ESISTE più: il DB è stato ripulito il 2026-07-04, e nello
 * schema live c'è solo `delegates`. La sonda non falliva in modo visibile — PostgREST
 * risponde 404 e il codice ripiegava in silenzio — quindi nessuno se n'era accorto: è stato
 * il logging strutturato, appena messo in produzione, a mostrarla (una riga `livello=error`
 * su OGNI chiamata, cioè rumore ricorrente nel canale che serve a trovare i guasti veri).
 * Costava anche un round-trip in più a ogni appello, per una tabella che non tornerà.
 */

const getQuerySchema = z.object({
    sezione: z.string().default(''),
    // L'identità VERA della classe. Il nome resta accettato (shell native già
    // installate, URL salvati) ma porta allo stesso filtro per uuid.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
}).refine((v) => Boolean(v.sezione) || Boolean(v.sectionId), {
    message: 'indicare sezione o sectionId',
});

export const GET = withRoute('attendance/delegates:GET', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { sezione } = q.data;

    try {
        const admin = await createAdminClient();
        // Il gate da solo non bastava: impedisce di NOMINARE la classe di
        // un'altra sede, non che la classe OMONIMA della propria sede si porti
        // dietro i delegati dell'altra (nome + numero di documento).
        const plessi = await resolveScuoleAttive(request, admin, auth.user);

        // `soloSezioniAssegnate` (2026-07-31, R108): il gate nudo non chiede
        // «questa classe è tua?», e un educator poteva ottenere i delegati al
        // ritiro — nome e numero di documento — di qualunque classe del plesso.
        //
        // ⚠️ Qui l'elenco vuoto ha una CONSEGUENZA FISICA, ed è l'unica route di
        // quest'onda in cui l'ha: nessuno risulta autorizzato al ritiro, e il
        // bambino resta a scuola. Finché si filtrava per NOME, bastava che
        // `alunni.classe_sezione` differisse di uno spazio da `sections.name`
        // perché tutti i delegati della classe sparissero — con 200 e senza log.
        const classe = await risolviSezione(admin, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
        if (classe.response) return classe.response;
        if (classe.sectionIds.length === 0) return NextResponse.json([]);

        const supabase = await createClient();

        const { data, error } = await supabase
            .from('delegates')
            .select(`
                id,
                student_id,
                first_name,
                last_name,
                document_number,
                alunni!inner ( section_id )
            `)
            .in('alunni.section_id', classe.sectionIds)
            .in('alunni.scuola_id', plessi);

        if (error) {
            // PostgREST non lancia: ritorna { error }. Prima questo errore veniva SCARTATO dalla
            // destrutturazione e la route rispondeva `[]` — cioè «nessun delegato» quando in realtà
            // la lettura si era rotta. Un elenco vuoto, al ritiro, è la direzione SICURA (nessuno
            // autorizzato: si chiama il genitore), e per questo si continua a rispondere `[]` invece
            // di rompere l'appello. Ma la differenza fra «non ci sono delegati» e «non si è potuto
            // leggere» ora esiste da qualche parte, e quel posto sono i log.
            logErrore({ operazione: 'attendance/delegates:GET', evento: 'db', stato: 200 }, error);
            return NextResponse.json([]);
        }

        // Mappa al formato atteso dal frontend.
        const mapped = (data ?? []).map((d: { id: string; student_id: string; first_name: string; last_name: string }) => ({
            id: d.id,
            alunno_id: d.student_id,
            nome: `${d.first_name} ${d.last_name}`,
            relazione: 'Delegato',
            foto_url: null,
        }));
        return NextResponse.json(mapped);
    } catch (err) {
        // Fail-closed come sopra: si risponde con l'elenco vuoto, ma il guasto non è muto.
        logErrore({ operazione: 'attendance/delegates:GET', stato: 200 }, err);
        return NextResponse.json([]);
    }
});
