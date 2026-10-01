/**
 * 生成期间证据集合发生变化时抛出的可重试错误。
 * 保存层用条件 UPDATE 比较“期望的已确认观察 id 快照”，条件不满足即抛此错误，
 * 避免迟到的模型结果覆盖较新的档案。
 */
export class StaleEvidenceError extends Error {
  constructor(message = "生成期间已有新的已确认观察，请重新生成。") {
    super(message);
    this.name = "StaleEvidenceError";
  }
}

/**
 * 记录状态与写入前提不一致（已确认或已离开待补充）时抛出，
 * 表示迟到的整理/追问请求不能改写当前记录。
 */
export class ObservationStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationStateConflictError";
  }
}
