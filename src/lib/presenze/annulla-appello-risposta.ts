import { NextResponse } from 'next/server';
import it from '../../../messages/it/shared.json';
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch';
import type { EsitoAnnullaAppello } from '@/lib/presenze/annulla-appello';

/**
 * ─── LA RISPOSTA HTTP DELL'ANNULLAMENTO DELL'APPELLO, scritta UNA volta ─────────
 *
 * Due rotte annullano l'appello di un bambino con la stessa libreria
 * (`@/lib/presenze/annulla-appello`): `DELETE /api/attendance/daily` (nido e
 * infanzia) e `DELETE /api/primaria/appello`. Fino al giro 2 di A3 ciascuna
 * traduceva l'esito in HTTP per conto suo, con lo switch copiato riga per riga —
 * e le due copie divergevano già sul guasto: una rispondeva 500 CON codice,
 * l'altra senza. Stessa libreria, due contratti.
 *
 * Qui il contratto è uno solo: stato, `codice` e prosa per ogni esito. Alle rotte
 * restano solo le cose che sono loro — gate, scope, «solo oggi» e gli effetti
 * collaterali del ramo riuscito (per la primaria l'avviso al titolare).
 *
 * La prosa `error` viene dal catalogo ITALIANO, come in `rifiutoSede()`: è la
 * stessa frase che il client mostra traducendo il `codice`, quindi server e
 * catalogo non possono dire due cose diverse. Il `message` di PostgREST non
 * arriva mai qui: la libreria lo ha già loggato.
 */

const CATALOGO_IT = it as Record<string, string>;

/** 409 — l'appello si annulla solo nel giorno stesso, in data di Roma. */
export function rispostaAnnullaSoloOggi(): NextResponse {
    return NextResponse.json(
        { error: CATALOGO_IT[CODICI_ERRORE.APPELLO_ANNULLA_SOLO_OGGI], codice: 'APPELLO_ANNULLA_SOLO_OGGI' },
        { status: 409 },
    );
}

/**
 * 500 — guasto di lettura/scrittura, o eccezione imprevista nella rotta. Esportata
 * anche da sola perché il `catch` delle rotte risponda con lo STESSO codice del
 * guasto che la libreria riconosce.
 */
export function rispostaAppelloNonAnnullato(): NextResponse {
    return NextResponse.json(
        { error: CATALOGO_IT[CODICI_ERRORE.APPELLO_NON_ANNULLATO], codice: 'APPELLO_NON_ANNULLATO' },
        { status: 500 },
    );
}

export function rispostaAnnullaAppello(r: EsitoAnnullaAppello): NextResponse {
    switch (r.esito) {
        case 'errore':
            return rispostaAppelloNonAnnullato();
        case 'non-trovata':
            return NextResponse.json(
                { error: CATALOGO_IT[CODICI_ERRORE.PRESENZA_NON_TROVATA], codice: 'PRESENZA_NON_TROVATA' },
                { status: 404 },
            );
        case 'niente-da-annullare':
            return NextResponse.json(
                { error: CATALOGO_IT[CODICI_ERRORE.NIENTE_DA_ANNULLARE], codice: 'NIENTE_DA_ANNULLARE' },
                { status: 409 },
            );
        case 'cambiata-nel-frattempo':
            return NextResponse.json(
                {
                    error: CATALOGO_IT[CODICI_ERRORE.APPELLO_CAMBIATO_NEL_FRATTEMPO],
                    codice: 'APPELLO_CAMBIATO_NEL_FRATTEMPO',
                },
                { status: 409 },
            );
        case 'cancellata':
        case 'ripristinata-comunicazione':
            // La risposta si COMPONE: le sei colonne dell'appello, come POST e PATCH.
            // Mai motivo, firma o nota interna, anche se un giorno la libreria ne
            // leggesse di più.
            return NextResponse.json(
                {
                    success: true,
                    esito: r.esito,
                    presenza: r.presenza
                        ? {
                            id: r.presenza.id,
                            alunno_id: r.presenza.alunno_id,
                            data: r.presenza.data,
                            stato: r.presenza.stato,
                            orario_entrata: r.presenza.orario_entrata ?? null,
                            orario_uscita: r.presenza.orario_uscita ?? null,
                        }
                        : null,
                },
                { status: 200 },
            );
    }
}
