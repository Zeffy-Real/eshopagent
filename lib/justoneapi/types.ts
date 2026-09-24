/**
 * JustOneAPI 的对外契约类型。
 *
 * 只放「与平台无关」的部分：响应信封、平台标识、实时字段集合。
 * 各平台的原始响应结构（淘宝 `itemId` / 京东 `skuId` 之类）
 * **必须等实测拿到真实响应后再写**，不凭文档字段名猜测——见 docs/justoneapi-design.md §3 / §11.2。
 */

/**
 * 先接入的平台。
 *
 * 只接 1 个（京东或淘宝，凭实测的字段覆盖率二选一，见设计文档 §2），
 * Amazon 明确放第二批：它需要 `country` 参数与汇率折算，且美国站价格与国内目录可比性更弱。
 */
export type JustOneApiPlatform = 'jd' | 'taobao';

/**
 * 统一响应信封。
 *
 * `recordTime` 在官方文档的契约里没写，但实测返回体带这个字段（设计文档 §11.1）——
 * 保留它以免把真实响应里的字段当成未知字段处理掉。
 */
export interface JustOneApiEnvelope<T> {
  /** 0 = 成功；其它值见 errors.ts 的码表 */
  code: number;
  message: string;
  /** 成功时为业务数据；失败时为 null */
  data: T | null;
  recordTime?: string | null;
}

/**
 * 实时数据**允许覆盖**的字段集合。
 *
 * 这是「补充而不是替换」在类型层面的落地：只有易变字段可以被实时值覆盖，
 * 稳定字段（name / category / image / description / specifications / tags）一律保留快照值——
 * 它们本来就不随分钟变化，且快照里的本地化文案更好（见设计文档 §14.4）。
 */
export interface LiveProductFields {
  /** 现价（元） */
  price: number;
  /** 划线原价（元）；源里没有时省略，由调用方沿用快照值 */
  originalPrice?: number;
  /** 评分 0 - 5（源若是 10 分制，在平台映射里折算后再放进来） */
  rating?: number;
  /** 评价数 */
  reviews?: number;
  /**
   * 库存**等级代表值**（0 / 10 / 40，对应 缺货 / 紧张 / 有货），不是件数。
   *
   * 上游给的是「有货/缺货」状态而不是件数，本项目也从不展示件数（lib/types.ts 的 stock 注释）。
   * 用等级代表值编码，是为了复用现有的 `stockLevelOf()` 判定，避免出现第二套库存口径。
   */
  stock?: number;
}

