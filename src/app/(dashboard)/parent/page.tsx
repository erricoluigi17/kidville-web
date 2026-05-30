'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'framer-motion';
import {
  Bell, MessageCircle, BookOpen, Image as ImageIcon,
  Package, FileText, BarChart3, CheckSquare, ChevronRight,
} from 'lucide-react';

const DEFAULT_STUDENT_ID = 'dc617529-e80d-4084-9041-fb28e864089f';

const tiles = [
  {
    id: 'avvisi',
    label: 'Avvisi',
    desc: 'Comunicazioni',
    icon: Bell,
    href: '/parent/avvisi',
    bg: '#006A5F',
    fg: '#FDC400',
    sub: 'rgba(253,196,0,0.55)',
  },
  {
    id: 'chat',
    label: 'Chat',
    desc: 'Messaggi',
    icon: MessageCircle,
    href: '/parent/chat',
    bg: '#FDC400',
    fg: '#006A5F',
    sub: 'rgba(0,106,95,0.55)',
  },
  {
    id: 'diario',
    label: 'Diario',
    desc: 'Giornata scolastica',
    icon: BookOpen,
    href: '/parent/diary',
    bg: '#FFF8E1',
    fg: '#006A5F',
    sub: '#A0A0A0',
  },
  {
    id: 'gallery',
    label: 'Galleria',
    desc: 'Foto & video',
    icon: ImageIcon,
    href: '/parent/gallery',
    bg: '#E8F5F3',
    fg: '#006A5F',
    sub: '#A0A0A0',
  },
  {
    id: 'modulistica',
    label: 'Moduli',
    desc: 'Documenti firmati',
    icon: FileText,
    href: '/parent/modulistica',
    bg: '#006A5F',
    fg: '#FDC400',
    sub: 'rgba(253,196,0,0.55)',
  },
  {
    id: 'register',
    label: 'Registro',
    desc: 'Voti & note',
    icon: BarChart3,
    href: '/parent/register',
    bg: '#FDC400',
    fg: '#006A5F',
    sub: 'rgba(0,106,95,0.55)',
  },
  {
    id: 'locker',
    label: 'Armadietto',
    desc: 'Materiali scolastici',
    icon: Package,
    href: '/parent/locker',
    bg: '#FFF8E1',
    fg: '#006A5F',
    sub: '#A0A0A0',
  },
  {
    id: 'attendance',
    label: 'Presenze',
    desc: 'Gestione assenze',
    icon: CheckSquare,
    href: '/parent/attendance',
    bg: '#E8F5F3',
    fg: '#006A5F',
    sub: '#A0A0A0',
  },
] as const;

function greetingByHour() {
  const h = new Date().getHours();
  if (h < 12) return 'Buongiorno';
  if (h < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

function ParentHomeContent() {
  const searchParams = useSearchParams();
  const studentId = searchParams.get('id') || DEFAULT_STUDENT_ID;

  const [studentName, setStudentName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [classe, setClasse] = useState('');
  const [mascotFailed, setMascotFailed] = useState(false);

  useEffect(() => {
    fetch(`/api/diary/students?id=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const full = `${d.nome ?? ''} ${d.cognome ?? ''}`.trim();
        setStudentName(full);
        setFirstName(d.nome ?? '');
        if (d.classe_sezione) setClasse(d.classe_sezione);
      })
      .catch(() => {});
  }, [studentId]);

  const initials = studentName
    ? studentName.split(' ').map((w: string) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
    : '';

  return (
    <div className="min-h-screen bg-kidville-cream pb-[100px]">

      {/* ── TOP BAR ───────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 pt-12 pb-3">
        <div className="flex-1 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo_green.png"
            alt="Kidville"
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
        </div>
        {initials && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3, type: 'spring', stiffness: 400, damping: 20 }}
            className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center shadow-sm"
          >
            <span className="font-barlow font-black text-xs text-kidville-yellow">{initials}</span>
          </motion.div>
        )}
      </div>

      {/* ── HERO CARD ─────────────────────────────── */}
      <div className="px-4 mb-4">
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-[28px]"
          style={{ backgroundColor: '#FDC400', minHeight: 166 }}
        >
          {/* Testo */}
          <div className="px-6 pt-6 pb-6" style={{ paddingRight: 160 }}>
            <p className="font-maven text-sm font-medium mb-1" style={{ color: 'rgba(0,106,95,0.65)' }}>
              {greetingByHour()}!
            </p>
            <h1
              className="font-barlow font-black uppercase leading-[1.0] tracking-tight"
              style={{ fontSize: 38, color: '#006A5F' }}
            >
              {firstName ? `Ciao,\n${firstName}!` : 'Benvenuta!'}
            </h1>
            {firstName && (
              <p className="font-maven text-sm mt-2 leading-snug" style={{ color: 'rgba(0,106,95,0.6)' }}>
                La giornata di {firstName}<br />è già iniziata ✨
              </p>
            )}
          </div>

          {/* Mascotte */}
          <div className="absolute right-0 bottom-0 flex items-end justify-end pointer-events-none"
            style={{ width: 155, height: '100%' }}>
            {!mascotFailed ? (
              /* Salva la mascotte in /public/mascot.png per visualizzarla */
              <img
                src="/mascot.png"
                alt="Mascotte Kidville"
                onError={() => setMascotFailed(true)}
                className="object-contain object-bottom drop-shadow-xl select-none"
                style={{ height: 162, width: 'auto' }}
              />
            ) : (
              <div
                className="flex items-center justify-center text-[80px] opacity-30 select-none"
                style={{ width: 155, height: 155 }}
              >
                🎩
              </div>
            )}
          </div>

          {/* Cerchi decorativi */}
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              width: 120, height: 120,
              top: -30, right: -30,
              backgroundColor: 'rgba(255,255,255,0.12)',
            }}
          />
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              width: 70, height: 70,
              bottom: -20, right: 90,
              backgroundColor: 'rgba(255,255,255,0.12)',
            }}
          />
        </motion.div>
      </div>

      {/* ── STUDENT BADGE ─────────────────────────── */}
      {studentName && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, duration: 0.4 }}
          className="mx-4 mb-5"
        >
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-2xl border"
            style={{ backgroundColor: 'rgba(255,255,255,0.80)', borderColor: 'rgba(255,255,255,0.5)' }}
          >
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: '#006A5F' }}
            >
              <span className="font-barlow font-black text-sm" style={{ color: '#FDC400' }}>
                {initials}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-barlow font-black text-base uppercase tracking-wide truncate leading-tight text-kidville-green">
                {studentName}
              </p>
              {classe && (
                <p className="font-maven text-xs text-gray-400 mt-0.5">Classe {classe}</p>
              )}
            </div>
            <div
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 flex-shrink-0"
              style={{ backgroundColor: 'rgba(253,196,0,0.18)' }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-kidville-success" />
              <span className="font-maven text-[10px] font-semibold text-kidville-green">
                A scuola
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── SECTION HEADER ────────────────────────── */}
      <div className="flex items-center gap-3 px-4 mb-3">
        <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide whitespace-nowrap">
          Sezioni
        </h2>
        <div className="h-px flex-1 bg-gradient-to-r from-kidville-green/25 to-transparent" />
      </div>

      {/* ── TILE GRID ─────────────────────────────── */}
      <div className="px-4 grid grid-cols-2 gap-3">
        {tiles.map((tile, i) => {
          const Icon = tile.icon;
          return (
            <motion.div
              key={tile.id}
              initial={{ opacity: 0, y: 18, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{
                delay: 0.08 + i * 0.045,
                duration: 0.38,
                ease: [0.22, 1, 0.36, 1],
              }}
              whileHover={{ scale: 1.03, y: -2 }}
              whileTap={{ scale: 0.96 }}
            >
              <Link href={tile.href} className="block h-full">
                <div
                  className="relative overflow-hidden rounded-[20px] p-4 h-full min-h-[110px] flex flex-col"
                  style={{ backgroundColor: tile.bg }}
                >
                  {/* Cerchio decorativo */}
                  <div
                    className="absolute -top-4 -right-4 rounded-full pointer-events-none"
                    style={{
                      width: 64, height: 64,
                      backgroundColor: tile.fg === '#FDC400'
                        ? 'rgba(253,196,0,0.12)'
                        : 'rgba(0,106,95,0.07)',
                    }}
                  />

                  <div className="flex-1">
                    <Icon
                      className="mb-3"
                      style={{ color: tile.fg, width: 22, height: 22 }}
                      strokeWidth={1.8}
                    />
                    <p
                      className="font-barlow font-black text-xl uppercase leading-tight tracking-tight"
                      style={{ color: tile.fg }}
                    >
                      {tile.label}
                    </p>
                    <p
                      className="font-maven text-[11px] mt-0.5 leading-tight"
                      style={{ color: tile.sub }}
                    >
                      {tile.desc}
                    </p>
                  </div>

                  <ChevronRight
                    className="absolute bottom-3 right-3 opacity-35"
                    style={{ color: tile.fg, width: 15, height: 15 }}
                  />
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>

      {/* ── FOOTER ────────────────────────────────── */}
      <div className="px-4 mt-8 mb-2">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-kidville-green/15" />
          <span className="font-barlow font-bold text-[10px] text-kidville-green/30 uppercase tracking-[0.2em]">
            Kidville ®
          </span>
          <div className="h-px flex-1 bg-kidville-green/15" />
        </div>
      </div>
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
