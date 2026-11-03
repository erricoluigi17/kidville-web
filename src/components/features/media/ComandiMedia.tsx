'use client';

import { useTranslations } from 'next-intl';
import { Download, Loader2, Share2 } from 'lucide-react';
import { useState } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { AzioniMedia, MediaAzionabile } from '@/components/features/media/useAzioniMedia';

export interface ComandiMediaProps {
    /** Il media aperto nel visore. Con `url` vuota (firma non riuscita) i due pulsanti non ci sono. */
    media: MediaAzionabile;
    /**
     * Le azioni, COME LE CONSEGNA `useAzioniMedia` a chi sta sopra: non se le crea questo
     * componente. È una decisione, non una comodità: la guardia «un'azione alla volta» è UNA per
     * superficie, e in Foto la condividono le card della griglia e il visore — due card (o una
     * card e il visore) che creassero ciascuna la propria potrebbero scaricare insieme. Chi usa
     * il visore chiama `useAzioniMedia({ etichetta })` UNA volta, e ne passa il risultato qui e
     * alle sue eventuali card. L'etichetta dei log sta quindi lì, e non fra le props di questa riga.
     */
    azioni: AzioniMedia;
    /** «Scarica» compare (se il media ha un indirizzo). */
    conScarica: boolean;
    /** «Condividi» compare — solo se anche `azioni.puoCondividere`: sul web senza condivisione di file non c'è. */
    conCondividi: boolean;
    /**
     * SOSTITUISCE lo scarico dell'hook (`azioni.scarica`): serve alla supervisione della chat, che
     * prima deve farsi registrare lo scarico dal server e poi scaricare con l'indirizzo che riceve.
     * Chi lo passa può comunque finire con `azioni.scarica({ ...media, url: nuovoUrl })`, e così
     * ereditare guardia, avvisi e log dell'hook.
     *
     * Il doppio tocco lo ferma LO STATO DEL PULSANTE (spento finché la promessa non si risolve),
     * non la guardia dell'hook, che qui non passa. Deve gestire da sé i propri errori; se lancia,
     * il pulsante si ripristina e la riga `media-comando-lanciato` finisce in `app_log`.
     */
    onScarica?: (m: MediaAzionabile) => Promise<void>;
    /** Dopo Scarica e Condividi, nella stessa riga: «Segnala» in Foto. */
    extra?: React.ReactNode;
}

type Comando = 'scarica' | 'condividi';

/**
 * LA RIGA «SCARICA / CONDIVIDI» DEL VISORE — la stessa in Foto e in chat.
 *
 * ─── LO STATO «AL LAVORO» È DEL PULSANTE ────────────────────────────────────────────────────
 * Mentre un'azione lavora (il file si prepara: sul web un `fetch`, nell'app una copia in cache e
 * il foglio di sistema; per un video parecchi secondi), il SUO pulsante è spento (`disabled`),
 * dichiara `aria-busy="true"` e dice «Preparo…». Lo stato sta qui e non nell'hook di proposito:
 * nell'hook ridisegnerebbe la griglia di Foto (fino a 40 card) a ogni pressione.
 *
 * L'ALTRO pulsante si spegne anch'esso, senza `aria-busy` e senza cambiare testo: la guardia
 * dell'hook lo scarterebbe comunque, e un pulsante premibile che non fa niente (e non dice
 * perché) è il difetto da cui nasce tutto questo lavoro.
 *
 * ⚠️ LA CARD DI FOTO HA LO STESSO SEGNALE MA NON LO STESSO STATO (`PulsantiCardMedia`): spinner e
 * `aria-busy` mentre la sua azione lavora, però SENZA `disabled`. Le sue due icone restano premibili
 * e il secondo tocco arriva alla guardia, che lo scarta e lo logga (`gallery-scarico-gia-in-corso`,
 * un nome già contato in `app_log` che i test della griglia fissano).
 *
 * Ritorna `null` quando non c'è niente da mostrare, così chi lo usa non ha una riga vuota (con il
 * suo margine) in mezzo al visore.
 */
export function ComandiMedia({ media, azioni, conScarica, conCondividi, onScarica, extra }: ComandiMediaProps) {
    const t = useTranslations('shared');
    const [alLavoro, setAlLavoro] = useState<Comando | null>(null);

    const azionabile = media.url !== '';
    const mostraScarica = conScarica && azionabile;
    const mostraCondividi = conCondividi && azioni.puoCondividere && azionabile;

    if (!mostraScarica && !mostraCondividi && !extra) return null;

    const esegui = async (comando: Comando) => {
        setAlLavoro(comando);
        try {
            if (comando === 'scarica') await (onScarica ?? azioni.scarica)(media);
            else await azioni.condividi(media);
        } catch (e) {
            // Le azioni dell'hook non lanciano; un `onScarica` di chi usa il visore potrebbe. Non si
            // lascia il pulsante incagliato su «Preparo…» e non si perde l'errore: si logga, solo
            // il NOME della classe (mai il testo, che può riecheggiare un indirizzo firmato).
            // ⚠️ Il nome sta nel `messaggio` e NON in un campo `errore`: quella chiave non è fra
            // `CHIAVI_IN_CHIARO` di `redact.ts`, e lato server uscirebbe `[redatto:str/N]` — cioè
            // l'unica informazione del log, illeggibile. Come fanno gli altri chiamanti.
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `media-comando-lanciato: ${nomeErrore(e)}`,
                campi: { operazione: comando },
            });
        } finally {
            setAlLavoro(null);
        }
    };

    const occupato = alLavoro !== null;

    return (
        <div data-testid="visore-comandi" className="flex flex-wrap items-center justify-center gap-2 mt-4">
            {mostraScarica && (
                <button
                    type="button"
                    onClick={() => { void esegui('scarica'); }}
                    disabled={occupato}
                    aria-busy={alLavoro === 'scarica' ? true : undefined}
                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green hover:bg-kidville-green/90 text-white rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm disabled:opacity-55 disabled:cursor-default"
                >
                    {alLavoro === 'scarica'
                        ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                        : <Download size={14} strokeWidth={2.5} />}
                    {alLavoro === 'scarica' ? t('mediaInPreparazione') : t('mediaScarica')}
                </button>
            )}
            {mostraCondividi && (
                <button
                    type="button"
                    onClick={() => { void esegui('condividi'); }}
                    disabled={occupato}
                    aria-busy={alLavoro === 'condividi' ? true : undefined}
                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-yellow hover:bg-kidville-yellow/90 text-kidville-green rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm disabled:opacity-55 disabled:cursor-default"
                >
                    {alLavoro === 'condividi'
                        ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                        : <Share2 size={14} strokeWidth={2.5} />}
                    {alLavoro === 'condividi' ? t('mediaInPreparazione') : t('mediaCondividi')}
                </button>
            )}
            {extra}
        </div>
    );
}
