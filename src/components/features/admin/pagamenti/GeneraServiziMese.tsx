'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { zMese } from '@/lib/pagamenti/servizi-mensili';
import { PAGINA_SERVIZI, codiceSicuro, importoNumero, intestazioni, leggiCorpo, meseCorrente } from './servizi-client';
import { BottonePrimarioServizi } from './BottonePrimarioServizi';
import { avvisoErrore, avvisoOk, btnSecondario, campo, etichetta } from './servizi-stili';

interface Props { userId: string; scuolaId: string }

interface Anteprima {
    periodo: string;
    voci: number;
    totale?: number;
    per_servizio: { categoria_id: string; nome: string; voci: number; totale?: number }[];
}

const ROUTE = '/api/pagamenti/genera-servizi';

type Esito = { tipo: 'ok' | 'errore'; testo: string } | null;

/**
 * Anteprima e generazione delle voci dei servizi per un mese. Il `totale` si mostra solo se la
 * route lo manda (solo la Direzione): qui non si guarda il ruolo.
 */
export function GeneraServiziMese({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const id = useId();
    const [mese, setMese] = useState(meseCorrente());
    const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
    const [occupato, setOccupato] = useState(false);
    const [esito, setEsito] = useState<Esito>(null);

    // Legge l'anteprima di UN mese; l'errore si restituisce, non si scrive: chi chiama decide
    // se sovrascrive un esito (dopo una generazione riuscita, no).
    const leggiAnteprima = async (periodo: string): Promise<{ anteprima: Anteprima } | { errore: string }> => {
        const q = new URLSearchParams({ periodo, scuola_id: scuolaId });
        try {
            const res = await fetch(`${ROUTE}?${q.toString()}`, { headers: intestazioni(userId) });
            const corpo = await leggiCorpo(res, 'servizi-anteprima') as { data?: Anteprima } | null;
            if (!res.ok || !corpo?.data) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-anteprima-respinta${codiceSicuro(corpo)}`, route: PAGINA_SERVIZI, stato: res.status });
                return { errore: messaggioDaCorpo(corpo, t('servGenErroreAnteprima')) };
            }
            return { anteprima: corpo.data };
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-anteprima-non-riuscita: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
            return { errore: t('servGenErroreAnteprima') };
        }
    };

    const mostraAnteprima = async () => {
        if (!zMese.safeParse(mese).success) { setEsito({ tipo: 'errore', testo: t('servErrDal') }); return; }
        setOccupato(true);
        setEsito(null);
        const r = await leggiAnteprima(mese);
        if ('errore' in r) { setAnteprima(null); setEsito({ tipo: 'errore', testo: r.errore }); } else setAnteprima(r.anteprima);
        setOccupato(false);
    };

    // Si genera il mese dell'ANTEPRIMA vista, non quello che il campo dice adesso.
    const pronta = anteprima !== null && anteprima.periodo.slice(0, 7) === mese;

    const genera = async () => {
        if (!anteprima || !pronta) return;
        const periodo = anteprima.periodo.slice(0, 7);
        setOccupato(true);
        setEsito(null);
        try {
            const res = await fetch(ROUTE, { method: 'POST', headers: intestazioni(userId), body: JSON.stringify({ periodo, scuola_id: scuolaId }) });
            const corpo = await leggiCorpo(res, 'servizi-generazione') as { data?: { generati?: number } } | null;
            if (!res.ok) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-generazione-respinta${codiceSicuro(corpo)}`, route: PAGINA_SERVIZI, stato: res.status });
                setEsito({ tipo: 'errore', testo: messaggioDaCorpo(corpo, t('servGenErroreGenera')) });
            } else if (typeof corpo?.data?.generati !== 'number') {
                // 200 ma senza il numero (corpo illeggibile o inatteso): non si scrive «0 voci generate».
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'servizi-generazione-senza-esito', route: PAGINA_SERVIZI, stato: res.status });
                setEsito({ tipo: 'errore', testo: t('servGenErroreGenera') });
            } else {
                // Il successo resta a schermo anche se la rilettura dell'anteprima fallisce.
                setEsito({ tipo: 'ok', testo: t('servGenFatto', { n: corpo.data.generati }) });
                const r = await leggiAnteprima(periodo);
                setAnteprima('anteprima' in r ? r.anteprima : null);
            }
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-generazione-non-riuscita: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
            setEsito({ tipo: 'errore', testo: t('servGenErroreGenera') });
        }
        setOccupato(false);
    };

    return (
        <section aria-labelledby={`${id}-titolo`} className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-4">
            <h3 id={`${id}-titolo`} className="font-barlow text-lg font-extrabold text-kidville-green">{t('servGenTitolo')}</h3>
            <div className="mt-3 flex flex-wrap items-end gap-3">
                <div>
                    <label htmlFor={`${id}-mese`} className={etichetta}>{t('servGenMese')}</label>
                    <input id={`${id}-mese`} type="month" value={mese}
                        disabled={occupato} onChange={(e) => { setMese(e.target.value); setAnteprima(null); setEsito(null); }} className={`${campo} w-44`} />
                </div>
                <button type="button" onClick={() => { void mostraAnteprima(); }} disabled={occupato} className={btnSecondario}>{t('servGenAnteprima')}</button>
            </div>

            {anteprima && (
                <div className="mt-3 space-y-2">
                    <ul className="space-y-1 font-maven text-sm text-kidville-ink">
                        {anteprima.per_servizio.map((s) => (
                            <li key={s.categoria_id}>
                                {s.totale !== undefined
                                    ? t('servGenRigaServizioTotale', { nome: s.nome, voci: t('servGenVoci', { n: s.voci }), importo: formatEuro(s.totale) })
                                    : t('servGenRigaServizio', { nome: s.nome, voci: t('servGenVoci', { n: s.voci }) })}
                            </li>
                        ))}
                    </ul>
                    {anteprima.totale !== undefined && (
                        <p className="font-maven text-sm font-bold text-kidville-green">{t('servGenTotale', { importo: formatEuro(anteprima.totale) })}</p>
                    )}
                    {anteprima.voci === 0 && <p className="font-maven text-sm text-kidville-sub">{t('servGenNessuna')}</p>}
                    <BottonePrimarioServizi onClick={() => { void genera(); }} disabled={occupato || !pronta || anteprima.voci === 0}>
                        {t('servGenGenera', { n: anteprima.voci })}
                    </BottonePrimarioServizi>
                </div>
            )}

            <div role="alert" className={esito?.tipo === 'errore' ? avvisoErrore : undefined}>
                {esito?.tipo === 'errore' && (<>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{esito.testo}</span>
                </>)}
            </div>
            <p role="status" className={esito?.tipo === 'ok' ? avvisoOk : undefined}>{esito?.tipo === 'ok' ? esito.testo : ''}</p>
        </section>
    );
}
