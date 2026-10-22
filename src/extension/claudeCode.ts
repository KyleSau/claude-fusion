import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

/** Environment that makes Claude Code talk to the Fusion gateway and list "Fusion (multi model)" in its model picker. */
export function claudeCodeEnv(port: number): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'fusion',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Fusion (multi model)',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Routes each task across Haiku, Sonnet and Opus',
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
  };
}

const KEYS = Object.keys(claudeCodeEnv(0));
export const CLAUDE_CODE_ENV_SETTING = 'claudeCode.environmentVariables';
const SETTING = CLAUDE_CODE_ENV_SETTING;

/** Whether Claude Code in VS Code is set to send its requests to this gateway (so it must be running). */
export function claudeCodeUsesGateway(port: number): boolean {
  const entries = vscode.workspace.getConfiguration().get<EnvEntry[]>(SETTING) ?? [];
  return entries.some((e) => e.name === 'ANTHROPIC_BASE_URL' && e.value.replace(/\/+$/, '') === claudeCodeEnv(port).ANTHROPIC_BASE_URL);
}
const settingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');

type EnvEntry = { name: string; value: string };

type Target = 'vscode' | 'global' | 'copy' | 'remove';

export async function setupClaudeCode(port: number, startGateway: () => Promise<string>): Promise<void> {
  const env = claudeCodeEnv(port);
  const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { target: Target }>(
    [
      {
        label: '$(vscode) Claude Code in VS Code',
        description: 'recommended',
        detail: 'Adds the variables to the claudeCode.environmentVariables setting. Only Claude Code started from VS Code uses Fusion, and the gateway runs inside VS Code.',
        target: 'vscode',
      },
      {
        label: '$(terminal) Every Claude Code session',
        detail: 'Adds an env block to ~/.claude/settings.json (backed up first). Claude Code in a terminal then needs the gateway running too: keep VS Code open, or run `fusion gateway`.',
        target: 'global',
      },
      { label: '$(clippy) Copy the settings', detail: 'Copy the env block and add it yourself.', target: 'copy' },
      { label: '$(trash) Remove Fusion from Claude Code', detail: 'Undo either of the above.', target: 'remove' },
    ],
    { title: 'Use Fusion in Claude Code', placeHolder: 'Where should Claude Code pick up Fusion?' },
  );
  if (!picked) return;

  switch (picked.target) {
    case 'copy':
      await vscode.env.clipboard.writeText(JSON.stringify({ env }, null, 2));
      vscode.window.showInformationMessage('Copied. Add it to ~/.claude/settings.json, then start the gateway with "Fusion: Start Gateway" or `fusion gateway`.');
      return;
    case 'remove':
      await removeFromVsCode(port);
      await removeFromSettingsFile(port);
      vscode.window.showInformationMessage('Fusion was removed from Claude Code. Start a new Claude Code session for it to take effect.');
      return;
    case 'vscode': {
      const config = vscode.workspace.getConfiguration();
      const current = (config.get<EnvEntry[]>(SETTING) ?? []).filter((e) => !KEYS.includes(e.name));
      await config.update(SETTING, [...current, ...Object.entries(env).map(([name, value]) => ({ name, value }))], vscode.ConfigurationTarget.Global);
      break;
    }
    case 'global': {
      const file = settingsFile();
      const ok = await vscode.window.showWarningMessage(
        `Add Fusion to ${file}?`,
        {
          modal: true,
          detail: `Every Claude Code session will send its requests through http://127.0.0.1:${port}. If the gateway is not running, Claude Code cannot connect until you remove these entries (run this command again and choose Remove). A backup is saved next to the file.`,
        },
        'Add',
      );
      if (ok !== 'Add') return;
      const data = await readSettingsFile(file);
      if (!data) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (data.raw !== undefined) await fs.writeFile(`${file}.fusion-backup`, data.raw);
      const json = data.json;
      json.env = { ...(json.env ?? {}), ...env };
      await fs.writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
      break;
    }
  }

  await vscode.workspace.getConfiguration('fusion').update('gateway.autoStart', true, vscode.ConfigurationTarget.Global);
  const address = await startGateway();
  vscode.window.showInformationMessage(
    `Fusion is ready for Claude Code (gateway ${address}). Start a new Claude Code session and choose "Fusion (multi model)" in the model menu, or run /model fusion.`,
  );
}

async function readSettingsFile(file: string): Promise<{ raw?: string; json: Record<string, any> } | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { json: {} };
  }
  try {
    const json = raw.trim() ? JSON.parse(raw) : {};
    return { raw, json };
  } catch {
    vscode.window.showErrorMessage(`${file} is not valid JSON, so Fusion left it untouched. Use "Copy the settings" instead.`);
    return undefined;
  }
}

async function removeFromVsCode(port: number): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<EnvEntry[]>(SETTING) ?? [];
  const ours = claudeCodeEnv(port);
  const kept = current.filter((e) => !(KEYS.includes(e.name) && (e.name !== 'ANTHROPIC_BASE_URL' || e.value === ours.ANTHROPIC_BASE_URL)));
  if (kept.length !== current.length) await config.update(SETTING, kept, vscode.ConfigurationTarget.Global);
}

async function removeFromSettingsFile(port: number): Promise<void> {
  const file = settingsFile();
  const data = await readSettingsFile(file);
  if (!data?.raw || !data.json.env) return;
  const ours = claudeCodeEnv(port);
  let changed = false;
  for (const key of KEYS) {
    if (key in data.json.env && (key !== 'ANTHROPIC_BASE_URL' || data.json.env[key] === ours.ANTHROPIC_BASE_URL)) {
      delete data.json.env[key];
      changed = true;
    }
  }
  if (!changed) return;
  if (!Object.keys(data.json.env).length) delete data.json.env;
  await fs.writeFile(`${file}.fusion-backup`, data.raw);
  await fs.writeFile(file, `${JSON.stringify(data.json, null, 2)}\n`);
}
