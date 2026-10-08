'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { aMeseInput, meseCorrente } from './servizi-client';
import { BottonePrimarioServizi } from './BottonePrimarioServizi';
import { avvisoErrore, btnSecondario, campo, etichetta } from './servizi-stili';

interface Props {
    modo: 'termina' | 'elimina';
    nome: string;
    /** Primo mese dell'iscrizione ('YYYY-MM-01'): l'ultimo mese non può precederlo. */
    dal: string;
    /** Ultimo mese attuale ('YYYY-MM-01') o null: «Termina» può accorciare, mai allungare. */
    al: string | null;
    invio: boolean;
    errore: string;
    /** `ultimoMese` ('YYYY-MM') c'è solo per «termina». */
    onConferma: (ultimoMese?: string) => void;
    onAnnulla: () => void;
}

/** Conferma esplicita di «Termina» (chiede l'ultimo mese) e di «Elimina». */
export function ConfermaIscrizioneServizio({ modo, nome, dal, al, invio, errore, onConferma, onAnnulla }: Props) {
    const t = useTranslations('adminContabilita');
    const id = useId();
    const dalMese = aMeseInput(dal);
    const corrente = meseCorrente();
    const alMese = al ? aMeseInput(al) : null;
    // Il mese corrente, ma mai dopo la fine attuale e mai prima dell'inizio.
    const proposto = alMese !== null && corrente > alMese ? alMese : corrente;
    const [ultimo, setUltimo] = useState(proposto < dalMese ? dalMese : proposto);
    const [erroreLocale, setErroreLocale] = useState('');
    const titolo = modo === 'termina' ? t('servTerminaTitolo', { nome }) : t('servEliminaTitolo', { nome });

    const conferma = () => {
        if (modo === 'elimina') { onConferma(); return; }
        if (!/^\d{4}-\d{2}$/.test(ultimo)) { setErroreLocale(t('servErrDal')); return; }
        if (ultimo < dalMese) { setErroreLocale(t('servErrAlPrimaDiDal')); return; }
        if (alMese !== null && ultimo > alMese) { setErroreLocale(t('servErrFineOltreAttuale')); return; }
        setErroreLocale('');
        onConferma(ultimo);
    };
    const messaggio = erroreLocale || errore;
    return (
        <Modal open onClose={invio ? () => {} : onAnnulla} title={titolo} labelledBy={`${id}-titolo`} closeOnBackdrop={false}
            className="w-full max-w-md rounded-card bg-kidville-white p-5 shadow-xl">
            <h3 id={`${id}-titolo`} className="font-barlow text-lg font-extrabold text-kidville-green">{titolo}</h3>
            {modo === 'termina' ? (
                <div className="mt-3">
                    <label htmlFor={`${id}-ultimo`} className={etichetta}>{t('servUltimoMese')}</label>
                    <input id={`${id}-ultimo`} type="month" value={ultimo} onChange={(e) => setUltimo(e.target.value)} className={campo} />
                </div>
            ) : (
                <p className="mt-3 font-maven text-sm text-kidville-ink">{t('servEliminaAvviso')}</p>
            )}
            <div role="alert" className={messaggio ? avvisoErrore : undefined}>
                {messaggio && (<>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{messaggio}</span>
                </>)}
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onAnnulla} disabled={invio} className={btnSecondario}>{t('servAnnulla')}</button>
                <BottonePrimarioServizi onClick={conferma} disabled={invio}>
                    {modo === 'termina' ? t('servTerminaConferma') : t('servEliminaConferma')}
                </BottonePrimarioServizi>
            </div>
        </Modal>
    );
}
