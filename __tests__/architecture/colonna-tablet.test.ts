import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * LOCK — LA COLONNA DI GENITORI E DOCENTI SI ALLARGA SUL TABLET.
 *
 * Fino al 18/10/2026 ogni pagina docente si scriveva da sola `mx-auto max-w-[460px]`, e il layout
 * del genitore chiudeva tutto in `max-w-[430px]`: sull'iPad l'app era una striscia da telefono in
 * mezzo allo schermo. La larghezza ora vive in `src/lib/ui/larghezza-pagina.ts` (460/430 sul
 * telefono, 720 da 744 px). Una pagina nuova che copiasse il letterale da una vecchia tornerebbe
 * a essere una striscia, e nessun test unitario lo vedrebbe: per questo il lock legge i sorgenti.
 *
 * Il modulo delle larghezze sta fuori dalle cartelle scansionate, quindi non ha bisogno di
 * eccezioni. Il conteggio dei file letti è provato a parte: un lock che non scansiona niente è
 * verde per costruzione.
 */

const RADICE = process.cwd();
const CARTELLE = ['src/app/(dashboard)/parent', 'src/app/(dashboard)/teacher'];
const LETTERALE = /max-w-\[(?:430|460)px\]/g;

function fileTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) return fileTsx(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

describe('lock — la colonna di genitori e docenti si allarga sul tablet', () => {
  const file = CARTELLE.flatMap((c) => fileTsx(join(RADICE, c)));

  it('il lock guarda davvero le pagine', () => {
    expect(file.length, 'nessuna pagina scansionata: il lock sarebbe verde per costruzione').toBeGreaterThan(20);
  });

  it('nessuna pagina si scrive a mano la colonna da telefono', () => {
    const colpevoli = file.flatMap((f) =>
      (readFileSync(f, 'utf8').match(LETTERALE) ?? []).map((m) => `${relative(RADICE, f)} — ${m}`),
    );
    expect(
      colpevoli,
      'Una pagina fissa la propria larghezza a 430/460 px: sul tablet resterebbe una striscia da ' +
        'telefono in mezzo allo schermo. Si usa `COLONNA_DOCENTE` o `classeColonnaGenitore` da ' +
        '`src/lib/ui/larghezza-pagina.ts`, che sul telefono valgono lo stesso.',
    ).toEqual([]);
  });
});
