'use client';

import { useTranslations } from 'next-intl';

/**
 * LA MINIATURA DI UNA FOTO DELLA CHAT — un comando, non più un'immagine nuda.
 *
 * Fino al 2026-11-03 era un `<img>` dentro un `div`: toccarla non faceva niente, e la foto
 * ritagliata a `max-h-48 object-cover` non si vedeva mai per intero né si poteva salvare. Ora è un
 * `<button>` vero: raggiungibile col Tab, attivabile con Invio e Spazio (li traduce il browser in un
 * clic, cosa che un `<div onClick>` non fa), con un nome che dice cosa succede al tocco.
 *
 * ─── L'IMMAGINE RESTA COM'ERA ────────────────────────────────────────────────────────────────
 * Stesse classi di prima (`w-full h-auto max-h-48 object-cover`) e stesso `alt`
 * (`attachmentAlt`): il tetto d'altezza con l'`object-fit` è ciò che il lock
 * `media-con-rapporto-daspetto` pretende da un'immagine a larghezza piena, e la bolla non cambia
 * forma di un pixel. Cambia solo l'involucro: le classi che prima stavano sul `div`
 * (`mb-2 rounded-xl overflow-hidden`) sono ora del pulsante, più `block w-full` perché un
 * `<button>` è `inline-block` e senza di loro la miniatura non riempirebbe la bolla.
 *
 * ─── IL FUOCO DA TASTIERA ────────────────────────────────────────────────────────────────────
 * Nessun `focus:outline-none`: l'anello lo disegna la regola globale `:focus-visible` di
 * `globals.css` (contorno verde da 2 px più alone bianco), che si vede sia sulla bolla bianca
 * (dell'interlocutore) sia su quella verde (la propria) — una classe `ring-*` qui non servirebbe a
 * niente, perché quella regola sta fuori dai layer e vince. Il nome accessibile è `aria-label`: con
 * l'`alt` dell'immagine («Allegato») il pulsante direbbe cosa c'è, non cosa fa.
 *
 * Chi la usa decide COSA si apre (`onApri`): in chat è il visore a tutto schermo
 * (`VisoreFotoChat`), e la stessa miniatura la usa la pagina Messaggi della segreteria.
 */
export function FotoAllegatoChat({ url, onApri }: { url: string; onApri: () => void }) {
    const t = useTranslations('parentChat');
    return (
        <button
            type="button"
            onClick={onApri}
            aria-label={t('chatApriFoto')}
            className="mb-2 block w-full cursor-pointer rounded-xl overflow-hidden"
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={t('attachmentAlt')} className="w-full h-auto max-h-48 object-cover" />
        </button>
    );
}
