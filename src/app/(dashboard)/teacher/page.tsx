'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  BookOpen, ClipboardCheck, NotebookPen, Images, Megaphone, ListTodo,
  Bell, ChevronRight, Check, AlertTriangle, CalendarDays, Eye, Users,
} from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { GradeWorldSwitch } from '@/components/features/teacher/GradeWorldSwitch';

// Scorciatoie del giorno (DR ScorciatoieBlock). Le voci didattiche sono gated
// dalla matrice funzioni (admin_settings.funzioni_matrice); comunica/attività
// sono sempre disponibili. Tutte puntano a rotte reali.
const SHORTCUTS = [
  { key: 'appello', eyebrow: 'Presenze', title: 'Appello', icon: ClipboardCheck, tint: '#006A5F', href: '/teacher/attendance', always: true },
  { key: 'diario', eyebrow: 'Giornata', title: 'Diario', icon: NotebookPen, tint: '#2A6FDB', href: '/teacher/diary', always: false },
  { key: 'registro', eyebrow: 'Valutazioni', title: 'Registro', icon: BookOpen, tint: '#7A3FD0', href: '/teacher/primaria', always: false },
  { key: 'gallery', eyebrow: 'Galleria', title: 'Foto del giorno', icon: Images, tint: '#006A5F', href: '/teacher/gallery', always: false },
  { key: 'comunica', eyebrow: 'Famiglie', title: 'Comunica', icon: Megaphone, tint: '#E53935', href: '/teacher/avvisi', always: true },
  { key: 'attivita', eyebrow: 'Staff', title: 'Attività', icon: ListTodo, tint: '#1F8A5B', href: '/teacher/tasks', always: true },
] as const;

const GRADO_LABEL: Record<string, string> = { infanzia: 'Infanzia', nido: 'Nido', primaria: 'Primaria' };

type MeData = { gradi: string[]; funzioni: Record<string, Record<string, boolean>> };
type Student = { id: string; nome: string; cognome: string; note_mediche: string | null; consenso_privacy: boolean };
type Avviso = {
  id: string; titolo: string; contenuto: string; tipo: string;
  author?: { first_name?: string; last_name?: string };
  created_at: string; stats?: { letti: number; adesioni_si: number; adesioni_no: number };
};
type Presenza = { stato?: string };

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-barlow text-[11px] font-bold uppercase tracking-[0.12em] text-kidville-yellow-dark">
      {children}
    </div>
  );
}

function relDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

function TeacherDashboardInner() {
  const params = useSearchParams();
  const userId = getCurrentTeacherId(params);
  const withUser = (href: string) => `${href}?userId=${userId}`;

  const [me, setMe] = useState<MeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<string[]>([]);
  const [activeSection, setActiveSection] = useState<string>('');
  const [students, setStudents] = useState<Student[]>([]);
  const [presenze, setPresenze] = useState<Presenza[]>([]);
  const [avvisi, setAvvisi] = useState<Avviso[]>([]);

  // me (gradi/funzioni) — fetch esistente, preservato.
  useEffect(() => {
    let active = true;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && d?.success) setMe(d.data); })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [userId]);

  // sezioni del docente (read-only) → ClassSwitcher + contesto Appello/Allergie.
  useEffect(() => {
    let active = true;
    fetch(`/api/educator-sections?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        const names: string[] = d?.sectionNames ?? [];
        setSections(names);
        setActiveSection((cur) => cur || names[0] || '');
      })
      .catch(() => {});
    return () => { active = false; };
  }, [userId]);

  // avvisi (bacheca del docente) — read-only.
  useEffect(() => {
    let active = true;
    fetch(`/api/avvisi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setAvvisi(d); })
      .catch(() => {});
    return () => { active = false; };
  }, [userId]);

  // dati della sezione attiva: presenze di oggi + alunni (per allergie/conteggio).
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []); // YYYY-MM-DD locale
  useEffect(() => {
    if (!activeSection) return;
    let active = true;
    fetch(`/api/attendance/daily?data=${today}&sezione=${encodeURIComponent(activeSection)}&userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setPresenze(d); })
      .catch(() => {});
    fetch(`/api/diary/students?sezione=${encodeURIComponent(activeSection)}&userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setStudents(d); })
      .catch(() => {});
    return () => { active = false; };
  }, [activeSection, today, userId]);

  const infanziaGradi = useMemo(() => (me?.gradi ?? []).filter((g) => g === 'infanzia' || g === 'nido'), [me]);
  const isEnabled = (key: string) => infanziaGradi.some((g) => me?.funzioni?.[g]?.[key] === true);
  const isPrimariaOnly = infanziaGradi.length === 0 && (me?.gradi ?? []).includes('primaria');

  const oggi = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  // derivati
  const studentCount = students.length;
  const allergie = students.filter(
    (s) => s.note_mediche && s.note_mediche.trim() !== '' && !/nessuna/i.test(s.note_mediche),
  );
  const appelloFatto = presenze.length > 0;
  const presenti = presenze.filter((p) => p.stato && p.stato !== 'assente').length;
  const assenti = presenze.filter((p) => p.stato === 'assente').length;

  const avvisiRecenti = avvisi.slice(0, 3);
  const shortcuts = SHORTCUTS.filter((s) => s.always || isEnabled(s.key));

  return (
    <div className="mx-auto max-w-[460px] px-4 pt-5">
      {/* ── HERO (DR yellow card) ───────────────────────── */}
      <div
        className="relative overflow-hidden rounded-3xl bg-kidville-yellow px-5 pb-5 pt-4"
        style={{ minHeight: 116, boxShadow: '0 14px 30px -16px rgba(230,177,0,.7)' }}
      >
        <div className="relative z-10 max-w-[68%]">
          <p className="font-maven text-xs font-semibold capitalize text-kidville-green/70">{oggi}</p>
          <h1 className="mt-1 font-barlow text-3xl font-black uppercase leading-[0.96] text-kidville-green">
            Buongiorno,<br />maestra!
          </h1>
          <p className="mt-1.5 font-maven text-xs font-semibold text-kidville-green/75">
            {activeSection ? `Sezione ${activeSection} · ${studentCount} bambini` : 'La tua giornata in sezione'}
          </p>
        </div>
        <Link
          href={withUser('/teacher/avvisi')}
          aria-label="Comunicazioni"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-kidville-green/12 text-kidville-green"
        >
          <Bell size={18} />
        </Link>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/mascot.png" alt="" draggable={false}
          className="pointer-events-none absolute -bottom-2 right-[-6px] z-0 h-36 select-none" />
      </div>

      {/* ── GRADE WORLD SWITCH (solo docenti misti) ─────── */}
      <div className="mt-4">
        <GradeWorldSwitch />
      </div>

      {/* ── CLASS SWITCHER (chip sezioni) ───────────────── */}
      {sections.length > 1 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {sections.map((s) => {
            const on = s === activeSection;
            return (
              <button
                key={s}
                onClick={() => setActiveSection(s)}
                className={`flex shrink-0 items-center gap-2 rounded-pill py-1.5 pl-1.5 pr-3.5 transition ${
                  on ? 'bg-white shadow-[inset_0_0_0_1.5px_var(--color-kidville-green)]' : 'shadow-[inset_0_0_0_1.5px_rgba(0,106,95,.18)]'
                }`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-full ${on ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream-dark text-kidville-green'}`}>
                  <Users size={15} />
                </span>
                <span className={`font-barlow text-sm font-extrabold uppercase ${on ? 'text-kidville-green' : 'text-kidville-muted'}`}>{s}</span>
              </button>
            );
          })}
        </div>
      )}

      {isPrimariaOnly && (
        <div className="mt-5 rounded-2xl border border-dashed border-kidville-line bg-white/60 p-5 text-center">
          <p className="font-maven text-sm text-kidville-muted">
            Nessuna attività infanzia/nido per il tuo profilo.{' '}
            <Link href={withUser('/teacher/primaria')} className="font-semibold text-kidville-green underline">Vai alla Primaria</Link>
          </p>
        </div>
      )}

      {/* ── COMUNICAZIONI (bacheca del docente · DR AvvisiBlock) ── */}
      {avvisiRecenti.length > 0 && (
        <section className="mt-5 rounded-[22px] px-3 pb-3 pt-0.5"
          style={{ background: 'linear-gradient(180deg, var(--color-kidville-yellow-soft) 0%, rgba(251,240,221,0) 72%)' }}>
          <div className="flex items-center gap-3 px-1 py-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kidville-yellow text-kidville-green"
              style={{ boxShadow: '0 8px 18px -10px rgba(230,177,0,.9)' }}>
              <Megaphone size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">Comunicazioni</h2>
                <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-kidville-green px-1.5 font-barlow text-xs font-extrabold text-kidville-yellow">{avvisi.length}</span>
              </div>
              <p className="mt-0.5 font-maven text-[11.5px] text-kidville-yellow-dark">Avvisi pubblicati in bacheca · letture</p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            {avvisiRecenti.map((a) => {
              const isAdesione = a.tipo === 'adesione';
              return (
                <div key={a.id} className="rounded-2xl bg-white p-3.5"
                  style={{ boxShadow: 'inset 0 0 0 1.6px var(--color-kidville-yellow), 0 8px 20px -14px rgba(230,177,0,.6)' }}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-kidville-green text-kidville-yellow">
                      <Eye size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-2 py-0.5 font-barlow text-[10.5px] font-extrabold uppercase tracking-wide text-kidville-green">
                          {isAdesione ? 'Adesione' : 'Presa visione'}
                        </span>
                        <span className="ml-auto font-maven text-[10.5px] text-kidville-muted">
                          {a.author ? `${a.author.first_name ?? ''} ${a.author.last_name ?? ''}`.trim() : ''} · {relDate(a.created_at)}
                        </span>
                      </div>
                      <h3 className="mb-0.5 truncate font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">{a.titolo}</h3>
                      <p className="line-clamp-2 font-maven text-xs leading-snug text-kidville-ink">{a.contenuto}</p>
                      {a.stats && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-success-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase text-kidville-success">
                            <Check size={11} strokeWidth={2.8} /> {a.stats.letti} letture
                          </span>
                          {isAdesione && (
                            <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-info-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase text-kidville-info">
                              {a.stats.adesioni_si} sì · {a.stats.adesioni_no} no
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <Link href={withUser('/teacher/avvisi')}
            className="mx-auto mt-3 flex h-9 w-fit items-center gap-1.5 rounded-pill px-4 font-barlow text-xs font-extrabold uppercase text-kidville-green"
            style={{ boxShadow: 'inset 0 0 0 1.5px rgba(0,106,95,.25)' }}>
            <Megaphone size={14} /> Apri la bacheca <ChevronRight size={14} strokeWidth={2.4} />
          </Link>
        </section>
      )}

      {/* ── BANNER ALLERGIE DEL GIORNO (DR AllergieBanner) ── */}
      {allergie.length > 0 && (
        <section className="mt-5">
          <div className="overflow-hidden rounded-[20px] bg-white"
            style={{ boxShadow: 'inset 0 0 0 1.6px var(--color-kidville-cream-dark), 0 10px 26px -18px rgba(120,80,10,.4)' }}>
            <div className="flex items-center gap-3 border-b border-kidville-line px-4 pb-3 pt-3.5"
              style={{ background: 'linear-gradient(180deg, var(--color-kidville-yellow-soft), #fff)' }}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kidville-yellow text-kidville-green">
                <AlertTriangle size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-barlow text-lg font-black uppercase leading-none text-kidville-green">Allergie e note mediche</div>
                <div className="mt-0.5 font-maven text-[11.5px] text-kidville-yellow-dark">
                  {allergie.length} {allergie.length === 1 ? 'bambino' : 'bambini'} da seguire · sezione {activeSection}
                </div>
              </div>
            </div>
            <div className="px-2.5 pb-1 pt-1">
              {allergie.map((s, i) => (
                <div key={s.id} className={`flex items-center gap-2.5 px-1.5 py-2.5 ${i ? 'border-t border-kidville-line' : ''}`}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-kidville-yellow-dark" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-barlow text-sm font-extrabold uppercase leading-tight text-kidville-green">{s.nome} {s.cognome}</div>
                  </div>
                  <span className="inline-flex max-w-[55%] items-center truncate rounded-pill bg-kidville-cream-dark px-2 py-0.5 font-barlow text-[10.5px] font-extrabold uppercase tracking-wide text-kidville-yellow-dark">
                    {s.note_mediche}
                  </span>
                </div>
              ))}
            </div>
            <Link href={withUser('/teacher/diary')}
              className="flex w-full items-center justify-center gap-1.5 border-t border-kidville-line bg-kidville-cream py-2.5 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green">
              <NotebookPen size={15} /> Vedi nel diario <ChevronRight size={14} strokeWidth={2.4} />
            </Link>
          </div>
        </section>
      )}

      {/* ── APPELLO DEL GIORNO (DR AppelloCard) ─────────── */}
      <section className="mt-5">
        <div className="relative overflow-hidden rounded-[18px] p-4"
          style={appelloFatto
            ? { background: '#fff', boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }
            : { background: 'var(--color-kidville-green)', boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
          <div className="flex items-center gap-3">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${appelloFatto ? 'bg-kidville-green-soft text-kidville-green' : 'bg-kidville-yellow text-kidville-green'}`}>
              <ClipboardCheck size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={`font-barlow text-lg font-black uppercase leading-none ${appelloFatto ? 'text-kidville-green' : 'text-white'}`}>Appello del giorno</div>
              <div className={`mt-1 font-maven text-xs ${appelloFatto ? 'text-kidville-ink' : 'text-white/80'}`}>
                {appelloFatto ? `${presenti} presenti · ${assenti} assenti` : `Non ancora registrato · ${studentCount || ''} bambini`}
              </div>
            </div>
            <span className={`rounded-pill px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase tracking-wide ${appelloFatto ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-yellow text-kidville-green'}`}>
              {appelloFatto ? 'Fatto' : 'Da fare'}
            </span>
          </div>
          <Link href={withUser('/teacher/attendance')}
            className={`mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-pill font-barlow text-sm font-extrabold uppercase ${appelloFatto ? 'bg-kidville-green-soft text-kidville-green' : 'bg-kidville-yellow text-kidville-green'}`}>
            <ClipboardCheck size={18} /> {appelloFatto ? "Modifica appello" : "Fai l'appello ora"} <ChevronRight size={16} strokeWidth={2.4} />
          </Link>
        </div>
      </section>

      {/* ── SCORCIATOIE (DR ScorciatoieBlock) ───────────── */}
      <section className="mt-6">
        <div className="mb-3 px-0.5">
          <Eyebrow>Azioni rapide</Eyebrow>
          <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">Scorciatoie</h2>
        </div>
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl border border-kidville-line bg-white/60" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {shortcuts.map((s) => {
              const Icon = s.icon;
              const detail =
                s.key === 'appello'
                  ? (appelloFatto ? `${presenti} presenti registrati` : 'Da registrare adesso')
                  : s.key === 'comunica'
                    ? 'Invia un avviso ai genitori'
                    : s.key === 'attivita'
                      ? 'Task e bacheca interna'
                      : s.key === 'diario'
                        ? 'Schede della giornata'
                        : s.key === 'registro'
                          ? 'Valutazioni e note'
                          : 'Carica i momenti della giornata';
              return (
                <Link key={s.key} href={withUser(s.href)}
                  className="flex flex-col rounded-2xl bg-white p-3.5"
                  style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 22px -16px rgba(0,84,75,.28)' }}>
                  <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl"
                    style={{ background: s.tint + '18', color: s.tint }}>
                    <Icon size={20} />
                  </span>
                  <span className="font-barlow text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: s.tint }}>{s.eyebrow}</span>
                  <span className="font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{s.title}</span>
                  <span className="mt-0.5 font-maven text-[11.5px] leading-snug text-kidville-ink">{detail}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ── AGENDA (DR AgendaCard · nessun backend → placeholder) ── */}
      <section className="mt-6">
        <div className="mb-3 px-0.5">
          <Eyebrow>Agenda</Eyebrow>
          <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">La giornata in sezione</h2>
        </div>
        <div className="rounded-2xl border border-dashed border-kidville-line bg-white/60 p-5 text-center"
          aria-label="Agenda in arrivo">
          <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-kidville-green-soft text-kidville-green">
            <CalendarDays size={22} />
          </span>
          <div className="font-barlow text-base font-extrabold uppercase text-kidville-green">Agenda della giornata</div>
          <p className="mx-auto mt-1 max-w-[260px] font-maven text-[12.5px] leading-snug text-kidville-muted">
            Calendario eventi e impegni della sezione · <span className="font-semibold text-kidville-yellow-dark">in arrivo</span>.
          </p>
        </div>
      </section>

      {/* footer */}
      <div className="px-4 pb-2 pt-5 text-center font-maven text-[10.5px] text-kidville-muted">
        Vista insegnante · {(me?.gradi ?? []).map((g) => GRADO_LABEL[g] ?? g).join(' · ') || 'Kidville'}
      </div>
    </div>
  );
}

export default function TeacherDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <TeacherDashboardInner />
    </Suspense>
  );
}
