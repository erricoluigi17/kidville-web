'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { TIPI_BASE } from '@/lib/diary/routine';

/**
 * Il diario di una classe di un anno PASSATO (o che si sta chiudendo), da CONSULTARE (lotto 8, §4.10 della specifica).
 *
 * Niente editor, niente aggiunta, modifica o cancellazione: solo, giorno per giorno dentro le date dell'anno, chi era in classe
 * e cosa è stato segnato (tipo e ora). Di proposito NON mostra note, dettagli né dati sanitari: sono testo libero, e dei minori.
 * Il server è la difesa vera (`/api/diary/entries?dellAnno=1` è in sola lettura; il POST risponde `SEZIONE_SOLA_LETTURA`).
 */
interface Props {
    sectionId: string;
    scuolaId?: string;
    /** Primo e ultimo giorno dell'anno di quella classe (`anni_sede`); `null` = non noti (nessun limite lato schermo). */
    annoInizio?: string | null;
    annoFine?: string | null;
}

interface Bambino { id: string; nome: string; cognome: string }
interface Voce { id: string; alunno_id: string; tipo_evento: string; orario_inizio: string | null }

const TIPI_NOTI: readonly string[] = TIPI_BASE;

/** Il giorno di partenza: oggi, ma mai oltre la fine dell'anno né prima del suo inizio. */
export function giornoIniziale(inizio?: string | null, fine?: string | null): string {
    let g = oggiFiscaleISO();
    if (fine && g > fine) g = fine;
    if (inizio && g < inizio) g = inizio;
    return g;
}

export function DiarioSolaLettura({ sectionId, scuolaId, annoInizio, annoFine }: Props) {
    const t = useTranslations('teacherDiario');
    const f = useDateFormat();
    const [giorno, setGiorno] = useState(() => giornoIniziale(annoInizio, annoFine));
    const [bambini, setBambini] = useState<Bambino[]>([]);
    const [voci, setVoci] = useState<Voce[]>([]);
    const [statoBambini, setStatoBambini] = useState<'caricamento' | 'ok' | 'errore'>('caricamento');
    const [statoVoci, setStatoVoci] = useState<'caricamento' | 'ok' | 'errore'>('caricamento');
    const max = annoFine && annoFine < oggiFiscaleISO() ? annoFine : oggiFiscaleISO();

    const sede = scuolaId ? `&scuola_id=${scuolaId}` : '';

    // I bambini dell'anno non cambiano con il giorno: si leggono una volta per classe, non a ogni cambio di data.
    useEffect(() => {
        let attivo = true;
        fetch(`/api/diary/students?sectionId=${sectionId}&dellAnno=1${sede}`, { cache: 'no-store' })
            .then(async (rb) => {
                if (!rb.ok) {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'diario-classe-passata-bambini-rifiutati', route: '/teacher/diary', stato: rb.status });
                    if (attivo) setStatoBambini('errore');
                    return;
                }
                const b = (await rb.json()) as Bambino[];
                if (!attivo) return;
                setBambini(Array.isArray(b) ? b : []);
                setStatoBambini('ok');
            })
            .catch((err) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `diario-classe-passata-bambini-fallito: ${nomeErrore(err)}`, route: '/teacher/diary' });
                if (attivo) setStatoBambini('errore');
            });
        return () => { attivo = false; };
    }, [sectionId, sede]);

    // Le voci del giorno: una lettura per ogni giorno scelto.
    useEffect(() => {
        let attivo = true;
        fetch(`/api/diary/entries?sectionId=${sectionId}&date=${giorno}&dellAnno=1${sede}`, { cache: 'no-store' })
            .then(async (rv) => {
                if (!rv.ok) {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'diario-classe-passata-rifiutato', route: '/teacher/diary', stato: rv.status });
                    if (attivo) setStatoVoci('errore');
                    return;
                }
                const v = (await rv.json()) as Voce[];
                if (!attivo) return;
                setVoci(Array.isArray(v) ? v : []);
                setStatoVoci('ok');
            })
            .catch((err) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `diario-classe-passata-fallito: ${nomeErrore(err)}`, route: '/teacher/diary' });
                if (attivo) setStatoVoci('errore');
            });
        return () => { attivo = false; };
    }, [sectionId, sede, giorno]);

    const stato: 'caricamento' | 'ok' | 'errore' = statoBambini === 'errore' || statoVoci === 'errore' ? 'errore' : statoBambini === 'ok' && statoVoci === 'ok' ? 'ok' : 'caricamento';

    const cambiaGiorno = (nuovo: string) => {
        if (!nuovo) return;
        setStatoVoci('caricamento');
        setGiorno(nuovo);
    };
    const ora = (iso: string | null) => (iso ? intlDateTime(f.locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
    const etichetta = (tipo: string) => (TIPI_NOTI.includes(tipo) ? t(`slTipo_${tipo}`) : t('slTipoRoutine'));
    // Le voci di bambini che NON sono nell'elenco dell'anno non si mostrano: se sono tutte così, l'elenco sarebbe vuoto.
    const idsElenco = new Set(bambini.map((b) => b.id));
    const vociVisibili = voci.filter((v) => idsElenco.has(v.alunno_id));
    const perBambino = (id: string) => voci.filter((v) => v.alunno_id === id).sort((a, b) => (a.orario_inizio ?? '').localeCompare(b.orario_inizio ?? ''));

    return (
        <div className="mt-4" data-diario-sola-lettura>
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="sl-giorno" className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-sub">{t('slGiorno')}</label>
                <input
                    id="sl-giorno"
                    type="date"
                    value={giorno}
                    min={annoInizio ?? undefined}
                    max={max}
                    onChange={(e) => cambiaGiorno(e.target.value)}
                    className="min-h-11 rounded-xl border border-kidville-line bg-white px-3 font-maven text-sm text-kidville-ink"
                />
            </div>

            {stato === 'caricamento' && <p role="status" className="mt-4 font-maven text-sm text-kidville-sub">{t('inCaricamento')}</p>}
            {stato === 'errore' && <p role="alert" className="mt-4 rounded-xl border border-kidville-warn/30 bg-kidville-warn-soft p-3 font-maven text-sm text-kidville-ink">{t('slErrore')}</p>}
            {stato === 'ok' && bambini.length === 0 && <p className="mt-4 font-maven text-sm text-kidville-sub">{t('slNessunBambino')}</p>}
            {stato === 'ok' && bambini.length > 0 && vociVisibili.length === 0 && <p className="mt-4 font-maven text-sm text-kidville-sub">{t('slNessunaVoce')}</p>}
            {stato === 'ok' && vociVisibili.length > 0 && (
                <ul className="mt-4 space-y-3">
                    {bambini.map((b) => {
                        const sue = perBambino(b.id);
                        if (sue.length === 0) return null;
                        return (
                            <li key={b.id} className="rounded-2xl border border-kidville-line bg-white p-4 shadow-sm">
                                <p className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">{b.nome} {b.cognome}</p>
                                <ul className="mt-2 space-y-1">
                                    {sue.map((v) => (
                                        <li key={v.id} className="flex flex-wrap items-baseline gap-2 font-maven text-sm text-kidville-ink">
                                            <span className="min-w-12 text-kidville-sub">{ora(v.orario_inizio)}</span>
                                            <span>{etichetta(v.tipo_evento)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
