'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { BookOpen, Users, ChevronRight } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { GradeWorldSwitch } from '@/components/features/teacher/GradeWorldSwitch';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

interface Classe {
  id: string;
  name: string;
  scholastic_year?: string | null;
  numAlunni: number;
}

function HubInner() {
  const t = useTranslations('teacherPrimaria');
  const params = useSearchParams();
  const userId = getCurrentTeacherId(params);
  const [classi, setClassi] = useState<Classe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/primaria/classi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setClassi(d.data);
        else setError(d.error || t('comuneErrore'));
      })
      .catch(() => setError(t('comuneErroreRete')))
      .finally(() => setLoading(false));
  }, [userId, t]);

  return (
    <div className="min-h-screen bg-kidville-cream/40">
      <div className="mx-auto max-w-[460px] px-4 pt-5">
        {/* Header verde (DR) */}
        <PageHeaderCard eyebrow={t('hubEyebrow')} title={t('hubTitolo')} />
        <div className="mt-3">
          <GradeWorldSwitch />
        </div>

        {error && <div className="mt-4 rounded-card bg-kidville-error/10 px-4 py-3 font-maven text-sm text-kidville-error">{error}</div>}

        {loading ? (
          <p className="mt-5 font-maven text-kidville-muted">{t('comuneCaricamento')}</p>
        ) : classi.length === 0 ? (
          <div className="mt-5 flex items-center gap-3 rounded-2xl border-[1.5px] border-dashed border-kidville-line bg-white/60 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kidville-cream-dark text-kidville-muted">
              <BookOpen size={20} />
            </div>
            <span className="font-maven text-[11.5px] leading-snug text-kidville-muted">
              {t('hubNessunaClasse')}
            </span>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {classi.map((c) => (
              <Link
                key={c.id}
                href={`/teacher/primaria/${c.id}?userId=${userId}`}
                className="group flex items-center gap-3.5 rounded-[18px] bg-white p-4 shadow-sm transition hover:shadow-md"
              >
                <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[15px] bg-kidville-green px-1 text-center font-barlow text-sm font-black uppercase leading-tight text-kidville-yellow [word-break:break-word]">
                  {c.name}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-barlow text-lg font-black uppercase leading-none text-kidville-green">{t('hubClasse', { name: c.name })}</p>
                  <p className="mt-1.5 flex items-center gap-3 font-maven text-xs text-kidville-muted">
                    <span className="flex items-center gap-1"><Users size={13} /> {t('hubAlunni', { count: c.numAlunni })}</span>
                    {c.scholastic_year ? <span>{c.scholastic_year}</span> : null}
                  </p>
                </div>
                <ChevronRight className="text-kidville-green" size={20} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PrimariaHubPage() {
  const t = useTranslations('teacherPrimaria');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('comuneCaricamento')}</div>}>
      <HubInner />
    </Suspense>
  );
}
