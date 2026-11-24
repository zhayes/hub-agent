/**
 * 故意违规的 fixture 用配置：domain 反向依赖 runtime。
 * 只用于证明 R1 规则真的会让 CI 失败，不参与真实构建。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'R1-domain-isolation',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { pathNot: '^(src/domain/|node_modules/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
  },
}
