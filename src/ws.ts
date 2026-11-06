import { Adapter, Context, HTTP, Logger, Schema, Time, Universal } from 'koishi'
import { WebSocketLayer } from '@koishijs/plugin-server'
import { NapCatBot } from './bot'
import { dispatchSession, Response, TimeoutError } from './utils'

interface SharedConfig<T = 'ws' | 'ws-reverse'> {
  protocol: T
  responseTimeout?: number
}

export class WsClient<C extends Context = Context> extends Adapter.WsClient<C, NapCatBot<C, NapCatBot.BaseConfig & WsClient.Options>> {
  private retryTimer?: ReturnType<typeof setTimeout>
  private pending?: Universal.WebSocket
  private running = false
  private retryCount = 0

  constructor(ctx: C, bot: NapCatBot<C, NapCatBot.BaseConfig & WsClient.Options>) {
    super(ctx, bot)
    ctx.on('dispose', () => this.stop())
  }

  reconnectNow(): 'accepted' | 'connected' | 'connecting' | 'stopped' {
    if (!this.running) return 'stopped'
    if (this.socket?.readyState === 1) return 'connected'
    if (this.pending) return 'connecting'
    this.clearRetry()
    void this.open(++this.connectionId)
    return 'accepted'
  }

  async start() {
    // stop() invalidates the old generation synchronously. Do not yield here:
    // disposal between stop and start must not resurrect a connection.
    void this.stop()
    this.running = true
    this.retryCount = 0
    void this.open(++this.connectionId, true)
  }

  async stop() {
    this.running = false
    ++this.connectionId
    this.clearRetry()
    this.pending?.close()
    this.socket?.close()
    this.pending = this.socket = undefined
    delete this.bot.internal._request
  }

  private clearRetry() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private open(id: number, initial = false) {
    if (!this.running || id !== this.connectionId) return
    this.bot.status = Universal.Status.CONNECT
    let socket: Universal.WebSocket
    const current = () => this.running && id === this.connectionId
    const retry = () => {
      if (!current()) return
      const nextId = ++this.connectionId
      this.pending = this.socket = undefined
      delete this.bot.internal._request
      if (initial && this.retryCount >= this.config.retryTimes) {
        this.bot.offline(new Error('WebSocket connection retries exhausted'))
        return
      }
      const delay = this.retryCount++ >= this.config.retryTimes ? this.config.retryLazy : this.config.retryInterval
      this.bot.status = Universal.Status.RECONNECT
      this.bot.logger.warn('websocket disconnected; retry in %s', Time.format(delay))
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.open(nextId, initial)
      }, delay)
    }
    try {
      // Keep the connecting socket so repeated control requests cannot open another one.
      socket = this.prepare()
      this.pending = socket
    } catch {
      retry()
      return
    }
    if (!current()) return socket.close()
    socket.addEventListener('error', () => {
      if (current()) this.bot.logger.warn('websocket connection error')
    })
    socket.addEventListener('close', () => retry())
    socket.addEventListener('open', () => {
      if (!current()) return socket.close()
      this.pending = undefined
      this.socket = socket
      this.retryCount = 0
      // An opened transport is not proof that the QQ account is online.
      accept(socket, this.bot, current)
      initial = false
    })
  }

  accept(socket: Universal.WebSocket): void {
    accept(socket, this.bot)
  }

  prepare() {
    const { token, endpoint } = this.bot.config
    const http = this.ctx.http.extend(this.bot.config)
    if (token) http.config.headers.Authorization = `Bearer ${token}`
    return http.ws(endpoint)
  }
}

export namespace WsClient {
  export interface Options extends SharedConfig<'ws'>, HTTP.Config, Adapter.WsClientConfig {}

  export const Options: Schema<Options> = Schema.intersect([
    Schema.object({
      protocol: Schema.const('ws').required(process.env.KOISHI_ENV !== 'browser'),
      responseTimeout: Schema.natural().role('time').default(Time.minute).description('等待响应的时间 (单位为毫秒)。'),
    }).description('连接设置'),
    HTTP.createConfig(true),
    Adapter.WsClientConfig,
  ])
}

const kSocket = Symbol('socket')

export class WsServer<C extends Context> extends Adapter<C, NapCatBot<C, NapCatBot.BaseConfig & WsServer.Options>> {
  static inject = ['server']

  public logger: Logger
  public wsServer?: WebSocketLayer

  constructor(ctx: C, bot: NapCatBot<C>) {
    super(ctx)
    this.logger = ctx.logger('onebot')

    const { path = '/onebot' } = bot.config as WsServer.Options
    this.wsServer = ctx.server.ws(path, (socket, { headers }) => {
      this.logger.debug('connected with', headers)
      if (headers['x-client-role'] !== 'Universal') {
        return socket.close(1008, 'invalid x-client-role')
      }
      const selfId = headers['x-self-id'].toString()
      const bot = this.bots.find(bot => bot.selfId === selfId)
      if (!bot) return socket.close(1008, 'invalid x-self-id')

      bot[kSocket] = socket
      accept(socket as Universal.WebSocket, bot)
    })

    ctx.on('dispose', () => {
      this.logger.debug('ws server closing')
      this.wsServer.close()
    })
  }

  async disconnect(bot: NapCatBot<C>) {
    bot[kSocket]?.close()
    bot[kSocket] = null
  }
}

export namespace WsServer {
  export interface Options extends SharedConfig<'ws-reverse'> {
    path?: string
  }

  export const Options: Schema<Options> = Schema.object({
    protocol: Schema.const('ws-reverse').required(process.env.KOISHI_ENV === 'browser'),
    path: Schema.string().description('服务器监听的路径。').default('/onebot'),
    responseTimeout: Schema.natural().role('time').default(Time.minute).description('等待响应的时间 (单位为毫秒)。'),
  }).description('连接设置')
}

let counter = 0

export function accept<
  C extends Context,
  T extends NapCatBot.Config & SharedConfig,
>(socket: Universal.WebSocket, bot: NapCatBot<C, T>, isCurrent = () => true) {
  const listeners = new Map<number, { resolve: (response: Response) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  const current = () => isCurrent() && bot.internal._request === request
  socket.addEventListener('message', (event) => {
    if (!current()) return
    let parsed: any
    const data = event.data.toString()
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      return bot.logger.warn('cannot parse message', data)
    }

    if ('post_type' in parsed) {
      bot.logger.debug('[receive] %o', parsed)
      dispatchSession(bot, parsed)
    } else {
      const listener = listeners.get(parsed.echo)
      if (!listener) return
      clearTimeout(listener.timer)
      listeners.delete(parsed.echo)
      listener.resolve(parsed)
    }
  })

  socket.addEventListener('close', () => {
    for (const { timer, reject } of listeners.values()) {
      clearTimeout(timer)
      reject(new Error('OneBot WebSocket closed'))
    }
    listeners.clear()
    if (!current()) return
    delete bot.internal._request
    bot.offline()
  })

  const request: typeof bot.internal._request = (action, params) => {
    const data = { action, params, echo: ++counter }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(data.echo)
        reject(new TimeoutError(params, action))
      }, bot.config.responseTimeout)
      listeners.set(data.echo, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify(data))
      } catch (error) {
        clearTimeout(timer)
        listeners.delete(data.echo)
        reject(error)
      }
    })
  }
  bot.internal._request = request
  bot.initialize(current)
}
