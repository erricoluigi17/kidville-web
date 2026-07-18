'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { MessageCircle, BookOpen, Camera, CalendarX2, GraduationCap } from 'lucide-react';
import { withIdentity } from '@/lib/auth/current-user';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { HeroCard } from '@/components/features/shell/HeroCard';
import { SospensioneBanner } from '@/components/features/parent/SospensioneBanner';
import { PagamentiSummary } from '@/components/features/parent/pagamenti/PagamentiSummary';
import { SectionHeader } from '@/components/features/parent/home/SectionHeader';
import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';
import { AvvisiPreview } from '@/components/features/parent/home/AvvisiPreview';
import { GalleryTodayCard } from '@/components/features/parent/home/GalleryTodayCard';
import { LockerTodayCard } from '@/components/features/parent/home/LockerTodayCard';
import { AgendaTodayCard } from '@/components/features/parent/home/AgendaTodayCard';
import { PresenzeTodayCard } from '@/components/features/parent/home/PresenzeTodayCard';

interface QuickAction {
  id: string;
  label: string;
  icon: typeof MessageCircle;
  href: string;
  bg: string;
  fg: string;
}

function ParentHomeContent() {
  const { parentId, studentId } = useParentIdentity();
  const { schoolType } = useChildSchoolType();
  const isPrimaria = schoolType === 'primaria';

  const [firstName, setFirstName] = useState('');
  const [nameResolved, setNameResolved] = useState(false);

  useEffect(() => {
    if (!studentId) return;
    fetch(`/api/diary/students?id=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setFirstName(d.nome ?? '');
      })
      .catch(() => {})
      .finally(() => setNameResolved(true));
  }, [studentId]);

  // Skeleton finché il nome non è risolto (evita il flash del fallback).
  // Con studentId assente non si resta in caricamento: si mostra il saluto neutro.
  const nameLoading = !!studentId && !nameResolved;

  // Azioni rapide (DR QuickActions): solo navigazione verso pagine reali.
  // "Segnala assenza" porta alla pagina assenze (dove vive il submit reale).
  const wi = (href: string) => withIdentity(href, parentId, studentId);
  const quickActions: QuickAction[] = [
    {
      id: 'absence',
      label: 'Segnala\nassenza',
      icon: CalendarX2,
      href: wi(isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance'),
      bg: 'bg-kidville-error-soft',
      fg: 'text-kidville-error',
    },
    { id: 'chat', label: 'Scrivi\nmaestra', icon: MessageCircle, href: wi('/parent/chat'), bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
    { id: 'foto', label: 'Vedi\nfoto', icon: Camera, href: wi('/parent/gallery'), bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
    // Il diario giornaliero è solo nido/infanzia: per la primaria l'azione
    // diventa l'area Scuola (lezioni, compiti, voti), senza la parola "Diario".
    isPrimaria
      ? { id: 'scuola', label: 'Scuola\nprimaria', icon: GraduationCap, href: wi('/parent/primaria'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' }
      : { id: 'diario', label: 'Diario\ndi oggi', icon: BookOpen, href: wi('/parent/diary'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
  ];

  return (
    <div className="min-h-screen bg-kidville-cream pb-[100px]">

      {/* ── HERO (DR warm) — wordmark/campanella nella AppBar ───────── */}
      <div className="px-4 pt-5">
        <HeroCard
          title={firstName ? `Ciao,\n${firstName}!` : 'Ciao!'}
          loading={nameLoading}
          subtitle={firstName ? 'Ecco le novità di oggi 🌈' : undefined}
        />
      </div>

      {/* ── BANNER SOSPENSIONE (solo se la famiglia è sospesa) ─────── */}
      {parentId && <SospensioneBanner userId={parentId} className="px-4 pt-4" />}

      {/* ── QUICK ACTIONS ──────────────────────────── */}
      <div className="grid grid-cols-4 gap-[9px] px-4 pt-4">
        {quickActions.map((a) => {
          const Icon = a.icon;
          return (
            <Link
              key={a.id}
              href={a.href}
              className="flex flex-col items-center gap-[7px] rounded-[18px] bg-white px-1 py-3 active:scale-95"
              style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}
            >
              <span className={`flex h-[42px] w-[42px] items-center justify-center rounded-[14px] ${a.bg} ${a.fg}`}>
                <Icon size={21} strokeWidth={1.9} />
              </span>
              <span className="whitespace-pre-line text-center font-barlow text-[11.5px] font-bold uppercase leading-[1.05] tracking-[0.02em] text-kidville-green">
                {a.label}
              </span>
            </Link>
          );
        })}
      </div>

      {/* ── PRESENZE OGGI (badge "A scuola" reale) ── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader
            eyebrow="Presenze"
            title="Oggi a scuola"
            actionLabel="Storico"
            actionHref={wi(isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance')}
          />
          <PresenzeTodayCard studentId={studentId} parentId={parentId} />
        </div>
      )}

      {/* ── RIEPILOGO PAGAMENTI ───────────────────── */}
      {parentId && (
        <div className="pt-4">
          <PagamentiSummary userId={parentId} href={wi('/parent/pagamenti')} />
        </div>
      )}

      {/* ── DIARIO OGGI (solo infanzia) ───────────── */}
      {!isPrimaria && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow="Diario" title={firstName ? `La giornata di ${firstName}` : 'Il diario'} />
          <DiaryTodayCard studentId={studentId} href={wi('/parent/diary')} />
        </div>
      )}

      {/* ── AVVISI (top 2, sola lettura) ──────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow="Comunicazioni" title="Avvisi" actionLabel="Tutti" actionHref={wi('/parent/avvisi')} />
          <AvvisiPreview parentId={parentId} studentId={studentId} />
        </div>
      )}

      {/* ── GALLERIA OGGI ─────────────────────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow="Galleria" title="Foto di oggi" actionLabel="Tutte" actionHref={wi('/parent/gallery')} />
          <GalleryTodayCard studentId={studentId} parentId={parentId} href={wi('/parent/gallery')} />
        </div>
      )}

      {/* ── ARMADIETTO · SCORTE (teaser DR) ───────── */}
      {studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow="Armadietto" title="Scorte" actionLabel="Gestisci" actionHref={wi('/parent/locker')} />
          <LockerTodayCard studentId={studentId} />
        </div>
      )}

      {/* ── CALENDARIO · AGENDA (eventi_agenda M6) ── */}
      <div className="px-4 pt-5">
        <SectionHeader eyebrow="Calendario" title="Prossimi appuntamenti" />
        <AgendaTodayCard studentId={studentId} />
      </div>

      {/* ── NOTA / FOOTER ─────────────────────────── */}
      <p className="px-4 pt-6 text-center font-maven text-[11px] text-kidville-muted">
        Le informazioni restano visibili per 14 giorni · Kidville
      </p>
    </div>
  );
}

export default function ParentHomePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[60vh] bg-kidville-cream">
        <div className="w-8 h-8 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
      </div>
    }>
      <ParentHomeContent />
    </Suspense>
  );
}
