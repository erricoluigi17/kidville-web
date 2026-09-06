import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, assertParentInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato';
import { linkOrCreateParent } from '@/lib/anagrafiche/parents';
import {
    RELAZIONI_FAMILIARI,
    cambiaRuoloFamiliare,
    collegaFamiliare,
    scollegaFamiliare,
    type RelazioneFamiliare,
    type Rifiuto,
} from '@/lib/anagrafiche/legami-scrittura';

/* ════════════════════════════════════════════════════════════════════════════
 * IL CONTRATTO — `/api/admin/legami-familiari`
 *
 * Una rotta sola per i tre gesti che mancavano: COLLEGARE un adulto già in
 * archivio a un bambino, SCOLLEGARLO, e CORREGGERE il ruolo (madre/padre/
 * delegato). Il verso è indifferente: «aggiungi una madre a questo bambino» e
 * «aggiungi un figlio a questa madre» sono lo stesso legame, quindi la stessa
 * chiamata — `alunno_id` + `parent_id`, in qualunque ordine li abbia scelti chi
 * sta davanti allo schermo.
 *
 * ─── PERCHÉ NON PASSA DA `PATCH /api/admin/parents` ─────────────────────────
 *
 * Perché quel corpo è `z.object({ id: zUuid }).loose()`: qualunque chiave passa
 * dritta nell'`update()`. Aggiungere lì i legami avrebbe voluto dire scrivere su
 * `parents` un campo che `parents` non ha, e la forma di quel difetto — un campo
 * fuori schema scartato in silenzio, con un 200 in risposta — questo repo l'ha
 * già pagata tre volte. Qui lo schema è STRICT: una chiave che non è prevista
 * fa 400, non viene ignorata.
 *
 * ─── GET — le due ricerche ──────────────────────────────────────────────────
 *
 *   GET ?tipo=genitori&q=<≥2 caratteri>[&alunno_id=<uuid>][&limite=1..50]
 *     → 200 { genitori: [{ id, first_name, last_name, fiscal_code, emails,
 *                          ha_account, gia_collegato }] }
 *     `gia_collegato` c'è SEMPRE, ma dice qualcosa solo con `alunno_id`: senza,
 *     vale `false` per tutti — e quel `false` significa «non l'ho chiesto», non
 *     «non è collegato». Chi lo rende senza aver passato `alunno_id` mostrerebbe
 *     come libero un adulto che è già in famiglia.
 *     `emails` è l'array della colonna (può essere vuoto); `ha_account` è un
 *     booleano DERIVATO: l'uuid dell'account non esce di qui.
 *
 *   GET ?tipo=alunni&q=<≥2 caratteri>[&parent_id=<uuid>][&limite=1..50]
 *     → 200 { alunni: [{ id, nome, cognome, classe_sezione, scuola_id,
 *                        gia_collegato }] }
 *
 *   `q` più corto di due caratteri restituisce un elenco VUOTO, non un errore:
 *   un elenco di adulti (o di bambini) non si sfoglia, si cerca.
 *
 * ─── POST — le tre azioni ───────────────────────────────────────────────────
 *
 *   { azione: 'collega', alunno_id, parent_id, relation_type }
 *   { azione: 'collega', alunno_id, relation_type, genitore: { …anagrafica } }
 *       ↑ crea un adulto NUOVO e lo collega, passando dal percorso già
 *         collaudato (`linkOrCreateParent`: dedup per codice fiscale, identità
 *         di accesso, invio credenziali, gemello runtime).
 *   { azione: 'scollega', alunno_id, parent_id }
 *   { azione: 'cambia-ruolo', alunno_id, parent_id, relation_type }
 *
 *   `relation_type` ∈ { 'mother' | 'father' | 'delegate' }.
 *   `is_primary` NON si passa: lo decide il ruolo (`ePrimario`), perché due
 *   colonne che dicono la stessa cosa non devono poter divergere.
 *
 *   Risposte — i nomi qui sotto sono quelli che escono DAVVERO dal `JSON.stringify`
 *   (`NextResponse.json(esito)` serializza gli `Esito*` di `legami-scrittura.ts`
 *   senza rimappare niente). Fino al 2026-09-06 questo blocco prometteva
 *   `parent_id` mentre la risposta mandava `parentId`, e chi si fidava della
 *   prosa invece del codice leggeva `undefined`:
 *
 *     200 { ok: true, parentId, anagrafica, runtime }         (collega)
 *          `parentId` in CAMMELLO, ed è il campo che dice CHI è stato collegato
 *          sul ramo «adulto nuovo», dove `anagrafica` esce sempre 'gia-presente'
 *          (il legame l'ha già scritto `linkOrCreateParent`).
 *     200 { ok: true, anagrafica: 'rimossa', runtime }        (scollega)
 *     200 { ok: true, relation_type, is_primary }             (cambia-ruolo)
 *          `relation_type` in serpente, come la colonna: qui il nome è quello.
 *     400 corpo non valido (zod strict) — SENZA `codice`: lo scrive `parseBody`
 *     400 { codice: 'LEGAME_ADULTO_NON_INDICATO' } né `parent_id` né `genitore`
 *     403 bambino o adulto fuori dai propri plessi — SENZA `codice`, e nemmeno
 *         il 404 «Alunno non trovato»: nascono da `assertAlunnoInScope` /
 *         `assertParentInScope`, che rispondono con la sola prosa. Un 404 con
 *         `codice` e uno senza sono due cose diverse: chi li distingue guardi il
 *         `codice`, non lo status.
 *     404 { codice: 'LEGAME_NON_TROVATO' }
 *     409 { codice: 'LEGAME_ULTIMO_GENITORE' }  ← vedi sotto
 *     500 { codice: 'LETTURA_FALLITA' }         niente è stato toccato
 *     500 { codice: 'LEGAME_NON_SALVATO' }      una scrittura respinta, e NIENTE
 *                                               è cambiato: si riprova
 *     500 { codice: 'LEGAME_MEZZO_TOLTO' }      scollega riuscito a METÀ: la riga
 *                                               dell'accesso è già andata, quella
 *                                               in anagrafica no
 *     500 { codice: 'LEGAME_ADULTO_FORSE_CREATO' } ramo «adulto nuovo»: l'anagrafica
 *                                               può essere già nata (e le
 *                                               credenziali partite). NON si
 *                                               ricompila il modulo: si cerca in
 *                                               archivio
 *
 *   `anagrafica` ∈ { 'creata' | 'gia-presente' }  (collega)
 *                 { 'rimossa' }                   (scollega)
 *   `runtime`    ∈ { 'creato' | 'gia-presente' | 'senza-account' | 'non-scritto' }
 *                                                 (collega)
 *                 { 'rimosso' | 'assente' }       (scollega)
 *   Gli insiemi sono PER AZIONE e non uno solo: un ramo scritto per un valore che
 *   quell'azione non produce non si accende mai, e non si vede che non si accende.
 *   `runtime: 'senza-account'` NON è un errore: l'adulto non ha ancora un
 *   account (64 anagrafiche su 747 in produzione), quindi la riga runtime non
 *   esiste finché la Segreteria non gli manda le credenziali. La UI lo dica.
 *   `runtime: 'non-scritto'` invece è un GUASTO dentro un 200: l'anagrafica è
 *   scritta, la riga che apre le policy RLS no — il genitore vedrà il figlio e
 *   non i suoi pagamenti. Va MOSTRATO come avviso; il rimedio è ripetere lo
 *   stesso collegamento (è idempotente e ritenta la riga runtime).
 *
 * ─── IL 409 CHE VALE LA PENA CONOSCERE ──────────────────────────────────────
 *
 * Scollegare l'ULTIMO adulto di un bambino è RIFIUTATO, non confermato: senza
 * legami quel bambino non lo vede più nessun genitore — diario, galleria,
 * pagamenti, chat — e il solo modo di ricollegarlo è questa stessa rotta. Il
 * messaggio dice il rimedio: prima si collega l'altro genitore, poi si scollega
 * questo.
 *
 * ─── L'ISOLAMENTO FRA PLESSI ────────────────────────────────────────────────
 *
 * `parents` non ha (e non deve avere) una colonna di sede: un adulto può avere
 * figli in due plessi. Lo scope si deriva dai FIGLI, e lo fa `assertParentInScope`.
 * Un elenco di adulti non filtrato per sede è una fuga di dati, quindi la
 * ricerca parte SEMPRE dal legame col bambino e dal plesso del bambino, mai da
 * `parents` per intero.
 * ════════════════════════════════════════════════════════════════════════════ */

const zRelazione = z.enum(RELAZIONI_FAMILIARI);

/** Sotto i due caratteri non si cerca: si restituisce vuoto (come `admin/search`). */
const MINIMO_RICERCA = 2;

/**
 * Il MASSIMO del perimetro letto per la ricerca dei genitori.
 *
 * Non è una paginazione: è la difesa contro una lettura che cresce da sola. Oggi
 * i legami in produzione sono 885; se un giorno superassero questo numero
 * l'elenco sarebbe TRONCATO, e un troncamento silenzioso in una ricerca è il
 * modo peggiore di sbagliare — «quel genitore non c'è» invece di «non l'ho
 * cercato tutto». Perciò quando lo si tocca si lascia una riga di `warn`.
 *
 * ⚠️ NON si chiama `TETTO_…`, e non è pignoleria: `logging-tetto.test.ts` legge i
 * NOMI e in questo repo un `TETTO` è quasi sempre un budget di TEMPO. Questo è un
 * numero di RIGHE — chiamarlo così avrebbe messo un conteggio dentro l'inventario
 * delle scadenze, dove nessuno lo saprebbe leggere.
 */
const MASSIMO_PERIMETRO = 3000;

const getQuerySchema = z
    .object({
        tipo: z.enum(['genitori', 'alunni']).default('genitori'),
        q: z.string().max(200).optional(),
        alunno_id: zUuid.optional(),
        parent_id: zUuid.optional(),
        limite: z.coerce.number().int().min(1).max(50).default(25),
    })
    .strict();

/**
 * Il corpo del POST, per azione. `.strict()` su OGNI ramo: una chiave in più —
 * `is_primary`, `scuola_id`, un refuso — è un 400, non un campo scartato in
 * silenzio dentro un 200.
 */
const postBodySchema = z.discriminatedUnion('azione', [
    z
        .object({
            azione: z.literal('collega'),
            alunno_id: zUuid,
            parent_id: zUuid.optional(),
            relation_type: zRelazione,
            /**
             * L'anagrafica di un adulto NUOVO. `unknown` per campo, e non è
             * pigrizia: la mappa «payload del form → colonne di `parents`» vive
             * in `buildParentRecord` ed è lì che si aggiunge un campo. Ribatterla
             * qui creerebbe una seconda lista bianca che il giorno in cui diverge
             * scarta un dato in silenzio — è già successo con
             * `codice_belfiore_nascita`.
             */
            genitore: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    z.object({ azione: z.literal('scollega'), alunno_id: zUuid, parent_id: zUuid }).strict(),
    z
        .object({
            azione: z.literal('cambia-ruolo'),
            alunno_id: zUuid,
            parent_id: zUuid,
            relation_type: zRelazione,
        })
        .strict(),
]);

/** Le colonne dell'adulto che servono a SCEGLIERLO in un elenco, e nient'altro. */
const COLONNE_GENITORE = 'id, first_name, last_name, fiscal_code, emails, auth_user_id';

/** Neutralizza i metacaratteri di `ilike` (%/_) e della sintassi `or()` di PostgREST. */
function ripulisci(q: string): string {
    return q.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** La riga d'errore delle letture: PostgREST non lancia, e il codice va conservato. */
function letturaFallita(esito: string, tabella: string, err: unknown): NextResponse {
    logEvento('anagrafica', 'error', {
        operazione: 'admin/legami-familiari:GET',
        esito,
        entita_tipo: tabella,
        error_code: (err as { code?: string } | null)?.code ?? null,
    }, err);
    return NextResponse.json(
        { error: 'Non è stato possibile leggere i dati.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
    );
}

export const GET = withRoute('admin/legami-familiari:GET', async (request: Request) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const supabase = await createAdminClient();
    const { tipo, alunno_id, parent_id, limite } = q.data;

    // I due identificativi che possono arrivare dal CLIENT si verificano PRIMA
    // di essere usati come filtro: `assertAlunnoInScope`/`assertParentInScope`
    // dicono «questa riga è dentro i tuoi plessi», che è ciò che serve.
    if (alunno_id) {
        const fuori = await assertAlunnoInScope(supabase, auth.user, alunno_id);
        if (fuori) return fuori;
    }
    if (parent_id) {
        const fuori = await assertParentInScope(supabase, auth.user, parent_id);
        if (fuori) return fuori;
    }

    const testo = ripulisci(q.data.q ?? '');
    if (testo.length < MINIMO_RICERCA) {
        return NextResponse.json(tipo === 'alunni' ? { alunni: [] } : { genitori: [] });
    }
    const plessi = await scuoleDiUtente(supabase, auth.user);
    if (plessi.length === 0) {
        // Scope vuoto = diniego, mai «tutti»: vedi `scuoleDiUtente`, fail-closed.
        return NextResponse.json(tipo === 'alunni' ? { alunni: [] } : { genitori: [] });
    }
    const like = `%${testo}%`;

    if (tipo === 'alunni') {
        const { data, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, classe_sezione, scuola_id')
            .in('scuola_id', plessi)
            // Un bambino archiviato o ritirato non si aggiunge a una famiglia
            // dallo sportello: `STATI_CON_CANALE_FAMIGLIA` è il confine, e sta
            // in un posto solo (`src/lib/alunni/stato.ts`).
            .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
            .or(`nome.ilike.${like},cognome.ilike.${like},codice_fiscale.ilike.${like}`)
            .limit(limite);
        if (error) return letturaFallita('ricerca-alunni-non-letta', 'alunni', error);

        const righe = (data ?? []) as { id: string }[];
        const collegati = new Set<string>();
        if (parent_id && righe.length > 0) {
            const { data: legami, error: errLegami } = await supabase
                .from('student_parents')
                .select('student_id')
                .eq('parent_id', parent_id)
                .in('student_id', righe.map((r) => r.id));
            if (errLegami) return letturaFallita('legami-non-letti', 'student_parents', errLegami);
            for (const r of (legami ?? []) as { student_id?: unknown }[]) {
                if (typeof r.student_id === 'string') collegati.add(r.student_id);
            }
        }
        return NextResponse.json({
            alunni: righe.map((r) => ({ ...r, gia_collegato: collegati.has(r.id) })),
        });
    }

    // ── GENITORI. Si parte dal LEGAME e dal plesso del BAMBINO, mai da
    //    `parents` per intero: è l'unico modo di non far uscire dal proprio
    //    plesso l'anagrafica di un adulto. Il filtro sul testo si applica dopo,
    //    su un perimetro già ristretto.
    const { data: perimetro, error: errPerimetro } = await supabase
        .from('student_parents')
        .select(`parent_id, alunni!inner(scuola_id), parents!inner(${COLONNE_GENITORE})`)
        .in('alunni.scuola_id', plessi)
        .limit(MASSIMO_PERIMETRO);
    if (errPerimetro) return letturaFallita('perimetro-non-letto', 'student_parents', errPerimetro);

    const righeP = (perimetro ?? []) as {
        parent_id?: unknown;
        parents?: { id?: unknown; first_name?: unknown; last_name?: unknown; fiscal_code?: unknown; emails?: unknown; auth_user_id?: unknown } | null;
    }[];
    if (righeP.length >= MASSIMO_PERIMETRO) {
        // Un elenco troncato che tace è peggio di un elenco vuoto: chi cerca
        // conclude «quel genitore non c'è», e la ricerca non l'ha guardato tutto.
        logEvento('anagrafica', 'warn', {
            operazione: 'admin/legami-familiari:GET',
            esito: 'perimetro-troncato',
            entita_tipo: 'student_parents',
            n: righeP.length,
        });
    }

    const ago = testo.toLowerCase();
    const trovati = new Map<string, Record<string, unknown>>();
    for (const r of righeP) {
        const p = r.parents;
        if (!p || typeof p.id !== 'string' || trovati.has(p.id)) continue;
        const campi = [p.first_name, p.last_name, p.fiscal_code]
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.toLowerCase());
        if (!campi.some((v) => v.includes(ago))) continue;
        trovati.set(p.id, {
            id: p.id,
            first_name: p.first_name ?? null,
            last_name: p.last_name ?? null,
            fiscal_code: p.fiscal_code ?? null,
            emails: p.emails ?? [],
            // L'account NON esce di qui: alla UI serve sapere SE c'è (per dire
            // «riceverà le credenziali»), non quale sia.
            ha_account: typeof p.auth_user_id === 'string' && p.auth_user_id !== '',
        });
    }

    const collegati = new Set<string>();
    if (alunno_id && trovati.size > 0) {
        const { data: legami, error: errLegami } = await supabase
            .from('student_parents')
            .select('parent_id')
            .eq('student_id', alunno_id)
            .in('parent_id', [...trovati.keys()]);
        if (errLegami) return letturaFallita('legami-non-letti', 'student_parents', errLegami);
        for (const r of (legami ?? []) as { parent_id?: unknown }[]) {
            if (typeof r.parent_id === 'string') collegati.add(r.parent_id);
        }
    }

    return NextResponse.json({
        genitori: [...trovati.values()]
            .map((g) => ({ ...g, gia_collegato: collegati.has(g.id as string) }))
            .slice(0, limite),
    });
});

/** Il rifiuto del modulo di scrittura → la risposta HTTP, in un posto solo. */
function rispostaDiRifiuto(rifiuto: Rifiuto): NextResponse {
    if (rifiuto.motivo === 'legame-inesistente') {
        return NextResponse.json({ error: rifiuto.dettaglio, codice: 'LEGAME_NON_TROVATO' }, { status: 404 });
    }
    if (rifiuto.motivo === 'ultimo-genitore') {
        return NextResponse.json({ error: rifiuto.dettaglio, codice: 'LEGAME_ULTIMO_GENITORE' }, { status: 409 });
    }
    if (rifiuto.motivo === 'lettura-fallita') {
        return NextResponse.json({ error: rifiuto.dettaglio, codice: 'LETTURA_FALLITA' }, { status: 500 });
    }
    if (rifiuto.motivo === 'mezzo-tolto') {
        // Lo STATO A METÀ ha un codice suo, e non è pignoleria di catalogo: il
        // client, appena riconosce un codice, mostra la frase TRADOTTA e scarta
        // la prosa del server (`messaggioDaCorpo`, e i `LEGAME_*` non sono in
        // `CODICI_CON_DETTAGLIO`). Con `LEGAME_NON_SALVATO` l'operatore leggeva
        // «niente è stato modificato» mentre l'accesso era già stato tolto:
        // l'esatto contrario del vero, nell'istante in cui un adulto ha appena
        // perso la vista sui dati di un minore.
        return NextResponse.json({ error: rifiuto.dettaglio, codice: 'LEGAME_MEZZO_TOLTO' }, { status: 500 });
    }
    return NextResponse.json({ error: rifiuto.dettaglio, codice: 'LEGAME_NON_SALVATO' }, { status: 500 });
}

export const POST = withRoute('admin/legami-familiari:POST', async (request: Request) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const body = await parseBody(request, postBodySchema);
    if ('response' in body) return body.response;

    const supabase = await createAdminClient();
    const dati = body.data;

    // Il BAMBINO è il perno di tutte e tre le azioni, e la sua sede è quella che
    // conta: `parents` una sede non ce l'ha, e non deve averla.
    const fuoriAlunno = await assertAlunnoInScope(supabase, auth.user, dati.alunno_id);
    if (fuoriAlunno) return fuoriAlunno;

    const { data: alunno, error: errAlunno } = await supabase
        .from('alunni')
        .select('scuola_id')
        .eq('id', dati.alunno_id)
        .maybeSingle();
    if (errAlunno) {
        logEvento('anagrafica', 'error', {
            operazione: 'admin/legami-familiari:POST',
            esito: 'sede-bambino-non-letta',
            entita_tipo: 'alunni',
            alunno_id: dati.alunno_id,
            error_code: (errAlunno as { code?: string }).code ?? null,
        }, errAlunno);
        return NextResponse.json(
            { error: 'Non è stato possibile leggere i dati.', codice: 'LETTURA_FALLITA' },
            { status: 500 },
        );
    }
    const scuolaId = ((alunno as { scuola_id?: unknown } | null)?.scuola_id as string | null) ?? null;

    // Un `parent_id` che arriva dal client è un identificativo scelto da chi
    // chiama: si verifica SEMPRE contro i propri plessi prima di toccarlo.
    if (dati.parent_id) {
        const fuoriParent = await assertParentInScope(supabase, auth.user, dati.parent_id);
        if (fuoriParent) return fuoriParent;
    }

    if (dati.azione === 'scollega') {
        const esito = await scollegaFamiliare(supabase, auth.user, {
            alunnoId: dati.alunno_id,
            parentId: dati.parent_id,
            scuolaId,
        });
        if (!esito.ok) return rispostaDiRifiuto(esito);
        return NextResponse.json(esito);
    }

    if (dati.azione === 'cambia-ruolo') {
        const esito = await cambiaRuoloFamiliare(supabase, auth.user, {
            alunnoId: dati.alunno_id,
            parentId: dati.parent_id,
            relazione: dati.relation_type as RelazioneFamiliare,
            scuolaId,
        });
        if (!esito.ok) return rispostaDiRifiuto(esito);
        return NextResponse.json(esito);
    }

    // ── COLLEGA. Due strade, e una sola scrittura in fondo.
    let parentId = dati.parent_id ?? null;
    /**
     * Da qui in giù serve sapere QUALE delle due strade si è presa, perché
     * cambia che cosa è già successo quando qualcosa va storto: sul ramo
     * «adulto nuovo» un rifiuto arriva DOPO `linkOrCreateParent`, cioè dopo che
     * l'anagrafica può essere nata e le credenziali essere partite.
     */
    const adultoDaArchivio = parentId !== null;
    if (!parentId) {
        if (!dati.genitore) {
            // Codice suo, e non `LEGAME_NON_SALVATO`: quella frase di catalogo
            // dice «riprova fra poco», mentre qui riprovare non serve a niente
            // finché non si indica un adulto. Nessuna schermata ci arriva (il
            // client manda sempre uno dei due corpi): lo legge chi scrive un
            // chiamante nuovo, ed è a lui che deve dire cosa manca.
            return NextResponse.json(
                {
                    error: 'Indica l’adulto da collegare: scegline uno dall’archivio oppure compila la sua anagrafica.',
                    codice: 'LEGAME_ADULTO_NON_INDICATO',
                },
                { status: 400 },
            );
        }
        // Adulto NUOVO: si passa dal percorso già collaudato, che fa il dedup per
        // codice fiscale, l'identità di accesso, l'invio delle credenziali e il
        // gemello runtime. Riscriverlo qui vorrebbe dire mantenerne due copie.
        try {
            const creato = await linkOrCreateParent(supabase, auth.user, {
                studentId: dati.alunno_id,
                payload: { ...dati.genitore, role: dati.relation_type },
            });
            parentId = creato.parentId;
        } catch (err) {
            logEvento('anagrafica', 'error', {
                operazione: 'admin/legami-familiari:POST',
                esito: 'anagrafica-non-creata',
                entita_tipo: 'parents',
                alunno_id: dati.alunno_id,
            }, err);
            // «NIENTE È STATO MODIFICATO» QUI NON SI PUÒ DIRE, e prima si diceva.
            // `linkOrCreateParent` lancia da quattro punti diversi: l'insert
            // dell'anagrafica (e allora è vero), ma anche il legame col bambino e
            // l'identità di accesso — che vengono DOPO, quando l'adulto esiste già
            // e, con un'email, le credenziali sono partite verso una famiglia
            // vera. Invitare a riprovare significava invitare a creare un secondo
            // adulto e mandare una seconda email.
            return NextResponse.json(
                {
                    error: 'L’anagrafica dell’adulto potrebbe essere già stata salvata: cercalo in archivio prima di ricrearlo.',
                    codice: 'LEGAME_ADULTO_FORSE_CREATO',
                },
                { status: 500 },
            );
        }
    }

    const esito = await collegaFamiliare(supabase, auth.user, {
        alunnoId: dati.alunno_id,
        parentId,
        relazione: dati.relation_type as RelazioneFamiliare,
        scuolaId,
    });
    if (!esito.ok) {
        // Stesso rifiuto, due racconti, perché a monte è successo qualcosa di
        // diverso: se l'adulto è stato appena CREATO, l'anagrafica c'è (e con lei
        // il legame che `linkOrCreateParent` scrive al suo interno, e forse
        // l'email di credenziali). Rispondere «niente è stato modificato»
        // manderebbe l'operatore a compilare una seconda volta lo stesso modulo.
        // Dall'archivio, invece, non è nato niente e il rimedio è riprovare.
        if (!adultoDaArchivio) {
            return NextResponse.json(
                {
                    error: 'L’anagrafica dell’adulto è stata salvata, ma il collegamento al bambino non è confermato: ricarica la scheda prima di riprovare.',
                    codice: 'LEGAME_ADULTO_FORSE_CREATO',
                },
                { status: 500 },
            );
        }
        return rispostaDiRifiuto(esito);
    }
    // ⚠️ 200 anche con `runtime: 'non-scritto'` — vedi la nota accanto al `return`
    // di `collegaFamiliare`: la riga anagrafica c'è, quella runtime no, e chi
    // rende questa risposta deve MOSTRARLO. Lo status non lo dice.
    return NextResponse.json(esito);
});
