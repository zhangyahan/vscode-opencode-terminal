/**
 * Resolution of the configured PTY working directory.
 *
 * This module has no dependency on `vscode`, so the extension host can inject
 * the configured string and tests can exercise the pure path rules.
 *
 * Rules:
 * - An absent/empty setting falls back to the selected workspace folder.
 * - Only `${workspaceFolder}`, `${workspaceFolderBasename}` and `${userHome}`
 *   are expanded. `${env:...}`, `${command:...}`, `$(...)` and unknown
 *   variables are rejected: this extension never runs a shell to expand a
 *   working directory and never reads environment variables for it.
 * - The result must be an absolute local path. Drive-relative Windows paths
 *   such as `C:work` are ambiguous and rejected, as are control characters.
 */

import * as path from 'node:path';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const VARIABLE_PATTERN = /\$\{([^}]*)\}/g;

export type WorkingDirectoryErrorCode =
  | 'invalid-value'
  | 'invalid-workspace'
  | 'control-character'
  | 'unknown-variable'
  | 'command-substitution'
  | 'drive-relative'
  | 'not-absolute';

export interface WorkingDirectoryInput {
  /** Raw `opencodeTerminal.workingDirectory` value. */
  readonly value: unknown;
  /** Selected VS Code workspace folder path. */
  readonly workspacePath: string;
  /** `os.homedir()` value used only for `${userHome}`. */
  readonly userHome: string;
  /** `process.platform` value; defaults to the host platform. */
  readonly platform?: string;
}

export interface WorkingDirectorySuccess {
  readonly ok: true;
  /**
   * Absolute local path. Empty settings preserve `folder.fsPath`; configured
   * values are normalized with `/` separators.
   */
  readonly path: string;
  /** `workspace` means the configured value was empty. */
  readonly source: 'workspace' | 'configured';
}

export interface WorkingDirectoryFailure {
  readonly ok: false;
  readonly code: WorkingDirectoryErrorCode;
  readonly message: string;
}

export type WorkingDirectoryResult =
  | WorkingDirectorySuccess
  | WorkingDirectoryFailure;

type PathFlavor = 'windows' | 'posix';

/**
 * Workspace mode is defined by VS Code's workspace file (saved or untitled
 * `.code-workspace`) or by having more than one workspace folder. In that mode
 * the extension never guesses a project root as the PTY cwd: the user must
 * choose the real working directory.
 */
export function isWorkspaceMode(
  workspaceFile: unknown,
  folderCount: number,
): boolean {
  return (
    (workspaceFile !== undefined && workspaceFile !== null) || folderCount > 1
  );
}

function failure(
  code: WorkingDirectoryErrorCode,
  message: string,
): WorkingDirectoryFailure {
  return { ok: false, code, message };
}

function isWindowsPlatform(platform: string): boolean {
  return platform.toLowerCase().startsWith('win');
}

function absoluteFlavor(value: string): PathFlavor | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return 'windows';
  }
  if (/^\\\\[^\\/]/.test(value) || /^\/\/[^/]/.test(value)) {
    return 'windows';
  }
  if (value.startsWith('/')) {
    return 'posix';
  }
  return undefined;
}

function stripTrailingSlashes(value: string): string {
  if (
    value === '/' ||
    /^[A-Za-z]:\/$/.test(value) ||
    /^\/\/[^/]+\/[^/]+\/$/.test(value)
  ) {
    return value;
  }
  return value.replace(/\/+$/, '');
}

function normalizeAbsolute(value: string, flavor: PathFlavor): string {
  const normalized =
    flavor === 'windows'
      ? path.win32.normalize(value).replace(/\\/g, '/')
      : path.posix.normalize(value);
  return stripTrailingSlashes(normalized);
}

function basename(
  value: string,
  flavor: PathFlavor,
): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  return flavor === 'windows'
    ? path.win32.basename(trimmed)
    : path.posix.basename(trimmed);
}

/**
 * Resolves the effective PTY working directory without touching the
 * filesystem. The caller must still verify that the result is a real
 * directory before spawning.
 */
export function resolveWorkingDirectory(
  input: WorkingDirectoryInput,
): WorkingDirectoryResult {
  const platform = input.platform ?? process.platform;
  const workspacePath = input.workspacePath;
  if (
    typeof workspacePath !== 'string' ||
    workspacePath.length === 0 ||
    CONTROL_CHARACTERS.test(workspacePath)
  ) {
    return failure(
      'invalid-workspace',
      'The selected workspace folder is not a valid local path.',
    );
  }
  const workspaceFlavor = absoluteFlavor(workspacePath);
  if (workspaceFlavor === undefined) {
    return failure(
      'invalid-workspace',
      'The selected workspace folder must be an absolute path.',
    );
  }

  const configured = input.value;
  if (configured === undefined || configured === null) {
    return {
      ok: true,
      path: workspacePath,
      source: 'workspace',
    };
  }
  if (typeof configured !== 'string') {
    return failure(
      'invalid-value',
      'The working directory setting must be a string.',
    );
  }
  if (configured.trim().length === 0) {
    return {
      ok: true,
      path: workspacePath,
      source: 'workspace',
    };
  }
  if (CONTROL_CHARACTERS.test(configured)) {
    return failure(
      'control-character',
      'The working directory setting contains control characters.',
    );
  }

  let variableFailure: WorkingDirectoryFailure | undefined;
  const expanded = configured.replace(
    VARIABLE_PATTERN,
    (match, expression: string): string => {
      if (variableFailure !== undefined) {
        return match;
      }
      switch (expression) {
        case 'workspaceFolder':
          return normalizeAbsolute(workspacePath, workspaceFlavor);
        case 'workspaceFolderBasename':
          return basename(workspacePath, workspaceFlavor);
        case 'userHome':
          return typeof input.userHome === 'string' ? input.userHome : '';
        default:
          variableFailure = failure(
            'unknown-variable',
            `Unsupported working directory variable "\${${expression}}". ` +
              'Only ${workspaceFolder}, ${workspaceFolderBasename} and ${userHome} are supported.',
          );
          return match;
      }
    },
  );
  if (variableFailure !== undefined) {
    return variableFailure;
  }
  if (/\$\(/.test(expanded)) {
    return failure(
      'command-substitution',
      'Shell command substitution is not supported in the working directory setting.',
    );
  }
  if (/\$env:/i.test(expanded) || expanded.includes('${')) {
    return failure(
      'unknown-variable',
      'The working directory setting contains an unsupported or unexpanded variable.',
    );
  }

  if (WINDOWS_DRIVE_RELATIVE.test(expanded)) {
    return failure(
      'drive-relative',
      'Drive-relative working directories such as "C:work" are ambiguous; use an absolute path.',
    );
  }

  const flavor = absoluteFlavor(expanded);
  if (flavor === undefined) {
    return failure(
      'not-absolute',
      'The working directory must be an absolute local path.',
    );
  }
  if (flavor === 'posix' && isWindowsPlatform(platform) && expanded.startsWith('/')) {
    // `/foo` is not an absolute Windows path. Keep the error explicit instead
    // of silently resolving it against the current drive.
    return failure(
      'not-absolute',
      'The working directory must include a drive letter or UNC share on Windows.',
    );
  }

  const normalized = normalizeAbsolute(expanded, flavor);
  if (normalized.length === 0 || CONTROL_CHARACTERS.test(normalized)) {
    return failure(
      'not-absolute',
      'The working directory does not identify a usable directory.',
    );
  }

  return { ok: true, path: normalized, source: 'configured' };
}
