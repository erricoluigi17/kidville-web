'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, Sparkles } from 'lucide-react';
import { creaMuta } from '@/lib/ui/muta';

interface Materia {
  id: string;
  nome: string;
  codice: string;
  e_civica: boolean;
  turno_mensa: boolean;
  ordine: number;
  attiva: boolean;
}

interface Obiettivo { id: string; codice: string | null; descrizione: string; materia_codice: string }

interface Props {
  sectionId: string;
  sezione?: { name: string } | undefined;
  userId: string;
  scuolaId: string;
}

export function MaterieManager({ sectionId, sezione, userId, scuolaId }: Props) {
  const t = useTranslations('adminPrimaria');
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [loading, setLoading] = useState(true);
  const [livello, setLivello] = useState(1);
  const [nuova, setNuova] = useState({ nome: '', codice: '' });
  const [error, setError] = useState('');
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [assoc, setAssoc] = useState<Record<string, string>>({}); // materia_id → obiettivo_id
  // Le materie con una POST sull'obiettivo in volo. Vedi `setObiettivo`.
  const [obiettivoInVolo, setObiettivoInVolo] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(async () => {
    if (!sectionId) return;
    try {
      const r = await fetch(`/api/admin/primaria/materie?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      setMaterie(d.success ? d.data : []);
    } finally {
      setLoading(false);
    }
  }, [sectionId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Prova a dedurre il livello dal nome sezione (es. "3A" → 3).
  useEffect(() => {
    const syncLivello = () => {
      let next: number | null = null;
      try {
        const m = sezione?.name?.match(/[1-5]/);
        if (m) next = Number(m[0]);
      } finally {
        if (next !== null) setLivello(next);
      }
    };
    syncLivello();
  }, [sezione]);

  // Obiettivi della scuola per il livello dedotto + associazioni materia→obiettivo.
  useEffect(() => {
    if (!scuolaId) return;
    fetch(`/api/admin/primaria/obiettivi?scuolaId=${scuolaId}&livello=${livello}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => { if (d.success) setObiettivi(d.data); });
  }, [scuolaId, livello, userId]);

  useEffect(() => {
    if (!sectionId) return;
    fetch(`/api/admin/primaria/materia-obiettivo?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          const map: Record<string, string> = {};
          for (const row of d.data as { materia_id: string; obiettivo_id: string }[]) map[row.materia_id] = row.obiettivo_id;
          setAssoc(map);
        }
      });
  }, [sectionId, userId]);

  /**
   * LE MUTAZIONI DI QUESTA SCHERMATA, e perché ne servono due varianti.
   *
   * Fino al 2026-09-09 «Applica preset» e «Aggiungi» mostravano il rifiuto e
   * «elimina», «attiva» e «obiettivo della classe» no: `await fetch(...)` nudo,
   * senza `res.ok`, senza log, senza avviso. Non era una scelta — è la firma
   * della dimenticanza, ed è la stessa in tutti e sette i manager del cockpit.
   *
   * Il ripiego è diverso fra le due perché dice all'operatore in che STATO è
   * rimasto il dato: dopo un salvataggio rifiutato non è stato registrato
   * niente, dopo un'eliminazione rifiutata la voce è ancora al suo posto. Sono
   * due informazioni diverse, e sceglierne una sola per brevità significherebbe
   * darne una sbagliata metà delle volte.
   */
  const { mutaSalva, mutaElimina } = useMemo(() => {
    const comuni = { route: '/admin/impostazioni', ricarica: load, setErrore: setError };
    return {
      mutaSalva: creaMuta({ ...comuni, fallback: t('comuneErroreSalvataggio') }),
      mutaElimina: creaMuta({ ...comuni, fallback: t('comuneErroreEliminazione') }),
    };
  }, [load, t]);

  /**
   * L'associazione materia→obiettivo è OTTIMISTICA: la tendina cambia prima
   * della risposta. Sul rifiuto si rimette com'era, e qui `ricarica` non aiuta
   * NEMMENO sul rifiuto del server: `ricarica` è `load`, che rilegge le MATERIE
   * e non tocca `assoc`. Le associazioni si leggono una volta sola, nell'effetto
   * qui sopra, con dipendenze `[sectionId, userId]` — quindi senza questo
   * ripristino una tendina rifiutata resterebbe sull'obiettivo sbagliato fino al
   * cambio di classe. Non serve nemmeno che la rete cada: basta un 403 di sede.
   *
   * ⚠️ SI RIMETTE LA SOLA CHIAVE TOCCATA, e con un updater funzionale. La prima
   * stesura salvava l'intero `assoc` prima della fetch e lo rimetteva sul
   * rifiuto: con due tendine cambiate di seguito, l'istantanea della seconda
   * contiene già la scelta ottimistica della prima — mai salvata — e rimetterla
   * riscrive a schermo un dato che il server ha rifiutato. È il difetto che
   * questo file esiste per chiudere, reintrodotto dal rimedio.
   *
   * Sulla STESSA tendina il ripristino per chiave non basterebbe (il «valore di
   * prima» del secondo cambio è il primo, che non è mai stato salvato): lì la
   * risposta è non far partire la seconda scrittura, ed è `obiettivoInVolo`.
   */
  const setObiettivo = async (m: Materia, obiettivoId: string) => {
    if (obiettivoInVolo.has(m.id)) return;
    const precedente = assoc[m.id];
    setObiettivoInVolo((prev) => new Set(prev).add(m.id));
    setAssoc((prev) => ({ ...prev, [m.id]: obiettivoId }));
    const ok = await mutaSalva(
      `/api/admin/primaria/materia-obiettivo?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, materiaId: m.id, obiettivoId: obiettivoId || null }),
      },
      'primaria-materia-obiettivo-respinta',
      m.nome,
    );
    if (!ok) {
      setAssoc((prev) => {
        const next = { ...prev };
        // `undefined` non è «nessun obiettivo»: è «questa materia non era in
        // elenco». Scriverlo come stringa vuota sarebbe una scelta che nessuno
        // ha fatto.
        if (precedente === undefined) delete next[m.id];
        else next[m.id] = precedente;
        return next;
      });
    }
    setObiettivoInVolo((prev) => {
      const next = new Set(prev);
      next.delete(m.id);
      return next;
    });
  };

  const applyPreset = async () => {
    await mutaSalva(
      `/api/admin/primaria/materie?action=apply-preset&userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, livello }),
      },
      'primaria-materie-preset-respinto',
    );
  };

  const addMateria = async () => {
    if (!nuova.nome || !nuova.codice) return;
    // I due campi si svuotano SOLO se il server ha accettato: cancellarli su un
    // rifiuto obbligherebbe a riscriverli per riprovare.
    const ok = await mutaSalva(
      `/api/admin/primaria/materie?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, nome: nuova.nome, codice: nuova.codice, ordine: materie.length + 1 }),
      },
      'primaria-materia-nuova-respinta',
    );
    if (ok) setNuova({ nome: '', codice: '' });
  };

  const toggleAttiva = async (m: Materia) => {
    await mutaSalva(
      `/api/admin/primaria/materie?userId=${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: m.id, attiva: !m.attiva }),
      },
      'primaria-materia-attiva-respinta',
      m.nome,
    );
  };

  const removeMateria = async (m: Materia) => {
    await mutaElimina(
      `/api/admin/primaria/materie?id=${m.id}&userId=${userId}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      'primaria-materia-elimina-respinta',
      // In un elenco di dodici materie «eliminazione non riuscita» non dice
      // quale riga riprovare. Il nome resta a schermo: `muta` non lo logga.
      m.nome,
    );
  };

  if (!sectionId) return <p className="font-maven text-kidville-muted">{t('comuneSelezionaSezione')}</p>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 rounded-card bg-kidville-cream/50 p-3">
        <span className="font-maven text-sm text-kidville-ink">{t('materiePresetLabel')}</span>
        <select
          value={livello}
          onChange={(e) => setLivello(Number(e.target.value))}
          className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
        >
          {[1, 2, 3, 4, 5].map((l) => (
            <option key={l} value={l}>{t('comuneLivelloOrdinale', { livello: l })}</option>
          ))}
        </select>
        <button
          onClick={applyPreset}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Sparkles size={14} /> {t('materieApplicaPreset')}
        </button>
      </div>

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">{t('comuneCaricamento')}</p>
      ) : (
        <ul className="divide-y divide-kidville-line">
          {materie.map((m) => {
            const obMateria = obiettivi.filter((o) => o.materia_codice === m.codice);
            return (
            <li key={m.id} className="py-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-maven text-kidville-ink">{m.nome}</span>
                  {m.e_civica && <span className="ml-2 rounded-pill bg-kidville-info-soft text-kidville-info px-2 py-0.5 text-[11px]">{t('materieBadgeCivica')}</span>}
                  {m.turno_mensa && <span className="ml-2 rounded-pill bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 text-[11px]">{t('materieBadgeMensa')}</span>}
                  <span className="ml-2 text-xs text-kidville-muted">{m.codice}</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="font-maven text-xs text-kidville-muted inline-flex items-center gap-1">
                    <input type="checkbox" checked={m.attiva} onChange={() => toggleAttiva(m)} /> {t('materieAttiva')}
                  </label>
                  <button onClick={() => removeMateria(m)} aria-label={t('materieElimina')} className="text-kidville-muted hover:text-kidville-error">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <label className="font-maven text-[11px] text-kidville-muted shrink-0">{t('materieObiettivoClasse')}</label>
                <select
                  value={assoc[m.id] ?? ''}
                  // Finché la POST di questa materia è in volo la tendina non si
                  // ricambia: il «valore di prima» di un secondo cambio sarebbe
                  // il primo, che il server non ha ancora accettato.
                  disabled={obiettivoInVolo.has(m.id)}
                  onChange={(e) => setObiettivo(m, e.target.value)}
                  className="font-maven flex-1 rounded border border-kidville-line px-2 py-1 text-xs disabled:opacity-60"
                >
                  <option value="">{t('materieNessunObiettivo')}</option>
                  {obMateria.map((o) => (
                    <option key={o.id} value={o.id}>{o.codice ? `${o.codice} · ` : ''}{o.descrizione}</option>
                  ))}
                </select>
              </div>
              {obMateria.length === 0 && (
                <p className="font-maven text-[11px] text-kidville-muted mt-1">{t('materieNessunObiettivoDefinito', { codice: m.codice, livello })}</p>
              )}
            </li>
          );})}
          {materie.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">{t('materieNessunaMateria')}</li>}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-kidville-line pt-4">
        <div>
          <label className="block font-maven text-xs text-kidville-muted">{t('materieNomeMateria')}</label>
          <input
            value={nuova.nome}
            onChange={(e) => setNuova((s) => ({ ...s, nome: e.target.value }))}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder={t('materiePlaceholderNome')}
          />
        </div>
        <div>
          <label className="block font-maven text-xs text-kidville-muted">{t('materieCodice')}</label>
          <input
            value={nuova.codice}
            onChange={(e) => setNuova((s) => ({ ...s, codice: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder={t('materiePlaceholderCodice')}
          />
        </div>
        <button
          onClick={addMateria}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> {t('comuneAggiungi')}
        </button>
      </div>
    </div>
  );
}
