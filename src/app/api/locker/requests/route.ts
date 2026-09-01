import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, assertClasseNomeInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { tabellaMancante } from '@/lib/db/tolleranza-schema';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' nei query param equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    alunno_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
    classe_sezione: z.string().optional(),
    stato: z.string().optional(), // filtro libero, come prima (nessun enum imposto sul GET)
});

// Il gate deve sapere PER CHI decidere, e lo sa solo dal corpo: `alunno_id`
// accompagna `id`. È il pattern già in uso nei cinque `requireParentOfStudent(
// request, idDalCorpo)` del repo — l'unico possibile quando il soggetto del
// permesso sta nella richiesta e non nella sessione.
const patchBodySchema = z.object({
    id: zUuid,
    alunno_id: zUuid,
    stato: z.enum(['presa_in_carico', 'evasa']),
});

// La tabella può non esistere in alcuni ambienti: in quel caso si degrada a
// vuoto invece di rispondere 500.
//
// ⚠️ QUEL «alcuni ambienti» OGGI È SOLO LA CI, e il verso della frase è
// cambiato. Fino al 2026-09-01 questa route interrogava `locker_requests`, del
// vecchio schema a saldo, che NESSUNA migrazione applicata crea: il ramo
// tollerato era quello che girava SEMPRE in produzione (226 `PGRST205` in 28
// giorni, 195 proprio qui, e nessuno se n'era accorto perché la lista «Da
// portare a scuola» è condizionata a `length > 0` e restava invisibile). Ora si
// legge `armadietto_richieste`, che in produzione c'è. La tolleranza RESTA
// perché il DB E2E della CI è un progetto Supabase separato e non migrato, dove
// la tabella davvero non c'è: toglierla farebbe rossa la CI.
//
// ⚠️ `tabellaMancante` ARRIVA DA UN MODULO CONDIVISO e non si riscrive qui. La
// copia che stava in queste righe decideva col REGEX SUL MESSAGGIO
// (`/does not exist|schema cache|could not find/i`), e dentro quel regex ci
// cadeva anche `42703 "column … does not exist"`: una COLONNA mancante — cioè
// una migrazione applicata a metà su un database vivo — diventava «nessuna
// richiesta armadietto». Un genitore vedeva zero righe e nessuno sapeva perché.
// La discriminante è il CODICE, non la prosa: vedi `@/lib/db/tolleranza-schema`.

/**
 * Il 500 di una query fallita: **loggato per intero, raccontato per niente**.
 *
 * Qui c'era `NextResponse.json({ error: error.message })` in quattro punti, e
 * `error.message` di PostgREST è testo interno — nome dello schema, nome della
 * tabella, nome della colonna. È la stessa fuga già chiusa in
 * `src/app/api/diary/route.ts`, e va chiusa insieme al regex: prima il 42703
 * finiva nel ramo tollerato e non arrivava mai qui, ora ci arriva.
 */
function erroreDb(error: unknown, operazione: string): NextResponse {
    logErrore({ operazione, stato: 500, evento: 'db' }, error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
}

// ============================================================
// GET /api/locker/requests
// Query:
//   ?alunno_id=<id>     → richieste per un alunno (genitore)
//   ?classe_sezione=<s> → richieste per tutta la sezione (insegnante)
//   ?stato=pending      → filtra per stato (opzionale)
// ============================================================
export const GET = withRoute('locker/requests:GET', async (request: NextRequest) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunno_id: alunnoId, classe_sezione: classeSezione, stato } = q.data;

        const supabase = await createAdminClient();

        if (alunnoId) {
            // Ramo per singolo alunno: gate identità (sessione), poi legame
            // genitore↔alunno al genitore e plesso+sezione a tutti gli altri
            // ruoli (dal 2026-07-31: prima lo staff di qualunque sede passava).
            const auth = await requireParentOfStudent(request, alunnoId);
            if (auth.response) return auth.response;

            let query = supabase
                .from('armadietto_richieste')
                .select('id, alunno_id, materiale, livello, quantita_residua, stato, presa_in_carico_il, evasa_il, creato_il, alunni (id, nome, cognome)')
                .eq('alunno_id', alunnoId)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return erroreDb(error, 'locker/requests:GET');
            }
            return NextResponse.json(data);

        } else if (classeSezione) {
            // Ramo docente/staff: gate ruolo + gate classe + isolamento per plesso.
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const admin = await createAdminClient();

            // GATE per SEZIONE ASSEGNATA (R108) prima di leggere gli alunni:
            // `requireDocente` verifica il ruolo, non la classe. Educator → solo
            // le sezioni assegnate (decisione di prodotto del 2026-07-30).
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, classeSezione, { soloSezioniAssegnate: true });
            if (scopeErr) return scopeErr;

            const plessi = await scuoleDiUtente(admin, auth.user);
            if (plessi.length === 0) return NextResponse.json([]);

            // Ottieni gli alunni della sezione (solo dei propri plessi)
            const { data: alunni } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classeSezione)
                .eq('stato', 'iscritto')
                .in('scuola_id', plessi);

            if (!alunni || alunni.length === 0) return NextResponse.json([]);
            const ids = alunni.map(a => a.id);

            let query = supabase
                .from('armadietto_richieste')
                .select('id, alunno_id, materiale, livello, quantita_residua, stato, presa_in_carico_il, evasa_il, creato_il, alunni (id, nome, cognome)')
                .in('alunno_id', ids)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return erroreDb(error, 'locker/requests:GET');
            }
            return NextResponse.json(data);
        }

        return NextResponse.json(
            { error: 'Parametro alunno_id o classe_sezione richiesto' },
            { status: 400 }
        );
    } catch (err) {
        logErrore({ operazione: 'locker/requests:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// PATCH /api/locker/requests — cambio di stato di una richiesta
// Body: { id, alunno_id, stato: 'presa_in_carico' | 'evasa' }
// ============================================================
export const PATCH = withRoute('locker/requests:PATCH', async (request: NextRequest) => {
    try {
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, alunno_id, stato } = b.data;

        // IL GATE SEGUE IL GESTO. Fino al 2026-09-01 questa route aveva un solo
        // gate, `requireDocente`, e la pagina genitore ci mandava il bottone
        // «Preso in carico»: ogni genitore che lo premeva prendeva 403. Il difetto
        // non era la tabella mancante — sarebbe rimasto anche dopo averla creata.
        //
        //   presa_in_carico → è il GENITORE che dice «la porto»
        //   evasa           → è la SCUOLA che dice «è arrivata»
        //
        // Il corpo si legge PRIMA del gate, e qui è obbligato: `requireParentOfStudent`
        // vuole sapere di quale bambino si parla, e quel dato viaggia nel corpo. È la
        // stessa forma dei cinque call site già dichiarati in
        // `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts`. Il residuo è lo
        // stesso e resta piccolo: `parseBody` risponde 400 sul corpo malformato invece
        // di lanciare, quindi non si riapre la via del 500 pilotato da fuori.
        const auth = stato === 'presa_in_carico'
            ? await requireParentOfStudent(request, alunno_id)
            : await requireDocente(request);
        if (auth.response) return auth.response;

        const supabase = await createAdminClient();

        // Carica la riga per ricavarne il contesto (alunno → sezione/plesso) e
        // applicare lo scope: un docente non tocca richieste fuori dalla sua sezione.
        const { data: riga, error: rigaErr } = await supabase
            .from('armadietto_richieste')
            .select('id, alunno_id')
            .eq('id', id)
            .maybeSingle();
        if (rigaErr) {
            if (tabellaMancante(rigaErr)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(rigaErr, 'locker/requests:PATCH');
        }
        if (!riga) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });

        // Il gate ha creduto al corpo: ora si verifica che la riga sia davvero di
        // quell'alunno, altrimenti `alunno_id` sarebbe una chiave per aprire la
        // porta di casa propria ed entrare in quella del vicino. 404 e non 403:
        // a chi non ha titolo non si conferma nemmeno che l'id esista.
        if (riga.alunno_id !== alunno_id) {
            return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });
        }

        // Solo sul ramo scuola: il genitore è già passato per `requireParentOfStudent`,
        // che il legame con quel bambino l'ha verificato — e la sede al genitore non si
        // applica affatto, due fratelli possono stare in due plessi diversi.
        if (stato === 'evasa') {
            const scopeErr = await assertAlunnoInScope(supabase, auth.user, riga.alunno_id);
            if (scopeErr) return scopeErr;
        }

        const adesso = new Date().toISOString();
        const updates: Record<string, unknown> = { stato, aggiornato_il: adesso };
        if (stato === 'presa_in_carico') {
            updates.presa_in_carico_il = adesso;
            updates.presa_in_carico_da = auth.user?.id ?? null;
        } else {
            updates.evasa_il = adesso;
        }

        const { data, error } = await supabase
            .from('armadietto_richieste')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            if (tabellaMancante(error)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(error, 'locker/requests:PATCH');
        }
        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'locker/requests:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
