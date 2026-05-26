import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { getRuntimeDirs } from './runtime';

export interface AutostartInstallOpts {
  execPath: string;
  args: string[];
  label: string;
}

export interface AutostartManager {
  platform: 'macos' | 'linux' | 'windows' | 'unsupported';
  isInstalled(): Promise<boolean>;
  install(opts: AutostartInstallOpts): Promise<void>;
  uninstall(): Promise<void>;
  getServicePath(): string;
}

const LABEL = 'com.lakphy.local-router';

function getDaemonLogPath(): string {
  return getRuntimeDirs().logs + '/daemon.log';
}

// ─── macOS LaunchAgent ──────────────────────────────────────────────────────

function getLaunchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function buildPlist(opts: AutostartInstallOpts): string {
  const logPath = getDaemonLogPath();
  const args = [opts.execPath, ...opts.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createMacosManager(): AutostartManager {
  const plistPath = getLaunchAgentPath();
  return {
    platform: 'macos',
    async isInstalled() {
      return existsSync(plistPath);
    },
    async install(opts) {
      const dir = dirname(plistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(plistPath, buildPlist(opts), 'utf-8');
      try {
        execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`, { stdio: 'ignore' });
      } catch {}
      execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: 'ignore' });
    },
    async uninstall() {
      if (!existsSync(plistPath)) return;
      try {
        execSync(`launchctl bootout gui/$(id -u) ${plistPath}`, { stdio: 'ignore' });
      } catch {}
      rmSync(plistPath, { force: true });
    },
    getServicePath() {
      return plistPath;
    },
  };
}

// ─── Linux systemd user unit ────────────────────────────────────────────────

function getSystemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'local-router.service');
}

function buildUnit(opts: AutostartInstallOpts): string {
  const logPath = getDaemonLogPath();
  const execStart = [opts.execPath, ...opts.args].join(' ');
  return `[Unit]
Description=Local Router API Gateway
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

function createLinuxManager(): AutostartManager {
  const unitPath = getSystemdUnitPath();
  return {
    platform: 'linux',
    async isInstalled() {
      if (!existsSync(unitPath)) return false;
      try {
        const out = execSync('systemctl --user is-enabled local-router 2>/dev/null', {
          encoding: 'utf-8',
        }).trim();
        return out === 'enabled';
      } catch {
        return false;
      }
    },
    async install(opts) {
      const dir = dirname(unitPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(unitPath, buildUnit(opts), 'utf-8');
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      execSync('systemctl --user enable local-router', { stdio: 'ignore' });
    },
    async uninstall() {
      try {
        execSync('systemctl --user disable local-router', { stdio: 'ignore' });
      } catch {}
      rmSync(unitPath, { force: true });
      try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      } catch {}
    },
    getServicePath() {
      return unitPath;
    },
  };
}

// ─── Windows Registry ───────────────────────────────────────────────────────

const WIN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_REG_VALUE = 'LocalRouter';

function createWindowsManager(): AutostartManager {
  return {
    platform: 'windows',
    async isInstalled() {
      try {
        execSync(`reg query "${WIN_REG_KEY}" /v ${WIN_REG_VALUE}`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    async install(opts) {
      const cmd = [opts.execPath, ...opts.args].map((a) => `"${a}"`).join(' ');
      execSync(`reg add "${WIN_REG_KEY}" /v ${WIN_REG_VALUE} /t REG_SZ /d "${cmd}" /f`, {
        stdio: 'ignore',
      });
    },
    async uninstall() {
      try {
        execSync(`reg delete "${WIN_REG_KEY}" /v ${WIN_REG_VALUE} /f`, { stdio: 'ignore' });
      } catch {}
    },
    getServicePath() {
      return `${WIN_REG_KEY}\\${WIN_REG_VALUE}`;
    },
  };
}

// ─── Unsupported ────────────────────────────────────────────────────────────

function createUnsupportedManager(): AutostartManager {
  return {
    platform: 'unsupported',
    async isInstalled() {
      return false;
    },
    async install() {
      throw new Error('当前平台不支持自启动');
    },
    async uninstall() {
      throw new Error('当前平台不支持自启动');
    },
    getServicePath() {
      return '';
    },
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createAutostartManager(): AutostartManager {
  const p = platform();
  if (p === 'darwin') return createMacosManager();
  if (p === 'linux') return createLinuxManager();
  if (p === 'win32') return createWindowsManager();
  return createUnsupportedManager();
}

export function getAutostartExecArgs(): { execPath: string; args: string[] } {
  const script = process.argv[1] ?? 'dist/cli.js';
  return {
    execPath: process.execPath,
    args: [script, '__run-server', '--mode', 'daemon'],
  };
}

export function readPlistExecPath(): string | null {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) return null;
  try {
    const content = readFileSync(plistPath, 'utf-8');
    const match = content.match(/<array>\s*<string>([^<]+)<\/string>/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
