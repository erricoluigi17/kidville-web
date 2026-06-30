'use client';

interface Campanella {
  id: string;
  giorno_settimana: number;
  ordine: number;
  ora_inizio: string;
  ora_fine: string;
  tipo: 'lezione' | 'intervallo' | 'mensa';
}
interface CellaOrario {
  giorno_settimana: number;
  campanella_id: string;
  materie?: { nome: string; codice: string } | null;
  utenti?: { nome: string; cognome: string } | null;
}

const GIORNI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

// Tinta per materia dai token --kv-subj-* (DR: griglia colorata per materia).
function subjTint(nome: string): string {
  const n = (nome || '').toLowerCase();
  const map: [string, string][] = [
    ['ital', 'italiano'], ['mate', 'matematica'], ['ingl', 'inglese'], ['stor', 'storia'],
    ['geo', 'geografia'], ['scien', 'scienze'], ['immag', 'arte'], ['arte', 'arte'],
    ['music', 'musica'], ['fisic', 'motoria'], ['motor', 'motoria'], ['tecno', 'tecnologia'],
    ['relig', 'religione'], ['mensa', 'mensa'],
  ];
  const hit = map.find(([k]) => n.includes(k));
  return hit ? `var(--kv-subj-${hit[1]})` : 'var(--color-kidville-green)';
}

export function OrarioGrid({
  campanelle,
  orario,
  showDocente = true,
}: {
  campanelle: Campanella[];
  orario: CellaOrario[];
  showDocente?: boolean;
}) {
  if (campanelle.length === 0) {
    return <p className="font-maven text-sm text-kidville-muted">Orario non ancora configurato.</p>;
  }

  const giorniPresenti = Array.from(new Set(campanelle.map((c) => c.giorno_settimana))).sort();
  const ordini = Array.from(new Set(campanelle.map((c) => c.ordine))).sort((a, b) => a - b);

  const campanellaDi = (giorno: number, ordine: number) =>
    campanelle.find((c) => c.giorno_settimana === giorno && c.ordine === ordine);
  const cellaDi = (campanellaId: string, giorno: number) =>
    orario.find((o) => o.campanella_id === campanellaId && o.giorno_settimana === giorno);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm font-maven">
        <thead>
          <tr>
            <th className="p-2 text-left text-kidville-muted font-normal">Ora</th>
            {giorniPresenti.map((g) => (
              <th key={g} className="p-2 text-center text-kidville-ink">{GIORNI[g - 1]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordini.map((ord) => {
            // L'orario di riferimento (prendo la prima campanella di quell'ordine).
            const ref = campanelle.find((c) => c.ordine === ord);
            return (
              <tr key={ord} className="border-t border-kidville-line">
                <td className="p-2 text-xs text-kidville-muted whitespace-nowrap">
                  {ref?.ora_inizio?.slice(0, 5)}–{ref?.ora_fine?.slice(0, 5)}
                </td>
                {giorniPresenti.map((g) => {
                  const camp = campanellaDi(g, ord);
                  if (!camp) return <td key={g} className="p-2" />;
                  if (camp.tipo !== 'lezione') {
                    return (
                      <td key={g} className="p-2 text-center">
                        <span className="rounded-pill bg-kidville-cream px-2 py-0.5 text-[11px] text-kidville-muted">
                          {camp.tipo === 'mensa' ? 'Mensa' : 'Intervallo'}
                        </span>
                      </td>
                    );
                  }
                  const cella = cellaDi(camp.id, g);
                  return (
                    <td key={g} className="p-2 text-center">
                      {cella?.materie ? (() => {
                        const tint = subjTint(cella.materie.nome);
                        return (
                          <div className="rounded-card px-2 py-1.5" style={{ background: `color-mix(in srgb, ${tint} 13%, white)`, boxShadow: `inset 2.5px 0 0 ${tint}` }}>
                            <div className="font-barlow text-[12px] font-bold uppercase leading-tight" style={{ color: tint }}>{cella.materie.nome}</div>
                            {showDocente && cella.utenti && (
                              <div className="text-[10px] text-kidville-muted">
                                {cella.utenti.nome} {cella.utenti.cognome}
                              </div>
                            )}
                          </div>
                        );
                      })() : (
                        <span className="text-kidville-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
