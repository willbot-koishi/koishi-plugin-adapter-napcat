import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adaptQQFace } from '../src/utils'

test('known QQ faces retain their image', () => {
  const face = adaptQQFace('14', 'onebot')
  assert.equal(face.attrs.id, '14')
  assert.equal(face.attrs.platform, 'onebot')
  assert.equal(face.children.length, 1)
  assert.ok(face.children[0].attrs.src)
})

test('unknown QQ faces keep their ID without an empty image', () => {
  for (const id of ['368', '379', '424', '499', '999999']) {
    const face = adaptQQFace(id, 'onebot')
    assert.equal(face.attrs.id, id)
    assert.equal(face.attrs.platform, 'onebot')
    assert.deepEqual(face.children, [])
  }
})
