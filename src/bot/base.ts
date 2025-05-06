import { Bot, Context, Schema, Universal } from 'koishi'
import * as OneBot from '../utils'
import { OneBotMessageEncoder, PRIVATE_PFX } from './message'

export class BaseBot<C extends Context = Context, T extends BaseBot.Config = BaseBot.Config> extends Bot<C, T> {
  static MessageEncoder = OneBotMessageEncoder
  static inject = ['http']

  public parent?: BaseBot
  public internal: OneBot.Internal

  async createDirectChannel(userId: string) {
    return { id: `${PRIVATE_PFX}${userId}`, type: Universal.Channel.Type.DIRECT }
  }

  async getMessage(_channelId: string, messageId: string) {
    const data = await this.internal.getMsg(messageId)
    return await OneBot.adaptMessage(this, data)
  }

  async deleteMessage(_channelId: string, messageId: string) {
    await this.internal.deleteMsg(messageId)
  }

  async getLogin() {
    const data = await this.internal.getLoginInfo()
    this.user = OneBot.decodeUser(data)
    return this.toJSON()
  }

  async getUser(userId: string) {
    const data = await this.internal.getStrangerInfo(userId)
    return OneBot.decodeUser(data)
  }

  async getFriendList() {
    const data = await this.internal.getFriendList()
    return { data: data.map(OneBot.decodeUser) }
  }

  async handleFriendRequest(messageId: string, approve: boolean, comment?: string) {
    await this.internal.setFriendAddRequest(messageId, approve, comment)
  }

  async handleGuildRequest(messageId: string, approve: boolean, comment?: string) {
    await this.internal.setGroupAddRequest(messageId, 'invite', approve, comment)
  }

  async handleGuildMemberRequest(messageId: string, approve: boolean, comment?: string) {
    await this.internal.setGroupAddRequest(messageId, 'add', approve, comment)
  }

  async deleteFriend(userId: string) {
    await this.internal.deleteFriend(userId)
  }

  async getMessageList(
    channelId: string,
    seq?: string,
    direction: Universal.Direction = 'before',
    count?: number,
  ): Promise<Universal.List<Universal.Message>> {
    if (direction !== 'before' && direction !== 'after') {
      throw new Error('Unsupported direction.')
    }

    const isReverse = direction === 'before'
    const { messages } = await this.internal
      .getGroupMsgHistory(Number(channelId), seq ? Number(seq) : 0, isReverse, count)
    if (isReverse && seq) messages.pop() // remove the delimiter message

    const adaptedMessages = await Promise.all(
      messages?.map(message => OneBot.adaptMessage(this, message)),
    )

    return {
      data: adaptedMessages,
      next: adaptedMessages?.[0]?.id,
    }
  }
}

export namespace BaseBot {
  export interface Config {
    advanced?: AdvancedConfig
  }

  export interface AdvancedConfig {
    splitMixedContent?: boolean
  }

  export const AdvancedConfig: Schema<AdvancedConfig> = Schema.object({
    splitMixedContent: Schema.boolean().description('是否自动在混合内容间插入空格。').default(true),
  }).description('高级设置')
}
