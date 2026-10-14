import { describe, it, expect } from 'vitest';
import { costruisciCsvReport } from '@/lib/cassa/report';

describe('CSV contabilità: somme esplicite', () => {
  it('riporta contante, altri metodi e totale netto delle categorie', () => {
    const csv = costruisciCsvReport({
      entrate_per_categoria: [{ categoria_id: 'c', categoria_nome: 'Retta', totale: 140, per_metodo: { contanti: 40, bonifico: 100 } }],
      uscite_per_categoria: [{ categoria_id: 'u', categoria_nome: 'Spese', totale: 35, contanti: 15, altri: 20 }], mensile: [],
    });
    expect(csv).toContain('Entrate;40,00;100,00;140,00');
    expect(csv).toContain('Uscite;15,00;20,00;35,00');
    expect(csv).toContain('Differenza delle entrate e uscite riportate;25,00;80,00;105,00');
  });
});
