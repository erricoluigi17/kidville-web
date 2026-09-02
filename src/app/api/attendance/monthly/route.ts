import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { COLONNE_SORGENTE, eFattoDelRegistro } from '@/lib/presenze/finestra-trascorsa';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { meseCivile } from '@/i18n/config';

export interface MonthlyAttendanceRecord {
    student_id: string;
    student_nome: string;
    student_cognome: string;
    section_name: string | null;
    date: string; // YYYY-MM-DD
    stato: 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
    orario_entrata: string | null;
    orario_uscita: string | null;
    /**
     * La riga afferma un FATTO del registro, e quindi si conta.
     *
     * ─── PERCHÉ NON SI CHIAMA PIÙ `futura` (Q4) ──────────────────────────────
     *
     * Si chiamava così, e il nome nascondeva metà del problema. `futura` è vero
     * solo per i giorni non ancora arrivati, ma il caso che fa danno è OGGI:
     * un'assenza che il genitore ha comunicato per il giorno corrente ha
     * `data = oggi`, quindi `futura` era `false`, quindi il prospetto — e il PDF
     * esportabile — la sommavano alle «A» e alle ORE prima che il docente avesse
     * fatto l'appello. Un nome che descrive il rimedio invece della regola porta
     * il lettore successivo a non ricontrollare.
     *
     * Il calendario continua a MOSTRARE tutte le righe — è il motivo per cui il
     * genitore le comunica — ma i CONTEGGI (presenze/assenze/ritardi/uscite,
     * monte ore, PDF) contano solo quelle marcate `true`.
     *
     * La marca la mette il SERVER e non il browser: l'orologio di un tablet può
     * essere sbagliato o su un altro fuso, e due dispositivi conterebbero
     * diversamente lo stesso registro. La regola sta in
     * `@/lib/presenze/finestra-trascorsa`, in un posto solo.
     */
    fattoDelRegistro: boolean;
}

/**
 * GET /api/attendance/monthly?year=2026&month=5&sezione=<classe>
 *
 * Strategia: due query separate (no join PostgREST) per massima compatibilità
 * con lo schema anche senza FK riconosciuta dalla schema cache.
 */

/** Intero da query string con la semantica storica di parseInt ('' → NaN → 400). */
const zIntParseInt = (inner: z.ZodNumber) =>
    z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), inner);

const getQuerySchema = z.object({
    // default dinamici (anno/mese correnti) calcolati nell'handler
    year: zIntParseInt(z.number().int()).optional(),
    month: zIntParseInt(z.number().int().min(1).max(12)).optional(),
    // Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
    sezione: z.string().default(''),
    // L'identità VERA della classe. Il nome resta accettato (shell native già
    // installate, URL salvati) ma porta allo stesso filtro per uuid.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
});

export const GET = withRoute('attendance/monthly:GET', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;

        // Il mese di default è quello ITALIANO, non quello del processo: su
        // Vercel gira in UTC, e fra mezzanotte e le due del primo del mese il
        // registro delle presenze si sarebbe aperto sul mese SBAGLIATO — con la
        // maestra che vede un mese vuoto e ricomincia a segnare da capo.
        const [annoCorrente, meseCorrente] = meseCivile().split('-').map(Number);
        const year  = q.data.year  ?? annoCorrente;
        const month = q.data.month ?? meseCorrente;
        const sezione = q.data.sezione;

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay   = new Date(year, month, 0).getDate();
        const endDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const supabase = await createAdminClient();

        // Contratto storico: senza sezione la risposta è vuota, non un 400.
        if (!sezione && !q.data.sectionId) {
            return NextResponse.json([], { status: 200, headers: { 'Cache-Control': 'no-store' } });
        }

        // Isolamento per tenant (finora ASSENTE su questa route): la stessa
        // `classe_sezione` può esistere in più sedi, quindi senza filtro il
        // prospetto mensile perdeva presenze cross-sede. Rispetta anche la
        // selezione del SedeSelector (cookie `sedi_attive`).
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);
        if (plessi.length === 0) {
            return NextResponse.json([], { status: 200, headers: { 'Cache-Control': 'no-store' } });
        }

        // GATE per SEZIONE ASSEGNATA (R108): `requireDocente` verifica il RUOLO,
        // non la classe. Senza questo un educator otteneva il prospetto presenze
        // del mese di qualunque classe del proprio plesso, comprese quelle non
        // sue. Admin/coordinator/segreteria non sono toccati (vedono il plesso).
        // Il gate passava e il prospetto usciva vuoto lo stesso: la query sotto
        // filtrava per NOME, e il nome può divergere da `sections.name`.
        const classe = await risolviSezione(supabase, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
        if (classe.response) return classe.response;
        if (classe.sectionIds.length === 0) {
            return NextResponse.json([], { status: 200, headers: { 'Cache-Control': 'no-store' } });
        }

        // ── Query 1: alunni della sezione (entro le sedi attive) ───────────────
        const { data: alunniData, error: alunniError } = await supabase
            .from('alunni')
            .select('id, nome, cognome, classe_sezione')
            .in('section_id', classe.sectionIds)
            .in('scuola_id', plessi);

        if (alunniError) {
            // L'oggetto errore si PASSA, non si riassume: `JSON.stringify` su un Error nativo
            // restituisce `{}` — è il bug che questo modulo esiste per togliere di mezzo.
            // IL `message` DI POSTGREST NON ESCE DA QUI. È prosa inglese con
            // dentro nomi di colonne e di vincoli: una mappa dello schema
            // consegnata a chiunque superi `requireDocente`. La regola è già
            // dichiarata dalla rotta gemella («il `message` di PostgREST NON esce
            // verso il client», `comunica-assenza`) e valeva per una sola delle
            // due. Il messaggio non si perde: sta intero nel `logErrore` qui
            // sopra, che è dove dice PERCHÉ.
            logErrore({ operazione: 'attendance/monthly:GET', stato: 500, evento: 'db' }, alunniError);
            return NextResponse.json({ error: 'Errore recupero alunni.' }, { status: 500 });
        }

        if (!alunniData || alunniData.length === 0) {
            return NextResponse.json([], { status: 200, headers: { 'Cache-Control': 'no-store' } });
        }

        const alunniIds = alunniData.map(a => a.id);
        const alunniMap: Record<string, { nome: string; cognome: string; classe_sezione: string | null }> = {};
        alunniData.forEach(a => { alunniMap[a.id] = a; });

        // ── Query 2: presenze del mese per questi alunni ───────────────────────
        const { data: presenzeData, error: presenzeError } = await supabase
            .from('presenze')
            // Le colonne della PROVENIENZA servono alla marca `fattoDelRegistro`:
            // sul giorno corrente la data non discrimina l'assenza annunciata dal
            // genitore dall'appello del docente.
            .select(`id, alunno_id, data, orario_entrata, orario_uscita, ${COLONNE_SORGENTE}`)
            .in('alunno_id', alunniIds)
            .gte('data', startDate)
            .lte('data', endDate)
            .order('data', { ascending: true });

        if (presenzeError) {
            logErrore({ operazione: 'attendance/monthly:GET', stato: 500, evento: 'db' }, presenzeError);
            return NextResponse.json({ error: 'Errore recupero presenze.' }, { status: 500 });
        }

        // ── Join manuale ───────────────────────────────────────────────────────
        // `oggi` si calcola UNA volta per tutta la risposta: due righe della
        // stessa lettura non possono cadere in due giorni diversi perché la
        // mezzanotte è passata a metà `map`.
        const oggi = oggiFiscaleISO();
        const records: MonthlyAttendanceRecord[] = (presenzeData ?? []).map(row => {
            const alunno = alunniMap[row.alunno_id];
            return {
                student_id:       row.alunno_id,
                student_nome:     alunno?.nome     ?? '—',
                student_cognome:  alunno?.cognome  ?? '—',
                section_name:     alunno?.classe_sezione ?? null,
                date:             row.data,
                stato:            row.stato as MonthlyAttendanceRecord['stato'],
                orario_entrata:   row.orario_entrata,
                orario_uscita:    row.orario_uscita,
                fattoDelRegistro: eFattoDelRegistro(row, oggi),
            };
        });

        return NextResponse.json(records, {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
        });

    } catch (err) {
        logErrore({ operazione: 'attendance/monthly:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });
    }
});
