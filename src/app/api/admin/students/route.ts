import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { STATO_ISCRITTO } from '@/lib/alunni/stato';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura, assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { colonnaSconosciuta, linkOrCreateParent } from '@/lib/anagrafiche/parents';
import { riallineaScadenzeRetteFuture } from '@/lib/pagamenti/scadenze';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { staffScuola } from '@/lib/notifiche/destinatari';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { HEADER_TOTALE } from '@/lib/api/paginazione';

// ============================================================
// Anagrafica alunni — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037, `logScrittura`/`audit_scritture_docente`).
// ============================================================
//
// ─── QUI NON C'È PIÙ NESSUNA `DELETE`, ed è una decisione. ───────────────────
//
// Fino al 2026-08-12 questo file esportava `DELETE` («Hard Delete GDPR»): la
// cancellazione a cascata della riga di un minore, dietro il pulsante «Elimina
// Alunno (GDPR)» della scheda anagrafica. È stata TOLTA, non spostata altrove né
// resa più prudente, e le ragioni sono tre — in ordine di quanto pesano.
//
//  1. NON FUNZIONAVA, e non per un caso limite. `alunni` ha 28 foreign key
//     entranti e SETTE senza `ON DELETE CASCADE` (valutazioni, pagamenti,
//     legame_genitori_alunni, eventi_diario, armadietto, ticket_mensa,
//     note_disciplinari). Misurato in produzione il 2026-08-12: su 33 alunni
//     veri, 28 hanno pagamenti e 28 hanno un legame con un genitore — cioè
//     **28 su 33 non erano cancellabili** e ricevevano un `23503` → 409. Tre
//     tentativi reali alle 11:17:24, 11:17:53 e 11:18:07 UTC sullo stesso
//     bambino, tutti respinti. Il pulsante era una promessa che il database non
//     poteva mantenere.
//  2. PER GLI ALTRI CINQUE FACEVA LA COSA PIÙ DISTRUTTIVA DELL'APPLICAZIONE
//     DIETRO LA CONFERMA PIÙ DEBOLE: un doppio clic, senza digitare nessun
//     nominativo. E tenerla «solo per gli alunni senza dati collegati» sarebbe
//     stata la trappola peggiore di tutte — **lo stesso bottone, nella stessa
//     posizione, avrebbe archiviato o annientato a seconda di uno stato
//     invisibile a chi lo preme**. Un comando che cambia significato in base a
//     una condizione che l'operatore non può vedere non è un comando: è una
//     roulette con l'anagrafica di un minore.
//  3. ESTIRPA ALLA RADICE IL DIFETTO DELL'AUDIT invece di compensarlo. L'audit
//     `hard_delete_gdpr` veniva scritto PRIMA della cancellazione: quando poi la
//     FK la respingeva, in `registro_modifiche` restava una copia integrale della
//     riga (note mediche comprese) sotto un'etichetta che dichiarava cancellato un
//     bambino ancora iscritto — tre righe false in produzione, bonificate dalla
//     migrazione `20260812194614`. Senza questa route nessun codice può più
//     scriverne una: il lock `registro-modifiche-senza-hard-delete` vieta il
//     letterale in `src/`.
//
// AL SUO POSTO, il modello a due tempi deciso dal titolare il 2026-08-12:
// `POST /api/admin/students/archivia` sposta l'alunno fra i «non più iscritti»
// lasciando INTATTA l'anagrafica (registri e pagamenti si conservano dieci anni)
// ed è REVERSIBILE; la liberazione dello spazio — foto, video, messaggi — è un
// secondo gesto, che si fa solo da quell'elenco. Il diritto all'oblio vero, quello
// che la famiglia può chiedere ex art. 17, resta dov'era: `admin/gdpr/erase`,
// dietro una richiesta registrata e non dietro un bottone in fondo a una scheda.

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.

const postBodySchema = z.object({
    nome: z.string().min(1),
    cognome: z.string().min(1),
    data_nascita: z.string().min(1),
    scuola_id: z.string().nullable().optional(),
    sesso: z.string().nullable().optional(),
    codice_fiscale: z.string().nullable().optional(),
    comune_nascita: z.string().nullable().optional(),
    provincia_nascita: z.string().nullable().optional(),
    /**
     * Il codice catastale del comune di nascita (`alunni.codice_belfiore_nascita`,
     * migrazione `20260810094625`; colonna NULLABLE, verificata l'11 agosto su
     * `information_schema.columns` insieme alla gemella su `parents`).
     *
     * ⚠️ QUESTA RIGA NON È DECORATIVA, e va detto perché la sua assenza non faceva
     * rumore: `postBodySchema` è uno `z.object` NON strict, quindi fino all'11 agosto
     * la chiave arrivava nel corpo dal form, zod la SCARTAVA senza errore e senza log,
     * e l'operatore riceveva `201`. Nessun test era rosso — le tre schede misuravano
     * il payload della richiesta, non ciò che entrava in archivio. È la stessa forma
     * di guasto che AGENTS.md descrive («un codice che fallisce in silenzio è un
     * codice rotto»), e il gemello adulto era già completo
     * (`buildParentRecord`, `src/lib/anagrafiche/parents.ts`): la stessa schermata
     * funzionava sui genitori e mentiva sui bambini.
     *
     * Il valore non lo digita nessuno: viene dal campo `belfiore` di
     * `GET /api/anagrafiche/comuni`, scelto dalla tendina. Resta `null` quando il
     * comune è scritto a mano e non si riconosce — assente non è un errore.
     */
    codice_belfiore_nascita: z.string().nullable().optional(),
    nazione_nascita: z.string().nullable().optional(),
    cittadinanza: z.string().nullable().optional(),
    indirizzo_residenza: z.string().nullable().optional(),
    civico: z.string().nullable().optional(),
    comune_residenza: z.string().nullable().optional(),
    provincia_residenza: z.string().nullable().optional(),
    cap: z.string().nullable().optional(),
    allergies: z.string().nullable().optional(),
    // non-array tollerato e normalizzato a [] nell'handler, come oggi
    allergeni: z.unknown().optional(),
    is_bes_dsa: z.boolean().nullable().optional(),
    note_bes: z.string().nullable().optional(),
    usa_pannolino: z.boolean().nullable().optional(),
    invoice_holder_type: z.string().nullable().optional(),
    invoice_holder_details: z.unknown().optional(), // jsonb libero
    classe_sezione: z.string().nullable().optional(),
    data_iscrizione: z.string().nullable().optional(),
    giorno_scadenza_pagamenti: z.number().int().min(1).max(28).nullable().optional(),
    // Salvataggio atomico alunno+genitori: array opzionale di payload adulto
    // (stesso shape del form ScrollableAdultForm). Ogni voce viene creata e
    // collegata a questo alunno lato server (niente più genitori "persi").
    parents: z.array(z.unknown()).optional(),
});

const getQuerySchema = z.object({
    scuola_id: z.string().optional(),
    classe_sezione: z.string().optional(),
    stato: z.string().optional(),
    // Clamp identico al comportamento precedente: default 200 (limit) / 0 (offset),
    // range 1..1000; input non numerico → default, mai 400.
    limit: z.preprocess((v) => Math.min(Math.max(Number(v ?? 200) || 200, 1), 1000), z.number()),
    offset: z.preprocess((v) => Math.max(Number(v ?? 0) || 0, 0), z.number()),
});

// PATCH: tre forme (bulk classe_sezione, bulk gruppo mensa, update singolo).
// I valori dei campi aggiornabili restano senza vincoli (z.unknown) come oggi.
// NB zod v4: z.unknown() nudo rende la chiave obbligatoria → sempre .optional().
const patchBodySchema = z.object({
    // bulk: la guardia Array.isArray resta nell'handler (come oggi)
    ids: z.unknown().optional(),
    gruppo_mensa_id: z.unknown().optional(),
    // update singolo
    id: z.string().optional(),
    // allowlist campi aggiornabili (stessa lista di `allowedFields` nell'handler)
    classe_sezione: z.unknown().optional(),
    stato: z.unknown().optional(),
    note_mediche: z.unknown().optional(),
    bes: z.unknown().optional(),
    note_bes: z.unknown().optional(),
    nome: z.unknown().optional(),
    cognome: z.unknown().optional(),
    data_nascita: z.unknown().optional(),
    codice_fiscale: z.unknown().optional(),
    gender: z.unknown().optional(),
    citizenship: z.unknown().optional(),
    birth_nation: z.unknown().optional(),
    birth_province: z.unknown().optional(),
    birth_city: z.unknown().optional(),
    // Vedi la testata sul gemello in `postBodySchema`: senza questa riga la chiave
    // veniva rimossa da zod prima ancora di arrivare ad `allowedFields`, e il PATCH
    // rispondeva `200` su un campo mai scritto.
    codice_belfiore_nascita: z.unknown().optional(),
    residence_address: z.unknown().optional(),
    residence_street_number: z.unknown().optional(),
    residence_city: z.unknown().optional(),
    residence_province: z.unknown().optional(),
    zip_code: z.unknown().optional(),
    allergies: z.unknown().optional(),
    allergeni: z.unknown().optional(),
    invoice_holder_type: z.unknown().optional(),
    invoice_holder_details: z.unknown().optional(),
    is_bes_dsa: z.unknown().optional(),
    usa_pannolino: z.unknown().optional(),
    section_id: z.unknown().optional(),
    importo_retta_mensile: z.unknown().optional(),
    opposizione_ade: z.unknown().optional(),
    // ─── I TRE CONSENSI FOTOGRAFICI, uno per CANALE ──────────────────────────
    // Sono distinti perché il consenso alla pubblicazione è granulare per canale
    // (provv. Garante 725 del 27/11/2025), e il modulo d'iscrizione li chiede
    // separatamente. Fino al 2026-08-01 solo il primo era scrivibile da qui: gli
    // altri due si popolavano SOLO importando una domanda approvata, cioè una
    // famiglia che cambiava idea non poteva essere registrata da nessuna parte.
    // Un consenso che non si può revocare non è un consenso (art. 7 §3 GDPR).
    /** Galleria RISERVATA alle famiglie della sezione (dentro l'app, dietro login). */
    consenso_privacy: z.unknown().optional(),
    /** SITO WEB della Scuola: canale pubblico, senza login (bucket `news`). */
    consenso_foto_sito: z.unknown().optional(),
    /** CANALI SOCIAL: la pubblicazione avviene fuori dai sistemi della Scuola. */
    consenso_foto_social: z.unknown().optional(),
    data_iscrizione: z.unknown().optional(),
    giorno_scadenza_pagamenti: z.unknown().optional(),
    genitori_separati: z.unknown().optional(),
    retta_split_config: z.unknown().optional(),
    intestatario_fatture: z.unknown().optional(),
});

// ─── Scope di sede sulle MUTAZIONI ───────────────────────────────────────────
// `requireStaff` dice che RUOLO hai, non su QUALE SEDE. Su una route
// service-role (la RLS non interviene) il solo gate di ruolo lasciava alla
// segreteria di un plesso modificare — e cancellare definitivamente — il minore
// di un altro. Da qui in giù ogni mutazione dichiara la sua sede: gate
// (`assertAlunnoInScope`, ricarica del batch) E filtro sulla query, sempre
// entrambi, perché il primo impedisce di NOMINARE una riga altrui e il secondo
// impedisce che ce ne finisca dentro una per omonimia o per corsa.

/**
 * Ricarica gli id di un batch DENTRO i plessi dell'utente.
 *
 * Se anche un solo id non torna — non esiste, oppure è di un'altra sede — si
 * rifiuta l'INTERO batch (403). Un aggiornamento parziale e muto sarebbe
 * peggio di un errore: nessuno si accorgerebbe di ciò che non è stato fatto.
 */
async function bersagliInScope(
    supabase: SupabaseClient,
    ids: unknown[],
    plessi: string[],
    operazione: string,
): Promise<{ ids: string[]; sedi: string[]; sedePerId: Map<string, string> } | { response: NextResponse }> {
    const richiesti = [...new Set(ids.filter((v): v is string => typeof v === 'string' && v !== ''))];
    if (richiesti.length === 0 || richiesti.length !== new Set(ids).size) {
        return { response: NextResponse.json({ error: 'ids[] deve contenere almeno un identificativo valido' }, { status: 400 }) };
    }
    // Scope vuoto ⇒ `.in('scuola_id', [])` non seleziona nulla ⇒ il conteggio
    // non torna ⇒ 403. Il vuoto NEGA, non allarga.
    const { data, error } = await supabase
        .from('alunni')
        .select('id, scuola_id')
        .in('id', richiesti)
        .in('scuola_id', plessi);
    if (error) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «zero righe» e quindi un 403 muto, indistinguibile da un
        // tentativo cross-sede.
        logEvento('multi_sede', 'error', { operazione, esito: 'scope-batch-non-risolto' }, error);
        return { response: NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 }) };
    }
    const trovati = data ?? [];
    if (trovati.length !== richiesti.length) {
        logEvento('multi_sede', 'warn', {
            operazione, esito: 'alunni-fuori-sede',
            richiesti: richiesti.length, in_scope: trovati.length,
        });
        return { response: NextResponse.json({ error: 'Alcuni alunni non sono nel tuo plesso' }, { status: 403 }) };
    }
    return {
        ids: richiesti,
        sedi: [...new Set(trovati.map((r) => r.scuola_id as string))],
        // La sede di OGNI bersaglio, per l'audit: `logScrittura` ripiega su
        // `attore.scuola_id` quando il chiamante non la dichiara, e con un
        // admin multi-sede quel ripiego attribuisce l'intervento al plesso
        // sbagliato. La traccia di chi ha toccato la scheda di un minore deve
        // dire dove sta il minore, non dove sta l'operatore.
        sedePerId: new Map(trovati.map((r) => [r.id as string, r.scuola_id as string])),
    };
}

/**
 * Il nome-classe di destinazione deve esistere in OGNI sede coinvolta.
 *
 * Dal 2026-07-29 il nome NON è più una chiave: «2 ANNI» esiste ad Aversa e a
 * Cesa. Il trigger `sync_alunno_section_id` risolve il nome solo dentro la sede
 * dell'alunno, quindi un nome che lì non c'è non produce un errore: azzera
 * `section_id`, e il bambino sparisce da registro, appello e mensa in silenzio.
 * Meglio un 400 esplicito.
 */
export async function classeEsisteInOgniSede(
    supabase: SupabaseClient,
    nome: string,
    sedi: string[],
    operazione: string,
): Promise<NextResponse | null> {
    const { data, error } = await supabase
        .from('sections')
        .select('scuola_id')
        .eq('name', nome)
        .in('scuola_id', sedi);
    if (error) {
        logEvento('multi_sede', 'error', { operazione, esito: 'classe-non-risolta', sezione: nome }, error);
        return NextResponse.json({ error: 'Verifica della classe non riuscita' }, { status: 500 });
    }
    const coperte = new Set((data ?? []).map((r) => r.scuola_id as string));
    const mancanti = sedi.filter((s) => !coperte.has(s));
    if (mancanti.length > 0) {
        logEvento('multi_sede', 'warn', {
            operazione, esito: 'classe-inesistente-nella-sede',
            sezione: nome, sedi_mancanti: mancanti.length,
        });
        return NextResponse.json(
            { error: `La classe «${nome}» non esiste nella sede di tutti gli alunni selezionati` },
            { status: 400 },
        );
    }
    return null;
}

/** La riga indicata (sezione, gruppo mensa) deve stare in UNA delle sedi date. */
async function rigaNelleSedi(
    supabase: SupabaseClient,
    tabella: 'sections' | 'gruppi_mensa',
    id: string,
    sedi: string[],
    messaggio: string,
    operazione: string,
): Promise<NextResponse | null> {
    const { data, error } = await supabase
        .from(tabella)
        .select('id, scuola_id')
        .eq('id', id)
        .maybeSingle();
    if (error) {
        logEvento('multi_sede', 'error', { operazione, esito: 'riferimento-non-risolto', entita_tipo: tabella }, error);
        return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 });
    }
    const sede = (data?.scuola_id as string | null) ?? null;
    if (!data || !sede || !sedi.includes(sede)) {
        logEvento('multi_sede', 'warn', { operazione, esito: 'riferimento-fuori-sede', entita_tipo: tabella });
        return NextResponse.json({ error: messaggio }, { status: 400 });
    }
    return null;
}

// ============================================================
// POST /api/admin/students — Creazione nuovo alunno
// ============================================================
export const POST = withRoute('admin/students:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const body = b.data;

    try {
        const supabase = await createAdminClient();

        const { nome, cognome, data_nascita } = body;

        // scuola_id: risolto dallo scope dell'admin (una sola sede per la scrittura).
        const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id);
        if (sw.response) return sw.response;

        const record: Record<string, unknown> = {
            scuola_id: sw.scuolaId,
            nome,
            cognome,
            data_nascita,
            gender: body.sesso || null,
            citizenship: body.cittadinanza || null,
            birth_nation: body.nazione_nascita || null,
            codice_fiscale: body.codice_fiscale || null,
            birth_city: body.comune_nascita || null,
            birth_province: body.provincia_nascita || null,
            codice_belfiore_nascita: body.codice_belfiore_nascita || null,
            residence_address: body.indirizzo_residenza || null,
            residence_street_number: body.civico || null,
            residence_city: body.comune_residenza || null,
            residence_province: (body.provincia_residenza || '').toUpperCase() || null,
            zip_code: body.cap || null,
            allergies: body.allergies || null,
            allergeni: Array.isArray(body.allergeni) ? body.allergeni : [],
            is_bes_dsa: body.is_bes_dsa || false,
            note_mediche: body.note_bes || null,
            usa_pannolino: body.usa_pannolino ?? false,
            invoice_holder_type: body.invoice_holder_type || null,
            invoice_holder_details: body.invoice_holder_details || null,
            // classe/sezione: il trigger DB sincronizza automaticamente section_id.
            classe_sezione: body.classe_sezione || null,
            data_iscrizione: body.data_iscrizione || null,
            giorno_scadenza_pagamenti: body.giorno_scadenza_pagamenti ?? null,
            stato: STATO_ISCRITTO,
        };

        let { data, error } = await supabase
            .from('alunni')
            .insert(record)
            .select()
            .single();

        /**
         * Resilienza pre-migration: se una colonna non esiste ancora (es. usa_pannolino,
         * residence_province/residence_street_number prima della migrazione 20260706105201),
         * rimuovila dal record e riprova (l'errore segnala una colonna alla volta).
         *
         * ⚠️ DUE CODICI, NON UNO — e questo ciclo fino all'11 agosto ne guardava uno solo,
         * quello che in scrittura non arriva quasi mai. PostgREST valida il corpo contro la
         * PROPRIA cache dello schema prima di parlare col database: quando una colonna lì non
         * c'è risponde `PGRST204` («Could not find the … column … in the schema cache»), non
         * `42703`. È il caso del DB E2E della CI, che è un progetto SEPARATO e NON migrato
         * (vedi CLAUDE.md): con `codice_belfiore_nascita` appena aggiunto al record e senza
         * questo ramo, ogni creazione di alunno in CI sarebbe diventata un 500 — cioè un
         * campo in più si sarebbe portato via un'intera funzionalità.
         *
         * `colonnaSconosciuta` è la stessa funzione che usa `insertParentResilient`: una
         * regola valida per più strade vive in un posto solo.
         */
        let attempts = 0;
        for (;;) {
            const col = colonnaSconosciuta(error as { code?: string; message?: string } | null);
            if (!col || !(col in record) || attempts >= 5) break;
            delete record[col];
            // Un dato che l'ambiente non sa dove mettere NON si perde in silenzio: la riga
            // viene scritta senza quel campo e chi legge i log deve poterlo sapere. A log solo
            // il nome della colonna — che non è un dato di persona (AGENTS.md, punto 8).
            logEvento('anagrafica', 'warn', {
                operazione: 'admin/students:POST',
                azione: 'colonna-assente-scartata',
                esito: col,
            });
            ({ data, error } = await supabase.from('alunni').insert(record).select().single());
            attempts++;
        }

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: data?.id ?? null,
            azione: 'insert',
            scuolaId: (data?.scuola_id as string) ?? (record.scuola_id as string),
            sectionId: (data?.section_id as string) ?? null,
            valoreDopo: data,
        });

        // Salvataggio atomico dei genitori collegati (opzionale): ogni voce viene
        // creata e collegata; gli errori per-genitore sono riportati senza
        // compromettere l'alunno già creato. `credenziali_email` riporta l'esito
        // dell'invio automatico delle credenziali (S6bis) per gli account nuovi.
        const parentsResults: {
            label: string;
            ok: boolean;
            error?: string;
            credenziali_email?: { email: string; inviata: boolean; errore: string | null } | null;
        }[] = [];
        if (Array.isArray(body.parents) && data?.id) {
            for (let i = 0; i < body.parents.length; i++) {
                const p = (body.parents[i] ?? {}) as Record<string, unknown>;
                const label = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || `Genitore ${i + 1}`;
                try {
                    const r = await linkOrCreateParent(supabase, auth.user, { studentId: data.id as string, payload: p });
                    parentsResults.push({ label, ok: true, credenziali_email: r.credenzialiEmail ?? null });
                } catch (e) {
                    parentsResults.push({ label, ok: false, error: (e as Error).message });
                }
            }
        }

        return NextResponse.json({ ...data, parents: parentsResults }, { status: 201 });
    } catch (err) {
        logErrore({ operazione: 'admin/students:POST', stato: 500 }, err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// GET /api/admin/students — Lista alunni con filtri
// ============================================================
export const GET = withRoute('admin/students:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    // Paginazione: limit clampato 1..1000 (default 200) + offset; shape array nudo invariata.
    const { scuola_id: sedeChiesta, classe_sezione: classeSezione, stato, limit, offset } = q.data;

    try {
        const supabase = await createAdminClient();

        // ─── Proiezione MINIMA dell'elenco (W8, 2026-07-31) ──────────────────
        //
        // Questa route restituiva 43 colonne per alunno — `note_mediche`,
        // `allergies`, `allergeni`, `is_bes_dsa`/`note_bes` (dato art. 9 GDPR),
        // `documento_path`, `importo_retta_mensile`, `genitori_separati`,
        // `retta_split_config`, `intestatario_fatture`, residenza — PIÙ l'embed
        // `student_parents ( … parents (*) ), delegates (*)`, cioè l'anagrafica
        // COMPLETA di ogni adulto collegato (codice fiscale, tipo e numero del
        // documento d'identità, indirizzo, recapiti) per OGNI riga dell'elenco.
        // Con `limit=1000` — il valore che usano tutte le pagine — una sola
        // chiamata consegnava il fascicolo dell'intera scuola.
        //
        // Niente di tutto ciò veniva mostrato da una lista: il dettaglio è
        // `GET /api/admin/students/[id]`, che il gate di sede ce l'ha già.
        // Le colonne rimaste sono quelle che i consumatori leggono davvero:
        //  · `StudentTable`/`StudentRowCard`: cognome, nome, `scuola_id` (colonna
        //    «Sede»), `data_nascita`, `classe_sezione`, `stato`, indicatore allergie;
        //  · ricerca ed export CSV di `/admin/students`: `codice_fiscale`;
        //  · filtri «frequentanti» di PaymentsDashboard/GeneratoreCategoria/
        //    FiscalePanel e di `students/sezioni/[id]`: `section_id`.
        // (`fiscal_code` su `alunni` non è mai stato popolato: il CF del minore
        // sta in `codice_fiscale`.)
        //
        // `note_mediche` si LEGGE ma non si RESTITUISCE: la lista accende solo un
        // indicatore «Allergie», e il testo libero di un minore non deve viaggiare
        // in un elenco (né finire in un attributo del DOM). Fuori esce il booleano
        // `ha_note_mediche`; il testo resta dietro la scheda alunno.
        //
        // Il ciclo 42703 qui sotto resta indispensabile: il DB E2E della CI non è
        // migrato e una colonna assente va tolta, non trasformata in un 500.
        //
        // ─── LE TRE COLONNE DELL'ARCHIVIAZIONE (2026-08-12) ──────────────────
        // Servono all'elenco dei «non più iscritti», e nessuna delle tre porta
        // un dato di persona: due date e il NOME della classe da cui il bambino
        // è uscito. Escono di qui perché un elenco che non sa QUANDO qualcuno è
        // stato archiviato può solo ordinarlo per cognome, e `archiviato_il` è
        // anche l'unico modo di distinguere «archiviato» da «`stato` messo a
        // mano dalla tendina» (migrazione `20260812194517`: lo stato dice COSA,
        // la data dice QUANDO). `archiviato_classe_sezione` dice da dove veniva
        // — senza, il ritorno fra gli iscritti sarebbe un indovinello — e
        // `spazio_liberato_il` distingue una scheda ancora completa da una a cui
        // sono già stati tolti foto, video e messaggi: due righe identiche a
        // schermo per due situazioni che non si possono confondere.
        //
        // Sul DB E2E della CI, che non è migrato, il ciclo `42703` qui sotto le
        // toglie una per una e l'elenco continua a rispondere: `archiviato_il`
        // assente vale «nessuno è archiviato», che è la lettura giusta su un
        // database dove l'archiviazione non esiste ancora.
        let cols = [
            'id', 'scuola_id', 'nome', 'cognome', 'data_nascita', 'codice_fiscale',
            'classe_sezione', 'stato', 'section_id', 'note_mediche',
            'archiviato_il', 'archiviato_classe_sezione', 'spazio_liberato_il',
        ];
        // Scope multi-sede: solo i plessi attivi (selezione SedeSelector ∩ accessibili).
        const scuole = await resolveScuoleAttive(request, supabase, auth.user);
        const runQuery = () => {
            // `count: 'exact'` — il TOTALE, non la lunghezza della pagina.
            // Senza, un elenco troncato è indistinguibile da un elenco
            // completo: 1000 righe rese su 1400 e 1000 su 1000 hanno lo stesso
            // corpo. È il conteggio che rende il troncamento osservabile
            // (header `X-Total-Count` + il `warn` qui sotto).
            let query = supabase
                .from('alunni')
                .select(cols.join(', '), { count: 'exact' })
                .order('cognome', { ascending: true })
                .range(offset, offset + limit - 1)
                .in('scuola_id', scuole);
            // Filtro per una sola sede, SEMPRE in AND con lo scope: `scuola_id`
            // era dichiarato nello schema zod (riga 58) ma non veniva applicato,
            // e chi chiamava presumeva che filtrasse. `SectionsView` fa una fetch
            // per sede e le concatena: riceveva ogni volta la lista COMPLETA, e i
            // conteggi per classe uscivano moltiplicati per il numero di sedi.
            // Sede chiesta fuori dallo scope ⇒ elenco VUOTO (l'AND non seleziona
            // nulla): mai «non posso filtrare, allora eccoti tutto».
            if (sedeChiesta) query = query.eq('scuola_id', sedeChiesta);
            if (classeSezione) query = query.eq('classe_sezione', classeSezione);
            if (stato) query = query.eq('stato', stato);
            return query;
        };

        let { data, error, count } = await runQuery();
        let attempts = 0;
        while (error && (error as { code?: string }).code === '42703' && attempts < 5) {
            const col = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(error.message)?.[1];
            if (!col || !cols.includes(col)) break;
            cols = cols.filter((c) => c !== col);
            ({ data, error, count } = await runQuery());
            attempts++;
        }
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        // La nota medica esce come SEGNALE, non come testo: `ha_note_mediche`
        // accende l'indicatore «Allergie» nella lista, e il contenuto resta dove
        // ha un motivo per stare (la scheda alunno). `note_mediche` non compare
        // nella risposta nemmeno a null, così nessun componente può ricascarci.
        const righe = ((data ?? []) as unknown as Record<string, unknown>[]).map((riga) => {
            const { note_mediche: nota, ...resto } = riga;
            return { ...resto, ha_note_mediche: Boolean(nota) };
        });

        // ─── IL TRONCAMENTO NON DEVE POTER PASSARE INOSSERVATO (T11-F5) ─────
        //
        // Al 2026-08-04 in produzione ci sono ~32 alunni: il tetto di 1000 non
        // morde, e costruire oggi una UI paginata sarebbe lavoro sprecato. Ma
        // un elenco tagliato non produce nessun errore — produce una classe con
        // dentro meno bambini, e nessuno che se ne accorga. Quindi:
        //
        //  · il totale ESATTO esce sempre in `X-Total-Count`, così un chiamante
        //    può confrontarlo con le righe che ha in mano;
        //  · quando le righe rese sono ESATTAMENTE il tetto e il totale è
        //    maggiore, resta una riga a `warn` (evento `db`, che
        //    `vaPersistito` manda in `app_log` e quindi sopravvive al deploy).
        //
        // La doppia condizione è deliberata: `rese === limit` da solo è la
        // normalità di una pagina piena, non un troncamento. Nel log solo
        // numeri — mai nomi, mai il filtro di sede in chiaro.
        const totale = typeof count === 'number' ? count : offset + righe.length;
        if (righe.length === limit && totale > offset + righe.length) {
            logEvento('db', 'warn', {
                operazione: 'admin/students:GET',
                esito: 'elenco-troncato',
                rese: righe.length,
                totale,
                offset,
                limite: limit,
            });
        }

        return NextResponse.json(righe, { headers: { [HEADER_TOTALE]: String(totale) } });
    } catch (err) {
        logErrore({ operazione: 'admin/students:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// PATCH /api/admin/students — Bulk assign o aggiornamento singolo
// ============================================================
export const PATCH = withRoute('admin/students:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;
    const body: Record<string, unknown> = b.data;
    const { ids, id, gruppo_mensa_id: gruppoMensaId } = b.data;

    try {
        const supabase = await createAdminClient();
        // I plessi dell'utente: valgono da gate per OGNI ramo di scrittura qui
        // sotto. Insieme vuoto ⇒ nessun alunno risulterà in scope ⇒ si nega.
        const plessi = await scuoleDiUtente(supabase, auth.user);

        // Bulk assign
        if (ids && Array.isArray(ids) && body.classe_sezione) {
            const bersagli = await bersagliInScope(supabase, ids, plessi, 'admin/students:PATCH');
            if ('response' in bersagli) return bersagli.response;
            const nomeClasse = typeof body.classe_sezione === 'string' ? body.classe_sezione.trim() : '';
            if (!nomeClasse) {
                return NextResponse.json({ error: 'classe_sezione non valida' }, { status: 400 });
            }
            const errClasse = await classeEsisteInOgniSede(supabase, nomeClasse, bersagli.sedi, 'admin/students:PATCH');
            if (errClasse) return errClasse;

            const { data, error } = await supabase
                .from('alunni')
                .update({ classe_sezione: body.classe_sezione })
                .in('id', bersagli.ids)
                .in('scuola_id', plessi)
                .select();

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            // Audit: una riga per alunno riassegnato (DL-037).
            for (const alunnoId of bersagli.ids) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: alunnoId,
                    azione: 'update',
                    scuolaId: bersagli.sedePerId.get(alunnoId) ?? null,
                    valoreDopo: { classe_sezione: body.classe_sezione },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Bulk assign gruppo mensa (P5.4, DL-050). `gruppo_mensa_id` può essere
        // null per rimuovere gli alunni dal gruppo.
        if (ids && Array.isArray(ids) && gruppoMensaId !== undefined) {
            const bersagli = await bersagliInScope(supabase, ids, plessi, 'admin/students:PATCH');
            if ('response' in bersagli) return bersagli.response;
            // Il gruppo mensa è una risorsa DI SEDE: assegnarne uno di un altro
            // plesso porterebbe il bambino in un turno che nella sua sede non
            // esiste (e nei conteggi della cucina sbagliata).
            if (typeof gruppoMensaId === 'string' && gruppoMensaId !== '') {
                const errGruppo = await rigaNelleSedi(
                    supabase, 'gruppi_mensa', gruppoMensaId, bersagli.sedi,
                    'Il gruppo mensa indicato non appartiene alla sede degli alunni selezionati',
                    'admin/students:PATCH',
                );
                if (errGruppo) return errGruppo;
            }

            const { data, error } = await supabase
                .from('alunni')
                .update({ gruppo_mensa_id: gruppoMensaId })
                .in('id', bersagli.ids)
                .in('scuola_id', plessi)
                .select();
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            for (const alunnoId of bersagli.ids) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: alunnoId,
                    azione: 'update',
                    scuolaId: bersagli.sedePerId.get(alunnoId) ?? null,
                    valoreDopo: { gruppo_mensa_id: gruppoMensaId },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Aggiornamento singolo
        if (id) {
            try {
                const updates: Record<string, unknown> = {};
                const allowedFields = ['classe_sezione', 'stato', 'note_mediche', 'bes', 'note_bes', 'nome', 'cognome', 'data_nascita', 'codice_fiscale', 'gender', 'citizenship', 'birth_nation', 'birth_province', 'birth_city', 'codice_belfiore_nascita', 'residence_address', 'residence_street_number', 'residence_city', 'residence_province', 'zip_code', 'allergies', 'allergeni', 'invoice_holder_type', 'invoice_holder_details', 'is_bes_dsa', 'usa_pannolino', 'section_id',
                    'importo_retta_mensile', 'genitori_separati', 'retta_split_config', 'intestatario_fatture', 'opposizione_ade',
                    // I tre consensi fotografici, uno per canale: galleria riservata,
                    // sito pubblico, social. Vanno tutti e tre in allowlist — con solo
                    // il primo, la revoca degli altri due non aveva nessuna strada.
                    'consenso_privacy', 'consenso_foto_sito', 'consenso_foto_social',
                    'data_iscrizione', 'giorno_scadenza_pagamenti'];

                for (const field of allowedFields) {
                    if (body[field] !== undefined) updates[field] = body[field];
                }

                /**
                 * Una sola risposta, DUE punti di uscita: qui (il client non ha chiesto
                 * niente di aggiornabile) e dentro il ciclo di resilienza qui sotto (tutto
                 * ciò che aveva chiesto era una colonna che l'ambiente non conosce).
                 * Scritta una volta e non copiata: `errori-con-codice.test.ts` congela il
                 * debito delle risposte SENZA `codice` al conteggio del 2026-08-01, e una
                 * seconda copia lo farebbe crescere dentro il lock che esiste per impedirlo.
                 */
                const nessunCampoDaAggiornare = () =>
                    NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 });

                if (Object.keys(updates).length === 0) {
                    return nessunCampoDaAggiornare();
                }

                // Gate di tenant PRIMA di qualunque lettura o scrittura: la
                // risposta di questa route è la riga INTERA dell'alunno (note
                // mediche, codice fiscale, indirizzo), quindi senza questo
                // controllo bastava una scrittura innocua su un id di un'altra
                // sede per farsi restituire il fascicolo di quel minore.
                const scopeErr = await assertAlunnoInScope(supabase, auth.user, id);
                if (scopeErr) return scopeErr;

                // Stato precedente per l'audit (valore prima/dopo).
                const { data: prima } = await supabase.from('alunni').select('*').eq('id', id).maybeSingle();
                if (!prima) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });

                /**
                 * ⚠️ LA SECONDA PORTA DEL RITORNO, E PERCHÉ È CHIUSA QUI.
                 *
                 * `archivia` sgancia dalla classe (`section_id` e `classe_sezione`
                 * a NULL) perché è QUELLA la leva: `from('alunni')` compare 181
                 * volte in 117 file e solo 12 filtrano lo stato. Il ritorno deve
                 * quindi riagganciare, e sa farlo solo `riattiva`, che verifica che
                 * la classe ricordata esista ancora NELLA SEDE prima di riscriverla.
                 *
                 * Questa PATCH non fa niente di tutto ciò: tiene `stato` in
                 * `allowedFields` e non tocca né `archiviato_*` né `classe_sezione`.
                 * Misurato eseguendo la rotta: `PATCH` con `stato` = `'iscritto'` su una riga
                 * archiviata rispondeva **200** e lasciava
                 * `{ stato = 'iscritto', archiviato_il = <valorizzato>, section_id = null,
                 * classe_sezione:null}` — un bambino ISCRITTO e senza classe, cioè
                 * invisibile a registro, appello, mensa, diario e valutazioni, e
                 * sparito anche dalla linguetta «Non più iscritti» che filtra
                 * `stato=ritirato`. Restava nella sola anagrafica piatta. Nessun log,
                 * nessun avviso: il danno che tutto il modello dichiara di voler
                 * evitare, a un clic dalla scheda su cui l'elenco stesso manda.
                 *
                 * Si rifiuta solo il CAMBIO: la scheda salva il form intero, quindi
                 * chi corregge un indirizzo su un archiviato rimanda lo stesso
                 * `stato` che c'era e deve poterlo fare. E il confronto è su
                 * `archiviato_il`, non sullo stato: il ritiro a mano dalla tendina
                 * (`stato='ritirato'`, `archiviato_il` NULL) è ancora agganciato alla
                 * sua sezione, e correggerlo da qui non fa sparire nessuno.
                 *
                 * ⚠️ Su un DB senza la colonna — il DB E2E della CI non è migrato —
                 * `prima.archiviato_il` è `undefined` e la guardia non scatta: è la
                 * lettura giusta là dove l'archiviazione non esiste ancora.
                 */
                const statoChiesto = updates.stato;
                if (statoChiesto !== undefined && prima.archiviato_il != null && statoChiesto !== prima.stato) {
                    logEvento('gdpr', 'warn', {
                        operazione: 'admin/students:PATCH',
                        azione: 'stato-su-archiviato-rifiutato',
                        esito: 'rifiutato',
                        alunno: id,
                        ruolo: auth.user.role,
                    });
                    return NextResponse.json(
                        {
                            error: 'Questo bambino è fra i «non più iscritti»: lo stato non si cambia da qui. Usa «Riporta fra gli iscritti», che gli restituisce anche la classe.',
                            codice: 'STATO_ALUNNO_ARCHIVIATO',
                        },
                        { status: 409 },
                    );
                }

                // Riassegnazioni di classe: la destinazione deve stare NELLA
                // SEDE dell'alunno. `section_id` è in allowlist e il trigger DB
                // non lo corregge (risolve solo su INSERT, su cambio del nome o
                // su `section_id` NULL): scrivendo il solo uuid, un bambino di
                // una sede finiva puntato alla sezione di un'altra.
                const sedeAlunno = (prima.scuola_id as string | null) ?? null;
                const nuovaSezione = typeof updates.section_id === 'string' && updates.section_id !== ''
                    ? updates.section_id : null;
                const nuovaClasse = typeof updates.classe_sezione === 'string' && updates.classe_sezione.trim() !== ''
                    ? updates.classe_sezione.trim() : null;
                if ((nuovaSezione || nuovaClasse) && !sedeAlunno) {
                    // Senza sede sulla riga non c'è nessun perimetro entro cui
                    // validare la destinazione: si nega, non si indovina.
                    logEvento('multi_sede', 'error', { operazione: 'admin/students:PATCH', esito: 'alunno-senza-sede' });
                    return NextResponse.json({ error: 'Alunno senza sede: impossibile assegnare la classe' }, { status: 400 });
                }
                if (nuovaSezione && sedeAlunno) {
                    const errSezione = await rigaNelleSedi(
                        supabase, 'sections', nuovaSezione, [sedeAlunno],
                        'La sezione indicata non appartiene alla sede dell\'alunno',
                        'admin/students:PATCH',
                    );
                    if (errSezione) return errSezione;
                }
                if (nuovaClasse && sedeAlunno) {
                    const errClasse = await classeEsisteInOgniSede(
                        supabase, nuovaClasse, [sedeAlunno], 'admin/students:PATCH',
                    );
                    if (errClasse) return errClasse;
                }

                // Il filtro affianca il gate, non lo sostituisce: `.in('scuola_id',
                // plessi)` fa sì che la riga RILETTA e restituita al client sia
                // per costruzione dentro i plessi dell'utente, anche se fra il
                // gate e l'update qualcuno spostasse l'alunno di sede.
                let { data, error } = await supabase
                    .from('alunni')
                    .update(updates)
                    .eq('id', id)
                    .in('scuola_id', plessi)
                    .select()
                    .single();

                // Resilienza pre-migration: rimuove le colonne non ancora esistenti e riprova.
                // Vale qui la stessa nota sui DUE codici scritta sull'INSERT qui sopra:
                // in scrittura l'errore che arriva è `PGRST204`, non `42703`.
                let patchAttempts = 0;
                for (;;) {
                    const col = colonnaSconosciuta(error as { code?: string; message?: string } | null);
                    if (!col || !(col in updates) || patchAttempts >= 5) break;
                    delete updates[col];
                    logEvento('anagrafica', 'warn', {
                        operazione: 'admin/students:PATCH',
                        azione: 'colonna-assente-scartata',
                        esito: col,
                    });
                    // Tutti i campi richiesti erano colonne che l'ambiente non conosce:
                    // un UPDATE nudo non si manda. Un 400 onesto, non un 500.
                    if (Object.keys(updates).length === 0) {
                        return nessunCampoDaAggiornare();
                    }
                    ({ data, error } = await supabase.from('alunni').update(updates).eq('id', id).in('scuola_id', plessi).select().single());
                    patchAttempts++;
                }

                // Zero righe aggiornate col gate già passato (PGRST116 su
                // `.single()`): la riga è uscita dallo scope fra il gate e
                // l'update. Un 404 onesto, non il messaggio grezzo di Postgres
                // dentro un 500.
                if (error && (error as { code?: string }).code === 'PGRST116') {
                    logEvento('multi_sede', 'warn', {
                        operazione: 'admin/students:PATCH', esito: 'nessuna-riga-aggiornata', alunno: id,
                    });
                    return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });
                }
                if (error) throw new Error(error.message);

                // "Giorno di paga" cambiato → riallinea le scadenze delle rette
                // aperte future (best-effort, vedi lib/pagamenti/scadenze).
                if ('giorno_scadenza_pagamenti' in updates) {
                    await riallineaScadenzeRetteFuture(supabase, id as string, updates.giorno_scadenza_pagamenti as number | null);
                }

                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: id,
                    azione: 'update',
                    scuolaId: (data?.scuola_id as string) ?? null,
                    sectionId: (data?.section_id as string) ?? null,
                    valorePrima: prima ?? null,
                    valoreDopo: updates,
                });

                // Allergie cambiate → avvisa cuoca/segreteria (best-effort,
                // sicurezza mensa). Scatta solo se il valore è davvero diverso.
                try {
                    const allergieCambiate =
                        ('allergies' in updates && updates.allergies !== prima.allergies) ||
                        ('allergeni' in updates && JSON.stringify(updates.allergeni) !== JSON.stringify(prima.allergeni));
                    if (allergieCambiate) {
                        const scuolaId = (data?.scuola_id as string | undefined) ?? null;
                        const destinatari = (await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'cuoca']))
                            .filter((uid) => uid !== auth.user.id);
                        await notificaEvento(supabase, {
                            tipo: 'allergie_aggiornate',
                            scuolaId,
                            utenteIds: destinatari,
                            titolo: 'Allergie aggiornate',
                            corpo: `Le allergie di ${[data?.nome, data?.cognome].filter(Boolean).join(' ') || 'un alunno'} sono state aggiornate: verificare il menu.`,
                            link: '/admin/mensa/cucina',
                            entitaTipo: 'alunno',
                            entitaId: id,
                            bufferMin: 0,
                        });
                    }
                } catch (e) {
                    // Non bloccante: l'alunno è già aggiornato. Ma l'errore NON si perde —
                    // è la notifica di sicurezza mensa che non è partita.
                    logErrore({ operazione: 'admin/students:PATCH', evento: 'push' }, e);
                }

                return NextResponse.json(data);
            } catch (err) {
                logErrore({ operazione: 'admin/students:PATCH', stato: 500 }, err);
                return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore durante il salvataggio alunno' }, { status: 500 });
            }
        }

        return NextResponse.json({ error: 'Specificare id o ids[]' }, { status: 400 });
    } catch (err) {
        logErrore({ operazione: 'admin/students:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno del server' }, { status: 500 });
    }
});
