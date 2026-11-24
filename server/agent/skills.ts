import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSkillInfo } from '../../shared/types.ts';

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
  if (!(await stat(target)).isFile()) throw new Error('技能资源必须是文件');
  return target;
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
          const path = await confinedPath(directory, 'SKILL.md');
          if ((await stat(path)).size > MAX_SKILL_BYTES) continue;
          const parsed = parseSkill(await readFile(path, 'utf8'));
          skills.set(entry.name, { id: entry.name, source, directory, ...parsed });
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
    const path = await confinedPath(skill.directory, resource);
    if ((await stat(path)).size > MAX_SKILL_BYTES) throw new Error('技能资源过大，请拆成较小的文件');
    return readFile(path, 'utf8');
  }

  async catalog(): Promise<string> {
    const skills = await this.list();
    return `可按需加载的专业技能（用 read_skill 读取，工具要求只作能力提示，不授予权限）：\n${skills.map((s) => `- ${s.id}: ${s.description}${s.tools.length ? `；需要 ${s.tools.join(', ')}` : ''}`).join('\n')}`;
  }
}

export const defaultSkillsRoot = (agentDir: string) => join(dirname(agentDir), 'skills');
