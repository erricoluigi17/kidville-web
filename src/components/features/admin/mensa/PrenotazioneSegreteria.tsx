'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Search, CalendarRange } from 'lucide-react';
import { SettimanaMensaStaff } from './SettimanaMensaStaff';

interface Props { userId: string; scuolaId: string }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione?: string }

/**
 * Scheda «Prenotazioni» della mensa: la segreteria cerca un bambino e ne vede la
 * settimana, con Aggiungi e Annulla a qualunque ora (`SettimanaMensaStaff`).
 *
 * Fino al 2026-10-12 a destra c'era un modulo a UN giorno («Inserisci ticket (scala
 * 1)»): si poteva solo aggiungere, senza vedere cosa il bambino avesse già, e annullare
 * non si poteva da nessuna schermata dello staff — benché il server lo permettesse.
 */
export function PrenotazioneSegreteria({ userId, scuolaId }: Props) {
  const t = useTranslations('adminMensa');
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Alunno | null>(null);

  useEffect(() => {
    // `stato=iscritto` (2026-08-13). `GET /api/admin/students` è un'ANAGRAFICA e
    // senza questo parametro risponde con la sede intera, archiviati compresi:
    // qui la segreteria sceglie un bambino e gli inserisce un ticket mensa, cioè
    // è un elenco OPERATIVO. «Tuo figlio archiviato è ancora prenotabile a
    // mensa» non è difendibile davanti a un genitore, e non era un'ipotesi: il
    // parametro esiste da sempre e tre schermate accanto lo passavano già
    // (`PaymentsDashboard`, `GeneratoreCategoria`, `FiscalePanel`).
    fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setAlunni(d.map((a: Alunno) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe_sezione: a.classe_sezione }))); });
  }, [scuolaId]);

  const filtered = alunni.filter(a => `${a.nome} ${a.cognome}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);

  return (
    <div className="grid md:grid-cols-2 gap-5">
      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Search size={14} /> {t('selezionaAlunno')}</h3>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('cerca')}
          className="w-full min-h-[44px] border-2 border-kidville-line rounded-full px-4 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green mb-2" />
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {filtered.map(a => (
            <button key={a.id} onClick={() => setSel(a)}
              className={`w-full min-h-[44px] text-left px-3 py-2 rounded-xl font-maven text-sm ${sel?.id === a.id ? 'bg-kidville-green text-white' : 'hover:bg-kidville-cream text-kidville-green'}`}>
              {a.nome} {a.cognome} <span className="text-xs opacity-70">{a.classe_sezione}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><CalendarRange size={14} /> {t('settimanaDelBambino')}</h3>
        {/* `key`: cambiando bambino la settimana riparte da zero, senza il saldo o
            l'esito del bambino di prima. */}
        {!sel ? <p className="font-maven text-sm text-kidville-sub">{t('selezionaUnAlunno')}</p>
          : <SettimanaMensaStaff key={sel.id} userId={userId} alunno={sel} />}
      </div>
    </div>
  );
}
