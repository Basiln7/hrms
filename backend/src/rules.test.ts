/* Tests that need no database: the setup gate, ids, and a scan of the source for local-time code. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ID_PATTERN } from '@delta-hrms/shared';
import { newId } from './ids';
import { sameSecret, setupGate } from './services/setup';

describe('how first-run setup is protected', () => {
  it('is switched off in production until a setup code is set', () => {
    expect(setupGate({ isProduction: true, setupCode: null })).toBe('disabled');
  });

  it('asks for the code whenever one is set', () => {
    expect(setupGate({ isProduction: true, setupCode: 'a-long-enough-setup-code' })).toBe('code');
    expect(setupGate({ isProduction: false, setupCode: 'a-long-enough-setup-code' })).toBe('code');
  });

  it('is open on a developer’s machine with no code', () => {
    expect(setupGate({ isProduction: false, setupCode: null })).toBe('open');
  });

  it('compares codes exactly', () => {
    expect(sameSecret('a-long-enough-setup-code', 'a-long-enough-setup-code')).toBe(true);
    expect(sameSecret('a-long-enough-setup-codE', 'a-long-enough-setup-code')).toBe(false);
    expect(sameSecret('', 'a-long-enough-setup-code')).toBe(false);
    expect(sameSecret('a-long-enough-setup-code-and-more', 'a-long-enough-setup-code')).toBe(false);
  });
});

describe('ids', () => {
  it('have the shape the API accepts, and do not repeat', () => {
    const ids = Array.from({ length: 20_000 }, () => newId('emp'));
    for (const id of ids.slice(0, 200)) {
      expect(id).toMatch(ID_PATTERN);
      expect(id).toMatch(/^emp_[0-9a-z]{12}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/*
 * The time zone of the machine the server runs on must never matter (plan.md, 6.6). Any
 * local-time method of Date reads that zone, so none may appear in the rules or the API.
 */
describe('no code reads the server’s own time zone', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const roots = [here, join(here, '../../shared/src')];
  const LOCAL_TIME = /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getMilliseconds|getTimezoneOffset|setFullYear|setMonth|setDate|setHours|setMinutes|setSeconds|setMilliseconds|toDateString|toTimeString|toLocaleDateString|toLocaleTimeString)\(/;
  /** `new Date(2026, 0, 1)`: several arguments are read as local time. */
  const LOCAL_CONSTRUCTOR = /new Date\([^()]*,[^()]*\)/;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });

  it('in shared or in the API', () => {
    const files = roots.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (LOCAL_TIME.test(line) || LOCAL_CONSTRUCTOR.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
