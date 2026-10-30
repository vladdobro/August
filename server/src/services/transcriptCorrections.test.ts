import { describe, expect, it } from 'vitest';

import { applyCorrections } from './transcriptCorrections.js';
import type { CorrectionItem } from '../types.js';

const HEADER = '# Transcript\n\n- Date: 1/1/2026\n- Duration: 00:01:00\n\n';
const item = (index: number, original: string, suggested: string, status: CorrectionItem['status'] = 'accepted'): CorrectionItem =>
  ({ id: index, index, start: 0, role: null, original, suggested, status });

describe('applyCorrections (AUG-163)', () => {
  const md = `${HEADER}[00:00:01] [Me] we went to the see\n[00:00:05] [Them] all good here\n[00:00:09] [Me] bye now\n`;

  it('replaces only accepted items whose original matches, leaving the rest byte-identical', () => {
    const out = applyCorrections(md, [
      item(0, 'we went to the see', 'we went to the sea'),
      item(1, 'all good here', 'all good there', 'rejected'),
      item(2, 'something else', 'bye then'),
    ]);
    expect(out).toBe(`${HEADER}[00:00:01] [Me] we went to the sea\n[00:00:05] [Them] all good here\n[00:00:09] [Me] bye now\n`);
  });

  it('handles single-track lines without a role and pending items', () => {
    const single = `${HEADER}[00:00:01] first line\n[00:00:05] second line\n`;
    const out = applyCorrections(single, [item(1, 'second line', 'second lines'), item(0, 'first line', 'x', 'pending')]);
    expect(out).toBe(`${HEADER}[00:00:01] first line\n[00:00:05] second lines\n`);
  });

  it('replaces a flagged segment inside a long merged line and applies several fixes of one line', () => {
    const single = `${HEADER}[00:00:01] first part is fine. we went to the see. and then home. bye bye now\n`;
    const out = applyCorrections(single, [
      { id: 0, index: 0, start: 3, role: null, original: 'we went to the see.', suggested: 'we went to the sea.', status: 'accepted' },
      { id: 1, index: 0, start: 9, role: null, original: 'bye bye now', suggested: 'bye now', status: 'accepted' },
      { id: 2, index: 0, start: 6, role: null, original: 'and then home.', suggested: 'and home.', status: 'rejected' },
    ]);
    expect(out).toBe(`${HEADER}[00:00:01] first part is fine. we went to the sea. and then home. bye now\n`);
  });

  it('returns the transcript unchanged when nothing is accepted', () => {
    expect(applyCorrections(md, [])).toBe(md);
  });
});
