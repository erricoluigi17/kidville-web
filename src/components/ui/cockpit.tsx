'use client';

/**
 * Primitive del COCKPIT Direzione/Segreteria (desktop). Ricostruzione on-token
 * del design DR (`admin/ui.jsx` + `design-export/ds.css`): PageHeader, SectionTitle,
 * StatCard, Tabs, Toolbar, Select, Donut, Bar, IconChip, Drawer, Live, Toggle e le
 * classi tabella. Solo LIGHT: nessun `dark:`, solo token `kidville-*`.
 *
 * Colori-di-stato dinamici (grado/materia o accenti per-dato) passano via prop
 * `tone` mappata sui token semantici (green/info/warn/error/success/neutral/yellow).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import { Search, X, ChevronDown, Check } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { SHADOW_CARD, SHADOW_FLOAT } from '@/components/ui/Card';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { TONE_HEX, TRACK } from '@/lib/ui/chart-colors';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useSediAttive } from '@/lib/context/sede-context';

export type Tone = 'green' | 'info' | 'warn' | 'error' | 'success' | 'neutral' | 'yellow';

/** Classi token per ciascun tono: testo forte, accento bordo, chip morbido. */
export const TONE: Record<Tone, { text: string; border: string; chipBg: string; softBg: string; dot: string }> = {
  green:   { text: 'text-kidville-green',   border: 'border-kidville-green',   chipBg: 'bg-kidville-green/[0.10]',   softBg: 'bg-kidville-green-soft',   dot: 'bg-kidville-green' },
  info:    { text: 'text-kidville-info',    border: 'border-kidville-info',    chipBg: 'bg-kidville-info/[0.10]',    softBg: 'bg-kidville-info-soft',    dot: 'bg-kidville-info' },
  warn:    { text: 'text-kidville-warn',    border: 'border-kidville-warn',    chipBg: 'bg-kidville-warn/[0.10]',    softBg: 'bg-kidville-warn-soft',    dot: 'bg-kidville-warn' },
  error:   { text: 'text-kidville-error',   border: 'border-kidville-error',   chipBg: 'bg-kidville-error/[0.10]',   softBg: 'bg-kidville-error-soft',   dot: 'bg-kidville-error' },
  success: { text: 'text-kidville-success', border: 'border-kidville-success', chipBg: 'bg-kidville-success/[0.10]', softBg: 'bg-kidville-success-soft', dot: 'bg-kidville-success' },
  neutral: { text: 'text-kidville-neutral', border: 'border-kidville-neutral', chipBg: 'bg-kidville-neutral/[0.10]', softBg: 'bg-kidville-neutral-soft', dot: 'bg-kidville-neutral' },
  yellow:  { text: 'text-kidville-yellow',  border: 'border-kidville-yellow',  chipBg: 'bg-kidville-yellow/[0.15]',  softBg: 'bg-kidville-yellow-soft',  dot: 'bg-kidville-yellow' },
};

/** Contenitore pagina cockpit (larghezza desktop, padding DR). */
export function CockpitPage({ children, className, max = 1360 }: { children: React.ReactNode; className?: string; max?: number }) {
  return (
    <div className={cx('mx-auto px-6 pb-16 pt-6 sm:px-8', className)} style={{ maxWidth: max }}>
      {children}
    </div>
  );
}

/** Chip icona quadrato colorato (accento morbido). */
export function IconChip({ icon: Icon, tone = 'green', size = 44, radius = 12, solid = false }: { icon: LucideIcon; tone?: Tone; size?: number; radius?: number; solid?: boolean }) {
  const t = TONE[tone];
  return (
    <div
      className={cx('flex shrink-0 items-center justify-center', solid ? cx(t.softBg.replace('-soft', ''), 'text-kidville-white') : cx(t.chipBg, t.text))}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={2.1} />
    </div>
  );
}

/**
 * Header pagina del cockpit: ADAPTER su `PageHeaderCard`. Le `actions` NON
 * vanno nello slot `action` della card (progettato per UNA pill compatta e
 * dentro il remap `.kv-tab-giallo`): si rendono in una riga wrappabile SOTTO
 * la card — (a) ripristina il flex-wrap del vecchio header su mobile,
 * (b) esce dal contesto di remap (niente CTA green-dark-su-verde),
 * (c) libera lo slot `action` → mascotte su TUTTE le pagine admin (design
 * scelto). L'<h1> resta il `title` passato, invariato (vincolo e2e).
 */
export function PageHeader({ icon, title, subtitle, actions, eyebrow }: { icon?: LucideIcon; title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  const t = useTranslations('shared');
  return (
    <div className="mb-6">
      <PageHeaderCard
        eyebrow={typeof eyebrow === 'string' ? eyebrow : t('direzioneSegreteria')}
        title={title}
        icon={icon}
        subtitle={subtitle}
      />
      {actions && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5">{actions}</div>
      )}
    </div>
  );
}

/** CTA primario della riga azioni header (cockpit): bianco su verde = 6,5:1 (AA).
 *  NON sostituisce Btn/btnClass (condivisi, giallo-su-verde brand): vale SOLO
 *  per la riga azioni delle pagine admin. */
export const HEADER_BTN = 'inline-flex items-center justify-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-white transition-all hover:bg-kidville-green-dark active:scale-[0.98] disabled:opacity-50';

/** Titolo di sezione dentro una card. */
export function SectionTitle({ icon: Icon, title, sub, action }: { icon?: LucideIcon; title: string; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <span className="flex shrink-0 text-kidville-green"><Icon size={20} strokeWidth={2.1} /></span>}
        <div className="min-w-0">
          <h2 className="font-barlow text-[19px] font-extrabold uppercase leading-[1.05] tracking-[0.01em] text-kidville-green">{title}</h2>
          {sub && <div className="mt-0.5 font-maven text-[12.5px] text-kidville-muted">{sub}</div>}
        </div>
      </div>
      {action}
    </div>
  );
}

/** Stat-card con accento (bordo left o top) + chip icona + valore grande. */
export function StatCard({ icon: Icon, label, value, sub, tone = 'green', accent = 'left' }: { icon?: LucideIcon; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; accent?: 'left' | 'top' }) {
  const t = TONE[tone];
  return (
    <div
      className={cx('flex min-w-0 items-center gap-3 rounded-card bg-kidville-white px-4 py-3.5', accent === 'left' ? cx('border-l-4', t.border) : cx('border-t-4', t.border))}
      style={{ boxShadow: SHADOW_CARD }}
    >
      {Icon && (
        <div className={cx('flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px]', t.chipBg, t.text)}>
          <Icon size={19} strokeWidth={2.1} />
        </div>
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className={cx('font-barlow text-[26px] font-black leading-none', t.text)}>{value}</span>
          {/* label/sub sono contenuto informativo (non decorativo) → -sub per l'AA
              (muted/neutral su bianco erano 2,5–3,1:1, ciclo 1 RC5). */}
          {sub && <span className="font-maven text-xs text-kidville-sub">{sub}</span>}
        </div>
        <div className="mt-1 font-barlow text-[11.5px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{label}</div>
      </div>
    </div>
  );
}

export interface TabOption { id: string; label: string; count?: number; icon?: LucideIcon }

/**
 * Tabs a PILLOLE (linguaggio dell'app): attiva verde-piena testo bianco,
 * inattiva bianca con ring `kidville-line`. API invariata `{value,options,
 * onChange,className}`. Lo stato attivo è esposto in modo accessibile con
 * `aria-pressed`, e il focus da tastiera è sempre visibile.
 */
export function Tabs({ value, options, onChange, className }: { value: string; options: TabOption[]; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={cx('kv-cockpit-tabs mb-5 flex flex-wrap gap-2', className)}>
      {options.map((o) => {
        const on = value === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-pill px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.02em] transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
              on
                ? 'bg-kidville-green text-kidville-white'
                : 'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50',
            )}
          >
            {Icon && <Icon size={16} strokeWidth={2.1} />}
            {o.label}
            {o.count != null && (
              <span className={cx('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill px-1.5 font-barlow text-[11px] font-extrabold', on ? 'bg-kidville-white/25 text-kidville-white' : 'bg-kidville-neutral-soft text-kidville-neutral')}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Toolbar: ricerca (opzionale) + filtri/azioni a destra. */
export function Toolbar({ search, onSearch, placeholder, children }: { search?: string; onSearch?: (v: string) => void; placeholder?: string; children?: React.ReactNode }) {
  const t = useTranslations('shared');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {onSearch && (
        <div className="relative min-w-[220px] flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kidville-neutral"><Search size={17} /></span>
          <input
            value={search ?? ''}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder ?? t('cerca')}
            className="h-[42px] w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-10 pr-3.5 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
          />
        </div>
      )}
      {children}
    </div>
  );
}

/** Select brandizzato (native). */
export function CockpitSelect({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx('h-[42px] cursor-pointer rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-[13.5px] text-kidville-ink outline-none transition-colors hover:border-kidville-green/50 focus:border-kidville-green focus-visible:ring-2 focus-visible:ring-kidville-green/30', className)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Barra di avanzamento orizzontale. `colorVar` per tinte per-dato (es. var(--kv-grade-*)). */
export function Bar({ value, max, tone = 'green', colorVar, height = 8 }: { value: number; max: number; tone?: Tone; colorVar?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className="w-full overflow-hidden rounded-pill bg-kidville-neutral-soft" style={{ height }}>
      <div className={cx('h-full rounded-pill', !colorVar && TONE[tone].dot)} style={{ width: pct + '%', ...(colorVar ? { background: colorVar } : null) }} />
    </div>
  );
}

/** Anello donut SVG con etichetta centrale. */
export function Donut({ value, max, size = 116, stroke = 12, label, sub, tone = 'green', colorVar }: { value: number; max: number; size?: number; stroke?: number; label: React.ReactNode; sub?: React.ReactNode; tone?: Tone; colorVar?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  // Colori dal mirror dei token (`chart-colors`): gli attributi SVG `stroke`
  // non risolvono in modo affidabile `var(--color-kidville-*)`.
  const color = colorVar ?? TONE_HEX[tone];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <div className="font-barlow font-black text-kidville-green" style={{ fontSize: size * 0.27 }}>{label}</div>
        {sub && <div className="mt-0.5 font-maven text-[11px] text-kidville-muted">{sub}</div>}
      </div>
    </div>
  );
}

/** Indicatore "Live" con pallino pulsante. */
export function Live({ label }: { label?: string }) {
  const t = useTranslations('shared');
  return (
    <span className="inline-flex items-center gap-1.5 font-maven text-xs font-semibold text-kidville-success">
      <span className="h-2 w-2 animate-pulse rounded-pill bg-kidville-success" />
      {label ?? t('live')}
    </span>
  );
}

/** Toggle switch (on/off). */
export function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cx('relative h-[26px] w-[44px] shrink-0 rounded-pill transition-colors disabled:opacity-50', on ? 'bg-kidville-green' : 'bg-kidville-neutral-soft')}
    >
      <span className={cx('absolute top-[3px] h-5 w-5 rounded-pill bg-kidville-white shadow transition-transform', on ? 'translate-x-[21px]' : 'translate-x-[3px]')} />
    </button>
  );
}

/* ── Tabella cockpit: classi condivise (th uppercase muted, righe hover cream) ── */
export const TABLE_WRAP = 'kv-table-scroll overflow-x-auto';
export const TABLE = 'w-full border-collapse';
export const TH = 'whitespace-nowrap px-3 pb-2.5 text-left font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub';
export const TD = 'border-t border-kidville-line px-3 py-2.5 align-middle';
export const TROW = 'transition-colors hover:bg-kidville-cream';

/** Drawer / slide-over destro con scrim. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 460 }: { open: boolean; onClose: () => void; title?: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  const t = useTranslations('shared');
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-kidville-ink/30 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className="absolute inset-y-0 right-0 flex max-w-[92%] flex-col bg-kidville-white"
        style={{ width, boxShadow: SHADOW_FLOAT }}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-3 border-b border-kidville-line px-6 py-5">
            <div className="min-w-0">
              {typeof title === 'string' ? <h2 className="font-barlow text-2xl font-black uppercase leading-none text-kidville-green">{title}</h2> : title}
              {subtitle && <div className="mt-1 font-maven text-[13px] text-kidville-muted">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} aria-label={t('chiudi')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green outline-none transition-colors hover:bg-kidville-green-soft focus-visible:ring-2 focus-visible:ring-kidville-green">
              <X size={19} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-kidville-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Selettore sede della TopBar: MULTI-select (Fase B). Le sedi accessibili e la
 * selezione vivono nel contesto condiviso (@/lib/context/sede-context), che
 * persiste il cookie `sedi_attive` e fa ri-scopare i dati server-side. Il
 * dropdown resta aperto durante il toggle (selezione multipla); "Tutte le sedi"
 * azzera il filtro. Con una sola sede accessibile il toggle è inerte (già "tutte").
 *
 * `compatto` è la variante per la topbar MOBILE (`AdminTopBarMobile`), dove lo
 * spazio è quello di un telefono: una riga sola, niente contatore alunni (e
 * quindi nessuna chiamata a /api/admin/dashboard in più su ogni pagina del
 * cockpit), dropdown ancorato a destra. Con una sede sola non si monta affatto:
 * non c'è niente da scegliere e sulla barra mobile ogni pixel conta.
 */
export function SedeSelector({ userId, compatto = false }: { userId?: string | null; compatto?: boolean }) {
  const t = useTranslations('shared');
  const tn = useTranslations('adminNav');
  const { sedi, effettive, toggle, tutte } = useSediAttive();
  const [open, setOpen] = useState(false);
  const [totAlunni, setTotAlunni] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Il conteggio serve solo al ramo desktop, e solo quando il selettore esiste
    // davvero: con una sede sola non si monta (vedi sotto), e chiedere il numero
    // di alunni su OGNI pagina del cockpit per non mostrarlo mai è traffico
    // regalato.
    if (compatto || sedi.length <= 1) return;
    const q = userId ? `?userId=${userId}` : '';
    // `x-sedi`: segnala lo scope attivo (il server scopa dal cookie) e fa
    // ri-conteggiare al cambio selezione. effettive è così referenziato (deps).
    fetch(`/api/admin/dashboard${q}`, { headers: { 'x-sedi': effettive.join(',') } })
      .then((r) => r.json())
      .then((d) => { const n = d?.studenti?.iscritti ?? d?.data?.studenti?.iscritti; if (typeof n === 'number') setTotAlunni(n); })
      // Un `catch` che non logga è un bug (AGENTS.md §6): qui il conteggio
      // resta al valore precedente, cioè il selettore mostra un numero di
      // alunni di una sede che non è più quella attiva — senza dirlo a nessuno.
      .catch((e) => {
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `sede-selettore-conteggio-fallito: ${nomeErrore(e)}`,
          route: '/admin',
        });
      });
  }, [userId, effettive, compatto, sedi.length]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const sel = new Set(effettive);
  const tutteAttive = effettive.length === sedi.length; // include il caso "cookie vuoto"
  const strutture = (n: number) => t('strutturePlurale', { n });
  const nome = tutteAttive
    ? t('tutteLeSedi')
    : effettive.length === 1
      ? (sedi.find((s) => s.id === effettive[0])?.nome ?? t('sediPlurale', { n: 1 }))
      : t('sediPlurale', { n: effettive.length });
  const meta = `${totAlunni != null ? `${t('alunniPlurale', { n: totAlunni })} · ` : ''}${strutture(tutteAttive ? sedi.length : effettive.length)}`;

  // Con una sede sola non c'è NIENTE da scegliere: il menu offrirebbe due voci
  // equivalenti («Tutte le sedi» e l'unica sede) e l'etichetta direbbe «TUTTE LE
  // SEDI · 1 struttura» — un plurale per un plesso solo. La guardia esisteva già
  // sul ramo compatto (mobile); vale identica sul desktop, e vale anche mentre
  // le sedi si stanno ancora caricando (`sedi` vuoto), per non far lampeggiare
  // un'etichetta che poi cambia.
  if (sedi.length <= 1) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title={compatto ? tn('sedeSelettoreAria') : undefined}
        className={cx(
          'flex items-center rounded-[12px] bg-kidville-white/[0.12] text-kidville-white',
          compatto ? 'min-h-[36px] max-w-[52vw] gap-1.5 px-2.5 py-1.5' : 'gap-2.5 px-3 py-[7px]',
        )}
      >
        <span className="flex shrink-0 text-kidville-yellow"><SchoolIcon /></span>
        <span className="min-w-0 text-left leading-[1.1]">
          <span className={cx('block truncate font-barlow font-extrabold uppercase', compatto ? 'text-[12.5px]' : 'text-sm')}>{nome}</span>
          {!compatto && <span className="block font-maven text-[10.5px] text-kidville-white/70">{meta}</span>}
        </span>
        <ChevronDown size={compatto ? 14 : 16} className="shrink-0 text-kidville-white/80" />
      </button>
      {open && (
        <div
          className={cx(
            'absolute top-[calc(100%+8px)] z-[60] w-[264px] max-w-[86vw] rounded-[14px] bg-kidville-white p-1.5',
            compatto ? 'right-0' : 'left-0',
          )}
          style={{ boxShadow: SHADOW_FLOAT }}
        >
          <SedeRow active={tutteAttive} nome={t('tutteLeSedi')} meta={t('strutturePlurale', { n: sedi.length })} onClick={() => { tutte(); }} />
          {sedi.map((s) => (
            <SedeRow key={s.id} active={!tutteAttive && sel.has(s.id)} nome={s.nome} meta="" onClick={() => { toggle(s.id); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function SedeRow({ active, nome, meta, onClick }: { active: boolean; nome: string; meta: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left', active ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream')}>
      <span className={cx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]', active ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-green')}><SchoolIcon /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-barlow text-[14.5px] font-extrabold uppercase text-kidville-green">{nome}</span>
        {meta && <span className="block truncate font-maven text-[11.5px] text-kidville-muted">{meta}</span>}
      </span>
      {active && <Check size={16} className="shrink-0 text-kidville-green" />}
    </button>
  );
}

function SchoolIcon() {
  // building/scuola (lucide "School" equivalente compatto)
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 22v-4a2 2 0 0 0-4 0v4" /><path d="m18 10 4 2v10H2V12l4-2" /><path d="M18 5v17" /><path d="m4 6 8-4 8 4" /><path d="M6 5v17" /><circle cx="12" cy="9" r="2" />
    </svg>
  );
}
