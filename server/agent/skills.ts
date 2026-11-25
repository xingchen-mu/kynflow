import { constants } from 'node:fs';
import fs, { readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSkillInfo } from '../../shared/types.ts';
import { createHash } from 'node:crypto';
import { ToolExecutionError } from './tool-errors.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 48_000;
const BUILTIN = fileURLToPath(new URL('./skills/', import.meta.url));
interface Skill extends AgentSkillInfo { directory: string; instructions: string }

/** Small, explicit metadata format; no executable code and no YAML dependency. */
function parseSkill(text: string): { name: string; description: string; tools: string[]; instructions: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md 需要 frontmatter');
  const metadata = new Map(match[1].split(/\r?\n/).map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  const name = metadata.get('name') ?? '';
  const description = metadata.get('description') ?? '';
  if (!name || name.length > 100 || !description || description.length > 500 || !match[2].trim()) throw new Error('技能需要 name、description 和正文');
  return { name, description, tools: (metadata.get('tools') ?? '').split(',').map((s) => s.trim()).filter(Boolean), instructions: match[2].trim() };
}

/** Resolve symlinks as well as '..': user references may never leave their skill directory. */
async function confinedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes('\0')) throw new Error('技能资源路径无效');
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('技能资源必须在技能目录内');
  return target;
}

/** Inspect and read the same open file, even if its pathname is replaced during the read. */
async function readSkillFile(root: string, resource: string): Promise<string> {
  const path = await confinedPath(root, resource);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    // Refuse a parent directory redirected between resolution and opening, before reading any content.
    if (await realpath(path) !== path) throw new Error('技能资源路径已改变，请重试');
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('技能资源必须是文件');
    if (info.size > MAX_SKILL_BYTES) throw new Error('技能资源过大，请拆成较小的文件');
    // A file can grow after fstat: read at most the limit plus one byte, never an unbounded readFile.
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_SKILL_BYTES) throw new Error('技能资源过大，请拆成较小的文件');
    return buffer.toString('utf8', 0, length);
  } finally {
    await handle.close();
  }
}

export class SkillEngine {
  constructor(private userRoot: string, private builtinRoot = BUILTIN) {}

  private async discover(): Promise<Skill[]> {
    const skills = new Map<string, Skill>();
    for (const [root, source] of [[this.builtinRoot, 'builtin'], [this.userRoot, 'user']] as const) {
      const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100)) {
        if (!entry.isDirectory() || !ID.test(entry.name)) continue;
        // Built-ins cannot be silently replaced by a user directory with the same id.
        if (skills.has(entry.name)) continue;
        const directory = join(root, entry.name);
        try {
          const parsed = parseSkill(await readSkillFile(directory, 'SKILL.md'));
          skills.set(entry.name, { id: entry.name, source, directory, version: createHash('sha256').update(JSON.stringify(parsed)).digest('hex').slice(0, 16), ...parsed });
        } catch (err) { console.warn(`agent: skipped invalid skill ${entry.name}:`, (err as Error).message); }
      }
    }
    return [...skills.values()];
  }

  async list(): Promise<AgentSkillInfo[]> {
    return (await this.discover()).map(({ directory: _directory, instructions: _instructions, ...info }) => info);
  }

  async read(id: string, resource?: string): Promise<string> {
    if (!ID.test(id)) throw new Error('技能 id 无效');
    const skill = (await this.discover()).find((s) => s.id === id);
    if (!skill) throw new Error('技能不存在，用 list_skills 查看');
    if (!resource || resource === 'SKILL.md') return skill.instructions;
    if (!/^(references|schemas)\//.test(resource) || !/\.(md|json|txt)$/.test(resource)) throw new Error('只支持技能 references/ 或 schemas/ 下的文本资源');
    return readSkillFile(skill.directory, resource);
  }

  /** Deterministic lexical retrieval; a match recommends knowledge, never permissions. */
  async match(query: string, availableTools: string[], limit = 3): Promise<AgentSkillInfo[]> {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]/gu) ?? [])];
    const skills = await this.list();
    return skills.filter((skill) => skill.tools.every((tool) => availableTools.includes(tool))).map((skill) => {
      const text = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      return { skill, score: terms.reduce((score, term) => score + Number(text.includes(term)), 0) };
    }).filter((entry) => entry.score >= 2).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id)).slice(0, Math.max(0, Math.min(3, limit))).map((entry) => entry.skill);
  }

  async compose(ids: string[], availableTools: string[]): Promise<(AgentSkillInfo & { instructions: string })[]> {
    const skills = await this.discover();
    return [...new Set(ids)].slice(0, 3).map((id) => {
      const skill = skills.find((entry) => entry.id === id);
      if (!skill) throw new ToolExecutionError('CAPABILITY_UNAVAILABLE', `专业技能不存在：${id}`);
      const missing = skill.tools.filter((tool) => !availableTools.includes(tool));
      if (missing.length) throw new ToolExecutionError('CAPABILITY_UNAVAILABLE', `技能 ${id} 缺少必要工具：${missing.join(', ')}`);
      const { directory: _directory, ...composed } = skill;
      return composed;
    });
  }

  async catalog(): Promise<string> {
    const skills = await this.list();
    return `可按需加载的专业技能（用 read_skill 读取，工具要求只作能力提示，不授予权限）：\n${skills.map((s) => `- ${s.id}: ${s.description}${s.tools.length ? `；需要 ${s.tools.join(', ')}` : ''}`).join('\n')}`;
  }
}

export const defaultSkillsRoot = (agentDir: string) => join(dirname(agentDir), 'skills');
