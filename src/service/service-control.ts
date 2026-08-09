import { printDaemonHelp } from '../cli/help.js';

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { dataDir, logsDir, projectHomeDir, serviceMarkerPath } from '../paths.js';

const SERVICE_MARKER = serviceMarkerPath();
const DEFAULT_INSTALL_DIR = resolve(homedir(), '.local/share/cursor-cp');

function launchdDomain(): string {
  const uid = process.getuid?.() ?? parseInt(execSync('id -u', { encoding: 'utf-8' }).trim(), 10);
  return `gui/${uid}`;
}

function resolveNodePath(): string {
  const candidates = [
    process.execPath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    return execSync('node -p process.execPath', {
      encoding: 'utf-8',
      env: process.env,
    }).trim();
  } catch {
    throw new Error('Node.js not found. Install Node.js 20+ and ensure it is on PATH.');
  }
}

function resolveInstallDir(): string {
  return process.env.CURSOR_CP_INSTALL_DIR?.trim() || DEFAULT_INSTALL_DIR;
}

/** PATH for background services — launchd/systemd omit shell profile paths. */
function resolveServicePath(): string {
  const home = homedir();
  const parts = new Set<string>();
  const add = (entry: string) => {
    const trimmed = entry.trim();
    if (trimmed) parts.add(trimmed);
  };

  for (const entry of (process.env.PATH ?? '').split(':')) {
    add(entry);
  }

  add(resolve(home, '.local/bin'));
  add('/opt/homebrew/bin');
  add('/opt/homebrew/sbin');
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');
  add('/usr/sbin');
  add('/sbin');

  return [...parts].join(':');
}

function escapePlistString(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface ServiceMarker {
  type: 'systemd-user' | 'launchd';
  unit?: string;
  label?: string;
  installDate: string;
}

export class ServiceController {
  private marker: ServiceMarker | null = null;

  constructor() {
    this.loadMarker();
  }

  private loadMarker(): void {
    if (existsSync(SERVICE_MARKER)) {
      try {
        const content = readFileSync(SERVICE_MARKER, 'utf-8');
        this.marker = JSON.parse(content) as ServiceMarker;
      } catch {
        this.marker = null;
      }
    }
  }

  private saveMarker(marker: ServiceMarker): void {
    mkdirSync(dataDir(), { recursive: true });
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(SERVICE_MARKER, JSON.stringify(marker, null, 2));
    this.marker = marker;
  }

  isInstalled(): boolean {
    return this.marker !== null;
  }

  getStatus(): 'running' | 'stopped' | 'unknown' {
    if (!this.marker) return 'unknown';

    try {
      if (this.marker.type === 'systemd-user') {
        const output = execSync(`systemctl --user is-active ${this.marker.unit}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        return output.trim() === 'active' ? 'running' : 'stopped';
      } else if (this.marker.type === 'launchd') {
        return this.isLaunchdRunning(this.marker.label!) ? 'running' : 'stopped';
      }
    } catch {
      return 'stopped';
    }

    return 'unknown';
  }

  async install(): Promise<void> {
    const platform = process.platform;

    if (platform === 'darwin') {
      await this.installLaunchd();
    } else if (platform === 'linux') {
      await this.installSystemd();
    } else {
      throw new Error(`Service installation not supported on ${platform}`);
    }
  }

  private isLaunchdRunning(label: string): boolean {
    try {
      const output = execSync(`launchctl print ${launchdDomain()}/${label}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return /state = running/i.test(output);
    } catch {
      return false;
    }
  }

  private launchdPlistPath(label: string): string {
    return resolve(homedir(), 'Library/LaunchAgents', `${label}.plist`);
  }

  private sleepSync(seconds: number): void {
    try {
      execSync(`sleep ${seconds}`, { stdio: 'ignore' });
    } catch {
      // Best-effort delay.
    }
  }

  private isLaunchdRegistered(label: string): boolean {
    try {
      execSync(`launchctl print ${launchdDomain()}/${label}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Remove any existing registration for the label, trying every launchctl form. */
  private bootoutLaunchd(label: string, plistPath: string): void {
    const domain = launchdDomain();
    const commands = [
      `launchctl bootout ${domain}/${label}`,
      `launchctl bootout ${domain} ${plistPath}`,
      `launchctl unload ${plistPath}`,
      `launchctl remove ${label}`,
    ];
    for (const command of commands) {
      try {
        execSync(command, { stdio: 'pipe' });
      } catch {
        // Try the next form; the job may not be registered in this domain.
      }
    }

    // launchctl returns before the job is fully torn down; bootstrapping too
    // soon yields "5: Input/output error". Wait for it to actually unregister.
    for (let i = 0; i < 12 && this.isLaunchdRegistered(label); i++) {
      this.sleepSync(0.5);
    }
  }

  private bootstrapLaunchd(label: string, plistPath: string): void {
    const domain = launchdDomain();
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      this.bootoutLaunchd(label, plistPath);
      this.sleepSync(0.5);

      try {
        execSync(`launchctl bootstrap ${domain} ${plistPath}`, { stdio: 'pipe' });
        return;
      } catch (err) {
        lastError = err;
      }

      try {
        execSync(`launchctl load -w ${plistPath}`, { stdio: 'pipe' });
        return;
      } catch (err) {
        lastError = err;
      }

      this.sleepSync(1);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('launchctl bootstrap failed');
  }

  private kickstartLaunchd(label: string): void {
    execSync(`launchctl kickstart -k ${launchdDomain()}/${label}`);
  }

  private async installLaunchd(): Promise<void> {
    const label = 'com.cursor.cp';
    const plistPath = this.launchdPlistPath(label);
    const nodePath = resolveNodePath();
    const cliPath = resolve(resolveInstallDir(), 'dist/cli/index.js');
    const servicePath = escapePlistString(resolveServicePath());

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>${servicePath}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${projectHomeDir()}</string>
    <key>StandardOutPath</key>
    <string>${logsDir()}/service.log</string>
    <key>StandardErrorPath</key>
    <string>${logsDir()}/service.error.log</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;

    mkdirSync(resolve(homedir(), 'Library/LaunchAgents'), { recursive: true });
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(plistPath, plist);

    this.bootstrapLaunchd(label, plistPath);
    if (!this.isLaunchdRunning(label)) {
      throw new Error(
        'Failed to start launchd service. Check ~/cursor-cp/logs/service.error.log',
      );
    }

    this.saveMarker({
      type: 'launchd',
      label,
      installDate: new Date().toISOString(),
    });

    console.log('✅ Daemon enabled (macOS LaunchAgent)');
    console.log(`   Plist: ${plistPath}`);
    console.log(`   Logs: ${logsDir()}/service.log`);
  }

  private async installSystemd(): Promise<void> {
    const unit = 'cursor-cp.service';
    const unitPath = resolve(homedir(), '.config/systemd/user', unit);
    const nodePath = resolveNodePath();
    const cliPath = resolve(resolveInstallDir(), 'dist/cli/index.js');
    const servicePath = resolveServicePath();

    const service = `[Unit]
Description=Cursor Control Plane + CLI
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath} serve
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=${servicePath}
WorkingDirectory=${projectHomeDir()}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target`;

    mkdirSync(resolve(homedir(), '.config/systemd/user'), { recursive: true });
    writeFileSync(unitPath, service);

    // Reload and enable
    try {
      execSync('systemctl --user daemon-reload');
      execSync(`systemctl --user enable ${unit}`);
      execSync(`systemctl --user start ${unit}`);
    } catch (err) {
      throw new Error(`Failed to install systemd service: ${err}`);
    }

    this.saveMarker({
      type: 'systemd-user',
      unit,
      installDate: new Date().toISOString(),
    });

    console.log('✅ Daemon enabled (systemd user service)');
    console.log(`   Unit: ${unitPath}`);
    console.log('   View logs: journalctl --user -u cursor-cp.service -f');
  }

  async start(): Promise<void> {
    if (!this.marker) {
      throw new Error('Daemon not enabled. Run: cursor-cp daemon enable');
    }

    if (this.marker.type === 'systemd-user') {
      execSync(`systemctl --user start ${this.marker.unit}`);
    } else if (this.marker.type === 'launchd') {
      const label = this.marker.label!;
      const plistPath = this.launchdPlistPath(label);
      try {
        this.kickstartLaunchd(label);
      } catch {
        this.bootstrapLaunchd(label, plistPath);
      }
    }

    if (this.getStatus() !== 'running') {
      throw new Error('Failed to start daemon. Check ~/cursor-cp/logs/service.error.log');
    }

    console.log('✅ Daemon started');
  }

  async stop(): Promise<void> {
    if (!this.marker) {
      throw new Error('Service not installed');
    }

    if (this.marker.type === 'systemd-user') {
      execSync(`systemctl --user stop ${this.marker.unit}`);
    } else if (this.marker.type === 'launchd') {
      const label = this.marker.label!;
      this.bootoutLaunchd(label, this.launchdPlistPath(label));
    }

    console.log('✅ Daemon stopped');
  }

  async restart(): Promise<void> {
    if (!this.marker) {
      throw new Error('Daemon not enabled. Run: cursor-cp daemon enable');
    }

    if (this.marker.type === 'systemd-user') {
      execSync(`systemctl --user restart ${this.marker.unit}`);
    } else if (this.marker.type === 'launchd') {
      const label = this.marker.label!;
      const plistPath = this.launchdPlistPath(label);
      this.bootoutLaunchd(label, plistPath);
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.bootstrapLaunchd(label, plistPath);
    }

    if (this.getStatus() !== 'running') {
      throw new Error('Failed to restart daemon. Check ~/cursor-cp/logs/service.error.log');
    }

    console.log('✅ Service restarted');
  }

  async uninstall(): Promise<void> {
    if (!this.marker) {
      console.log('Daemon not enabled');
      return;
    }

    // Stop first
    try {
      await this.stop();
    } catch {
      // Ignore stop errors
    }

    if (this.marker.type === 'systemd-user') {
      const unitPath = resolve(homedir(), '.config/systemd/user', this.marker.unit!);
      try {
        execSync(`systemctl --user disable ${this.marker.unit}`);
      } catch {
        // Ignore
      }
      if (existsSync(unitPath)) {
        unlinkSync(unitPath);
      }
    } else if (this.marker.type === 'launchd') {
      const label = this.marker.label!;
      const plistPath = this.launchdPlistPath(label);
      this.bootoutLaunchd(label, plistPath);
      if (existsSync(plistPath)) {
        unlinkSync(plistPath);
      }
    }

    // Remove marker
    if (existsSync(SERVICE_MARKER)) {
      unlinkSync(SERVICE_MARKER);
    }
    this.marker = null;

    console.log('✅ Daemon disabled');
  }

  printStatus(): void {
    if (!this.marker) {
      console.log('Daemon status: Not enabled');
      console.log('Run: cursor-cp daemon enable');
      return;
    }

    const status = this.getStatus();
    console.log(`Daemon type: ${this.marker.type}`);
    console.log(`Status: ${status}`);
    console.log(`Enabled since: ${this.marker.installDate}`);

    if (this.marker.type === 'systemd-user') {
      console.log(`Unit: ${this.marker.unit}`);
      console.log('Commands:');
      console.log(`  systemctl --user status ${this.marker.unit}`);
      console.log(`  systemctl --user restart ${this.marker.unit}`);
    } else if (this.marker.type === 'launchd') {
      console.log(`Label: ${this.marker.label}`);
      console.log('Commands:');
      console.log(`  launchctl list ${this.marker.label}`);
    }
  }
}

// CLI commands
export async function runDaemonCommand(command: string): Promise<void> {
  const controller = new ServiceController();

  switch (command) {
    case 'enable':
      await controller.install();
      break;
    case 'disable':
      await controller.uninstall();
      break;
    case 'start':
      await controller.start();
      break;
    case 'stop':
      await controller.stop();
      break;
    case 'restart':
      await controller.restart();
      break;
    case 'status':
      controller.printStatus();
      break;
    default:
      printDaemonHelp();
      process.exit(1);
  }
}
