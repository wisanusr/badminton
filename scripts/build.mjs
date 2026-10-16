// Precompiles index.html for production so the browser does not download and run Babel + the Tailwind CDN on every visit.
//   index.html (source, still runs by itself in dev)  ->  _site/index.html (JSX compiled, Tailwind CSS inlined)
// Usage: npm ci && node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'index.html'), 'utf8');

// Cut the first match of `re` out of html; fail loudly if the page no longer has it (so a refactor cannot ship an unbuilt page).
function take(html, re, what) {
  const m = html.match(re);
  if (!m) throw new Error('build: ' + what + ' not found in index.html');
  return { match: m, html: html.replace(re, '') };
}

// 1) JSX -> plain JS. React stays the global from the UMD script tags, like Babel standalone did.
const babelRe = /[ \t]*<script type="text\/babel">([\s\S]*?)<\/script>\s*/;
const jsx = src.match(babelRe);
if (!jsx) throw new Error('build: <script type="text/babel"> not found in index.html');
const js = transformSync(jsx[1], { loader: 'jsx', target: 'es2018', minify: true, legalComments: 'none' }).code;

let html = src.replace(babelRe, '');
// 2) Drop the runtime compilers: Babel and the Tailwind CDN + its inline config.
html = take(html, /[ \t]*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+"><\/script>\s*/, 'Babel <script>').html;
html = take(html, /[ \t]*<script src="https:\/\/cdn\.tailwindcss\.com\/[^"]+"><\/script>\s*/, 'Tailwind CDN <script>').html;
html = take(html, /[ \t]*<script>\s*tailwind\.config = [\s\S]*?<\/script>\s*/, 'tailwind.config <script>').html;

// 3) Tailwind: generate only the classes the page uses (same preflight + theme as the CDN build, config copied from index.html).
const work = join(tmpdir(), 'badminton-build-' + process.pid);
mkdirSync(work, { recursive: true });
try {
  writeFileSync(join(work, 'in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  writeFileSync(join(work, 'tailwind.config.cjs'), `module.exports = {
  content: [${JSON.stringify(join(root, 'index.html'))}],
  theme: { extend: { fontFamily: { sans: ['"Google Sans"', '"Noto Sans Thai"', 'sans-serif'] } } }
};\n`);
  execFileSync(process.execPath, [
    join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
    '-c', join(work, 'tailwind.config.cjs'), '-i', join(work, 'in.css'), '-o', join(work, 'out.css'), '--minify'
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const css = readFileSync(join(work, 'out.css'), 'utf8');

  // Tailwind goes AFTER the page's own <style>, as with the CDN (it appends its <style> last): utilities such as p-4 beat .pt-safe the same way.
  // Callback form: CSS/JS contain `$`, which a replacement string would interpret.
  html = html.replace('</head>', () => '    <style>/* tailwind */' + css.replace(/<\/style/gi, '<\\/style') + '</style>\n</head>');
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 4) Put the compiled app where the Babel tag was.
html = html.replace('<div id="root"></div>', '<div id="root"></div>\n    <script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>');

mkdirSync(join(root, '_site'), { recursive: true });
writeFileSync(join(root, '_site', 'index.html'), html);
console.log(`built _site/index.html (${(html.length / 1024).toFixed(0)} KB; source ${(src.length / 1024).toFixed(0)} KB)`);
