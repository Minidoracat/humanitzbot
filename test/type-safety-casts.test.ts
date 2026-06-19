// P2-7b — self-enforced SAFETY gate for `as unknown as` double-casts in src/.
//
// PR #20 cut the double-cast count and gave every survivor a `// SAFETY:`
// justification. This test stops the count from silently creeping back and
// stops new unjustified casts from sneaking in (Minidoracat's request).
//
// Two guards:
//   1. every `as unknown as` in src/ has a `// SAFETY:` comment nearby;
//   2. the total stays under MAX_CASTS.
//
// Note on the window: Minidoracat asked for "same or previous line". In practice
// many casts are multi-line expressions whose justification block sits a few
// lines above, or whose `// SAFETY:` trails the closing paren — so we accept a
// `// SAFETY:` within ±WINDOW lines instead of literally same/prev. The count
// ceiling is the real anti-creep backstop; the comment check enforces intent.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SRC_DIR = join(process.cwd(), 'src');
// Matches `as unknown as` even when wrapped across lines — a single-line check
// would let a multi-line cast slip the gate entirely (count + comment check).
const CAST_RE = /\bas\s+unknown\s+as\b/g;
const WINDOW = 3;
// Ceiling, not a ratchet: keep headroom so routine refactors don't churn this
// test, while bulk creep still trips it. Lower it whenever the count drops.
const MAX_CASTS = 35;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 0-based line index of every real (non-comment) `as unknown as`, anchored at the
// match start. Scans the whole file text so a cast wrapped across lines still
// counts; skips matches sitting after a `//` or on a JSDoc `*` continuation line.
function castLineIndexes(text: string, lines: string[]): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  CAST_RE.lastIndex = 0;
  while ((m = CAST_RE.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const lineIdx = before.split('\n').length - 1;
    const col = m.index - (before.lastIndexOf('\n') + 1);
    const line = lines[lineIdx] ?? '';
    const commentAt = line.indexOf('//');
    if (commentAt !== -1 && commentAt < col) continue; // line comment before the cast
    if (/^\s*\*/.test(line)) continue; // JSDoc continuation line
    out.push(lineIdx);
  }
  return out;
}

type Cast = { loc: string; justified: boolean };

const casts: Cast[] = [];
for (const file of tsFiles(SRC_DIR)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const rel = file.slice(SRC_DIR.length - 'src'.length);
  for (const i of castLineIndexes(text, lines)) {
    const from = Math.max(0, i - WINDOW);
    const to = Math.min(lines.length - 1, i + WINDOW);
    const justified = lines.slice(from, to + 1).some((l) => l.includes('// SAFETY:'));
    casts.push({ loc: `${rel}:${i + 1}`, justified });
  }
}

describe('type-safety: `as unknown as` double-cast gate (P2-7b)', () => {
  it(`every double-cast in src/ has a // SAFETY: comment within ${WINDOW} lines`, () => {
    const unjustified = casts.filter((c) => !c.justified).map((c) => c.loc);
    assert.deepEqual(
      unjustified,
      [],
      `These \`as unknown as\` casts lack a \`// SAFETY:\` comment within ${WINDOW} lines:\n  ${unjustified.join('\n  ')}\nAdd a \`// SAFETY:\` explaining why the double-cast is sound, or remove the cast.`,
    );
  });

  it(`keeps the double-cast count under ${MAX_CASTS} (currently ${casts.length})`, () => {
    assert.ok(
      casts.length < MAX_CASTS,
      `src/ has ${casts.length} \`as unknown as\` casts (ceiling ${MAX_CASTS}). ` +
        `Prefer a narrower type or a runtime guard over a new double-cast.`,
    );
  });
});
