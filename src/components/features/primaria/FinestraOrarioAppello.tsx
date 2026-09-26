'use client';

/**
 * LA FINESTRA DI «RITARDO» E «USCITA ANTICIPATA» DELL'APPELLO PRIMARIA (A4, 2026-09-26).
 *
 * Prima il tocco su «Ritardo» salvava subito con l'ora del tocco, e l'ora si correggeva
 * dopo col chip. Mancava il posto per dire PERCHÉ: un bambino che entra alle 10 dopo la
 * terapia non ha fatto due ore di assenza. La finestra raccoglie in un gesto solo:
 *  · l'ora (ingresso per il ritardo, uscita per l'uscita anticipata), precompilata con
 *    l'ora di Roma di adesso — o con quella salvata, se la riga è già in quello stato;
 *  · la spunta «Giustificato (non conta nelle ore di assenza)»;
 *  · la nota, OBBLIGATORIA con la spunta: il server la esige nello STESSO corpo (422
 *    `GIUSTIFICAZIONE_SENZA_NOTA`), e il CHECK del DB la esige comunque. Qui si ferma
 *    prima, dicendo perché, invece di far partire una POST destinata al rifiuto.
 *
 * Il componente non salva niente: consegna i valori a `onSalva` e il chiamante manda la
 * POST esistente. «Annulla», Escape, tocco fuori e Indietro di Android chiudono senza
 * cambiare nulla (la primitiva `Modal`).
 *
 * Lo stato del modulo nasce dai valori iniziali e non si riallinea dopo: il chiamante lo
 * monta con una `key` per alunno e stato, così ogni apertura riparte da capo.
 */

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

export type StatoConOrario = 'ritardo' | 'uscita_anticipata';

export interface ValoriFinestraOrario {
    /** `HH:MM` nell'ora di Roma. */
    ora: string;
    giustificato: boolean;
    /** Già ripulita dagli spazi ai bordi; stringa vuota = nessuna nota. */
    nota: string;
}

const ORA_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Perché i valori non si possono salvare, o `null` se si può. */
export function motivoNonSalvabile(v: ValoriFinestraOrario): 'ora-mancante' | 'nota-mancante' | null {
    if (!ORA_HHMM.test(v.ora)) return 'ora-mancante';
    if (v.giustificato && v.nota.trim() === '') return 'nota-mancante';
    return null;
}

const NOTA_MAX = 500;

export function FinestraOrarioAppello({
    stato,
    nomeAlunno,
    iniziale,
    onSalva,
    onAnnulla,
}: {
    stato: StatoConOrario;
    nomeAlunno: string;
    iniziale: ValoriFinestraOrario;
    onSalva: (valori: ValoriFinestraOrario) => void;
    onAnnulla: () => void;
}) {
    const t = useTranslations('teacherPrimaria');
    const [ora, setOra] = useState(iniziale.ora);
    const [giustificato, setGiustificato] = useState(iniziale.giustificato);
    const [nota, setNota] = useState(iniziale.nota);

    const idTitolo = useId();
    const idOra = useId();
    const idSpunta = useId();
    const idNota = useId();
    const idMotivo = useId();

    const ritardo = stato === 'ritardo';
    const titolo = ritardo ? t('appelloFinestraTitoloRitardo') : t('appelloFinestraTitoloUscita');
    const motivo = motivoNonSalvabile({ ora, giustificato, nota });
    const notaMancante = motivo === 'nota-mancante';

    const salva = (e: FormEvent) => {
        e.preventDefault();
        // Anche il submit da tastiera (Invio nel campo ora) passa di qui: il bottone
        // fermo da solo non basterebbe.
        if (motivo !== null) return;
        onSalva({ ora, giustificato, nota: nota.trim() });
    };

    const BTN_PRIMARIO =
        'inline-flex min-h-[44px] items-center justify-center rounded-xl bg-kidville-green px-4 font-maven text-sm font-bold text-white transition-colors disabled:bg-kidville-neutral';
    const BTN_SECONDARIO =
        'inline-flex min-h-[44px] items-center justify-center rounded-xl border border-kidville-line px-4 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green';
    const CAMPO =
        'w-full rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none';

    return (
        // `labelledBy`: il titolo visibile è anche il nome accessibile, una volta sola.
        <Modal open onClose={onAnnulla} title={titolo} labelledBy={idTitolo} className="w-full max-w-md">
            <form onSubmit={salva} noValidate className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
                <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
                    {titolo}
                </h2>
                <p className="font-maven mt-0.5 text-xs text-kidville-sub">{nomeAlunno}</p>

                <div className="mt-4 space-y-4">
                    <div className="space-y-1">
                        <label htmlFor={idOra} className="block font-maven text-xs font-semibold text-kidville-sub">
                            {ritardo ? t('appelloFinestraOraIngresso') : t('appelloFinestraOraUscita')}
                        </label>
                        <input
                            id={idOra}
                            type="time"
                            value={ora}
                            onChange={(e) => setOra(e.target.value)}
                            required
                            aria-invalid={motivo === 'ora-mancante'}
                            aria-describedby={motivo === 'ora-mancante' ? idMotivo : undefined}
                            className={CAMPO}
                        />
                    </div>

                    <div className="flex items-start gap-2">
                        <input
                            id={idSpunta}
                            type="checkbox"
                            checked={giustificato}
                            onChange={(e) => setGiustificato(e.target.checked)}
                            className="mt-0.5 h-5 w-5 shrink-0 accent-kidville-green"
                        />
                        <label htmlFor={idSpunta} className="font-maven text-sm text-kidville-ink">
                            {t('appelloFinestraGiustificato')}
                        </label>
                    </div>

                    <div className="space-y-1">
                        <label htmlFor={idNota} className="block font-maven text-xs font-semibold text-kidville-sub">
                            {giustificato ? t('appelloFinestraNotaObbligatoria') : t('appelloFinestraNota')}
                        </label>
                        <textarea
                            id={idNota}
                            value={nota}
                            onChange={(e) => setNota(e.target.value)}
                            rows={2}
                            maxLength={NOTA_MAX}
                            placeholder={t('appelloFinestraNotaSegnaposto')}
                            required={giustificato}
                            aria-invalid={notaMancante}
                            aria-describedby={notaMancante ? idMotivo : undefined}
                            className={CAMPO}
                        />
                    </div>

                    {/* Il motivo per cui «Salva» è fermo, detto in chiaro e legato al campo
                        da riempire. `polite`: non è un errore del sistema, è un'istruzione.
                        La regione live è SEMPRE montata e cambia solo il contenuto: una
                        regione inserita nel DOM insieme al suo testo spesso non viene
                        annunciata (NVDA/VoiceOver), e chi spunta «Giustificato» non
                        saprebbe che la nota è diventata obbligatoria. Vuota resta
                        `sr-only`: non occupa spazio a schermo e non esce dall'albero
                        accessibile (con `hidden` o `display:none` ne uscirebbe). */}
                    <p
                        id={idMotivo}
                        aria-live="polite"
                        className={
                            motivo
                                ? 'rounded-2xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-ink'
                                : 'sr-only'
                        }
                    >
                        {motivo === 'nota-mancante'
                            ? t('appelloFinestraNotaManca')
                            : motivo === 'ora-mancante'
                                ? t('appelloFinestraOraManca')
                                : null}
                    </p>

                    <div className="flex flex-wrap justify-end gap-2">
                        <button type="button" onClick={onAnnulla} className={BTN_SECONDARIO}>
                            {t('appelloFinestraAnnulla')}
                        </button>
                        <button
                            type="submit"
                            disabled={motivo !== null}
                            aria-describedby={motivo ? idMotivo : undefined}
                            className={BTN_PRIMARIO}
                        >
                            {t('appelloFinestraSalva')}
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}
