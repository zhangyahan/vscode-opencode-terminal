/**
 * Pure helpers for reading VS Code's `terminal.integrated` settings.
 *
 * `vscode` is deliberately not imported here. The extension passes raw values
 * from `WorkspaceConfiguration.get`/`inspect` into these helpers so the same
 * parsing can be unit tested with plain Node.
 */

import type { ShellProfile } from './shellProfile';

export type TerminalPlatformKey = 'windows' | 'linux' | 'osx';

/** Maps `process.platform` to the suffix used by VS Code terminal settings. */
export function terminalPlatformKey(platform: string): TerminalPlatformKey {
  const value = platform.toLowerCase();
  if (value.startsWith('win')) {
    return 'windows';
  }
  if (value === 'darwin' || value === 'macos' || value === 'osx') {
    return 'osx';
  }
  return 'linux';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Normalizes the raw `terminal.integrated.profiles.<platform>` value. Unknown
 * fields are ignored; malformed optional fields are dropped instead of being
 * forwarded to the resolver as non-strings.
 */
export function sanitizeProfiles(value: unknown): Record<string, ShellProfile> {
  if (!isRecord(value)) {
    return {};
  }

  const profiles: Record<string, ShellProfile> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (name.length === 0 || !isRecord(raw)) {
      continue;
    }

    const profile: {
      path?: string | readonly string[];
      args?: string | readonly string[];
      env?: Record<string, string | null>;
      source?: string;
    } = {};

    if (typeof raw.path === 'string') {
      profile.path = raw.path;
    } else if (isStringArray(raw.path)) {
      profile.path = [...raw.path];
    }

    if (typeof raw.args === 'string') {
      profile.args = raw.args;
    } else if (isStringArray(raw.args)) {
      profile.args = [...raw.args];
    }

    if (isRecord(raw.env)) {
      const env: Record<string, string | null> = {};
      for (const [key, entry] of Object.entries(raw.env)) {
        if (typeof entry === 'string' || entry === null) {
          env[key] = entry;
        }
      }
      profile.env = env;
    }

    if (typeof raw.source === 'string') {
      profile.source = raw.source;
    }

    profiles[name] = profile;
  }
  return profiles;
}

/** Normalizes `terminal.integrated.env.<platform>` (string values and null). */
export function sanitizeEnv(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) {
    return {};
  }

  const env: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) {
      continue;
    }
    if (typeof entry === 'string' || entry === null) {
      env[key] = entry;
    }
  }
  return env;
}

/** Platform-specific setting keys checked for workspace-scoped overrides. */
export function terminalSettingKeys(platform: string): readonly string[] {
  const key = terminalPlatformKey(platform);
  return [
    `defaultProfile.${key}`,
    `profiles.${key}`,
    `env.${key}`,
  ];
}

/**
 * Adds the terminal capabilities expected by TUI applications. `shellProfile`
 * already removed Electron-only variables; this only sets TERM/COLORTERM.
 */
export function withTerminalEnvironment(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
}

/** Environment names read by OpenCode's editor integration (in this order). */
export const EDITOR_BRIDGE_PORT_ENV = [
  'OPENCODE_EDITOR_SSE_PORT',
  'CLAUDE_CODE_SSE_PORT',
] as const;

/**
 * Replaces inherited editor ports with this workspace's bridge port (or removes
 * both names when the bridge failed to start). Keys are matched
 * case-insensitively so a Windows environment cannot retain a duplicate entry
 * that still points at another editor.
 */
export function withEditorBridgeEnvironment(
  env: Readonly<Record<string, string>>,
  port: number | undefined,
): Record<string, string> {
  const result: Record<string, string> = { ...env };
  const names = new Set(EDITOR_BRIDGE_PORT_ENV.map((name) => name.toLowerCase()));
  for (const key of Object.keys(result)) {
    if (names.has(key.toLowerCase())) {
      delete result[key];
    }
  }
  if (port !== undefined && Number.isSafeInteger(port) && port > 0 && port <= 65535) {
    for (const name of EDITOR_BRIDGE_PORT_ENV) {
      result[name] = String(port);
    }
  }
  return result;
}
