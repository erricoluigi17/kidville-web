'use client';

/**
 * «ELIMINA DEFINITIVAMENTE» — la finestra della linguetta «Non iscritti».
 *
 * Due tempi, come «Libera spazio», ma senza nominativo da riscrivere (decisione
 * del titolare, 2026-10-08): all'apertura si CONTA (`mode: 'dryrun'`) e si
 * mostrano i numeri; poi si offrono SOLO le scelte che il server ha detto
 * disponibili. Il server ricontrolla comunque tutto: questa finestra non è una
 * difesa, è la spiegazione.
 *
 * Un comando che non si può usare resta a schermo, spento e con il motivo
 * accanto: sparire direbbe «non esiste», mentre la verità è «non qui, e perché».
 * È spento con `aria-disabled` e non con `disabled` (che toglie il fuoco), quindi
 * il click ARRIVA: a fermarlo è `esegui`, che non parte su una scelta che il
 * server non ha offerto.
 *
 * ⚠️ `t` NON entra nelle dipendenze di `misura`, per la stessa ragione misurata
 * scritta in `LiberaSpazioDialog`: `useTranslations` non promette la stessa
 * funzione a ogni render, e con `t` fra le dipendenze l'effetto ripartirebbe a
 * ogni render sparando un dry-run per giro. Perciò l'errore si conserva come
 * frase del server (o stringa vuota) e il ripiego tradotto si sceglie a render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
// `import type`: viene cancellato in compilazione, del motore server non entra
// una riga nel bundle del browser (stesso schema di `LiberaSpazioDialog`).
import type { ConteggiEliminazione, MotivoBloccoEliminazione, SceltaEliminazione } from '@/lib/alunni/elimina-definitivo';

export interface AlunnoDaEliminare {
    id: string;
    nome?: string | null;
    cognome?: string | null;
}

export interface EliminaDefinitivoDialogProps {
    /** `null` = finestra chiusa. */
    alunno: AlunnoDaEliminare | null;
    onChiudi: () => void;
    /** Chiamata a operazione riuscita, con la frase da mostrare nell'elenco. */
    onEliminato: (esito: string) => void;
}

interface Anteprima {
    conteggi: ConteggiEliminazione;
    scelte: Record<SceltaEliminazione, boolean>;
    motivo: MotivoBloccoEliminazione | null;
}

type Fase = 'misura' | 'pronta' | 'misura-fallita' | 'esecuzione';

const ROTTA = '/api/admin/students/elimina';

export function EliminaDefinitivoDialog({ alunno, onChiudi, onEliminato }: EliminaDefinitivoDialogProps) {
    if (alunno === null) return null;
    // La `key` sta DENTRO il componente: un altro bambino è un'altra finestra, e
    // i numeri del precedente non arrivano mai sopra un comando senza annulla.
    return <Finestra key={alunno.id} alunno={alunno} onChiudi={onChiudi} onEliminato={onEliminato} />;
}

function Finestra({ alunno, onChiudi, onEliminato }: { alunno: AlunnoDaEliminare } & Omit<EliminaDefinitivoDialogProps, 'alunno'>) {
    const t = useTranslations('adminStudents');
    const [fase, setFase] = useState<Fase>('misura');
    const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
    /**
     * `null` = niente di storto; `''` = storto senza un motivo del server (il
     * ripiego tradotto si sceglie a render); testo = il motivo del server, già
     * tradotto dal catalogo dei codici.
     */
    const [errore, setErrore] = useState<string | null>(null);
    /** Guardia di rientro: due click nello stesso tick non fanno due POST. */
    const inVolo = useRef(false);
    /** L'epoca della misura in corso: la risposta VECCHIA non vince sulla nuova. */
    const ultimaMisura = useRef(0);

    const alunnoId = alunno.id;
    const nominativo = [alunno.cognome, alunno.nome].filter((v) => typeof v === 'string' && v !== '').join(' ');

    const misura = useCallback(async () => {
        const mia = ultimaMisura.current + 1;
        ultimaMisura.current = mia;
        let motivo = '';
        // Il default è il RIFIUTO: qualunque strada esca da qui senza aver letto
        // i numeri ferma l'operatore. «Non lo so» non si traveste da «niente».
        let prossima: Fase = 'misura-fallita';
        try {
            const res = await fetch(ROTTA, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunnoId, mode: 'dryrun' }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (mia !== ultimaMisura.current) return;
            if (res === null) {
                setErrore('');
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-anteprima-non-arrivata: ${motivo}`, route: '/admin/students' });
                return;
            }
            if (!res.ok) {
                setErrore(await messaggioErrore(res, ''));
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-anteprima-rifiutata', route: '/admin/students', stato: res.status });
                return;
            }
            const corpo = (await res.json().catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            })) as Anteprima | null;
            if (mia !== ultimaMisura.current) return;
            if (!corpo || typeof corpo !== 'object' || !corpo.scelte || !corpo.conteggi) {
                setErrore('');
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-anteprima-illeggibile: ${motivo || 'forma'}`, route: '/admin/students', stato: res.status });
                return;
            }
            setAnteprima(corpo);
            setErrore(null);
            prossima = 'pronta';
        } finally {
            if (mia === ultimaMisura.current) setFase(prossima);
        }
    }, [alunnoId]);

    useEffect(() => {
        void misura();
    }, [misura]);

    const riprova = () => {
        setFase('misura');
        setErrore(null);
        void misura();
    };

    const esegui = async (scelta: SceltaEliminazione) => {
        // Un comando spento con `aria-disabled` riceve comunque il click: qui si
        // ferma, sia in volo sia su una scelta che il server non ha offerto.
        if (inVolo.current || !anteprima?.scelte[scelta]) return;
        inVolo.current = true;
        setFase('esecuzione');
        setErrore(null);
        let motivo = '';
        try {
            const res = await fetch(ROTTA, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunnoId, mode: 'execute', scelta }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (res === null) {
                setErrore('');
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-non-arrivata: ${motivo}`, route: '/admin/students' });
                return;
            }
            if (!res.ok) {
                setErrore(await messaggioErrore(res, ''));
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-rifiutata', route: '/admin/students', stato: res.status });
                return;
            }
            onEliminato(
                scelta === 'anonimizza'
                    ? t('elmEsitoAnonimizzato', { nome: nominativo })
                    : t('elmEsitoEliminato', { nome: nominativo }),
            );
            onChiudi();
        } finally {
            inVolo.current = false;
            setFase((f) => (f === 'esecuzione' ? 'pronta' : f));
        }
    };

    const c = anteprima?.conteggi;
    const documenti = c ? c.certificati_medici + c.fascicolo_sanitario : 0;
    /** Le voci collegate, con il loro conteggio. Le righe a zero non si mostrano. */
    const righe = c
        ? [
              c.presenze > 0 ? t('elmPresenze', { n: c.presenze }) : null,
              c.diario > 0 ? t('elmDiario', { n: c.diario }) : null,
              c.legami_genitori > 0 ? t('elmLegami', { n: c.legami_genitori }) : null,
              documenti > 0 ? t('elmDocumenti', { n: documenti }) : null,
              c.foto_solo_sue > 0 ? t('elmFoto', { n: c.foto_solo_sue }) : null,
              c.foto_di_gruppo > 0 ? t('elmFotoGruppo', { n: c.foto_di_gruppo }) : null,
              c.allegati_chat > 0 ? t('elmChat', { n: c.allegati_chat }) : null,
              c.pagamenti > 0 ? t('elmPagamenti', { n: c.pagamenti }) : null,
          ].filter((v): v is string => v !== null)
        : [];

    const registro = anteprima?.motivo === 'REGISTRO_PRIMARIA_DA_CONSERVARE';
    const pagamentiBloccati = anteprima?.motivo === 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI';
    const occupato = fase === 'esecuzione';
    const decisione = anteprima !== null && (fase === 'pronta' || fase === 'esecuzione');

    return (
        <Modal
            open
            onClose={onChiudi}
            title={t('elmTitolo')}
            labelledBy="elimina-definitivo-titolo"
            // Non si chiude cliccando fuori: da qui parte un'operazione senza annulla.
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-4 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <Trash2 size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h2 id="elimina-definitivo-titolo" className="font-barlow text-lg font-bold uppercase text-kidville-green">
                        {t('elmTitolo')}
                    </h2>
                    <p className="font-maven truncate text-sm text-kidville-sub">{nominativo}</p>
                </div>
            </div>

            {fase === 'misura' && (
                <p role="status" className="mb-4 flex items-center gap-2 font-maven text-sm text-kidville-sub">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('elmMisura')}
                </p>
            )}

            {fase === 'misura-fallita' && (
                <p role="alert" className="mb-4 flex items-start gap-2 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {errore || t('elmMisuraFallita')}
                </p>
            )}

            {decisione && (
                <>
                    <div className="mb-4 rounded-input bg-kidville-cream px-3 py-2.5 font-maven text-[13px] text-kidville-ink">
                        <p className="mb-1 font-semibold">{t('elmCollegati')}</p>
                        {righe.length === 0 ? (
                            <p>{t('elmNiente')}</p>
                        ) : (
                            <ul className="list-disc pl-5">
                                {righe.map((r) => (
                                    <li key={r}>{r}</li>
                                ))}
                            </ul>
                        )}
                        {c && c.legami_genitori > 0 && <p className="mt-2">{t('elmGenitoriIntatti')}</p>}
                    </div>

                    {registro ? (
                        <p className="mb-4 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            {t('elmBloccoRegistro')}
                        </p>
                    ) : (
                        <>
                            {pagamentiBloccati && (
                                <p className="mb-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                                    {t('elmBloccoPagamenti')}
                                </p>
                            )}
                            {anteprima.scelte.anonimizza && (
                                <p className="mb-3 font-maven text-[13px] text-kidville-sub">{t('elmSpiegaAnonimizza')}</p>
                            )}
                            <p className="mb-3 font-maven text-[13px] font-semibold text-kidville-error-strong">{t('elmIrreversibile')}</p>
                        </>
                    )}

                    {errore !== null && (
                        <p role="alert" className="mb-3 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong">
                            {errore || t('elmErrore')}
                        </p>
                    )}
                </>
            )}

            <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onChiudi} className={btnClass('ghost', 'sm')}>
                    {registro || fase === 'misura-fallita' ? t('elmChiudi') : t('elmAnnulla')}
                </button>
                {fase === 'misura-fallita' && (
                    <button type="button" onClick={riprova} className={btnClass('primary', 'sm')}>
                        <RotateCcw size={14} strokeWidth={2} aria-hidden="true" /> {t('elmRiprova')}
                    </button>
                )}
                {decisione && !registro && (
                    <>
                        {anteprima.scelte.anonimizza && (
                            <button type="button" onClick={() => void esegui('anonimizza')} aria-disabled={occupato} className={btnClass('secondary', 'sm')}>
                                {t('elmBtnAnonimizza')}
                            </button>
                        )}
                        {(anteprima.scelte.elimina_con_pagamenti || pagamentiBloccati) && (
                            <button
                                type="button"
                                onClick={() => void esegui('elimina_con_pagamenti')}
                                aria-disabled={occupato || !anteprima.scelte.elimina_con_pagamenti}
                                className={btnClass('danger', 'sm')}
                            >
                                {t('elmBtnEliminaConPagamenti')}
                            </button>
                        )}
                        {anteprima.scelte.elimina && (
                            <button type="button" onClick={() => void esegui('elimina')} aria-disabled={occupato} className={btnClass('danger', 'sm')}>
                                {occupato ? t('elmInCorso') : t('elmBtnElimina')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
