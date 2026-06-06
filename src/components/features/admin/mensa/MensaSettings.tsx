'use client';

import { useState, useEffect } from 'react';
import { Settings, Save, CheckCircle2 } from 'lucide-react';

interface Props { userId: string; scuolaId: string }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const GIORNI = [{ n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mer' }, { n: 4, l: 'Gio' }, { n: 5, l: 'Ven' }, { n: 6, l: 'Sab' }, { n: 7, l: 'Dom' }];

export function MensaSettings({ userId, scuolaId }: Props) {
  const [cutoff, setCutoff] = useState('09:30');
  const [giorni, setGiorni] = useState<number[]>([1, 2, 3, 4, 5]);
  const [settimane, setSettimane] = useState(4);
  const [soglia, setSoglia] = useState(5);
  const [done, setDone] = useState(false);

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

  return (
    <div className="max-w-lg">
      <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-4 flex items-center gap-2"><Settings size={14} /> Impostazioni mensa</h3>

      <div className="space-y-4">
        <div>
          <label className="font-maven text-xs text-gray-500 block mb-1">Orario limite (cutoff) prenotazioni/disdette</label>
          <input type="time" value={cutoff} onChange={e => setCutoff(e.target.value)}
            className="border-2 border-gray-200 rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
        </div>

        <div>
          <label className="font-maven text-xs text-gray-500 block mb-1.5">Giorni mensa attivi</label>
          <div className="flex flex-wrap gap-1.5">
            {GIORNI.map(g => (
              <button key={g.n} onClick={() => toggleGiorno(g.n)}
                className={`px-3 py-1.5 rounded-full font-maven text-xs font-bold border-2 ${giorni.includes(g.n) ? 'bg-kidville-green text-white border-kidville-green' : 'bg-white text-gray-400 border-gray-200'}`}>
                {g.l}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="font-maven text-xs text-gray-500 block mb-1">Settimane di rotazione menu</label>
            <input type="number" min={1} max={8} value={settimane} onChange={e => setSettimane(Number(e.target.value))}
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
          </div>
          <div>
            <label className="font-maven text-xs text-gray-500 block mb-1">Soglia avviso saldo basso</label>
            <input type="number" min={0} value={soglia} onChange={e => setSoglia(Number(e.target.value))}
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
          </div>
        </div>

        <button onClick={salva} className="px-4 py-2 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center gap-1">
          <Save size={15} /> Salva impostazioni
        </button>
        {done && <p className="font-maven text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={13} /> Impostazioni salvate.</p>}
      </div>
    </div>
  );
}
