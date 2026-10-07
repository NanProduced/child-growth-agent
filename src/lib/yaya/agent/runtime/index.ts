/**
 * 芽芽正式运行服务（AGENT-APP1）导出。
 *
 * 消费口径：
 * - 路由：`startYayaRun` / `lookupYayaRun` / `cancelYayaRun`；
 * - TOOLS1 集成：`createYayaRunDependencies` 的 `write` 绑定 + `assertYayaRunActive`
 *   同 client 保存钩子。
 */
export * from './registry';
export * from './store';
export * from './context';
export * from './identity';
export * from './deps';
export * from './service';
