'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SelettoreAlunni } from '@/components/ui/SelettoreAlunni';
import { periodiSovrapposti, primoDelMese } from '@/lib/pagamenti/servizi-mensili';
import { SELEZIONE_TUTTI, alunniBersaglio, nomeCompleto, type SelezioneAlunni } from '@/lib/pagamenti/selezione-alunni';
import { caricaAlunni, importoNumero, leggiImporto, meseCorrente, aMeseInput, type AlunnoElenco, type IscrizioneServizio, type Servizio } from './servizi-client';
import { BottonePrimarioServizi } from './BottonePrimarioServizi';
import { avvisoErrore, btnSecondario, campo, etichetta } from './servizi-stili';

export interface DatiIscrizione { alunno_ids: string[]; importo: number; dal: string; al: string | null }

interface Props {
    userId: string;
    scuolaId: string;
    servizio: Servizio;
    /** Le iscrizioni già presenti allo stesso servizio: servono a escludere chi si sovrapporrebbe. */
    iscrizioniServizio: IscrizioneServizio[];
    /** Presente = modifica di quella iscrizione; assente = nuove iscrizioni. */
    modifica?: IscrizioneServizio;
    invio: boolean;
    errore: string;
    onInvia: (d: DatiIscrizione) => void;
    onAnnulla: () => void;
}

const virgola = (n: number) => String(n).replace('.', ',');

/** Aggiunta di bambini a un servizio, oppure modifica di un'iscrizione (importo e periodo). */
export function IscrizioneServizioForm({ userId, scuolaId, servizio, iscrizioniServizio, modifica, invio, errore, onInvia, onAnnulla }: Props) {
    const t = useTranslations('adminContabilita');
    const id = useId();
    const nomeModifica = modifica?.alunno ? nomeCompleto({ id: modifica.id, nome: modifica.alunno.nome, cognome: modifica.alunno.cognome }) : '';
    const predefinito = modifica ? importoNumero(modifica.importo_mensile) : importoNumero(servizio.importo_mensile_default);
    const [importo, setImporto] = useState(predefinito > 0 ? virgola(predefinito) : '');
    const [dal, setDal] = useState(modifica ? aMeseInput(modifica.dal) : meseCorrente());
    const [al, setAl] = useState(modifica ? aMeseInput(modifica.al) : '');
    const [selezione, setSelezione] = useState<SelezioneAlunni>({ ...SELEZIONE_TUTTI, modo: 'scelti' });
    const [alunni, setAlunni] = useState<AlunnoElenco[]>([]);
    const [alunniErrore, setAlunniErrore] = useState(false);
    const [alunniCaricati, setAlunniCaricati] = useState(false);
    const [erroreLocale, setErroreLocale] = useState('');

    // L'elenco dei bambini si carica all'apertura, solo per le nuove iscrizioni.
    useEffect(() => {
        if (modifica) return;
        let vivo = true;
        void caricaAlunni(userId, scuolaId).then((r) => {
            if (!vivo) return;
            setAlunni(r.alunni);
            setAlunniErrore(r.errore);
            setAlunniCaricati(true);
        });
        return () => { vivo = false; };
    }, [userId, scuolaId, modifica]);

    // Chi ha già un'iscrizione che si sovrappone al periodo scelto non si può scegliere.
    const candidati = useMemo(() => {
        if (!dal) return alunni;
        const periodo = { dal: primoDelMese(dal), al: al && al >= dal ? primoDelMese(al) : null };
        const occupati = new Set(
            iscrizioniServizio.filter((i) => periodiSovrapposti(periodo, { dal: i.dal, al: i.al })).map((i) => i.alunno_id),
        );
        return alunni.filter((a) => !occupati.has(a.id));
    }, [alunni, iscrizioniServizio, dal, al]);
    const esclusi = alunni.length - candidati.length;

    const invia = () => {
        const scelti = modifica ? [] : alunniBersaglio(candidati, selezione).map((a) => a.id);
        if (!modifica && scelti.length === 0) { setErroreLocale(t('servErrNessunoScelto')); return; }
        const valore = leggiImporto(importo);
        if (valore === null) { setErroreLocale(t('servErrImporto')); return; }
        if (!/^\d{4}-\d{2}$/.test(dal)) { setErroreLocale(t('servErrDal')); return; }
        if (al && al < dal) { setErroreLocale(t('servErrAlPrimaDiDal')); return; }
        setErroreLocale('');
        onInvia({ alunno_ids: scelti, importo: valore, dal, al: al || null });
    };

    const titolo = modifica ? t('servFormModificaTitolo', { nome: nomeModifica }) : t('servFormAggiungiTitolo', { servizio: servizio.nome });
    const messaggio = erroreLocale || errore;
    return (
        <Modal open onClose={invio ? () => {} : onAnnulla} title={titolo} labelledBy={`${id}-titolo`} closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl">
            <h3 id={`${id}-titolo`} className="font-barlow text-lg font-extrabold text-kidville-green">{titolo}</h3>

            {!modifica && (
                <div className="mt-3 space-y-2">
                    {alunniErrore && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{t('servAlunniNonCaricati')}</p>}
                    {!alunniCaricati ? (
                        <p role="status" className="font-maven text-sm text-kidville-sub">{t('servFormCaricamentoAlunni')}</p>
                    ) : (
                    <SelettoreAlunni
                        id={`${id}-scelta`}
                        alunni={candidati}
                        valore={selezione}
                        onChange={setSelezione}
                        disabled={invio}
                        testi={{
                            legenda: t('genrSceltaLegenda'),
                            modoTutti: t('genrSceltaTutti'),
                            modoClasse: t('genrSceltaClasse'),
                            modoScelti: t('genrSceltaScelti'),
                            classeEtichetta: t('genrSceltaClasseEtichetta'),
                            classeTutte: t('genrSceltaClasseTutte'),
                            cercaEtichetta: t('genrSceltaCerca'),
                            cercaSegnaposto: t('genrSceltaCercaSegnaposto'),
                            selezionaMostrati: t('genrSceltaSelezionaMostrati'),
                            svuota: t('genrSceltaSvuota'),
                            vuoto: t('genrSceltaVuoto'),
                            conteggio: (n: number) => t('genrSceltaConteggio', { n }),
                            bersaglio: (n: number) => t('genrSceltaBersaglio', { n }),
                        }}
                    />
                    )}
                    <p role="status" className="font-maven text-xs text-kidville-sub">{esclusi > 0 ? t('servAlunniEsclusi', { n: esclusi }) : ''}</p>
                </div>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div>
                    <label htmlFor={`${id}-importo`} className={etichetta}>{t('servImporto')}</label>
                    <input id={`${id}-importo`} type="text" inputMode="decimal" value={importo}
                        onChange={(e) => setImporto(e.target.value)} className={campo} />
                </div>
                <div>
                    <label htmlFor={`${id}-dal`} className={etichetta}>{t('servDal')}</label>
                    <input id={`${id}-dal`} type="month" value={dal} onChange={(e) => setDal(e.target.value)} className={campo} />
                </div>
                <div>
                    <label htmlFor={`${id}-al`} className={etichetta}>{t('servAl')}</label>
                    <input id={`${id}-al`} type="month" value={al} aria-describedby={`${id}-al-aiuto`}
                        onChange={(e) => setAl(e.target.value)} className={campo} />
                </div>
            </div>
            <p id={`${id}-al-aiuto`} className="mt-1 font-maven text-xs text-kidville-sub">{t('servAlAiuto')}</p>

            <div role="alert" className={messaggio ? avvisoErrore : undefined}>
                {messaggio && (<>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                    <span>{messaggio}</span>
                </>)}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onAnnulla} disabled={invio} className={btnSecondario}>{t('servAnnulla')}</button>
                <BottonePrimarioServizi onClick={invia} disabled={invio}>{modifica ? t('servSalva') : t('servIscrivi')}</BottonePrimarioServizi>
            </div>
        </Modal>
    );
}
