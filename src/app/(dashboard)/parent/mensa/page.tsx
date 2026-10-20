'use client';

import { Suspense, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { logClient, nomeErrore } from '@/lib/logging/client';

/** Banner pericolo allergeni (DL-043): il menù di oggi contiene allergeni del figlio. */
function AllergyBanner({ studentId, parentId }: { studentId: string; parentId: string }) {
  const t = useTranslations('mensa');
  const [info, setInfo] = useState<{ pericolo: boolean; conflitti_label: string[] } | null>(null);
  // Fase 11: un controllo che non risponde NON è «nessun allergene». Prima il banner taceva sia
  // quando il menù era sicuro sia quando la verifica era caduta; ora il secondo caso lo dice.
  const [nonVerificati, setNonVerificati] = useState(false);
  useEffect(() => {
    if (!studentId) return;
    const today = new Date().toISOString().slice(0, 10);
    fetch(`/api/parent/mensa/allergie?alunno_id=${studentId}&date=${today}`, { headers: { 'x-user-id': parentId } })
      .then(r => {
        if (!r.ok) {
          logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-allergeni-non-verificati: http ${r.status}` });
          setNonVerificati(true);
          return null;
        }
        return r.json();
      })
      .then(d => { if (d) setInfo(d); })
      .catch((err) => {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-allergeni-non-verificati: ${nomeErrore(err)}` });
        setNonVerificati(true);
      });
  }, [studentId, parentId]);

  if (nonVerificati && !info) {
    return (
      <div role="status" className="mb-4 rounded-2xl border border-kidville-line bg-white px-4 py-3 flex items-start gap-2.5">
        <AlertTriangle size={20} className="text-kidville-sub flex-shrink-0 mt-0.5" strokeWidth={2} />
        <div>
          <p className="font-barlow font-bold text-sm text-kidville-ink uppercase tracking-wide">{t('allergiaNonVerificataTitolo')}</p>
          <p className="font-maven text-xs text-kidville-sub mt-0.5">{t('allergiaNonVerificataCorpo')}</p>
        </div>
      </div>
    );
  }
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
