// Owned test-only lifecycle overlay, never imported by the production image.
// Node after hooks run in registration order. The pinned restart fixture removes
// its shared directory before awaiting the restarted runtime's disposer, letting
// pending saves race rmSync. Await that SAME disposer before the SAME rmSync;
// preserve every assertion, cleanup failure and existing retry option.
import {createHash} from 'node:crypto';
export const target=new URL('../runtime/ds-bot-upstream/ds-bot/test/rounds.test.js',import.meta.url).href;
export const marker="test('a group whose state was not saved after its last line goes on numbering after the book', async (t) => {";
const expected='bda5d434d459dde98f8ca0ef9a2f87216faa28ba6bd3a4dbf2d198a40cf38f1f';
export const replacements=[
 ["  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))",
  "  let stopRestarted\n  t.after(async () => {\n    if (stopRestarted) await stopRestarted()\n    rmSync(home, { recursive: true, force: true, maxRetries: 5 })\n  })"],
 ["  t.after(() => again.stop({ keep: true }))","  stopRestarted = () => again.stop({ keep: true })"],
];
export function transformRestartFixture(source){
 if(createHash('sha256').update(source).digest('hex')!==expected)throw Error('Upstream rounds fixture changed: independently review cleanup ordering');
 const begin=source.indexOf(marker),end=source.indexOf('\n})',begin)+3;
 if(begin<0||end<begin)throw Error('Missing exact restart fixture');
 let block=source.slice(begin,end);
 for(const [before,after]of replacements){
  if(block.split(before).length!==2)throw Error('Unexpected restart cleanup wiring');
  block=block.replace(before,after);
 }
 return source.slice(0,begin)+block+source.slice(end);
}
