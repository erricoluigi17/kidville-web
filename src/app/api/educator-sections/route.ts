import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { sezioniDiUtente } from '@/lib/sezioni/docenti';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// Uuid opzionale da query string: stringa vuota trattata come assente
// (preserva il check truthy `requestedId ?` pre-esistente su `?userId=`).
const zUuidQueryOpzionale = z.preprocess(
    (v) => (v === '' ? undefined : v),
    zUuid.optional()
);

const getQuerySchema = z.object({
    userId: zUuidQueryOpzionale,
});

/**
 * Una sezione è un'IDENTITÀ, non un nome.
 *
 * ⚠️ Fino al 2026-07-31 questa route rispondeva `sectionNames: string[]` e un
 * `sections: [{name, school_type}]` senza `id` né sede. Con tre plessi «2 ANNI»
 * esiste ad Aversa E a Cesa: l'elenco conteneva due voci identiche e
 * indistinguibili, la home docente ne disegnava due chip con la STESSA chiave
 * React (che si accendevano insieme), e da quelle chip partivano le presenze,
 * le note mediche del diario e la creazione degli eventi di agenda — tutte con
 * un nome che valeva per due sedi. `sectionNames` resta per i consumer legacy,
 * ma smette di essere ciò su cui si clicca.
 */
interface SezioneEsposta {
    id: string;
    name: string;
    scuolaId: string;
    /** Nome della sede: serve alle etichette «nome — sede» quando le sedi sono >1. */
    scuolaNome: string;
    school_type: string | null;
}

interface RigaSezione {
    id: string;
    name: string;
    school_type: string | null;
    scuola_id: string;
}

/**
 * Sezioni dei plessi in scope, righe complete.
 *
 * Scope vuoto ⇒ elenco vuoto SENZA interrogare il DB: `.in('scuola_id', [])`
 * negherebbe comunque, ma non chiedere è il modo per non dipendere da come
 * PostgREST tratta la lista vuota. `null` = lettura fallita (≠ nessuna sezione).
 */
async function sezioniDeiPlessi(
    supabase: SupabaseClient,
    plessi: string[],
): Promise<RigaSezione[] | null> {
    if (plessi.length === 0) return [];
    const { data, error } = await supabase
        .from('sections')
        .select('id, name, school_type, scuola_id')
        .in('scuola_id', plessi)
        .order('name');
    if (error) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // sarebbe indistinguibile da «questo docente non ha sezioni».
        logEvento('db', 'error', {
            operazione: 'educator-sections:GET', esito: 'sezioni-non-lette', sedi: plessi.length,
        }, error);
        return null;
    }
    return (data ?? []) as unknown as RigaSezione[];
}

/** id sede → nome sede. Nome mancante = etichetta vuota, mai una sede sbagliata. */
async function nomiDelleSedi(
    supabase: SupabaseClient,
    ids: string[],
): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await supabase.from('schools').select('id, nome').in('id', ids);
    if (error) {
        logEvento('db', 'error', {
            operazione: 'educator-sections:GET', esito: 'nomi-sedi-non-letti', sedi: ids.length,
        }, error);
        return new Map();
    }
    return new Map(
        ((data ?? []) as unknown as { id: string; nome: string | null }[]).map((s) => [s.id, s.nome ?? '']),
    );
}

/**
 * Euristica legacy (Metodo 1): dai media taggati dal docente si risale agli
 * alunni e quindi alle loro sezioni. Vive solo per chi non ha nessun legame in
 * `utenti_sezioni` (in produzione: nessuno). Resta dentro i plessi in scope, e
 * risolve l'IDENTITÀ della sezione — `section_id` se c'è, altrimenti la coppia
 * (sede, nome-classe), che è la vera chiave a DB.
 *
 * Il «Metodo 2» che stava qui accanto è stato rimosso il 2026-07-31: leggeva
 * `eventi_diario.sezione` e `.teacher_id`, due colonne che non esistono. Nessuno
 * controllava `{ error }`, quindi rispondeva `42703` e il ramo tornava sempre
 * vuoto: sembrava una rete di sicurezza, non lo è mai stata.
 */
async function sezioniDaiMediaTaggati(
    supabase: SupabaseClient,
    userId: string,
    plessi: string[],
    candidate: RigaSezione[],
): Promise<RigaSezione[]> {
    const { data: myMedia, error: errMedia } = await supabase
        .from('galleria_media_v2')
        .select('tag_students')
        .eq('uploaded_by', userId)
        .not('tag_students', 'is', null);
    if (errMedia) {
        logEvento('db', 'error', {
            operazione: 'educator-sections:GET', esito: 'media-taggati-non-letti',
        }, errMedia);
        return [];
    }

    const taggati = [...new Set(
        ((myMedia ?? []) as unknown as { tag_students: string[] | null }[])
            .flatMap((m) => m.tag_students ?? [])
            .filter(Boolean),
    )];
    if (taggati.length === 0) return [];

    const { data: alunni, error } = await supabase
        .from('alunni')
        .select('section_id, classe_sezione, scuola_id')
        .in('id', taggati)
        // L'euristica resta dentro i propri plessi: altrimenti bastava un
        // vecchio tag su un bambino di un'altra sede per farsi comparire in
        // elenco la sua classe.
        .in('scuola_id', plessi);
    if (error) {
        logEvento('db', 'error', {
            operazione: 'educator-sections:GET', esito: 'alunni-taggati-non-letti',
        }, error);
        return [];
    }

    type RigaAlunno = { section_id: string | null; classe_sezione: string | null; scuola_id: string | null };
    const righe = (alunni ?? []) as unknown as RigaAlunno[];
    const perId = new Set(righe.map((a) => a.section_id).filter(Boolean) as string[]);
    // Chiave composta (sede -> nomi), mai una stringa concatenata: il nome da
    // solo non identifica più nulla, e concatenarlo con un separatore
    // riporterebbe l'ambiguità da cui si sta scappando.
    const nomiPerSede = new Map<string, Set<string>>();
    for (const a of righe) {
        if (a.section_id || !a.classe_sezione || !a.scuola_id) continue;
        const nomi = nomiPerSede.get(a.scuola_id) ?? new Set<string>();
        nomi.add(a.classe_sezione);
        nomiPerSede.set(a.scuola_id, nomi);
    }
    return candidate.filter(
        (s) => perId.has(s.id) || (nomiPerSede.get(s.scuola_id)?.has(s.name) ?? false),
    );
}

// GET /api/educator-sections[?userId=xxx]
// Sezioni su cui l'utente autenticato può operare, con identità e sede.
// `?userId=` (sezioni di un ALTRO utente) è onorato solo per admin/coordinator;
// per tutti gli altri l'identità è quella della sessione.
export const GET = withRoute('educator-sections:GET', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const requestedId = q.data.userId;
        const canQueryOthers = auth.user.role === 'admin' || auth.user.role === 'coordinator';
        const userId = canQueryOthers && requestedId ? requestedId : auth.user.id;

        const supabase = await createAdminClient();
        // Isolamento per sede: le sezioni visibili sono quelle dei plessi ATTIVI
        // (SedeSelector ∩ accessibili), mai tutte quelle di tutte le sedi. Il
        // perimetro è lo stesso che usano le route a valle (agenda, presenze,
        // diario): se qui fosse più largo, le chip proporrebbero classi su cui
        // la richiesta successiva risponderebbe 403.
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        const { data: utente, error: errUtente } = await supabase
            .from('utenti')
            .select('ruolo, role')
            .eq('id', userId)
            .maybeSingle();
        if (errUtente) {
            // Ruolo non letto ⇒ si degrada al ramo PIÙ RESTRITTIVO (educator),
            // mai a quello che elenca tutte le sezioni del plesso.
            logEvento('db', 'error', {
                operazione: 'educator-sections:GET', esito: 'ruolo-non-letto',
            }, errUtente);
        }

        const rawRole = (utente?.ruolo as string | undefined) || '';

        // Normalize role
        let normalizedRole = 'educator';
        if (rawRole === 'admin') normalizedRole = 'admin';
        else if (rawRole === 'coordinator' || rawRole === 'coordinatore') normalizedRole = 'coordinator';
        else if (['maestra', 'insegnante', 'educator'].includes(rawRole)) normalizedRole = 'educator';

        const isManager = normalizedRole === 'admin' || normalizedRole === 'coordinator';

        const candidate = await sezioniDeiPlessi(supabase, plessi);
        if (candidate === null) {
            return NextResponse.json({ sectionNames: [], sections: [], role: normalizedRole });
        }

        let righe: RigaSezione[];
        if (isManager) {
            // Manager: tutte le sezioni dei plessi attivi.
            righe = candidate;
        } else {
            // Metodo 0 (canonico): legame docente↔sezione in `utenti_sezioni`,
            // INTERSECATO con i plessi attivi. Prima l'intersezione non c'era —
            // il ramo manager rispettava il SedeSelector, questo no.
            const assegnate = new Set(await sezioniDiUtente(supabase, userId));
            righe = candidate.filter((s) => assegnate.has(s.id));
            if (righe.length === 0) {
                righe = await sezioniDaiMediaTaggati(supabase, userId, plessi, candidate);
            }
        }

        const nomiSedi = await nomiDelleSedi(supabase, [...new Set(righe.map((s) => s.scuola_id))]);
        const sections: SezioneEsposta[] = righe
            .map((s) => ({
                id: s.id,
                name: s.name,
                scuolaId: s.scuola_id,
                scuolaNome: nomiSedi.get(s.scuola_id) ?? '',
                school_type: s.school_type ?? null,
            }))
            // Ordine stabile: per nome, e a parità di nome per sede — così le
            // omonime di sedi diverse escono sempre nello stesso ordine.
            .sort((a, b) => a.name.localeCompare(b.name) || a.scuolaNome.localeCompare(b.scuolaNome));

        return NextResponse.json({
            // Contratto legacy: la lista dei NOMI, senza doppioni. Un nome
            // ripetuto qui diventava una `key` React duplicata in ogni pill del
            // cockpit docente, e due voci identiche in ogni tendina.
            sectionNames: [...new Set(sections.map((s) => s.name))],
            sections,
            role: normalizedRole,
        });

    } catch (error) {
        // Niente `stato`: qui la route degrada a una 200 con lista vuota, non a un 500.
        // Dichiarare `stato: 500` sarebbe una riga che mente sull'esito della richiesta.
        logErrore({ operazione: 'educator-sections:GET' }, error);
        return NextResponse.json({ sectionNames: [], sections: [], role: 'educator' });
    }
})
