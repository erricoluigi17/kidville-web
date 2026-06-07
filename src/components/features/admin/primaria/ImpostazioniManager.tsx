'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';

type Matrice = Record<string, Record<string, boolean>>;

const GRADI = ['primaria', 'infanzia', 'nido'];
const FUNZIONI = ['registro', 'valutazioni', 'note', 'orario', 'appello', 'diario', 'gallery'];

export function ImpostazioniManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [matrice, setMatrice] = useState<Matrice>({});
  const [classeOrale, setClasseOrale] = useState(2);
  const [scrittoPratico, setScrittoPratico] = useState(15);
  const [buffer, setBuffer] = useState(10);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/primaria/impostazioni?scuolaId=${scuolaId}`);
    const d = await r.json();
    if (d.success) {
      setMatrice(d.data.funzioni_matrice ?? {});
      setClasseOrale(d.data.timelock_giorni_classe_orale ?? 2);
      setScrittoPratico(d.data.timelock_giorni_scritto_pratico ?? 15);
      setBuffer(d.data.notif_buffer_valutazioni_min ?? 10);
    }
  }, [scuolaId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (grado: string, funzione: string) => {
    setMatrice((prev) => ({
      ...prev,
      [grado]: { ...(prev[grado] ?? {}), [funzione]: !(prev[grado]?.[funzione]) },
    }));
  };

  const salva = async () => {
    setMsg('');
    const r = await fetch(`/api/admin/primaria/impostazioni?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        scuolaId,
        funzioni_matrice: matrice,
        timelock_giorni_classe_orale: classeOrale,
        timelock_giorni_scritto_pratico: scrittoPratico,
        notif_buffer_valutazioni_min: buffer,
      }),
    });
    const d = await r.json();
    setMsg(r.ok ? 'Salvato ✓' : d.error || 'Errore');
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-2">Matrice funzioni per grado</h3>
        <p className="font-maven text-xs text-gray-400 mb-3">Quali moduli sono attivi per ciascun grado (preset + override).</p>
        <div className="overflow-x-auto">
          <table className="text-sm font-maven">
            <thead>
              <tr className="text-gray-400">
                <th className="p-2 text-left">Grado</th>
                {FUNZIONI.map((f) => <th key={f} className="p-2 text-center capitalize">{f}</th>)}
              </tr>
            </thead>
            <tbody>
              {GRADI.map((g) => (
                <tr key={g} className="border-t border-gray-100">
                  <td className="p-2 capitalize text-gray-700">{g}</td>
                  {FUNZIONI.map((f) => (
                    <td key={f} className="p-2 text-center">
                      <input type="checkbox" checked={!!matrice[g]?.[f]} onChange={() => toggle(g, f)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="font-barlow text-base font-bold text-gray-800 mb-2">Vincoli temporali e notifiche</h3>
        <div className="flex flex-wrap gap-4">
          <label className="font-maven text-sm text-gray-600">
            Registro/orali (giorni)
            <input type="number" value={classeOrale} onChange={(e) => setClasseOrale(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
          <label className="font-maven text-sm text-gray-600">
            Scritti/pratici (giorni)
            <input type="number" value={scrittoPratico} onChange={(e) => setScrittoPratico(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
          <label className="font-maven text-sm text-gray-600">
            Buffer notifiche (min)
            <input type="number" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} className="ml-2 w-16 rounded-pill border border-gray-200 px-2 py-1" />
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={salva} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">
          <Save size={15} /> Salva impostazioni
        </button>
        {msg && <span className={`font-maven text-sm ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</span>}
      </div>
    </div>
  );
}
