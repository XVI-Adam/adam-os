import type { Project } from './projects.ts';
import type { Capability, ComplexityTier, RouteDecision, TaskCategory, Tier, VerificationPlan, WorkflowId } from './types.ts';
import { WORKFLOWS } from './workflows.ts';

// Deterministic router. Keyword scoring is crude but inspectable and free;
// an LLM refinement step can be layered on later for ambiguous tasks.

const CATEGORY_KEYWORDS: Record<TaskCategory, string[]> = {
  debugging: ['fix', 'bug', 'broken', 'crash', 'error', 'fails', 'failing', 'regression', 'not working', 'doesn\'t work', 'debug', 'investigate why', 'root cause', 'traceback', 'exception', '500', '404'],
  implementation: ['implement', 'add', 'build', 'create', 'feature', 'support', 'integrate', 'wire', 'ship', 'migrate', 'migration', 'replace', 'upgrade', 'swap', 'enable'],
  refactoring: ['refactor', 'clean up', 'cleanup', 'restructure', 'simplify', 'extract', 'reorganize', 'rename', 'dedupe', 'tidy'],
  testing: ['test', 'tests', 'unit test', 'coverage', 'spec', 'assert', 'vitest', 'jest', 'flutter test'],
  evaluation: ['eval', 'evals', 'evaluation', 'harness', 'benchmark', 'accuracy', 'score', 'regression suite', 'grader', 'judge', 'baseline', 'improve accuracy', 'hallucination'],
  documentation: ['document', 'documentation', 'docs', 'readme', 'write up', 'explain', 'comment', 'changelog', 'guide'],
  ux_design: ['ux', 'ui', 'design', 'visual', 'polish', 'style', 'styling', 'layout', 'animation', 'look', 'feel', 'css', 'responsive', 'mobile view'],
  architecture: ['architecture', 'architect', 'design the system', 'plan the', 'structure', 'schema', 'data model', 'pipeline', 'redesign', 'scalab'],
  deployment: ['deploy', 'deployment', 'release', 'app store', 'testflight', 'production', 'prod', 'vercel', 'domain', 'ship to', 'go live', 'publish', 'launch'],
  data_acquisition: ['scrape', 'scraping', 'collect data', 'dataset', 'service manual', 'ingest', 'import data', 'seed', 'crawl', 'gather data', 'populate'],
  research: ['research', 'investigate', 'explore', 'compare', 'evaluate options', 'what is', 'how does', 'find out', 'audit', 'assess', 'review the', 'look into', 'options for', 'api docs', 'timing'],
};

const COMPLEX_MARKERS = ['prepare', 'production', 'release', 'app store', 'migrate', 'migration', 'end-to-end', 'end to end', 'across', 'entire', 'whole', 'all ', 'audit', 'pipeline', 'iterate until', 'until', 'security', 'performance', 'redesign', 'replace placeholder', 'real data', 'integrat'];
const SIMPLE_MARKERS = ['typo', 'rename', 'bump', 'one line', 'one-line', 'small', 'minor', 'quick', 'tweak', 'comment', 'update the readme', 'lint'];

const ROLE_CAPS: Record<TaskCategory, Capability[]> = {
  research: ['repo_read', 'web_research'],
  debugging: ['repo_read', 'repo_write', 'run_commands', 'run_tests'],
  implementation: ['repo_read', 'repo_write', 'run_commands', 'run_tests'],
  refactoring: ['repo_read', 'repo_write', 'run_tests'],
  testing: ['repo_read', 'repo_write', 'run_tests'],
  evaluation: ['repo_read', 'repo_write', 'run_eval', 'run_tests'],
  documentation: ['repo_read', 'repo_write'],
  ux_design: ['repo_read', 'repo_write', 'design_review'],
  architecture: ['repo_read', 'design_review'],
  deployment: ['repo_read', 'repo_write', 'run_commands', 'deploy_check'],
  data_acquisition: ['repo_read', 'repo_write', 'web_research', 'run_commands'],
};

function scoreCategories(text: string): Array<[TaskCategory, number]> {
  const t = ` ${text.toLowerCase()} `;
  const scores: Array<[TaskCategory, number]> = [];
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS) as Array<[TaskCategory, string[]]>) {
    let s = 0;
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'g');
      const n = (t.match(re) ?? []).length;
      s += n * (w.length > 6 ? 2 : 1);
    }
    scores.push([cat, s]);
  }
  return scores.sort((a, b) => b[1] - a[1]);
}

export function classifyCategory(text: string, project?: Project): { category: TaskCategory; scores: Array<[TaskCategory, number]>; rationale: string } {
  const scores = scoreCategories(text);
  const t = text.toLowerCase();
  let [category, top] = scores[0];
  let rationale = `keyword score ${top} for ${category}`;
  // Tie-breaks and overrides that reflect what the workflows actually do.
  // A question with read-only intent stays research even when it names eval files:
  // the eval workflow costs a full harness run, which a question never needs.
  const readOnly = readOnlyIntent(t);
  if (readOnly) {
    category = 'research';
    rationale = 'read-only intent (asks a question, no mutation verb)';
  } else if (project?.eval && /\b(eval|harness|regression|accuracy|hallucinat|model migration|deprecated model|judge|grader)/.test(t)) {
    category = 'evaluation';
    rationale = 'project has an eval harness and the task references it';
  } else if (/\b(app store|testflight|release|production[- ]ready|go live|prepare .* for)/.test(t)) {
    category = 'deployment';
    rationale = 'release/production wording';
  } else if (top === 0) {
    category = 'research';
    rationale = 'no keyword matched; defaulting to research (cheapest, read-only)';
  }
  return { category, scores, rationale };
}

export function scoreComplexity(text: string, category: TaskCategory, project?: Project): { score: number; tier: ComplexityTier; reasons: string[] } {
  const t = text.toLowerCase();
  const reasons: string[] = [];
  let score = 2;
  const complexHits = COMPLEX_MARKERS.filter((m) => t.includes(m));
  if (complexHits.length) { score += Math.min(2, complexHits.length); reasons.push(`complex markers: ${complexHits.slice(0, 4).join(', ')}`); }
  const simpleHits = SIMPLE_MARKERS.filter((m) => t.includes(m));
  if (simpleHits.length) { score -= 1; reasons.push(`simple markers: ${simpleHits.join(', ')}`); }
  const conjunctions = (t.match(/\b(and|then)\b/g) ?? []).length + (t.match(/,/g) ?? []).length;
  if (conjunctions >= 3) { score += 1; reasons.push(`multi-part task (${conjunctions} conjunctions)`); }
  if (t.length > 160) { score += 1; reasons.push('long description'); }
  if (['architecture', 'deployment', 'evaluation', 'data_acquisition'].includes(category)) { score += 1; reasons.push(`category ${category} is inherently multi-step`); }
  if (project?.eval && category === 'evaluation') { score += 1; reasons.push('eval harness in the loop'); }
  score = Math.max(1, Math.min(5, score));
  const tier: ComplexityTier = score <= 2 ? 'simple' : score === 3 ? 'medium' : 'complex';
  return { score, tier, reasons };
}

export function chooseWorkflow(category: TaskCategory, complexity: ComplexityTier, text: string, project?: Project): WorkflowId {
  const t = text.toLowerCase();
  if (category === 'evaluation') return project?.eval ? 'ai_agent_improvement' : 'testing';
  if (category === 'deployment' || (category === 'architecture' && /audit|readiness|production/.test(t))) return 'production_readiness';
  if (category === 'debugging') return complexity === 'simple' ? 'quick_fix' : 'bug_fix';
  if (category === 'implementation' || category === 'ux_design') return complexity === 'simple' ? 'quick_fix' : 'feature';
  if (category === 'refactoring') return 'refactor';
  if (category === 'testing') return 'testing';
  if (category === 'documentation') return 'documentation';
  return 'research'; // research, architecture, data_acquisition
}

export function tierFor(complexity: ComplexityTier): Tier {
  return complexity === 'simple' ? 'light' : complexity === 'medium' ? 'standard' : 'strong';
}

export function planVerification(project: Project, category: TaskCategory, workflow: WorkflowId): VerificationPlan[] {
  const plans: VerificationPlan[] = [];
  const c = project.commands;
  if (c.typecheck) plans.push({ id: 'typecheck', kind: 'command', label: 'Type check', command: c.typecheck, required: true, scopes: ['all', 'typecheck', 'baseline'] });
  const readOnly = category === 'research' || category === 'documentation' || category === 'architecture';
  if (c.test && !readOnly) plans.push({ id: 'test', kind: 'command', label: 'Unit tests', command: c.test, required: true, scopes: ['all', 'tests', 'baseline'] });
  if (c.lint && ['implementation', 'refactoring', 'ux_design'].includes(category)) plans.push({ id: 'lint', kind: 'command', label: 'Lint', command: c.lint, required: false, scopes: ['all'] });
  if (c.build && ['deployment', 'ux_design', 'implementation'].includes(category)) plans.push({ id: 'build', kind: 'command', label: 'Build', command: c.build, required: category === 'deployment', scopes: ['all', 'build'] });
  if (project.eval && (workflow === 'ai_agent_improvement' || category === 'evaluation')) {
    plans.push({ id: 'eval', kind: 'eval', label: 'Eval harness', command: project.eval.command, required: true, scopes: ['all', 'eval', 'baseline'] });
  }
  return plans;
}

export function route(text: string, project: Project, desiredOutcome?: string): RouteDecision {
  const full = desiredOutcome ? `${text}\n${desiredOutcome}` : text;
  const cat = classifyCategory(full, project);
  const cx = scoreComplexity(full, cat.category, project);
  const workflow = chooseWorkflow(cat.category, cx.tier, full, project);
  const verification = planVerification(project, cat.category, workflow);
  const steps = WORKFLOWS[workflow].steps;
  const agentSteps = steps.filter((s) => s.kind === 'agent').length;
  // Each agent step is a tool loop of a few model calls; estimate 3 per step.
  const estimatedAgentCalls = agentSteps * 3;
  let wall = 10 + agentSteps * 4;
  if (verification.some((v) => v.kind === 'eval')) wall += 40; // paced eval run at Groq's per-minute cap
  const rationale = [
    `category: ${cat.category} (${cat.rationale})`,
    `complexity: ${cx.score}/5 → ${cx.tier}${cx.reasons.length ? ' (' + cx.reasons.join('; ') + ')' : ''}`,
    `workflow: ${workflow} — ${WORKFLOWS[workflow].description}`,
    `verification: ${verification.map((v) => v.id).join(', ') || 'none available for this project'}`,
  ];
  return {
    project: project.slug,
    category: cat.category,
    complexity: { score: cx.score, tier: cx.tier },
    capabilities: ROLE_CAPS[cat.category],
    workflow,
    tier: tierFor(cx.tier),
    verification,
    estimatedAgentCalls,
    estimatedWallClockMinutes: wall,
    rationale,
  };
}

const RESEARCH_OPENERS = /^\s*(research|investigate|explain|describe|what|which|how|why|where|compare|find out|check whether|check if|tell me|list|summari[sz]e|audit|assess|look into|is |are |does |do )/;
const MUTATION_VERBS = /\b(implement|fix|change|improve|migrate|iterate|update|add|replace|refactor|remove|delete|write|create|build|ship|deploy|release|prepare|make|enable|disable|rename|bump|upgrade|promote|run the|re-?run)\b/;

/** True when the task reads like a question and contains no verb that asks for a change. */
export function readOnlyIntent(text: string): boolean {
  const t = text.toLowerCase();
  return RESEARCH_OPENERS.test(t) && !MUTATION_VERBS.test(t);
}
