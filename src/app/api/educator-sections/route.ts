import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { filtraPerAnnoDiSede, type AnniAttivi } from '@/lib/anno/anni-attivi';
import { resolveAnnoLetturaElenco, resolveScuoleAttive } from '@/lib/auth/scope';
import { sezioniVisibiliConEsito } from '@/lib/sezioni/docenti';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { leggiVive } from '@/lib/gallery/cestino';

// Uuid opzionale da query string: stringa vuota trattata come assente
// (preserva il check truthy `requestedId ?` pre-esistente su `?userId=`).
const zUuidQueryOpzionale = z.preprocess(
    (v) => (v === '' ? undefined : v),
    zUuid.optional()
);

const getQuerySchema = z.object({
    userId: zUuidQueryOpzionale,
    // `passati=1`: oltre all'anno in corso, le classi assegnate degli anni `in_chiusura` e `chiuso`, in SOLA LETTURA
    // (decisione 14 e §4.10 della specifica dell'anno scolastico). Senza, la risposta è quella di sempre: le pagine che
    // scrivono (mensa, armadietto, modulistica…) non si ritrovano in elenco una classe su cui il server risponderebbe 403.
    passati: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['0', '1']).optional()),
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
    /** `true` per una classe di un anno `in_chiusura` o `chiuso`: si apre, non si scrive (il server rifiuta comunque). Solo con `passati=1`. */
    solaLettura?: boolean;
    /** `anni_scolastici.id` e `etichetta_breve` («2026/27»): solo quando la funzione dell'anno esiste (DB migrato). */
    annoId?: string | null;
    annoEtichetta?: string | null;
    /** `corrente`, `in_chiusura` o `chiuso`: distingue «Anno che si sta chiudendo» da «Anno passato». */
    annoStato?: string | null;
    /** Primo e ultimo giorno dell'anno di quella sede (`anni_sede`): il giorno da cui parte l'appello in sola lettura e la frase «arrivano con l'inizio dell'anno». */
    annoInizio?: string | null;
    annoFine?: string | null;
}

interface InfoAnno { annoId: string | null; etichetta: string | null; stato: string | null; inizio: string | null; fine: string | null }

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
    anni: AnniAttivi | null,
): Promise<RigaSezione[] | null> {
    if (plessi.length === 0) return [];
    let query = supabase
        .from('sections')
        .select('id, name, school_type, scuola_id')
        .in('scuola_id', plessi)
        .order('name');
    // Un solo anno (Compito 4.3.7): `null` = DB senza lo schema dell'anno, nessun filtro.
    query = filtraPerAnnoDiSede(query, anni);
    const { data, error } = await query;
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

/**
 * L'anno di ciascuna sezione: id, etichetta breve e stato (quello della SEDE della sezione). Tre letture, tutte in
 * degrado: una che fallisce toglie l'etichetta, mai la sezione. Si chiama solo con la funzione dell'anno presente
 * (altrimenti `anno_id` non esiste e darebbe `42703`).
 */
async function infoAnnoDelleSezioni(
    supabase: SupabaseClient,
    righe: RigaSezione[],
): Promise<Map<string, InfoAnno>> {
    const info = new Map<string, InfoAnno>();
    if (righe.length === 0) return info;
    const sez = await supabase.from('sections').select('id, anno_id').in('id', righe.map((s) => s.id));
    if (sez.error) {
        logEvento('db', 'warn', { operazione: 'educator-sections:GET', esito: 'anno-sezioni-non-letto' }, sez.error);
        return info;
    }
    const annoDi = new Map(((sez.data ?? []) as unknown as { id: string; anno_id: string | null }[]).map((r) => [r.id, r.anno_id]));
    const annoIds = [...new Set([...annoDi.values()].filter((a): a is string => !!a))];
    if (annoIds.length === 0) return info;
    const [anni, sedi] = await Promise.all([
        supabase.from('anni_scolastici').select('id, etichetta_breve').in('id', annoIds),
        supabase.from('anni_sede').select('anno_id, scuola_id, stato, inizio, fine').in('anno_id', annoIds).in('scuola_id', [...new Set(righe.map((s) => s.scuola_id))]),
    ]);
    if (anni.error) logEvento('db', 'warn', { operazione: 'educator-sections:GET', esito: 'anni-non-letti' }, anni.error);
    if (sedi.error) logEvento('db', 'warn', { operazione: 'educator-sections:GET', esito: 'stati-anno-non-letti' }, sedi.error);
    const etichette = new Map(((anni.data ?? []) as unknown as { id: string; etichetta_breve: string | null }[]).map((r) => [r.id, r.etichetta_breve]));
    const periodi = new Map(((sedi.data ?? []) as unknown as { anno_id: string; scuola_id: string; stato: string | null; inizio: string | null; fine: string | null }[]).map((r) => [`${r.scuola_id}|${r.anno_id}`, r]));
    for (const s of righe) {
        const annoId = annoDi.get(s.id) ?? null;
        const periodo = annoId ? periodi.get(`${s.scuola_id}|${annoId}`) : undefined;
        info.set(s.id, { annoId, etichetta: annoId ? (etichette.get(annoId) ?? null) : null, stato: periodo?.stato ?? null, inizio: periodo?.inizio ?? null, fine: periodo?.fine ?? null });
    }
    return info;
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
    // ── IL CESTINO: VERSO «SOLO LE VIVE» ─────────────────────────────────────
    // Stessa euristica di `tasks:GET`, stesso verso e per la stessa ragione: le
    // sezioni di un docente non possono dipendere da una foto che è nel cestino.
    // Qui pesa anche di più — questa rotta dice QUALI CLASSI un docente vede, e
    // una foto cestinata che rimette in elenco una sezione è un permesso
    // resuscitato da una cancellazione.
    // `leggiVive` porta con sé il degrado per il DB E2E della CI, non migrato,
    // dove `eliminato_il` non esiste (`42703`).
    const { data: myMedia, error: errMedia } = await leggiVive(
        (vive) => vive(
            supabase
                .from('galleria_media_v2')
                .select('tag_students')
                .eq('uploaded_by', userId)
        ).not('tag_students', 'is', null),
        'educator-sections:GET',
    );
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

        const anno = await resolveAnnoLetturaElenco(request, supabase, auth.user, plessi);
        if (anno instanceof NextResponse) return anno;
        // `passati=1` per un docente: si legge UNA volta l'elenco di tutti gli anni (poi filtrato dalla funzione dell'anno);
        // senza il parametro la lettura è quella di sempre, di un anno solo, e nessuna lettura in più sull'anno.
        const conPassati = !isManager && q.data.passati === '1';
        const candidate = await sezioniDeiPlessi(supabase, plessi, conPassati ? null : anno);
        if (candidate === null) {
            return NextResponse.json({ sectionNames: [], sections: [], role: normalizedRole });
        }

        let righe: RigaSezione[];
        // sezione → sola lettura, per le sole sezioni assegnate al docente (mai per il manager).
        let solaLettura = new Map<string, boolean>();
        let conAnni = false;
        if (isManager) {
            // Manager: tutte le sezioni dei plessi attivi.
            righe = candidate;
        } else {
            // Metodo 0 (canonico): legame docente↔sezione, INTERSECATO con i plessi attivi. La funzione dell'anno dà
            // anche le classi `in_chiusura` e `chiuso` (con `sola_lettura`): con `passati=1` si tengono, altrimenti
            // resta l'anno in corso, come prima.
            const esito = await sezioniVisibiliConEsito(supabase, userId);
            const visibili = esito.ok ? esito.sezioni : [];
            conAnni = conPassati && esito.ok && esito.conAnni === true;
            solaLettura = new Map(visibili.map((v) => [v.sectionId, v.solaLettura]));
            righe = candidate.filter((s) => solaLettura.has(s.id));
            if (righe.length === 0) {
                // L'euristica dei media resta dentro l'anno in corso, come prima del lotto 6.
                const delAnno = conPassati ? await sezioniDeiPlessi(supabase, plessi, anno) : candidate;
                righe = await sezioniDaiMediaTaggati(supabase, userId, plessi, delAnno ?? []);
            }
        }

        const nomiSedi = await nomiDelleSedi(supabase, [...new Set(righe.map((s) => s.scuola_id))]);
        const anni = conAnni ? await infoAnnoDelleSezioni(supabase, righe) : new Map<string, InfoAnno>();
        const sections: SezioneEsposta[] = righe
            .map((s) => ({
                id: s.id,
                name: s.name,
                scuolaId: s.scuola_id,
                scuolaNome: nomiSedi.get(s.scuola_id) ?? '',
                school_type: s.school_type ?? null,
                // I campi di L6-1 escono SOLO con `passati=1`: senza, la risposta è quella di prima del lotto 6.
                ...(conPassati ? {
                    solaLettura: solaLettura.get(s.id) === true,
                    annoId: anni.get(s.id)?.annoId ?? null,
                    annoEtichetta: anni.get(s.id)?.etichetta ?? null,
                    annoStato: anni.get(s.id)?.stato ?? null,
                    annoInizio: anni.get(s.id)?.inizio ?? null,
                    annoFine: anni.get(s.id)?.fine ?? null,
                } : {}),
            }))
            // Ordine stabile: prima le classi scrivibili (l'anno in corso), poi quelle di sola lettura; dentro, per nome, e a
            // parità di nome per sede (le omonime di sedi diverse escono sempre nello stesso ordine) e per anno, il più recente prima.
            .sort((a, b) => Number(a.solaLettura === true) - Number(b.solaLettura === true)
                || a.name.localeCompare(b.name) || a.scuolaNome.localeCompare(b.scuolaNome)
                || (b.annoEtichetta ?? '').localeCompare(a.annoEtichetta ?? ''));

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
