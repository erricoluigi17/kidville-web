import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { leggiModuleConfig } from '@/lib/settings/module-config';
import { logEvento, logErrore } from '@/lib/logging/logger';
import {
    TIPI_BASE,
    ROUTINE_DI_TIPO,
    routineBaseAttive,
    routinePersonalizzate,
    idDiTipo,
    valoreRoutineValido,
    dettagliRoutine,
    type TipoBase,
} from '@/lib/diary/routine';

/**
 * LE ROUTINE VALGONO ANCHE PER CHI SCRIVE (2026-09-28) — il controllo di `POST /api/diary/entries`.
 *
 * Il filtro dei bottoni vive nel client, e un client si può non aggiornare: il 2026-09-08 un tablet
 * con l'app aperta dal mattino ha scritto 17 righe di bagno vuote due ore dopo un rilascio. Qui,
 * per ogni voce, con la configurazione della SEDE DEL BAMBINO:
 *  · tipo base di una routine spenta → rifiuto `ROUTINE_SPENTA`;
 *  · `routine:<id>` che la sede non ha, o ha spento → rifiuto `ROUTINE_NON_DISPONIBILE`. Vale anche
 *    per un `routine:…` con un id malformato: il prefisso è riservato, non un tipo libero;
 *  · valore non valido per la routine → rifiuto `ROUTINE_VALORE_NON_VALIDO`;
 *  · altrimenti la voce passa, e per le routine della scuola i `dettagli` li riscrive il SERVER:
 *    fotografia della definizione più il valore. Quello che il client dice di sé non conta.
 *
 * Tutto-o-niente, come gli orari delle attività: un rifiuto e non si scrive nessuna riga del lotto.
 * I tipi che non sono di nessuna routine (`entrata`, storici) passano come prima: il server non
 * inventa filtri su ciò che non conosce.
 *
 * CONFIGURAZIONE ILLEGGIBILE: le routine BASE passano (fail-open, com'era prima di oggi: meglio una
 * voce in più che un diario che non si salva); quelle della SCUOLA no, perché senza la definizione
 * non c'è niente da scrivere — rifiuto `ROUTINE_NON_VERIFICATE` (503).
 */

const PREFISSO = 'routine:';

type CodiceRifiuto = 'ROUTINE_SPENTA' | 'ROUTINE_NON_DISPONIBILE' | 'ROUTINE_VALORE_NON_VALIDO' | 'ROUTINE_NON_VERIFICATE';

const MESSAGGI: Record<CodiceRifiuto, string> = {
    ROUTINE_SPENTA: 'Questa routine è spenta nelle impostazioni della sede: nessuna registrazione è stata salvata.',
    ROUTINE_NON_DISPONIBILE: 'Questa routine non è disponibile per la sede del bambino: nessuna registrazione è stata salvata.',
    ROUTINE_VALORE_NON_VALIDO: 'Il valore segnato non vale per questa routine: nessuna registrazione è stata salvata.',
    ROUTINE_NON_VERIFICATE: 'Non è stato possibile verificare le routine della sede: nessuna registrazione è stata salvata.',
};

interface VoceDiario { alunno_id: string; tipo_evento: string; dettagli?: unknown }

function eTipoBase(tipo: string): tipo is TipoBase {
    return (TIPI_BASE as readonly string[]).includes(tipo);
}

/** Il rifiuto, con la sua riga di log: codice e conteggi, mai nomi, valori o id di bambini. */
function rifiuta(codice: CodiceRifiuto, nRicevute: number, nRifiutate: number): { response: NextResponse } {
    logEvento('diary', 'warn', {
        operazione: 'diary/entries:POST',
        esito: 'routine-rifiutata',
        error_code: codice,
        n_ricevute: nRicevute,
        n_rifiutate: nRifiutate,
    });
    // Un ramo per codice, con il codice LETTERALE: il lock `errori-con-codice` deve poterli leggere.
    switch (codice) {
        case 'ROUTINE_SPENTA':
            return { response: NextResponse.json({ error: MESSAGGI.ROUTINE_SPENTA, codice: 'ROUTINE_SPENTA' }, { status: 422 }) };
        case 'ROUTINE_NON_DISPONIBILE':
            return { response: NextResponse.json({ error: MESSAGGI.ROUTINE_NON_DISPONIBILE, codice: 'ROUTINE_NON_DISPONIBILE' }, { status: 422 }) };
        case 'ROUTINE_VALORE_NON_VALIDO':
            return { response: NextResponse.json({ error: MESSAGGI.ROUTINE_VALORE_NON_VALIDO, codice: 'ROUTINE_VALORE_NON_VALIDO' }, { status: 422 }) };
        case 'ROUTINE_NON_VERIFICATE':
            return { response: NextResponse.json({ error: MESSAGGI.ROUTINE_NON_VERIFICATE, codice: 'ROUTINE_NON_VERIFICATE' }, { status: 503 }) };
    }
}

/**
 * Applica le routine della sede a un lotto di voci. `{ voci }` = da scrivere così (le routine della
 * scuola con i `dettagli` riscritti); `{ response }` = rifiuto, già loggato.
 */
export async function applicaRoutineAlLotto<T extends VoceDiario>(
    admin: SupabaseClient,
    entries: T[],
): Promise<{ voci: T[] } | { response: NextResponse }> {
    const toccate = entries.filter((e) => eTipoBase(e.tipo_evento) || e.tipo_evento.startsWith(PREFISSO));
    if (toccate.length === 0) return { voci: entries };

    // La sede di ogni bambino: le routine sono della SUA sede, non di chi scrive.
    const ids = [...new Set(toccate.map((e) => e.alunno_id))];
    const { data: alunni, error } = await admin.from('alunni').select('id, scuola_id').in('id', ids);
    if (error) {
        logErrore({ operazione: 'diary/entries:POST', evento: 'db', stato: 503 }, error);
        return rifiuta('ROUTINE_NON_VERIFICATE', entries.length, toccate.length);
    }
    const sedeDi = new Map<string, string | null>(
        ((alunni ?? []) as Array<{ id: string; scuola_id: string | null }>).map((a) => [a.id, a.scuola_id ?? null]),
    );

    // Una lettura per sede (di solito una sola). `null` = configurazione illeggibile.
    const configDi = new Map<string, Record<string, unknown> | null>();
    for (const sede of new Set([...sedeDi.values()].filter((s): s is string => Boolean(s)))) {
        const esito = await leggiModuleConfig<Record<string, unknown>>(admin, 'diario_config', sede);
        configDi.set(sede, esito.ok ? (esito.config as Record<string, unknown>) : null);
    }

    const rifiuti: CodiceRifiuto[] = [];
    const voci = entries.map((e) => {
        if (!toccate.includes(e)) return e;
        const sede = sedeDi.get(e.alunno_id) ?? null;
        // Un bambino senza sede non ha impostazioni: valgono le routine predefinite.
        const cfg = sede ? configDi.get(sede) : {};

        if (eTipoBase(e.tipo_evento)) {
            if (cfg === null || cfg === undefined) return e; // illeggibile: fail-open sulle routine base
            if (!routineBaseAttive(cfg.routine_attive).has(ROUTINE_DI_TIPO[e.tipo_evento])) rifiuti.push('ROUTINE_SPENTA');
            return e;
        }

        if (cfg === null || cfg === undefined) {
            rifiuti.push('ROUTINE_NON_VERIFICATE');
            return e;
        }
        const id = idDiTipo(e.tipo_evento);
        const def = id ? routinePersonalizzate(cfg.routine_personalizzate).find((r) => r.id === id && r.attiva) : undefined;
        if (!def) {
            rifiuti.push('ROUTINE_NON_DISPONIBILE');
            return e;
        }
        const grezzo = e.dettagli && typeof e.dettagli === 'object' ? (e.dettagli as Record<string, unknown>).valore : undefined;
        // Il testo si salva senza spazi ai bordi; tutto spazi vale «niente».
        const valore = typeof grezzo === 'string' && def.risposta === 'testo' ? (grezzo.trim() || null) : (grezzo ?? null);
        if (valore !== null && !valoreRoutineValido(def, valore)) {
            rifiuti.push('ROUTINE_VALORE_NON_VALIDO');
            return e;
        }
        return { ...e, dettagli: dettagliRoutine(def, valore) };
    });

    if (rifiuti.length > 0) return rifiuta(rifiuti[0], entries.length, rifiuti.length);
    return { voci };
}
