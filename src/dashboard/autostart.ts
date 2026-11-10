import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { loadConfig, ROOT } from '../config.ts';

// Start the dashboard at login with a per-user launchd agent (macOS). The
// agent runs the same `cli.ts dashboard` command as `npm run dashboard`,
// with the node binary and PATH captured at install time: launchd starts
// jobs with a bare PATH, and the dashboard needs git, the project test
// commands and the claude CLI to be findable.

export const LABEL = 'com.adamos.dashboard';

export interface AutostartOptions {
  port: number;
  /** Absolute path of the node binary to run. */
  node: string;
  /** Repository root (WorkingDirectory, and where cli.ts lives). */
  root: string;
  /** PATH the dashboard and everything it spawns will see. */
  path: string;
  logPath: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist(o: AutostartOptions): string {
  const args = [o.node, resolve(o.root, 'src/cli.ts'), 'dashboard', '--port', String(o.port)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logPath)}</string>
</dict>
</plist>
`;
}

/** PATH entries that exist, in order, without duplicates. */
export function cleanPath(path: string, exists: (dir: string) => boolean = existsSync): string {
  const seen = new Set<string>();
  return path.split(delimiter).filter((dir) => dir && !seen.has(dir) && Boolean(seen.add(dir)) && exists(dir)).join(delimiter);
}

export const plistPath = () => resolve(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;

function launchctl(args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { const err = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message }; }
}

function requireMac(): void {
  if (process.platform !== 'darwin') throw new Error('autostart uses launchd and is only available on macOS; run `npm run dashboard` from your own login items instead');
}

const loaded = () => launchctl(['print', `${domain()}/${LABEL}`]);

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/focus`, { signal: AbortSignal.timeout(1000) })).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Write the agent and (re)start it. Safe to run again: after a node upgrade, a moved repo, or to restart the server. */
export async function installAutostart(port: number): Promise<string> {
  requireMac();
  const dataDir = loadConfig().dataDir;
  const logPath = resolve(dataDir, 'logs', 'dashboard.log');
  mkdirSync(resolve(dataDir, 'logs'), { recursive: true });
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  const file = plistPath();
  writeFileSync(file, renderPlist({ port, node: process.execPath, root: ROOT, path: cleanPath(process.env.PATH ?? '/usr/bin:/bin'), logPath }));

  if (loaded().ok) launchctl(['bootout', `${domain()}/${LABEL}`]);
  // bootout returns before the old process has gone; bootstrap fails with EIO until it has.
  let started = launchctl(['bootstrap', domain(), file]);
  for (let i = 0; i < 10 && !started.ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    started = launchctl(['bootstrap', domain(), file]);
  }
  if (!started.ok) throw new Error(`launchctl could not load ${file}: ${started.out}`);

  const up = await waitForServer(port, 15_000);
  return [
    `installed ${file}`,
    up ? `dashboard is running → http://localhost:${port} (and will start at every login)`
       : `the agent is loaded but nothing answered on port ${port} yet; check ${logPath} (is another dashboard already using the port?)`,
    `log: ${logPath}`,
    'after changing node versions or moving this folder, run this command again',
  ].join('\n');
}

export function uninstallAutostart(): string {
  requireMac();
  const file = plistPath();
  const wasLoaded = loaded().ok;
  if (wasLoaded) launchctl(['bootout', `${domain()}/${LABEL}`]);
  const existed = existsSync(file);
  if (existed) unlinkSync(file);
  return existed || wasLoaded ? `removed ${file}; the dashboard no longer starts at login` : 'autostart was not installed';
}

export function autostartStatus(): string {
  requireMac();
  const file = plistPath();
  if (!existsSync(file)) return 'autostart is not installed (run `orchestrate autostart install`)';
  const port = /<string>--port<\/string>\s*<string>(\d+)<\/string>/.exec(readFileSync(file, 'utf8'))?.[1] ?? '4646';
  const state = loaded();
  const pid = /\bpid = (\d+)/.exec(state.out)?.[1];
  const running = state.ok && pid !== undefined;
  return [
    `installed: ${file}`,
    running ? `running (pid ${pid}) → http://localhost:${port}` : state.ok ? 'loaded, but the dashboard process is not running (see the log)' : 'not loaded (run `orchestrate autostart install` to load it)',
    `log: ${resolve(loadConfig().dataDir, 'logs', 'dashboard.log')}`,
  ].join('\n');
}
