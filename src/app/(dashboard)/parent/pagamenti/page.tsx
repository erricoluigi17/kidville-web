'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';
import { SospensioneBanner } from '@/components/features/parent/SospensioneBanner';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// L'identità viene dalla sessione (URL → localStorage → /api/me), senza demo.
function Inner() {
    const t = useTranslations('pagamenti');
    const { userId } = useSessionIdentity();
    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow={t('eyebrow')}
                title={t('titolo')}
                subtitle={t('sottotitolo')}
                className="mb-5"
            />
            {userId && <SospensioneBanner userId={userId} className="mb-5" />}
            {userId && <StoricoPagamenti userId={userId} />}
        </div>
    );
}

export default function ParentPagamentiPage() {
    const t = useTranslations('pagamenti');
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>}>
            <Inner />
        </Suspense>
    );
}
