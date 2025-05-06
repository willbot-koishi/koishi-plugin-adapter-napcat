import { Session } from 'koishi'
import { NapCatBot } from './bot'
import * as OneBot from './utils'

export { OneBot }

export * from './bot'
export * from './http'
export * from './ws'

export default NapCatBot

declare module '@satorijs/core' {
  interface Session {
    onebot?: OneBot.Payload & OneBot.Internal
  }
}

declare module 'koishi' {
  interface Events {
    'onebot/message-reactions-updated'(session: Session): void
    'onebot/channel-updated'(session: Session): void
    'onebot/channel-created'(session: Session): void
    'onebot/channel-destroyed'(session: Session): void
  }
}
