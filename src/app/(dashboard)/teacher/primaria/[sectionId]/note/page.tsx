'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { nomeCompleto } from '@/lib/format/nome';
import { logClient } from '@/lib/logging/client';
import { AzioniNota, CATEGORIE_NOTA, type NotaElenco } from '@/components/features/primaria/AzioniNota';

interface Alunno { id: string; nome: string; cognome: string }
type Nota = NotaElenco;

export default function NotePage() {
  const t = useTranslations('teacherPrimaria');
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [note, setNote] = useState<Nota[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [categoria, setCategoria] = useState('disciplinare');
  const [testo, setTesto] = useState('');
  const [richiedeFirma, setRichiedeFirma] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  /** `testo: null` = nessun messaggio dal server: al render si mostra il ripiego tradotto. */
  const [apiError, setApiError] = useState<{ testo: string | null } | null>(null);
  /**
   * `false` = il server ha dato l'elenco ma non è riuscito a calcolare i permessi
   * (`statoVociDisponibile`): le note si vedono, Modifica/Elimina no, e lo si dice.
   */
  const [permessiDisponibili, setPermessiDisponibili] = useState(true);
  /** Il ruolo di chi guarda (`/api/primaria/me`): decide solo se «Sblocca» si mostra. */
  const [ruolo, setRuolo] = useState<string | null>(null);
  /** L'esito dell'ultima modifica/eliminazione, sopra l'elenco. */
  const [esitoElenco, setEsitoElenco] = useState<{ testo: string; tipo: 'ok' | 'errore' } | null>(null);

  // `t` NON è fra le dipendenze: il messaggio di ripiego si traduce al render.
  // Con `t` qui, una `t` non stabile (il mock dei test la ricrea a ogni render)
  // rileggeva la classe a ogni render, in un giro senza fine.
  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setApiError(null); }
        else setApiError({ testo: typeof d.error === 'string' ? d.error : null });
      })
      .catch((err: unknown) => {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `note-alunni-non-caricati: ${err instanceof Error ? err.name : 'errore'}`,
          route: typeof window !== 'undefined' ? window.location.pathname : undefined,
        });
        setApiError({ testo: null });
      });
  }, [sectionId, userId]);

  const loadNote = useCallback(async () => {
    try {
      const r = await fetch(`/api/primaria/note?sectionId=${sectionId}&userId=${userId}`);
      const d = await r.json();
      if (d.success) {
        setNote(d.data);
        setPermessiDisponibili(d.statoVociDisponibile !== false);
      }
    } finally {
      // nessuno stato di caricamento da azzerare. Il `catch` sta al punto di
      // chiamata (`ricaricaNote`): qui dentro farebbe scattare
      // `react-hooks/set-state-in-effect`.
    }
  }, [sectionId, userId]);

  /** Rilegge l'elenco; un guasto di rete non passa in silenzio. */
  const ricaricaNote = useCallback(() => {
    loadNote().catch((err: unknown) => {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `note-elenco-non-caricato: ${err instanceof Error ? err.name : 'errore'}`,
        route: typeof window !== 'undefined' ? window.location.pathname : undefined,
      });
    });
  }, [loadNote]);

  useEffect(() => { ricaricaNote(); }, [ricaricaNote]);

  /**
   * Dopo uno sblocco riuscito l'avviso «Voce bloccata…» sopra l'elenco è falso:
   * si toglie PRIMA di rileggere, altrimenti resterebbe sopra una nota di nuovo
   * modificabile.
   */
  const dopoSblocco = useCallback(() => {
    setEsitoElenco(null);
    ricaricaNote();
  }, [ricaricaNote]);

  // Il ruolo serve solo a mostrare «Sblocca» alla Direzione: senza risposta non
  // si mostra (fail-closed), e il gate vero resta sul server.
  useEffect(() => {
    let vivo = true;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (vivo && d?.success && typeof d.data?.ruolo === 'string') setRuolo(d.data.ruolo); })
      .catch((err) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `note-ruolo-non-risolto: ${err instanceof Error ? err.name : 'errore'}`,
          route: typeof window !== 'undefined' ? window.location.pathname : undefined,
        });
      });
    return () => { vivo = false; };
  }, [userId]);

  /** Quante note di ciascun gruppo risultano firmate nell'elenco. */
  const firmatePerGruppo = new Map<string, number>();
  for (const n of note) {
    if (n.nota_gruppo_id && n.firmata_il) firmatePerGruppo.set(n.nota_gruppo_id, (firmatePerGruppo.get(n.nota_gruppo_id) ?? 0) + 1);
  }

  const toggle = (id: string) => setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSel(sel.length === alunni.length ? [] : alunni.map((a) => a.id));

  const salva = async () => {
    setMsg('');
    if (sel.length === 0 || !testo) { setMsg(t('noteSelezionaAlunniTesto')); return; }
    if (!userId) { setMsg(t('comuneIdentitaNonRisolta')); return; }
    setSaving(true);
    const r = await fetch(`/api/primaria/note?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, alunnoIds: sel, categoria, testo, richiedeFirma }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setMsg(d.error || t('comuneErrore'));
    else { setMsg(t('noteInviata')); setTesto(''); setSel([]); ricaricaNote(); }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink mb-3 flex items-center gap-2">
          <AlertTriangle size={18} className="text-kidville-warn" /> {t('noteNuova')}
        </h2>

        {apiError && (
          <div className="mb-3 flex items-center gap-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
            <AlertTriangle size={14} /> {apiError.testo ?? t('comuneImpossibileCaricareAlunni')}
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <label className="font-maven text-xs text-kidville-muted">{t('noteAlunni')}</label>
          <button onClick={toggleAll} className="font-maven text-xs text-kidville-green">{sel.length === alunni.length ? t('noteDeselezionaTutti') : t('noteTuttaClasse')}</button>
        </div>
        <div className="mb-3 max-h-36 overflow-y-auto rounded-card border border-kidville-line p-2">
          {alunni.map((a) => (
            <label key={a.id} className="flex items-center gap-2 py-0.5 font-maven text-sm">
              <input type="checkbox" checked={sel.includes(a.id)} onChange={() => toggle(a.id)} />
              {nomeCompleto(a.nome, a.cognome, 'cognome-nome')}
            </label>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {CATEGORIE_NOTA.map((c) => (
            <button key={c.key} onClick={() => setCategoria(c.key)} className={`font-maven rounded-pill px-3 py-1 text-xs ${categoria === c.key ? c.cls + ' ring-1 ring-current' : 'bg-kidville-cream text-kidville-muted'}`}>{t(`noteCategoria_${c.key}`)}</button>
          ))}
        </div>

        <textarea value={testo} onChange={(e) => setTesto(e.target.value)} rows={3} placeholder={t('noteTestoPlaceholder')} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm mb-2" />
        <label className="mb-3 flex items-center gap-2 font-maven text-sm text-kidville-ink">
          <input type="checkbox" checked={richiedeFirma} onChange={(e) => setRichiedeFirma(e.target.checked)} />
          {t('noteRichiediFirma')}
        </label>

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
        <button onClick={salva} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
          <Check size={15} /> {saving ? t('noteInvioInCorso') : t('noteInvia')}
        </button>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">{t('noteRecenti')}</h3>
        {!permessiDisponibili && note.length > 0 && (
          <p className="mb-2 font-maven text-xs text-kidville-warn">{t('noteAzioniNonDisponibili')}</p>
        )}
        {esitoElenco && (
          <p
            role={esitoElenco.tipo === 'errore' ? 'alert' : 'status'}
            className={`mb-2 font-maven text-sm ${esitoElenco.tipo === 'ok' ? 'text-kidville-success' : 'text-kidville-error'}`}
          >
            {esitoElenco.testo}
          </p>
        )}
        <ul className="divide-y divide-kidville-line">
          {note.map((n) => {
            const cat = CATEGORIE_NOTA.find((c) => c.key === n.categoria);
            const nomeAlunno = nomeCompleto(n.alunni?.nome, n.alunni?.cognome, 'cognome-nome');
            return (
              <li key={n.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] font-maven ${cat?.cls}`}>{cat ? t(`noteCategoria_${cat.key}`) : ''}</span>
                  <span className="font-maven text-sm text-kidville-ink">{nomeAlunno}</span>
                  {n.richiede_firma && (
                    <span className={`text-[11px] font-maven ${n.firmata_il ? 'text-kidville-success' : 'text-kidville-warn'}`}>
                      {n.firmata_il ? t('noteFirmata') : t('noteAttesaFirma')}
                    </span>
                  )}
                </div>
                <p className="font-maven text-xs text-kidville-muted mt-0.5">{n.testo}</p>
                <AzioniNota
                  nota={n}
                  nomeAlunno={nomeAlunno}
                  firmateNelGruppo={n.nota_gruppo_id ? firmatePerGruppo.get(n.nota_gruppo_id) ?? 0 : n.firmata_il ? 1 : 0}
                  userId={userId ?? ''}
                  ruolo={ruolo}
                  permessiDisponibili={permessiDisponibili && !!userId}
                  onCambiato={ricaricaNote}
                  onEsito={(testo, tipo) => setEsitoElenco({ testo, tipo })}
                  onApri={() => setEsitoElenco(null)}
                  onSbloccato={dopoSblocco}
                />
              </li>
            );
          })}
          {note.length === 0 && <li className="py-2 font-maven text-sm text-kidville-muted">{t('noteNessuna')}</li>}
        </ul>
      </div>
    </div>
  );
}
