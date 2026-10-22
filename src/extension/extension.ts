import * as vscode from 'vscode';
import type { AnthropicCredentials } from '../backends/anthropic';
import { validateConfig } from '../core/config';
import { formatUsd } from '../core/ledger';
import { ModelRegistry } from '../core/models';
import { errorMessage, type Logger } from '../core/orchestrator';
import { markdownReport } from '../core/report';
import type { Tier } from '../core/types';
import { DEFAULT_UPSTREAM, Gateway } from '../gateway/server';
import { createRuntime } from '../runtime';
import { setupClaudeCode } from './claudeCode';
import { FusionChatProvider, VENDOR } from './provider';
import { readSettings } from './settings';
import { FusionStatus } from './status';
import { VsCodeLmBackend } from './vscodeBackend';

const SECRET = 'fusion.anthropicApiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Fusion', { log: true });
  const logger: Logger = { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) };
  const version = String(context.extension.packageJSON.version ?? '0.0.0');

  let settings = readSettings();
  let apiKey = await context.secrets.get(SECRET);
  const credentials = (): AnthropicCredentials | undefined => {
    const key = apiKey || process.env.FUSION_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    return key ? { apiKey: key } : undefined;
  };

  const registry = new ModelRegistry();
  const vscodeBackend = new VsCodeLmBackend(registry, logger);
  const { orchestrator } = createRuntime({
    config: () => settings.fusion,
    credentials,
    upstreamURL: settings.baseUrl || DEFAULT_UPSTREAM,
    registry,
    extraBackends: [vscodeBackend],
    log: logger,
  });

  let gateway: Gateway | undefined;
  const status = new FusionStatus(orchestrator, registry, () => ({ apiKey: !!credentials(), gateway: gateway?.address }));

  const needsAnthropic = () => Object.values(settings.fusion.pool).some((id) => registry.get(id)?.provider !== 'vscode');
  const promptForKey = async (): Promise<string | undefined> => {
    const value = await vscode.window.showInputBox({
      title: 'Anthropic API key for Fusion',
      prompt: 'Fusion calls Claude Haiku, Sonnet and Opus with this key. Create one in the Claude Developer Platform; it is kept in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith('sk-ant-') ? undefined : 'Anthropic API keys start with "sk-ant-"'),
    });
    const key = value?.trim();
    if (key) {
      await context.secrets.store(SECRET, key);
      apiKey = key;
    }
    return key;
  };

  const provider = new FusionChatProvider({
    orchestrator,
    registry,
    settings: () => settings,
    ensureCredentials: async () => !!credentials() || !needsAnthropic() || !!(await promptForKey()),
    onProgress: (p) => status.progress(p),
    onTurnEnd: (taskId) => status.turnEnded(taskId),
    log,
    version,
  });
  context.subscriptions.push(log, status, vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

  const startGateway = async (): Promise<string> => {
    if (gateway?.address) return gateway.address;
    const instance = new Gateway({
      orchestrator,
      port: settings.gateway.port,
      upstreamURL: settings.baseUrl || DEFAULT_UPSTREAM,
      defaultCredentials: credentials,
      defaultObjective: () => settings.fusion.objective,
      countTokensModel: () => settings.fusion.pool.balanced,
      log: logger,
    });
    const address = await instance.start();
    gateway = instance;
    log.info(`gateway listening on ${address}`);
    status.update();
    return address;
  };
  const stopGateway = async () => {
    await gateway?.stop();
    gateway = undefined;
    status.update();
  };
  context.subscriptions.push({ dispose: () => void stopGateway() });
  if (settings.gateway.autoStart) {
    startGateway().catch((err) => {
      log.error(`could not start the gateway: ${errorMessage(err)}`);
      vscode.window.showWarningMessage(`Fusion could not start its gateway on port ${settings.gateway.port}: ${errorMessage(err)}`);
    });
  }

  // Models other extensions provide can join the pool as `vscode:<vendor>/<id>`.
  let discovered = '';
  const discover = () =>
    vscodeBackend.discover().then(
      () => {
        const ids = registry
          .all()
          .filter((m) => m.provider === 'vscode')
          .map((m) => m.id)
          .sort()
          .join(',');
        if (ids !== discovered) {
          discovered = ids;
          log.info(`models from other extensions: ${ids || 'none'}`);
          provider.refresh();
        }
      },
      (err) => log.warn(`could not list VS Code models: ${errorMessage(err)}`),
    );
  void discover();
  context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => void discover()));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('fusion')) return;
      const previous = settings;
      settings = readSettings();
      const problems = validateConfig(settings.fusion, registry);
      if (problems.length) vscode.window.showWarningMessage(`Fusion settings: ${problems.join('; ')}`);
      provider.refresh();
      status.update();
      if (gateway && previous.gateway.port !== settings.gateway.port) {
        await stopGateway();
        await startGateway().catch((err) => log.error(`could not restart the gateway: ${errorMessage(err)}`));
      }
      if (previous.baseUrl !== settings.baseUrl) {
        const reload = await vscode.window.showInformationMessage('Reload the window to use the new Anthropic base URL.', 'Reload');
        if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
    context.secrets.onDidChange(async (e) => {
      if (e.key !== SECRET) return;
      apiKey = await context.secrets.get(SECRET);
      provider.refresh();
      status.update();
    }),
  );

  const commands: Record<string, () => unknown> = {
    'fusion.setApiKey': async () => {
      if (await promptForKey()) vscode.window.showInformationMessage('Fusion: API key saved. Pick "Fusion (multi model)" in the chat model picker.');
    },
    'fusion.clearApiKey': async () => {
      await context.secrets.delete(SECRET);
      apiKey = undefined;
      vscode.window.showInformationMessage('Fusion: API key removed.');
    },
    'fusion.showLog': () => log.show(),
    'fusion.showLastTask': async () => {
      const task = orchestrator.ledger.latest();
      if (!task) {
        vscode.window.showInformationMessage('Fusion has not run a task in this window yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdownReport(task, registry) });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    },
    'fusion.configureModels': async () => {
      const slot = await vscode.window.showQuickPick(
        [
          { label: 'fast', description: settings.fusion.pool.fast, detail: 'Routing, trivial tasks and first drafts' },
          { label: 'balanced', description: settings.fusion.pool.balanced, detail: 'Medium tasks, gate checks, reviews' },
          { label: 'frontier', description: settings.fusion.pool.frontier, detail: 'Hard tasks and escalations' },
          { label: 'critic', description: settings.fusion.critique.model || '(policy default)', detail: 'Reviewer for the critique pattern; another model family gives the most independent review' },
        ],
        { title: 'Fusion: which slot?' },
      );
      if (!slot) return;
      await discover();
      const items = registry.all().map((m) => ({
        label: m.label,
        description: m.id,
        detail: m.pricing ? `$${m.pricing.input} / $${m.pricing.output} per MTok · ${m.family}` : `${m.family} · billed by its provider`,
        id: m.id,
      }));
      if (slot.label === 'critic') items.unshift({ label: '(policy default)', description: '', detail: 'Use the tier model the policy picks', id: '' });
      const model = await vscode.window.showQuickPick(items, { title: `Fusion: model for the ${slot.label} slot`, matchOnDescription: true });
      if (!model) return;
      const key = slot.label === 'critic' ? 'models.critic' : `models.${slot.label as Tier}`;
      await vscode.workspace.getConfiguration('fusion').update(key, model.id, vscode.ConfigurationTarget.Global);
    },
    'fusion.startGateway': async () => {
      try {
        const address = await startGateway();
        vscode.window.showInformationMessage(`Fusion gateway running at ${address}. Point Claude Code at it with "Fusion: Use Fusion in Claude Code…".`);
      } catch (err) {
        vscode.window.showErrorMessage(`Fusion could not start its gateway: ${errorMessage(err)}`);
      }
    },
    'fusion.stopGateway': async () => {
      await stopGateway();
      vscode.window.showInformationMessage('Fusion gateway stopped.');
    },
    'fusion.setupClaudeCode': async () => {
      try {
        await setupClaudeCode(settings.gateway.port, startGateway);
      } catch (err) {
        vscode.window.showErrorMessage(`Fusion: ${errorMessage(err)}`);
      }
    },
    'fusion.menu': async () => {
      const session = orchestrator.ledger.session;
      const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: '$(graph) Show last workflow', description: orchestrator.ledger.latest()?.plan?.pattern ?? '', command: 'fusion.showLastTask' },
        { label: '$(key) Set Anthropic API key', description: credentials() ? 'set' : 'not set', command: 'fusion.setApiKey' },
        { label: '$(layers) Choose models for each tier', command: 'fusion.configureModels' },
        gateway?.address
          ? { label: '$(debug-stop) Stop gateway', description: gateway.address, command: 'fusion.stopGateway' }
          : { label: '$(plug) Start gateway', description: `port ${settings.gateway.port}`, command: 'fusion.startGateway' },
        { label: '$(terminal) Use Fusion in Claude Code…', command: 'fusion.setupClaudeCode' },
        { label: '$(gear) Settings', command: 'fusion.openSettings' },
        { label: '$(output) Show log', command: 'fusion.showLog' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `Fusion — ${session.tasks} task(s), ${formatUsd(session.costUsd)} estimated this session`,
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    },
    'fusion.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:kylesau.fusion'),
  };
  for (const [id, run] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, run));

  if (!credentials() && !context.globalState.get('fusion.welcomed')) {
    void context.globalState.update('fusion.welcomed', true);
    void vscode.window
      .showInformationMessage('Fusion adds "Fusion (multi model)" to the chat model picker. It calls Claude with your Anthropic API key.', 'Set API Key')
      .then((pick) => pick && vscode.commands.executeCommand('fusion.setApiKey'));
  }
  log.info(`Fusion ${version} ready (objective ${settings.fusion.objective}; pool ${Object.values(settings.fusion.pool).join(', ')})`);
}

export function deactivate(): void {}
