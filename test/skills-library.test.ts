import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SkillEngine } from '../server/agent/skills.ts';
import { canvasTools } from '../server/agent/tools.ts';
import { harnessTools } from '../server/agent/harness-tools.ts';
import { ExperienceStore } from '../server/agent/experience.ts';
import { VISUAL_DIMENSIONS } from '../server/agent/visual-criteria.ts';

const root = fileURLToPath(new URL('../server/agent/skills/', import.meta.url));
const engine = new SkillEngine(join(tmpdir(), 'kynflow-unused-library-user-skills'), root);

test('every builtin skill loads and declares tools available in the canvas harness', async () => {
  const catalog = (await engine.list()).filter((s) => s.source === 'builtin');
  const directories = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(catalog.map((s) => s.id).sort(), directories, 'invalid metadata must not silently remove a builtin');
  type Deps = Parameters<typeof canvasTools>[0];
  type Writer = Parameters<typeof canvasTools>[1];
  const tools = new Set([
    ...canvasTools({} as Deps, {} as Writer),
    ...harnessTools({} as Deps, engine, new ExperienceStore('/unused')),
  ].map((t) => t.name));
  for (const skill of catalog) {
    assert.ok((await engine.read(skill.id)).trim(), skill.id);
    for (const tool of skill.tools) assert.ok(tools.has(tool), `${skill.id}: unknown tool ${tool}`);
  }
});

test('all builtin resources and local markdown links are reachable through the confined reader', async () => {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const file of files.filter((f) => f.isFile())) {
    const path = join(file.parentPath, file.name);
    const [id, ...segments] = relative(root, path).split('/');
    const resource = segments.join('/');
    const content = await engine.read(id, resource);
    if (resource.endsWith('.json')) JSON.parse(content);
    if (!resource.endsWith('.md')) continue;
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^https?:\/\//.test(target)) continue;
      const linked = relative(join(root, id), resolve(dirname(path), target));
      assert.ok(!linked.startsWith('..'), `${id}/${resource}: link leaves skill directory`);
      assert.ok((await engine.read(id, linked)).trim(), `${id}/${resource}: ${target}`);
    }
  }
});

interface QualityCase {
  id: string;
  request: string;
  skills: string[];
  inputs: string[];
  expectedBehavior: string[];
  outputChecks: { dimension: string; description: string }[];
  failureConditions: string[];
}

test('quality scenarios refer to real skills and review dimensions without claiming measured results', async () => {
  const product = JSON.parse(await engine.read('product-photography', 'references/quality-cases.json'));
  const crossSkill = JSON.parse(await readFile(new URL('./fixtures/skill-quality-cases.json', import.meta.url), 'utf8'));
  const catalog = new Set((await engine.list()).filter((s) => s.source === 'builtin').map((s) => s.id));
  const covered = new Set<string>();
  const ids = new Set<string>();
  for (const suite of [product, crossSkill]) {
    assert.equal(suite.formatVersion, 1);
    assert.equal(suite.status, 'not_run', 'fixtures are specifications, not quality measurements');
    for (const scenario of suite.cases as QualityCase[]) {
      assert.ok(scenario.id && !ids.has(scenario.id), 'case ids must be unique');
      ids.add(scenario.id);
      assert.ok(scenario.request && scenario.inputs.length && scenario.expectedBehavior.length && scenario.failureConditions.length, scenario.id);
      assert.ok(scenario.skills.length > 0 && scenario.skills.length <= 3, `${scenario.id}: respect active skill budget`);
      for (const skill of scenario.skills) {
        assert.ok(catalog.has(skill), `${scenario.id}: missing skill ${skill}`);
        covered.add(skill);
      }
      assert.ok(scenario.outputChecks.length, scenario.id);
      for (const check of scenario.outputChecks) {
        assert.ok((VISUAL_DIMENSIONS as readonly string[]).includes(check.dimension), `${scenario.id}: unsupported dimension ${check.dimension}`);
        assert.ok(check.description, scenario.id);
      }
    }
  }
  assert.deepEqual([...covered].sort(), [...catalog].sort(), 'each builtin needs a realistic quality scenario');
});
