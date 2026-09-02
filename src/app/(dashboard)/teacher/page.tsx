'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import {
  BookOpen, ClipboardCheck, NotebookPen, Images, Megaphone, ListTodo,
  ChevronRight, Check, AlertTriangle, Eye, Users,
} from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { dataCivile, intlDateTime } from '@/i18n/config';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useTeacherGradi } from '@/lib/auth/use-teacher-gradi';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { greetingByHour } from '@/lib/ui/greeting';
import { parametroClasse } from '@/lib/sezioni/parametro-classe';
import { HeroCard } from '@/components/features/shell/HeroCard';
import { GradeWorldSwitch } from '@/components/features/teacher/GradeWorldSwitch';
import { TeacherAgendaCard } from '@/components/features/teacher/TeacherAgendaCard';

// Scorciatoie del giorno (DR ScorciatoieBlock), con `grado` come le voci della
// bottom-nav: le voci 0-6 sono gated dalla matrice funzioni
// (admin_settings.funzioni_matrice), quella primaria dai gradi del docente;
// comunica/attività sono sempre disponibili. Tutte puntano a rotte reali.
// Le etichette (eyebrow/title/detail) sono i18n: risolte a runtime per `key`
// contro il namespace `teacherNav` (chiavi `shortcut_<key>_*`).
const SHORTCUTS = [
  { key: 'appello', icon: ClipboardCheck, tint: '#006A5F', href: '/teacher/attendance', always: true, grado: 'comune' },
  { key: 'diario', icon: NotebookPen, tint: '#2A6FDB', href: '/teacher/diary', always: false, grado: 'infanzia' },
  { key: 'registro', icon: BookOpen, tint: '#7A3FD0', href: '/teacher/primaria', always: false, grado: 'primaria' },
  { key: 'gallery', icon: Images, tint: '#006A5F', href: '/teacher/gallery', always: false, grado: 'infanzia' },
  { key: 'comunica', icon: Megaphone, tint: '#E53935', href: '/teacher/avvisi', always: true, grado: 'comune' },
  { key: 'attivita', icon: ListTodo, tint: '#1F8A5B', href: '/teacher/tasks', always: true, grado: 'comune' },
] as const;

type MeData = { gradi: string[]; funzioni: Record<string, Record<string, boolean>> };
/**
 * Una sezione è un'IDENTITÀ, non un nome (R106, audit multi-sede 2026-07-31).
 * Con tre plessi «2 ANNI» esiste ad Aversa E a Cesa: finché la chip era la
 * stringa, le due omonime avevano la stessa `key` React, si accendevano
 * insieme, e le letture a valle — presenze del giorno e `diary/students`, che
 * restituisce le NOTE MEDICHE dei bambini — partivano con un nome che valeva
 * per due sedi.
 */
type SezioneChip = {
  id: string;
  name: string;
  scuolaId: string;
  scuolaNome: string;
  school_type: string | null;
};
type Student = { id: string; nome: string; cognome: string; note_mediche: string | null; consenso_privacy: boolean };
type Avviso = {
  id: string; titolo: string; contenuto: string; tipo: string;
  author?: { first_name?: string; last_name?: string };
  created_at: string; stats?: { letti: number; adesioni_si: number; adesioni_no: number };
};
type Presenza = { stato?: string };

/**
 * Occhiello di sezione («AZIONI RAPIDE», «AGENDA», …).
 *
 * Era `text-kidville-yellow-dark`: 1,97:1 su bianco, 1,75:1 sul giallo tenue
 * delle sue fasce. Non è testo grande e non è un fregio — è l'unica etichetta
 * che dice a cosa serve il blocco sotto. `warn-strong` conserva l'accento caldo
 * del design e sta a 5,61:1 / 4,97:1.
 */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-barlow text-[11px] font-bold uppercase tracking-[0.12em] text-kidville-warn-strong">
      {children}
    </div>
  );
}

/**
 * Data breve di un avviso in bacheca («31 lug»).
 *
 * `intlDateTime` e non `toLocaleDateString(locale, …)`: quest'ultima prendeva il
 * locale GREZZO di next-intl («en», che Intl risolve su en-US) e NESSUN fuso,
 * cioè quello dell'ambiente. Su Vercel il processo gira in UTC: un avviso
 * pubblicato alle 00:30 di Roma risultava del giorno prima. Il mese abbreviato
 * non è fra i formati di `@/lib/i18n/date`, e `intlDateTime` è proprio la via
 * dichiarata per le opzioni fuori standard: mette `Europe/Rome` per costruzione.
 */
function relDate(iso: string, locale: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return intlDateTime(locale, { day: 'numeric', month: 'short' }).format(d);
}

function TeacherDashboardInner() {
  const t = useTranslations('teacherNav');
  const locale = useLocale();
  const { userId } = useSessionIdentity();
  // La home docente semina i link dell'app: con identità non risolta il
  // parametro viene omesso (href invariato), mai `userId=null`.
  const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);
  // Etichette dei gradi tradotte (fallback al codice grezzo se sconosciuto).
  const gradoLabel = (g: string): string =>
    ({ infanzia: t('gradoInfanzia'), nido: t('gradoNido'), primaria: t('gradoPrimaria') } as Record<string, string>)[g] ?? g;

  const [me, setMe] = useState<MeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<SezioneChip[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string>('');
  const [students, setStudents] = useState<Student[]>([]);
  const [presenze, setPresenze] = useState<Presenza[]>([]);
  const [avvisi, setAvvisi] = useState<Avviso[]>([]);

  // Saluto dipendente dall'ora locale: SOLO client-side (SSR-safe, hydration).
  // La riga data è interna alla HeroCard.
  const greeting = useClientValue(greetingByHour, '');

  // me (gradi/funzioni) + sezioni + avvisi: 3 fetch indipendenti in UN solo
  // effect con Promise.all. Esiti gestiti per-fetch (catch silenziosi
  // indipendenti, come i 3 effect originali): un avviso che fallisce non
  // blocca me/sezioni né lascia lo skeleton acceso. Zero cambio visivo.
  useEffect(() => {
    if (!userId) return; // identità non risolta: lo skeleton (loading=true) resta attivo
    let active = true;
    const meReq = fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && d?.success) setMe(d.data); })
      .catch(() => {});
    const sectionsReq = fetch(`/api/educator-sections?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        // `sections` (identità) e non più `sectionNames`: la chip deve poter
        // dire QUALE «2 ANNI» è, e la richiesta a valle deve poter dichiarare
        // la sede. Righe senza `id` scartate: senza identità non si clicca.
        const lista: SezioneChip[] = Array.isArray(d?.sections)
          ? (d.sections as SezioneChip[]).filter((s) => s?.id && s?.name)
          : [];
        setSections(lista);
        setActiveSectionId((cur) => cur || lista[0]?.id || '');
      })
      .catch(() => {});
    const avvisiReq = fetch(`/api/avvisi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setAvvisi(d); })
      .catch(() => {});
    Promise.all([meReq, sectionsReq, avvisiReq]).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  // Sezione attiva risolta per ID: `sections` e `activeSectionId` cambiano
  // insieme, quindi il riferimento resta stabile fra i render (dipendenza
  // dell'effect qui sotto).
  const activeSection = useMemo(
    () => sections.find((s) => s.id === activeSectionId) ?? null,
    [sections, activeSectionId],
  );
  const nomeSezione = activeSection?.name ?? '';
  // Con più sedi in elenco l'etichetta deve dire QUALE: due «2 ANNI» nude sono
  // indistinguibili. Con una sola sede il suffisso sarebbe solo rumore.
  const piuSedi = useMemo(
    () => new Set(sections.map((s) => s.scuolaId).filter(Boolean)).size > 1,
    [sections],
  );

  // dati della sezione attiva: presenze di oggi + alunni (per allergie/conteggio).
  // `dataCivile()` = la data di OGGI in Europe/Rome, `YYYY-MM-DD`. Prima era
  // `new Date().toLocaleDateString('en-CA')`, cioè la data del PROCESSO: su
  // Vercel (UTC) fra le 00:00 e le 02:00 italiane l'appello del giorno veniva
  // chiesto per IERI — e server e browser rendevano due giorni diversi.
  const today = useMemo(() => dataCivile(), []);
  useEffect(() => {
    if (!activeSection || !userId) return;
    let active = true;
    // La sede viaggia SEMPRE: con l'uuid della sezione l'omonimia fra plessi non
    // può più portare dentro i bambini dell'altra sede, ma `scuola_id` resta
    // perché è la sede DICHIARATA dal SedeSelector e le route la ri-validano.
    const sede = activeSection.scuolaId ? `&scuola_id=${activeSection.scuolaId}` : '';
    // Questa pagina aveva già l'identità della sezione — `activeSection.id`, che
    // usa per la chip — e mandava al server il NOME. Le due route filtravano
    // `alunni.classe_sezione` per uguaglianza esatta: uno spazio di differenza e
    // la dashboard mostrava una classe vuota, con 200 e senza un log.
    const classe = parametroClasse(activeSection);
    fetch(`/api/attendance/daily?data=${today}&${classe}&userId=${userId}${sede}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setPresenze(d); })
      .catch(() => {});
    fetch(`/api/diary/students?${classe}&userId=${userId}${sede}`)
      .then((r) => r.json())
      .then((d) => { if (active && Array.isArray(d)) setStudents(d); })
      .catch(() => {});
    return () => { active = false; };
  }, [activeSection, today, userId]);

  const infanziaGradi = useMemo(() => (me?.gradi ?? []).filter((g) => g === 'infanzia' || g === 'nido'), [me]);
  const isEnabled = (key: string) => infanziaGradi.some((g) => me?.funzioni?.[g]?.[key] === true);
  // Gradi dal hook condiviso con bottom-nav e GradeWorldSwitch (fetch dedupato).
  const { hasPrimaria, isPrimariaOnly } = useTeacherGradi(userId ?? null);
  // Un docente solo-primaria non deve vedere lessico 0-6 (né riferimenti a
  // infanzia/nido): il mondo primaria parla di "classe" e "alunni".
  // Discriminatore lessicale: seleziona in JS la variante i18n giusta (le
  // stringhe world-dependent hanno una chiave `*Classe`/`*Sezione` dedicata),
  // così le pluralizzazioni restano gestite dall'ICU senza select annidati.
  const nounGruppo = isPrimariaOnly ? 'classe' : 'sezione';

  // derivati
  const studentCount = students.length;
  const allergie = students.filter(
    (s) => s.note_mediche && s.note_mediche.trim() !== '' && !/nessuna/i.test(s.note_mediche),
  );
  const appelloFatto = presenze.length > 0;
  const presenti = presenze.filter((p) => p.stato && p.stato !== 'assente').length;
  const assenti = presenze.filter((p) => p.stato === 'assente').length;

  const avvisiRecenti = avvisi.slice(0, 3);
  // Voci primaria: bastano i gradi (l'hub /teacher/primaria aggrega più
  // funzioni); voci 0-6: resta il gate della matrice funzioni.
  const shortcuts = SHORTCUTS.filter((s) =>
    s.always || (s.grado === 'primaria' ? hasPrimaria : isEnabled(s.key)),
  );

  return (
    <div className="mx-auto max-w-[460px] px-4 pt-5">
      {/* ── HERO (DR yellow card) — wordmark/campanella nella AppBar ───── */}
      <HeroCard
        title={`${greeting}${greeting ? '!' : ''}`}
        subtitle={nomeSezione
          ? t(isPrimariaOnly ? 'heroSottotitoloClasse' : 'heroSottotitoloSezione', { sezione: nomeSezione, count: studentCount })
          : t(isPrimariaOnly ? 'heroVuotoClasse' : 'heroVuotoSezione')}
      />

      {/* ── GRADE WORLD SWITCH (solo docenti misti) ─────── */}
      <div className="mt-4">
        <GradeWorldSwitch />
      </div>

      {/* ── CLASS SWITCHER (chip sezioni) ───────────────── */}
      {sections.length > 1 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {sections.map((s) => {
            const on = s.id === activeSectionId;
            const conSede = piuSedi && Boolean(s.scuolaNome);
            return (
              <button
                key={s.id}
                onClick={() => setActiveSectionId(s.id)}
                aria-pressed={on}
                // Il nome da solo non identifica più la classe: l'etichetta
                // accessibile porta anche la sede, altrimenti due chip omonime
                // sono indistinguibili per chi usa uno screen reader.
                aria-label={conSede ? `${s.name} — ${s.scuolaNome}` : s.name}
                className={`flex shrink-0 items-center gap-2 rounded-pill py-1.5 pl-1.5 pr-3.5 transition ${
                  on ? 'bg-white shadow-[inset_0_0_0_1.5px_var(--color-kidville-green)]' : 'shadow-[inset_0_0_0_1.5px_rgba(0,106,95,.18)]'
                }`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-full ${on ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream-dark text-kidville-green'}`}>
                  <Users size={15} />
                </span>
                {/* Nome classe e nome sede sono la COPPIA che identifica dove
                    finiscono presenze, diario e voti: `muted` (2,27:1 su crema)
                    era il testo meno leggibile della schermata. Token `sub`
                    (5,82:1) e sede a 11px invece di 10. */}
                <span className="flex min-w-0 flex-col items-start">
                  <span className={`font-barlow text-sm font-extrabold uppercase leading-none ${on ? 'text-kidville-green' : 'text-kidville-sub'}`}>{s.name}</span>
                  {conSede && (
                    <span className="mt-0.5 max-w-[9rem] truncate font-maven text-[11px] leading-none text-kidville-sub">{s.scuolaNome}</span>
                  )}
                </span>
              </button>
            );
          })}
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
                <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">{t('comunicazioniTitolo')}</h2>
                <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-kidville-green px-1.5 font-barlow text-xs font-extrabold text-kidville-yellow">{avvisi.length}</span>
              </div>
              <p className="mt-0.5 font-maven text-[11.5px] text-kidville-warn-strong">{t('comunicazioniSottotitolo')}</p>
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
                          {isAdesione ? t('badgeAdesione') : t('badgePresaVisione')}
                        </span>
                        <span className="ml-auto font-maven text-[10.5px] text-kidville-sub">
                          {a.author ? `${a.author.first_name ?? ''} ${a.author.last_name ?? ''}`.trim() : ''} · {relDate(a.created_at, locale)}
                        </span>
                      </div>
                      <h3 className="mb-0.5 truncate font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">{a.titolo}</h3>
                      <p className="line-clamp-2 font-maven text-xs leading-snug text-kidville-ink">{a.contenuto}</p>
                      {a.stats && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-success-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase text-kidville-success">
                            <Check size={11} strokeWidth={2.8} /> {t('letture', { count: a.stats.letti })}
                          </span>
                          {isAdesione && (
                            <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-info-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase text-kidville-info">
                              {t('adesioniSiNo', { si: a.stats.adesioni_si, no: a.stats.adesioni_no })}
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
            <Megaphone size={14} /> {t('apriBacheca')} <ChevronRight size={14} strokeWidth={2.4} />
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
                <div className="font-barlow text-lg font-black uppercase leading-none text-kidville-green">{t('allergieTitolo')}</div>
                <div className="mt-0.5 font-maven text-[11.5px] text-kidville-warn-strong">
                  {t(isPrimariaOnly ? 'allergieDaSeguireClasse' : 'allergieDaSeguireSezione', { count: allergie.length, sezione: nomeSezione })}
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
                  {/* La NOTA MEDICA di un bambino non è un accento cromatico:
                      su `cream-dark` il giallo scuro stava a 1,59:1 — il
                      contrasto più basso di tutta l'app, proprio sull'unica riga
                      che un docente deve poter leggere di sfuggita. `ink` la
                      porta a 9,51:1 (AAA). */}
                  <span className="inline-flex max-w-[55%] items-center truncate rounded-pill bg-kidville-cream-dark px-2 py-0.5 font-barlow text-[10.5px] font-extrabold uppercase tracking-wide text-kidville-ink">
                    {s.note_mediche}
                  </span>
                </div>
              ))}
            </div>
            <Link href={withUser(isPrimariaOnly ? '/teacher/primaria' : '/teacher/diary')}
              className="flex w-full items-center justify-center gap-1.5 border-t border-kidville-line bg-kidville-cream py-2.5 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green">
              {isPrimariaOnly ? <BookOpen size={15} /> : <NotebookPen size={15} />}
              {isPrimariaOnly ? t('allergieCtaRegistro') : t('allergieCtaDiario')}
              <ChevronRight size={14} strokeWidth={2.4} />
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
              <div className={`font-barlow text-lg font-black uppercase leading-none ${appelloFatto ? 'text-kidville-green' : 'text-white'}`}>{t('appelloTitolo')}</div>
              <div className={`mt-1 font-maven text-xs ${appelloFatto ? 'text-kidville-ink' : 'text-white/80'}`}>
                {appelloFatto
                  ? t('appelloPresentiAssenti', { presenti, assenti })
                  : t(isPrimariaOnly ? 'appelloNonRegistratoClasse' : 'appelloNonRegistratoSezione', { count: studentCount })}
              </div>
            </div>
            <span className={`rounded-pill px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase tracking-wide ${appelloFatto ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-yellow text-kidville-green'}`}>
              {appelloFatto ? t('appelloBadgeFatto') : t('appelloBadgeDaFare')}
            </span>
          </div>
          <Link href={withUser('/teacher/attendance')}
            className={`mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-pill font-barlow text-sm font-extrabold uppercase ${appelloFatto ? 'bg-kidville-green-soft text-kidville-green' : 'bg-kidville-yellow text-kidville-green'}`}>
            <ClipboardCheck size={18} /> {appelloFatto ? t('appelloCtaModifica') : t('appelloCtaFai')} <ChevronRight size={16} strokeWidth={2.4} />
          </Link>
        </div>
      </section>

      {/* ── SCORCIATOIE (DR ScorciatoieBlock) ───────────── */}
      <section className="mt-6">
        <div className="mb-3 px-0.5">
          <Eyebrow>{t('scorciatoieEyebrow')}</Eyebrow>
          <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">{t('scorciatoieTitolo')}</h2>
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
              // Il dettaglio dell'appello dipende dallo stato + conteggio (ICU);
              // per le altre scorciatoie la chiave è `shortcut_<key>_detail`.
              const detail =
                s.key === 'appello'
                  ? (appelloFatto ? t('shortcut_appello_detailFatto', { count: presenti }) : t('shortcut_appello_detailDaFare'))
                  : t(`shortcut_${s.key}_detail`);
              return (
                <Link key={s.key} href={withUser(s.href)}
                  className="flex flex-col rounded-2xl bg-white p-3.5"
                  style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 22px -16px rgba(0,84,75,.28)' }}>
                  <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl"
                    style={{ background: s.tint + '18', color: s.tint }}>
                    <Icon size={20} />
                  </span>
                  <span className="font-barlow text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: s.tint }}>{t(`shortcut_${s.key}_eyebrow`)}</span>
                  <span className="font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{t(`shortcut_${s.key}_title`)}</span>
                  <span className="mt-0.5 font-maven text-[11.5px] leading-snug text-kidville-ink">{detail}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ── AGENDA (DR AgendaCard · eventi_agenda M6) ── */}
      <section className="mt-6">
        <div className="mb-3 px-0.5">
          <Eyebrow>{t('agendaEyebrow')}</Eyebrow>
          <h2 className="font-barlow text-xl font-black uppercase leading-none text-kidville-green">{t(isPrimariaOnly ? 'agendaTitoloClasse' : 'agendaTitoloSezione')}</h2>
        </div>
        <TeacherAgendaCard
          sezione={nomeSezione}
          sectionId={activeSection?.id ?? null}
          userId={userId}
          gruppo={nounGruppo}
        />
      </section>

      {/* footer */}
      <div className="px-4 pb-2 pt-5 text-center font-maven text-[10.5px] text-kidville-sub">
        {t('footerVista')} · {(me?.gradi ?? []).map((g) => gradoLabel(g)).join(' · ') || 'Kidville'}
      </div>
    </div>
  );
}

export default function TeacherDashboardPage() {
  const t = useTranslations('teacherNav');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-sub">{t('caricamento')}</div>}>
      <TeacherDashboardInner />
    </Suspense>
  );
}
