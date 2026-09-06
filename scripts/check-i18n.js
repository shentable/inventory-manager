'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const project = path.resolve(__dirname, '..');
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(project, 'web/js/i18n/en-core.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(project, 'web/js/i18n/en-app.js'), 'utf8'));

const core = global.I18N_EN_CORE || {};
const app = global.I18N_EN_APP || {};
const duplicates = Object.keys(core).filter((key) => Object.prototype.hasOwnProperty.call(app, key));
if (duplicates.length) {
  throw new Error('英文字典存在重复 key：\n' + duplicates.join('\n'));
}

const dictionary = { ...core, ...app };
const literalKeys = new Set();
const callPattern = /(?:\bI18N\.t|(?<![A-Za-z0-9_$])t)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
for (const relative of ['web/app.js', 'web/js/api.js', 'web/js/ui.js', 'web/js/i18n.js']) {
  const source = fs.readFileSync(path.join(project, relative), 'utf8');
  let match;
  while ((match = callPattern.exec(source))) {
    literalKeys.add(match[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
}
const missing = [...literalKeys]
  .filter((key) => key !== 'errcode.' && !Object.prototype.hasOwnProperty.call(dictionary, key))
  .sort();
if (missing.length) {
  throw new Error('以下界面文案缺少英文翻译：\n' + missing.join('\n'));
}

function androidStrings(relative) {
  const xml = fs.readFileSync(path.join(project, relative), 'utf8');
  const values = new Map();
  const pattern = /<string name="([^"]+)">([\s\S]*?)<\/string>/g;
  let match;
  while ((match = pattern.exec(xml))) values.set(match[1], match[2]);
  return values;
}
function placeholders(value) {
  return (value.match(/%(?:\d+\$)?[sd]/g) || []).sort().join(',');
}
const zh = androidStrings('android/app/src/main/res/values/strings.xml');
const en = androidStrings('android/app/src/main/res/values-en/strings.xml');
const missingAndroid = [...zh.keys()].filter((key) => !en.has(key))
  .concat([...en.keys()].filter((key) => !zh.has(key)));
const mismatchedAndroid = [...zh.keys()].filter((key) => en.has(key) && placeholders(zh.get(key)) !== placeholders(en.get(key)));
if (missingAndroid.length || mismatchedAndroid.length) {
  throw new Error('Android 中英资源不一致：missing=' + missingAndroid.join(',') + ' placeholders=' + mismatchedAndroid.join(','));
}

console.log(`i18n check passed: ${literalKeys.size - 1} Web keys, ${zh.size} Android strings`);
