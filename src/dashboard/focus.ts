import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// "Today" list for the dashboard: the handful of things you decided to do,
// whether pinned from the brief or typed in. Plain JSON in the data dir.
// Unfinished items carry over; finished ones drop off the next local day
// (they stay in the file as a log).

export interface FocusItem {
  id: string;
  text: string;
  project?: string;
  /** Brief candidate this was pinned from (`slug:kind`), so the same item is not pinned twice. */
  source?: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}

const MAX_TEXT = 300;

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export class FocusStore {
  private path: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = resolve(dataDir, 'focus.json');
  }

  private read(): FocusItem[] {
    if (!existsSync(this.path)) return [];
    try { return (JSON.parse(readFileSync(this.path, 'utf8')) as { items: FocusItem[] }).items ?? []; } catch { return []; }
  }

  private write(items: FocusItem[]): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items }, null, 2));
    renameSync(tmp, this.path);
  }

  /** Open items plus anything finished today, oldest first. */
  list(now: number = Date.now()): FocusItem[] {
    const today = startOfLocalDay(now);
    return this.read().filter((i) => !i.done || (i.doneAt !== undefined && Date.parse(i.doneAt) >= today));
  }

  add(input: { text: string; project?: string; source?: string }, now: number = Date.now()): FocusItem {
    const text = String(input.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) throw new Error('focus item needs text');
    const items = this.read();
    const dup = input.source ? items.find((i) => !i.done && i.source === input.source) : undefined;
    if (dup) return dup;
    const item: FocusItem = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text, project: input.project || undefined, source: input.source || undefined,
      done: false, createdAt: new Date(now).toISOString(),
    };
    this.write([...items, item]);
    return item;
  }

  update(id: string, patch: { done?: boolean; text?: string }, now: number = Date.now()): FocusItem | undefined {
    const items = this.read();
    const item = items.find((i) => i.id === id);
    if (!item) return undefined;
    if (typeof patch.done === 'boolean') {
      item.done = patch.done;
      item.doneAt = patch.done ? new Date(now).toISOString() : undefined;
    }
    if (typeof patch.text === 'string' && patch.text.trim()) item.text = patch.text.trim().slice(0, MAX_TEXT);
    this.write(items);
    return item;
  }

  remove(id: string): boolean {
    const items = this.read();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length) return false;
    this.write(next);
    return true;
  }
}
