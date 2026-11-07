import fs from 'node:fs/promises';
import path from 'node:path';

/** Total bytes of the files under dir. */
export async function dirSize(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(entries.filter(e => e.isFile()).map(e =>
    fs.stat(path.join(e.parentPath, e.name)).then(s => s.size, () => 0))); // 0: deleted meanwhile
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Finds a file. "a/**\/b" means b anywhere under a; other paths are taken as they are.
 * Relative paths resolve against base.
 */
export async function resolveFile(spec, base) {
  const [dir, name] = spec.includes('**/') ? spec.split(/\/?\*\*\//) : [undefined, undefined];
  if (name === undefined) {
    const file = path.resolve(base ?? '.', spec);
    await fs.access(file);
    return file;
  }
  const root = path.resolve(base ?? '.', dir || '.');
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const hit = entries.find(e => e.isFile() && e.name === name);
  if (!hit) throw new Error(`No ${name} under ${root}`);
  return path.join(hit.parentPath, hit.name);
}
