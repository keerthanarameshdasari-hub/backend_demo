import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const importsOf = (path: string) =>
  [...readFileSync(path, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('architecture', () => {
  it('src/domain depends only on itself', () => {
    const offenders = files(join(SRC, 'domain')).flatMap((file) =>
      importsOf(file)
        .filter((spec) => !spec.startsWith('./'))
        .map((spec) => `${relative(SRC, file)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('only src/config reads process.env (plus the entry scripts)', () => {
    const allowed = new Set(['config/env.ts', 'main.ts']);
    const offenders = files(SRC)
      .filter((file) => !file.includes(`${join('src', 'generated')}`))
      .filter((file) => !allowed.has(relative(SRC, file)))
      .filter((file) => /process\.env/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
