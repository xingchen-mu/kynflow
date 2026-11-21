import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AgentExtension } from '../../shared/types.ts';
import { config } from '../config.ts';

const home = homedir();
const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
export const MCP_URL = `http://${host}:${config.port}/mcp`;

const connectJson = JSON.stringify({ mcpServers: { infinode: { type: 'http', url: MCP_URL } } }, null, 2);

interface Client {
  id: string;
  bin: string;
  install: string;
  connect: string;
  connectKind: 'command' | 'json';
  /** Where the client keeps its MCP servers, most specific first. */
  configs: string[];
  configPath: string;
  /** Desktop apps have no CLI on PATH; these paths tell they are installed. */
  apps?: string[];
}

const CLIENTS: Client[] = [
  {
    id: 'claude',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    connect: `claude mcp add --transport http infinode ${MCP_URL}`,
    connectKind: 'command',
    configs: [join(home, '.claude.json'), join(config.appRoot, '.mcp.json')],
    configPath: '~/.claude.json',
  },
  {
    id: 'codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    connect: `codex mcp add infinode --url ${MCP_URL}`,
    connectKind: 'command',
    configs: [join(home, '.codex', 'config.toml')],
    configPath: '~/.codex/config.toml',
  },
  {
    id: 'gemini',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    connect: `gemini mcp add --transport http infinode ${MCP_URL}`,
    connectKind: 'command',
    configs: [join(home, '.gemini', 'settings.json')],
    configPath: '~/.gemini/settings.json',
  },
  {
    id: 'cursor',
    bin: 'cursor',
    install: '',
    connect: connectJson,
    connectKind: 'json',
    configs: [join(home, '.cursor', 'mcp.json')],
    configPath: '~/.cursor/mcp.json',
    apps: ['/Applications/Cursor.app', join(home, 'Applications', 'Cursor.app'), join(home, '.cursor')],
  },
];

/** Homebrew and local bins are often missing from a GUI-launched server's PATH. */
const EXTRA_BINS = [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

function onPath(bin: string): boolean {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_BINS];
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  return dirs.some((dir) => suffixes.some((suffix) => existsSync(join(dir, bin + suffix))));
}

/** Reads the client's config, skipping huge files we have no business loading. */
function mentionsInfinode(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return false;
    return /infinode/i.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Which outside assistants this machine has, and which already point at this server. */
export function detectExtensions(): AgentExtension[] {
  return CLIENTS.map(({ id, bin, install, connect, connectKind, configs, configPath, apps }) => ({
    id,
    bin,
    installed: onPath(bin) || (apps ?? []).some((path) => existsSync(path)),
    mcpConfigured: configs.some(mentionsInfinode),
    configPath,
    install,
    connect,
    connectKind,
  }));
}
