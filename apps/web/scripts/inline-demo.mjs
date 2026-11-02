// Inlines the demo build's CSS and JS into one HTML file (dist-demo/vendor-onboarding-demo.html).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../dist-demo');
const assets = readdirSync(path.join(dir, 'assets'));
const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(path.join(dir, 'assets', f), 'utf8')).join('\n');
const js = assets.filter((f) => f.endsWith('.js'));
if (js.length !== 1) throw new Error(`expected one JS bundle, found ${js.length}`);
const code = readFileSync(path.join(dir, 'assets', js[0]), 'utf8').replace(/<\/script/gi, '<\\/script');

const html = `<title>Vendor Onboarding</title>
<meta name="theme-color" content="#e9eef6">
<style>${css}</style>
<div id="root"></div>
<script type="module">${code}</script>
`;
writeFileSync(path.join(dir, 'vendor-onboarding-demo.html'), html);
console.log(`wrote vendor-onboarding-demo.html (${(html.length / 1024).toFixed(0)} KB)`);
