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
 * «Cancella anche i pagamenti» con un pagamento bloccato resta a schermo, spento
 * e con il motivo accanto: sparire direbbe «non esiste», mentre la verità è «non
 * qui, e perché». È spento con `aria-disabled` e non con `disabled` (che toglie
 * il fuoco), quindi il click ARRIVA: a fermarlo è `esegui`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PERCHÉ LE CHIAMATE STANNO FUORI DAL COMPONENTE
 *
 * `react-hooks/set-state-in-effect` (un ERRORE del gate) con un
 * `try { await … } finally { setState }` dentro il componente non è soddisfatta:
 * è SPENTA. Il compilatore di React rinuncia al componente intero («Handle
 * TryStatement without a catch clause», visibile con `react-hooks/todo` acceso),
 * e con lui tutte le sue regole. Qui la forma è quella che il compilatore legge:
 * la rete in due funzioni di MODULO che non toccano lo stato e restituiscono un
 * esito; nel componente un effetto su `[alunnoId, tentativo]` con il flag `vivo`
 * e i `setState` dentro il `.then`. «Riprova» incrementa `tentativo`.
 *
 * Nelle due funzioni non entra nessuna frase di catalogo: l'errore torna come
 * frase del server (già tradotta dal catalogo dei codici) o come stringa vuota,
 * e il ripiego tradotto si sceglie a render. Così `t` non entra in nessuna
 * dipendenza: `useTranslations` non promette la stessa funzione a ogni render, e
 * un effetto che dipendesse da `t` ripartirebbe a ogni render (misurato su
 * «Libera spazio»: un dry-run per giro).
 */

import { useEffect, useRef, useState } from 'react';
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

/**
 * L'esito di una chiamata, già pronto per lo stato. `errore` vale la frase del
 * server, o `''` quando il server non ha detto perché (rete giù, corpo
 * illeggibile): il ripiego tradotto lo sceglie il render.
 */
type EsitoAnteprima = { ok: true; anteprima: Anteprima } | { ok: false; errore: string };
type EsitoEsecuzione = { ok: true } | { ok: false; errore: string };

type Fase = 'misura' | 'pronta' | 'misura-fallita' | 'esecuzione';

const ROTTA = '/api/admin/students/elimina';
const ID_MOTIVO = 'elimina-definitivo-motivo';
/** Il comando spento deve SEMBRARE spento: `btnClass` stila `disabled`, non `aria-disabled`. */
const SPENTO = 'aria-disabled:border-kidville-neutral aria-disabled:bg-kidville-neutral-soft aria-disabled:text-kidville-sub';

function chiama(corpo: Record<string, unknown>): Promise<Response | null> {
    return fetch(ROTTA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
    }).catch((e: unknown) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-non-arrivata: ${nomeErrore(e)}`, route: '/admin/students' });
        return null;
    });
}

/** Il dry-run: SOLE letture sul server. Non tocca lo stato di nessun componente. */
async function misuraEliminazione(alunnoId: string): Promise<EsitoAnteprima> {
    const res = await chiama({ alunno_id: alunnoId, mode: 'dryrun' });
    if (res === null) return { ok: false, errore: '' };
    if (!res.ok) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-anteprima-rifiutata', route: '/admin/students', stato: res.status });
        return { ok: false, errore: await messaggioErrore(res, '') };
    }
    let motivo = 'forma';
    const corpo = (await res.json().catch((e: unknown) => {
        motivo = nomeErrore(e);
        return null;
    })) as Partial<Anteprima> | null;
    if (!corpo || typeof corpo !== 'object' || !corpo.scelte || !corpo.conteggi) {
        // Senza numeri non si offre niente: «non lo so» non si traveste da «niente».
        logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-anteprima-illeggibile: ${motivo}`, route: '/admin/students', stato: res.status });
        return { ok: false, errore: '' };
    }
    return { ok: true, anteprima: { conteggi: corpo.conteggi, scelte: corpo.scelte, motivo: corpo.motivo ?? null } };
}

/** L'esecuzione. Un 200 vuol dire fatto: il corpo non serve alla finestra. */
async function eseguiEliminazione(alunnoId: string, scelta: SceltaEliminazione): Promise<EsitoEsecuzione> {
    const res = await chiama({ alunno_id: alunnoId, mode: 'execute', scelta });
    if (res === null) return { ok: false, errore: '' };
    if (!res.ok) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-rifiutata', route: '/admin/students', stato: res.status });
        return { ok: false, errore: await messaggioErrore(res, '') };
    }
    return { ok: true };
}

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
    const [erroreMisura, setErroreMisura] = useState('');
    /** `null` = nessuna esecuzione fallita da mostrare. Resta a schermo durante la rimisura. */
    const [erroreEsecuzione, setErroreEsecuzione] = useState<string | null>(null);
    /** La scelta in volo: è il SUO bottone a dire «Un momento…». */
    const [inCorso, setInCorso] = useState<SceltaEliminazione | null>(null);
    /** Ogni incremento rifà la misura: «Riprova», e dopo un'esecuzione fallita. */
    const [tentativo, setTentativo] = useState(0);
    /** Guardia di rientro, sincrona: due click nello stesso tick non fanno due POST. */
    const inVolo = useRef(false);
    /** Dove va il fuoco quando un'esecuzione fallisce e i comandi spariscono. */
    const erroreRef = useRef<HTMLParagraphElement>(null);

    const alunnoId = alunno.id;
    const nominativo = [alunno.cognome, alunno.nome].filter((v) => typeof v === 'string' && v !== '').join(' ');

    useEffect(() => {
        let vivo = true;
        void misuraEliminazione(alunnoId).then((esito) => {
            if (!vivo) return;
            if (esito.ok) {
                setAnteprima(esito.anteprima);
                setFase('pronta');
            } else {
                setErroreMisura(esito.errore);
                setFase('misura-fallita');
            }
        });
        return () => {
            vivo = false;
        };
    }, [alunnoId, tentativo]);

    useEffect(() => {
        if (erroreEsecuzione !== null) erroreRef.current?.focus();
    }, [erroreEsecuzione]);

    const rimisura = () => {
        setFase('misura');
        setTentativo((n) => n + 1);
    };

    /** Durante l'esecuzione la finestra non si chiude: né Annulla, né Escape, né Indietro. */
    const chiudi = () => {
        if (inVolo.current) return;
        onChiudi();
    };

    const esegui = (scelta: SceltaEliminazione) => {
        // Un comando spento con `aria-disabled` riceve comunque il click: qui si
        // ferma, sia in volo sia su una scelta che il server non ha offerto.
        if (inVolo.current || fase !== 'pronta' || !anteprima?.scelte[scelta]) return;
        inVolo.current = true;
        setInCorso(scelta);
        setFase('esecuzione');
        setErroreEsecuzione(null);
        void eseguiEliminazione(alunnoId, scelta).then((esito) => {
            inVolo.current = false;
            if (esito.ok) {
                onEliminato(
                    scelta === 'anonimizza'
                        ? t('elmEsitoAnonimizzato', { nome: nominativo })
                        : t('elmEsitoEliminato', { nome: nominativo }),
                );
                onChiudi();
                return;
            }
            // Fallita: il messaggio resta, e i numeri si rileggono — quelli di
            // prima potrebbero non essere più veri (un file uscito, uno no).
            setInCorso(null);
            setErroreEsecuzione(esito.errore);
            rimisura();
        });
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
              c.articoli_pubblici > 0 ? t('elmArticoli', { n: c.articoli_pubblici }) : null,
              c.pagamenti > 0 ? t('elmPagamenti', { n: c.pagamenti }) : null,
              // Ricevute senza un pagamento dell'alunno a cui appendersi: non sono
              // «niente», e sono loro a bloccare.
              c.pagamenti === 0 && c.pagamenti_bloccati > 0 ? t('elmRicevute', { n: c.pagamenti_bloccati }) : null,
          ].filter((v): v is string => v !== null)
        : [];

    const motivo = anteprima?.motivo ?? null;
    const registro = motivo === 'REGISTRO_PRIMARIA_DA_CONSERVARE';
    const pagamentiBloccati = motivo === 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI';
    const fotoBloccano = motivo === 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI';
    const scelte = anteprima?.scelte;
    const qualcheScelta = scelte ? scelte.elimina || scelte.elimina_con_pagamenti || scelte.anonimizza : false;
    const occupato = fase === 'esecuzione';
    const decisione = anteprima !== null && (fase === 'pronta' || fase === 'esecuzione');
    const soloChiudi = fase === 'misura-fallita' || (decisione && !qualcheScelta);

    return (
        <Modal
            open
            onClose={chiudi}
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
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {erroreMisura || t('elmMisuraFallita')}
                </p>
            )}

            {decisione && scelte && (
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

                    {registro && (
                        <p className="mb-4 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            {t('elmBloccoRegistro')}
                        </p>
                    )}
                    {pagamentiBloccati && (
                        <p id={ID_MOTIVO} className="mb-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            {t('elmBloccoPagamenti')}
                        </p>
                    )}
                    {fotoBloccano && c && (
                        <p id={ID_MOTIVO} className="mb-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            {t('elmBloccoFoto', { n: c.foto_non_rimovibili })}
                        </p>
                    )}
                    {scelte.anonimizza && <p className="mb-3 font-maven text-[13px] text-kidville-sub">{t('elmSpiegaAnonimizza')}</p>}
                    {qualcheScelta && (
                        <p className="mb-3 font-maven text-[13px] font-semibold text-kidville-error-strong">{t('elmIrreversibile')}</p>
                    )}
                </>
            )}

            {erroreEsecuzione !== null && (
                <p
                    ref={erroreRef}
                    role="alert"
                    tabIndex={-1}
                    className="mb-3 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
                >
                    {erroreEsecuzione || t('elmErrore')}
                </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={chiudi} aria-disabled={occupato} className={btnClass('ghost', 'sm')}>
                    {soloChiudi ? t('elmChiudi') : t('elmAnnulla')}
                </button>
                {fase === 'misura-fallita' && (
                    <button type="button" onClick={rimisura} className={btnClass('primary', 'sm')}>
                        <RotateCcw size={14} strokeWidth={2} aria-hidden="true" /> {t('elmRiprova')}
                    </button>
                )}
                {decisione && scelte && (
                    <>
                        {scelte.anonimizza && (
                            <button type="button" onClick={() => esegui('anonimizza')} aria-disabled={occupato} className={btnClass('secondary', 'sm')}>
                                {inCorso === 'anonimizza' ? t('elmInCorso') : t('elmBtnAnonimizza')}
                            </button>
                        )}
                        {(scelte.elimina_con_pagamenti || pagamentiBloccati) && (
                            <button
                                type="button"
                                onClick={() => esegui('elimina_con_pagamenti')}
                                aria-disabled={occupato || !scelte.elimina_con_pagamenti}
                                aria-describedby={scelte.elimina_con_pagamenti ? undefined : ID_MOTIVO}
                                className={btnClass('danger', 'sm', scelte.elimina_con_pagamenti ? undefined : SPENTO)}
                            >
                                {inCorso === 'elimina_con_pagamenti' ? t('elmInCorso') : t('elmBtnEliminaConPagamenti')}
                            </button>
                        )}
                        {scelte.elimina && (
                            <button type="button" onClick={() => esegui('elimina')} aria-disabled={occupato} className={btnClass('danger', 'sm')}>
                                {inCorso === 'elimina' ? t('elmInCorso') : t('elmBtnElimina')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
