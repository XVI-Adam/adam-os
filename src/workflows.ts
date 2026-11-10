import type { Workflow, WorkflowId } from './types.ts';

// Reusable, project-aware step sequences. Verification steps are code, not
// agents; an agent never gets to declare its own success.

export const WORKFLOWS: Record<WorkflowId, Workflow> = {
  quick_fix: {
    id: 'quick_fix',
    description: 'Simple change: implement → verify → review',
    retryFrom: 'implement',
    steps: [
      { id: 'implement', kind: 'agent', role: 'coding', goal: 'Make the smallest correct change that accomplishes the task. Run the relevant project command yourself if allowed, then call finish with changed_files.' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Review the diff (git diff) for correctness, regressions, and completeness against the task. Call finish with verdict approve|request_changes and specific issues.' },
    ],
  },
  bug_fix: {
    id: 'bug_fix',
    description: 'Research → reproduce → diagnose → implement → test → review',
    retryFrom: 'diagnose_fix',
    steps: [
      { id: 'research', kind: 'agent', role: 'research', goal: 'Locate the code paths involved in this bug and any tests or docs that describe expected behaviour. Report exact file paths and line ranges. Do not change files.' },
      { id: 'diagnose_fix', kind: 'agent', role: 'debugging', goal: 'Reproduce the problem (run an allowed test/command if one applies), identify the root cause, and implement a minimal fix. Call finish with root_cause and changed_files.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Review git diff for correctness and regressions. Confirm the fix addresses the root cause rather than the symptom.' },
    ],
  },
  feature: {
    id: 'feature',
    description: 'Plan → research → implement → test → review → product check',
    retryFrom: 'implement',
    steps: [
      { id: 'plan', kind: 'agent', role: 'planner', goal: 'Produce a short, concrete implementation plan: files to touch, order of changes, how to verify. Call finish with plan as a numbered list. Do not change files.' },
      { id: 'research', kind: 'agent', role: 'research', goal: 'Confirm the plan against the actual code: verify the files, APIs and patterns exist as the plan assumes. Report discrepancies. Do not change files.' },
      { id: 'implement', kind: 'agent', role: 'coding', goal: 'Implement the plan. Keep changes scoped. Call finish with changed_files.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Review git diff for correctness, regressions, security, and maintainability.' },
      { id: 'product', kind: 'agent', role: 'product', goal: 'Judge whether the implemented change actually satisfies the stated task and desired outcome from a user/business perspective. Call finish with satisfied true|false and gaps.' },
    ],
  },
  ai_agent_improvement: {
    id: 'ai_agent_improvement',
    description: 'Baseline eval → failure analysis → implement → eval → regression check → review',
    retryFrom: 'implement',
    steps: [
      { id: 'baseline', kind: 'verify', verify: 'baseline' },
      { id: 'analyze', kind: 'agent', role: 'debugging', goal: 'You are given a per-case failure digest from the baseline eval (grader findings are verbatim). Work from the digest first; open a case YAML or ledger entry only when the digest leaves the cause unclear. Group the UNEXPECTED failures by root cause (prompt problem, grader problem, model limitation, data gap), name the responsible file for each group, and propose the single smallest change with the best expected gain across the most cases. If the migration itself is already complete, say so explicitly and list what remains (e.g. stale baseline). Do not change files. Budget your turns: aim to finish within 8. Call finish with findings (one line per group) and proposed_change.' },
      { id: 'implement', kind: 'agent', role: 'coding', goal: 'Implement the proposed change from the analysis step. Respect the project agent instructions exactly. Call finish with changed_files and a one-line rationale.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Review git diff. Check the change is minimal, keeps prompts consistent with the fact ledger where applicable, and does not silence graders. Call finish with verdict.' },
    ],
  },
  production_readiness: {
    id: 'production_readiness',
    description: 'Architecture audit → security audit → performance audit → test → deployment check → final review',
    retryFrom: 'fix',
    steps: [
      { id: 'architecture_audit', kind: 'agent', role: 'research', goal: 'Audit the architecture for release readiness: configuration, error handling, missing pieces. List concrete blockers with file references. Do not change files.' },
      { id: 'security_audit', kind: 'agent', role: 'reviewer', goal: 'Audit for security issues: secrets in code, permissive rules, unsafe inputs, missing auth. List findings with severity and file references.' },
      { id: 'performance_audit', kind: 'agent', role: 'research', goal: 'Identify obvious performance problems: unbounded queries, huge bundles, N+1 patterns, missing indexes. Do not change files.' },
      { id: 'fix', kind: 'agent', role: 'coding', goal: 'Fix only the blocking findings from the audits that are safe to fix in code. Leave anything requiring credentials or external accounts as a documented blocker.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'deployment_check', kind: 'agent', role: 'research', goal: 'Check deployment configuration and scripts; list exactly what a human must do to release (store listing, credentials, domains). Do not change files.' },
      { id: 'final_review', kind: 'agent', role: 'reviewer', goal: 'Summarise readiness: what is done, what blocks release, ordered next actions.' },
    ],
  },
  research: {
    id: 'research',
    description: 'Investigate and report; no code changes',
    retryFrom: 'research',
    steps: [
      { id: 'research', kind: 'agent', role: 'research', goal: 'Investigate the question thoroughly using the repository and provided context. Report findings with file references, unknowns, and recommended next steps. Do not change files.' },
    ],
  },
  documentation: {
    id: 'documentation',
    description: 'Research → write docs → review',
    retryFrom: 'write',
    steps: [
      { id: 'research', kind: 'agent', role: 'research', goal: 'Gather the facts the documentation must contain from the actual code. Do not change files.' },
      { id: 'write', kind: 'agent', role: 'coding', goal: 'Write or update the documentation. Only claim what the code does. Call finish with changed_files.' },
      { id: 'verify', kind: 'verify', verify: 'typecheck' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Check the documentation against the code for accuracy and completeness.' },
    ],
  },
  refactor: {
    id: 'refactor',
    description: 'Plan → refactor → verify → review',
    retryFrom: 'refactor',
    steps: [
      { id: 'plan', kind: 'agent', role: 'planner', goal: 'Plan the refactor: what moves where, what must not change behaviourally, and which tests cover it. Do not change files.' },
      { id: 'refactor', kind: 'agent', role: 'coding', goal: 'Perform the refactor with no behaviour change. Call finish with changed_files.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Confirm behaviour is unchanged and the structure is better. Flag any semantic drift.' },
    ],
  },
  testing: {
    id: 'testing',
    description: 'Write tests → run → review',
    retryFrom: 'write_tests',
    steps: [
      { id: 'write_tests', kind: 'agent', role: 'coding', goal: 'Add or fix tests as the task requires, following the existing test patterns in the repo. Call finish with changed_files.', minTier: 'standard' },
      { id: 'verify', kind: 'verify', verify: 'all' },
      { id: 'review', kind: 'agent', role: 'reviewer', goal: 'Review the tests for meaningfulness: do they fail when the behaviour breaks?' },
    ],
  },
};

export function getWorkflow(id: WorkflowId): Workflow {
  return WORKFLOWS[id];
}
