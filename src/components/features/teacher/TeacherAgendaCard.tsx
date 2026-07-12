'use client';

import { useCallback, useEffect, useState } from 'react';
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

const TIPI = [
  { value: 'evento', label: 'Evento' },
  { value: 'uscita', label: 'Uscita' },
  { value: 'scadenza', label: 'Scadenza' },
  { value: 'riunione', label: 'Riunione' },
] as const;

const TIPO_LABEL: Record<string, string> = Object.fromEntries(TIPI.map((t) => [t.value, t.label]));

function giornoMese(ymd: string): { giorno: string; mese: string } {
  try {
    const d = new Date(`${ymd}T00:00:00`);
    return {
      giorno: d.toLocaleDateString('it-IT', { day: 'numeric' }),
      mese: d.toLocaleDateString('it-IT', { month: 'short' }).replace('.', ''),
    };
  } catch {
    return { giorno: '—', mese: '' };
  }
}

const inputCls =
  'w-full rounded-input border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink placeholder:text-kidville-muted focus:border-kidville-green focus:outline-none';

export function TeacherAgendaCard({
  sezione,
  userId,
  gruppo = 'sezione',
}: {
  sezione: string;
  userId: string | null;
  /** Lessico per grado: "sezione" (0-6) o "classe" (primaria). */
  gruppo?: 'sezione' | 'classe';
}) {
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
      const res = await fetch(
        `/api/agenda?sezione=${encodeURIComponent(sezione)}${userId ? `&userId=${userId}` : ''}`
      ).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (Array.isArray(j?.data)) setEventi(j.data.slice(0, 6));
    } finally {
      setLoading(false);
    }
  }, [sezione, userId]);

  useEffect(() => {
    if (!sezione || !userId) return;
    void load();
  }, [sezione, userId, load]);

  if (!sezione) {
    return (
      <div className="rounded-2xl border border-dashed border-kidville-line bg-white/60 p-5 text-center">
        <p className="font-maven text-[12.5px] leading-snug text-kidville-muted">
          Nessuna {gruppo} assegnata: l&apos;agenda apparirà qui.
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
          sezione,
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
        setErrore('Salvataggio non riuscito. Riprova.');
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
            Nessun evento in programma per la {gruppo}.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-kidville-line">
          {eventi.map((e) => {
            const { giorno, mese } = giornoMese(e.data);
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
                    {TIPO_LABEL[e.tipo] ?? e.tipo}
                    {e.orario_inizio ? ` · ore ${e.orario_inizio.slice(0, 5)}` : ''}
                    {e.visibile_genitori ? '' : ' · solo staff'}
                    {e.section_id === null ? ' · plesso' : ''}
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
          Nuovo evento
        </p>
        <input
          type="text"
          value={titolo}
          onChange={(e) => setTitolo(e.target.value)}
          placeholder="Titolo (es. Uscita al parco)"
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
            {TIPI.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
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
            Visibile ai genitori
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !titolo.trim()}
            className="rounded-pill bg-kidville-green px-4 py-2 font-barlow text-[11.5px] font-extrabold uppercase tracking-wide text-white active:scale-95 disabled:opacity-60"
          >
            {saving ? 'Salvataggio…' : 'Aggiungi'}
          </button>
        </div>
        {errore && (
          <p className="mt-2 font-maven text-[12px] text-kidville-error">{errore}</p>
        )}
      </div>
    </div>
  );
}
