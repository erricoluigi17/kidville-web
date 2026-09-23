'use client';

import { useTranslations } from 'next-intl';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
// `import type`: `@/lib/fatture-coda/api` tira dentro `next/server` e il logger del server.
import type { StatoCodaAttivo } from '@/lib/fatture-coda/api';

const CHIP: Record<string, { labelKey: string; tone: BadgeTone }> = {
    in_attesa: { labelKey: 'fatChip_attesa', tone: 'warn' },
    emessa: { labelKey: 'fatChip_fatturata', tone: 'success' },
    scartata: { labelKey: 'fatChip_scartata', tone: 'error' },
};

/**
 * La voce ATTIVA della coda fatture (consegna 2a, rilievo e). Blu mentre aspetta o parte;
 * rosso sull'errore, l'unico dei tre che chiede di agire (pagina «Coda fatture»).
 */
const CODA: Record<StatoCodaAttivo, { labelKey: string; tone: BadgeTone }> = {
    in_coda: { labelKey: 'fatChip_coda_in_coda', tone: 'inCorso' },
    in_invio: { labelKey: 'fatChip_coda_in_invio', tone: 'inCorso' },
    errore: { labelKey: 'fatChip_coda_errore', tone: 'error' },
};

/**
 * Chip informativo sullo stato di fatturazione di un pagamento, più la sua voce in coda.
 * "Da fatturare" compare SOLO sui saldati: l'emissione resta un'azione
 * esplicita della segreteria (FatturaButton), mai automatica.
 */
export function FatturaChip({ stato, fatturaStato, codaStato }: {
    stato: string;
    fatturaStato?: string | null;
    codaStato?: StatoCodaAttivo | null;
}) {
    const t = useTranslations('adminContabilita');
    const cfg = CHIP[fatturaStato ?? ''] ?? (stato === 'pagato' ? { labelKey: 'fatChip_da_fatturare', tone: 'neutral' as BadgeTone } : null);
    const coda = codaStato ? CODA[codaStato] ?? null : null;
    if (!cfg && !coda) return null;
    return (
        <>
            {cfg && <Badge tone={cfg.tone}>{t(cfg.labelKey)}</Badge>}
            {coda && <Badge tone={coda.tone} data-testid="coda-chip">{t(coda.labelKey)}</Badge>}
        </>
    );
}
