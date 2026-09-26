/**
 * ─── FILTRO PER CLASSE DELLA CONTABILITÀ — la parte pura ─────────────────────
 *
 * Una classe, qui, è un `section_id`: MAI un nome. Dal 2026-07-29 le sedi sono
 * tre e «Sezione A» esiste in più di una; il titolare ha deciso che nel filtro
 * le classi omonime restano SEPARATE per sede («Sezione A — Giugliano»,
 * «Sezione A — Aversa»). Unire per nome selezionerebbe i bambini di due plessi
 * con un clic solo — lo stesso difetto che il lock `nome-classe-con-sede`
 * sorveglia sul lato delle query.
 *
 * Il nome (`alunni.classe_sezione`) serve solo a SCRIVERE l'etichetta; il
 * confronto si fa sempre sull'id.
 *
 * Contratto completo: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/K6.md
 */

/** Una voce del filtro: una classe di UNA sede. */
export type ClasseFiltro = {
  /** `sections.id` (= `alunni.section_id`): è l'identità della classe. */
  id: string;
  /** Nome leggibile (`alunni.classe_sezione`), solo per l'etichetta. */
  nome: string;
  scuolaId: string;
  /** Nome della sede; stringa vuota se non noto. */
  scuolaNome: string;
};

/** La forma minima di alunno da cui si ricavano le classi. */
type AlunnoPerFiltroClassi = {
  section_id: string | null;
  classe_sezione: string | null;
  scuola_id: string | null;
};

/** Separatore fra classe e sede nell'etichetta: uno solo, qui. */
const SEPARATORE_SEDE = ' — ';

/**
 * Ripiego per una classe il cui nome non è scritto su nessun alunno. È un
 * SEGNAPOSTO, non un testo da mostrare: esportato perché l'interfaccia lo
 * riconosca e lo sostituisca con un testo tradotto («Classe senza nome») —
 * un bottone che si chiama «—» uno screen reader non lo legge.
 */
export const NOME_CLASSE_ASSENTE = '—';

const confronta = (a: string, b: string) => a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' });

/**
 * Le classi distinte (per `section_id`) degli alunni dati, ordinate per nome di
 * sede e poi per nome di classe (ordine naturale: «Sezione 2» prima di
 * «Sezione 10»). Gli alunni senza `section_id` non generano voci: non c'è
 * un'identità su cui filtrare.
 */
export function classiDaAlunni(
  alunni: ReadonlyArray<AlunnoPerFiltroClassi>,
  nomiSedi: Readonly<Record<string, string>>,
): ClasseFiltro[] {
  const perId = new Map<string, ClasseFiltro>();
  for (const a of alunni) {
    if (!a.section_id) continue;
    const nome = (a.classe_sezione ?? '').trim();
    const gia = perId.get(a.section_id);
    if (gia) {
      // Il nome può mancare sul primo alunno letto: si prende il primo che ce l'ha.
      if (gia.nome === NOME_CLASSE_ASSENTE && nome !== '') gia.nome = nome;
      continue;
    }
    const scuolaId = a.scuola_id ?? '';
    perId.set(a.section_id, {
      id: a.section_id,
      nome: nome !== '' ? nome : NOME_CLASSE_ASSENTE,
      scuolaId,
      scuolaNome: nomiSedi[scuolaId] ?? '',
    });
  }
  return [...perId.values()].sort(
    (a, b) =>
      confronta(a.scuolaNome, b.scuolaNome) ||
      a.scuolaId.localeCompare(b.scuolaId) ||
      confronta(a.nome, b.nome) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * «Sezione A» con una sede sola, «Sezione A — Giugliano» con più sedi. Se il
 * nome della sede non è noto non lascia un trattino appeso.
 */
export function etichettaClasse(c: ClasseFiltro, mostraSede: boolean): string {
  return mostraSede && c.scuolaNome !== '' ? `${c.nome}${SEPARATORE_SEDE}${c.scuolaNome}` : c.nome;
}

/**
 * Le righe la cui classe è fra quelle selezionate. Nessuna selezione = nessun
 * filtro: si restituiscono tutte le righe, comprese quelle senza classe. Con
 * una selezione, una riga senza classe (`null`) è esclusa. Non muta `righe`.
 */
export function filtraPerClassi<T>(
  righe: ReadonlyArray<T>,
  selezionate: ReadonlyArray<string>,
  sectionIdDi: (r: T) => string | null,
): T[] {
  if (selezionate.length === 0) return [...righe];
  const scelte = new Set(selezionate);
  return righe.filter((r) => {
    const id = sectionIdDi(r);
    return id !== null && scelte.has(id);
  });
}
