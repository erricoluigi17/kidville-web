'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { Bell, MessageCircle, BookOpen, Camera, CalendarX2, GraduationCap } from 'lucide-react';
import { withIdentity } from '@/lib/auth/current-user';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { PagamentiSummary } from '@/components/features/parent/pagamenti/PagamentiSummary';
import { SectionHeader } from '@/components/features/parent/home/SectionHeader';
import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';
import { AvvisiPreview } from '@/components/features/parent/home/AvvisiPreview';
import { GalleryTodayCard } from '@/components/features/parent/home/GalleryTodayCard';
import { LockerTodayCard } from '@/components/features/parent/home/LockerTodayCard';
import { AgendaTodayCard } from '@/components/features/parent/home/AgendaTodayCard';
import { PresenzeTodayCard } from '@/components/features/parent/home/PresenzeTodayCard';

function greetingByHour() {
  const h = new Date().getHours();
  if (h < 12) return 'Buongiorno';
  if (h < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

interface QuickAction {
  id: string;
  label: string;
  icon: typeof Bell;
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
  const [mascotFailed, setMascotFailed] = useState(false);

  // Saluto dipendente dall'ora locale: calcolato SOLO client-side (SSR-safe)
  // per evitare il mismatch di hydration server-UTC vs browser.
  const greeting = useClientValue(greetingByHour, '');

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
      bg: '#FDE8E7',
      fg: '#E53935',
    },
    { id: 'chat', label: 'Scrivi\nmaestra', icon: MessageCircle, href: wi('/parent/chat'), bg: '#E2EEEC', fg: '#006A5F' },
    { id: 'foto', label: 'Vedi\nfoto', icon: Camera, href: wi('/parent/gallery'), bg: '#FBF0DD', fg: '#E6B100' },
    // Il diario giornaliero è solo nido/infanzia: per la primaria l'azione
    // diventa l'area Scuola (lezioni, compiti, voti), senza la parola "Diario".
    isPrimaria
      ? { id: 'scuola', label: 'Scuola\nprimaria', icon: GraduationCap, href: wi('/parent/primaria'), bg: '#EAF3EC', fg: '#43A047' }
      : { id: 'diario', label: 'Diario\ndi oggi', icon: BookOpen, href: wi('/parent/diary'), bg: '#EAF3EC', fg: '#43A047' },
  ];

  return (
    <div className="min-h-screen bg-kidville-cream pb-[100px]">

      {/* ── HERO (DR warm) ─────────────────────────── */}
      <div className="px-4 pt-4">
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-[28px]"
          style={{ backgroundColor: '#FDC400', minHeight: 150 }}
        >
          {/* top row: logo + campanella → avvisi */}
          <div className="relative z-[2] flex items-center justify-between px-5 pt-5">
            {/* M9.5: logo statico su next/image; resa identica (height 18, width auto dal rapporto intrinseco) */}
            <Image src="/logo_green.png" alt="Kidville" width={192} height={108} priority style={{ height: 18, width: 'auto', display: 'block' }} />
            <Link
              href={wi('/parent/avvisi')}
              aria-label="Avvisi"
              className="relative flex h-[38px] w-[38px] items-center justify-center rounded-full"
              style={{ background: 'rgba(0,106,95,0.12)', color: '#006A5F' }}
            >
              <Bell size={19} />
            </Link>
          </div>

          {/* greeting */}
          <div className="relative z-[2] px-5 pb-6 pt-3" style={{ maxWidth: '64%' }}>
            <p className="mb-0.5 font-maven text-xs font-semibold capitalize" style={{ color: 'rgba(0,84,75,0.7)' }}>
              {greeting}{greeting ? '!' : ''}
            </p>
            {nameLoading ? (
              // Placeholder discreto: evita il flash "Benvenuta!" → "Ciao, Nome"
              // prima che il nome sia risolto.
              <div className="h-9 w-44 max-w-full rounded-lg bg-black/5 animate-pulse" aria-hidden="true" />
            ) : (
              <h1
                className="whitespace-pre-line font-barlow font-black uppercase leading-[0.98] tracking-tight"
                style={{ fontSize: 30, color: '#006A5F' }}
              >
                {firstName ? `Ciao,\n${firstName}!` : 'Ciao!'}
              </h1>
            )}
            {firstName && (
              <p className="mt-1.5 font-maven text-[13px]" style={{ color: 'rgba(0,84,75,0.78)' }}>
                Ecco le novità di oggi 🌈
              </p>
            )}
          </div>

          {/* mascotte */}
          <div className="pointer-events-none absolute bottom-0 right-0 z-[1] flex items-end justify-end" style={{ width: 150, height: '100%' }}>
            {!mascotFailed ? (
              /* Salva la mascotte in /public/mascot.png per visualizzarla.
                 M9.5: next/image (intrinseco 792×1040 in scala), resa identica. */
              <Image
                src="/mascot.png"
                alt="Mascotte Kidville"
                width={198}
                height={260}
                priority
                onError={() => setMascotFailed(true)}
                className="select-none object-contain object-bottom drop-shadow-xl"
                style={{ height: 128, width: 'auto' }}
              />
            ) : (
              <div className="flex select-none items-center justify-center text-[80px] opacity-30" style={{ width: 150, height: 150 }}>
                🎩
              </div>
            )}
          </div>
        </motion.div>
      </div>

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
              <span
                className="flex h-[42px] w-[42px] items-center justify-center rounded-[14px]"
                style={{ background: a.bg, color: a.fg }}
              >
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
