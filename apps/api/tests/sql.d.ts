// 测试读取正式 migration，避免复制建表语句；不向 Workers 类型环境引入 Node 全局。
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
