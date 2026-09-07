'use client';

/**
 * IL CHIP DELL'ORA CHE SI PUÒ CORREGGERE — condiviso fra i due gradi.
 *
 * Estratto da `StudentAttendanceRow` il 2026-09-07 perché l'appello della PRIMARIA
 * ne aveva bisogno: là c'era un `<input type="time">` nudo, mostrato per il solo
 * stato «ritardo» o «uscita anticipata», uno alla volta e senza conferma. Riscriverlo
 * avrebbe prodotto due gemelli destinati a divergere — e con loro due comportamenti
 * diversi per lo stesso gesto in due registri della stessa scuola.
 *
 * Resta nel namespace i18n `teacherPresenze`: è il catalogo di «l'orario di una
 * presenza», e le sue sei chiavi valgono per entrambi i gradi. La primaria le riusa
 * invece di clonarle — è la stessa scelta che questo file faceva già in senso
 * opposto, leggendo da `teacherPrimaria` l'etichetta della giustifica.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { oraDiRoma, oraDiRomaAdesso } from '@/lib/presenze/orario';

/** Quale dei due orari della giornata si sta toccando. */
export type CampoOrario = 'entrata' | 'uscita';

/**
 * ─── L'ORARIO È IL COMANDO ───────────────────────────────────────────────────
 *
 * A riposo questo componente rende **esattamente ciò che rendeva prima**: l'icona,
 * l'etichetta e l'ora. La differenza è che è un `<button>`, quindi l'affordance sta
 * dove sta il dato invece di occupare un posto suo nella riga — che a 320px va già
 * a capo. Al tocco il chip si trasforma NELLO STESSO SLOT in un campo ora con
 * conferma e annulla.
 *
 * ⚠️ Il colore è `text-kidville-sub` (#55615C: 6,46:1 su bianco, 5,82:1 sul crema
 * dell'hover) e non più `text-kidville-muted` (2,51:1). Quel muted era in
 * `testo-muted-allowlist.json` — discutibile per un testo passivo, indifendibile
 * per un comando tattile. La voce è stata tolta dall'allowlist, non aggirata.
 */
export function OrarioCorreggibile({
    campo,
    valore,
    etichetta,
    icona,
    alunno,
    nomeAlunno,
    ariaKey,
    inCorso,
    onSalva,
}: {
    campo: CampoOrario;
    valore: string | null;
    etichetta: string;
    icona: ReactNode;
    alunno: string;
    nomeAlunno: string;
    ariaKey: 'orarioIngressoAria' | 'orarioUscitaAria';
    inCorso: boolean;
    onSalva: ((ora: string) => void) | null;
}) {
    // Le traduzioni se le prende da sé: un chiamante nuovo (l'appello della primaria)
    // non deve sapere da quale namespace vengono le sei chiavi di questo chip.
    const t = useTranslations('teacherPresenze');
    const [inModifica, setInModifica] = useState(false);
    const [bozza, setBozza] = useState('');
    const rifInput = useRef<HTMLInputElement>(null);
    const rifChip = useRef<HTMLButtonElement>(null);

    // Dal MOTORE UNICO, mai da `.slice(0,5)` o `getHours()`: la colonna porta tre
    // forme diverse (HH:MM nudo, ISO naïve, istante con fuso) e solo `oraDiRoma` le
    // legge tutte e tre all'orologio di Roma.
    const ora = oraDiRoma(valore);
    const mostrato = ora ?? t('orarioNonRegistrato');

    useEffect(() => {
        if (inModifica) rifInput.current?.focus();
    }, [inModifica]);

    const chiudi = () => {
        setInModifica(false);
        rifChip.current?.focus();
    };

    const conferma = () => {
        // Un campo svuotato non è una correzione: cancellare l'ora d'ingresso di un
        // bambino presente non vuol dire niente, e si farebbe con un tocco distratto.
        if (!bozza || !onSalva) return;
        onSalva(bozza);
        // Si chiude SUBITO, come fa il resto di questa schermata: l'aggiornamento è
        // ottimistico e, se il server rifiuta, la pagina fa rollback e alza la
        // fascia `role="alert"` che nomina il bambino. Chiudere invece in un
        // `useEffect` appeso a `inCorso` sarebbe un `setState` dentro un effetto —
        // vietato dal lock `eslint-set-state-in-effect`, e per una buona ragione:
        // due render a catena per un'informazione che qui è già nota.
        setInModifica(false);
        rifChip.current?.focus();
    };

    // Senza `onSalva` la riga è quella di sempre: testo, non comando — e se l'ora
    // non c'è, NIENTE. Prima la condizione era `{checkInTime && …}`: mostrare
    // «Ingresso: non registrato» dove prima non compariva nulla sarebbe rumore in
    // una schermata che si legge di corsa. Il «non registrato» ha senso solo dove
    // è un invito a scriverlo, cioè quando l'ora si può correggere.
    if (!onSalva) {
        if (!ora) return null;
        return (
            <span className="flex items-center gap-1">
                {icona} {etichetta}: {ora}
            </span>
        );
    }

    if (inModifica) {
        return (
            <span className="flex items-center gap-1">
                <label className="sr-only" htmlFor={`input-orario-${campo}-${alunno}`}>
                    {t('orarioCampoAria')}
                </label>
                <input
                    ref={rifInput}
                    id={`input-orario-${campo}-${alunno}`}
                    type="time"
                    step={60}
                    value={bozza}
                    onChange={(e) => setBozza(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); conferma(); }
                        if (e.key === 'Escape') { e.preventDefault(); chiudi(); }
                    }}
                    className="min-h-11 rounded-xl border border-kidville-line bg-white px-2 font-maven text-sm text-kidville-sub"
                />
                <button
                    id={`btn-salva-orario-${campo}-${alunno}`}
                    onClick={conferma}
                    disabled={inCorso}
                    aria-label={t('salvaOrario')}
                    className="min-h-11 min-w-11 rounded-xl bg-kidville-green text-white flex items-center justify-center disabled:opacity-60"
                >
                    <Check size={16} />
                </button>
                <button
                    id={`btn-annulla-orario-${campo}-${alunno}`}
                    onClick={chiudi}
                    aria-label={t('annullaModifica')}
                    className="min-h-11 min-w-11 rounded-xl bg-kidville-cream text-kidville-sub border border-kidville-line flex items-center justify-center"
                >
                    <X size={16} />
                </button>
            </span>
        );
    }

    return (
        <button
            ref={rifChip}
            id={`btn-orario-${campo}-${alunno}`}
            onClick={() => { setBozza(ora ?? oraDiRomaAdesso()); setInModifica(true); }}
            aria-label={t(ariaKey, { alunno: nomeAlunno, ora: mostrato })}
            className="min-h-11 flex items-center gap-1 rounded-xl px-1 text-kidville-sub hover:bg-kidville-cream-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-kidville-green"
        >
            {icona} {etichetta}: {mostrato}
        </button>
    );
}
