'use client';

import { CheckCircle2, Circle, FileSignature, Euro } from 'lucide-react';

interface Props {
    autorizzato: boolean;
    quotaOk: boolean;
    compact?: boolean;
}

// Semaforo gita/uscita per l'insegnante: verde solo se autorizzazione firmata
// E quota gita saldata. NESSUN dato economico mostrato (solo stato ok/non ok).
export function SemaforoAutorizzazione({ autorizzato, quotaOk, compact }: Props) {
    const verde = autorizzato && quotaOk;

    if (compact) {
        return verde
            ? <CheckCircle2 size={18} className="text-kidville-success" aria-label="Pronto per l'uscita" />
            : <Circle size={18} className="text-kidville-muted" aria-label="Non pronto" />;
    }

    return (
        <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${verde ? 'bg-kidville-success' : 'bg-gray-300'}`} />
            <span className="flex items-center gap-1 font-maven text-xs" title="Autorizzazione firmata">
                <FileSignature size={13} className={autorizzato ? 'text-kidville-success' : 'text-kidville-muted'} />
                {autorizzato ? 'Firmata' : 'Non firmata'}
            </span>
            <span className="flex items-center gap-1 font-maven text-xs" title="Quota saldata">
                <Euro size={13} className={quotaOk ? 'text-kidville-success' : 'text-kidville-muted'} />
                {quotaOk ? 'Saldata' : 'Da saldare'}
            </span>
        </div>
    );
}
