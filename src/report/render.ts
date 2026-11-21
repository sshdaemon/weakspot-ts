import { laterLane } from './survivors.ts';
import type { Report, Survivor } from './types.ts';

export function renderMarkdown(r: Report): string {
  return [
    `# weakspot report`,
    ``,
    `Repo: ${r.repo}  `,
    `Change: ${r.change.kind} (${r.change.detail})  `,
    `Run: ${r.createdAt}  `,
    `Command: \`${r.command}\``,
    ``,
    ...packageTable(r),
    ...section('Untested (no spec found, not mutated)', r.untested),
    ...section('Mutated whole because a spec that imports them changed', r.viaChangedSpec),
    ...section('Changed specs whose edit touched only imports (their sources not mutated for them)', r.importOnlySpecs),
    ...section('No unit spec, checked by a later lane', r.viaFallback.map((f) => `${f.file}: ${f.lane} lane`)),
    ...section('No test config found', r.noTestConfig),
    ...section('Warnings', r.warnings),
    ...section('Skipped by triage', r.dropped.map((d) => `${d.path}: ${d.reason}`)),
    ...survivorList(r.survivors.filter((s) => !s.noise && !s.accepted)),
    ...noiseList(r.survivors.filter((s) => s.noise && !s.accepted)),
    ...section('Killed in a later lane (unit tests miss them, not findings)', r.killedLater.map((k) => `${k.where} \`${k.id}\`: ${k.lane} lane`)),
    ...section('Accepted (not findings)', r.accepted.map((a) => `${a.where} \`${a.id}\`: ${a.reason} (${a.date.slice(0, 10)})`)),
  ].join('\n');
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
      `| ${p.escalated ? `${p.lane} (retry)` : p.lane} | ${p.name} | ${p.targets.length} | ${p.specs.length} | ${p.testCount} | ${total} | ${c['Killed'] ?? 0} | ${c['Survived'] ?? 0} | ${c['NoCoverage'] ?? 0} | ${c['Timeout'] ?? 0} | ${errors} | ${c['Ignored'] ?? 0} | ${(p.durationMs / 1000).toFixed(1)}s |`,
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

/** Hidden survivors by class: a count per class, then the lines, so a misjudged class is easy to spot. */
function noiseList(survivors: readonly Survivor[]): string[] {
  if (survivors.length === 0) return [];
  const counts = new Map<string, number>();
  for (const s of survivors) counts.set(s.noise!, (counts.get(s.noise!) ?? 0) + 1);
  const summary = [...counts].map(([cls, n]) => `${cls} ${n}`).join(', ');
  return [``, `## Noise (${survivors.length}, not findings: ${summary})`, ``, ...survivors.map((s) => `${survivorLine(s)} [${s.noise}] in ${s.mutant.file}`)];
}

function survivorLine({ mutant: m, kind, escalated }: Survivor): string {
  const coverage: Record<Survivor['kind'], string> = {
    static: 'static: every test ran against it, none fails',
    noCoverage: 'no test reaches this line',
    weakAssertion: `${m.coveredBy} covering test(s), none fails`,
  };
  const later = escalated ? `; ${laterLane(escalated)}` : '';
  return `- L${m.start.line}:${m.start.column} ${m.mutator} → \`${m.replacement.replaceAll(/\s+/g, ' ').trim() || '(removed)'}\` (${coverage[kind]}${later})`;
}
