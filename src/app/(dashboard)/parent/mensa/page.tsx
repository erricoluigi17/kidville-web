'use client';

import { Suspense, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

/** Banner pericolo allergeni (DL-043): il menù di oggi contiene allergeni del figlio. */
function AllergyBanner({ studentId, parentId }: { studentId: string; parentId: string }) {
  const t = useTranslations('mensa');
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
        <p className="font-barlow font-bold text-sm text-kidville-error uppercase tracking-wide">{t('allergiaTitolo')}</p>
        <p className="font-maven text-xs text-kidville-error mt-0.5">
          {t.rich('allergiaCorpo', {
            elenco: info.conflitti_label.join(', '),
            strong: (c) => <strong>{c}</strong>,
          })}
        </p>
      </div>
    </div>
  );
}

function Inner() {
  const t = useTranslations('mensa');
  const { parentId, studentId, ready } = useParentIdentity();

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('eyebrow')}
        title={t('titolo')}
        subtitle={t('sottotitolo')}
        className="mb-5"
      />
      {!ready || !parentId ? (
        <div className="py-12 flex justify-center"><div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" /></div>
      ) : !studentId ? (
        <div className="rounded-2xl border border-kidville-line bg-white px-4 py-6 text-center">
          <p className="font-maven text-sm text-kidville-ink">{t('nessunAlunno')}</p>
          <p className="font-maven text-xs text-kidville-muted mt-1">{t('nessunAlunnoAiuto')}</p>
        </div>
      ) : (
        <><AllergyBanner studentId={studentId} parentId={parentId} /><MensaCalendar userId={parentId} studentId={studentId} /></>
      )}
    </div>
  );
}

export default function ParentMensaPage() {
  const t = useTranslations('mensa');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <Inner />
    </Suspense>
  );
}
