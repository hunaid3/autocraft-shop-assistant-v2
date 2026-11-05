import { describe, expect, it } from 'vitest';
import { matchItem, normKey, tokens } from '../../src/domain/itemMatch.js';

const items = [
  { id: 'a141', name: 'boAt Airdopes 141' },
  { id: 'a131', name: 'boAt Airdopes 131' },
  { id: 'usbc', name: 'USB-C Cable', aliases: ['cable', 'type c cable'] },
  { id: 'chai', name: 'चाय पत्ती 250g', aliases: ['chai patti'] },
  { id: 'fevi', name: 'Fevicol SH 1kg' }
];

describe('normKey', () => {
  it('drops spaces and punctuation, keeps Indian-script vowel signs and virama', () => {
    expect(normKey('USB-C Cable')).toBe('usbccable');
    expect(normKey('चाय पत्ती, 250g।')).toBe('चायपत्ती250g');
    expect(normKey('Redmi Note 10+ (₹)')).toBe('redminote10');
  });
  it('splits tokens on the same boundaries', () => {
    expect(tokens('boAt Airdopes-141')).toEqual(['boat', 'airdopes', '141']);
    expect(tokens('चाय पत्ती')).toEqual(['चाय', 'पत्ती']);
  });
});

describe('matchItem', () => {
  it('exact alias wins', () => {
    expect(matchItem('cable', items).match?.id).toBe('usbc');
    expect(matchItem('Chai Patti', items).match?.id).toBe('chai');
  });

  it('all words present', () => {
    expect(matchItem('airdopes 141', items).match?.id).toBe('a141');
  });

  it('Hindi name', () => {
    expect(matchItem('चाय पत्ती', items).match?.id).toBe('chai');
  });

  it('ambiguous names return candidates instead of guessing', () => {
    const r = matchItem('airdopes', items);
    expect(r.match).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['a131', 'a141']);
  });

  it('misspelling: same as Code.gs — offers the likely item instead of guessing', () => {
    // 1 of 3 words matches → score 0.33, below the 0.5 auto-match threshold.
    // Typo tolerance (edit distance) is a Phase 2 improvement.
    const r = matchItem('airdops 141', items);
    expect(r.match).toBeNull();
    expect(r.candidates.map((c) => c.id)).toEqual(['a141']);
  });

  it('prefix of a word', () => {
    expect(matchItem('fevicol', items).match?.id).toBe('fevi');
  });

  it('unknown item → no match and no candidates', () => {
    expect(matchItem('hdmi switch', items)).toEqual({ match: null, candidates: [] });
    expect(matchItem('   ', items)).toEqual({ match: null, candidates: [] });
  });
});
