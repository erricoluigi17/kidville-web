'use client';

import { useCallback, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { formatEuro } from '@/lib/format/valuta';
import { attivaNel, primoDelMese } from '@/lib/pagamenti/servizi-mensili';
import { etichettaMese } from '@/lib/pagamenti/selezione-voci';
import { nomeCompleto } from '@/lib/pagamenti/selezione-alunni';
import { ConfermaIscrizioneServizio } from './ConfermaIscrizioneServizio';
import { IscrizioneServizioForm, type DatiIscrizione } from './IscrizioneServizioForm';
import { VociFutureDialog } from './VociFutureDialog';
import { importoNumero, meseCorrente, type IscrizioneServizio, type Servizio } from './servizi-client';
import { useScritturaServizi, type EsitoMostrato } from './use-scrittura-servizi';
import { btnPiccolo, btnSecondario } from './servizi-stili';

interface Props {
    userId: string;
    scuolaId: string;
    servizio: Servizio;
    /** Le iscrizioni di QUESTO servizio. */
    iscrizioni: IscrizioneServizio[];
    onEsito: (e: EsitoMostrato) => void;
    onScritto: () => void;
    /** Si apre una nuova azione: l'esito precedente non vale più. */
    onNuovaAzione: () => void;
}

type Azione =
    | { tipo: 'aggiungi' }
    | { tipo: 'modifica' | 'termina' | 'elimina'; iscrizione: IscrizioneServizio };

const nomeDi = (i: IscrizioneServizio) => nomeCompleto({ id: i.id, nome: i.alunno?.nome, cognome: i.alunno?.cognome });

/** Un servizio mensile: dati, elenco delle iscrizioni e le azioni (aggiungi, modifica, termina, elimina). */
export function ServizioScheda({ userId, scuolaId, servizio, iscrizioni, onEsito, onScritto, onNuovaAzione }: Props) {
    const t = useTranslations('adminContabilita');
    const locale = useLocale();
    const [azione, setAzione] = useState<Azione | null>(null);
    const chiudi = useCallback(() => setAzione(null), []);
    const titoloRef = useRef<HTMLHeadingElement>(null);
    // Dopo un'operazione riuscita il bottone da cui si era partiti può sparire (eliminazione,
    // iscrizione conclusa): il focus va sul titolo della scheda, che c'è sempre.
    const esitoConFocus = useCallback((e: EsitoMostrato) => {
        onEsito(e);
        if (e.tipo === 'ok') setTimeout(() => titoloRef.current?.focus(), 0);
    }, [onEsito]);
    const scrittura = useScritturaServizi({ onEsito: esitoConFocus, onScritto, onChiuso: chiudi }, userId);
    const { azzeraErrore } = scrittura;
    const apri = (a: Azione) => { azzeraErrore(); onNuovaAzione(); setAzione(a); };

    const oggi = primoDelMese(meseCorrente());
    const ordinate = [...iscrizioni].sort((a, b) =>
        nomeDi(a).localeCompare(nomeDi(b), 'it') || a.dal.localeCompare(b.dal));
    const attivi = iscrizioni.filter((i) => attivaNel({ dal: i.dal, al: i.al }, oggi)).length;
    const predefinito = importoNumero(servizio.importo_mensile_default);

    const annulla = () => { scrittura.annulla(); };
    const invia = (d: DatiIscrizione) => {
        if (azione?.tipo === 'aggiungi') {
            void scrittura.iscrivi({
                scuola_id: scuolaId, categoria_id: servizio.id, alunno_ids: d.alunno_ids,
                importo_mensile: d.importo, dal: d.dal, ...(d.al ? { al: d.al } : {}),
            });
        } else if (azione?.tipo === 'modifica') {
            void scrittura.esegui({
                metodo: 'PATCH', evento: 'servizi-modifica-respinta', ok: 'servAggiornata',
                body: { id: azione.iscrizione.id, scuola_id: scuolaId, importo_mensile: d.importo, dal: d.dal, al: d.al },
            });
        }
    };
    const conferma = (ultimoMese?: string) => {
        if (azione?.tipo === 'termina' && ultimoMese) {
            void scrittura.esegui({
                metodo: 'PATCH', evento: 'servizi-termina-respinta', ok: 'servAggiornata',
                body: { id: azione.iscrizione.id, scuola_id: scuolaId, al: ultimoMese },
            });
        } else if (azione?.tipo === 'elimina') {
            void scrittura.esegui({
                metodo: 'DELETE', evento: 'servizi-elimina-respinta', ok: 'servEliminata',
                query: { id: azione.iscrizione.id, scuola_id: scuolaId },
            });
        }
    };

    const periodo = (i: IscrizioneServizio) => {
        const dal = etichettaMese(i.dal, locale, 'lunga');
        return i.al ? t('servPeriodoDaAl', { dal, al: etichettaMese(i.al, locale, 'lunga') }) : t('servPeriodoDa', { dal });
    };

    return (
        <section className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 ref={titoloRef} tabIndex={-1} className="font-barlow text-lg font-extrabold text-kidville-green outline-none">{servizio.nome}</h3>
                    <p className="font-maven text-xs text-kidville-sub">
                        {predefinito > 0 ? t('servImportoProposto', { importo: formatEuro(predefinito) }) : t('servImportoNonImpostato')}
                        {' · '}{t('servIscrittiAttivi', { n: attivi })}
                    </p>
                </div>
                <button type="button" onClick={() => apri({ tipo: 'aggiungi' })} className={btnSecondario}
                    aria-label={t('servAzioneServizio', { azione: t('servAggiungi'), servizio: servizio.nome })}>{t('servAggiungi')}</button>
            </div>

            {iscrizioni.length === 0 ? (
                <p className="mt-3 font-maven text-sm text-kidville-sub">{t('servNessunaIscrizione')}</p>
            ) : (
                <ul className="mt-3 space-y-2">
                    {ordinate.map((i) => {
                        const nome = nomeDi(i);
                        const conclusa = i.al !== null && i.al < oggi;
                        const per = (azione: string) => t('servAzioneIscrizione', { azione, nome, servizio: servizio.nome, periodo: periodo(i) });
                        return (
                            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-input bg-kidville-cream px-3 py-2 font-maven text-sm text-kidville-ink">
                                <span className="font-bold">{nome}</span>
                                {i.alunno?.classe_sezione && <span className="text-kidville-sub">{i.alunno.classe_sezione}</span>}
                                <span>{formatEuro(i.importo_mensile)}</span>
                                <span className="text-kidville-sub">{periodo(i)}</span>
                                {conclusa && <Badge tone="neutral">{t('servConclusa')}</Badge>}
                                {i.alunno && i.alunno.stato !== 'iscritto' && <Badge tone="warn">{t('servNonIscritto')}</Badge>}
                                <span className="ml-auto flex gap-1.5">
                                    <button type="button" className={btnPiccolo} aria-label={per(t('servModifica'))} onClick={() => apri({ tipo: 'modifica', iscrizione: i })}>{t('servModifica')}</button>
                                    {!conclusa && (
                                        <button type="button" className={btnPiccolo} aria-label={per(t('servTermina'))} onClick={() => apri({ tipo: 'termina', iscrizione: i })}>{t('servTermina')}</button>
                                    )}
                                    <button type="button" className={btnPiccolo} aria-label={per(t('servElimina'))} onClick={() => apri({ tipo: 'elimina', iscrizione: i })}>{t('servElimina')}</button>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            {azione && !scrittura.decisione && (azione.tipo === 'aggiungi' || azione.tipo === 'modifica') && (
                <IscrizioneServizioForm userId={userId} scuolaId={scuolaId} servizio={servizio} iscrizioniServizio={iscrizioni}
                    modifica={azione.tipo === 'modifica' ? azione.iscrizione : undefined}
                    invio={scrittura.invio} errore={scrittura.errore} onInvia={invia} onAnnulla={annulla} />
            )}
            {azione && !scrittura.decisione && (azione.tipo === 'termina' || azione.tipo === 'elimina') && (
                <ConfermaIscrizioneServizio modo={azione.tipo} nome={nomeDi(azione.iscrizione)} dal={azione.iscrizione.dal} al={azione.iscrizione.al}
                    invio={scrittura.invio} errore={scrittura.errore} onConferma={conferma} onAnnulla={annulla} />
            )}
            {scrittura.decisione && (
                <VociFutureDialog voci={scrittura.decisione.voci} invio={scrittura.invio}
                    onElimina={() => { void scrittura.decidi('elimina'); }}
                    onMantieni={() => { void scrittura.decidi('mantieni'); }}
                    onAnnulla={annulla} />
            )}
        </section>
    );
}
