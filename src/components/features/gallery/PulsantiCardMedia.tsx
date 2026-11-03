'use client';

import { useTranslations } from 'next-intl';
import { Download, Loader2, Share2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AzioniMedia, MediaAzionabile } from '@/components/features/media/useAzioniMedia';

interface Props {
    /** Il media della card, con l'indirizzo firmato (senza non si arriva qui: la card non li mostra). */
    media: MediaAzionabile;
    /**
     * Le azioni, come le consegna `useAzioniMedia` a `MediaGrid`: UNA sola istanza per tutta la griglia
     * e per il visore, perché la guardia «un'azione alla volta» è una per superficie (due card diverse
     * non devono poter scaricare insieme: su iOS un secondo foglio di condivisione, mentre il primo è
     * aperto, solleva). Vedi `ComandiMedia`, che fa lo stesso nel visore.
     */
    azioni: AzioniMedia;
    /** «Condividi» compare solo col genitore (`showActions`) e solo se il dispositivo sa condividere un FILE. */
    conCondividi: boolean;
}

type Comando = 'scarica' | 'condividi';

const CLASSI_PULSANTE =
    'h-9 w-9 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line';

/**
 * I DUE PULSANTI DELLA CARD DI FOTO — Scarica e (col genitore) Condividi.
 *
 * Con «Condividi = il file» la preparazione non è più istantanea: sul web c'è un `fetch` e nell'app
 * una copia in cache; per un video sono parecchi secondi. Su una card che resta identica per tutto
 * quel tempo il pulsante sembra rotto, che è il difetto da cui nasce questo lavoro. Quindi, MENTRE
 * LA SUA AZIONE LAVORA, il pulsante scambia l'icona con uno spinner, dichiara `aria-busy="true"` e
 * dice «Preparo…» a chi non vede (`sr-only`: il pulsante è un'icona di 36 px, il testo non ci sta).
 * Il `title` non cambia.
 *
 * ─── SENZA `disabled`, E NON È UNA DIMENTICANZA ─────────────────────────────────────────────
 * Il pulsante resta premibile e il click non viene ignorato: il secondo tocco arriva alla guardia
 * di `useAzioniMedia`, che lo scarta e lo LOGGA (`gallery-scarico-gia-in-corso`, un nome già
 * contato in `app_log`). Un pulsante spento lo renderebbe invisibile ai log, e il test della
 * griglia che preme due volte lo stesso pulsante lo vieta. Il visore ha invece lo stato spento
 * (`ComandiMedia`): lì il pulsante è uno solo per tipo e ha il testo.
 *
 * ─── LO STATO È QUI, NON NELL'HOOK E NON IN `MediaGrid` ─────────────────────────────────────
 * Ogni card ha il proprio (`useState`), così la griglia — fino a 40 card — non si ridisegna a ogni
 * pressione e le altre card non si accorgono di niente. Un `ref` tiene «sto lavorando» per il
 * secondo tocco: quel tocco va comunque alla guardia, ma NON deve toccare lo stato, altrimenti il
 * suo `finally` spegnerebbe l'indicatore della prima azione, che sta ancora lavorando.
 *
 * ─── IL CONTENITORE: SEMPRE VISIBILE, E C'È SCRITTO ─────────────────────────────────────────
 * Qui c'erano `opacity-0 group-hover:opacity-100 md:group-hover:opacity-100` e, sullo stesso
 * elemento, uno `style={{ opacity: 1 }}` inline. Lo stile inline VINCE su qualunque classe: le
 * tre classi erano codice morto, e l'unico posto dove si leggeva l'intenzione era il commento
 * dentro l'oggetto di stile. Su touch l'hover non esiste, quindi la scelta è giusta — ma va
 * dichiarata dove un lettore la cerca.
 *
 * I bottoni passano da 28 a 36 px: 28 è sotto il minimo di WCAG 2.5.8 (24 px) solo di poco e ben
 * sotto i 44 di Apple, e sono due bersagli a 6 px di distanza in un angolo da 170 px.
 */
export function PulsantiCardMedia({ media, azioni, conCondividi }: Props) {
    const t = useTranslations('shared');
    const [alLavoro, setAlLavoro] = useState<Comando | null>(null);
    const inCorso = useRef(false);

    const esegui = async (comando: Comando) => {
        const azione = comando === 'scarica' ? azioni.scarica : azioni.condividi;
        if (inCorso.current) {
            // Il secondo tocco: alla guardia, che lo scarta e lo logga. Lo stato non si tocca.
            await azione(media);
            return;
        }
        inCorso.current = true;
        setAlLavoro(comando);
        try {
            // Le azioni dell'hook non lanciano; se una lo facesse, il `finally` ripristina il
            // pulsante e l'errore resta una rejection non gestita, che il logger client registra.
            await azione(media);
        } finally {
            inCorso.current = false;
            setAlLavoro(null);
        }
    };

    /** L'icona, o — mentre la SUA azione lavora — lo spinner con il testo per chi non vede. */
    const contenuto = (comando: Comando, icona: React.ReactNode) =>
        alLavoro === comando ? (
            <>
                <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                <span className="sr-only">{t('mediaInPreparazione')}</span>
            </>
        ) : icona;

    return (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10 pointer-events-auto">
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    void esegui('scarica');
                }}
                aria-busy={alLavoro === 'scarica' ? true : undefined}
                className={CLASSI_PULSANTE}
                title={t('mediaScarica')}
            >
                {contenuto('scarica', <Download size={14} strokeWidth={2.5} />)}
            </button>
            {/* Condividi resta del GENITORE (`showActions`): a docenti e Segreteria la spec dà il
                solo «Scarica». E c'è solo se il dispositivo sa condividere un FILE: sul web senza
                `navigator.canShare` resta «Scarica», perché un «Condividi» che manda un link da 10
                minuti è il difetto che si toglie. */}
            {conCondividi && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        void esegui('condividi');
                    }}
                    aria-busy={alLavoro === 'condividi' ? true : undefined}
                    className={CLASSI_PULSANTE}
                    title={t('mediaCondividi')}
                >
                    {contenuto('condividi', <Share2 size={14} strokeWidth={2.5} />)}
                </button>
            )}
        </div>
    );
}
