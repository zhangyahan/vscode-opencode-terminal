/**
 * Pure resolution of VS Code terminal profiles for an embedded node-pty shell.
 *
 * The module deliberately has no dependency on `vscode` or `node-pty`. The
 * runtime supplies a snapshot of the relevant VS Code settings, an injected
 * `fileExists` probe and an already-resolved default shell (`vscode.env.shell`).
 *
 * Resolution order for the executable:
 *  1. Explicit profile `path` candidates (first candidate that exists / resolves
 *     on PATH wins).
 *  2. A profile managed by `source` (for example VS Code's auto-detected
 *     PowerShell or Git Bash profile): use `vscode.env.shell`, because VS Code
 *     already detected the real path. Never guess that "PowerShell" means the
 *     old Windows PowerShell.
 *  3. `vscode.env.shell` when no explicit profile is selected.
 *  4. `ComSpec` on Windows or `/bin/sh` on POSIX, with a warning.
 *
 * The working directory is always the workspace folder. Environment values are
 * merged base -> integrated -> profile, support `null` deletion, Windows
 * case-insensitive keys and `${env:...}`, `${userHome}`, `${workspaceFolder}`
 * and related variables. Warning messages never contain environment values.
 */

import * as path from 'node:path';

export type ShellPlatform = 'windows' | 'posix';

export interface ShellProfile {
  readonly path?: string | readonly string[];
  readonly args?: string | readonly string[];
  readonly env?: Readonly<Record<string, string | null | undefined>>;
  /**
   * VS Code's profile source, e.g. "PowerShell" or "Git Bash". Such profiles
   * have no explicit path; `vscode.env.shell` is the detected executable.
   */
  readonly source?: string;
}

export interface ShellProfileSnapshot {
  /** `process.platform` value or `windows`/`posix`. */
  readonly platform: string;
  /** Value of `terminal.integrated.defaultProfile.<platform>`, if set. */
  readonly defaultProfile?: string;
  /** `terminal.integrated.profiles.<platform>`. */
  readonly profiles?: Readonly<Record<string, ShellProfile>>;
  /** `vscode.env.shell`: the default shell path detected by VS Code. */
  readonly envShell?: string;
  /** Host process environment. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** `terminal.integrated.env.<platform>`. */
  readonly integratedEnv?: Readonly<Record<string, string | null | undefined>>;
  /** Absolute workspace folder used as `cwd`. */
  readonly workspacePath: string;
  /** User home directory used by `${userHome}`. */
  readonly home: string;
  /** Injected existence probe (normally `fs.existsSync`). */
  readonly fileExists: (candidate: string) => boolean;
}

export type ShellProfileWarningCode =
  | 'profile-path-missing'
  | 'profile-source-fallback'
  | 'profile-unsupported'
  | 'args-rejected'
  | 'shell-fallback'
  | 'env-variable-unresolved'
  | 'unknown-variable'
  | 'invalid-profile';

export interface ShellProfileWarning {
  readonly code: ShellProfileWarningCode;
  /** Never contains environment values. */
  readonly message: string;
  readonly profileName?: string;
}

export interface ShellLaunchConfig {
  readonly ok: true;
  readonly shellPath: string;
  /** A string is kept as-is for node-pty on Windows. */
  readonly args: string[] | string;
  readonly env: Record<string, string>;
  /** Always `workspacePath`. */
  readonly cwd: string;
  readonly warnings: ShellProfileWarning[];
  readonly profileName?: string;
}

export type ShellProfileErrorCode =
  | 'invalid-workspace'
  | 'missing-shell'
  | 'unsupported-profile'
  | 'unsupported-args';

export interface ShellProfileFailure {
  readonly ok: false;
  readonly code: ShellProfileErrorCode;
  readonly message: string;
  readonly warnings: ShellProfileWarning[];
}

export type ShellProfileResult = ShellLaunchConfig | ShellProfileFailure;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Electron/extension-host markers that must not be inherited by a shell. In
 * particular `ELECTRON_RUN_AS_NODE` turns the shell executable into a Node
 * process instead of a terminal.
 */
const HOST_ONLY_ENV = new Set([
  'electron_run_as_node',
  'electron_no_attach_console',
  'electron_enable_logging',
  'electron_enable_stack_dumping',
  'electron_default_error_mode',
  'electron_crash_dump',
]);

function warning(
  code: ShellProfileWarningCode,
  message: string,
  profileName?: string,
): ShellProfileWarning {
  return profileName === undefined ? { code, message } : { code, message, profileName };
}

function isWindows(platform: string): boolean {
  return platform.toLowerCase().startsWith('win');
}

function platformKind(platform: string): ShellPlatform {
  return isWindows(platform) ? 'windows' : 'posix';
}

function pathModule(platform: ShellPlatform): typeof path.win32 | typeof path.posix {
  return platform === 'windows' ? path.win32 : path.posix;
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/** Minimal ordered env map with Windows case-insensitive keys. */
class EnvBuilder {
  private readonly values = new Map<string, string>();

  constructor(private readonly windows: boolean) {}

  set(key: string, value: string): void {
    if (key.length === 0 || key.includes('=') || key.includes('\u0000')) {
      return;
    }
    if (this.windows) {
      const existing = this.findKey(key);
      this.values.set(existing ?? key, value);
      return;
    }
    this.values.set(key, value);
  }

  delete(key: string): void {
    const existing = this.windows ? this.findKey(key) : key;
    if (existing !== undefined) {
      this.values.delete(existing);
    }
  }

  get(key: string): string | undefined {
    return this.values.get(this.windows ? this.findKey(key) ?? key : key);
  }

  removeHostOnly(): void {
    for (const key of [...this.values.keys()]) {
      const normalized = (this.windows ? key.toLowerCase() : key).toLowerCase();
      // Remove the known Electron switches and any future ELECTRON_* marker;
      // inheriting them can turn the shell executable into a Node process.
      if (HOST_ONLY_ENV.has(normalized) || normalized.startsWith('electron_')) {
        this.values.delete(key);
      }
    }
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  private findKey(key: string): string | undefined {
    const lower = key.toLowerCase();
    for (const existing of this.values.keys()) {
      if (existing.toLowerCase() === lower) {
        return existing;
      }
    }
    return undefined;
  }
}

interface ExpansionContext {
  readonly env: EnvBuilder;
  readonly home: string;
  readonly workspacePath: string;
  readonly platform: ShellPlatform;
  readonly warnings: ShellProfileWarning[];
  readonly profileName?: string;
}

function workspaceBasename(workspacePath: string, platform: ShellPlatform): string {
  const clean = workspacePath.replace(/[\\/]+$/, '');
  return pathModule(platform).basename(clean);
}

/**
 * Expands the VS Code-style variables supported by integrated terminal
 * profiles. Unknown variables are preserved verbatim and reported; missing
 * `${env:NAME}` values become empty (as VS Code does) and are reported by name
 * only, never by value.
 */
function expandVariables(value: string, context: ExpansionContext): string {
  return value.replace(/\$\{([^}]*)\}/g, (match, expression: string) => {
    if (expression.startsWith('env:')) {
      const rest = expression.slice(4);
      const separator = rest.indexOf(':');
      const name = separator === -1 ? rest : rest.slice(0, separator);
      const fallback = separator === -1 ? undefined : rest.slice(separator + 1);
      const resolved = name.length === 0 ? undefined : context.env.get(name);
      if (resolved !== undefined) {
        return resolved;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      context.warnings.push(
        warning(
          'env-variable-unresolved',
          `Environment variable "${name}" referenced by a shell profile is not defined; it was replaced with an empty string.`,
          context.profileName,
        ),
      );
      return '';
    }

    switch (expression) {
      case 'userHome':
        return context.home;
      case 'workspaceFolder':
      case 'cwd':
        return context.workspacePath;
      case 'workspaceFolderBasename':
        return workspaceBasename(context.workspacePath, context.platform);
      case 'pathSeparator':
        return context.platform === 'windows' ? ';' : ':';
      default:
        context.warnings.push(
          warning(
            'unknown-variable',
            `Unsupported variable "\${${expression}}" in a shell profile was left unchanged.`,
            context.profileName,
          ),
        );
        return match;
    }
  });
}

function expandHome(value: string, home: string, platform: ShellPlatform): string {
  if (home.length === 0) {
    return value;
  }
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return pathModule(platform).join(home, value.slice(2));
  }
  return value;
}

interface EnvLayer {
  readonly values: Readonly<Record<string, string | null | undefined>> | undefined;
  readonly label: 'integrated' | 'profile';
}

function buildEnvironment(
  snapshot: ShellProfileSnapshot,
  profile: ShellProfile | undefined,
  platform: ShellPlatform,
  warnings: ShellProfileWarning[],
  profileName?: string,
): EnvBuilder {
  const env = new EnvBuilder(platform === 'windows');
  const base = snapshot.baseEnv ?? {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      env.set(key, value);
    }
  }

  const context: ExpansionContext = {
    env,
    home: typeof snapshot.home === 'string' ? snapshot.home : '',
    workspacePath: snapshot.workspacePath,
    platform,
    warnings,
    ...(profileName === undefined ? {} : { profileName }),
  };

  const layers: EnvLayer[] = [
    { values: snapshot.integratedEnv, label: 'integrated' },
    { values: profile?.env, label: 'profile' },
  ];

  for (const layer of layers) {
    if (layer.values === undefined || layer.values === null) {
      continue;
    }
    for (const [key, raw] of Object.entries(layer.values)) {
      if (raw === null) {
        env.delete(key);
        continue;
      }
      if (typeof raw !== 'string') {
        warnings.push(
          warning(
            'invalid-profile',
            `Environment entry "${key}" in ${layer.label} settings is not a string or null and was ignored.`,
            profileName,
          ),
        );
        continue;
      }
      env.set(key, expandVariables(raw, context));
    }
  }

  env.removeHostOnly();
  return env;
}

function candidateValues(
  value: string | readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return value.length === 0 ? [] : [value];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const candidates: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    if (entry.length > 0) {
      candidates.push(entry);
    }
  }
  return candidates;
}

function pathEntries(env: EnvBuilder, platform: ShellPlatform): string[] {
  const value = env.get('PATH');
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value
    .split(platform === 'windows' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

function executableExtensions(env: EnvBuilder, platform: ShellPlatform): string[] {
  if (platform !== 'windows') {
    return [''];
  }
  const pathExt = env.get('PATHEXT');
  if (pathExt !== undefined && pathExt.length > 0) {
    return ['', ...pathExt.split(';').filter((entry) => entry.length > 0)];
  }
  return ['', '.exe', '.cmd', '.bat', '.com'];
}

/**
 * Resolves a bare command name through the merged PATH using the injected
 * existence probe. This is also used for profile `path` entries that VS Code
 * treats as command names rather than absolute files.
 */
function findOnPath(
  command: string,
  env: EnvBuilder,
  platform: ShellPlatform,
  fileExists: (candidate: string) => boolean,
): string | undefined {
  const pathApi = pathModule(platform);
  const extensions = executableExtensions(env, platform);
  for (const directory of pathEntries(env, platform)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${command}${extension}`);
      if (safeExists(fileExists, candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function safeExists(
  fileExists: (candidate: string) => boolean,
  candidate: string,
): boolean {
  try {
    return fileExists(candidate);
  } catch {
    return false;
  }
}

function resolveProfilePath(
  candidate: string,
  env: EnvBuilder,
  platform: ShellPlatform,
  fileExists: (candidate: string) => boolean,
): string | undefined {
  const pathApi = pathModule(platform);
  if (pathApi.isAbsolute(candidate)) {
    if (safeExists(fileExists, candidate)) {
      return candidate;
    }
    const normalized = pathApi.normalize(candidate);
    if (normalized !== candidate && safeExists(fileExists, normalized)) {
      return normalized;
    }
    return undefined;
  }

  // A relative path with a separator would be relative to an unknown working
  // directory. Do not guess: only bare command names are resolved via PATH.
  if (candidate.includes('/') || candidate.includes('\\')) {
    return undefined;
  }
  return findOnPath(candidate, env, platform, fileExists);
}

function usableShell(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  if (hasControlCharacters(value)) {
    return undefined;
  }
  return value;
}

function resolveArgs(
  profile: ShellProfile | undefined,
  platform: ShellPlatform,
  context: ExpansionContext,
): { readonly ok: true; readonly args: string[] | string } | { readonly ok: false; readonly message: string } {
  const raw = profile?.args;
  if (raw === undefined) {
    return { ok: true, args: [] };
  }

  if (typeof raw === 'string') {
    if (platform === 'posix') {
      return {
        ok: false,
        message:
          'This profile supplies a single argument string on a POSIX platform. ' +
          'This backend cannot split it without guessing shell quoting rules, so the profile is rejected. ' +
          'Use an argument array in the profile settings.',
      };
    }
    return { ok: true, args: expandVariables(raw, context) };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, message: 'Shell profile args must be a string or an array of strings.' };
  }

  const args: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, message: 'Shell profile args must contain only strings.' };
    }
    args.push(expandVariables(entry, context));
  }
  return { ok: true, args };
}

function failed(
  code: ShellProfileErrorCode,
  message: string,
  warnings: ShellProfileWarning[],
): ShellProfileFailure {
  return { ok: false, code, message, warnings };
}

/**
 * Resolves a VS Code terminal profile snapshot into concrete node-pty launch
 * options. The result is a tagged union: an explicit but unsupported profile
 * fails instead of silently launching a different shell.
 */
export function resolveShellProfile(snapshot: ShellProfileSnapshot): ShellProfileResult {
  const warnings: ShellProfileWarning[] = [];

  if (
    typeof snapshot.workspacePath !== 'string' ||
    snapshot.workspacePath.length === 0 ||
    hasControlCharacters(snapshot.workspacePath)
  ) {
    return failed(
      'invalid-workspace',
      'A non-empty workspace path without control characters is required.',
      warnings,
    );
  }

  const platform = platformKind(snapshot.platform);

  const defaultProfile =
    typeof snapshot.defaultProfile === 'string' && snapshot.defaultProfile.length > 0
      ? snapshot.defaultProfile
      : undefined;
  const profile =
    defaultProfile === undefined ? undefined : snapshot.profiles?.[defaultProfile];
  const hasExplicitProfile = defaultProfile !== undefined;
  const profileName = defaultProfile;

  if (hasExplicitProfile && profile === undefined) {
    // VS Code reports auto-detected profiles (for example "PowerShell") by name
    // even when they are not present in the user's `profiles` object. Their
    // executable is the shell VS Code detected.
    const envShell = usableShell(snapshot.envShell);
    if (envShell === undefined) {
      warnings.push(
        warning(
          'profile-unsupported',
          `Profile "${defaultProfile}" has no explicit path and VS Code did not provide a detected shell path. ` +
            'This backend will not guess an executable (for example it will not assume PowerShell means Windows PowerShell).',
          defaultProfile,
        ),
      );
      return failed(
        'unsupported-profile',
        `Profile "${defaultProfile}" cannot be resolved without an explicit path or a detected default shell.`,
        warnings,
      );
    }
    warnings.push(
      warning(
        'profile-source-fallback',
        `Profile "${defaultProfile}" is managed by VS Code; the detected default shell from vscode.env.shell is used.`,
        defaultProfile,
      ),
    );
    const env = buildEnvironment(snapshot, undefined, platform, warnings, defaultProfile);
    const context: ExpansionContext = {
      env,
      home: typeof snapshot.home === 'string' ? snapshot.home : '',
      workspacePath: snapshot.workspacePath,
      platform,
      warnings,
      profileName: defaultProfile,
    };
    const args = resolveArgs(undefined, platform, context);
    if (!args.ok) {
      warnings.push(warning('args-rejected', args.message, defaultProfile));
      return failed('unsupported-args', args.message, warnings);
    }
    return {
      ok: true,
      shellPath: envShell,
      args: args.args,
      env: env.toRecord(),
      cwd: snapshot.workspacePath,
      warnings,
      profileName: defaultProfile,
    };
  }

  const env = buildEnvironment(snapshot, profile, platform, warnings, profileName);
  const context: ExpansionContext = {
    env,
    home: typeof snapshot.home === 'string' ? snapshot.home : '',
    workspacePath: snapshot.workspacePath,
    platform,
    warnings,
    ...(profileName === undefined ? {} : { profileName }),
  };

  const args = resolveArgs(profile, platform, context);
  if (!args.ok) {
    warnings.push(warning('args-rejected', args.message, profileName));
    return failed('unsupported-args', args.message, warnings);
  }

  let shellPath: string | undefined;

  if (profile !== undefined) {
    const candidates = candidateValues(profile.path);
    if (candidates === undefined) {
      warnings.push(
        warning(
          'invalid-profile',
          `Profile "${profileName ?? ''}" path must be a string or an array of strings.`,
          profileName,
        ),
      );
      return failed('unsupported-profile', 'The selected profile has an invalid path setting.', warnings);
    }

    for (const rawCandidate of candidates) {
      const expanded = expandHome(
        expandVariables(rawCandidate, context),
        context.home,
        platform,
      );
      if (expanded.length === 0 || hasControlCharacters(expanded)) {
        continue;
      }
      shellPath = resolveProfilePath(expanded, env, platform, snapshot.fileExists);
      if (shellPath !== undefined) {
        break;
      }
    }

    if (shellPath === undefined && candidates.length > 0) {
      warnings.push(
        warning(
          'profile-path-missing',
          `None of the ${candidates.length} path candidate(s) for profile "${profileName ?? ''}" exists or resolves on PATH.`,
          profileName,
        ),
      );
      return failed(
        'unsupported-profile',
        `Profile "${profileName ?? ''}" has no usable executable path.`,
        warnings,
      );
    }

    if (shellPath === undefined) {
      const envShell = usableShell(snapshot.envShell);
      if (envShell === undefined) {
        warnings.push(
          warning(
            'profile-unsupported',
            `Profile "${profileName ?? ''}" has no path and VS Code did not provide a detected shell path. ` +
              'This backend will not guess an executable (for example it will not assume PowerShell means Windows PowerShell).',
            profileName,
          ),
        );
        return failed(
          'unsupported-profile',
          `Profile "${profileName ?? ''}" cannot be resolved without an explicit path or a detected default shell.`,
          warnings,
        );
      }
      warnings.push(
        warning(
          'profile-source-fallback',
          `Profile "${profileName ?? ''}" has no explicit path; the shell detected by VS Code is used.`,
          profileName,
        ),
      );
      shellPath = envShell;
    }
  } else {
    // No explicit profile: prefer the shell VS Code detected.
    shellPath = usableShell(snapshot.envShell);
    if (shellPath === undefined) {
      if (platform === 'windows') {
        const comSpec = env.get('ComSpec');
        if (comSpec !== undefined && usableShell(comSpec) !== undefined) {
          shellPath = comSpec;
          warnings.push(
            warning(
              'shell-fallback',
              'No shell profile or detected shell is available; ComSpec is used as the fallback shell.',
            ),
          );
        }
      } else {
        shellPath = '/bin/sh';
        warnings.push(
          warning(
            'shell-fallback',
            'No shell profile or detected shell is available; /bin/sh is used as the fallback shell.',
          ),
        );
      }
    }
  }

  if (shellPath === undefined) {
    warnings.push(
      warning(
        'shell-fallback',
        'No shell profile, detected shell or platform fallback is available.',
      ),
    );
    return failed(
      'missing-shell',
      'Unable to determine a shell executable from the terminal profile, vscode.env.shell or the platform fallback.',
      warnings,
    );
  }

  return {
    ok: true,
    shellPath,
    args: args.args,
    env: env.toRecord(),
    cwd: snapshot.workspacePath,
    warnings,
    ...(profileName === undefined ? {} : { profileName }),
  };
}
