import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { recordAssessment } from './media.cjs'

for (const fails of [false, true]) {
  test(`should always attach video and ${fails ? 'capture' : 'omit'} a screenshot when assessment ${fails ? 'fails' : 'passes'}`, async () => {
    const calls = []
    const page = {
      screencast: {
        start: async (options) => calls.push(['start', options]),
        stop: async () => calls.push(['stop'])
      },
      locator: (selector) => selector,
      screenshot: async (options) => {
        calls.push(['screenshot', options])
        return Buffer.from('png')
      }
    }
    const info = {
      outputPath: (name) => name,
      attach: async (name, options) => calls.push(['attach', name, options])
    }
    const error = new Error('Assessment failed')
    const run = recordAssessment(page, info, async () => {
      calls.push(['assess'])
      if (fails) throw error
    })
    if (fails) await assert.rejects(run, (actual) => actual === error)
    else await run
    assert.equal(calls[0][0], 'start')
    assert.equal(calls[1][0], 'assess')
    assert.equal(calls.at(-2)[0], 'stop')
    assert.deepEqual(calls.at(-1), [
      'attach',
      'Agent assessment video',
      {
        path: 'agent-assessment.webm',
        contentType: 'video/webm'
      }
    ])
    assert.equal(
      calls.some(([type]) => type === 'screenshot'),
      fails
    )
    if (fails) {
      assert.deepEqual(calls[2], [
        'screenshot',
        {
          type: 'png',
          fullPage: true,
          mask: ['input[type="password"]']
        }
      ])
    }
  })
}

test('should save playable video and failure PNG when recording the existing Chromium page', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'onecx-agent-media-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<h1>Authenticated synthetic workspace</h1><button>Inspect</button>')
  const attachments = []
  await assert.rejects(
    recordAssessment(
      page,
      {
        outputPath: (name) => join(directory, name),
        attach: async (name, value) => attachments.push({ name, ...value })
      },
      async () => {
        await page.getByRole('button').click()
        await page.waitForTimeout(300)
        throw new Error('Synthetic observation failed')
      }
    ),
    /Synthetic observation failed/
  )
  const video = await readFile(attachments.find((attachment) => attachment.contentType === 'video/webm').path)
  assert.equal(video.subarray(0, 4).toString('hex'), '1a45dfa3')
  assert.ok(video.length > 1000)
  const png = attachments.find((attachment) => attachment.contentType === 'image/png').body
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(await page.getByRole('heading').innerText(), 'Authenticated synthetic workspace')
})
