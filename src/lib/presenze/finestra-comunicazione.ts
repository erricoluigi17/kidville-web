/**
 * LA FINESTRA IN CUI UN'ASSENZA SI PUÒ COMUNICARE — da oggi, e non oltre il tetto.
 *
 * ─── PERCHÉ ESISTE UN MODULO PER UN NUMERO E DUE CONFRONTI ──────────────────
 * Perché la stessa regola era scritta in tre posti e in due di questi era
 * incompleta, e il collaudo del 2026-08-08 l'ha misurato:
 *
 *   · la route (`parent/presenze/comunica-assenza`) impone ENTRAMBI i confini —
 *     `data < oggi` → 400 `ASSENZA_DATA_PASSATA`, `data > oggi+60` → 400
 *     `ASSENZA_DATA_TROPPO_LONTANA`;
 *   · `/parent/attendance` conosceva SOLO il pavimento, scritto a mano
 *     (`if (data < today)`);
 *   · `ComunicaAssenzaCard` non conosceva nessuno dei due: `min` sul campo e
 *     basta — e su iOS il selettore nativo `min` non lo rispetta. Misurato: con
 *     `2026-01-15` forzata nel campo, «POST partiti: 1». La richiesta usciva dal
 *     dispositivo per farsi rifiutare, consumando il tetto di frequenza.
 *
 * Il tetto superiore non era MAI arrivato all'interfaccia, su nessuna delle due
 * schermate: il calendario nativo offriva qualunque giorno futuro e l'aiuto
 * persistente diceva «puoi indicare oggi o un giorno futuro», che oltre il
 * sessantesimo giorno è falso. Il genitore sceglieva una data che il calendario
 * gli proponeva e scopriva dal rifiuto che non era ammessa.
 *
 * Una regola valida per tre strade vive in un posto solo. Qui.
 *
 * ⚠️ LA COPIA NELLA ROUTE — perché per ora ce ne sono due. `route.ts` continua a
 * dichiarare il proprio `GIORNI_MASSIMI_IN_ANTICIPO`: quel file non è di questo
 * intervento e importarlo da qui è la mossa giusta, ma va fatta da chi tocca la
 * route. Finché le copie sono due, a tenerle uguali è un lock che LEGGE il
 * sorgente della route e confronta il numero
 * (`__tests__/pages/assenze-quarto-collaudo.test.tsx`, §Q28) — la stessa forma
 * con cui `assenze-rifiniture-secondo-collaudo` tiene i «dodici mesi»
 * dell'informativa allineati a `v_mesi` della migrazione. Un lock non è come
 * avere un solo numero, ma è l'unico modo di non averne due che divergono.
 */

import { finestraAnnuncioAperta } from '@/lib/presenze/finestra-trascorsa';

/**
 * Quanti giorni in anticipo si può comunicare un'assenza.
 *
 * Il valore è quello che la route applica (`route.ts`). Non è un limite di
 * calendario ma un numero di GIORNI: nessun caso di bordo a fine anno
 * scolastico, nessun fuso da sbagliare. Oltre il tetto la strada esiste e ha un
 * nome: la segreteria.
 */
export const GIORNI_MASSIMI_IN_ANTICIPO = 60;

/**
 * L'ultimo giorno comunicabile, a partire da «oggi» in `YYYY-MM-DD`.
 *
 * Aritmetica di calendario in UTC e basta: `Date.UTC` somma i giorni senza mai
 * consultare il fuso del processo, e il risultato torna in `YYYY-MM-DD`. Il fuso
 * lo ha già deciso `oggiFiscaleISO()` una volta sola, a monte — sommare giorni a
 * una data locale sarebbe il modo di sbagliarlo una seconda volta. È la stessa
 * funzione, riga per riga, che la route usa per il proprio confronto.
 */
export function ultimoGiornoComunicabile(oggi: string): string {
  const [anno, mese, giorno] = oggi.split('-').map(Number);
  return new Date(Date.UTC(anno, mese - 1, giorno + GIORNI_MASSIMI_IN_ANTICIPO))
    .toISOString()
    .slice(0, 10);
}

/** I due codici con cui il server rifiuta un giorno fuori finestra. */
export type RifiutoGiorno = 'ASSENZA_DATA_PASSATA' | 'ASSENZA_DATA_TROPPO_LONTANA';

/**
 * Il giorno scelto è fuori finestra? E da quale parte?
 *
 * Restituisce il CODICE del rifiuto, non una frase: la frase la sceglie chi
 * chiama, dal catalogo condiviso con il server (`CODICI_ERRORE`), così le due
 * schermate e la route dicono al genitore le stesse identiche parole. E i due
 * codici sono diversi di proposito: `ASSENZA_DATA_PASSATA` rimanda alla
 * giustifica, che per un giorno ancora da venire sarebbe l'indicazione sbagliata.
 *
 * Confronto lessicografico su `YYYY-MM-DD`: due stringhe a lunghezza fissa e
 * zero-padded ordinano come le date che rappresentano, e non c'è nessun `Date`
 * da costruire — cioè nessun fuso da sbagliare una seconda volta.
 *
 * Un giorno VUOTO non è «fuori finestra»: è un campo non compilato, e lo dice
 * un'altra riga (il comando è spento e la sua descrizione spiega perché).
 */
export function rifiutoDelGiorno(giorno: string, oggi: string): RifiutoGiorno | null {
  if (!giorno) return null;
  // Il PAVIMENTO è la stessa soglia della scadenza dell'annuncio: un giorno
  // concluso non si comunica più, non si ritira più (`comunica-assenza:DELETE`)
  // e non è più un annuncio ma un fatto del registro (R15). Una soglia sola, in
  // un posto solo: `finestraAnnuncioAperta`.
  if (!finestraAnnuncioAperta(giorno, oggi)) return 'ASSENZA_DATA_PASSATA';
  if (giorno > ultimoGiornoComunicabile(oggi)) return 'ASSENZA_DATA_TROPPO_LONTANA';
  return null;
}
