import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAvvisoInScope } from '@/lib/auth/scope-avvisi';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseData, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { ETICHETTA_NUMERO_PREDEFINITA } from '@/lib/validation/avvisi';
import { alunniDelleRisposte, nomiGenitoriDelleRisposte } from '@/lib/avvisi/nomi-risposte';
import { csvDocumento } from '@/lib/export/csv';
import { APP_TIMEZONE, LOCALE_BCP47 } from '@/i18n/config';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// =============================================================================
// GET /api/avvisi/[id]/risposte/esporta — l'elenco delle adesioni in CSV.
//
// ── PERCHÉ UNA ROUTE SEPARATA E NON UN `?format=csv` SUL GET CHE C'È ────────
//
// Perché quel GET è `requireDocente`, che comprende l'`educator`, mentre
// l'esportazione è riservata alla segreteria. Un `if (ruolo === …)` dentro un
// handler gatato per un pubblico più largo è la forma «un gate dentro un ramo
// `if` non domina il ramo `else`»: basta un `return` spostato, o un secondo
// formato aggiunto sotto, e il file esce a chi non doveva averlo.
//
// E il file che esce contiene NOMI DI MINORI E DI GENITORI. Il suo gate deve
// leggersi in una riga, ed è la prima di questo handler.
//
// ── TRE QUERY, NON N+1 ─────────────────────────────────────────────────────
//
// Una su `avvisi_risposte`, una su `alunni` e una su `utenti`, entrambe a
// BLOCCHI (`ID_PER_QUERY`): `.in()` non viaggia nel corpo ma nell'URL, e mille
// uuid fanno ~38 kB di riga di richiesta, cioè un **414**.
//
// ⚠️ QUESTO PARAGRAFO DICEVA ANCHE «il GET accanto fa invece due letture per
// riga», e dal 2026-09-19 non è più vero: quel difetto è stato chiuso, e le due
// letture dei nomi vivono ORA NELLO STESSO MODULO (`@/lib/avvisi/nomi-risposte`)
// — che è il solo motivo per cui non possono ridivergere. Un commento che
// descrive la rotta accanto invecchia con lei: se torna a essere falso, è
// perché quel modulo ha smesso di essere condiviso, e allora è quello il
// problema.
// =============================================================================

interface RouteParams {
    params: Promise<{ id: string }>;
}

/**
 * Il `zod-coverage` pretende che ogni `route.ts` sotto `src/app/api/avvisi/`
 * validi i propri ingressi, e questa route un ingresso di query non ne ha —
 * l'avviso sta nel percorso. Lo schema resta comunque **chiuso** e non
 * decorativo: `strict()` rifiuta i parametri che nessuno legge, invece di
 * lasciar credere che un `?scuola_id=…` appeso all'URL faccia qualcosa.
 */
const getQuerySchema = z.object({}).strict();

/** Le colonne del file, nell'ordine in cui la segreteria le legge. */
const INTESTAZIONI_FISSE = ['Classe', 'Alunno', 'Genitore', 'Stato adesione', 'Risposta'] as const;

/**
 * Lo STATO in chiaro, ed è la colonna indispensabile.
 *
 * `numero_partecipanti` resta salvato anche dopo un ritiro (la funzione di
 * database conserva il dato e azzera solo lo stato): senza questa colonna una
 * famiglia ritirata comparirebbe con «4 persone» accanto e sembrerebbe
 * partecipante. Chi conta le sedie leggerebbe un numero sbagliato.
 */
const STATO_LEGGIBILE: Record<string, string> = {
    ammessa: 'Confermata',
    in_attesa: 'In lista d’attesa',
};

const RISPOSTA_LEGGIBILE: Record<string, string> = {
    si: 'Sì',
    no: 'No',
};

interface RigaRisposta {
    id: string;
    parent_id: string | null;
    student_id: string | null;
    risposta: string | null;
    risposto_il: string | null;
    numero_partecipanti: number | null;
    stato_adesione: string | null;
    in_coda_dal: string | null;
}

const NON_DISPONIBILE = () =>
    NextResponse.json(
        { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
        { status: 503 },
    );

export const GET = withRoute('avvisi/[id]/risposte/esporta:GET', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria']);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;

        const rawParams = await params;
        const pId = parseData(zUuid, rawParams.id);
        if ('response' in pId) return pId.response;
        const avvisoId = pId.data;

        const supabase = await createAdminClient();

        const fuoriScope = await assertAvvisoInScope(supabase, auth.user, avvisoId);
        if (fuoriScope) return fuoriScope;

        const { data: avviso, error: erroreAvviso } = await supabase
            .from('avvisi')
            .select('id, scuola_id, etichetta_numero')
            .eq('id', avvisoId)
            .maybeSingle();
        if (erroreAvviso) {
            logErrore({ operazione: 'avvisi/[id]/risposte/esporta:GET', stato: 503, evento: 'db' }, erroreAvviso);
            return NON_DISPONIBILE();
        }

        const { data: risposteRaw, error: erroreRisposte } = await supabase
            .from('avvisi_risposte')
            .select('id, parent_id, student_id, risposta, risposto_il, numero_partecipanti, stato_adesione, in_coda_dal')
            .eq('avviso_id', avvisoId);
        if (erroreRisposte) {
            logErrore({ operazione: 'avvisi/[id]/risposte/esporta:GET', stato: 503, evento: 'db' }, erroreRisposte);
            return NON_DISPONIBILE();
        }
        const risposte = (risposteRaw ?? []) as unknown as RigaRisposta[];

        // ── I nomi, in BLOCCO E NELLO STESSO POSTO DELL'ALTRA LETTURA ────────
        //
        // 🔴 Questa risoluzione stava scritta QUI e, in una seconda copia, dentro
        // `GET /api/avvisi/[id]/risposte` — la schermata su cui la segreteria
        // decide chi va in gita. Le due copie divergevano già: qui gli alunni si
        // filtravano per la sede dell'avviso, là no. Una riga che punta a un
        // minore di un altro plesso spariva da QUESTO file (con Classe e Alunno
        // vuote, e nessun log) e compariva su QUELLA schermata, col nome e
        // contata nel riepilogo. Stessa gita, due elenchi diversi, e nessuno dei
        // due che dicesse perché.
        //
        // Ora la regola vive in `@/lib/avvisi/nomi-risposte`: stesso filtro di
        // sede, stessa forma del nome, stessi `aBlocchi`/`ID_PER_QUERY` (`.in()`
        // non viaggia nel corpo ma nell'URL: mille uuid fanno ~38 kB di riga di
        // richiesta, cioè un **414**). La decisione sul filtro — perché resta, e
        // che cosa nasconde insieme a ciò che è anomalo — sta scritta per esteso
        // accanto al filtro stesso, in quel modulo.
        //
        // ⚠️ IL RIFIUTO RESTA DURO, e vale la pena dire che cosa è cambiato: il
        // codice di prima usciva al PRIMO blocco fallito, ora l'helper li prova
        // tutti e questa rotta rifiuta se ne è fallito almeno uno. La risposta è
        // la stessa (503, niente file); ciò che si guadagna è il conteggio vero
        // degli id rimasti fuori. Un file di adesioni a metà si stampa e si porta
        // in gita senza che nessuno sappia che è a metà: qui non si degrada.
        const alunni = await alunniDelleRisposte(supabase, risposte.map((r) => r.student_id), avviso?.scuola_id as string | null);
        const genitori = await nomiGenitoriDelleRisposte(supabase, risposte.map((r) => r.parent_id));
        for (const b of [...alunni.nonLetti, ...genitori.nonLetti]) {
            logErrore({ operazione: 'avvisi/[id]/risposte/esporta:GET', stato: 503, evento: 'db' }, b.error);
        }
        if (alunni.nonLetti.length > 0 || genitori.nonLetti.length > 0) return NON_DISPONIBILE();

        // ⚠️ IL NOME CHE MANCA NON DEVE ESSERE MUTO. Un id presente nella riga e
        // non risolto lascia DUE CELLE VUOTE in questo file, e fino a oggi non
        // lasciava nient'altro: «quel bambino non è più in anagrafica» e «quel
        // bambino è di un altro plesso» erano lo stesso vuoto, e nessuno dei due
        // si vedeva. Il `logErrore` qui sopra copre l'errore di QUERY, che è
        // un'altra cosa: lì la domanda è fallita, qui ha risposto «niente».
        if (alunni.nonRisolti > 0) {
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]/risposte/esporta:GET',
                esito: 'alunni-non-risolti',
                avviso: avvisoId,
                n: alunni.nonRisolti,
            });
        }
        const nomiAlunni = alunni.valori;
        const nomiGenitori = genitori.valori;

        // ── Le date ──────────────────────────────────────────────────────────
        // `Intl.DateTimeFormat` con fuso e regione DICHIARATI. Mai `toISOString()`
        // (è UTC: fra mezzanotte e le due stampa il giorno prima) e mai un
        // `toLocale*` nudo, che prende il locale dell'ambiente — su Vercel non è
        // quello di chi legge. I due lock sono `date-con-timezone` e `date-senza-fuso`.
        const formato = new Intl.DateTimeFormat(LOCALE_BCP47.it, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
            timeZone: APP_TIMEZONE,
        });
        const istante = (v: string | null): string => {
            if (!v) return '';
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? '' : formato.format(d);
        };

        const etichettaNumero = ((avviso?.etichetta_numero as string | null) ?? '').trim() || ETICHETTA_NUMERO_PREDEFINITA;

        const righe = risposte.map((r) => {
            const alunno = r.student_id ? nomiAlunni.get(r.student_id) : undefined;
            return [
                alunno?.classe ?? '',
                alunno?.nome ?? '',
                (r.parent_id ? nomiGenitori.get(r.parent_id) : '') ?? '',
                r.stato_adesione ? (STATO_LEGGIBILE[r.stato_adesione] ?? r.stato_adesione) : '',
                r.risposta ? (RISPOSTA_LEGGIBILE[r.risposta] ?? r.risposta) : '',
                r.numero_partecipanti ?? '',
                istante(r.risposto_il),
                istante(r.in_coda_dal),
            ];
        });

        const csv = csvDocumento(
            [...INTESTAZIONI_FISSE, etichettaNumero, 'Risposto il', 'In coda dal'],
            righe,
        );

        // Le PERSONE, non le adesioni: una famiglia da 4 ne occupa 4, e
        // `numero_partecipanti` nullo vale 1 (è il caso di tutte le righe
        // storiche). Conta solo chi è `ammessa`.
        const persone = risposte
            .filter((r) => r.stato_adesione === 'ammessa')
            .reduce((s, r) => s + (r.numero_partecipanti ?? 1), 0);

        // ⚠️ MAI PII NEI LOG: niente titolo dell'avviso, niente `etichetta_numero`
        // (testo libero della segreteria), niente nomi. Uuid, numeri, ruoli, esiti.
        logEvento('avvisi', 'info', {
            operazione: 'avvisi/[id]/risposte/esporta:GET',
            esito: 'export-csv',
            avviso: avvisoId,
            uid: auth.user.id,
            ruolo: auth.user.role ?? null,
            n_righe: righe.length,
            n_persone: persone,
            formato: 'csv',
        });

        // ⚠️ `azione: 'insert'` e non `'export'`, ed è una verifica non una scelta
        // di comodo: il vocabolario di `AzioneScrittura` (`src/lib/audit/scrittura.ts:18`)
        // è `'insert' | 'update' | 'delete'`, e `'export'` non c'è. Inventarlo qui
        // avrebbe rotto il tipo; aggiungerlo è una decisione che non appartiene a
        // questo lavoro. La convenzione del repo per gli export di dati personali
        // è già `entitaTipo: 'export_…'` + `azione: 'insert'` — la usano
        // `pagamenti/export`, `admin/merch/export` e `admin/protocolli/export`.
        // La domanda a cui si deve poter rispondere è «chi ha scaricato l'elenco
        // dei bambini e quando», e questa forma ci risponde.
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'export_avviso_risposte',
            entitaId: avvisoId,
            azione: 'insert',
            scuolaId: (avviso?.scuola_id as string | null) ?? null,
            valoreDopo: { formato: 'csv', n_righe: righe.length, n_persone: persone },
        });

        return new NextResponse(csv, {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="adesioni-${avvisoId}.csv"`,
                // È un elenco di minori: non deve finire in nessuna cache
                // condivisa, né in quella del browser di un computer di segreteria
                // usato da più persone.
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]/risposte/esporta:GET', stato: 500 }, error);
        return NextResponse.json(
            { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
            { status: 500 },
        );
    }
});
