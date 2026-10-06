/**
 * 教师创建 / 密码重置的安全控件衔接（TOOLS1）。
 *
 * 冻结口径（contract-v1 §5、api-contract-v1 §6 与 message-spec §3.11）：
 * - 密码只进入现有教师管理页/服务端入口，不进入模型、聊天、提案 payload、历史、事件或日志；
 * - `manage_teacher` 写工具只注册无密码动作（启停/分配/撤销任教）；
 *   新建账号与重置密码不注册为可执行操作，也不经批准账本执行；
 * - 本模块只做**公开元数据**意图投影（哪个安全控件、目标账号），
 *   不把“打开窗口”当作账号已创建或密码已重置。
 */
import {
  projectYayaSecureControlIntent,
  type YayaSecureControlIntent,
} from '../../api-contract';

export type YayaTeacherSecureControlRequest =
  | { operation: 'create'; teacher_account_id?: null }
  | { operation: 'reset_password'; teacher_account_id: string };

export class YayaSecureControlError extends Error {
  readonly code = 'secure_control_invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'YayaSecureControlError';
  }
}

/**
 * 投影安全控件意图：输入只允许 operation 与目标账号；
 * 任何 password/token/secret 类字段会被 API0 投影器递归扫描并拒绝。
 */
export function projectTeacherSecureControlIntent(
  request: YayaTeacherSecureControlRequest,
): YayaSecureControlIntent {
  const kind = request.operation === 'create' ? 'teacher_account_create' : 'teacher_password_reset';
  const projected = projectYayaSecureControlIntent({
    kind,
    target_account_id: request.operation === 'reset_password' ? request.teacher_account_id : null,
  });
  if (!projected.ok) {
    throw new YayaSecureControlError(
      `安全控件意图不合法：${projected.violations.map((violation) => violation.code).join(',')}`,
    );
  }
  return projected.value;
}
