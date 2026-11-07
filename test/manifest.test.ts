import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

interface ViewContainerContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
}

interface ViewContribution {
  readonly id: string;
  readonly type?: string;
  readonly name?: string;
  readonly initialSize?: number;
}

interface Manifest {
  readonly version: string;
  readonly description: string;
  readonly engines: {
    readonly vscode: string;
  };
  readonly contributes: {
    readonly viewsContainers?: Readonly<
      Record<string, readonly ViewContainerContribution[]>
    >;
    readonly views?: Readonly<Record<string, readonly ViewContribution[]>>;
    readonly commands?: readonly {
      readonly command: string;
      readonly title: string;
    }[];
  };
  readonly activationEvents?: readonly string[];
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface Lockfile {
  readonly version: string;
  readonly packages: Readonly<
    Record<
      string,
      {
        readonly version?: string;
        readonly engines?: {
          readonly vscode?: string;
        };
      }
    >
  >;
}

const projectRoot = resolvePath(__dirname, '..', '..');
const manifest = JSON.parse(
  readFileSync(resolvePath(projectRoot, 'package.json'), 'utf8'),
) as Manifest;
const lockfile = JSON.parse(
  readFileSync(resolvePath(projectRoot, 'package-lock.json'), 'utf8'),
) as Lockfile;

const NEW_CONTAINER_ID = 'opencodeTerminalSecondary';
const MAIN_VIEW_ID = 'opencodeTerminal.main';
const DROP_VIEW_ID = 'opencodeTerminal.drop';

test('manifest places the extension in the Secondary Sidebar, not the panel', () => {
  const containers = manifest.contributes.viewsContainers;
  assert.ok(containers, 'viewsContainers is required');
  assert.deepEqual(Object.keys(containers), ['secondarySidebar']);
  assert.equal(containers.panel, undefined);
  assert.deepEqual(containers.secondarySidebar, [
    {
      id: NEW_CONTAINER_ID,
      title: 'OpenCode',
      icon: 'media/opencode.svg',
    },
  ]);
});

test('new container keeps both legacy view IDs in TUI-then-drop order', () => {
  const views = manifest.contributes.views;
  assert.ok(views, 'views is required');
  assert.deepEqual(Object.keys(views), [NEW_CONTAINER_ID]);

  const contributed = views[NEW_CONTAINER_ID];
  assert.ok(contributed, 'new container must have views');
  assert.deepEqual(
    contributed.map((view) => view.id),
    [MAIN_VIEW_ID, DROP_VIEW_ID],
  );
  assert.equal(contributed[0].type, 'webview');
  assert.equal(contributed[1].type, 'tree');
  assert.deepEqual(
    contributed.map((view) => view.initialSize),
    [90, 10],
  );
});

test('manifest retains command and activation IDs used by extension code', () => {
  const commandIds = (manifest.contributes.commands ?? []).map(
    (command) => command.command,
  );
  for (const id of [
    'opencodeTerminal.open',
    'opencodeTerminal.start',
    'opencodeTerminal.focusTerminal',
    'opencodeTerminal.addSelection',
    'opencodeTerminal.addFile',
    'opencodeTerminal.pickFiles',
    'opencodeTerminal.copyAll',
    'opencodeTerminal.clear',
  ]) {
    assert.ok(commandIds.includes(id), `missing command ${id}`);
  }
  const openTitle = (manifest.contributes.commands ?? []).find(
    (command) => command.command === 'opencodeTerminal.open',
  )?.title;
  assert.equal(openTitle, 'OpenCode: 打开侧栏');

  const activationEvents = manifest.activationEvents ?? [];
  for (const id of [MAIN_VIEW_ID, DROP_VIEW_ID]) {
    assert.ok(
      activationEvents.includes(`onView:${id}`),
      `missing activation event for ${id}`,
    );
  }
});

test('manifest requires VS Code 1.106 or newer for secondarySidebar', () => {
  assert.equal(manifest.engines.vscode, '^1.106.0');
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.vscode);
  assert.ok(match, 'engines.vscode must be a caret range');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  assert.ok(
    major > 1 || (major === 1 && minor >= 106),
    'secondarySidebar requires VS Code >= 1.106',
  );
  assert.equal(manifest.devDependencies?.['@types/vscode'], '1.106.0');
});

test('version and packaging target 0.0.8 consistently', () => {
  assert.equal(manifest.version, '0.0.8');
  assert.match(manifest.description, /Secondary Sidebar/);
  assert.equal(lockfile.version, '0.0.8');
  assert.equal(lockfile.packages['']?.version, '0.0.8');
  assert.equal(lockfile.packages['']?.engines?.vscode, '^1.106.0');

  const packageScript = manifest.scripts?.package ?? '';
  assert.match(packageScript, /vscode-opencode-terminal-0\.0\.8-win32-x64\.vsix/);
  assert.doesNotMatch(packageScript, /0\.0\.7/);
});
