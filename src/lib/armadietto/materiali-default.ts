/**
 * I materiali che l'armadietto traccia quando `locker_config` non ha righe.
 *
 * ⚠️ `locker_config` VUOTA NON È UN GUASTO. Decisione del titolare del 2026-09-01:
 * il modulo non è ancora in uso e i materiali li aggiungeranno le maestre man mano,
 * quindi la tabella resta a zero righe e questo è il listino che vale. Le soglie qui
 * sotto sono le soglie VERE del sistema finché la segreteria non ne scrive di proprie.
 *
 * Vive qui e non dentro una route perché lo leggono in tre: la route `materials`,
 * il motore delle richieste e il modale di carico. Tre copie della stessa lista è
 * esattamente come nasce il giorno in cui due schermate mostrano soglie diverse.
 */
export interface MaterialeSoglie {
    id: string;
    nome: string;
    icona: string;
    unita: string;
    livello_allerta: number;
    livello_emergenza: number;
    ordine: number;
    attivo: boolean;
}

export const MATERIALI_DEFAULT: readonly MaterialeSoglie[] = [
    { id: 'default-1', nome: 'Pannolini', icona: '🧷', unita: 'pz', livello_allerta: 5, livello_emergenza: 2, ordine: 1, attivo: true },
    { id: 'default-2', nome: 'Salviette', icona: '🧻', unita: 'pz', livello_allerta: 4, livello_emergenza: 2, ordine: 2, attivo: true },
    { id: 'default-3', nome: 'Crema',     icona: '🧴', unita: 'pz', livello_allerta: 3, livello_emergenza: 1, ordine: 3, attivo: true },
    { id: 'default-4', nome: 'Cambio',    icona: '👕', unita: 'pz', livello_allerta: 2, livello_emergenza: 1, ordine: 4, attivo: true },
];
