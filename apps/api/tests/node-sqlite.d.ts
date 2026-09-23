// `apps/api/tsconfig.json` 是 `"types": []`（Workers 环境，刻意不引 @types/node）。
// 但单测需要一个**真 SQL** 的内存库来当 D1 替身，Node 24 内置的 `node:sqlite` 正好合适。
// 这里只声明测试用到的那点接口，避免把整套 @types/node 拉进 Workers 程序
// （`vitest.config.ts` 的注释已说明 `NodeJS.ProcessEnv` 会污染根程序）。
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  }
}
