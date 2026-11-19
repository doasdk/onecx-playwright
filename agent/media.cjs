async function recordAssessment(page, testInfo, assess) {
  const videoPath = testInfo.outputPath('agent-assessment.webm')
  await page.screencast.start({ path: videoPath, size: { width: 1280, height: 720 } })
  try {
    await assess()
  } catch (error) {
    await testInfo.attach('Agent failure screenshot', {
      body: await page.screenshot({
        type: 'png',
        fullPage: true,
        mask: [page.locator('input[type="password"]')]
      }),
      contentType: 'image/png'
    })
    throw error
  } finally {
    await page.screencast.stop()
    await testInfo.attach('Agent assessment video', { path: videoPath, contentType: 'video/webm' })
  }
}

exports.recordAssessment = recordAssessment
