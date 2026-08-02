import type { SVGProps } from 'react';

/**
 * L'UNICO glifo che rappresenta una SEDE (plesso) in tutta l'app.
 *
 * PERCHÉ ESISTE. Il collaudo del 2026-07-31 ha trovato TRE icone diverse per lo
 * stesso concetto nelle superfici toccate dal lavoro multi-sede: un SVG «scuola»
 * fatto in casa nel selettore della topbar, `Building2` sulle card delle sezioni,
 * `MapPin` nelle Impostazioni e nell'Oblio. Tre glifi per il dato su cui ruota
 * l'intero audit di isolamento: chi impara che «la sede è il pin» non riconosce
 * la sede quando diventa un edificio due schermate dopo.
 *
 * La forma scelta è quella del selettore di sede — il punto di riferimento, dove
 * l'utente incontra il concetto per la prima volta.
 *
 * È DECORATIVA. `aria-hidden` di default: il nome della sede è sempre scritto
 * accanto in testo vero, e un'icona che si annuncia raddoppierebbe l'annuncio.
 * `MapPin` resta legittimo dove significa «indirizzo / mappa» (il wizard pubblico
 * di pre-iscrizione), non «sede».
 */
export function SedeIcon({ size = 18, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...rest}
        >
            <path d="M14 22v-4a2 2 0 0 0-4 0v4" />
            <path d="m18 10 4 2v10H2V12l4-2" />
            <path d="M18 5v17" />
            <path d="m4 6 8-4 8 4" />
            <path d="M6 5v17" />
            <circle cx="12" cy="9" r="2" />
        </svg>
    );
}
