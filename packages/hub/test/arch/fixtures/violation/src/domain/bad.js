// 违规示例：domain 不应该依赖 runtime
import { thing } from '../runtime/thing.js'

export const broken = thing
