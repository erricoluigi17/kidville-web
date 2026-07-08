'use client';

// Skeleton di caricamento della schermata chat: riproduce header + lista thread
// (avatar + due righe) per una percezione di caricamento migliore rispetto al
// solo spinner. Nessuna dipendenza extra: usa animate-pulse di Tailwind.

function SkeletonRow() {
    return (
        <div className="w-full flex items-center gap-3 px-4 py-3.5">
            <div className="w-11 h-11 rounded-full bg-kidville-line/70 flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
                <div className="h-3 w-2/5 rounded bg-kidville-line/70" />
                <div className="h-2.5 w-3/4 rounded bg-kidville-line/50" />
            </div>
        </div>
    );
}

export function ChatListSkeleton() {
    const rows = [0, 1, 2, 3, 4];
    return (
        <div
            className="max-w-5xl mx-auto p-4 sm:p-6 animate-pulse"
            aria-busy="true"
            aria-label="Caricamento chat"
        >
            {/* Header */}
            <div className="mb-4">
                <div className="h-3 w-28 rounded bg-kidville-line/70 mb-2" />
                <div className="h-8 w-44 rounded-lg bg-kidville-line/70 mb-2" />
                <div className="h-3 w-64 max-w-[70%] rounded bg-kidville-line/50" />
            </div>

            {/* Desktop: due colonne (lista + area conversazione) */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px)] min-h-[500px] mb-24">
                <div className="w-80 flex-shrink-0 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b border-kidville-line">
                        <div className="h-3 w-24 rounded bg-kidville-line/70" />
                    </div>
                    <div className="divide-y divide-gray-100/60">
                        {rows.map(i => <SkeletonRow key={i} />)}
                    </div>
                </div>
                <div className="flex-1 bg-white rounded-3xl border border-kidville-line shadow-sm flex items-center justify-center">
                    <div className="w-20 h-20 rounded-full bg-kidville-line/50" />
                </div>
            </div>

            {/* Mobile: singolo pannello lista */}
            <div className="md:hidden bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                <div className="divide-y divide-gray-100/60">
                    {rows.map(i => <SkeletonRow key={i} />)}
                </div>
            </div>
        </div>
    );
}
