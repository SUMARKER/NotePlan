'use strict';
/* ==========================================================================
 * 统一版本号升级脚本
 * 用法：node scripts/bump-version.js X.Y.Z
 * 依据 SemVer 按修改范围选择版本号（规则见 README「版本规范」）：
 *   修复/文案   -> X.Y.Z+1   (patch)
 *   新功能/UI  -> X.Y+1.0   (minor)
 *   破坏性变更 -> X+1.0.0   (major)
 * 覆盖位置：electron/package.json(+lock)、tauri.conf.json、Cargo.toml(+lock)、
 *           webview2/setup.nsi、webview2/NotePlanWpf.csproj、
 *           native-wpf/NotePlanNative.csproj、关于弹窗（app.js）
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const NEW = process.argv[2];
if (!NEW || !/^\d+\.\d+\.\d+$/.test(NEW)) {
  console.error('用法: node scripts/bump-version.js X.Y.Z');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, c) => fs.writeFileSync(path.join(ROOT, p), c, 'utf8');

// 当前版本以 electron/package.json 为准
const pkg = JSON.parse(read('electron/package.json'));
const OLD = pkg.version;
if (OLD === NEW) {
  console.log(`版本已是 ${NEW}，无需修改`);
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+$/.test(OLD)) {
  console.error(`无法识别当前版本 "${OLD}"`);
  process.exit(1);
}

let changed = 0;
const swap = (file, from, to) => {
  const c = read(file);
  if (!c.includes(from)) {
    console.error(`  跳过 ${file}：未找到 "${from}"`);
    return;
  }
  write(file, c.split(from).join(to));
  changed++;
  console.log(`  ${file}: ${from} -> ${to}`);
};

// 1. electron/package.json
swap('electron/package.json', `"version": "${OLD}"`, `"version": "${NEW}"`);

// 2. electron/package-lock.json（仅文件头部的根包版本，避免误伤同版本号的第三方依赖）
{
  const f = 'electron/package-lock.json';
  const c = read(f);
  const lines = c.split('\n');
  let hits = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (lines[i].includes(`"version": "${OLD}"`)) { lines[i] = lines[i].replace(`"version": "${OLD}"`, `"version": "${NEW}"`); hits++; }
  }
  if (hits) { write(f, lines.join('\n')); changed++; console.log(`  ${f}: ${hits} 处`); }
}

// 3. tauri.conf.json
swap('tauri/src-tauri/tauri.conf.json', `"version": "${OLD}"`, `"version": "${NEW}"`);

// 4. Cargo.toml
swap('tauri/src-tauri/Cargo.toml', `version = "${OLD}"`, `version = "${NEW}"`);

// 5. Cargo.lock（仅 noteplan-tauri 条目）
{
  const f = 'tauri/src-tauri/Cargo.lock';
  const c = read(f);
  const marker = 'name = "noteplan-tauri"';
  const i = c.indexOf(marker);
  if (i === -1) {
    console.error(`  跳过 ${f}：未找到 noteplan-tauri 条目`);
  } else {
    const head = c.slice(0, i);
    const rest = c.slice(i).replace(`version = "${OLD}"`, `version = "${NEW}"`);
    write(f, head + rest);
    changed++;
    console.log(`  ${f}: ${OLD} -> ${NEW}`);
  }
}

// 6. webview2/setup.nsi（已冻结，保持版本号同步）
swap('webview2/setup.nsi', `!define VERSION "${OLD}"`, `!define VERSION "${NEW}"`);

// 7. webview2/NotePlanWpf.csproj
swap('webview2/NotePlanWpf.csproj', `<Version>${OLD}</Version>`, `<Version>${NEW}</Version>`);

// 8. native-wpf/NotePlanNative.csproj（-preview 后缀）
{
  const f = 'native-wpf/NotePlanNative.csproj';
  const c = read(f);
  const from = `<Version>${OLD}-preview</Version>`;
  const to = `<Version>${NEW}-preview</Version>`;
  if (c.includes(from)) { write(f, c.replace(from, to)); changed++; console.log(`  ${f}: ${OLD}-preview -> ${NEW}-preview`); }
  else console.error(`  跳过 ${f}：未找到 "${from}"`);
}

// 9. 关于弹窗（app.js）
swap('electron/src/js/app.js', `NotePlan for Windows v${OLD}`, `NotePlan for Windows v${NEW}`);

console.log(`\n版本 ${OLD} -> ${NEW}，共更新 ${changed} 个文件`);
console.log('后续：git commit + git tag vX.Y.Z + git push --tags 触发 CI 发布');
