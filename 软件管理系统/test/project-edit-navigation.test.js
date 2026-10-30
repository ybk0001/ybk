const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../bundled-server/public/index.html'), 'utf8');
const start = html.indexOf('window.editProject = function');
const end = html.indexOf('\n    window.deleteProject', start);
const source = html.slice(start, end);

test('从嵌套客户年度销售列表编辑时关闭父报表并显示原项目表单', () => {
  const dialogs = Object.fromEntries(['projectDrilldownDialog', 'annualSalesDialog', 'operationsDialog'].map(id => [id, { open: true, close() { this.open = false; } }]));
  const project = { id: 'legacy', name: '历史订单', _version: 'unchanged' };
  const window = {};
  let shown, filled;
  new Function('window', 'document', 'getCurrentProject', 'showMainPage', 'fillForm', 'showToast', source)(window, { getElementById: id => dialogs[id] }, id => id === project.id ? project : null, page => { shown = page; }, row => { filled = row; }, () => {});
  window.editProject(project.id);
  assert.equal(shown, 'order');
  assert.equal(filled, project);
  assert.ok(Object.values(dialogs).every(dialog => !dialog.open));
  assert.equal(project._version, 'unchanged');
});

test('失效的项目引用显示提示而不是静默返回', () => {
  const window = {};
  let message = '';
  new Function('window', 'document', 'getCurrentProject', 'showMainPage', 'fillForm', 'showToast', source)(window, {}, () => null, () => assert.fail('must not navigate'), () => assert.fail('must not populate'), text => { message = text; });
  window.editProject('missing');
  assert.match(message, /未找到该项目/);
});
