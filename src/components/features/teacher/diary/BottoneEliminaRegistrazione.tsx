'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * LA PORTA D'USCITA DI UNA REGISTRAZIONE SEGNATA PER ERRORE.
 *
 * Nasce dalla nanna, dove viveva in linea dentro la sua card. Dal 2026-09-08 serve
 * anche al bagno e ai pasti, che sono diventati selettivi come lei — e con il
 * salvataggio selettivo «azzera i campi e risalva» smette di cancellare: il bambino
 * esce dal payload, la riga resta in archivio, e a schermo i campi sono vuoti, la ✅
 * è sparita e il toast è verde. Un no-op che sembra riuscito.
 *
 * Per il bagno è peggio che per la nanna: la riga sbagliata NON è vuota — porta
 * `{pipi:2, cacca:1}` — quindi nemmeno il filtro di lettura la rende inerte, e il
 * genitore continua a leggere «Ho fatto pipì 2 volte» del figlio di un altro.
 *
 * Compare SOLO su una registrazione che esiste davvero in archivio (la ✅): un
 * cestino su una riga che non c'è prometterebbe una cancellazione impossibile.
 */
export function BottoneEliminaRegistrazione({
    nome, evento, haNota, onElimina,
}: {
    nome: string;
    /** L'etichetta leggibile della routine («Bagno», «Pranzo»…), per la domanda. */
    evento: string;
    /** La nota per-bambino sta sulla STESSA riga e sparisce con lei: chi conferma deve saperlo. */
    haNota: boolean;
    onElimina: () => void;
}) {
    const t = useTranslations('teacherDiario');
    return (
        <button
            type="button"
            onClick={() => {
                const domanda = haNota
                    ? t('confermaEliminaConNota', { nome, evento })
                    : t('confermaElimina', { nome, evento });
                if (!confirm(domanda)) return;
                onElimina();
            }}
            aria-label={t('eliminaAria', { nome })}
            className="flex-shrink-0 min-h-[44px] px-2 rounded-xl text-kidville-error-strong font-maven text-xs font-semibold flex items-center gap-1 hover:bg-kidville-error-soft transition-colors"
        >
            <Trash2 size={14} strokeWidth={1.5} /> {t('eliminaRegistrazione')}
        </button>
    );
}
