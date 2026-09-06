'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MessageCircle, BookOpen, Camera, CalendarX2, GraduationCap, Hourglass, Info } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { withIdentity } from '@/lib/auth/current-user';
import { useParentIdentity, eMotivoNonPiuIscritto } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { HeroCard } from '@/components/features/shell/HeroCard';
import { SospensioneBanner } from '@/components/features/parent/SospensioneBanner';
import { PagamentiSummary } from '@/components/features/parent/pagamenti/PagamentiSummary';
import { SectionHeader } from '@/components/features/parent/home/SectionHeader';
import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';
import { AvvisiPreview } from '@/components/features/parent/home/AvvisiPreview';
import { NewsPreview } from '@/components/features/parent/home/NewsPreview';
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
  const t = useTranslations('home');
  // Le due frasi della schermata di cortesia stanno in `parentServizi` e non in
  // `home`: sono un testo dell'AREA famiglia, non del riquadro di benvenuto.
  const tServizi = useTranslations('parentServizi');
  const { parentId, studentId, inAttesa, motivoAssenza, ready } = useParentIdentity();
  const { schoolType } = useChildSchoolType();
  const isPrimaria = schoolType === 'primaria';

  const [firstName, setFirstName] = useState('');
  const [nameResolved, setNameResolved] = useState(false);
  // La sezione del bambino viaggia fino alla card dell'armadietto, che senza non
  // può chiedere al server le soglie del materiale (e prima le aveva cablate).
  const [classeSezione, setClasseSezione] = useState('');

  useEffect(() => {
    if (!studentId) return;
    fetch(`/api/diary/students?id=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setFirstName(d.nome ?? '');
        if (typeof d.classe_sezione === 'string') setClasseSezione(d.classe_sezione);
      })
      // AGENTS.md regola 6: un `catch` che non logga è un bug. Qui l'errore È
      // tollerabile — il nome serve al solo saluto dell'hero, e il `finally`
      // sblocca comunque lo skeleton — ma «tollerabile» va SCRITTO: senza questa
      // riga una home che saluta «Ciao!» invece che per nome non lascia nessuna
      // traccia, e un guasto di rete prende l'aspetto di una scelta di prodotto.
      //
      // ⚠️ `warn` E NON `info`, benché la regola dica `info`: il canale del client
      // non ha `info` — `EventoClient.livello` è `'warn' | 'error'` e la route
      // `/api/logs` rifiuta il resto (vedi `livelloEvento` in
      // `@/lib/logging/client`). `warn` è il livello più basso che esista qui, ed
      // è anche quello in cui la politica declassa da sola una fetch troncata
      // dalla WebView, che è il caso frequente.
      //
      // Solo `nomeErrore`: il `message` di una fetch fallita può portarsi dietro
      // l'URL, e in quell'URL c'è l'id di un minore.
      .catch((err: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `home-nome-figlio-non-letto: ${nomeErrore(err)}`,
          route: '/parent',
        });
      })
      .finally(() => setNameResolved(true));
  }, [studentId]);

  // ── «HO DEI FIGLI, MA NESSUNO È ANCORA VISIBILE» ────────────────────────────
  //
  // Dal 2026-09-05 l'app non mostra più i figli senza classe, ritirati o
  // archiviati. Per quattro account genitore in produzione quelli erano TUTTI i
  // figli: senza questo ramo la loro home sarebbe la home di chi non ha figli —
  // saluto neutro, riquadri vuoti, nessuna spiegazione e nessuna cosa da fare.
  //
  // La differenza fra le due situazioni la sa solo il server (`in_attesa`), ed è
  // il motivo per cui non basta guardare `studentId === null`: quello è vero anche
  // mentre la rete è giù, e mandare in segreteria chi è semplicemente offline
  // sarebbe peggio di non dire niente.
  //
  // ⚠️ IL RAMO STA DOPO TUTTI GLI HOOK, e non prima: `useEffect` e `useState` di
  // questo componente devono girare sempre nello stesso ordine.
  //
  // ── E NON È UNA SCHERMATA SOLA, PERCHÉ NON È UN CASO SOLO ──────────────────
  //
  // Misurato in produzione il 2026-09-06: dei 4 account senza figli visibili, 3
  // hanno l'unico figlio SENZA SEZIONE — «appena la classe è assegnata qui
  // compare tutto» è vera — e 1 ce l'ha ARCHIVIATO, e a quella famiglia la
  // stessa frase prometteva il completamento di un'iscrizione che non esiste e
  // una classe che non arriverà. Un quarto delle persone leggeva una cosa falsa
  // sull'unica schermata che la loro app mostra.
  //
  // La clessidra segue la frase e non il ramo: promette un'attesa, e dove non
  // c'è nessuna attesa da fare sarebbe la parte che continua a mentire dopo che
  // il testo ha smesso.
  if (ready && inAttesa) {
    const nonPiuIscritto = eMotivoNonPiuIscritto(motivoAssenza);
    const Icona = nonPiuIscritto ? Info : Hourglass;
    return (
      <div className="min-h-screen bg-kidville-cream px-4 pb-[100px] pt-5">
        <div className="rounded-[22px] bg-white px-5 py-8 text-center" style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}>
          <span className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-[18px] bg-kidville-yellow-soft text-kidville-yellow-dark">
            <Icona size={24} strokeWidth={1.9} aria-hidden="true" />
          </span>
          <h1 className="pt-4 font-barlow text-[19px] font-bold uppercase leading-[1.1] tracking-[0.02em] text-kidville-green">
            {nonPiuIscritto ? tServizi('nonPiuIscrittoTitolo') : tServizi('inAttesaTitolo')}
          </h1>
          {/* `sub` (#55615C, 6,46:1) e NON `muted` (#7B8582, 3,80:1 su bianco, sotto i
              4,5:1 di WCAG AA): a 13,5px questa frase è l'UNICA cosa che i quattro
              account senza figli visibili leggono nella loro app, e dice a chi
              rivolgersi. Il lock `__tests__/a11y/testo-muted-allowlist.test.ts` lo
              pretende — l'allowlist può solo accorciarsi, non crescere a due. */}
          <p className="pt-2 font-maven text-[13.5px] leading-[1.5] text-kidville-sub">
            {nonPiuIscritto ? tServizi('nonPiuIscrittoTesto') : tServizi('inAttesaTesto')}
          </p>
        </div>
      </div>
    );
  }

  // Skeleton finché il nome non è risolto (evita il flash del fallback).
  // Con studentId assente non si resta in caricamento: si mostra il saluto neutro.
  const nameLoading = !!studentId && !nameResolved;

  // Azioni rapide (DR QuickActions): solo navigazione verso pagine reali.
  // "Segnala assenza" porta alla pagina assenze (dove vive il submit reale).
  const wi = (href: string) => withIdentity(href, parentId, studentId);
  const quickActions: QuickAction[] = [
    {
      id: 'absence',
      label: t('azioneAssenza'),
      icon: CalendarX2,
      href: wi(isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance'),
      bg: 'bg-kidville-error-soft',
      fg: 'text-kidville-error',
    },
    { id: 'chat', label: t('azioneChat'), icon: MessageCircle, href: wi('/parent/chat'), bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
    { id: 'foto', label: t('azioneFoto'), icon: Camera, href: wi('/parent/gallery'), bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
    // Il diario giornaliero è solo nido/infanzia: per la primaria l'azione
    // diventa l'area Scuola (lezioni, compiti, voti), senza la parola "Diario".
    isPrimaria
      ? { id: 'scuola', label: t('azioneScuola'), icon: GraduationCap, href: wi('/parent/primaria'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' }
      : { id: 'diario', label: t('azioneDiario'), icon: BookOpen, href: wi('/parent/diary'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
  ];

  return (
    <div className="min-h-screen bg-kidville-cream pb-[100px]">

      {/* ── HERO (DR warm) — wordmark/campanella nella AppBar ───────── */}
      <div className="px-4 pt-5">
        <HeroCard
          title={firstName ? t('heroCiaoNome', { nome: firstName }) : t('heroCiao')}
          loading={nameLoading}
          subtitle={firstName ? t('heroSottotitolo') : undefined}
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
            eyebrow={t('eyebrowPresenze')}
            title={t('titoloOggiAScuola')}
            actionLabel={t('azioneStorico')}
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
          <SectionHeader eyebrow={t('eyebrowDiario')} title={firstName ? t('diarioGiornataDi', { nome: firstName }) : t('diarioTitolo')} />
          <DiaryTodayCard studentId={studentId} href={wi('/parent/diary')} />
        </div>
      )}

      {/* ── AVVISI (top 2, sola lettura) ──────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowComunicazioni')} title={t('titoloAvvisi')} actionLabel={t('azioneTutti')} actionHref={wi('/parent/avvisi')} />
          <AvvisiPreview parentId={parentId} studentId={studentId} />
        </div>
      )}

      {/* ── NEWS (top 3, sola lettura; si nasconde se vuoto) ── */}
      {parentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowComunicazioni')} title={t('titoloNews')} actionLabel={t('azioneTutte')} actionHref={wi('/parent/news')} />
          <NewsPreview parentId={parentId} studentId={studentId} />
        </div>
      )}

      {/* ── GALLERIA OGGI ─────────────────────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowGalleria')} title={t('titoloFotoDiOggi')} actionLabel={t('azioneTutte')} actionHref={wi('/parent/gallery')} />
          <GalleryTodayCard studentId={studentId} parentId={parentId} href={wi('/parent/gallery')} />
        </div>
      )}

      {/* ── ARMADIETTO · SCORTE (teaser DR) ───────── */}
      {studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowArmadietto')} title={t('titoloScorte')} actionLabel={t('azioneGestisci')} actionHref={wi('/parent/locker')} />
          <LockerTodayCard studentId={studentId} classeSezione={classeSezione} />
        </div>
      )}

      {/* ── CALENDARIO · AGENDA (eventi_agenda M6) ── */}
      <div className="px-4 pt-5">
        <SectionHeader eyebrow={t('eyebrowCalendario')} title={t('titoloProssimiAppuntamenti')} />
        <AgendaTodayCard studentId={studentId} />
      </div>

      {/* ── NOTA / FOOTER ─────────────────────────── */}
      <p className="px-4 pt-6 text-center font-maven text-[11px] text-kidville-muted">
        {t('footerRetention')}
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
