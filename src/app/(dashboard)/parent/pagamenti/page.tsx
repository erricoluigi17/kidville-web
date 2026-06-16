'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Euro } from 'lucide-react';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';
import { getCurrentParentId } from '@/lib/auth/current-user';

function Inner() {
    const params = useSearchParams();
    const userId = getCurrentParentId(params);
    return (
        <div className="px-4 pt-6 pb-24">
            <header className="mb-5">
                <h1 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                    <Euro size={22} /> Pagamenti
                </h1>
                <p className="font-maven text-xs text-gray-500">Storico pagamenti effettuati e da effettuare.</p>
            </header>
            <StoricoPagamenti userId={userId} />
        </div>
    );
}

export default function ParentPagamentiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
            <Inner />
        </Suspense>
    );
}
