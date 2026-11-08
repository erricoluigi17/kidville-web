import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { logScrittura } from '@/lib/audit/scrittura';
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi';
import { selectResiliente } from '@/lib/supabase/select-resiliente';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ============================================================
// GET /api/admin/students/export — l'anagrafica che «Genera Esportazione» scarica in Excel.
// ============================================================
//
// PERCHÉ STA SUL SERVER. `ImportExportClient` faceva `from('alunni').select('*')` dal browser: con
// una sessione quella lettura parte col token dell'utente, e su `alunni` l'unica policy è quella dei
// figli del genitore. Uno staff riceveva `[]` senza errore, e si scaricava un file vuoto come se
// fosse riuscito (prova: `__tests__/db/alunni-rls-export-staff.test.ts`). Una policy per lo staff
// non è la strada: `alunni` resta chiusa al browser, come ogni tabella di dati di minori.
//
// QUI LA RLS NON C'È, ed è il motivo delle tre righe che seguono: la service role la scavalca, quindi
// il ruolo lo dice `requireStaff`, la sede `resolveScuoleAttive`, le colonne `COLONNE`.

const OPERAZIONE = 'admin/students/export:GET';

// Il perimetro lo decidono la sessione e il selettore di sede: nessun parametro da leggere.
const getQuerySchema = z.object({});

/**
 * Anagrafica e posizione scolastica, e niente di più.
 *
 * NON ci sono, di proposito: `note_mediche`, `allergies`, `allergeni`, `is_bes_dsa`, `note_bes` (dati
 * sanitari di un minore, art. 9 GDPR), `documento_path`, rette e intestatari. Questo file finisce sul
 * computer di una segreteria e lì nessuno lo controlla più: è lo stesso ragionamento che ha tolto
 * quelle colonne dall'elenco di `GET /api/admin/students` (W8). Non essendo mai uscito niente da qui,
 * aprirle sarebbe una scelta nuova, che spetta al titolare e costa una riga.
 *
 * `id` in fondo: serve a `leggiABlocchi`, e a ritrovare la riga di un foglio usato come copia.
 */
const COLONNE = [
    'scuola_id', 'cognome', 'nome', 'data_nascita', 'codice_fiscale', 'gender', 'citizenship',
    'birth_nation', 'birth_province', 'birth_city', 'residence_address', 'residence_street_number',
    'residence_city', 'residence_province', 'zip_code', 'classe_sezione', 'stato', 'data_iscrizione',
    'id',
] as const;

type RigaAlunno = { scuola_id: string; id: string } & Record<string, unknown>;

/** Il foglio non esce: né intero né a metà. */
const nonLetta = () => NextResponse.json(
    { error: 'L’anagrafica non si è potuta leggere per intero.', codice: 'ANAGRAFICA_EXPORT_NON_LETTA' },
    { status: 500 },
);

/** Tutto o niente: un foglio a cui manca un pezzo, presentato come intero, è il difetto da non avere. */
function guastoLettura(esito: Extract<EsitoABlocchi<RigaAlunno>, { ok: false }>): NextResponse {
    if (esito.motivo === 'tetto') {
        logErrore(
            { operazione: OPERAZIONE, stato: 500, evento: 'lettura-troncata' },
            new Error(`${descriviTetto('export-anagrafica-alunni', esito)}, rifiutata per intero`),
        );
    } else {
        logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, esito.error);
    }
    return nonLetta();
}

export const GET = withRoute('admin/students/export:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    try {
        const supabase = await createAdminClient();

        // Il vuoto nega: nessun plesso, nessun elenco. Nei log solo uuid e ruolo.
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);
        if (plessi.length === 0) {
            logEvento('anagrafica', 'warn', {
                operazione: OPERAZIONE, esito: 'scope-vuoto', utente: auth.user.id, ruolo: auth.user.role,
            });
            return rifiutoSede('SEDE_NON_ACCESSIBILE');
        }

        // Su più plessi un uuid non dice di chi sono i bambini: la colonna porta il nome della sede.
        const { data: sedi, error: erroreSedi } = await supabase
            .from('schools')
            .select('id, nome')
            .in('id', plessi);
        if (erroreSedi) {
            logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, erroreSedi);
            return nonLetta();
        }
        const nomeSede = new Map((sedi ?? []).map((s) => [String(s.id), String(s.nome ?? '')]));

        // A blocchi perché `max_rows` taglia a 1000 senza dirlo. `selectResiliente` toglie la colonna
        // che il DB E2E della CI non ha ancora: legge il `42703` dall'`error` qui sotto e riparte.
        // Gli anonimizzati restano fuori come dalle due linguette: la loro riga non è più un bambino.
        // Nessun filtro di stato, di proposito: la schermata promette un backup, e chi non frequenta più
        // resta nel foglio con la sua colonna `stato` (deroga in `elenchi-operativi-solo-iscritti`).
        const letti = await selectResiliente(
            COLONNE,
            async (colonne) => {
                const esito = await leggiABlocchi<RigaAlunno>(() =>
                    supabase
                        .from('alunni')
                        .select(colonne.join(', '))
                        .in('scuola_id', plessi)
                        .is('anonimizzato_il', null)
                        .order('scuola_id', { ascending: true })
                        .order('cognome', { ascending: true })
                        .order('nome', { ascending: true }),
                );
                const error = !esito.ok && esito.motivo === 'errore'
                    ? (esito.error as { code?: string; message: string })
                    : null;
                return { esito, data: null, error };
            },
            OPERAZIONE,
            { livello: 'warn' },
        );
        if (!letti.esito.ok) return guastoLettura(letti.esito);

        const conteggi = new Map<string, number>();
        const righe = letti.esito.righe.map(({ scuola_id, ...resto }) => {
            conteggi.set(scuola_id, (conteggi.get(scuola_id) ?? 0) + 1);
            return { sede: nomeSede.get(scuola_id) ?? '', ...resto };
        });

        // «Chi ha scaricato l'elenco dei bambini e quando»: la convenzione degli export di dati
        // personali (`export_…` + `insert`), una riga per sede, DOPO la lettura: l'audit racconta un
        // elenco consegnato, non uno tentato. `logScrittura` non lancia mai.
        for (const plesso of plessi) {
            await logScrittura(supabase, {
                attore: auth.user,
                entitaTipo: 'export_anagrafica_alunni',
                azione: 'insert',
                scuolaId: plesso,
                valoreDopo: { formato: 'xlsx', n_righe: conteggi.get(plesso) ?? 0, plessi },
            });
        }

        logEvento('anagrafica', 'info', {
            operazione: OPERAZIONE, esito: 'export-consegnato',
            n: righe.length, sedi: plessi.length, utente: auth.user.id, ruolo: auth.user.role,
        });

        // È un elenco di minori: non deve restare in nessuna cache, né condivisa né del browser.
        return NextResponse.json({ righe }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (err) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, err);
        return nonLetta();
    }
});
