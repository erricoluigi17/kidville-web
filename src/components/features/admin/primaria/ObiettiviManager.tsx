'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { creaMuta } from '@/lib/ui/muta';

interface Obiettivo {
  id: string;
  materia_codice: string;
  livello: number;
  codice: string | null;
  descrizione: string;
  attivo: boolean;
}

// Primo elemento = codice materia (valore persistito/confrontato); secondo = chiave i18n dell'etichetta.
const MATERIE_STD = [
  ['italiano', 'obiettiviMateriaItaliano'], ['matematica', 'obiettiviMateriaMatematica'], ['storia', 'obiettiviMateriaStoria'],
  ['geografia', 'obiettiviMateriaGeografia'], ['scienze', 'obiettiviMateriaScienze'], ['inglese', 'obiettiviMateriaInglese'],
  ['arte', 'obiettiviMateriaArte'], ['musica', 'obiettiviMateriaMusica'], ['ed_fisica', 'obiettiviMateriaEdFisica'],
  ['tecnologia', 'obiettiviMateriaTecnologia'], ['religione', 'obiettiviMateriaReligione'], ['ed_civica', 'obiettiviMateriaEdCivica'],
] as const;

export function ObiettiviManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [materiaCodice, setMateriaCodice] = useState('italiano');
  const [livello, setLivello] = useState(1);
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [nuovo, setNuovo] = useState({ codice: '', descrizione: '' });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    let next: Obiettivo[] | null = null;
    try {
      const r = await fetch(
        `/api/admin/primaria/obiettivi?scuolaId=${scuolaId}&materiaCodice=${materiaCodice}&livello=${livello}`,
        { headers: { 'x-user-id': userId } }
      );
      const d = await r.json();
      next = d.success ? d.data : [];
    } finally {
      if (next) setObiettivi(next);
    }
  }, [scuolaId, materiaCodice, livello, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * «Aggiungi» mostrava il rifiuto, «elimina» no: la firma della dimenticanza,
   * non della scelta. I due ripieghi restano distinti perché dicono in che
   * STATO è il dato — non registrato, oppure ancora al suo posto.
   */
  const { mutaSalva, mutaElimina } = useMemo(() => {
    const comuni = { route: '/admin/impostazioni', ricarica: load, setErrore: setError };
    return {
      mutaSalva: creaMuta({ ...comuni, fallback: t('comuneErroreSalvataggio') }),
      mutaElimina: creaMuta({ ...comuni, fallback: t('comuneErroreEliminazione') }),
    };
  }, [load, t]);

  const add = async () => {
    if (!nuovo.descrizione) return;
    // I campi si svuotano SOLO se il server ha accettato: la descrizione di un
    // obiettivo è lunga da riscrivere, e riscriverla è il momento in cui si
    // rinuncia.
    const ok = await mutaSalva(
      `/api/admin/primaria/obiettivi?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ scuolaId, materiaCodice, livello, codice: nuovo.codice || null, descrizione: nuovo.descrizione }),
      },
      'primaria-obiettivo-nuovo-respinto',
    );
    if (ok) setNuovo({ codice: '', descrizione: '' });
  };

  const remove = async (o: Obiettivo) => {
    await mutaElimina(
      `/api/admin/primaria/obiettivi?id=${o.id}&userId=${userId}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      'primaria-obiettivo-elimina-respinto',
      // Il codice quando c'è (è corto e identifica la riga), altrimenti la
      // descrizione. Resta a schermo: `muta` non lo logga.
      o.codice || o.descrizione,
    );
  };

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={materiaCodice}
          onChange={(e) => setMateriaCodice(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
        >
          {MATERIE_STD.map(([c, labelKey]) => (
            <option key={c} value={c}>{t(labelKey)}</option>
          ))}
        </select>
        <select
          value={livello}
          onChange={(e) => setLivello(Number(e.target.value))}
          className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
        >
          {[1, 2, 3, 4, 5].map((l) => (
            <option key={l} value={l}>{t('comuneLivelloOrdinale', { livello: l })}</option>
          ))}
        </select>
      </div>

      <ul className="divide-y divide-kidville-line">
        {obiettivi.map((o) => (
          <li key={o.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="font-maven text-sm text-kidville-ink">
              {o.codice && <span className="mr-2 text-xs font-semibold text-kidville-green">{o.codice}</span>}
              {o.descrizione}
            </div>
            <button onClick={() => remove(o)} aria-label={t('obiettiviElimina')} className="text-kidville-muted hover:text-kidville-error shrink-0">
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {obiettivi.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">{t('obiettiviNessuno')}</li>}
      </ul>

      <div className="flex flex-wrap items-end gap-2 border-t border-kidville-line pt-4">
        <div>
          <label className="block font-maven text-xs text-kidville-muted">{t('obiettiviCodiceOpz')}</label>
          <input
            value={nuovo.codice}
            onChange={(e) => setNuovo((s) => ({ ...s, codice: e.target.value }))}
            className="font-maven w-24 rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder={t('obiettiviPlaceholderCodice')}
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block font-maven text-xs text-kidville-muted">{t('obiettiviDescrizione')}</label>
          <input
            value={nuovo.descrizione}
            onChange={(e) => setNuovo((s) => ({ ...s, descrizione: e.target.value }))}
            className="font-maven w-full rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder={t('obiettiviPlaceholderDescrizione')}
          />
        </div>
        <button
          onClick={add}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> {t('comuneAggiungi')}
        </button>
      </div>
    </div>
  );
}
