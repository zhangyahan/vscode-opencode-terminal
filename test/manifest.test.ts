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
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly publisher: string;
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
      readonly icon?: string;
    }[];
    readonly menus?: Readonly<
      Record<
        string,
        readonly {
          readonly command: string;
          readonly when?: string;
        }[]
      >
    >;
    readonly configuration?: {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly type?: string;
            readonly default?: unknown;
            readonly scope?: string;
          }
        >
      >;
    };
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

const NEW_CONTAINER_ID = 'opencodeTerminalBottom';
const MAIN_VIEW_ID = 'opencodeTerminal.main';
const DROP_VIEW_ID = 'opencodeTerminal.drop';

test('manifest places the extension in the bottom panel, not the Secondary Sidebar', () => {
  const containers = manifest.contributes.viewsContainers;
  assert.ok(containers, 'viewsContainers is required');
  assert.deepEqual(Object.keys(containers), ['panel']);
  assert.equal(containers.secondarySidebar, undefined);
  assert.deepEqual(containers.panel, [
    {
      id: NEW_CONTAINER_ID,
      title: 'OpenCode',
      icon: 'media/opencode.svg',
    },
  ]);
});

test('new container keeps both legacy view IDs with drop left and TUI right', () => {
  const views = manifest.contributes.views;
  assert.ok(views, 'views is required');
  assert.deepEqual(Object.keys(views), [NEW_CONTAINER_ID]);

  const contributed = views[NEW_CONTAINER_ID];
  assert.ok(contributed, 'new container must have views');
  assert.deepEqual(
    contributed.map((view) => view.id),
    [DROP_VIEW_ID, MAIN_VIEW_ID],
  );
  assert.equal(contributed[0].type, 'tree');
  assert.equal(contributed[1].type, 'webview');
  assert.deepEqual(
    contributed.map((view) => view.initialSize),
    [1, 99],
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
    'opencodeTerminal.setReferenceBase',
  ]) {
    assert.ok(commandIds.includes(id), `missing command ${id}`);
  }
  const openTitle = (manifest.contributes.commands ?? []).find(
    (command) => command.command === 'opencodeTerminal.open',
  )?.title;
  assert.equal(openTitle, 'OpenCode: 打开面板');

  const activationEvents = manifest.activationEvents ?? [];
  for (const id of [MAIN_VIEW_ID, DROP_VIEW_ID]) {
    assert.ok(
      activationEvents.includes(`onView:${id}`),
      `missing activation event for ${id}`,
    );
  }
});

test('manifest requires VS Code 1.106 or newer', () => {
  assert.equal(manifest.engines.vscode, '^1.106.0');
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.vscode);
  assert.ok(match, 'engines.vscode must be a caret range');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  assert.ok(
    major > 1 || (major === 1 && minor >= 106),
    'the manifest must keep the existing VS Code baseline',
  );
  assert.equal(manifest.devDependencies?.['@types/vscode'], '1.106.0');
});

test('version and packaging target 0.0.14 consistently', () => {
  assert.equal(manifest.version, '0.0.14');
  assert.match(manifest.description, /bottom Panel/i);
  assert.doesNotMatch(manifest.description, /Secondary Sidebar/i);
  assert.equal(lockfile.version, '0.0.14');
  assert.equal(lockfile.packages['']?.version, '0.0.14');
  assert.equal(lockfile.packages['']?.engines?.vscode, '^1.106.0');

  const packageScript = manifest.scripts?.package ?? '';
  assert.match(packageScript, /vscode-opencode-terminal-0\.0\.14-win32-x64\.vsix/);
  assert.doesNotMatch(packageScript, /0\.0\.1[0123]/);
});

test('workingDirectory setting and setReferenceBase command are contributed', () => {
  const properties = manifest.contributes.configuration?.properties;
  const workingDirectory = properties?.['opencodeTerminal.workingDirectory'];
  assert.ok(workingDirectory, 'workingDirectory setting is required');
  assert.equal(workingDirectory.type, 'string');
  assert.equal(workingDirectory.default, '');
  assert.equal(workingDirectory.scope, 'machine-overridable');

  const command = (manifest.contributes.commands ?? []).find(
    (entry) => entry.command === 'opencodeTerminal.setReferenceBase',
  );
  assert.ok(command, 'setReferenceBase command is required');
  assert.equal(command.title, 'OpenCode: 设置引用基准目录（不执行 cd）');
  assert.equal(command.icon, '$(folder)');

  const viewTitle = manifest.contributes.menus?.['view/title'] ?? [];
  assert.ok(
    viewTitle.some(
      (entry) =>
        entry.command === 'opencodeTerminal.setReferenceBase' &&
        (entry.when ?? '').includes('opencodeTerminal.main'),
    ),
    'the command needs a lightweight view/title entry for the main view',
  );
  assert.ok(
    (manifest.activationEvents ?? []).includes(
      'onCommand:opencodeTerminal.setReferenceBase',
    ),
  );
});

test('marketplace display name is unique without changing IDs or view titles', () => {
  assert.equal(manifest.displayName, 'OpenCode Terminal by ZhangYahan');
  assert.notEqual(manifest.displayName, 'OpenCode Terminal');

  assert.equal(manifest.name, 'vscode-opencode-terminal');
  assert.equal(manifest.publisher, 'zhangyahan');
  assert.equal(
    `${manifest.publisher}.${manifest.name}`,
    'zhangyahan.vscode-opencode-terminal',
  );

  const container = manifest.contributes.viewsContainers?.panel?.[0];
  assert.equal(container?.title, 'OpenCode');
  assert.equal(
    manifest.contributes.views?.[NEW_CONTAINER_ID]?.find(
      (view) => view.id === MAIN_VIEW_ID,
    )?.name,
    'OpenCode',
  );

  const readme = readFileSync(resolvePath(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /^# OpenCode Terminal by ZhangYahan$/m);
});

test('marketplace publisher and installation ID target zhangyahan', () => {
  assert.equal(manifest.publisher, 'zhangyahan');

  const readme = readFileSync(resolvePath(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /zhangyahan\.vscode-opencode-terminal/);
  assert.match(
    readme,
    /marketplace\.visualstudio\.com\/items\?itemName=zhangyahan\.vscode-opencode-terminal/,
  );
  assert.doesNotMatch(readme, /只通过 GitHub 分发/);
});
