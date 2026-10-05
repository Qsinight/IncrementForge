// ESLint 扁平配置（TECH_DESIGN 14.3「CI：lint（ESLint + Prettier）」）。
//
// 规则取向与既有实现保持一致：
// - `no-undef` 在 TS 项目里由 `tsc` 负责（类型系统比 ESLint 更准），因此关掉；
// - 保留 `no-console` 的 warn：12 的性能预算要求打包时 drop console，但运行时仍应可打点；
// - react-hooks 的两条规则开 `error`：它们直接对应 7.x 里“状态放 store、副作用收口”的写法。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'packages/num/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'no-undef': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // 编辑器是 React 应用。
    // `react-refresh/only-export-components` 关闭的原因：为了让**单测能直接断言纯逻辑**，
    // 控件文件同时导出了辅助函数（`isNumericLiteral`、`batchModeOf`、`formatWhere`…），
    // 纯函数与组件同文件在 Vite 下只影响 HMR 的粒度，不影响正确性；
    // 为此拆成几十个文件反而增加导航成本。文件内部有注释标明哪些是纯函数导出。
    files: ['apps/editor/src/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // 测试允许断言里出现非空断言与 any。
    files: ['**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Node 侧构建脚本（`.mjs`，M5 起）。
    //
    // 单独一个 block 的原因：`.mjs` **不匹配**上面那个 `**/*.{ts,tsx}` 的配置块，
    // 因此拿不到 `no-undef: 'off'` 与 browser/node 全局——脚本里的 `process`
    // 会被当成未定义变量。这些文件是 Node 脚本（`scripts/iforge-pack.mjs` 等），
    // 它们的运行时不随打包目标变化，因此 `sourceType: 'module'` + node 全局即���全。
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off',
    },
  },
)
