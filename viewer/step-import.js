// 浏览器内 STEP/STP 解析（occt-import-js WASM），无需 Blender / OCP 服务端。
//
// occt-import-js 返回的每个 face 都有独立顶点（js-interface.cpp 中每 face 从 vertexOffset
// 重新枚举顶点，三角形索引引用 vertexOffset+v），因此 AP214 面颜色可无损展开为逐顶点颜色，
// 用单个 MeshStandardMaterial(vertexColors) 表达 —— 与既有高亮/材质覆盖代码完全兼容。
//
// 输出 group 已缩放到米（查看器世界 1 单位 = 1 米；occt 默认输出毫米）。
import * as THREE from 'three';

let occtPromise = null;

function getOcct() {
  if (!occtPromise) {
    const factory = (typeof window !== 'undefined') && window.occtimportjs;
    if (typeof factory !== 'function') {
      occtPromise = Promise.reject(new Error(
        'occt-import-js 未加载：缺少 lib/occt/occt-import-js.js。请先运行 tools/download-occt.ps1 下载，再刷新页面。'
      ));
    } else {
      occtPromise = factory();
    }
  }
  return occtPromise;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

// 单个网格：position/normal/index + 逐顶点颜色（AP214 面颜色展开）。
function buildMesh(meshData) {
  const pos = meshData.attributes.position.array;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (meshData.attributes.normal && meshData.attributes.normal.array) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.attributes.normal.array, 3));
  }
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(meshData.index.array), 1));

  const defaultColor = meshData.color
    ? [meshData.color[0], meshData.color[1], meshData.color[2]]
    : [0.60, 0.63, 0.65];

  const vertexCount = pos.length / 3;
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 3] = defaultColor[0];
    colors[i * 3 + 1] = defaultColor[1];
    colors[i * 3 + 2] = defaultColor[2];
  }

  // brep_faces[].first/last 是三角形下标（闭区间），顺序覆盖整个 index 数组；
  // 把每个 face 的颜色写到它覆盖的三角形顶点上（每 face 顶点独立，无共享冲突）。
  const faces = meshData.brep_faces || [];
  const index = meshData.index.array;
  const triangleCount = Math.floor(index.length / 3);
  let tri = 0;
  let faceIdx = 0;
  while (tri < triangleCount) {
    let lastTri;
    let color;
    if (faceIdx >= faces.length) {
      lastTri = triangleCount;
      color = defaultColor;
    } else if (tri < faces[faceIdx].first) {
      lastTri = faces[faceIdx].first;
      color = defaultColor;
    } else {
      lastTri = faces[faceIdx].last + 1;
      const fc = faces[faceIdx].color;
      color = fc ? [fc[0], fc[1], fc[2]] : defaultColor;
      faceIdx += 1;
    }
    for (let t = tri; t < lastTri; t++) {
      const v0 = index[t * 3];
      const v1 = index[t * 3 + 1];
      const v2 = index[t * 3 + 2];
      colors[v0 * 3] = color[0]; colors[v0 * 3 + 1] = color[1]; colors[v0 * 3 + 2] = color[2];
      colors[v1 * 3] = color[0]; colors[v1 * 3 + 1] = color[1]; colors[v1 * 3 + 2] = color[2];
      colors[v2 * 3] = color[0]; colors[v2 * 3 + 1] = color[1]; colors[v2 * 3 + 2] = color[2];
    }
    tri = lastTri;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.7,
    roughness: 0.4,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = meshData.name || '';
  return mesh;
}

// 由 occt 结果构建 three.js 场景 + 序列号零件表（Axxx=装配 / Pxxx=零件）。
export function buildStepScene(result) {
  const meshes = result.meshes || [];
  const parts = {};
  const counter = { a: 0, p: 0 };

  function buildNode(node) {
    const hasMeshes = node.meshes && node.meshes.length > 0;
    const hasChildren = node.children && node.children.length > 0;
    const group = new THREE.Group();
    if (hasMeshes) {
      const serial = 'P' + pad3(counter.p++);
      group.name = serial;
      for (const mi of node.meshes) {
        const md = meshes[mi];
        if (md) group.add(buildMesh(md));
      }
      parts[serial] = { name_en: node.name || serial, name_zh: node.name || serial, kind: 'part' };
    } else {
      const serial = 'A' + pad3(counter.a++);
      group.name = serial;
      parts[serial] = { name_en: node.name || serial, name_zh: node.name || serial, kind: 'assembly' };
    }
    if (hasChildren) {
      for (const c of node.children) group.add(buildNode(c));
    }
    return group;
  }

  const root = new THREE.Group();
  const rootNode = result.root || {};
  if (rootNode.children && rootNode.children.length) {
    for (const c of rootNode.children) root.add(buildNode(c));
  } else if (rootNode.meshes && rootNode.meshes.length) {
    // 单零件：根节点本身就是网格节点
    root.add(buildNode(rootNode));
  }
  return { group: root, parts };
}

// 解析 STEP 字节流 → 构建场景 → 缩放到米（occt 默认毫米，世界单位 = 米）。
export async function parseStepBuffer(uint8, params) {
  const occt = await getOcct();
  const result = occt.ReadStepFile(uint8, params || null);
  if (!result || !result.success) {
    throw new Error('STEP 解析失败（occt-import-js 返回 success=false）');
  }
  const { group, parts } = buildStepScene(result);

  const box = new THREE.Box3().setFromObject(group);
  let maxDimMm = 0;
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3());
    maxDimMm = Math.max(size.x, size.y, size.z);
  }
  group.scale.setScalar(0.001);

  return { group, parts, meta: { max_dim: maxDimMm, units: 'mm' } };
}

// 打开本地 STEP/STP 文件。
export async function importStepFile(file, params) {
  return parseStepBuffer(new Uint8Array(await file.arrayBuffer()), params);
}

// 从 URL 拉取并解析 STEP（用于 GitHub Pages 在线演示等场景）。
export async function importStepUrl(url, params) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseStepBuffer(new Uint8Array(await r.arrayBuffer()), params);
}
