// Syntax check of every source file (no test run).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = fs.readdirSync('src', { recursive: true }).filter(f => /\.(mjs|cjs|js)$/.test(f)).map(f => `src/${f}`);
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`${files.length} files OK`);
