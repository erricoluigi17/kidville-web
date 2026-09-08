/**
 * «✨ APPLICA A TUTTE» — LA REGOLA, IN UN POSTO SOLO.
 *
 * Il gesto serve, e serve davvero: con 37 foto da pubblicare, taggare una per
 * una è la strada che porta a non taggare affatto. Ma fino al 2026-09-08
 * copiava i tag della foto attiva su TUTTE le altre e lo diceva DOPO, con un
 * `alert` che non si poteva annullare.
 *
 * Misurato in produzione: il 6 settembre 37 foto caricate in tre minuti hanno
 * tutte la stessa impronta di tag — gli stessi 2 bambini su ognuna, entrambi
 * con la liberatoria (quindi non è il lucchetto privacy). Le famiglie degli
 * altri bambini non hanno visto niente; quelle due hanno ricevuto tutte le 37.
 *
 * LA REGOLA NUOVA: di norma si riempiono solo le foto ANCORA DA CONFIGURARE.
 * Sostituire il lavoro già fatto resta possibile — a volte è proprio quello che
 * si vuole — ma diventa una scelta esplicita, presa sapendo quante foto si
 * stanno sovrascrivendo, PRIMA di toccarle.
 *
 * Perché sta qui e non dentro la pagina: la pagina la usa, ma il test che
 * conta è su questa funzione. Una regola che vive dentro un `onClick` si prova
 * solo montando mezza applicazione, e infatti non era provata affatto.
 */

/** Il minimo che serve per decidere: il resto della foto non ci riguarda. */
export type FotoDaTaggare = {
    tag_students: string[];
    is_broadcast: boolean;
};

/**
 * Una foto è CONFIGURATA quando qualcuno ha già detto a chi va: ha dei tag,
 * oppure è dichiarata broadcast.
 *
 * Il broadcast conta, e non è un dettaglio: `is_broadcast` porta
 * `tag_students: []`, quindi guardando i soli tag sembrerebbe una foto vuota —
 * e sovrascriverla le cambierebbe la destinazione in silenzio.
 */
function configurata(f: FotoDaTaggare): boolean {
    return f.is_broadcast || f.tag_students.length > 0;
}

/**
 * Quante foto (esclusa l'attiva) PERDEREBBERO la propria configurazione se si
 * sovrascrivesse tutto. È il numero da mostrare nella domanda: «stai per
 * sostituire i tag di N foto».
 */
export function fotoGiaConfigurate(files: readonly FotoDaTaggare[], attiva: number): number {
    return files.filter((f, i) => i !== attiva && configurata(f)).length;
}

/** Quante foto (esclusa l'attiva) verrebbero riempite senza sovrascrivere niente. */
export function fotoDaConfigurare(files: readonly FotoDaTaggare[], attiva: number): number {
    return files.filter((f, i) => i !== attiva && !configurata(f)).length;
}

/**
 * Applica la destinazione della foto attiva alle altre.
 *
 * Senza `sovrascrivi`, tocca SOLO le foto ancora da configurare: è il
 * comportamento normale, quello che non può far perdere niente.
 */
export function applicaTagATutte<T extends FotoDaTaggare>(
    files: readonly T[],
    attiva: number,
    opts?: { sovrascrivi?: boolean },
): T[] {
    const sorgente = files[attiva];
    // Indice fuori range (elenco svuotato mentre la domanda era aperta): si
    // restituisce l'elenco com'è. Copiare `undefined` addosso a tutte le foto
    // le lascerebbe senza destinazione e senza che nessuno l'abbia chiesto.
    if (!sorgente) return [...files];

    return files.map((f, i) => {
        if (i === attiva) return f;
        if (!opts?.sovrascrivi && configurata(f)) return f;
        return {
            ...f,
            // Copia dell'array, mai il riferimento: due foto che condividono lo
            // stesso array si modificano a vicenda al primo tocco successivo.
            tag_students: [...sorgente.tag_students],
            is_broadcast: sorgente.is_broadcast,
        };
    });
}
