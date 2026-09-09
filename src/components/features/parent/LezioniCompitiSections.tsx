'use client';

import { BookOpen, ClipboardList, FileText, Image as ImageIcon, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';

// `file_url` è NULLABILE, e il tipo lo dice.
//
// `GET /api/parent/primaria` non restituisce più il percorso dentro il
// contenitore privato — che il browser risolveva come indirizzo RELATIVO,
// rispondendo 404 senza un errore né una riga di log — ma un link FIRMATO a
// tempo. Quando la firma non riesce (Storage giù, file rimosso a mano) il
// contratto del progetto è `null`, mai il percorso grezzo: qui `null` significa
// «allegato non apribile adesso», e l'unica risposta onesta è non disegnare un
// link.
export interface Allegato { id: string; tipo: string; file_url: string | null; file_name: string | null }
export interface Individualizzata { argomento: string | null; compiti: string | null }
export interface Lezione {
  id: string; data: string; ora_lezione: number; materia: string | null;
  argomento: string | null; compiti: string | null; data_consegna_compiti?: string | null;
  allegati: Allegato[]; individualizzate: Individualizzata[];
}

function perGiorno(lezioni: Lezione[]): [string, Lezione[]][] {
  const m = new Map<string, Lezione[]>();
  for (const l of lezioni) {
    const arr = m.get(l.data) ?? [];
    arr.push(l);
    m.set(l.data, arr);
  }
  return [...m.entries()];
}

// ─── `new Date('YYYY-MM-DD')` È MEZZANOTTE **UTC**, e qui va bene ────────────
//
// La stringa arriva da una colonna `date` di Postgres e il costruttore la legge
// come mezzanotte UTC. Il giorno reso sarebbe quindi quello sbagliato in ogni
// fuso a occidente di Greenwich — se il formattatore usasse il fuso di CHI
// GUARDA. Non lo usa: `intlDateTime` dichiara `Europe/Rome` per costruzione
// (`@/i18n/config`), e il lock `__tests__/architecture/date-con-timezone.test.ts`
// vieta i formattatori che non lo fanno.
//
// Misurato, non dedotto (2026-09-09, `new Date('2026-09-10')`):
//
//   fuso del processo      Europe/Rome forzato    fuso d'ambiente
//   Europe/Rome            gio 10 set             gio 10 set
//   America/Los_Angeles    gio 10 set             mer 9 set   ← lo sfasamento
//   Pacific/Niue           gio 10 set             mer 9 set
//
// Mezzanotte UTC in Europe/Rome è l'01:00 o le 02:00 dello STESSO giorno, e il
// fuso italiano non è mai negativo: la data non può scivolare. L'assunzione da
// non infrangere è quindi una sola — il fuso è quello dell'ISTITUTO, non del
// dispositivo — e vale finché queste due chiamate non dichiarano un `timeZone`
// proprio. Non c'è niente da correggere; c'è da non toglierlo.
const fmtGiorno = (g: string, locale: string) =>
  intlDateTime(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(g));

/**
 * I chip degli allegati di una lezione — gli stessi in «Lezioni» e in «Compiti».
 *
 * Vive in una funzione sola perché le due sezioni sono nate con lo stesso blocco
 * scritto una volta: in «Compiti» semplicemente NON C'ERA, e il pulsante «Scatta
 * foto» del registro produceva un dato che la famiglia non vedeva mai. Due copie
 * dello stesso blocco sono due copie da tenere allineate, ed è esattamente il
 * modo in cui la seconda si dimentica.
 *
 * Un allegato senza indirizzo (`file_url: null`, firma non riuscita) non diventa
 * un'ancora: `href={null}` renderebbe un `<a>` che sembra un link, non lo è, e
 * non lo dice a nessuno.
 */
function AllegatiLezione({ allegati, etichettaVuota }: { allegati: Allegato[]; etichettaVuota: string }) {
  // Il predicato di tipo, e non un `!` più avanti: è la stessa condizione detta
  // una volta sola, e il compilatore la porta fino all'`href`.
  const apribili = allegati.filter((a): a is Allegato & { file_url: string } => !!a.file_url);
  if (apribili.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {apribili.map((a) => (
        <a key={a.id} href={a.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-pill bg-white px-2 py-0.5 text-[11px] text-kidville-muted">
          {a.tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />}
          {a.file_name || etichettaVuota}
        </a>
      ))}
    </div>
  );
}

// Sezione "Lezioni": materia + argomento + allegati (sola lettura).
export function LezioniList({ lezioni }: { lezioni: Lezione[] }) {
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const giorni = perGiorno(lezioni);
  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2 mb-3">
        <BookOpen size={18} className="text-kidville-green" /> {t('lezioniTitolo')}
      </h3>
      {giorni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('lezioniVuoto')}</p>
      ) : (
        <div className="space-y-4">
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-kidville-muted mb-1">{fmtGiorno(giorno, f.locale)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-sm text-kidville-ink">
                      <span className="font-semibold text-kidville-green">{l.materia || t('lezioniLezione')}</span>
                      {l.argomento && <span className="text-kidville-muted"> — {l.argomento}</span>}
                    </div>
                    {l.individualizzate.filter((i) => i.argomento).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-kidville-info-soft px-2 py-1 font-maven text-xs text-kidville-info">{t('lezioniAttivitaIndividuale', { value: i.argomento ?? '' })}</p>
                    ))}
                    <AllegatiLezione allegati={l.allegati} etichettaVuota={t('lezioniAllegato')} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Sezione "Compiti": compiti + scadenza (mostra solo le lezioni con compiti).
export function CompitiList({ lezioni }: { lezioni: Lezione[] }) {
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const conCompiti = lezioni.filter((l) => l.compiti || l.individualizzate.some((i) => i.compiti));
  const giorni = perGiorno(conCompiti);
  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2 mb-3">
        <ClipboardList size={18} className="text-kidville-yellow-strong" /> {t('compitiTitolo')}
      </h3>
      {giorni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('compitiVuoto')}</p>
      ) : (
        <div className="space-y-4">
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-kidville-muted mb-1">{fmtGiorno(giorno, f.locale)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-xs text-kidville-muted">{l.materia || t('compitiLezione')}</div>
                    {l.compiti && <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-sm text-kidville-ink">{l.compiti}</p>}
                    {l.individualizzate.filter((i) => i.compiti).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-kidville-info-soft px-2 py-1 font-maven text-xs text-kidville-info">{t('compitiIndividuali', { value: i.compiti ?? '' })}</p>
                    ))}
                    {/* Gli allegati del compito: la foto della pagina del libro o il
                        PDF della scheda, che dal registro si allegano proprio qui.
                        Erano già nel dato e resi solo in «Lezioni». */}
                    <AllegatiLezione allegati={l.allegati} etichettaVuota={t('lezioniAllegato')} />
                    {l.data_consegna_compiti && (
                      // Data di consegna: unico indicatore (chip), formato it-IT.
                      // Con il datepicker docente la data non va più scritta nel
                      // testo libero, evitando la doppia indicazione.
                      <p className="mt-1.5 inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2 py-0.5 font-maven text-[11px] font-semibold text-kidville-error">
                        <CalendarClock size={11} /> {t('compitiConsegna', { data: intlDateTime(f.locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(l.data_consegna_compiti)) })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
