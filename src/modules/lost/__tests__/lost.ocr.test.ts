import { describe, expect, it } from 'vitest';

import { parseIdentity } from '../lost.ocr.js';

const now = new Date('2026-11-05T10:00:00Z');
const read = (text: string) => parseIdentity(text, now);

describe('reading a student card: birth date, place, nationality', () => {
  it('labels and values on the same line', () => {
    expect(read('Date de naissance : 12/03/2002\nLieu de naissance : SAINT-LOUIS\nNationalité : SENEGALAISE')).toEqual({ birthDate: '2002-03-12', birthPlace: 'Saint-Louis', nationality: 'Sénégalaise' });
  });

  it('the value on the next line', () => {
    expect(read('Date de naissance\n12/03/2002\nLieu de naissance\nDakar')).toMatchObject({ birthDate: '2002-03-12', birthPlace: 'Dakar' });
  });

  it('read in blocks: all the labels, then all the values (a label is never a value)', () => {
    const text = 'UNIVERSITE GASTON BERGER\nCARTE D’ETUDIANT\nNom\nPrénom\nDate de naissance\nLieu de naissance\nNationalité\nBA\nAissatou\n12/03/2002\nSAINT-LOUIS\nSENEGALAISE\nAnnée universitaire 2025-2026\nValable jusqu’au 30/09/2026';
    const r = read(text);
    expect(r.birthDate).toBe('2002-03-12');
    expect(r.birthPlace).toBeNull();
    expect(r.nationality).toBeNull();
  });

  it('« Date et lieu de naissance », « Né(e) le … à … », short labels', () => {
    expect(read('Date et lieu de naissance : 05/11/2001 à Ziguinchor')).toMatchObject({ birthDate: '2001-11-05', birthPlace: 'Ziguinchor' });
    expect(read('Né(e) le 12/03/2002 à Saint-Louis')).toMatchObject({ birthDate: '2002-03-12', birthPlace: 'Saint-Louis' });
    expect(read('Date Naiss. : 01-02-2003')).toMatchObject({ birthDate: '2003-02-01' });
  });

  it('other ways of writing the date, and OCR mistakes', () => {
    expect(read('Date de naissance : 12 mars 2002').birthDate).toBe('2002-03-12');
    expect(read('Date de naissance : 1er janv. 2003').birthDate).toBe('2003-01-01');
    expect(read('Date de naissance : 12.03.2002').birthDate).toBe('2002-03-12');
    expect(read('Date de naissance : 12032002').birthDate).toBe('2002-03-12');
    expect(read('Date de naissance : 12/O3/2OO2').birthDate).toBe('2002-03-12');
  });

  it('a date written in letters, every month: filled as a date (JJ/MM/AAAA in the app)', () => {
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    months.forEach((m, i) => expect(read(`Date de naissance : 14 ${m} 1993`).birthDate).toBe(`1993-${String(i + 1).padStart(2, '0')}-14`));
    expect(read('DATE DE NAISSANCE\n14 JANVIER 1993\nLIEU DE NAISSANCE\nDAKAR')).toMatchObject({ birthDate: '1993-01-14', birthPlace: 'Dakar' });
    expect(read('Né le 14 janvier 1993 à Thiès')).toMatchObject({ birthDate: '1993-01-14', birthPlace: 'Thiès' });
    expect(read('Date de naissance : 3 Sept. 2001').birthDate).toBe('2001-09-03');
  });

  it('no label at all: the date that fits a student, not the validity date', () => {
    expect(read('UGB\nP232055\n12/03/2002\nValable jusqu’au 30/09/2026').birthDate).toBe('2002-03-12');
    expect(read('UGB\nValable jusqu’au 30/09/2026').birthDate).toBeNull();
  });
});
