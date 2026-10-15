import { appartenenzeNelGiorno } from '@/lib/storici/alunni-giorno';
import { rispostaErroreStorico } from '@/lib/storici/http';
import { NextRequest, NextResponse } from 'next/server';
import type { AppUser } from '@/lib/auth/predicati-ruolo';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { applicaRettificaStorica, eRettificaStorica, storicoIndisponibile, type AttesaStorica, type AzioneStorica } from '@/lib/primaria/rettifica-storica';
import { oggiRoma, intervalloGiornoRoma, istanteNelGiornoRoma, politicaNotificaOperazione, puoCorreggereStorico } from '@/lib/storici/retroattivita';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaTitolariScrittura, enqueueDiarioGenitori, ritiraDiarioGenitori } from '@/lib/primaria/notifiche';
import { getModuleConfig } from '@/lib/settings/module-config';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento, logErrore } from '@/lib/logging/logger';
import { riconciliaRichieste } from '@/lib/armadietto/richieste';
import { voceDaMostrare } from '@/lib/diary/registrazione';
import { applicaRoutineAlLotto } from '@/lib/diary/routine-lotto';
import { TIPI_BASE, TIPO_ROUTINE_RE, eRoutinePersonalizzata, routineCompilata } from '@/lib/diary/routine';
import { eEventoAttivita, ORA_ATTIVITA_RE, oraAttivitaValida } from '@/lib/diary/attivita';

// Modalità genitore: default from = 14 giorni fa, to = oggi (dinamici, calcolati nel codice).
const getParentQuerySchema = z.object({
    alunno_id: zUuid,
    from: zDataYMD.optional(),
    to: zDataYMD.optional(),
});

// Modalità insegnante/staff: default date = oggi (dinamico, calcolato nel codice).
// Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
const getTeacherQuerySchema = z.object({
    sezione: z.string().default(''),
    // L'identità VERA della classe. Il nome resta accettato (shell native già
    // installate, URL salvati) ma porta allo stesso filtro per uuid.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
    date: zDataYMD.optional(),
    // La sede scelta nel SedeSelector (R70): il nome-classe da solo non basta più.
    scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
});

// Un evento diario: campi pass-through verso il DB lasciati permissivi
// (il comportamento attuale non impone vincoli su orari/dettagli/nota).
const entrySchema = z.object({
    versioneAttesa: z.number().int().nonnegative().nullable().optional(),
    alunno_id: zUuid,
    // UN VOCABOLARIO CHIUSO (2026-09-28, seconda revisione): i tipi base e `routine:<id>`. Era una
    // stringa libera, e da quando le routine si accendono e si spengono per sede una stringa libera
    // le aggirava: `BAGNO`, `bagno ` o `Routine:…` si scrivevano senza passare dai controlli (lo
    // poteva fare solo il personale, ma lo poteva fare). In produzione, misurato lo stesso giorno,
    // i tipi scritti sono SETTE, tutti in `TIPI_BASE`.
    tipo_evento: z.union([z.enum(TIPI_BASE), z.string().regex(TIPO_ROUTINE_RE)]),
    // Default dinamico (adesso) calcolato nel codice.
    orario_inizio: z.unknown().optional(),
    orario_fine: z.unknown().optional(),
    dettagli: z.unknown().optional(),
    // Nota di SEZIONE: broadcast, identica per tutti i genitori.
    nota_libera: z.unknown().optional(),
    // Nota per SINGOLO bambino (E1): visibile solo al genitore di quel bambino.
    // Colonna dedicata `nota_bambino`, distinta da nota_libera (per non essere
    // sovrascritta dalla nota di sezione). Senza questo campo zod la scarterebbe.
    nota_bambino: z.unknown().optional(),
    // Routine della scuola (2026-09-28): la maestra ha TOLTO il valore e tiene la nota. Senza questo
    // segnale il server conserva il valore già salvato (vedi `tieniPrecedente`), che è la regola
    // giusta quando il client non sa mostrarlo — non quando la maestra l'ha tolto apposta.
    azzera_valore: z.boolean().optional(),
    // Routine della scuola (quinto giro, 2026-09-28): la maestra ha tolto la SOLA NOTA di un valore
    // che la routine non prevede più. La riga di oggi, se c'è, perde la nota del bambino e tiene il
    // valore (e la nota di sezione, se a schermo non ce n'è una nuova); se non c'è, non si crea.
    // Senza, quella voce (valore vuoto, nessuna nota) era «muta» e si saltava.
    togli_nota: z.boolean().optional(),
});

// Il body può essere un singolo evento o un array di eventi.
const postBodySchema = z.union([z.array(entrySchema), entrySchema]);
const postQuerySchema = z.object({ date: zDataYMD.optional(), scuola_id: zUuid.optional(), sectionId: zUuid.optional() });

// ─────────────────────────────────────────────────────────────────────────────
// ORARIO DELLE ATTIVITÀ (D1, 26/09/2026) — contratto in
// docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/D1.md
//
// Ogni voce di `dettagli.activities[]` di un evento `attivita` può portare
// `ora_inizio`/`ora_fine` ("HH:MM", facoltativi). Si valida SOLO l'orario: il
// resto di `dettagli` resta pass-through come prima (`looseObject`, voci non
// oggetto e `activities` non array lasciate passare), e ciò che si scrive è il
// `dettagli` ricevuto, non l'output di zod.
//
// Stringa vuota e `null` valgono «non inserito»: è ciò che un
// `<input type="time">` lasciato vuoto produce.
// ─────────────────────────────────────────────────────────────────────────────
const MSG_ORA_FORMATO = "Orario dell'attività non valido: usa il formato HH:MM (es. 09:30).";
const MSG_ORA_FINE_PRIMA = "L'ora di fine di un'attività non può essere prima dell'ora di inizio.";

const zOraAttivita = z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string({ error: MSG_ORA_FORMATO }).regex(ORA_ATTIVITA_RE, { error: MSG_ORA_FORMATO }).optional(),
);

const voceAttivitaSchema = z.preprocess(
    // Una voce non-oggetto passava prima e passa ancora: qui si guarda solo l'orario.
    (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    z.looseObject({ ora_inizio: zOraAttivita, ora_fine: zOraAttivita }).superRefine((voce, ctx) => {
        // In zod 4 questa refinement gira ANCHE se un campo ha già fallito la regex:
        // si confronta solo quando entrambi sono "HH:MM" validi (zero-padded), l'unico
        // caso in cui l'ordine fra stringhe è quello fra orari. Altrimenti '9:30' vs
        // '10:00' produrrebbe un «fine prima dell'inizio» falso, che per la regola di
        // precedenza coprirebbe il vero errore di formato.
        if (
            oraAttivitaValida(voce.ora_inizio) &&
            oraAttivitaValida(voce.ora_fine) &&
            voce.ora_fine < voce.ora_inizio
        ) {
            ctx.addIssue({ code: 'custom', message: MSG_ORA_FINE_PRIMA, path: ['ora_fine'] });
        }
    }),
);

const dettagliAttivitaSchema = z.looseObject({
    activities: z.preprocess(
        (v) => (Array.isArray(v) ? v : undefined),
        z.array(voceAttivitaSchema).optional(),
    ),
});

/**
 * Valida gli orari di TUTTE le voci attività del lotto, prima di qualunque
 * scrittura: tutto-o-niente. `null` = tutto a posto; altrimenti la 422.
 */
function validaOrariAttivita(
    entries: ReadonlyArray<{ tipo_evento: string; dettagli?: unknown }>,
    lotto: boolean,
): NextResponse | null {
    const dettagliErrori: Array<{ path: string; message: string }> = [];
    let nVociNonValide = 0;
    entries.forEach((e, i) => {
        if (!eEventoAttivita(e.tipo_evento)) return;
        // Solo un oggetto può portare `activities`: `dettagli` array o primitivo
        // passava prima così com'era e passa ancora.
        if (!e.dettagli || typeof e.dettagli !== 'object' || Array.isArray(e.dettagli)) return;
        const r = dettagliAttivitaSchema.safeParse(e.dettagli);
        if (r.success) return;
        const voci = new Set<string>();
        for (const issue of r.error.issues) {
            const percorso = ['dettagli', ...issue.path.map(String)];
            voci.add(percorso.slice(0, 3).join('.'));
            dettagliErrori.push({ path: (lotto ? [String(i), ...percorso] : percorso).join('.'), message: issue.message });
        }
        nVociNonValide += voci.size;
    });
    if (dettagliErrori.length === 0) return null;

    // «Fine prima dell'inizio» ha la precedenza: è l'errore che la maestra può capire.
    const incoerente = dettagliErrori.some((d) => d.message === MSG_ORA_FINE_PRIMA);
    // Solo codici e conteggi: niente alunno, niente descrizione.
    logEvento('diary', 'warn', {
        operazione: 'diary/entries:POST',
        esito: 'orario-attivita-non-valido',
        error_code: incoerente ? 'ORARIO_ATTIVITA_INCOERENTE' : 'ORARIO_ATTIVITA_NON_VALIDO',
        n_voci_non_valide: nVociNonValide,
        n_ricevute: entries.length,
    });
    // Codici LETTERALI, uno per ramo: il lock `errori-con-codice` deve poterli leggere.
    if (incoerente) {
        return NextResponse.json(
            { error: MSG_ORA_FINE_PRIMA, codice: 'ORARIO_ATTIVITA_INCOERENTE', details: dettagliErrori },
            { status: 422 },
        );
    }
    return NextResponse.json(
        { error: MSG_ORA_FORMATO, codice: 'ORARIO_ATTIVITA_NON_VALIDO', details: dettagliErrori },
        { status: 422 },
    );
}

// GET /api/diary/entries
// Modalità insegnante: ?sezione=<classe>&date=2026-05-12
// Modalità genitore:   ?alunno_id=xxx&from=2026-04-28
//
// P0/S9b (DL-040): tutti gli accessi a `eventi_diario` usano service-role +
// scoping applicativo (End-state X, DL-035), così le policy permissive anon
// sono droppate. Il ramo per alunno è gated con `requireParentOfStudent`:
// identità dalla SESSIONE, poi legame genitore↔figlio al genitore e
// plesso+sezione a chiunque altro.
//
// ⚠️ Il secondo pezzo è arrivato il 2026-07-31, e prima non c'era: questo è il
// ramo su cui la falla è stata MISURATA in produzione. Un educator di Aversa
// chiedeva `?alunno_id=<minore di Giugliano>` e riceveva 200 con quindici voci
// di diario — bagno, pranzo, attività. La query qui sotto filtra solo per
// `alunno_id`, che è un valore scelto dal client: senza il gate non esiste
// nessun altro presidio, perché il client è service-role e la RLS non si
// applica.
export const GET = withRoute('diary/entries:GET', async (request: NextRequest) => {
    const admin = await createAdminClient();
    const params = request.nextUrl.searchParams;

    // ── Modalità genitore: per singolo alunno in un range di date ──
    if (params.get('alunno_id')) {
        const q = parseQuery(request, getParentQuerySchema);
        if ('response' in q) return q.response;
        // Scoping di proprietà (privacy minori): il genitore del bambino, oppure
        // lo staff che ha quel bambino nel proprio plesso (e nella propria
        // sezione, se educator). Chiude la lettura anonima, quella dell'altro
        // genitore e quella cross-sede.
        const gate = await requireParentOfStudent(request, q.data.alunno_id);
        if (gate.response) return gate.response;
        const fromDate = q.data.from ?? (() => {
            return new Date(Date.parse(`${oggiRoma()}T12:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
        })();
        const toDate = q.data.to ?? oggiRoma();

        // Buffer visibilità (come le valutazioni primaria, PRD §4.5): il genitore
        // vede una voce solo trascorsi `buffer_visibilita_min` minuti dalla
        // creazione, così la maestra ha la finestra di correzione. Default 10'.
        const { data: alunno, error: erroreSede } = await admin
            .from('alunni')
            .select('scuola_id')
            .eq('id', q.data.alunno_id)
            .maybeSingle();
        if (erroreSede) logErrore({ operazione: 'diary/entries:GET', evento: 'db' }, erroreSede);
        const diarioCfg = await getModuleConfig<{ buffer_visibilita_min?: number }>(
            admin, 'diario_config', alunno?.scuola_id,
        );
        const bufferMin = diarioCfg.buffer_visibilita_min ?? 10;
        const soglia = new Date(Date.now() - bufferMin * 60_000).toISOString();

        // `nota_bambino` (E1) è la nota riservata al singolo bambino; `nota_libera`
        // resta la nota di sezione (broadcast). Il DB E2E CI non è migrato: se la
        // colonna non esiste la SELECT torna 42703 → riprova senza (degrado pulito).
        const buildParent = (conNotaBambino: boolean) => admin
            .from('eventi_diario')
            .select(conNotaBambino
                ? 'id, tipo_evento, orario_inizio, dettagli, nota_libera, nota_bambino'
                : 'id, tipo_evento, orario_inizio, dettagli, nota_libera')
            .eq('alunno_id', q.data.alunno_id)
            .gte('orario_inizio', intervalloGiornoRoma(fromDate).startOfDay)
            .lte('orario_inizio', intervalloGiornoRoma(toDate).endOfDay)
            // Nasconde le voci create da meno di `bufferMin` (finestra di correzione).
            .lte('creato_il', soglia)
            .order('orario_inizio', { ascending: false });

        let res = await buildParent(true);
        if (res.error && ['PGRST204', '42703'].includes((res.error as { code?: string }).code ?? '')) {
            logEvento('diary', 'info', {
                operazione: 'diary/entries:GET',
                esito: 'degrado-nota-bambino-assente',
            });
            res = await buildParent(false);
        }
        const { data, error } = res;

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        // Il type-parser di Supabase non modella la SELECT condizionale (degrado
        // nota_bambino → union di due literal) e inferisce un ParserError: la query
        // è corretta a runtime, si normalizza la riga a Record per il map.
        const mapped = ((data ?? []) as unknown as Record<string, unknown>[]).map((e) => ({
            id:                   e.id,
            tipo_evento:          e.tipo_evento,
            timestamp_evento:     e.orario_inizio,
            dettagli:             e.dettagli,
            note:                 e.nota_libera,
            // Solo la nota del PROPRIO bambino (il ramo è già filtrato per alunno_id).
            notaBambino:          (e.nota_bambino as string | null | undefined) ?? null,
            activity_description: null,
        }));
        return NextResponse.json(mapped);
    }

    // ── Modalità insegnante/staff: per sezione + data ──
    // Gate ruolo + gate classe + isolamento per plesso.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getTeacherQuerySchema);
    if ('response' in q) return q.response;
    const sezione = q.data.sezione;
    const date = q.data.date ?? oggiRoma();
    // Contratto storico: senza sezione la risposta è vuota, non un 400.
    if (!sezione && !q.data.sectionId) return NextResponse.json([]);

    // Rispetta la selezione del SedeSelector (cookie `sedi_attive`), ri-validata
    // contro le sedi accessibili, e la sede eventualmente dichiarata in query.
    const attive = await resolveScuoleAttive(request, admin, auth.user);
    const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
        azione: 'diary/entries:GET', utente: auth.user.id, ruolo: auth.user.role,
    });
    if (sede.response) return sede.response;
    const plessi = sede.plessi ?? [];
    if (plessi.length === 0) return NextResponse.json([]);

    // GATE per SEZIONE ASSEGNATA prima di leggere gli alunni: `requireDocente`
    // verifica il ruolo, non la classe (R108). Educator → solo le sue sezioni.
    // Il gate passava e l'elenco restava vuoto lo stesso: si filtrava per NOME.
    const storica = puoCorreggereStorico(auth.user) && date < oggiRoma();
    const classe = storica && q.data.sectionId
        ? { sectionIds: [q.data.sectionId], response: undefined }
        : await risolviSezione(admin, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
    if (classe.response) return classe.response;
    if (classe.sectionIds.length === 0) return NextResponse.json([]);

    let idsStorici: string[] | null = null;
    if (storica) {
        try { idsStorici = [...new Set((await appartenenzeNelGiorno(admin, { scuole: plessi, sectionIds: classe.sectionIds, giorno: date })).map(a => a.alunno_id))]; }
        catch (error) { logEvento('registro', 'error', { operazione: 'diary/entries:GET', esito: 'appartenenze-non-lette' }, error); return rispostaErroreStorico(error, 'diary/entries:GET'); }
        if (!idsStorici.length) return NextResponse.json([]);
    }
    const queryAlunni = idsStorici
        ? admin.from('alunni').select('id').in('id', idsStorici).is('anonimizzato_il', null)
        : admin.from('alunni').select('id').in('section_id', classe.sectionIds).in('scuola_id', plessi).is('anonimizzato_il', null);
    const { data: alunni, error: erroreAlunni } = await queryAlunni;

    if (erroreAlunni) {
        logErrore({ operazione: 'diary/entries:GET', evento: 'db' }, erroreAlunni);
        return NextResponse.json({ error: 'Lettura degli alunni non riuscita', codice: 'DIARIO_LETTURA_FALLITA' }, { status: 500 });
    }
    if (!alunni || alunni.length === 0) return NextResponse.json([]);

    const ids = alunni.map(a => a.id);
    const { startOfDay, endOfDay } = intervalloGiornoRoma(date);

    const { data, error } = await admin
        .from('eventi_diario')
        .select('*')
        .in('alunno_id', ids)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay)
        .order('orario_inizio', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(data);
});

/** Il perimetro di una rettifica è quello comprovato per quel giorno, non la classe corrente. */
async function contestoStoricoDiario(admin: Awaited<ReturnType<typeof createAdminClient>>, utente: AppUser, request: NextRequest, giorno: string, scuolaId: string | undefined, alunnoIds: string[], sectionId?: string): Promise<{ response: NextResponse } | { scuola_id: string; sezioni: Map<string, string> }> {
    if (!scuolaId) return { response: rifiutoSede('SEDE_DA_SPECIFICARE') };
    const scuole = await resolveScuoleAttive(request, admin, utente);
    if (!scuole.includes(scuolaId)) return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') };
    try {
        const membri = await appartenenzeNelGiorno(admin, { scuole: [scuolaId], sectionIds: sectionId ? [sectionId] : undefined, alunnoIds, giorno });
        const sezioni = new Map<string, string>();
        for (const id of alunnoIds) {
            const classi = new Set(membri.filter(m => m.alunno_id === id).map(m => m.section_id));
            if (classi.size !== 1) return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') };
            sezioni.set(id, [...classi][0]);
        }
        return { scuola_id: scuolaId, sezioni };
    } catch (err) {
        logErrore({ operazione: 'diary/perimetro-storico', evento: 'db' }, err);
        return { response: rispostaErroreStorico(err, 'diary/perimetro-storico') };
    }
}

// POST /api/diary/entries — salva (upsert) eventi diario
// Per ogni alunno+tipo_evento: se già esiste oggi → UPDATE, altrimenti → INSERT
export const POST = withRoute('diary/entries:POST', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const query = parseQuery(request, postQuerySchema);
    if ('response' in query) return query.response;
    const giorno = query.data.date ?? oggiRoma();
    if (giorno !== oggiRoma() && !puoCorreggereStorico(auth.user)) {
        logEvento('diary', 'info', { operazione: 'diary/entries:POST', esito: 'data-storica-docente-negata', data: giorno });
        return NextResponse.json({ error: 'Il docente può compilare solo il diario di oggi.', codice: 'DIARIO_DATA_BLOCCATA' }, { status: 423 });
    }
    const operazione = politicaNotificaOperazione({ attore: auth.user, giornoCompetenza: giorno });
    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const admin = await createAdminClient();

    const entries = Array.isArray(b.data) ? b.data : [b.data];

    // Orario delle attività: 422 PRIMA di ogni lettura/scrittura (vedi validaOrariAttivita).
    const orarioNonValido = validaOrariAttivita(entries, Array.isArray(b.data));
    if (orarioNonValido) return orarioNonValido;

    const alunnoIds = [...new Set(entries.map((e) => e.alunno_id).filter(Boolean))];
    const storica = eRettificaStorica(auth.user, giorno);
    let contestoStorico: { scuola_id: string; sezioni: Map<string, string> } | null = null;
    if (storica) {
        const contesto = await contestoStoricoDiario(admin, auth.user, request, giorno, query.data.scuola_id, alunnoIds, query.data.sectionId);
        if ('response' in contesto) return contesto.response;
        contestoStorico = contesto;
    } else {
        for (const aid of alunnoIds) {
            const scopeErr = await assertAlunnoInScope(admin, auth.user, aid);
            if (scopeErr) return scopeErr;
        }
    }

    // Le routine della SEDE DEL BAMBINO (2026-09-28): spente, inesistenti o con un valore che non
    // vale non si scrivono (422, tutto-o-niente); quelle della scuola escono con la fotografia
    // scritta dal server. Vedi `applicaRoutineAlLotto`.
    const routine = await applicaRoutineAlLotto(admin, entries, contestoStorico ? new Map(alunnoIds.map(id => [id, contestoStorico.scuola_id])) : undefined);
    if ('response' in routine) return routine.response;
    const verificate = routine.voci;

    // ─────────────────────────────────────────────────────────────────────────
    // LA VOCE MUTA NON ENTRA IN ARCHIVIO, E LA REGOLA STA ANCHE QUI.
    //
    // Non è ridondanza col filtro della schermata: è che quel filtro vive nel
    // CLIENT, e un client si può non aggiornare. Misurato il 2026-09-08, DUE ORE
    // dopo il rilascio del salvataggio selettivo: una maestra ha scritto 19 righe
    // di bagno di cui 17 vuote e senza note, perché il suo tablet aveva l'app
    // aperta da mattina e stava ancora eseguendo il bundle di prima. Tre colleghe,
    // nella stessa finestra, ne hanno scritte zero. La regola va dove nessuno può
    // scavalcarla: nella rotta che possiede la tabella.
    //
    // NON si RIFIUTA la richiesta: le altre righe sono legittime e vanno salvate.
    // Le mute si SALTANO — ed è per questo che il salto si logga: «17 righe non
    // scritte» in silenzio sarebbe il guasto opposto a quello che stiamo chiudendo.
    //
    // `voceDaMostrare` è la stessa funzione dei cinque lettori: una regola sola,
    // e fail-open sui tipi che non ne hanno una (nessun filtro inventato qui).
    // ─────────────────────────────────────────────────────────────────────────
    // `togli_nota` vale solo per le routine della scuola: sugli altri tipi non apre niente.
    const togliNota = (e: { tipo_evento: string; togli_nota?: boolean }) => e.togli_nota === true && eRoutinePersonalizzata(e.tipo_evento);
    const daScrivere = verificate.filter((e) => togliNota(e) || voceDaMostrare(
        e.tipo_evento,
        (e.dettagli ?? null) as Record<string, unknown> | null,
        { conNota: Boolean(String(e.nota_libera ?? '').trim() || String(e.nota_bambino ?? '').trim()) },
    ));
    if (daScrivere.length < entries.length) {
        logEvento('diary', 'warn', {
            operazione: 'diary/entries:POST',
            esito: 'voci-mute-saltate',
            n_ricevute: entries.length,
            n_saltate: entries.length - daScrivere.length,
        });
    }

    const today = giorno;
    const { startOfDay, endOfDay } = intervalloGiornoRoma(giorno);

    const atteseStoriche: AttesaStorica[] = [];
    const azioniStoriche: AzioneStorica[] = [];

    const results: Array<{ id: string; alunno_id: string; tipo_evento: string; storico_versione?: number }> = [];
    const errors = [];
    // `togli_nota` senza una riga di oggi: non si crea niente, e lo si conta per il log qui sotto.
    let togliNotaSenzaRiga = 0;

    const scalaPannolino = async (entry: typeof daScrivere[number]) => {
        // #9 — Scalo automatico pannolino: ad ogni evento "bagno" scala 1 pannolino
        // dall'armadietto, SOLO per i bambini con flag "usa_pannolino" in anagrafica.
        // Best-effort e idempotente per giorno: non blocca mai il salvataggio del diario.
        if (entry.tipo_evento === 'bagno' && results.some(r => r.alunno_id === entry.alunno_id && r.tipo_evento === 'bagno')) {
            try {
                // `scuola_id` insieme a `usa_pannolino`: lo scalo scrive su
                // `armadietto`, e ogni scrittura dichiara la sua sede. Fino al
                // 2026-07-31 questo insert — come gli altri due su `armadietto` —
                // la ometteva, e in produzione la colonna è NULL su tutte le righe.
                let anagrafica = admin.from('alunni').select('usa_pannolino, scuola_id').eq('id', entry.alunno_id);
                if (contestoStorico) anagrafica = anagrafica.eq('scuola_id', contestoStorico.scuola_id);
                const { data: attuale, error: erroreAlunno } = await anagrafica.maybeSingle();
                if (erroreAlunno) throw erroreAlunno;
                let al = attuale;
                if (!al && contestoStorico) {
                    // Un ex alunno non concede accesso ai suoi dati correnti nell'altra sede.
                    // Per il consumo valgono le evidenze dei pannolini già movimentati qui.
                    const { data: evidenze, error: erroreEvidenze } = await admin.from('armadietto').select('id').eq('alunno_id', entry.alunno_id).eq('scuola_id', contestoStorico.scuola_id).eq('materiale', 'Pannolini').lte('date', giorno).limit(1);
                    if (erroreEvidenze) throw erroreEvidenze;
                    if (evidenze?.length) al = { usa_pannolino: true, scuola_id: contestoStorico.scuola_id };
                    else logEvento('diary', 'info', { operazione: 'diary/entries:POST', esito: 'scalo-storico-senza-evidenza-pannolini' });
                }
                const scuolaAlunno = (al?.scuola_id as string | undefined) ?? null;
                if (al?.usa_pannolino === true && !scuolaAlunno) {
                    // Sede non risolvibile: si SALTA lo scalo invece di scrivere una
                    // riga senza plesso. Va detto per lo stesso motivo del catch qui
                    // sotto: è una scorta che a fine mese non torna.
                    logEvento('diary', 'warn', {
                        operazione: 'diary/entries:POST',
                        esito: 'scalo-pannolino-saltato-senza-sede',
                    });
                }

                if (al?.usa_pannolino === true && scuolaAlunno) {
                    // Evita doppio scalo nello stesso giorno (idempotenza su update ripetuti)
                    const { data: giaScalato, error: erroreMovimento } = await admin
                        .from('armadietto')
                        .select('id')
                        .eq('alunno_id', entry.alunno_id)
                        .eq('materiale', 'Pannolini')
                        .eq('scuola_id', scuolaAlunno)
                        .eq('date', today)
                        .eq('portato', false)
                        .limit(1);

                    if (erroreMovimento) throw erroreMovimento;
                    if (!giaScalato || giaScalato.length === 0) {
                        const { error: erroreScalo } = await admin.from('armadietto').insert({
                            alunno_id: entry.alunno_id,
                            scuola_id: scuolaAlunno,
                            nome_oggetto: 'Pannolini',
                            materiale: 'Pannolini',
                            quantita: 1,
                            quantita_residua: 0,
                            date: today,
                            politica_operazione: operazione,
                            portato: false, // consumo: sottrae dallo stock aggregato
                            livello_allerta: 5,
                            livello_emergenza: 2,
                        });
                        if (erroreScalo) throw erroreScalo;
                        logEvento('diary', 'info', { operazione: 'diary/entries:POST', esito: 'pannolino-scalato', data: giorno, alunno_id: entry.alunno_id });

                        // Lo scalo è il DATO, la richiesta è la CONSEGUENZA: la
                        // conseguenza non può far fallire il dato. Se la
                        // riconciliazione esplode, il movimento resta scritto e il
                        // cron delle 06:00 rimetterà le cose a posto. Un catch che
                        // non logga sarebbe un bug (AGENTS.md regola 6).
                        //
                        // Dentro il ramo dell'insert e non fuori: qui lo stock è
                        // appena cambiato. Se il pannolino era già stato scalato
                        // oggi (idempotenza per giorno) non c'è nessun movimento
                        // nuovo da riconciliare, e ripassare a ogni evento «bagno»
                        // di ogni bambino della sezione sarebbe solo lavoro inutile
                        // sul database.
                        try {
                            await riconciliaRichieste(admin, { alunnoId: entry.alunno_id, operazione, materiale: 'Pannolini', ...(contestoStorico ? { sedeStorica: { scuolaId: contestoStorico.scuola_id, sectionId: contestoStorico.sezioni.get(entry.alunno_id) ?? null } } : {}) });
                        } catch (e) {
                            logErrore({ operazione: 'diary/entries:POST', evento: 'db' }, e);
                        }
                    }
                }
            } catch (e) {
                // Lo scalo del pannolino è un effetto collaterale: se salta, il diario è comunque
                // salvato e la richiesta non deve fallire. Ma «saltato» va detto — è una scorta che
                // non viene scalata, cioè un armadietto che a fine mese non torna, e senza questa
                // riga la discrepanza sarebbe inspiegabile. `warn` e non `error`: il dato principale
                // è salvo. Va in tabella (vaPersistito persiste i warn), che è dove la si conta.
                logEvento('diary', 'warn', {
                    operazione: 'diary/entries:POST',
                    esito: 'scalo-pannolino-saltato',
                }, e);
            }
        }
    };

    for (const entry of daScrivere) {
        // Cerca se esiste già un evento per questo alunno+tipo oggi
        const { data: existing, error: erroreRicerca } = await admin
            .from('eventi_diario')
            .select('*')
            .eq('alunno_id', entry.alunno_id)
            .eq('tipo_evento', entry.tipo_evento)
            .gte('orario_inizio', startOfDay)
            .lte('orario_inizio', endOfDay)
            .order('orario_inizio', { ascending: false })
            .limit(1);

        // PostgREST non lancia: senza questo controllo una ricerca fallita diventava «non c'è» e si
        // scriveva una SECONDA riga — col valore vuoto, se era una nota: il genitore, che legge
        // l'ultima voce per tipo, avrebbe visto sparire il valore (terzo giro, 2026-09-28).
        if (erroreRicerca) {
            logErrore({ operazione: 'diary/entries:POST', evento: 'db' }, erroreRicerca);
            errors.push({ alunno_id: entry.alunno_id, error: 'Lettura della voce di oggi non riuscita' });
            continue;
        }

        // `togli_nota` su una riga che non c'è: niente da togliere, e mai un INSERT. Con la riga,
        // si passa dall'UPDATE normale qui sotto: col valore vuoto `tieniPrecedente` tiene quello
        // salvato e la nota si azzera; con un valore nuovo e valido si scrive il valore nuovo
        // (sesto giro, 2026-09-28: un ramo a parte scriveva solo la nota e perdeva il valore).
        if (togliNota(entry) && (!existing || existing.length === 0)
            && !routineCompilata(entry.dettagli as Record<string, unknown> | null)) {
            togliNotaSenzaRiga += 1;
            continue;
        }

        if (storica) {
            if (existing?.length && existing[0].storico_versione === undefined) return storicoIndisponibile();
            atteseStoriche.push({ tabella: 'eventi_diario', filtro: existing?.length ? { id: existing[0].id } : { alunno_id: entry.alunno_id, tipo_evento: entry.tipo_evento, giorno_competenza: giorno }, versione: entry.versioneAttesa });
        }

        if (existing && existing.length > 0) {
            // UPDATE — resiliente alla colonna nota_bambino non ancora migrata (DB E2E CI):
            // PGRST204/42703 → rimuove la colonna mancante e riprova. In prod esiste → 0 retry.
            // Una routine della scuola che arriva SENZA valore (tenuta in piedi da una nota) non
            // cancella il valore già salvato (2026-09-28): succede quando la segreteria ha cambiato
            // le opzioni e il valore di stamattina non vale più per la routine com'è adesso. Il
            // valore si toglie col cestino, o svuotando e salvando — che mandano una DELETE.
            const precedente = (existing[0] as { dettagli?: Record<string, unknown> | null }).dettagli ?? null;
            const tieniPrecedente = eRoutinePersonalizzata(entry.tipo_evento)
                && entry.azzera_valore !== true
                && !routineCompilata(entry.dettagli as Record<string, unknown> | null)
                && routineCompilata(precedente);
            const updateRecord: Record<string, unknown> = {
                // Si tiene il VALORE, non la fotografia vecchia: nome e icona sono quelli di oggi.
                dettagli: tieniPrecedente
                    ? { ...(entry.dettagli as Record<string, unknown>), valore: precedente?.valore }
                    : entry.dettagli ?? null,
                orario_fine: entry.orario_fine == null ? null : istanteNelGiornoRoma(giorno, new Date(String(entry.orario_fine))),
                nota_libera: entry.nota_libera ?? null,   // nota di sezione (broadcast a tutti)
                nota_bambino: entry.nota_bambino ?? null, // nota del singolo bambino (E1)
                // activity_description escluso: colonna non ancora migrata
            };
            // Togliendo la sola nota del bambino, una nota di sezione vuota a schermo non cancella
            // quella salvata sulla riga (l'editor non la ripristina mai: vuota non vuol dire tolta).
            if (togliNota(entry) && !String(entry.nota_libera ?? '').trim()) delete updateRecord.nota_libera;
            if (storica) { azioniStoriche.push({ tabella: 'eventi_diario', operazione: 'update', filtro: { id: existing[0].id }, valori: updateRecord }); continue; }
            let updRes = await admin.from('eventi_diario').update(updateRecord).eq('id', existing[0].id).select('id, alunno_id, tipo_evento');
            let uAttempts = 0;
            while (updRes.error && ['PGRST204', '42703'].includes((updRes.error as { code?: string }).code ?? '') && uAttempts < 4) {
                const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(updRes.error.message);
                const col = m?.[1] ?? m?.[2];
                if (!col || !(col in updateRecord)) break;
                delete updateRecord[col];
                updRes = await admin.from('eventi_diario').update(updateRecord).eq('id', existing[0].id).select('id, alunno_id, tipo_evento');
                uAttempts++;
            }
            if (updRes.error) errors.push({ alunno_id: entry.alunno_id, error: updRes.error.message });
            else if (updRes.data) results.push(...updRes.data);
        } else {
            // INSERT — stessa resilienza alla colonna nota_bambino non ancora migrata.
            const insertRecord: Record<string, unknown> = {
                alunno_id: entry.alunno_id,
                // Provenienza operativa = chi registra (anche la segreteria). Non è una firma valutativa.
                maestra_id: auth.user.id,
                tipo_evento: entry.tipo_evento,
                orario_inizio: istanteNelGiornoRoma(giorno, entry.orario_inizio ? new Date(String(entry.orario_inizio)) : new Date()),
                orario_fine: entry.orario_fine == null ? null : istanteNelGiornoRoma(giorno, new Date(String(entry.orario_fine))),
                dettagli: entry.dettagli ?? null,
                nota_libera: entry.nota_libera ?? null,   // nota di sezione (broadcast a tutti)
                nota_bambino: entry.nota_bambino ?? null, // nota del singolo bambino (E1)
                // activity_description escluso: colonna non ancora migrata su Supabase
                pubblicato: false,
            };
            if (storica) { azioniStoriche.push({ tabella: 'eventi_diario', operazione: 'insert', valori: insertRecord }); continue; }
            let insRes = await admin.from('eventi_diario').insert(insertRecord).select('id, alunno_id, tipo_evento');
            let iAttempts = 0;
            while (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '') && iAttempts < 4) {
                const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(insRes.error.message);
                const col = m?.[1] ?? m?.[2];
                if (!col || !(col in insertRecord)) break;
                delete insertRecord[col];
                insRes = await admin.from('eventi_diario').insert(insertRecord).select('id, alunno_id, tipo_evento');
                iAttempts++;
            }
            if (insRes.error) errors.push({ alunno_id: entry.alunno_id, error: insRes.error.message });
            else if (insRes.data) results.push(...insRes.data);
        }

        if (!storica) await scalaPannolino(entry);
    }

    if (storica && azioniStoriche.length && contestoStorico) {
        const rettifica = await applicaRettificaStorica(admin, { attore: auth.user, scuolaId: contestoStorico.scuola_id, sectionId: [...new Set(contestoStorico.sezioni.values())].length === 1 ? [...contestoStorico.sezioni.values()][0] : null, modulo: 'diario', giorno, attese: atteseStoriche, azioni: azioniStoriche });
        if ('response' in rettifica) return rettifica.response;
        results.push(...rettifica.righe.flat().map(r => ({ id: String(r.id), alunno_id: String(r.alunno_id), tipo_evento: String(r.tipo_evento), storico_versione: Number(r.storico_versione) })));
        for (const entry of daScrivere) await scalaPannolino(entry);
    }

    if (togliNotaSenzaRiga > 0) {
        logEvento('diary', 'warn', {
            operazione: 'diary/entries:POST',
            esito: 'togli-nota-senza-riga',
            n_ricevute: entries.length,
            n_saltate: togliNotaSenzaRiga,
        });
    }

    // Audit (diff) + notifica al docente titolare se scrive segreteria/direzione.
    if (results.length > 0) {
        const { data: al, error: erroreContesto } = contestoStorico ? { data: { scuola_id: contestoStorico.scuola_id, section_id: contestoStorico.sezioni.get(results[0].alunno_id) }, error: null } : await admin.from('alunni').select('section_id, scuola_id').eq('id', results[0].alunno_id).maybeSingle();
        if (erroreContesto) logErrore({ operazione: 'diary/entries:POST', evento: 'db' }, erroreContesto);
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'diario', azione: 'update',
            scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null, valoreDopo: results,
        });
        if (al?.section_id) {
            await notificaTitolariScrittura(admin, { attore: auth.user, sectionId: al.section_id, scuolaId: al?.scuola_id, area: 'diario' });
        }

        // Push genitori per aggiornamento diario (buffer 10' + debounce) — 1 per figlio.
        const figliIds = [...new Set(results.map((r) => r.alunno_id).filter(Boolean))];
        const { data: nomi, error: erroreNomi } = await admin.from('alunni').select('id, nome').in('id', figliIds);
        if (erroreNomi) logErrore({ operazione: 'diary/entries:POST', evento: 'db' }, erroreNomi);
        const nomeById = new Map((nomi ?? []).map((n) => [n.id, n.nome as string | null]));
        for (const aid of figliIds) {
            await enqueueDiarioGenitori(admin, { alunnoId: aid, nome: nomeById.get(aid), operazione });
        }
    }

    logEvento('diary', 'info', { operazione: 'diary/entries:POST', esito: 'diario-salvato', data: giorno, n: results.length, n_errori: errors.length });
    if (errors.length > 0) {
        return NextResponse.json({ saved: results, errors }, { status: 207 });
    }

    return NextResponse.json(results);
});

// ─────────────────────────────────────────────────────────────────────────────────
// DELETE /api/diary/entries?alunno_id=…&tipo_evento=nanna_inizio&date=YYYY-MM-DD
//
// «Ho segnato la nanna a un bambino per errore.» Fino a oggi non c'era modo di
// disfarlo: nessun handler DELETE esisteva sotto /api/diary, e l'unica via per
// togliere una riga da `eventi_diario` era l'oblio GDPR dell'alunno o il wipe
// dell'ambiente.
//
// PERCHÉ IL VERBO STA QUI. `eventi_diario` è la risorsa di questa rotta. Aggiungere
// il verbo dove la risorsa già vive muove UN solo conteggio dell'inventario di
// `isolamento-sede-coverage` (handlerControllati) invece dei due che costerebbe una
// rotta nuova — e soprattutto tiene le regole di questa tabella in un posto solo.
//
// PERCHÉ NON UNA POST CON `dettagli` VUOTO, che di lock non ne avrebbe mossi affatto:
//  · la riga RESTEREBBE in archivio, invisibile solo perché tre lettori si ricordano
//    di filtrarla. Il quarto lettore che nascerà — un export, un prospetto, un
//    conteggio «quanti hanno dormito» — non se lo ricorderà: è il difetto che stiamo
//    chiudendo, rimandato di un anno;
//  · la POST accoda `enqueueDiarioGenitori`, cioè manderebbe al genitore un push
//    «il diario è aggiornato» per dirgli che una cosa non è successa;
//  · scriverebbe `azione: 'update'` su una cancellazione. `AzioneScrittura` ha già
//    `'delete'`: usare l'altro è una colonna d'audit che mente.
//
// PERIMETRO STRETTO, DI PROPOSITO. `tipo_evento` è un `z.enum`, non una stringa
// libera: il gesto che questa porta serve è «ho sbagliato a segnare», non «cancella
// una riga qualunque del diario».
//
// ⏭️ IL 2026-09-08 LA DECISIONE È PASSATA, ed è quella che la riga qui sotto
// prevedeva. Bagno, pranzo e merenda sono diventati selettivi come la nanna, e con
// il filtro «azzera e risalva» non cancella più niente: la riga resta in archivio
// mentre a schermo i contatori sono a zero e il toast è verde. Per il bagno è
// peggio che per la nanna, perché la riga sbagliata NON è vuota — porta
// `{pipi:2}` — quindi nemmeno il filtro di lettura la rende inerte, e il genitore
// continua a leggere «Ho fatto pipì 2 volte» del figlio di un altro.
//
// L'elenco vive in `@/lib/diary/registrazione` (`TIPI_ELIMINABILI`), insieme a
// quello dei tipi selettivi: sono due facce della stessa decisione e separarle
// significherebbe, un domani, renderne uno selettivo e dimenticare la porta.
// `attivita` è entrata insieme alla sua regola selettiva; `umore` il 2026-09-28,
// quando le routine hanno cominciato a spegnersi per sede (la ragione è scritta lì).
//
// L'enum si tiene comunque QUI, esplicito e letterale: il gate di una rotta che
// cancella non si legge da una costante importata.
//
// NESSUNA NOTIFICA AL GENITORE, e non è una comodità: il diario ha un buffer di
// visibilità di 10 minuti (vedi il ramo genitore della GET). Una correzione fatta
// subito — il caso reale — il genitore non l'ha mai vista, e avvisarlo significherebbe
// raccontargli un errore che non ha letto.
// ─────────────────────────────────────────────────────────────────────────────────

const deleteQuerySchema = z.object({
    scuola_id: zUuid.optional(),
    sectionId: zUuid.optional(),
    versioniAttese: z.preprocess(v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { logEvento('registro', 'warn', { operazione: 'storici/valida-versioni', esito: 'versioni-client-non-valide' }); return null } }, z.record(z.string(), z.number().int().nonnegative()).optional()),
    alunno_id: zUuid,
    // Nanna, bagno e pasti: vedi «perimetro stretto» qui sopra. Deve restare
    // allineato a `TIPI_ELIMINABILI` — c'è un lock che lo verifica.
    // Più le routine aggiunte dalla scuola (2026-09-28): `routine:` + gli 8 caratteri dell'id, e
    // nient'altro — il prefisso non è una porta per stringhe libere. Anche per una routine spenta
    // o cancellata: correggere uno sbaglio non dipende da quello.
    tipo_evento: z.union([
        z.enum(['nanna_inizio', 'nanna_fine', 'bagno', 'pranzo', 'merenda', 'attivita', 'umore']),
        z.string().regex(TIPO_ROUTINE_RE),
    ]),
    // Default dinamico (oggi), calcolato nel codice come fa la GET.
    date: zDataYMD.optional(),
});

export const DELETE = withRoute('diary/entries:DELETE', async (request: NextRequest) => {
    // IL GATE PRIMA DI TUTTO, parametri compresi.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, deleteQuerySchema);
    if ('response' in q) return q.response;

    const admin = await createAdminClient();

    const date = q.data.date ?? oggiRoma();
    let contestoStorico: { scuola_id: string; sezioni: Map<string, string> } | null = null;
    if (eRettificaStorica(auth.user, date)) {
        const contesto = await contestoStoricoDiario(admin, auth.user, request, date, q.data.scuola_id, [q.data.alunno_id], q.data.sectionId);
        if ('response' in contesto) return contesto.response;
        contestoStorico = contesto;
    } else {
        const scopeErr = await assertAlunnoInScope(admin, auth.user, q.data.alunno_id);
        if (scopeErr) return scopeErr;
    }

    const { startOfDay, endOfDay } = intervalloGiornoRoma(date);

    // Si legge PRIMA di cancellare: è l'unico momento in cui il valore di prima
    // esiste ancora, ed è ciò che l'audit deve conservare. Con `nota_bambino`
    // dentro: sta sulla stessa riga e sparisce con lei.
    const { data: prima, error: erroreLettura } = await admin
        .from('eventi_diario')
        .select('*')
        .eq('alunno_id', q.data.alunno_id)
        .eq('tipo_evento', q.data.tipo_evento)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay);

    if (erroreLettura) {
        // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo si
        // cancellerebbe alla cieca, e l'audit direbbe «niente c'era prima».
        logErrore({ operazione: 'diary/entries:DELETE', stato: 500, evento: 'diary' }, erroreLettura);
        return NextResponse.json({ error: 'Lettura non riuscita', codice: 'DIARIO_LETTURA_FALLITA' }, { status: 500 });
    }

    const righe = prima ?? [];
    if (righe.length === 0) {
        // Cancellare ciò che non c'è è il risultato voluto, non un errore: un 404
        // farebbe comparire un avviso alla maestra che tocca due volte il cestino.
        return NextResponse.json({ eliminati: 0 });
    }

    let error: unknown = null;
    if (eRettificaStorica(auth.user, date)) {
        if (righe.some(r => r.storico_versione === undefined)) return storicoIndisponibile();
        if (!contestoStorico) return storicoIndisponibile();
        const rettifica = await applicaRettificaStorica(admin, { attore: auth.user, scuolaId: contestoStorico.scuola_id, alunnoId: q.data.alunno_id, sectionId: contestoStorico.sezioni.get(q.data.alunno_id), modulo: 'diario', giorno: date,
            attese: righe.map(r => ({ tabella: 'eventi_diario', filtro: { id: r.id }, versione: q.data.versioniAttese?.[String(r.id)] })),
            azioni: righe.map(r => ({ tabella: 'eventi_diario', operazione: 'delete', filtro: { id: r.id } })) });
        if ('response' in rettifica) return rettifica.response;
    } else {
        const esito = await admin.from('eventi_diario').delete().in('id', righe.map(r => r.id)).eq('alunno_id', q.data.alunno_id).eq('tipo_evento', q.data.tipo_evento).gte('orario_inizio', startOfDay).lte('orario_inizio', endOfDay);
        error = esito.error;
    }

    if (error) {
        logErrore({ operazione: 'diary/entries:DELETE', stato: 500, evento: 'diary' }, error);
        return NextResponse.json({ error: 'Cancellazione non riuscita', codice: 'DIARIO_NON_ELIMINATO' }, { status: 500 });
    }

    const { data: al, error: erroreContesto } = contestoStorico ? { data: { scuola_id: contestoStorico.scuola_id, section_id: contestoStorico.sezioni.get(q.data.alunno_id) }, error: null } : await admin
        .from('alunni')
        .select('section_id, scuola_id')
        .eq('id', q.data.alunno_id)
        .maybeSingle();

    if (erroreContesto) logErrore({ operazione: 'diary/entries:DELETE', evento: 'db' }, erroreContesto);

    // `entitaId` = il BAMBINO (2026-09-28): il valore di prima porta la sua nota e il testo delle
    // routine, e l'oblio GDPR ritrova le righe d'audit per `entita_id`. Senza, restavano per sempre.
    await logScrittura(admin, {
        attore: auth.user, entitaTipo: 'diario', entitaId: q.data.alunno_id, azione: 'delete',
        scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null,
        valorePrima: righe, valoreDopo: null,
    });
    if (al?.section_id) {
        await notificaTitolariScrittura(admin, { attore: auth.user, sectionId: al.section_id, scuolaId: al.scuola_id, area: 'diario' });
    }
    if (eRettificaStorica(auth.user, date)) {
        await ritiraDiarioGenitori(admin, { alunnoId: q.data.alunno_id, giorno: date, storico: true });
    }

    logEvento('diary', 'info', { operazione: 'diary/entries:DELETE', esito: 'diario-eliminato', data: date, n: righe.length });
    return NextResponse.json({ eliminati: righe.length });
});
