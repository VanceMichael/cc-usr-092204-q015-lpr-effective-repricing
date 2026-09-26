// 领域错误：所有业务校验失败都以带编码的 DomainError 抛出，便于上层映射与审计。
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

// 正式计划/条款版本冲突：批量作业与客户变更并发时由存储层抛出，服务层负责重读重试。
export class VersionConflict extends DomainError {
  constructor(message) {
    super("VERSION_CONFLICT", message);
    this.name = "VersionConflict";
  }
}
