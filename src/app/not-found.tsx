'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { btnClass } from '@/components/ui/Btn';

/**
 * LA 404 DELL'APP. Prima di questo file non ne esisteva nessuna.
 *
 * ─── IL DIFETTO (collaudo del 2026-08-08, localizzazione Q14) ───────────────
 * Senza `not-found.tsx`, Next serve il proprio componente interno: «404 This
 * page could not be found.», una stringa INGLESE cablata nel framework, che non
 * passa da nessun catalogo. Misurato su `/parent/menu` con sessione italiana:
 * testo inglese dentro un documento che dichiara `lang="it"` — uno screen reader
 * lo pronuncia con la fonetica italiana. E con il cookie `KV_LOCALE=en` non
 * cambiava nulla, perché non c'era nessuna lingua da scegliere.
 *
 * Il difetto era invisibile a tutti gli strumenti: nessun test naviga su una
 * rotta inesistente, e la parità dei cataloghi confronta chiavi ESISTENTI —
 * non sa niente di una stringa che nei cataloghi non è mai entrata.
 *
 * ─── QUANDO SI VEDE ─────────────────────────────────────────────────────────
 * Due strade, e questa pagina le copre entrambe:
 *  · un URL che non corrisponde a nessuna rotta (`/parent/menu`);
 *  · una chiamata esplicita a `notFound()` dal codice — oggi
 *    `parent/forms/[id]` (un modulo che non esiste o non è del genitore) e
 *    `m/[token]` (un link pubblico scaduto). Sono i due casi in cui l'utente
 *    NON ha sbagliato a digitare: ha seguito un collegamento che non porta più
 *    da nessuna parte, ed è il motivo per cui il testo non lo accusa di niente.
 *
 * ─── LA VIA D'USCITA È `/`, NON UNA HOME CABLATA ────────────────────────────
 * `src/app/page.tsx` non è una landing: è l'INSTRADATORE che risolve la sessione
 * e manda ognuno alla home del proprio ruolo (genitore→/parent, docente→/teacher,
 * staff→/admin), e l'anonimo al login. Un link a `/parent` scritto qui sarebbe
 * giusto per una famiglia e sbagliato per tutti gli altri — e questa pagina la
 * vedono anche i visitatori del modulo pubblico, che una sessione non ce l'hanno.
 *
 * Component CLIENT come `error.tsx`, suo fratello: il `NextIntlClientProvider`
 * vive nel root layout, di cui la 404 è discendente, quindi il catalogo c'è.
 */
export default function NonTrovata() {
    const t = useTranslations('shared');

    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
            {/* Il numero non si traduce: «404» è lo stesso in ogni lingua, ed è
                il solo elemento che l'utente riconosce prima ancora di leggere.
                `aria-hidden` perché uno screen reader lo direbbe come una cifra
                nuda, senza contesto: il contesto è il titolo qui sotto.

                L'inchiostro è `yellow-strong` (#7A5C00) e NON `yellow-dark`:
                quest'ultimo è un colore di RIEMPIMENTO (l'hover del bottone
                secondario) e come testo su fascia chiara vale fra 1,61:1 e
                1,97:1 — sotto AA anche per il testo grande. `yellow-strong` è
                l'inchiostro giallo misurato per le fasce chiare: 6,25:1 su
                bianco, 5,63:1 su crema (vedi globals.css). */}
            <p
                aria-hidden="true"
                className="font-barlow text-[64px] font-black leading-none text-kidville-yellow-strong"
            >
                404
            </p>

            <h1 className="font-barlow text-[26px] font-black uppercase leading-none text-kidville-green">
                {t('paginaNonTrovataTitolo')}
            </h1>

            <p className="max-w-md font-maven text-sm leading-relaxed text-kidville-sub">
                {t('paginaNonTrovataCorpo')}
            </p>

            <Link href="/" className={btnClass('primary', 'md', 'mt-2')}>
                {t('paginaNonTrovataTornaHome')}
            </Link>
        </div>
    );
}
