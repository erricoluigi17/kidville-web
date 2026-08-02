import type { createAdminClient } from '@/lib/supabase/server-client';

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>;

export type EsitoClassi =
    | { ok: true; mancanti: string[] }
    | { ok: false; errore: unknown };

/**
 * IL TARGET DI UN AVVISO SI VALIDA CONTRO LE SEZIONI DELLA SUA SEDE.
 *
 * `avvisi.target_classes` contiene NOMI di classe, e la consegna li confronta con
 * `alunni.classe_sezione` — che è un nome. Finché il plesso era uno, il nome era di
 * fatto una chiave e nessuno doveva pensarci. Dal 2026-07-29 le sedi sono tre:
 * «2 ANNI» esiste a Giugliano e ad Aversa, e un target non validato manda l'avviso
 * a una classe che sta in un altro plesso — oppure a niente.
 *
 * IL MODO IN CUI FALLISCE È IL PROBLEMA. Non c'è nessun errore: la riga si scrive,
 * la risposta è 2xx, l'operatore vede il successo. Il silenzio arriva dopo, dalla
 * parte delle famiglie, dove nessuno lo collega alla pubblicazione. In produzione
 * il 2026-08-01 due avvisi avevano in `target_classes` l'UUID della sezione invece
 * del nome: 10 alunni in quella sezione, 10 genitori agganciati, **0 raggiunti**.
 *
 * PERCHÉ STA QUI E NON DENTRO UNA ROUTE. Questa funzione è nata dentro
 * `POST /api/avvisi` il 2026-07-30 e **è rimasta lì**: quando il 1° agosto si è
 * andati a vedere perché quei due avvisi non arrivavano, si è scoperto che
 * `PUT /api/avvisi/[id]` non l'aveva mai avuta — aveva il gate di RUOLO e si
 * fermava lì, poi scriveva l'array grezzo. Chiudere la porta della creazione e
 * lasciare aperta quella della modifica non è mezza correzione: è nessuna
 * correzione, con l'aria di essere fatta. Una regola che vale per due strade deve
 * vivere in un posto solo, o la seconda strada resta indietro per sempre.
 */
export async function classiMancantiNellaSede(
    supabase: SupabaseAdmin,
    scuolaId: string,
    classi: string[],
): Promise<EsitoClassi> {
    const { data, error } = await supabase
        .from('sections')
        .select('name')
        .eq('scuola_id', scuolaId)
        .in('name', classi);
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe «nessuna classe trovata», cioè un 400 che accusa l'operatore
    // di un errore che non ha commesso.
    if (error) return { ok: false, errore: error };
    const presenti = new Set(
        (data ?? []).map((r) => String((r as { name?: unknown }).name ?? '')),
    );
    return { ok: true, mancanti: classi.filter((c) => !presenti.has(c)) };
}

/**
 * L'insieme dei nomi di classe da ARCHIVIARE, ricavato da ciò che manda il client.
 *
 * Si archivia questo, mai l'array grezzo: validare una lista e scriverne un'altra
 * rende il gate una formalità — duplicati, stringhe vuote e valori non testuali
 * entrerebbero senza essere mai stati confrontati con le sezioni della sede.
 */
export function classiTargetValide(target_classes: unknown): string[] {
    if (!Array.isArray(target_classes)) return [];
    return [
        ...new Set(
            (target_classes as unknown[])
                .filter((c): c is string => typeof c === 'string' && c.trim() !== ''),
        ),
    ];
}
