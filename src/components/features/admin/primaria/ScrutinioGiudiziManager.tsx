'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GraduationCap } from 'lucide-react';
import { creaMuta } from '@/lib/ui/muta';

interface Section { id: string; name: string; school_type: string }
interface Periodo { id: string; nome: string; anno_scolastico: string }
interface Materia { id: string; nome: string; codice: string }
interface ScalaItem { etichetta: string; ordine: number }
interface DescrRow { materia_codice: string; etichetta_voto: string; giudizio_descrittivo: string }

const LIVELLI = [1, 2, 3, 4, 5];

// Configurazione del giudizio descrittivo di scrutinio per voto, distinto da
// quello in itinere. Granularità: livello × materia × periodo × voto. In pagella
// il testo si associa in automatico al voto assegnato. Compilare un livello vale
// per tutte le sezioni di quel livello.
export function ScrutinioGiudiziManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  const [scala, setScala] = useState<ScalaItem[]>([]);
  const [sezioni, setSezioni] = useState<Section[]>([]);
  const [livello, setLivello] = useState(1);
  const [periodoId, setPeriodoId] = useState('');
  const [materie, setMaterie] = useState<Materia[]>([]);
  // testi[materia_codice][etichetta_voto] = testo
  const [testi, setTesti] = useState<Record<string, Record<string, string>>>({});
  const [msg, setMsg] = useState('');

  // Carica periodi, scala e sezioni una volta.
  useEffect(() => {
    fetch(`/api/admin/primaria/scrutinio-periodi?userId=${userId}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => { if (d.success) { setPeriodi(d.data); if (d.data.length) setPeriodoId((p) => p || d.data[0].id); } })
      .catch(() => {});
    fetch(`/api/admin/primaria/giudizi?scuolaId=${scuolaId}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => { if (d.success) setScala(d.data.scala ?? []); })
      .catch(() => {});
    fetch(`/api/admin/sections?scuola_id=${scuolaId}`)
      .then((r) => r.json())
      .then((d) => { setSezioni(Array.isArray(d) ? d.filter((s: Section) => s.school_type === 'primaria') : []); })
      .catch(() => {});
  }, [scuolaId, userId]);

  // Materie del livello: usa una sezione rappresentativa di quel livello.
  useEffect(() => {
    const sez = sezioni.find((s) => s.name?.match(/[1-5]/)?.[0] === String(livello));
    const loadMaterie = async () => {
      let next: Materia[] | null = null;
      try {
        if (!sez) { next = []; return; }
        const d = await fetch(`/api/admin/primaria/materie?sectionId=${sez.id}`, { headers: { 'x-user-id': userId } })
          .then((r) => r.json())
          .catch(() => null);
        if (d?.success) next = (d.data as Materia[]).filter((m) => m.codice);
      } finally {
        if (next) setMaterie(next);
      }
    };
    loadMaterie();
  }, [sezioni, livello, userId]);

  const loadTesti = useCallback(async () => {
    if (!periodoId) return;
    let map: Record<string, Record<string, string>> | null = null;
    try {
      const r = await fetch(`/api/admin/primaria/scrutinio-giudizio?scuolaId=${scuolaId}&livello=${livello}&periodoId=${periodoId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      if (!d.success) return;
      const next: Record<string, Record<string, string>> = {};
      (d.data as DescrRow[]).forEach((row) => {
        next[row.materia_codice] = next[row.materia_codice] || {};
        next[row.materia_codice][row.etichetta_voto] = row.giudizio_descrittivo;
      });
      map = next;
    } finally {
      if (map) setTesti(map);
    }
  }, [scuolaId, livello, periodoId, userId]);

  useEffect(() => { loadTesti(); }, [loadTesti]);

  const muta = useMemo(
    () => creaMuta({
      route: '/admin/impostazioni',
      ricarica: loadTesti,
      setErrore: setMsg,
      fallback: t('scrutinioGiudiziErroreSalvataggio'),
    }),
    [loadTesti, t],
  );

  /**
   * QUESTA ERA IBRIDA, ED È IL MODO PEGGIORE DI SBAGLIARE.
   *
   * Mostrava l'errore — `setMsg(r.ok ? … : …)` — e un rigo prima scriveva
   * COMUNQUE lo stato ottimistico. Il risultato: un avviso rosso in cima e, sotto,
   * `testi` che dichiara salvato un testo che il database non ha. E `testi` non
   * è decorazione: è il valore con cui `onBlur` confronta per decidere se
   * risalvare. Registrato il rifiuto come se fosse riuscito, il tentativo
   * successivo sullo stesso campo veniva scartato come «non è cambiato niente» —
   * cioè l'avviso diceva «riprova» e il codice, riprovando, non faceva più nulla.
   *
   * Ora lo stato si aggiorna SOLO se il server ha accettato. Il testo digitato
   * resta nella textarea (è a `defaultValue`), quindi riprovare costa un secondo
   * clic fuori dal campo e non una riscrittura.
   */
  const salva = async (materia: Materia, etichettaVoto: string, testo: string) => {
    setMsg('');
    const ok = await muta(
      `/api/admin/primaria/scrutinio-giudizio?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ scuolaId, livello, materiaCodice: materia.codice, periodoId, etichettaVoto, testo }),
      },
      'primaria-scrutinio-giudizio-respinto',
      // Materia e voto: la griglia è larga quanto le materie per quanti sono i
      // voti, e senza queste due parole l'avviso non dice quale casella rifare.
      `${materia.nome} · ${etichettaVoto}`,
    );
    if (!ok) return;
    setTesti((prev) => ({ ...prev, [materia.codice]: { ...(prev[materia.codice] || {}), [etichettaVoto]: testo } }));
    setMsg(t('comuneSalvato'));
  };

  return (
    <div>
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <GraduationCap size={16} className="text-kidville-green" /> {t('scrutinioGiudiziTitolo')}
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-4">
        {t('scrutinioGiudiziSottotitolo')}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="font-maven text-sm text-kidville-ink">{t('scrutinioGiudiziLivello')}</label>
        <select value={livello} onChange={(e) => setLivello(Number(e.target.value))} className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm">
          {LIVELLI.map((l) => <option key={l} value={l}>{t('comuneLivelloOrdinale', { livello: l })}</option>)}
        </select>
        <label className="font-maven text-sm text-kidville-ink">{t('scrutinioGiudiziPeriodo')}</label>
        <select value={periodoId} onChange={(e) => setPeriodoId(e.target.value)} className="font-maven rounded-pill border border-kidville-line bg-white px-4 py-2 text-sm">
          {periodi.length === 0 && <option value="">{t('scrutinioGiudiziNessunPeriodoOpt')}</option>}
          {periodi.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.anno_scolastico})</option>)}
        </select>
        {msg && (
          <span
            role={msg.includes('✓') ? 'status' : 'alert'}
            className={`font-maven text-xs ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}
          >
            {msg}
          </span>
        )}
      </div>

      {periodi.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">{t('scrutinioGiudiziConfiguraPeriodo')}</p>
      ) : scala.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">{t('scrutinioGiudiziConfiguraScala')}</p>
      ) : materie.length === 0 ? (
        <p className="font-maven text-sm text-kidville-warn">{t('scrutinioGiudiziNessunaMateria', { livello })}</p>
      ) : (
        <div className="space-y-5">
          {materie.map((m) => (
            <div key={m.id} className="rounded-card border border-kidville-line p-3">
              <p className="font-maven text-sm font-semibold text-kidville-ink mb-2">{m.nome}</p>
              <div className="space-y-2">
                {scala.map((s) => (
                  <div key={s.etichetta} className="flex items-start gap-2">
                    <span className="font-maven text-xs text-kidville-muted w-28 shrink-0 pt-2">{s.etichetta}</span>
                    <textarea
                      defaultValue={testi[m.codice]?.[s.etichetta] ?? ''}
                      key={`${m.codice}-${s.etichetta}-${livello}-${periodoId}`}
                      rows={2}
                      placeholder={t('scrutinioGiudiziPlaceholder')}
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v !== (testi[m.codice]?.[s.etichetta] ?? '')) salva(m, s.etichetta, v);
                      }}
                      className="font-maven flex-1 rounded border border-kidville-line px-2 py-1.5 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
