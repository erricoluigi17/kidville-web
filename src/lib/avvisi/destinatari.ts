/**
 * L'etichetta di un destinatario di avviso — la coda dell'audit multi-sede.
 *
 * `avvisi.target_classes` è un `text[]` ETEROGENEO: il modulo «Nuovo avviso» ci
 * scrive i NOMI delle sezioni, ma in produzione esistono record che ci hanno
 * messo l'ID (verificato il 2026-08-01: 2 avvisi su 10, entrambi con
 * l'identificativo della sezione «TEST Infanzia»). Finché il plesso era uno le
 * due forme erano equivalenti — il nome della classe era di fatto una chiave.
 * Con tre sedi «2 ANNI» esiste ad Aversa E a Cesa: il nome non identifica più
 * niente, e chi LEGGE quel campo deve saper leggere entrambe le forme.
 *
 * Il difetto che questa funzione chiude (collaudo iOS del 2026-07-31, F4): la
 * bacheca del docente stampava le voci tali e quali, cioè un uuid dove ci si
 * aspetta una classe. Il cockpit invece risolveva: due letture diverse dello
 * stesso dato, ed è sempre la lettura più povera quella che finisce sotto gli
 * occhi di chi non può correggerla.
 *
 * Le regole, in ordine:
 *  1. **l'ID vince sul nome** — è l'identità vera; il nome è un'etichetta;
 *  2. la sede si aggiunge SOLO quando è deducibile senza ambiguità: se lo stesso
 *     nome esiste in due plessi, attribuirlo a uno dei due sarebbe indovinare,
 *     cioè l'errore che questo audit sta chiudendo;
 *  3. una voce che ha la FORMA di un uuid e non si risolve **non si stampa**:
 *     `risolta: false`, e il chiamante mette un'etichetta neutra tradotta. Un
 *     uuid a schermo non è un'informazione per un genitore, è una fuga di
 *     dettaglio interno;
 *  4. un nome storico che non è più in elenco resta leggibile: «Girasoli» dice
 *     qualcosa, nasconderlo toglierebbe informazione senza aggiungere niente.
 *
 * La funzione è PURA e senza traduzioni di proposito: la stringa di ripiego
 * appartiene al catalogo del componente che la mostra, non a questa libreria.
 */

/**
 * Una classe conosciuta dal chiamante.
 *
 * Strutturalmente compatibile con `ClasseAvviso` (`AvvisoForm`) e con le righe
 * di `/api/admin/sections/scoped` e `/api/educator-sections`: si passa quello
 * che si ha già, senza conversioni e senza import incrociati fra componenti.
 */
export interface ClasseNota {
    id: string;
    nome: string;
    scuolaId?: string | null;
    scuolaNome?: string | null;
}

/**
 * L'esito della risoluzione.
 *
 * Discriminata di proposito: `{ risolta: false }` NON porta nessun testo, così
 * è impossibile stampare per sbaglio la voce grezza credendo di stampare
 * un'etichetta. Il chiamante è costretto a scegliere una parola sua.
 */
export type EtichettaDestinatario =
    | { risolta: true; testo: string }
    | { risolta: false };

/** Riconosce una voce che è in realtà un identificativo di sezione. */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vero quando fra le classi note c'è più di una sede: allora il plesso va detto. */
function piuSedi(classi: readonly ClasseNota[]): boolean {
    return new Set(classi.map((c) => c.scuolaId).filter(Boolean)).size > 1;
}

/** Nome della classe, con la sede accanto solo se le sedi in gioco sono più d'una. */
function conSede(classe: ClasseNota, mostraSede: boolean): string {
    return mostraSede && classe.scuolaNome ? `${classe.nome} — ${classe.scuolaNome}` : classe.nome;
}

/**
 * L'etichetta leggibile di una voce di `target_classes`.
 *
 * @param voce   il valore archiviato: un id di sezione o un nome di classe
 * @param classi le classi note al chiamante (vuoto = nessuna fonte, es. genitore)
 */
export function etichettaDestinatario(
    voce: string,
    classi: readonly ClasseNota[],
): EtichettaDestinatario {
    const v = voce.trim();
    if (v === '') return { risolta: false };

    const mostraSede = piuSedi(classi);

    // 1. Identità: ha la precedenza sul nome, sempre.
    const perId = classi.find((c) => c.id === v);
    if (perId) return { risolta: true, testo: conSede(perId, mostraSede) };

    // 2. Nome: la sede si dice solo se una sola classe porta quel nome.
    const omonime = classi.filter((c) => c.nome === v);
    if (omonime.length === 1) return { risolta: true, testo: conSede(omonime[0], mostraSede) };
    if (omonime.length > 1) return { risolta: true, testo: v };

    // 3. Nessuna corrispondenza: un uuid non si mostra, un nome sì.
    return UUID_RX.test(v) ? { risolta: false } : { risolta: true, testo: v };
}
