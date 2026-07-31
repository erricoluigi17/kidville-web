'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { CalendarDays } from 'lucide-react';

/**
 * Agenda della sezione attiva per la home docente (M6.4, DR AgendaCard):
 * lista eventi (plesso + sezione, da /api/agenda) + composer inline on-token
 * (titolo, data, tipo, visibile ai genitori → POST /api/agenda).
 */

interface EventoAgenda {
  id: string;
  section_id: string | null;
  titolo: string;
  tipo: string;
  data: string; // YYYY-MM-DD
  orario_inizio?: string | null;
  visibile_genitori: boolean;
}

// Tipi dell'agenda: il `value` è il discriminatore persistito (dato, non
// tradotto); l'etichetta è i18n, risolta a runtime dalla `labelKey`.
const TIPI = [
  { value: 'evento', labelKey: 'tipoEvento' },
  { value: 'uscita', labelKey: 'tipoUscita' },
  { value: 'scadenza', labelKey: 'tipoScadenza' },
  { value: 'riunione', labelKey: 'tipoRiunione' },
] as const;

const TIPO_LABEL_KEY: Record<string, string> = Object.fromEntries(TIPI.map((ti) => [ti.value, ti.labelKey]));

function giornoMese(ymd: string, locale: string): { giorno: string; mese: string } {
  try {
    const d = new Date(`${ymd}T00:00:00`);
    return {
      giorno: d.toLocaleDateString(locale, { day: 'numeric' }),
      mese: d.toLocaleDateString(locale, { month: 'short' }).replace('.', ''),
    };
  } catch {
    return { giorno: '—', mese: '' };
  }
}

const inputCls =
  'w-full rounded-input border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink placeholder:text-kidville-muted focus:border-kidville-green focus:outline-none';

export function TeacherAgendaCard({
  sezione,
  sectionId = null,
  userId,
  gruppo = 'sezione',
}: {
  /** Nome della classe: serve alle etichette, non più a identificarla. */
  sezione: string;
  /**
   * Identità della sezione (`sections.id`). È ciò che viaggia al server.
   *
   * ⚠️ Fino al 2026-07-31 partiva solo il NOME, e `/api/agenda` lo risolveva con
   * un `LIMIT 1` senza `ORDER BY`: con «2 ANNI» presente ad Aversa e a Cesa
   * l'evento — e la notifica alle famiglie — finiva in un plesso scelto dal
   * pianificatore di query. Oggi la route è fail-closed (400 sull'omonimo):
   * senza `section_id` la creazione si fermerebbe.
   */
  sectionId?: string | null;
  userId: string | null;
  /** Lessico per grado: "sezione" (0-6) o "classe" (primaria). */
  gruppo?: 'sezione' | 'classe';
}) {
  const t = useTranslations('teacherNav');
  const locale = useLocale();
  const isClasse = gruppo === 'classe';
  const [eventi, setEventi] = useState<EventoAgenda[]>([]);
  const [loading, setLoading] = useState(true);
  const [titolo, setTitolo] = useState('');
  const [dataEvento, setDataEvento] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [tipo, setTipo] = useState<string>('evento');
  const [visibile, setVisibile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // `section_id` quando c'è: la lettura ha lo stesso perimetro della
      // scrittura, quindi non si crea un evento che poi non si rivede (o si
      // rivede quello dell'omonima di un'altra sede).
      const filtro = sectionId
        ? `section_id=${encodeURIComponent(sectionId)}`
        : `sezione=${encodeURIComponent(sezione)}`;
      const res = await fetch(
        `/api/agenda?${filtro}${userId ? `&userId=${userId}` : ''}`
      ).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (Array.isArray(j?.data)) setEventi(j.data.slice(0, 6));
    } finally {
      setLoading(false);
    }
  }, [sezione, sectionId, userId]);

  useEffect(() => {
    if (!sezione || !userId) return;
    void load();
  }, [sezione, userId, load]);

  if (!sezione) {
    return (
      <div className="rounded-2xl border border-dashed border-kidville-line bg-white/60 p-5 text-center">
        <p className="font-maven text-[12.5px] leading-snug text-kidville-muted">
          {t(isClasse ? 'agendaNessunaAssegnataClasse' : 'agendaNessunaAssegnataSezione')}
        </p>
      </div>
    );
  }

  const submit = async () => {
    if (!titolo.trim() || !dataEvento || saving) return;
    setSaving(true);
    setErrore(null);
    try {
      const res = await fetch(`/api/agenda${userId ? `?userId=${userId}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Identità se c'è, nome solo come ripiego: il server non deve mai
          // scegliere fra due classi omonime al posto del docente.
          ...(sectionId ? { section_id: sectionId } : { sezione }),
          titolo: titolo.trim(),
          data: dataEvento,
          tipo,
          visibile_genitori: visibile,
        }),
      }).catch(() => null);
      if (res?.ok) {
        setTitolo('');
        await load();
      } else {
        // Il motivo del rifiuto viene dal server (es. «Specificare la sede»):
        // una scrittura muta è una scrittura persa. Il titolo NON si azzera,
        // così l'evento si può ancora salvare dopo aver corretto.
        const j = res ? await res.json().catch(() => null) : null;
        const messaggio = typeof j?.error === 'string' && j.error.trim() !== '' ? j.error : null;
        setErrore(messaggio ?? t('agendaErroreSalvataggio'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="rounded-2xl bg-white p-4"
      style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 22px -16px rgba(0,84,75,.28)' }}
    >
      {loading ? (
        <div className="space-y-2">
          <div className="h-10 animate-pulse rounded-xl bg-kidville-line/60" />
          <div className="h-10 animate-pulse rounded-xl bg-kidville-line/60" />
        </div>
      ) : eventi.length === 0 ? (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-kidville-green-soft text-kidville-green">
            <CalendarDays size={20} />
          </span>
          <p className="font-maven text-[12.5px] leading-snug text-kidville-muted">
            {t(isClasse ? 'agendaNessunEventoClasse' : 'agendaNessunEventoSezione')}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-kidville-line">
          {eventi.map((e) => {
            const { giorno, mese } = giornoMese(e.data, locale);
            return (
              <div key={e.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-xl bg-kidville-yellow-soft text-kidville-yellow-dark">
                  <span className="font-barlow text-[15px] font-black leading-none">{giorno}</span>
                  <span className="font-barlow text-[9px] font-bold uppercase leading-none">{mese}</span>
                </span>
                <div className="min-w-0">
                  <p className="truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">
                    {e.titolo}
                  </p>
                  <p className="mt-0.5 font-maven text-[12px] leading-snug text-kidville-muted">
                    {TIPO_LABEL_KEY[e.tipo] ? t(TIPO_LABEL_KEY[e.tipo]) : e.tipo}
                    {e.orario_inizio ? ` · ${t('agendaOre', { orario: e.orario_inizio.slice(0, 5) })}` : ''}
                    {e.visibile_genitori ? '' : ` · ${t('agendaSoloStaff')}`}
                    {e.section_id === null ? ` · ${t('agendaPlesso')}` : ''}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* composer inline (M6.4) */}
      <div className="mt-3 border-t border-kidville-line pt-3">
        <p className="font-barlow text-[10px] font-bold uppercase tracking-[0.08em] text-kidville-yellow-dark">
          {t('agendaNuovoEvento')}
        </p>
        <input
          type="text"
          value={titolo}
          onChange={(e) => setTitolo(e.target.value)}
          placeholder={t('agendaTitoloPlaceholder')}
          maxLength={200}
          className={`mt-2 ${inputCls}`}
        />
        <div className="mt-2 flex gap-2">
          <input
            type="date"
            value={dataEvento}
            onChange={(e) => setDataEvento(e.target.value)}
            className={inputCls}
          />
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={inputCls}>
            {TIPI.map((ti) => (
              <option key={ti.value} value={ti.value}>{t(ti.labelKey)}</option>
            ))}
          </select>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 font-maven text-[12.5px] text-kidville-ink">
            <input
              type="checkbox"
              checked={visibile}
              onChange={(e) => setVisibile(e.target.checked)}
              className="accent-kidville-green"
            />
            {t('agendaVisibileGenitori')}
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !titolo.trim()}
            className="rounded-pill bg-kidville-green px-4 py-2 font-barlow text-[11.5px] font-extrabold uppercase tracking-wide text-white active:scale-95 disabled:opacity-60"
          >
            {saving ? t('agendaSalvataggio') : t('agendaAggiungi')}
          </button>
        </div>
        {errore && (
          <p className="mt-2 font-maven text-[12px] text-kidville-error">{errore}</p>
        )}
      </div>
    </div>
  );
}
