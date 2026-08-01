'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { CalendarRange, Save, Plus, Trash2, CalendarOff, UtensilsCrossed } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { ALLERGENI } from '@/lib/mensa/allergeni';
import { SezioniMultiSelect } from '@/components/features/admin/SezioniMultiSelect';

interface Props { userId: string; scuolaId: string }
interface MenuConfig { id: string; nome: string; ordine: number }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
// `tk` è la chiave i18n (namespace adminMensa) risolta a runtime; `n`/`k` restano
// i valori-dato usati come chiave nelle strutture (settimana-giorno, portata).
const GIORNI_TUTTI = [
  { n: 1, tk: 'giornoLunedi' }, { n: 2, tk: 'giornoMartedi' }, { n: 3, tk: 'giornoMercoledi' },
  { n: 4, tk: 'giornoGiovedi' }, { n: 5, tk: 'giornoVenerdi' }, { n: 6, tk: 'giornoSabato' }, { n: 7, tk: 'giornoDomenica' },
];
const PORTATE = [{ k: 'primo', tk: 'portataPrimo' }, { k: 'secondo', tk: 'portataSecondo' }, { k: 'contorno', tk: 'portataContorno' }, { k: 'frutta', tk: 'portataFrutta' }] as const;
type PortataKey = typeof PORTATE[number]['k'];

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface AllergeniPortate { primo?: string[]; secondo?: string[]; contorno?: string[]; frutta?: string[] }
interface RotRow { settimana: number; giorno_settimana: number; portate: Portate; ingredienti?: Portate; allergeni?: AllergeniPortate; note?: string | null }
interface OvrRow { id?: string; data: string; chiuso: boolean; portate: Portate; ingredienti?: Portate; allergeni?: AllergeniPortate; note?: string | null }

// Editor di una singola portata: nome piatto + ingredienti + allergeni.
function PortataEditor({
  label, nome, ingredienti, allergeni, onNome, onIngredienti, onToggleAllergene,
}: {
  label: string;
  nome: string; ingredienti: string; allergeni: string[];
  onNome: (v: string) => void; onIngredienti: (v: string) => void; onToggleAllergene: (k: string) => void;
}) {
  const t = useTranslations('adminMensa');
  return (
    <div className="rounded-xl border border-kidville-line p-3 bg-white">
      <p className="font-barlow text-[11px] uppercase text-kidville-muted mb-1.5">{label}</p>
      <input value={nome} onChange={e => onNome(e.target.value)} placeholder={t('placeholderNomePiatto')}
        className="w-full border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-xs text-kidville-green focus:border-kidville-green focus:outline-none mb-1.5" />
      <input value={ingredienti} onChange={e => onIngredienti(e.target.value)} placeholder={t('placeholderIngredienti')}
        className="w-full border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-[11px] text-kidville-ink focus:border-kidville-green focus:outline-none mb-2" />
      <div className="flex flex-wrap gap-1">
        {ALLERGENI.map(a => {
          const on = allergeni.includes(a.key);
          return (
            <button key={a.key} type="button" onClick={() => onToggleAllergene(a.key)}
              title={a.label}
              className={`px-2 py-0.5 rounded-full font-maven text-[10px] font-bold border ${on ? 'bg-kidville-error text-white border-kidville-error' : 'bg-white text-kidville-muted border-kidville-line'}`}>
              {a.emoji} {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MenuBuilder({ userId, scuolaId }: Props) {
  const t = useTranslations('adminMensa');
  const f = useDateFormat();
  const [menus, setMenus] = useState<MenuConfig[]>([]);
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);

  const [settimaneTot, setSettimaneTot] = useState(4);
  const [settimana, setSettimana] = useState(1);
  const [giorniAttivi, setGiorniAttivi] = useState<number[]>([1, 2, 3, 4, 5]);
  const [rot, setRot] = useState<Record<string, Portate>>({});
  const [ing, setIng] = useState<Record<string, Portate>>({});
  const [alg, setAlg] = useState<Record<string, AllergeniPortate>>({});
  const [override, setOverride] = useState<OvrRow[]>([]);
  const [done, setDone] = useState(false);
  // Sezioni assegnate al menu selezionato (multi-select reale).
  const [assegnaSezioni, setAssegnaSezioni] = useState<string[]>([]);
  const [assegnaSaved, setAssegnaSaved] = useState(false);
  // nuovo override
  const [ovData, setOvData] = useState('');
  const [ovChiuso, setOvChiuso] = useState(false);
  const [ovPortate, setOvPortate] = useState<Portate>({});
  const [ovIng, setOvIng] = useState<Portate>({});
  const [ovAlg, setOvAlg] = useState<AllergeniPortate>({});

  const giorni = GIORNI_TUTTI.filter(g => giorniAttivi.includes(g.n));

  // Carica la lista dei menu configurati per questa scuola
  useEffect(() => {
    fetch(`/api/mensa/menu-config?scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then(r => r.json())
      .then(j => { if (j.success) setMenus(j.data); });
  }, [userId, scuolaId]);

  const menuConfigParam = selectedMenuId ? `&menu_config_id=${selectedMenuId}` : '';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mensa/menu?userId=${userId}&scuola_id=${scuolaId}&raw=1${menuConfigParam}`, { headers: hdr(userId) });
      const j = await res.json();
      if (!j.success) return;
      if (j.data.config?.settimaneRotazione) setSettimaneTot(j.data.config.settimaneRotazione);
      if (Array.isArray(j.data.config?.giorniAttivi) && j.data.config.giorniAttivi.length) setGiorniAttivi(j.data.config.giorniAttivi);
      const mNome: Record<string, Portate> = {}, mIng: Record<string, Portate> = {}, mAlg: Record<string, AllergeniPortate> = {};
      for (const r of j.data.rotazione as RotRow[]) {
        const k = `${r.settimana}-${r.giorno_settimana}`;
        mNome[k] = r.portate ?? {};
        mIng[k] = r.ingredienti ?? {};
        mAlg[k] = r.allergeni ?? {};
      }
      setRot(mNome); setIng(mIng); setAlg(mAlg);
      setOverride(j.data.override ?? []);
    } finally {
      // no-op: corpo in try/finally per il pattern loader (react-hooks set-state-in-effect)
    }
  }, [userId, scuolaId, menuConfigParam]);

  useEffect(() => { load(); }, [load]);

  // Sezioni attualmente assegnate al menu selezionato.
  useEffect(() => {
    if (!selectedMenuId) return;
    let cancelled = false;
    fetch(`/api/mensa/class-assignments?scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then(r => r.json())
      .then(j => {
        if (cancelled || !j.success) return;
        const names = [...new Set((j.data as { classe: string; menu_config_id: string }[])
          .filter(a => a.menu_config_id === selectedMenuId)
          .map(a => a.classe))];
        setAssegnaSezioni(names);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedMenuId, scuolaId, userId]);

  const salvaSezioni = async () => {
    if (!selectedMenuId) return;
    const res = await fetch('/api/mensa/class-assignments', {
      method: 'PUT', headers: hdr(userId),
      body: JSON.stringify({ scuola_id: scuolaId, menu_config_id: selectedMenuId, classi: assegnaSezioni }),
    });
    const j = await res.json();
    if (j.success) { setAssegnaSaved(true); setTimeout(() => setAssegnaSaved(false), 2500); } else alert(j.error);
  };

  const setNome = (giorno: number, p: PortataKey, val: string) => {
    const key = `${settimana}-${giorno}`;
    setRot(prev => ({ ...prev, [key]: { ...prev[key], [p]: val } }));
  };
  const setIngrediente = (giorno: number, p: PortataKey, val: string) => {
    const key = `${settimana}-${giorno}`;
    setIng(prev => ({ ...prev, [key]: { ...prev[key], [p]: val } }));
  };
  const toggleAllergene = (giorno: number, p: PortataKey, allergene: string) => {
    const key = `${settimana}-${giorno}`;
    setAlg(prev => {
      const cur = prev[key] ?? {};
      const list = cur[p] ?? [];
      const next = list.includes(allergene) ? list.filter(x => x !== allergene) : [...list, allergene];
      return { ...prev, [key]: { ...cur, [p]: next } };
    });
  };

  const salvaRotazione = async () => {
    setDone(false);
    const rows: RotRow[] = [];
    for (const g of giorni) {
      const key = `${settimana}-${g.n}`;
      if (rot[key] || ing[key] || alg[key]) {
        rows.push({ settimana, giorno_settimana: g.n, portate: rot[key] ?? {}, ingredienti: ing[key] ?? {}, allergeni: alg[key] ?? {} });
      }
    }
    const res = await fetch('/api/mensa/menu', {
      method: 'PUT', headers: hdr(userId),
      body: JSON.stringify({ scuola_id: scuolaId, menu_config_id: selectedMenuId, rotazione: rows }),
    });
    const j = await res.json();
    if (j.success) setDone(true); else alert(j.error);
  };

  const toggleOvAllergene = (p: PortataKey, allergene: string) => {
    setOvAlg(prev => {
      const list = prev[p] ?? [];
      const next = list.includes(allergene) ? list.filter(x => x !== allergene) : [...list, allergene];
      return { ...prev, [p]: next };
    });
  };

  const aggiungiOverride = async () => {
    if (!ovData) return;
    const res = await fetch('/api/mensa/menu', {
      method: 'PUT', headers: hdr(userId),
      body: JSON.stringify({
        scuola_id: scuolaId,
        menu_config_id: selectedMenuId,
        override: [{ data: ovData, chiuso: ovChiuso, portate: ovChiuso ? {} : ovPortate, ingredienti: ovChiuso ? {} : ovIng, allergeni: ovChiuso ? {} : ovAlg }],
      }),
    });
    const j = await res.json();
    if (j.success) { setOvData(''); setOvChiuso(false); setOvPortate({}); setOvIng({}); setOvAlg({}); await load(); } else alert(j.error);
  };

  const rimuoviOverride = async (id?: string) => {
    if (!id) return;
    const res = await fetch(`/api/mensa/menu?userId=${userId}&override_id=${id}`, { method: 'DELETE', headers: hdr(userId) });
    const j = await res.json();
    if (j.success) await load(); else alert(j.error);
  };

  return (
    <div className="space-y-8">
      {/* ── Selettore menu (visibile solo se ci sono più menu configurati) ── */}
      {menus.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <UtensilsCrossed size={14} className="text-kidville-green" />
            <span className="font-barlow font-bold text-kidville-green uppercase text-sm">{t('menuLabel')}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedMenuId(null)}
              className={`px-3 py-1.5 rounded-full font-maven text-xs font-bold border-2 ${!selectedMenuId ? 'bg-kidville-green text-white border-kidville-green' : 'bg-white text-kidville-muted border-kidville-line'}`}
            >
              {t('menuUnicoLegacy')}
            </button>
            {menus.map(m => (
              <button
                key={m.id}
                onClick={() => setSelectedMenuId(m.id)}
                className={`px-3 py-1.5 rounded-full font-maven text-xs font-bold border-2 ${selectedMenuId === m.id ? 'bg-kidville-green text-white border-kidville-green' : 'bg-white text-kidville-muted border-kidville-line'}`}
              >
                {m.nome}
              </button>
            ))}
          </div>
          {selectedMenuId && (
            <div className="mt-3 rounded-2xl bg-kidville-cream/40 p-3">
              <p className="font-barlow font-bold text-kidville-green uppercase text-xs mb-2 flex items-center gap-1">
                <UtensilsCrossed size={12} /> {t('sezioniAssegnateA', { nome: menus.find(m => m.id === selectedMenuId)?.nome ?? '' })}
              </p>
              <SezioniMultiSelect
                value={assegnaSezioni}
                onChange={setAssegnaSezioni}
                withLivelloFilter
                emptyHint={t('sezioniEmptyHint')}
              />
              <button onClick={salvaSezioni} className="mt-3 px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven font-bold text-xs flex items-center gap-1">
                <Save size={13} /> {t('salvaSezioni')}
              </button>
              {assegnaSaved && <span className="ml-2 font-maven text-xs text-kidville-success inline-flex items-center gap-1"><SaveCheck size={13} /> {t('assegnazioneSalvata')}</span>}
            </div>
          )}
        </div>
      )}

      {/* ── Rotazione ── */}
      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm flex items-center gap-2"><CalendarRange size={14} /> {t('menuRotazione')}</h3>
          <div className="flex items-center gap-1.5">
            <span className="font-maven text-xs text-kidville-muted">{t('settimana')}</span>
            {Array.from({ length: settimaneTot }, (_, i) => i + 1).map(n => (
              <button key={n} onClick={() => setSettimana(n)}
                className={`w-8 h-8 rounded-full font-maven text-sm font-bold ${settimana === n ? 'bg-kidville-green text-white' : 'bg-white border border-kidville-line text-kidville-muted'}`}>
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {giorni.map(g => {
            const key = `${settimana}-${g.n}`;
            return (
              <div key={g.n} className="rounded-2xl bg-kidville-cream/40 p-3">
                <p className="font-barlow font-bold text-kidville-green text-sm mb-2">{t(g.tk)}</p>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {PORTATE.map(p => (
                    <PortataEditor
                      key={p.k}
                      label={t(p.tk)}
                      nome={rot[key]?.[p.k] ?? ''}
                      ingredienti={ing[key]?.[p.k] ?? ''}
                      allergeni={alg[key]?.[p.k] ?? []}
                      onNome={v => setNome(g.n, p.k, v)}
                      onIngredienti={v => setIngrediente(g.n, p.k, v)}
                      onToggleAllergene={a => toggleAllergene(g.n, p.k, a)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <button onClick={salvaRotazione} className="mt-3 px-4 py-2 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center gap-1">
          <Save size={15} /> {t('salvaSettimana', { n: settimana })}
        </button>
        {done && <span className="ml-2 font-maven text-xs text-kidville-success inline-flex items-center gap-1"><SaveCheck size={14} /> {t('salvato')}</span>}
      </div>

      {/* ── Override per data ── */}
      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><CalendarOff size={14} /> {t('eccezioniPerData')}</h3>

        <div className="bg-kidville-cream/50 rounded-xl p-3 mb-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="font-maven text-[11px] text-kidville-muted block mb-0.5">{t('dataLabel')}</label>
              <DateField value={ovData} onChange={setOvData}
                className="border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-xs text-kidville-green" />
            </div>
            <label className="flex items-center gap-1.5 font-maven text-xs text-kidville-green py-1.5">
              <input type="checkbox" checked={ovChiuso} onChange={e => setOvChiuso(e.target.checked)} /> {t('mensaChiusa')}
            </label>
            <button onClick={aggiungiOverride} className="px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven font-bold text-xs flex items-center gap-1 ml-auto">
              <Plus size={13} /> {t('aggiungi')}
            </button>
          </div>
          {!ovChiuso && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {PORTATE.map(p => (
                <PortataEditor
                  key={p.k}
                  label={t(p.tk)}
                  nome={ovPortate[p.k] ?? ''}
                  ingredienti={ovIng[p.k] ?? ''}
                  allergeni={ovAlg[p.k] ?? []}
                  onNome={v => setOvPortate(prev => ({ ...prev, [p.k]: v }))}
                  onIngredienti={v => setOvIng(prev => ({ ...prev, [p.k]: v }))}
                  onToggleAllergene={a => toggleOvAllergene(p.k, a)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          {override.length === 0 && <p className="font-maven text-sm text-kidville-muted">{t('nessunaEccezione')}</p>}
          {override.map(o => (
            <div key={o.id} className="flex items-center justify-between px-3 py-2 rounded-xl bg-white border border-kidville-line">
              <div className="font-maven text-sm text-kidville-green">
                <b>{intlDateTime(f.locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${o.data}T00:00:00Z`))}</b>
                {o.chiuso ? <span className="ml-2 text-kidville-error">{t('chiusa')}</span> : (
                  <span className="ml-2 text-kidville-muted text-xs">{[o.portate?.primo, o.portate?.secondo, o.portate?.contorno, o.portate?.frutta].filter(Boolean).join(' · ')}</span>
                )}
              </div>
              <button onClick={() => rimuoviOverride(o.id)} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
