// Copies the OCR engine (Tesseract worker + WebAssembly core + English model) into public/ocr
// so OCR runs fully self-hosted: no third-party CDN, documents never leave the browser for OCR.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const out = path.resolve(import.meta.dirname, '../public/ocr');
mkdirSync(out, { recursive: true });

const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const copy = (from, to = path.basename(from)) => copyFileSync(from, path.join(out, to));

copy(path.join(pkgDir('tesseract.js'), 'dist/worker.min.js'));
// Use the exact core build tesseract.js depends on (it picks simd / relaxed-simd variants at runtime).
const tjs = pkgDir('tesseract.js');
const core = path.dirname(createRequire(path.join(tjs, 'package.json')).resolve('tesseract.js-core/package.json'));
for (const f of readdirSync(core)) if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) copy(path.join(core, f));
const lang = path.join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz');
if (!existsSync(lang)) throw new Error('English OCR model not found');
copy(lang);
console.log(`OCR assets ready in ${path.relative(process.cwd(), out)}`);
