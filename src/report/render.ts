import type { Report, Survivor } from './types.ts';

export function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# weakspot report`, ``, `Repo: ${r.repo}  `, `Change: ${r.change.kind} (${r.change.detail})  `, `Run: ${r.createdAt}  `, `Command: \`${r.command}\``, ``);
  lines.push(...packageTable(r));
  lines.push(...section('Untested (no spec found, not mutated)', r.untested));
  lines.push(...section('Mutated whole because a spec that imports them changed', r.viaChangedSpec));
  lines.push(...section('No unit spec, checked by a later lane', r.viaFallback.map((f) => `${f.file}: ${f.lane} lane`)));
  lines.push(...section('No test config found', r.noTestConfig));
  lines.push(...section('Warnings', r.warnings));
  lines.push(...section('Skipped by triage', r.dropped.map((d) => `${d.path}: ${d.reason}`)));
  lines.push(...survivorList(r.survivors));
  return lines.join('\n');
}

function packageTable(r: Report): string[] {
  const lines = [
    `## Packages`,
    ``,
    `| Lane | Package | Files | Specs | Tests | Mutants | Killed | Survived | No coverage | Timeout | Errors | Ignored | Time |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const p of r.packages) {
    const c = p.counts;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const errors = (c['CompileError'] ?? 0) + (c['RuntimeError'] ?? 0);
    lines.push(
      `| ${p.lane} | ${p.name} | ${p.targets.length} | ${p.specs.length} | ${p.testCount} | ${total} | ${c['Killed'] ?? 0} | ${c['Survived'] ?? 0} | ${c['NoCoverage'] ?? 0} | ${c['Timeout'] ?? 0} | ${errors} | ${c['Ignored'] ?? 0} | ${(p.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  return lines;
}

/** A titled bullet list, or nothing when there are no items. */
function section(title: string, items: readonly string[]): string[] {
  return items.length > 0 ? [``, `## ${title}`, ``, ...items.map((i) => `- ${i}`)] : [];
}

function survivorList(survivors: readonly Survivor[]): string[] {
  const lines = [``, `## Survivors (${survivors.length})`, ``];
  if (survivors.length === 0) lines.push(`None.`);
  const byFile = new Map<string, Survivor[]>();
  for (const s of survivors) {
    const key = s.mutant.lane === 'unit' ? s.mutant.file : `${s.mutant.file} (${s.mutant.lane} lane)`;
    byFile.set(key, [...(byFile.get(key) ?? []), s]);
  }
  for (const [file, list] of byFile) {
    lines.push(`### ${file}`, ``, ...list.map(survivorLine), ``);
  }
  return lines;
}

function survivorLine({ mutant: m, kind }: Survivor): string {
  const coverage: Record<Survivor['kind'], string> = {
    static: 'static: every test ran against it, none fails',
    noCoverage: 'no test reaches this line',
    weakAssertion: `${m.coveredBy} covering test(s), none fails`,
  };
  return `- L${m.start.line}:${m.start.column} ${m.mutator} → \`${m.replacement.replace(/\s+/g, ' ').trim() || '(removed)'}\` (${coverage[kind]})`;
}
