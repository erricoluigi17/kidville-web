import { describe, it, expect } from 'vitest';
import { estensioneDaPercorso, nomeConEstensione } from '@/lib/native/nome-da-percorso';
import { nomeFileDocumento } from '@/lib/native/scarica';

/**
 * L'ESTENSIONE DAL FILE VERO. Nell'app un file senza estensione non si apre
 * (l'anteprima di iOS non sa che cosa sia): il certificato medico ha solo il percorso
 * nello Storage, il documento del fascicolo un `file_name` che può mancare o non
 * portarla. L'estensione si prende dal percorso — mai il resto, che sono uuid.
 */

const FIRMATO = 'https://storage.example.test/storage/v1/object/sign/fascicolo/a1/b2.PDF?token=abc.def';

describe('estensioneDaPercorso', () => {
  it('prende l’estensione dall’ultimo segmento, minuscola, senza query né frammento', () => {
    expect(estensioneDaPercorso(FIRMATO)).toBe('pdf');
    expect(estensioneDaPercorso('aaaa/bbbb.jpeg#x')).toBe('jpeg');
    expect(estensioneDaPercorso('/api/x/file?id=1&nome=a.pdf')).toBeNull();
  });

  it('niente estensione, file nascosto o valore assente → null', () => {
    expect(estensioneDaPercorso('aaaa/bbbb')).toBeNull();
    expect(estensioneDaPercorso('aaaa/.pdf')).toBeNull();
    expect(estensioneDaPercorso(null)).toBeNull();
    expect(estensioneDaPercorso(undefined)).toBeNull();
    // un punto in una cartella non è l'estensione del file
    expect(estensioneDaPercorso('a.b/cartella/file')).toBeNull();
  });
});

describe('nomeConEstensione', () => {
  it('aggiunge l’estensione del file vero a un nome che non ce l’ha', () => {
    expect(nomeConEstensione('certificato-medico', 'u1/u2.pdf')).toBe('certificato-medico.pdf');
    expect(nomeConEstensione('modulo iscrizione', FIRMATO)).toBe('modulo iscrizione.pdf');
  });

  it('non la raddoppia quando il nome finisce già con quella (senza badare alle maiuscole)', () => {
    expect(nomeConEstensione('scheda.pdf', FIRMATO)).toBe('scheda.pdf');
    expect(nomeConEstensione('SCHEDA.PDF', FIRMATO)).toBe('SCHEDA.PDF');
  });

  it('«ricevuta n.12»: il 12 non è un’estensione, e il PDF resta un PDF', () => {
    const nome = nomeConEstensione('ricevuta n.12', FIRMATO);
    expect(nome).toBe('ricevuta n.12.pdf');
    // e l'helper di scarico la riconosce e la tiene
    expect(nomeFileDocumento(nome)).toMatch(/\.pdf$/);
  });

  it('nome assente o vuoto → il predefinito, sempre con l’estensione', () => {
    expect(nomeConEstensione(null, FIRMATO, 'documento-alunno')).toBe('documento-alunno.pdf');
    expect(nomeConEstensione('   ', 'x/y.png')).toBe('kidville-documento.png');
  });

  it('percorso senza estensione → il nome resta com’è', () => {
    expect(nomeConEstensione('certificato-medico', 'u1/u2')).toBe('certificato-medico');
    expect(nomeConEstensione('certificato-medico', null)).toBe('certificato-medico');
  });
});
