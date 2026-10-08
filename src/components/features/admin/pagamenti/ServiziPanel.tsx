'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AlertTriangle, Repeat } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { GeneraServiziMese } from './GeneraServiziMese';
import { ServizioScheda } from './ServizioScheda';
import { caricaServizi, type DatiServizi } from './servizi-client';
import type { EsitoMostrato } from './use-scrittura-servizi';
import { avvisoErrore, avvisoOk, btnSecondario } from './servizi-stili';

interface Props { userId: string; scuolaId: string }

type Stato = { fase: 'caricamento' } | { fase: 'errore'; testo: string } | { fase: 'pronto'; dati: DatiServizi };

/** Scheda «Servizi» della Contabilità: i servizi mensili, le iscrizioni e la generazione delle voci. */
export function ServiziPanel({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const [stato, setStato] = useState<Stato>({ fase: 'caricamento' });
    const [esito, setEsito] = useState<EsitoMostrato | null>(null);
    // Si ricarica cambiando questo numero: l'effetto riparte e rilegge.
    const [lettura, setLettura] = useState(0);

    useEffect(() => {
        let vivo = true;
        void caricaServizi(userId, scuolaId).then((r) => {
            if (!vivo) return;
            setStato('errore' in r ? { fase: 'errore', testo: r.errore } : { fase: 'pronto', dati: r.dati });
        });
        return () => { vivo = false; };
    }, [userId, scuolaId, lettura]);

    const ricarica = useCallback(() => setLettura((n) => n + 1), []);
    const riprova = () => { setStato({ fase: 'caricamento' }); ricarica(); };

    const dati = stato.fase === 'pronto' ? stato.dati : null;
    const pronti = dati && !dati.non_disponibile ? dati : null;
    const impostazioni = userId ? `/admin/impostazioni?userId=${userId}` : '/admin/impostazioni';

    return (
        <div className="space-y-4">
            <SectionTitle icon={Repeat} title={t('servTitolo')} sub={t('servSottotitolo')} />

            {/* Le regioni dell'esito stanno SEMPRE nel DOM (un'area live nata col testo non si annuncia)
                e subito sotto il titolo: dove si guarda dopo aver premuto un bottone della scheda. */}
            <div role="alert" className={esito?.tipo === 'errore' ? avvisoErrore : undefined}>
                {esito?.tipo === 'errore' && (<>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{esito.testo}</span>
                </>)}
            </div>
            <p role="status" className={esito?.tipo === 'ok' ? avvisoOk : undefined}>{esito?.tipo === 'ok' ? esito.testo : ''}</p>

            {stato.fase === 'caricamento' && <p role="status" className="font-maven text-sm text-kidville-sub">{t('servCaricamento')}</p>}

            {stato.fase === 'errore' && (
                <div role="alert" className={avvisoErrore}>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{stato.testo || t('servErroreCaricamento')}</span>
                    <button type="button" onClick={riprova} className={btnSecondario}>{t('servRiprova')}</button>
                </div>
            )}

            {dati?.non_disponibile && <p role="status" className="font-maven text-sm text-kidville-sub">{t('servNonDisponibile')}</p>}

            {pronti && pronti.servizi.length === 0 && (
                <div role="status" className="font-maven text-sm text-kidville-sub">
                    <p>{t('servNessunServizio')}</p>
                    <Link href={impostazioni} className="mt-2 inline-block font-bold text-kidville-green underline">{t('servVaiImpostazioni')}</Link>
                </div>
            )}

            {pronti && pronti.servizi.length > 0 && (
                <>
                    {pronti.servizi.map((s) => (
                        <ServizioScheda key={s.id} userId={userId} scuolaId={scuolaId} servizio={s}
                            iscrizioni={pronti.iscrizioni.filter((i) => i.categoria_id === s.id)}
                            onEsito={setEsito} onScritto={ricarica} onNuovaAzione={() => setEsito(null)} />
                    ))}
                    <GeneraServiziMese userId={userId} scuolaId={scuolaId} />
                </>
            )}

        </div>
    );
}
