// 从导出的 GLB 生成多级 LOD（gltf-transform simplify + meshoptimizer）。
// 用法：node tools/lod.mjs <input.glb> [--outDir <dir>]
// 产出：<slug>.lod1.glb / <slug>.lod2.glb + <slug>.lod.json（lod0 即原 glb，不重存）
import { NodeIO } from '@gltf-transform/core';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error('usage: node tools/lod.mjs <input.glb> [--outDir <dir>]');
  process.exit(1);
}
const i = args.indexOf('--outDir');
const outDir = i >= 0 ? (args[i + 1] || dirname(input)) : dirname(input);
const slug = basename(input, extname(input));

// 目标：lod1 降到约 50% 面数，lod2 降到约 20%；error 越大允许越多失真。
const LEVELS = [
  { name: 'lod1', ratio: 0.5, error: 0.0005 },
  { name: 'lod2', ratio: 0.2, error: 0.001 },
];

const io = new NodeIO();
const manifest = { slug, source: basename(input), levels: [] };

for (const level of LEVELS) {
  const doc = await io.read(input);
  await doc.transform(
    weld({}),
    simplify({ simplifier: MeshoptSimplifier, ratio: level.ratio, error: level.error })
  );
  const outPath = join(outDir, `${slug}.${level.name}.glb`);
  await io.write(outPath, doc);
  manifest.levels.push({
    name: level.name,
    ratio: level.ratio,
    error: level.error,
    bytes: statSync(outPath).size,
  });
}

const manifestPath = join(outDir, `${slug}.lod.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`LOD generated -> ${manifestPath}`);
for (const lv of manifest.levels) {
  console.log(`  ${lv.name}: ${Math.round(lv.bytes / 1024)} KB (ratio ${lv.ratio})`);
}
