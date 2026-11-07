import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { bundledTargetsDir, schemaPath, toolRoot, userTargetsDir } from './paths.mjs';

let validator;
async function getValidator() {
  if (!validator) {
    const schema = JSON.parse(await fs.readFile(schemaPath(), 'utf8'));
    validator = new Ajv2020({ allErrors: true, discriminator: true, strict: false }).compile(schema);
  }
  return validator;
}

/** Errors as "path: message" lines; empty when the config is valid. */
export async function validateTarget(config) {
  const validate = await getValidator();
  if (validate(config)) return [];
  // a step's oneOf failure also reports "required" for every action it lacks; say it once instead
  const oneOfPaths = new Set(validate.errors.filter(e => e.keyword === 'oneOf').map(e => e.instancePath));
  const errors = validate.errors.filter(e => !(e.keyword === 'required' && oneOfPaths.has(e.instancePath)));
  return errors.map(e => {
    if (e.keyword === 'oneOf' && /^\/setup\/\d+$/.test(e.instancePath)) {
      return `${e.instancePath}: a step needs exactly one action: goto, navigate, click, fill, press, waitFor, waitForUrl, wait or script`;
    }
    const extra = e.keyword === 'additionalProperties' || e.keyword === 'unevaluatedProperties'
      ? ` (${e.params.additionalProperty ?? e.params.unevaluatedProperty})`
      : e.keyword === 'enum' ? ` (${e.params.allowedValues.join(', ')})` : '';
    return `${e.instancePath || '/'}: ${e.message}${extra}`;
  });
}

/** Parses and validates config JSON text. Throws with every problem listed. */
export async function parseTarget(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  const errors = await validateTarget(config);
  if (errors.length) throw new Error(`The config doesn't match the schema:\n${errors.map(e => `  ${e}`).join('\n')}`);
  return config;
}

const idOf = file => path.basename(file, '.json');

async function readDir(dir, source) {
  let files;
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(files.map(async f => {
    const file = path.join(dir, f);
    const text = await fs.readFile(file, 'utf8');
    try {
      const config = await parseTarget(text);
      return { id: idOf(f), file, source, config, available: availableHere(config) };
    } catch (e) {
      return { id: idOf(f), file, source, error: e.message, text };
    }
  }));
}

const availableHere = config => !config.platforms || config.platforms.includes(process.platform);

/** Bundled targets plus your own; yours win when the ids match (that's how a bundled one is edited). */
export async function listTargets() {
  const byId = new Map();
  for (const t of await readDir(bundledTargetsDir(), 'bundled')) byId.set(t.id, t);
  for (const t of await readDir(userTargetsDir(), 'user')) byId.set(t.id, { ...t, overrides: byId.has(t.id) });
  return [...byId.values()].sort((a, b) => (a.config?.name ?? a.id).localeCompare(b.config?.name ?? b.id));
}

export async function getTarget(idOrPath) {
  if (idOrPath.endsWith('.json')) {
    const file = path.resolve(idOrPath);
    return { id: idOf(file), file, source: 'file', config: await parseTarget(await fs.readFile(file, 'utf8')) };
  }
  const target = (await listTargets()).find(t => t.id === idOrPath);
  if (!target) throw new Error(`No target "${idOrPath}". Known: ${(await listTargets()).map(t => t.id).join(', ')}`);
  if (target.error) throw new Error(`Target ${target.id} (${target.file}) is broken:\n${target.error}`);
  return target;
}

/** Saves to your targets folder. Returns the saved target. */
export async function saveTarget(id, text) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('Target ids are letters, digits, dot, dash and underscore.');
  const config = await parseTarget(text);
  await fs.mkdir(userTargetsDir(), { recursive: true });
  const file = path.join(userTargetsDir(), `${id}.json`);
  await fs.writeFile(file, text.endsWith('\n') ? text : `${text}\n`);
  return { id, file, source: 'user', config };
}

/** Deletes one of your targets (for an edited bundled target, this restores the bundled one). */
export async function deleteTarget(id) {
  await fs.rm(path.join(userTargetsDir(), `${id}.json`));
}

/** The smallest useful target: open this URL in a fresh browser. */
export function targetFromUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) throw new Error('Use an http, https or file URL.');
  return {
    id: slug(u.hostname || path.basename(u.pathname) || 'site'),
    config: { $schema: '../schema/target.schema.json', name: u.hostname || u.pathname, launch: { type: 'browser', url: u.href } },
  };
}

export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'target';

/** The prompt for an AI to write a target: AUTHORING.md with the schema appended. */
export async function authoringPrompt() {
  const guide = await fs.readFile(path.join(toolRoot(), 'AUTHORING.md'), 'utf8');
  const schema = await fs.readFile(schemaPath(), 'utf8');
  const example = await fs.readFile(path.join(bundledTargetsDir(), 'fwlite-maui.json'), 'utf8');
  return `${guide}\n## The schema\n\n\`\`\`json\n${schema}\`\`\`\n\n## A full example\n\n\`\`\`json\n${example}\`\`\`\n`;
}

/**
 * Replaces ${name} in every string of a config value. Unknown names are left alone so the error is visible.
 * ${env:NAME} reads an environment variable.
 */
export function expand(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (m, name) => {
      if (name.startsWith('env:')) return process.env[name.slice(4)] ?? '';
      return vars[name] !== undefined ? String(vars[name]) : m;
    });
  }
  if (Array.isArray(value)) return value.map(v => expand(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}
