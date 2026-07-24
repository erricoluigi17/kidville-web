import { CloudOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Indicatore non invasivo mostrato quando i dati in schermata provengono dalla
 * cache locale (offline) invece che dalla rete. Piccola pill grigia coerente col
 * design Kidville.
 *
 * Colore testo: `text-kidville-sub` (non `-muted`) per rispettare il contrasto AA
 * su `bg-kidville-neutral-soft` (5,76:1 vs ~2,2:1 di `-muted`), mantenendo l'aspetto
 * grigio/neutro richiesto.
 */
export function OfflineBadge({ className = '' }: { className?: string }) {
    const t = useTranslations('shared');
    return (
        <div
            role="status"
            className={`inline-flex items-center gap-1.5 rounded-full bg-kidville-neutral-soft px-2.5 py-1 font-maven text-[11px] font-semibold text-kidville-sub ${className}`}
        >
            <CloudOff size={12} className="flex-shrink-0" aria-hidden="true" />
            <span>{t('datiNonAggiornati')}</span>
        </div>
    );
}
