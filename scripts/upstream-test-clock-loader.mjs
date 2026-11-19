// Owned test-only overlay; the pinned upstream vendor tree remains byte-identical.
// All test bodies/assertions are unchanged. Replace only the wall-clock helper
// with a causal microtask-then-timer barrier, after the mocked send can schedule
// its reduced-motion close timer. Never apply this to application/runtime code.
import { createHash } from 'node:crypto';
export const target = new URL('../runtime/ds-bot-upstream/ds-bot/test/text-annotation.test.js', import.meta.url).href;
export const oldHelper = 'const settle = () => new Promise(resolve => setTimeout(resolve, 5))';
export const newHelper = 'const settle = async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) }';
const expected = 'a5ada9ad5a0fc2f4ea2b034c6ea028f5de4972bf2e91aee9462f29d612eec4e7';
export function transformAnnotationFixture(source) {
  if (createHash('sha256').update(source).digest('hex') !== expected || source.split(oldHelper).length !== 2)
    throw new Error('Upstream annotation fixture changed: review its causal timer overlay, do not silently patch it');
  return source.replace(oldHelper, newHelper);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== target) return result;
  return { ...result, source: transformAnnotationFixture(Buffer.from(result.source).toString('utf8')) };
}
