import type { AuthErrorCode } from "./types";

/** 账号与教师管理领域错误：调用方按 code 映射冻结错误体与 HTTP 状态 */
export class AccountsError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

export class UsernameTakenError extends AccountsError {
  constructor() {
    super("username_taken", "该用户名已被使用");
    this.name = "UsernameTakenError";
  }
}

export class LastAdminProtectedError extends AccountsError {
  constructor() {
    super("last_admin_protected", "不能停用系统中最后一个管理员账号");
    this.name = "LastAdminProtectedError";
  }
}

/** 教师管理接口不得通过传入管理员 ID 修改管理员 */
export class ForbiddenTargetError extends AccountsError {
  constructor(message = "该接口只能管理教师账号") {
    super("forbidden_role", message);
    this.name = "ForbiddenTargetError";
  }
}

export class AccountNotFoundError extends AccountsError {
  constructor(message = "账号不存在") {
    super("not_found", message);
    this.name = "AccountNotFoundError";
  }
}

export class ClassNotFoundError extends AccountsError {
  constructor(message = "班级不存在") {
    super("not_found", message);
    this.name = "ClassNotFoundError";
  }
}

/** 首位管理员初始化冲突语义：沿用 state_conflict 409，不新增错误码 */
export class AdminAlreadyInitializedError extends Error {
  readonly code = "admin_already_initialized";
  constructor() {
    super("系统中已存在管理员，不能重复初始化");
    this.name = "AdminAlreadyInitializedError";
  }
}
