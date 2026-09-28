/**
 * «LA NOTIFICA CHE HAI TOCCATO PORTA QUI, E QUI CI SEI GIÀ» (2026-09-28).
 *
 * Il genitore è sul diario del figlio, arriva «Diario aggiornato», la tocca (dalla campanella,
 * o dal banner con l'app aperta). In Next 16 una navigazione allo stesso percorso non rimonta la
 * pagina, e a un indirizzo IDENTICO non cambia nemmeno `useSearchParams`: il diario restava
 * quello di prima, e il tocco sembrava non fare niente. Quando il link era `'/'` almeno la home
 * si rimontava con la card fresca.
 *
 * Il tocco allora, oltre a navigare, avvisa con un evento la pagina di destinazione: se è già
 * montata, è lei a decidere cosa vuol dire «aggiornati» (il diario torna a oggi e rilegge).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

import { apriLinkNotifica } from '@/lib/chat/apertura-thread';
import { ascoltaNotificaAperta, segnalaNotificaAperta } from '@/lib/notifiche/pagina-aperta-da-notifica';

const aperti: Array<() => void> = [];
function ascolta(percorso: string) {
    const gestore = vi.fn();
    aperti.push(ascoltaNotificaAperta(percorso, gestore));
    return gestore;
}

afterEach(() => {
    while (aperti.length) aperti.pop()!();
});

describe('il tocco su una notifica avvisa la pagina di destinazione', () => {
    it('il diario montato sente il tocco su «Diario aggiornato», e la navigazione parte lo stesso', () => {
        const diario = ascolta('/parent/diary');
        const naviga = vi.fn();

        apriLinkNotifica('/parent/diary?id=a1', naviga);

        expect(naviga).toHaveBeenCalledWith('/parent/diary?id=a1');
        expect(diario, 'il diario già aperto non ha saputo del tocco').toHaveBeenCalledTimes(1);
    });

    it('la pagina sente solo i link al SUO percorso', () => {
        const diario = ascolta('/parent/diary');

        segnalaNotificaAperta('/parent/chat?thread=x');
        segnalaNotificaAperta('/parent/diary-foto?id=a1');
        segnalaNotificaAperta('/parent');

        expect(diario).not.toHaveBeenCalled();
    });

    it('presidio — un link che non è di questa app non avvisa nessuno', () => {
        const diario = ascolta('/parent/diary');
        const naviga = vi.fn();

        apriLinkNotifica('//evil.example/parent/diary', naviga);
        segnalaNotificaAperta('https://evil.example/parent/diary');

        expect(naviga).not.toHaveBeenCalled();
        expect(diario).not.toHaveBeenCalled();
    });

    it('chi smette di ascoltare non riceve più niente', () => {
        const gestore = vi.fn();
        const smetti = ascoltaNotificaAperta('/parent/diary', gestore);
        smetti();

        segnalaNotificaAperta('/parent/diary?id=a1');

        expect(gestore).not.toHaveBeenCalled();
    });
});
