import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Public interface glyphs only. No credentials, private DB rows, or environment files are read.
const files = ['src/components/home-v2/homepage.tsx', 'src/components/home-v2/login-panel.tsx', 'src/components/top-nav.tsx',
  'src/components/accounts/teacher-management.tsx'];
const strings = await Promise.all(files.map(file => readFile(file, 'utf8')));
const glyphs = Array.from(new Set([...strings.join('').matchAll(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/gu)].map(m => m[0])
  .concat(Array.from('林小满王园长芽芽苗苗星星月亮蒲公英太阳童童阿依努尔麦提0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,:;!?()[]/@+—·')))).sort().join('');
const cssUrl = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=swap&text=' + encodeURIComponent(glyphs);
const cssResponse = await fetch(cssUrl, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } });
if (!cssResponse.ok) throw new Error('Font stylesheet unavailable');
const css = await cssResponse.text();
if (!css.includes('font-weight: 100 900;')) throw new Error('Expected variable weight response');
const source = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
if (!source) throw new Error('Trusted font URL missing');
const fontResponse = await fetch(source);
if (!fontResponse.ok) throw new Error('Font binary unavailable');
const bytes = Buffer.from(await fontResponse.arrayBuffer());
if (bytes.subarray(0, 4).toString() !== 'wOF2') throw new Error('Expected WOFF2; refusing mislabeled asset');
// Binary asset production, not a page/source rewrite. Text/CSS edits are handed back to apply_patch.
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir('public/assets/fonts/home-v2', { recursive: true });
await writeFile('public/assets/fonts/home-v2/noto-sans-sc-ui.woff2', bytes);
console.log(JSON.stringify({ source, bytes: bytes.length, glyphs: Array.from(glyphs).length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  css: css.replaceAll('Noto Sans SC', 'Home Noto Sans SC').replaceAll(source, '/assets/fonts/home-v2/noto-sans-sc-ui.woff2') }));
