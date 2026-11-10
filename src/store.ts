import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import type { Event, TaskRecord } from './types.ts';

export type ControlAction = 'pause' | 'stop' | 'replan' | 'resume';

export class Store {
  dir: string;
  constructor(dir: string = loadConfig().dataDir) {
    this.dir = dir;
    mkdirSync(resolve(dir, 'tasks'), { recursive: true });
    mkdirSync(resolve(dir, 'logs'), { recursive: true });
  }

  taskPath(id: string): string { return resolve(this.dir, 'tasks', `${id}.json`); }
  controlPath(id: string): string { return resolve(this.dir, 'tasks', `${id}.control`); }
  logPath(id: string): string { return resolve(this.dir, 'logs', `${id}.log`); }
  eventsPath(): string { return resolve(this.dir, 'events.jsonl'); }

  saveTask(task: TaskRecord): void {
    task.updatedAt = new Date().toISOString();
    const tmp = `${this.taskPath(task.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(task, null, 2));
    renameSync(tmp, this.taskPath(task.id));
  }

  loadTask(id: string): TaskRecord | undefined {
    const p = this.taskPath(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as TaskRecord;
  }

  /** Accepts a full id or a unique prefix. */
  resolveTaskId(idOrPrefix: string): string | undefined {
    const ids = this.listTaskIds();
    if (ids.includes(idOrPrefix)) return idOrPrefix;
    const matches = ids.filter((i) => i.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  listTaskIds(): string[] {
    const d = resolve(this.dir, 'tasks');
    return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  listTasks(): TaskRecord[] {
    return this.listTaskIds()
      .map((id) => this.loadTask(id))
      .filter((t): t is TaskRecord => Boolean(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  appendEvent(ev: Omit<Event, 'ts'> & { ts?: string }): void {
    const full: Event = { ts: new Date().toISOString(), ...ev } as Event;
    appendFileSync(this.eventsPath(), JSON.stringify(full) + '\n');
  }

  readEvents(taskId?: string): Event[] {
    const p = this.eventsPath();
    if (!existsSync(p)) return [];
    const out: Event[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as Event;
        if (!taskId || ev.taskId === taskId) out.push(ev);
      } catch { /* skip malformed line */ }
    }
    return out;
  }

  setControl(id: string, action: ControlAction): void {
    writeFileSync(this.controlPath(id), JSON.stringify({ action, at: new Date().toISOString() }));
  }

  readControl(id: string): ControlAction | undefined {
    const p = this.controlPath(id);
    if (!existsSync(p)) return undefined;
    try { return (JSON.parse(readFileSync(p, 'utf8')) as { action: ControlAction }).action; } catch { return undefined; }
  }

  clearControl(id: string): void {
    const p = this.controlPath(id);
    if (existsSync(p)) unlinkSync(p);
  }
}

export function newTaskId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}
