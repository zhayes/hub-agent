/**
 * 架构边界规则（ARCHITECTURE §3.1 R1–R8）
 *
 * 这里只表达"谁不能依赖谁"。R7（禁止 barrel 文件）无法用依赖规则表达，
 * 由 test/arch/no-barrel.test.ts 直接断言文件是否存在。
 *
 * 违规即 CI 失败，不允许以"先这样后面再改"为由绕过。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'R1-domain-isolation',
      comment: 'domain 不得 import 任何其他层（只允许自身与外部包）',
      severity: 'error',
      from: { path: '^packages/hub/src/domain/' },
      to: { pathNot: '^(packages/hub/src/domain/|node_modules/)' },
    },
    {
      name: 'R2-brain-no-io',
      comment: 'brain 不得 import storage / adapters（只能看快照，不能直接读写库或起进程）',
      severity: 'error',
      from: { path: '^packages/hub/src/brain/' },
      to: { path: '^packages/hub/src/(storage|adapters)/' },
    },
    {
      name: 'R3-runtime-no-pi',
      comment: 'runtime 不得 import brain/pi，只依赖 orchestrator-brain 接口',
      severity: 'error',
      from: { path: '^packages/hub/src/runtime/' },
      to: { path: '^packages/hub/src/brain/pi/' },
    },
    {
      name: 'R4-adapters-no-runtime',
      comment: 'adapters 不得 import runtime（防止反向依赖）',
      severity: 'error',
      from: { path: '^packages/hub/src/adapters/' },
      to: { path: '^packages/hub/src/runtime/' },
    },
    {
      name: 'R5-http-readonly-storage',
      comment: 'interfaces/http 可只读查询，但不得 import storage/write',
      severity: 'error',
      from: { path: '^packages/hub/src/interfaces/http/' },
      to: { path: '^packages/hub/src/storage/write' },
    },
    {
      name: 'R6-shared-is-leaf',
      comment: 'shared 不得 import 任何业务层',
      severity: 'error',
      from: { path: '^packages/hub/src/shared/' },
      to: {
        path: '^packages/hub/src/(domain|brain|runtime|adapters|agent-host|sandbox|storage|interfaces)/',
      },
    },
    {
      name: 'R8-child-process-only-in-host-and-sandbox',
      comment:
        '只有 agent-host 与 sandbox 可以直接使用 node:child_process（保证所有子进程都经过隔离层）',
      severity: 'error',
      from: {
        path: '^packages/hub/src/',
        pathNot: '^packages/hub/src/(agent-host|sandbox)/',
      },
      to: { path: '^(node:)?child_process$' },
    },
    {
      name: 'R9-agent-host-no-storage',
      comment:
        'AgentHost 不得接触 storage：拒绝启动的实现不允许顺手写任务/执行记录（记录由 Runtime 在 spawn 成功后写）',
      severity: 'error',
      from: { path: '^packages/hub/src/agent-host/' },
      to: { path: '^packages/hub/src/storage/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules|\\.test\\.ts$' },
    // TypeScript 7 的 API 不满足 dependency-cruiser 的要求，改用 swc 解析。
    // 不设这个，规则会静默空转（0 modules cruised）。
    parser: 'swc',
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/[^/]+' },
    },
  },
}
