import { Service } from '@deepseek-ai/cordis';
import { preparePresetProfile } from '../../dist/profile.js';

/** 使用真实加载器与预设声明，仅替换发布包准备阶段。 */
export default class ProfileUpdater {
  static inject = ['loader'];

  constructor(
    ctx,
  ) {
    this.ctx = ctx;
  }

  async *[Service.init]() {
    await preparePresetProfile(this.ctx, this.ctx.get('testDefinition'), ['persona', 'sagitta-task', 'sagitta-memory']);
    yield this.ctx.provide('sagittaReady', true);
  }
}
