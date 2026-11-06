import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Universal } from 'koishi'
import { WsClient } from '../src/ws'

class Socket extends EventTarget {
  readyState = 0
  close() { this.readyState = 3 }
  send() {}
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  closed() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

function fixture() {
  const sockets: Socket[] = []
  const ctx = { on() {} }
  const bot = {
    config: { retryTimes: 0, retryInterval: 20, retryLazy: 20, responseTimeout: 100 },
    internal: {}, status: Universal.Status.CONNECT,
    logger: { warn() {} }, initialize() {},
    offline() { this.status = Universal.Status.OFFLINE },
  }
  const client = new WsClient(ctx as any, bot as any)
  client.prepare = () => {
    const socket = new Socket()
    sockets.push(socket)
    return socket as any
  }
  return { client, bot, sockets }
}

test('coalesces attempts, cancels backoff, ignores stale open/close callbacks', async () => {
  const { client, bot, sockets } = fixture()
  try {
    await client.start()
    assert.equal(client.reconnectNow(), 'connecting')
    sockets[0].open()
    assert.equal(client.reconnectNow(), 'connected')
    sockets[0].closed()
    assert.equal(client.reconnectNow(), 'accepted')
    assert.equal(client.reconnectNow(), 'connecting')
    sockets[1].open()
    sockets[0].closed()
    assert.equal(client.reconnectNow(), 'connected')
    assert.ok(bot.internal['_request'])
    await wait(40)
    assert.equal(sockets.length, 2)
    await client.stop()
    sockets[1].open()
    assert.equal(sockets[1].readyState, 3)
    assert.equal(client.reconnectNow(), 'stopped')
    await wait(40)
    assert.equal(sockets.length, 2)
  } finally {
    await client.stop()
  }
})

test('failed immediate retry returns to normal backoff', async () => {
  const { client, sockets } = fixture()
  try {
    await client.start()
    sockets[0].open()
    sockets[0].closed()
    assert.equal(client.reconnectNow(), 'accepted')
    sockets[1].closed()
    await wait(35)
    assert.equal(sockets.length, 3)
  } finally {
    await client.stop()
  }
})

test('initial retry exhaustion can be recovered manually; stop cancels the retry', async () => {
  const { client, bot, sockets } = fixture()
  try {
    await client.start()
    sockets[0].closed()
    assert.equal(bot.status, Universal.Status.OFFLINE)
    assert.equal(client.reconnectNow(), 'accepted')
    sockets[1].closed()
    assert.equal(bot.status, Universal.Status.RECONNECT)
    await client.stop()
    await wait(40)
    assert.equal(sockets.length, 2)
  } finally {
    await client.stop()
  }
})

test('prepare failure is contained and does not duplicate retry timers', async () => {
  const { client, sockets } = fixture()
  try {
    await client.start()
    sockets[0].open()
    sockets[0].closed()
    client.prepare = () => { throw new Error('local test preparation failure') }
    assert.equal(client.reconnectNow(), 'accepted')
    await client.stop()
    await wait(40)
    assert.equal(sockets.length, 1)
  } finally {
    await client.stop()
  }
})
