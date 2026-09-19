'use client';

// =============================================================================
// ClasseShell — cornice persistente per-classe (header + linguette + contenuto).
// Componente UNICO condiviso tra il flusso docente (/teacher/primaria) e il
// cockpit Direzione/Segreteria (/admin/primaria). Riceve solo il PREFISSO di
// base; risolve internamente sectionId da useParams() e costruisce i percorsi.
//
// ⚠️ QUANTE SONO LE LINGUETTE NON SI SCRIVE QUI. Fino al 2026-09-19 questa riga
// diceva «8 tab» e `NAV` ne aveva NOVE: il numero era già falso prima che la
// linguetta «Compiti» lo facesse diventare dieci. Un conteggio scritto in un
// commento non lo aggiorna chi aggiunge una voce — lo conta `NAV`, qui sotto,
// che è l'unico posto in cui la risposta non può invecchiare.
// =============================================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, LayoutGrid, ClipboardList, BookOpenCheck, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3, GraduationCap, FolderLock, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTeacherIdentity } from '@/lib/auth/use-teacher-identity';
import { isoToIt, itToIso } from '@/lib/format/data';

/**
 * Il giorno scritto nell'URL (`?data=yyyy-mm-dd`), ma SOLO se è un giorno vero.
 *
 * ⚠️ NIENTE `new Date(...)` QUI DENTRO, e non è pignoleria: la forma `yyyy-mm-dd`
 * da sola non basta — `2026-02-30` ce l'ha e non esiste — e
 * `Date.parse('2026-02-30T12:00:00')` in V8 **non** è `NaN`, vale il 2 marzo. Il
 * controllo di calendario esiste già, provato dal suo lock
 * (`__tests__/lib/format-data.test.ts`): è il round-trip ISO → gg/mm/aaaa → ISO
 * di `@/lib/format/data`, dove `itToIso` rifiuta le date impossibili osservando
 * il rollover. Riscriverlo qui significherebbe avere due idee diverse di «giorno
 * valido» nella stessa navigazione.
 *
 * Una data che non supera il controllo non viene propagata: gli href tornano
 * esattamente quelli di prima. Portarsela dietro spargerebbe su nove linguette
 * un valore che il registro rifiuterebbe comunque (`dataDaUrl` ricade su oggi),
 * e che un domani qualcuno potrebbe infilare in una query.
 */
function giornoDaUrl(scritta: string | null | undefined): string | null {
  if (!scritta) return null;
  return itToIso(isoToIt(scritta)) === scritta ? scritta : null;
}

/**
 * I tab, in ordine. `seg` è il segmento dell'URL — che NON si traduce, è una
 * rotta — e `chiave` è l'etichetta nel catalogo `shared`.
 *
 * ⚠️ L'etichetta è una CHIAVE e non più una stringa: fino al 2026-08-03 questo
 * array conteneva «Panoramica», «Registro», «Appello»… scritti a mano, e il
 * componente non passava affatto da next-intl. Con l'interfaccia in inglese
 * l'intera cornice della classe — ogni linguetta, il titolo e il badge — restava
 * in italiano, sia sotto /teacher sia dentro il cockpit. Non era una traduzione
 * dimenticata in un angolo: è la barra di navigazione di tutta l'area Primaria.
 *
 * ⚠️ «Compiti» sta SUBITO DOPO «Registro» e non è un vezzo d'ordine: è la stessa
 * materia vista in due modi — il registro un giorno alla volta, questa linguetta
 * tutto il periodo insieme — e chi cerca i compiti parte da lì. Da non confondere
 * con `/admin/compiti`, che nel cockpit sono i task interni dello staff: quella
 * voce di menu vive altrove (`admin-nav-config`) e questa non la tocca.
 */
const NAV = [
  { seg: '', chiave: 'classeShellTabPanoramica', icon: LayoutGrid },
  { seg: 'registro', chiave: 'classeShellTabRegistro', icon: ClipboardList },
  { seg: 'compiti', chiave: 'classeShellTabCompiti', icon: BookOpenCheck },
  { seg: 'appello', chiave: 'classeShellTabAppello', icon: CheckSquare },
  { seg: 'valutazioni', chiave: 'classeShellTabValutazioni', icon: Star },
  { seg: 'note', chiave: 'classeShellTabNote', icon: AlertTriangle },
  { seg: 'orario', chiave: 'classeShellTabOrario', icon: CalendarDays },
  { seg: 'prospetto', chiave: 'classeShellTabProspetto', icon: BarChart3 },
  { seg: 'scrutinio', chiave: 'classeShellTabScrutinio', icon: GraduationCap },
  { seg: 'fascicolo', chiave: 'classeShellTabFascicolo', icon: FolderLock },
] as const;

export function ClasseShell({ basePrefix, children }: { basePrefix: string; children: React.ReactNode }) {
  const t = useTranslations('shared');
  const params = useParams();
  const search = useSearchParams();
  const pathname = usePathname();
  const sectionId = params?.sectionId as string;
  // Identità a due passaggi (SSR → idratazione): gli href dei tab sono
  // renderizzati, quindi l'uuid NON può essere letto da localStorage dentro il
  // render. `withUser` lo omette finché non è risolto: mai `userId=null`.
  const { userId, pronta, withUser } = useTeacherIdentity(search);
  const [nomeClasse, setNomeClasse] = useState('');
  const [ruolo, setRuolo] = useState('');
  // `?userId=` solo se c'è: la stringa «null» non è un id, e senza identità
  // locale la richiesta la risolve comunque la sessione (resolveIdentity).
  const q = userId ? `?userId=${encodeURIComponent(userId)}` : '';

  /**
   * IL GIORNO SOPRAVVIVE AL GIRO SULLE ALTRE LINGUETTE.
   *
   * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
   * Il registro porta il giorno scelto nell'URL (`?data=`, vedi `cambiaData` in
   * `…/registro/page.tsx`), così che un F5 e i tasti avanti/indietro del browser
   * lo conservino. Gli href dei tab però li costruisce questa riga, e fino al
   * 2026-09-19 passavano dal solo `withUser`: Registro al 10 settembre →
   * «Appello» → «Registro» riapriva su OGGI. Per la maestra e per la segreteria
   * è indistinguibile da «non si riesce a tornare indietro con le date», che è
   * la segnalazione da cui è partito tutto.
   *
   * ─── PERCHÉ SU TUTTE LE LINGUETTE E NON SOLO SU «REGISTRO» ──────────────────
   * Perché il giro passa DI LÀ. Oggi l'unica linguetta che legge `?data=` è
   * Registro (Appello ha un suo selettore con stato proprio, Compiti ragiona per
   * periodo relativo: `…/appello/page.tsx:78`, e `dataDaDelPeriodo` in
   * `…/compiti/page.tsx`). Il secondo riferimento è per NOME e non per riga di
   * proposito: quel file è ancora in riscrittura, e qui c'è già stato un numero
   * di riga falso — indicava un blocco di documentazione sul typing di
   * `res.json()`, che col periodo non c'entra niente.
   * Decorare il solo href di «Registro» non correggerebbe NIENTE: una volta su
   * Appello il valore è già perduto, e il ritorno riparte da oggi lo stesso. È
   * la linguetta di TRANSITO a doverselo portare dietro. Il prezzo è un `?data=`
   * visibile anche dove non viene letto — inerte PER LE PAGINE, perché nessuna
   * delle altre nove legge dalla query qualcosa di diverso da `userId` — e il
   * giorno in cui una di loro imparerà a leggerlo si troverà il valore già lì.
   *
   * ─── «INERTE» VALE PER LE PAGINE, NON PER IL ROUTER ─────────────────────────
   * Prima di questa riga i dieci href erano COSTANTI rispetto al giorno; adesso
   * ogni cambio di data li riscrive tutti e dieci. In questo repo `prefetch` non
   * è impostato da nessuna parte e sotto `(dashboard)` non c'è `loading.tsx`: i
   * dieci `<Link>` restano sul default `auto`, che in produzione prefetcha
   * all'ingresso nel viewport — dieci href nuovi possono quindi valere dieci
   * payload RSC nuovi. In jsdom il router è finto e quel giro NON è misurabile
   * da qui: è DICHIARATO e non contato, come il costo di `cambiaData` in
   * `…/registro/page.tsx`. Questa app ha già pagato un incidente da volume di
   * richieste (2,23 M/giorno da polling): se un domani il registro si sfoglia
   * tenendo premuta la freccia, è questo il numero da rimisurare, e sulla rete
   * vera.
   *
   * ⚠️ NON entra nelle due GET qui sopra: `q` resta il solo `?userId=`. Il giorno
   * è un fatto di navigazione, non un parametro di quelle route — aggiungerlo
   * cambierebbe una richiesta che nessuno ha chiesto di cambiare.
   *
   * ⚠️ NON entra nella freccia «indietro»: quella esce dalla classe e torna
   * all'elenco, dove un giorno non vuol dire niente.
   *
   * ⚠️ ASIMMETRIA con `cambiaData` (`…/registro/page.tsx`), da sapere PRIMA di
   * introdurre un terzo parametro sotto questa cornice: là la query si PRESERVA
   * intera (`new URLSearchParams(search)` + `.set`), qui si RICOMPONE da zero
   * con due sole chiavi — `withUser` appende `userId` a un href nudo, `conGiorno`
   * gli appende `data`. Un eventuale `?foo=bar` non sopravvive al giro sulle
   * linguette. È pre-esistente (`withUser` faceva già così) e oggi innocuo,
   * perché sotto la cornice nessuno legge altro da `userId`/`data`; smette di
   * esserlo il giorno in cui una pagina figlia si porta dietro un parametro suo.
   */
  const giorno = giornoDaUrl(search?.get('data'));
  const conGiorno = (href: string): string => {
    if (!giorno) return href;
    const sep = href.includes('?') ? '&' : '?';
    return `${href}${sep}data=${encodeURIComponent(giorno)}`;
  };

  useEffect(() => {
    // `pronta` evita la chiamata del passaggio di idratazione, che partirebbe
    // senza identità e verrebbe subito rifatta: una GET in più per pagina.
    if (!sectionId || !pronta) return;
    fetch(`/api/primaria/classe/${sectionId}${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.section) setNomeClasse(d.data.section.name);
      })
      .catch(() => {});
  }, [sectionId, q, pronta]);

  useEffect(() => {
    if (!pronta) return;
    fetch(`/api/primaria/me${q}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [q, pronta]);

  // Staff = opera per conto del docente titolare (admin/coordinator/segreteria).
  const isStaff = ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria';
  const base = `${basePrefix}/${sectionId}`;

  // Nel cockpit (/admin) la cornice persistente (sidebar desktop / topbar mobile)
  // è fornita da admin/layout: ClasseShell NON deve comportarsi da pagina a sé
  // (niente min-h-screen, niente header sticky a tutto schermo che copre la
  // topbar mobile z-30). Sotto /teacher resta lo shell standalone invariato.
  const inCockpit = basePrefix.startsWith('/admin');

  return (
    <div className={inCockpit ? '' : 'min-h-screen bg-kidville-cream/40'}>
      {/* top: sotto /teacher la var --kv-appbar-h (layout) fa scorrere lo sticky
          SOTTO la AppBar persistente; sotto /admin la var non esiste → 0px. */}
      <header className={`${inCockpit ? 'lg:sticky lg:top-0' : 'sticky top-[var(--kv-appbar-h,0px)]'} z-20 bg-kidville-green`}>
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <div className="flex items-center gap-3 pb-3">
            {/* Dentro c'è solo una freccia: senza nome uno screen reader annuncia
                «link», e basta (WCAG 4.1.2). Il nome ora è TRADOTTO: un
                `aria-label` italiano dentro un'interfaccia inglese è la voce che
                l'utente sente, non un dettaglio che si vede solo leggendo. */}
            <Link href={withUser(basePrefix)} aria-label={t('classeShellIndietro')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25">
              <ArrowLeft size={18} />
            </Link>
            <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-white">
              {/* Il nome della classe è un DATO («3 ANNI A»): resta com'è, e la
                  frase che lo contiene si interpola invece di concatenarsi —
                  «Class 3A» in inglese non ha lo stesso ordine dell'italiano. */}
              {nomeClasse ? t('classeShellClasse', { nome: nomeClasse }) : t('classeShellClasseSenzaNome')}
            </h1>
            <span className="rounded-pill bg-white/15 px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-white">
              {t('classeShellPrimaria')}
            </span>
            {isStaff && (
              <span className="rounded-pill bg-kidville-yellow px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-kidville-green">
                {t('classeShellModalitaSegreteria')}
              </span>
            )}
          </div>
          <nav className="flex gap-1.5 overflow-x-auto pb-3">
            {NAV.map(({ seg, chiave, icon: Icon }) => {
              // `withUser` PRIMA, il giorno dopo: l'identità resta il primo
              // parametro esattamente com'era, e `userId=null` resta impossibile
              // per costruzione (lo omette `withUser`, non si ricompone qui).
              const href = conGiorno(withUser(seg ? `${base}/${seg}` : base));
              const active = seg ? pathname === `${base}/${seg}` : pathname === base;
              return (
                <Link
                  key={seg || 'panoramica'}
                  href={href}
                  className={`font-barlow inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12.5px] font-bold uppercase tracking-wide transition ${
                    active ? 'bg-white text-kidville-green' : 'bg-white/14 text-white hover:bg-white/25'
                  }`}
                >
                  <Icon size={14} />
                  {t(chiave)}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Avviso-ponte NON bloccante: mostrato UNA sola volta (solo su Panoramica),
          non ripetuto su ogni tab della classe. */}
      {isStaff && pathname === base && (
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <p className="font-maven flex items-start gap-2 rounded-card bg-kidville-warn-soft px-3 py-2 text-xs text-kidville-warn">
            <Info size={14} className="mt-0.5 shrink-0" />
            {t('classeShellAvvisoSegreteria')}
          </p>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
