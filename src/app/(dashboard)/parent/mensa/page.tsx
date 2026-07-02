'use client';

import { Suspense, useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

/** Banner pericolo allergeni (DL-043): il menù di oggi contiene allergeni del figlio. */
function AllergyBanner({ studentId, parentId }: { studentId: string; parentId: string }) {
  const [info, setInfo] = useState<{ pericolo: boolean; conflitti_label: string[] } | null>(null);
  useEffect(() => {
    if (!studentId) return;
    const today = new Date().toISOString().slice(0, 10);
    fetch(`/api/parent/mensa/allergie?alunno_id=${studentId}&date=${today}`, { headers: { 'x-user-id': parentId } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setInfo(d))
      .catch(() => {});
  }, [studentId, parentId]);

  if (!info?.pericolo) return null;
  return (
    <div className="mb-4 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft px-4 py-3 flex items-start gap-2.5">
      <AlertTriangle size={20} className="text-kidville-error flex-shrink-0 mt-0.5" strokeWidth={2} />
      <div>
        <p className="font-barlow font-bold text-sm text-kidville-error uppercase tracking-wide">Allergeni nel menù di oggi</p>
        <p className="font-maven text-xs text-kidville-error mt-0.5">
          Il menù di oggi contiene: <strong>{info.conflitti_label.join(', ')}</strong>. Verifica con la scuola prima di prenotare.
        </p>
      </div>
    </div>
  );
}

function Inner() {
  const { parentId, studentId, ready } = useParentIdentity();

  return (
    <div className="px-4 pt-6 pb-24">
      <header className="mb-5">
        <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
          Servizi
        </p>
        <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide leading-none">
          Mensa
        </h1>
        <p className="font-maven text-xs text-kidville-muted mt-1">Prenota il pranzo e consulta il menù della settimana.</p>
      </header>
      {ready
        ? <><AllergyBanner studentId={studentId} parentId={parentId} /><MensaCalendar userId={parentId} studentId={studentId} /></>
        : <div className="py-12 flex justify-center"><div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" /></div>
      }
    </div>
  );
}

export default function ParentMensaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <Inner />
    </Suspense>
  );
}
