'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, classiBadge, type BadgeTone } from '@/components/ui/Badge';
import { CODA_FATTURE_HREF } from '@/components/features/admin/admin-nav-config';
import { azioneConCoda } from '@/lib/pagamenti/fatturazione-riga';
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
 *
 * Dal 2026-09-24 (consegna 2b, D7) «Errore in coda» è il COLLEGAMENTO a quella pagina, con
 * la faccia del Badge (`classiBadge`, niente `span` annidato nell'`a`) e un nome accessibile
 * che dice dove porta. Se è un collegamento lo decide il motore (`azioneConCoda`), non questo
 * file. `min-h-6`: il Badge misura circa 23,5 px, sotto i 24 di WCAG 2.5.8.
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
            {coda && (azioneConCoda(codaStato) === 'vai_alla_coda'
                ? (
                    <Link href={CODA_FATTURE_HREF} data-testid="coda-chip" aria-label={t('fatChip_coda_errore_link')}
                        className={classiBadge(coda.tone, 'min-h-6 underline underline-offset-2')}>
                        {t(coda.labelKey)}
                    </Link>
                )
                : <Badge tone={coda.tone} data-testid="coda-chip">{t(coda.labelKey)}</Badge>)}
        </>
    );
}
