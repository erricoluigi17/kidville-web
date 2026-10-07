'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { zMese } from '@/lib/pagamenti/servizi-mensili';
import { PAGINA_SERVIZI, importoNumero, intestazioni, meseCorrente } from './servizi-client';
import { BottonePrimarioServizi } from './BottonePrimarioServizi';
import { avvisoErrore, avvisoOk, btnSecondario, campo, etichetta } from './servizi-stili';

interface Props { userId: string; scuolaId: string }

interface Anteprima {
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

    const leggiAnteprima = async (): Promise<Anteprima | null> => {
        const q = new URLSearchParams({ periodo: mese, scuola_id: scuolaId });
        try {
            const res = await fetch(`${ROUTE}?${q.toString()}`, { headers: intestazioni(userId) });
            const corpo = await res.json().catch(() => null) as { data?: Anteprima } | null;
            if (!res.ok || !corpo?.data) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'servizi-anteprima-respinta', route: PAGINA_SERVIZI, stato: res.status });
                setEsito({ tipo: 'errore', testo: messaggioDaCorpo(corpo, t('servGenErroreAnteprima')) });
                return null;
            }
            return corpo.data;
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-anteprima-non-riuscita: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
            setEsito({ tipo: 'errore', testo: t('servGenErroreAnteprima') });
            return null;
        }
    };

    const mostraAnteprima = async () => {
        if (!zMese.safeParse(mese).success) { setEsito({ tipo: 'errore', testo: t('servErrDal') }); return; }
        setOccupato(true);
        setEsito(null);
        setAnteprima(await leggiAnteprima());
        setOccupato(false);
    };

    const genera = async () => {
        setOccupato(true);
        setEsito(null);
        try {
            const res = await fetch(ROUTE, { method: 'POST', headers: intestazioni(userId), body: JSON.stringify({ periodo: mese, scuola_id: scuolaId }) });
            const corpo = await res.json().catch(() => null) as { data?: { generati?: number } } | null;
            if (!res.ok) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'servizi-generazione-respinta', route: PAGINA_SERVIZI, stato: res.status });
                setEsito({ tipo: 'errore', testo: messaggioDaCorpo(corpo, t('servGenErroreGenera')) });
            } else {
                setEsito({ tipo: 'ok', testo: t('servGenFatto', { n: importoNumero(corpo?.data?.generati) }) });
                setAnteprima(await leggiAnteprima());
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
                        onChange={(e) => { setMese(e.target.value); setAnteprima(null); setEsito(null); }} className={`${campo} w-44`} />
                </div>
                <button type="button" onClick={() => { void mostraAnteprima(); }} disabled={occupato} className={btnSecondario}>{t('servGenAnteprima')}</button>
            </div>

            {anteprima && (
                <div className="mt-3 space-y-2">
                    <ul className="space-y-1 font-maven text-sm text-kidville-ink">
                        {anteprima.per_servizio.map((s) => (
                            <li key={s.categoria_id}>
                                <span className="font-bold">{s.nome}</span>{': '}{t('servGenVoci', { n: s.voci })}
                                {s.totale !== undefined && ` · ${formatEuro(s.totale)}`}
                            </li>
                        ))}
                    </ul>
                    {anteprima.totale !== undefined && (
                        <p className="font-maven text-sm font-bold text-kidville-green">{t('servGenTotale', { importo: formatEuro(anteprima.totale) })}</p>
                    )}
                    {anteprima.voci === 0 && <p className="font-maven text-sm text-kidville-sub">{t('servGenNessuna')}</p>}
                    <BottonePrimarioServizi onClick={() => { void genera(); }} disabled={occupato || anteprima.voci === 0}>
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
