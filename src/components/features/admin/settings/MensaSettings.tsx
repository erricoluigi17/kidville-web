'use client';

import { useState, useEffect, useCallback } from 'react';
import { Settings, Save, CheckCircle2, Plus, Trash2, ChevronDown, ChevronUp, UtensilsCrossed, BookOpen } from 'lucide-react';

interface Props { userId: string; scuolaId: string }
interface MenuConfig { id: string; nome: string; ordine: number }
interface ClassAssignment { id: string; classe: string; menu_config_id: string; attivo_dal: string; mensa_menu_config?: { nome: string } }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const GIORNI = [{ n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mer' }, { n: 4, l: 'Gio' }, { n: 5, l: 'Ven' }, { n: 6, l: 'Sab' }, { n: 7, l: 'Dom' }];

export function MensaSettings({ userId, scuolaId }: Props) {
  const [cutoff, setCutoff] = useState('09:30');
  const [giorni, setGiorni] = useState<number[]>([1, 2, 3, 4, 5]);
  const [settimane, setSettimane] = useState(4);
  const [soglia, setSoglia] = useState(5);
  const [done, setDone] = useState(false);

  // Multi-menu state
  const [menus, setMenus] = useState<MenuConfig[]>([]);
  const [assignments, setAssignments] = useState<ClassAssignment[]>([]);
  const [newMenuNome, setNewMenuNome] = useState('');
  const [showMenuSection, setShowMenuSection] = useState(false);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuMsg, setMenuMsg] = useState<string | null>(null);

  // Form nuova assegnazione classe
  const [newClasse, setNewClasse] = useState('');
  const [newMenuId, setNewMenuId] = useState('');
  const [newAttivoDal, setNewAttivoDal] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then(r => r.json()).then(d => {
        if (!d.success) return;
        const s = d.data;
        if (s.mensa_cutoff_ora) setCutoff(String(s.mensa_cutoff_ora).slice(0, 5));
        if (Array.isArray(s.mensa_giorni_attivi)) setGiorni(s.mensa_giorni_attivi);
        if (s.mensa_settimane_rotazione) setSettimane(s.mensa_settimane_rotazione);
        if (s.mensa_soglia_saldo_basso != null) setSoglia(s.mensa_soglia_saldo_basso);
      });
  }, [userId, scuolaId]);

  const loadMenus = useCallback(async () => {
    const [mRes, aRes] = await Promise.all([
      fetch(`/api/mensa/menu-config?scuola_id=${scuolaId}`, { headers: hdr(userId) }).then(r => r.json()),
      fetch(`/api/mensa/class-assignments?scuola_id=${scuolaId}`, { headers: hdr(userId) }).then(r => r.json()),
    ]);
    if (mRes.success) setMenus(mRes.data);
    if (aRes.success) setAssignments(aRes.data);
  }, [userId, scuolaId]);

  useEffect(() => { loadMenus(); }, [loadMenus]);

  const toggleGiorno = (n: number) => {
    setGiorni(g => g.includes(n) ? g.filter(x => x !== n) : [...g, n].sort());
  };

  const salva = async () => {
    setDone(false);
    const res = await fetch('/api/admin/settings', {
      method: 'PATCH', headers: hdr(userId),
      body: JSON.stringify({
        scuola_id: scuolaId,
        mensa_cutoff_ora: cutoff,
        mensa_giorni_attivi: giorni,
        mensa_settimane_rotazione: settimane,
        mensa_soglia_saldo_basso: soglia,
      }),
    });
    const j = await res.json();
    if (j.success) { setDone(true); } else alert(j.error);
  };

  const creaMenu = async () => {
    if (!newMenuNome.trim()) return;
    setMenuLoading(true); setMenuMsg(null);
    const res = await fetch('/api/mensa/menu-config', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ scuola_id: scuolaId, nome: newMenuNome.trim(), ordine: menus.length }),
    });
    const j = await res.json();
    setMenuLoading(false);
    if (j.success) { setNewMenuNome(''); await loadMenus(); } else setMenuMsg(j.error);
  };

  const eliminaMenu = async (id: string) => {
    if (!confirm('Eliminare questo menu? Verranno rimossi anche i collegament alle classi.')) return;
    setMenuLoading(true); setMenuMsg(null);
    const res = await fetch(`/api/mensa/menu-config?id=${id}`, { method: 'DELETE', headers: hdr(userId) });
    const j = await res.json();
    setMenuLoading(false);
    if (j.success) { await loadMenus(); } else setMenuMsg(j.error);
  };

  const aggiungiAssegnazione = async () => {
    if (!newClasse.trim() || !newMenuId || !newAttivoDal) return;
    setMenuLoading(true); setMenuMsg(null);
    const res = await fetch('/api/mensa/class-assignments', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ scuola_id: scuolaId, classe: newClasse.trim(), menu_config_id: newMenuId, attivo_dal: newAttivoDal }),
    });
    const j = await res.json();
    setMenuLoading(false);
    if (j.success) { setNewClasse(''); await loadMenus(); } else setMenuMsg(j.error);
  };

  const eliminaAssegnazione = async (id: string) => {
    setMenuLoading(true);
    const res = await fetch(`/api/mensa/class-assignments?id=${id}`, { method: 'DELETE', headers: hdr(userId) });
    const j = await res.json();
    setMenuLoading(false);
    if (j.success) { await loadMenus(); } else setMenuMsg(j.error);
  };

  // Raggruppa assegnazioni per classe (mostra solo la più recente attiva + le future)
  const today = new Date().toISOString().slice(0, 10);
  const assignmentsByClasse: Record<string, ClassAssignment[]> = {};
  for (const a of assignments) {
    if (!assignmentsByClasse[a.classe]) assignmentsByClasse[a.classe] = [];
    assignmentsByClasse[a.classe].push(a);
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* ── IMPOSTAZIONI GENERALI ── */}
      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-4 flex items-center gap-2">
          <Settings size={14} /> Impostazioni mensa
        </h3>

        <div className="space-y-4">
          <div>
            <label className="font-maven text-xs text-kidville-muted block mb-1">Orario limite (cutoff) prenotazioni/disdette</label>
            <input type="time" value={cutoff} onChange={e => setCutoff(e.target.value)}
              className="border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
          </div>

          <div>
            <label className="font-maven text-xs text-kidville-muted block mb-1.5">Giorni mensa attivi</label>
            <div className="flex flex-wrap gap-1.5">
              {GIORNI.map(g => (
                <button key={g.n} onClick={() => toggleGiorno(g.n)}
                  className={`px-3 py-1.5 rounded-full font-maven text-xs font-bold border-2 ${giorni.includes(g.n) ? 'bg-kidville-green text-white border-kidville-green' : 'bg-white text-kidville-muted border-kidville-line'}`}>
                  {g.l}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-maven text-xs text-kidville-muted block mb-1">Settimane di rotazione menu</label>
              <input type="number" min={1} max={8} value={settimane} onChange={e => setSettimane(Number(e.target.value))}
                className="w-full border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
            </div>
            <div>
              <label className="font-maven text-xs text-kidville-muted block mb-1">Soglia avviso saldo basso</label>
              <input type="number" min={0} value={soglia} onChange={e => setSoglia(Number(e.target.value))}
                className="w-full border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
            </div>
          </div>

          <button onClick={salva} className="px-4 py-2 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center gap-1">
            <Save size={15} /> Salva impostazioni
          </button>
          {done && <p className="font-maven text-xs text-kidville-success flex items-center gap-1"><CheckCircle2 size={13} /> Impostazioni salvate.</p>}
        </div>
      </div>

      {/* ── GESTIONE MENU ── */}
      <div className="border-t border-kidville-line pt-5">
        <button
          onClick={() => setShowMenuSection(v => !v)}
          className="w-full flex items-center justify-between mb-4"
        >
          <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm flex items-center gap-2">
            <UtensilsCrossed size={14} /> Menu mensa ({menus.length})
          </h3>
          {showMenuSection ? <ChevronUp size={16} className="text-kidville-muted" /> : <ChevronDown size={16} className="text-kidville-muted" />}
        </button>

        {showMenuSection && (
          <div className="space-y-4">
            <p className="font-maven text-xs text-kidville-muted -mt-2">
              Crea più menu per ordini scolastici diversi (es. Nido, Infanzia e Primaria). Ogni menu ha il suo piano di rotazione separato.
            </p>

            {/* Lista menu esistenti */}
            {menus.length > 0 && (
              <div className="space-y-2">
                {menus.map(m => (
                  <div key={m.id} className="flex items-center gap-2 p-2.5 rounded-xl border border-kidville-line bg-kidville-cream">
                    <div className="flex-1 min-w-0">
                      <span className="font-maven font-bold text-sm text-kidville-green">{m.nome}</span>
                    </div>
                    <button onClick={() => eliminaMenu(m.id)} className="p-1.5 rounded-lg text-kidville-error hover:bg-kidville-error-soft" title="Elimina menu">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Form nuovo menu */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Nome menu (es. Nido)"
                value={newMenuNome}
                onChange={e => setNewMenuNome(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && creaMenu()}
                className="flex-1 border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green"
              />
              <button
                onClick={creaMenu}
                disabled={!newMenuNome.trim() || menuLoading}
                className="px-3 py-1.5 rounded-lg bg-kidville-green text-white font-maven text-sm font-bold flex items-center gap-1 disabled:opacity-50"
              >
                <Plus size={14} /> Aggiungi
              </button>
            </div>

            {menuMsg && <p className="font-maven text-xs text-kidville-error">{menuMsg}</p>}

            {/* ── ASSEGNAZIONI CLASSI ── */}
            {menus.length > 0 && (
              <div className="border-t border-kidville-line pt-4 space-y-3">
                <h4 className="font-barlow font-bold text-kidville-green uppercase text-xs flex items-center gap-1.5">
                  <BookOpen size={12} /> Assegnazione classi ai menu
                </h4>
                <p className="font-maven text-xs text-kidville-muted">
                  Specifica da quale data una classe passa a un determinato menu.
                  La regola più recente (attivo_dal ≤ oggi) è quella in vigore.
                </p>

                {/* Assegnazioni esistenti raggruppate per classe */}
                {Object.entries(assignmentsByClasse).map(([classe, list]) => (
                  <div key={classe} className="rounded-xl border border-kidville-line overflow-hidden">
                    <div className="px-3 py-2 bg-kidville-cream font-maven font-bold text-xs text-kidville-green">
                      Classe: {classe}
                    </div>
                    {list.map(a => (
                      <div key={a.id} className="flex items-center gap-2 px-3 py-2 border-t border-kidville-line text-xs">
                        <span className={`flex-1 font-maven ${a.attivo_dal > today ? 'text-kidville-muted italic' : 'text-kidville-ink'}`}>
                          {a.attivo_dal > today ? '⏳ Dal ' : '✓ Dal '}
                          <span className="font-bold">{a.attivo_dal}</span>
                          {' → '}
                          <span className="text-kidville-green font-bold">
                            {(a.mensa_menu_config as { nome: string } | undefined)?.nome ?? menus.find(m => m.id === a.menu_config_id)?.nome ?? '—'}
                          </span>
                        </span>
                        <button onClick={() => eliminaAssegnazione(a.id)} className="p-1 rounded text-kidville-error hover:bg-kidville-error-soft">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}

                {/* Form nuova assegnazione */}
                <div className="rounded-xl border-2 border-dashed border-kidville-line p-3 space-y-2">
                  <p className="font-maven text-xs text-kidville-muted font-bold">Nuova assegnazione</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="font-maven text-[10px] text-kidville-muted block mb-0.5">Classe / sezione</label>
                      <input
                        type="text"
                        placeholder="es. 1A, Sezione B"
                        value={newClasse}
                        onChange={e => setNewClasse(e.target.value)}
                        className="w-full border border-kidville-line rounded-lg px-2 py-1.5 font-maven text-xs text-kidville-green"
                      />
                    </div>
                    <div>
                      <label className="font-maven text-[10px] text-kidville-muted block mb-0.5">Menu</label>
                      <select
                        value={newMenuId}
                        onChange={e => setNewMenuId(e.target.value)}
                        className="w-full border border-kidville-line rounded-lg px-2 py-1.5 font-maven text-xs text-kidville-green bg-white"
                      >
                        <option value="">Seleziona…</option>
                        {menus.map(m => <option key={m.id} value={m.id}>{m.nome}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="font-maven text-[10px] text-kidville-muted block mb-0.5">Attivo dal</label>
                    <input
                      type="date"
                      value={newAttivoDal}
                      onChange={e => setNewAttivoDal(e.target.value)}
                      className="border border-kidville-line rounded-lg px-2 py-1.5 font-maven text-xs text-kidville-green"
                    />
                  </div>
                  <button
                    onClick={aggiungiAssegnazione}
                    disabled={!newClasse.trim() || !newMenuId || !newAttivoDal || menuLoading}
                    className="px-3 py-1.5 rounded-lg bg-kidville-green text-white font-maven text-xs font-bold flex items-center gap-1 disabled:opacity-50"
                  >
                    <Plus size={13} /> Aggiungi assegnazione
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
