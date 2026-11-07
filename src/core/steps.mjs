import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTIONS = ['goto', 'navigate', 'click', 'fill', 'press', 'waitFor', 'waitForUrl', 'wait', 'script'];
const IF_VISIBLE_MS = 5_000;

/** "/abc/i" → RegExp, anything else stays a string. */
export function textOrRegex(s) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : s;
}

export function locate(page, loc) {
  const exact = loc.exact;
  let l;
  if (loc.role) l = page.getByRole(loc.role, loc.name !== undefined ? { name: textOrRegex(loc.name), exact } : {});
  else if (loc.text !== undefined) l = page.getByText(textOrRegex(loc.text), { exact });
  else if (loc.label !== undefined) l = page.getByLabel(textOrRegex(loc.label), { exact });
  else if (loc.placeholder !== undefined) l = page.getByPlaceholder(textOrRegex(loc.placeholder), { exact });
  else if (loc.testId !== undefined) l = page.getByTestId(loc.testId);
  else if (loc.selector !== undefined) l = page.locator(loc.selector);
  else throw new Error(`A locator needs text, role, label, placeholder, testId or selector: ${JSON.stringify(loc)}`);
  return l.first();
}

/** Glob with ** and *, or /regex/, matched against the full URL or its path + query. */
export function urlMatcher(pattern) {
  const re = textOrRegex(pattern);
  if (re instanceof RegExp) return u => re.test(u.href) || re.test(u.pathname + u.search);
  const glob = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`);
  return u => glob.test(u.href) || glob.test(u.pathname) || glob.test(u.pathname + u.search);
}

export const describeStep = step => {
  const action = ACTIONS.find(a => a in step);
  const value = step[action];
  return `${action} ${typeof value === 'object' ? JSON.stringify(value) : value}`;
};

/** Runs setup steps in order. Each step's variables are already expanded. */
export async function runSteps(steps, { page, context, vars, configDir, log = console.log }) {
  for (const step of steps ?? []) {
    const timeout = step.timeout ?? 30_000;
    try {
      if (step.ifVisible) {
        const visible = await locate(page, step.ifVisible).waitFor({ timeout: IF_VISIBLE_MS }).then(() => true, () => false);
        if (!visible) {
          log(`  skip ${describeStep(step)} (not visible: ${JSON.stringify(step.ifVisible)})`);
          continue;
        }
      }
      log(`  ${describeStep(step)}`);
      await runStep(step, { page, context, vars, configDir, log, timeout });
    } catch (e) {
      if (step.optional) {
        log(`  optional step failed, carrying on: ${e.message.split('\n')[0]}`);
        continue;
      }
      throw new Error(`Setup step failed: ${describeStep(step)}\n${e.message}`);
    }
  }
}

async function runStep(step, { page, context, vars, configDir, log, timeout }) {
  if (step.goto !== undefined) return void await page.goto(new URL(step.goto, page.url()).href, { timeout });
  if (step.navigate !== undefined) {
    return void await page.evaluate(to => {
      history.pushState({}, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, step.navigate);
  }
  if (step.click) return void await locate(page, step.click).click({ timeout });
  if (step.fill) {
    const { value, ...loc } = step.fill;
    return void await locate(page, loc).fill(value, { timeout });
  }
  if (step.press !== undefined) return void await page.keyboard.press(step.press);
  if (step.waitFor) return void await locate(page, step.waitFor).waitFor({ timeout });
  if (step.waitForUrl !== undefined) return void await page.waitForURL(urlMatcher(step.waitForUrl), { timeout });
  if (step.wait !== undefined) return void await page.waitForTimeout(step.wait);
  if (step.script !== undefined) {
    const mod = await import(pathToFileURL(path.resolve(configDir, step.script)).href);
    return void await mod.default({ page, context, vars, log });
  }
  throw new Error(`Unknown step ${JSON.stringify(step)}`);
}
