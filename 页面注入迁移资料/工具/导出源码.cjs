const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const sourceRoot = String.raw`D:\云监控\app`
const outputRoot = path.resolve(__dirname, '..')
const snapshotRoot = path.join(outputRoot, '源码快照')
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const integration = 'src/main/integration/'
const coreNames = [
  'pddAdapter.ts', 'pddGuestSender.ts', 'pddTitanDecoder.ts', 'pddChromeBridge.ts',
  'pddOrderProbe.ts', 'douyinAdapter.ts', 'douyinPageBridge.ts', 'douyinMessage.ts',
  'douyinRecoveryState.ts', 'pddStateStore.ts', 'pddReplyResolver.ts',
  'flags.ts', 'messageSchemaCapture.ts'
]
const core = [
  ...coreNames.map((name) => integration + name),
  'resources/injections/yz-pdd-hook.js', 'src/shared/contracts.ts'
]
const tests = [
  'pddAdapter.test.ts', 'pddGuestSender.test.ts', 'pddTitanDecoder.test.ts',
  'pddOrderProbe.test.ts', 'pddStateStore.test.ts', 'pddReplyResolver.test.ts',
  'douyinAdapter.test.ts', 'douyinPageBridge.test.ts', 'douyinMessage.test.ts',
  'douyinRecoveryState.test.ts', 'messageSchemaCapture.test.ts'
].map((name) => integration + name)
const fixtures = ['mockAdapter.ts', 'types.ts', 'redaction.ts'].map((name) => integration + name)
const host = [
  'src/main/index.ts', 'src/main/ipc.ts', 'src/preload/index.ts',
  integration + 'registry.ts',
  'src/renderer/src/components/PlatformViewport.vue',
  'src/renderer/src/components/DouyinViewport.vue'
]
const configs = [
  'package.json', 'pnpm-lock.yaml', 'electron.vite.config.ts', 'electron-builder.yml',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.ts'
]
const files = [...core, ...tests, ...fixtures, ...host, ...configs]
const manifest = []
for (const relative of files) {
  const original = path.join(sourceRoot, relative)
  const target = path.join(snapshotRoot, relative)
  const bytes = fs.readFileSync(original)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  const copied = fs.readFileSync(target)
  if (sha(bytes) !== sha(copied)) throw new Error('Copy checksum mismatch: ' + relative)
  if (sha(bytes) !== sha(fs.readFileSync(original))) throw new Error('Source changed during export: ' + relative)
  manifest.push({
    path: relative, source: original, bytes: bytes.length,
    lines: bytes.toString('utf8').split(/\r?\n/).length,
    sha256: sha(bytes), sourceMtime: fs.statSync(original).mtime.toISOString(),
    category: core.includes(relative) ? 'core' : tests.includes(relative) ? 'test'
      : fixtures.includes(relative) ? 'test-fixture' : host.includes(relative) ? 'host-reference' : 'config-reference'
  })
}
fs.writeFileSync(path.join(outputRoot, '源码清单.json'), JSON.stringify({
  exportedAt: new Date().toISOString(), sourceRoot, snapshotRoot,
  notes: '静态源码快照；没有导出运行数据。宿主参考文件含原软件其他功能，目标软件只迁移本手册范围。',
  files: manifest
}, null, 2), 'utf8')

function section(relative, start, end) {
  const item = manifest.find((entry) => entry.path === relative)
  const source = fs.readFileSync(path.join(snapshotRoot, relative), 'utf8')
  const lines = source.split(/\r?\n/)
  const body = start ? lines.slice(start - 1, end).join('\n') : source.replace(/\r\n/g, '\n')
  const longest = Math.max(0, ...(body.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(4, longest + 1))
  const language = relative.endsWith('.vue') ? 'vue' : relative.endsWith('.json') ? 'json'
    : relative.endsWith('.yml') ? 'yaml' : relative.endsWith('.js') ? 'javascript' : 'typescript'
  return `\n## ${relative}${start ? `（原文件 L${start}–L${end}）` : ''}\n\n` +
    `原路径：\`${item.source}\`  \nSHA-256（整个原文件）：\`${item.sha256}\`  \n` +
    `原文件字节：${item.bytes}；行数：${item.lines}。\n\n` +
    `${fence}${language}\n${body.replace(/\n$/, '')}\n${fence}\n`
}
const sourceDoc = '# 页面注入与收发核心源码全文\n\n' +
  '本文件来自 2026-10-02 静态提取。代码逻辑保持原样；Markdown 代码块统一换行，实际迁移使用字节一致的 `源码快照/`。\n\n' +
  '拼多多默认接收是 CDP，不是仅装载 hook；Chrome 分支和 hook 单列在全文中。抖音发送借助页面 IM。阅读注意事项请先看 `01_拼多多与抖音页面注入收发迁移手册.md`。\n\n' +
  '该附录包含拼多多订单辅助模块以保持 import 闭包；共享 contracts 还含原应用其他平台 / UI 类型，不要求目标软件接入那些功能。\n\n' +
  core.map((relative, index) => `${index + 1}. \`${relative}\``).join('\n') + '\n' +
  core.map((relative) => section(relative)).join('\n')
fs.writeFileSync(path.join(outputRoot, '02_核心源码全文.md'), sourceDoc, 'utf8')

const indexLines = fs.readFileSync(path.join(snapshotRoot, 'src/main/index.ts'), 'utf8').split(/\r?\n/)
const findLine = (contains) => {
  const index = indexLines.findIndex((line) => line.includes(contains))
  if (index < 0) throw new Error('Missing host section: ' + contains)
  return index + 1
}
const begin = findLine('function createWindow(): BrowserWindow')
const end = findLine("if (is.dev && process.env['ELECTRON_RENDERER_URL'])") - 1
const dataBegin = findLine('const relocatedUserData')
const dataEnd = findLine('qianniuPollTimer = setInterval') - 1
let hostDoc = '# 宿主接线与离线测试源码\n\n' +
  '宿主代码是原软件的接线证据，不是目标软件的完整可运行入口。核心逻辑见 02，迁移步骤见 01。\n\n' +
  '完整宿主参考文件放在 `源码快照/`，含原软件其他 UI / 千牛 / 模型配置功能；本文只展开主要 webview 接入片段。多店接入应替换默认 session 单例分流。\n\n' +
  '## 一、BrowserWindow、guest 安全配置和绑定\n' +
  section('src/main/index.ts', begin, end) +
  '\n## 二、userData 与模块初始化\n' + section('src/main/index.ts', dataBegin, dataEnd) +
  '\n## 三、原 registry（装配参考，不作为目标软件业务仓库）\n' + section(integration + 'registry.ts') +
  '\n## 四、IPC / preload / 页面入口定位\n\n' +
  '| 文件 | 需要迁移的点 |\n|---|---|\n' +
  '| `src/main/ipc.ts` | pdd / douyin 的 get-state、auto-reply、resume；PDD order 查询与 buyerReceipt 确认可选 |\n' +
  '| `src/preload/index.ts` | 受控 `window.api`，只给本地 UI 暴露明确 IPC，不给商家页任意执行能力 |\n' +
  '| `PlatformViewport.vue` | PDD URL、persist:pdd-store-default、运行状态与开关 UI |\n' +
  '| `DouyinViewport.vue` | FEIGE_URL、persist:douyin-store-default、状态与开关 UI |\n\n' +
  '这些文件全文在源码快照中。目标软件的 IPC 还应验证调用方 frame/origin、参数类型与店铺权限，不直接接受网页提交的任意脚本。\n\n' +
  '## 五、原构建配置（参考）\n' +
  ['package.json', 'electron.vite.config.ts', 'electron-builder.yml', 'vitest.config.ts'].map((relative) => section(relative)).join('\n') +
  '\n## 六、测试专用依赖\n\n' +
  'douyinAdapter.test.ts 使用 MockPlatformAdapter 提供合成规则，因此附带 mockAdapter/types/redaction 的静态源码。这些文件不含导出的真实聊天记录；目标软件可把规则 fixture 改成自己的最小对象，生产运行不需要照搬 MockPlatformAdapter。\n' +
  fixtures.map((relative) => section(relative)).join('\n') +
  '\n## 七、原离线测试全文\n\n' +
  '这些测试使用虚拟页面、合成消息与临时状态文件；页面函数测试使用 node:vm。离线通过表示对应本地逻辑通过，不表示真实平台内部接口今日仍有效。测试集不含可选 Chrome 真实登录收发验收。\n' +
  tests.map((relative) => section(relative)).join('\n')
fs.writeFileSync(path.join(outputRoot, '03_宿主接线与测试源码.md'), hostDoc, 'utf8')

const testReportFile = path.join(outputRoot, '离线测试结果.json')
let testStatus = '尚未执行本轮离线测试。\n\n'
if (fs.existsSync(testReportFile)) {
  const report = JSON.parse(fs.readFileSync(testReportFile, 'utf8'))
  testStatus = `本轮结果：${report.success ? '通过' : '有未通过项'}。${report.testResults.length} 个测试文件；` +
    `${report.numPassedTests}/${report.numTotalTests} 个测试通过。执行时间：${new Date(report.startTime).toISOString()}。\n\n` +
    '测试使用本包源码的隔离副本、虚拟页面与合成消息；没有启动店铺页面、没有向买家发送消息。为避免源码快照内原 tsconfig 继承依赖影响隔离执行，测试工程使用最小 TS 配置；业务与测试源码字节保持一致。\n\n' +
    '本轮最初遇到沙盒下配置装载与外部 TS 配置继承问题；切换 native 配置装载并建立独立测试工程后完成以下测试。这些初始问题属于测试环境准备，不是平台收发结果。\n\n' +
    '| 测试文件 | 用例数 | 结果 |\n|---|---:|---|\n' +
    report.testResults.map((result) => `| \`${path.basename(result.name)}\` | ${result.assertionResults.length} | ${result.status} |`).join('\n') + '\n\n' +
    '机器可读输出见 `离线测试结果.json`。离线通过不等于目标软件已经接入，也不等于真实平台当前接口复测通过。\n\n'
}
const guide = '# 源码清单与校验\n\n' +
  `整理日期：2026-10-02。原项目：\`${sourceRoot}\`。\n\n` +
  `本次提取 ${manifest.length} 个静态源文件 / 配置文件，合计 ${manifest.reduce((sum, item) => sum + item.bytes, 0)} 字节。每个副本与原件逐一 SHA-256 相等，并检查提取期间原文件未变化。\n\n` +
  '## 文件类别\n\n- core：核心收发与静态类型；\n- test：本地测试；\n- test-fixture：测试依赖的合成规则 / 类型 / 脱敏器；\n- host-reference：原宿主与 UI 接线参考，不是独立入口；\n- config-reference：原构建 / 依赖配置，迁入时按目标工程选择。\n\n' +
  '未导出：node_modules、out 构建物、商家 Cookie、profile 会话、运行数据库、回执、密钥、采集原始日志、旧 vendor 参考 hook。目录名与源码内商家示例文本属于静态代码，保留原样。\n\n' +
  '## 离线测试\n\n' + testStatus +
  '## 字节一致性清单\n\n| 相对路径 | 类别 | 字节 | SHA-256 |\n|---|---|---:|---|\n' +
  manifest.map((item) => `| \`${item.path}\` | ${item.category} | ${item.bytes} | \`${item.sha256}\` |`).join('\n') +
  '\n\n机器可读清单见 `源码清单.json`，含原文件时间戳。仅源码快照用于字节校验；Markdown 展示统一了换行。\n'
fs.writeFileSync(path.join(outputRoot, '04_源码清单与校验.md'), guide, 'utf8')
console.log(JSON.stringify({ exportedFiles: manifest.length, bytes: manifest.reduce((sum, item) => sum + item.bytes, 0), outputRoot }, null, 2))
