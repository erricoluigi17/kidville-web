import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Helper per i test del cruscotto Contabilità: scelta di categorie, mesi e anno scolastico
 * attraverso i comandi VERI (nessun accesso allo stato interno).
 *
 * Il criterio comune: si porta ogni pastiglia allo stato VOLUTO leggendo `aria-pressed`, invece
 * di cliccare «a memoria». Così l'esito non dipende dalla data di oggi (il mese predefinito è
 * quello corrente) né da cosa era già scelto prima.
 */

/** Apre il comando il cui nome accessibile comincia con `prefisso`, e restituisce il suo pannello. */
async function apriComando(prefisso: 'Categorie' | 'Mesi'): Promise<{ comando: HTMLElement; pannello: HTMLElement }> {
    const comando = await screen.findByRole('button', { name: new RegExp(`^${prefisso}`) });
    if (comando.getAttribute('aria-expanded') !== 'true') fireEvent.click(comando);
    const idPannello = comando.getAttribute('aria-controls');
    const pannello = idPannello ? document.getElementById(idPannello) : null;
    if (!pannello) throw new Error(`il comando «${prefisso}» non ha un pannello (aria-controls)`);
    return { comando, pannello };
}

/** Porta le pastiglie del pannello allo stato voluto, poi chiude con Escape. */
async function scegli(prefisso: 'Categorie' | 'Mesi', voluti: string[] | 'tutto'): Promise<void> {
    const { pannello } = await apriComando(prefisso);
    const pastiglie = within(pannello).getAllByRole('button') as HTMLButtonElement[];
    // La prima pastiglia è sempre quella che azzera («Tutte le categorie» / «Tutto l’anno»).
    const [tutte, ...voci] = pastiglie;
    if (voluti === 'tutto') {
        if (tutte.getAttribute('aria-pressed') !== 'true') fireEvent.click(tutte);
    } else {
        const nomi = new Set(voci.map((v) => v.textContent ?? ''));
        for (const n of voluti) {
            if (!nomi.has(n)) throw new Error(`«${n}» non è fra le pastiglie di «${prefisso}»: ${[...nomi].join(' | ')}`);
        }
        for (const v of voci) {
            const premuta = v.getAttribute('aria-pressed') === 'true';
            const voluta = voluti.includes(v.textContent ?? '');
            if (premuta !== voluta) fireEvent.click(v);
        }
    }
    fireEvent.keyDown(document, { key: 'Escape' });
}

/** Sceglie le categorie per NOME (come scritto nella pastiglia), o `'tutte'` per azzerare il filtro. */
export async function scegliCategorie(nomi: string[] | 'tutte'): Promise<void> {
    await scegli('Categorie', nomi === 'tutte' ? 'tutto' : nomi);
}

/** Sceglie i mesi per ETICHETTA corta («Set 2026»), o `'tutto'` per «Tutto l’anno». */
export async function scegliMesi(etichette: string[] | 'tutto'): Promise<void> {
    await scegli('Mesi', etichette);
}

/** Cambia l'anno scolastico (l'anno di settembre). */
export function scegliAnno(y: number): void {
    fireEvent.change(screen.getByLabelText('Anno scolastico'), { target: { value: String(y) } });
}
