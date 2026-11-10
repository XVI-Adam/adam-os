// Anti-runaway progress policy. Reading is not progress. An agent must
// periodically show one of: an edit, a command run, a finish, or (for read-only
// roles) a written checkpoint summary with a concrete next action. Otherwise the
// loop forces a compact summary and then a finish.

export interface ProgressPolicy {
  /** Turns without progress before a checkpoint is demanded. */
  stallWindow: number;
  /** Checkpoints allowed before the step is force-finished. */
  maxCheckpoints: number;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = { stallWindow: 4, maxCheckpoints: 1 };
export const READ_ONLY_PROGRESS_POLICY: ProgressPolicy = { stallWindow: 5, maxCheckpoints: 2 };

export type ProgressVerdict = 'progress' | 'stall' | 'checkpoint_due' | 'force_finish';

export interface TurnSignal {
  toolCalls: Array<{ name: string; args: Record<string, unknown>; ok: boolean }>;
  text: string;
  /** True when this turn was the reply to a checkpoint request. */
  answeringCheckpoint?: boolean;
}

const PROGRESS_TOOLS = new Set(['edit_file', 'write_file', 'run_command', 'finish']);

export class ProgressTracker {
  policy: ProgressPolicy;
  turns = 0;
  turnsSinceProgress = 0;
  checkpoints = 0;
  repeatedReads = 0;
  private seen = new Set<string>();
  private lastVerdict: ProgressVerdict = 'progress';

  constructor(policy: ProgressPolicy = DEFAULT_PROGRESS_POLICY) { this.policy = policy; }

  private readKey(name: string, args: Record<string, unknown>): string {
    return `${name}:${JSON.stringify({ p: args.path ?? args.dir ?? args.pattern ?? '', s: args.start_line ?? '', e: args.end_line ?? '' })}`;
  }

  /** Classify a completed turn and say what the loop should do next. */
  record(turn: TurnSignal): ProgressVerdict {
    this.turns++;
    let progressed = turn.toolCalls.some((c) => PROGRESS_TOOLS.has(c.name) && c.ok);
    if (turn.answeringCheckpoint && turn.text.trim().length >= 80) progressed = true; // a real summary counts once
    let repeats = 0;
    for (const c of turn.toolCalls) {
      if (PROGRESS_TOOLS.has(c.name)) continue;
      const k = this.readKey(c.name, c.args);
      if (this.seen.has(k)) repeats++; else this.seen.add(k);
    }
    this.repeatedReads += repeats;
    if (progressed) { this.turnsSinceProgress = 0; this.lastVerdict = 'progress'; return 'progress'; }
    // A repeated read is a stronger stall signal than a new one.
    this.turnsSinceProgress += repeats > 0 ? 2 : 1;
    if (this.turnsSinceProgress < this.policy.stallWindow) { this.lastVerdict = 'stall'; return 'stall'; }
    if (this.checkpoints >= this.policy.maxCheckpoints) { this.lastVerdict = 'force_finish'; return 'force_finish'; }
    this.checkpoints++;
    this.turnsSinceProgress = 0;
    this.lastVerdict = 'checkpoint_due';
    return 'checkpoint_due';
  }

  checkpointPrompt(): string {
    return 'Progress check: you have used several turns without an edit, a command run, or a result. In at most 150 words, state (1) what you have established so far with file references, (2) the single most likely root cause or answer, and (3) your next concrete action. If you already have enough, call finish now instead.';
  }

  summary(): { turns: number; checkpoints: number; repeatedReads: number; last: ProgressVerdict } {
    return { turns: this.turns, checkpoints: this.checkpoints, repeatedReads: this.repeatedReads, last: this.lastVerdict };
  }
}
