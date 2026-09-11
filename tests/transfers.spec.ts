import { expect, test } from '@playwright/test'

const file = (name: string, completed_at: string, error = '') => ({
    name,
    completed_at,
    error,
    group: 'job/7',
    srcFs: 'Source:',
    dstFs: 'Destination:',
    bytes: 512,
    size: 1024,
})

test('compact activity keeps running files visible and sorts completions by file timestamp', async ({
    page,
}) => {
    let active = true
    await page.addInitScript(() => {
        localStorage.setItem(
            'lite-auth-store',
            JSON.stringify({
                state: { url: 'http://rc.test', user: 'fixture', pass: 'fixture' },
                version: 0,
            })
        )
    })
    await page.route('http://rc.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        const responses: Record<string, unknown> = {
            '/core/stats': {
                transferring: active
                    ? [{ ...file('active.bin', ''), speed: 128, percentage: 50 }]
                    : [],
            },
            '/core/transferred': {
                transferred: [
                    file('old.bin', '2026-09-11T10:00:00Z'),
                    file('newest.bin', '2026-09-11T12:00:00Z'),
                    file('middle.bin', '2026-09-11T11:00:00Z'),
                    file('failed.bin', '2026-09-11T13:00:00Z', 'Fixture failure'),
                    file('unknown-time.bin', 'invalid'),
                ],
            },
            '/job/status': { id: 7, finished: false, startTime: '2026-09-11T09:00:00Z' },
            '/config/listremotes': { remotes: [] },
            '/config/dump': {},
            '/core/command': { result: '' },
            '/core/disks': { disks: [] },
        }
        await route.fulfill({ json: responses[path] ?? {} })
    })
    await page.goto('/transfers')
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(6)
    for (const [index, name] of [
        'active.bin',
        'newest.bin',
        'middle.bin',
        'old.bin',
        'unknown-time.bin',
        'failed.bin',
    ].entries()) {
        await expect(rows.nth(index)).toContainText(name)
    }
    expect((await rows.first().boundingBox())?.height).toBeLessThanOrEqual(42)
    await page.screenshot({ path: 'test-results/transfers-desktop.png', fullPage: true })
    const toggle = page.getByRole('button', { name: /Transfer activity/ })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('active.bin')
    active = false
    await expect(page.getByText('No active transfers. Expand to see history.')).toBeVisible()
    await toggle.click()
    await expect(rows).toHaveCount(5)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(toggle).toBeVisible()
    await page.screenshot({ path: 'test-results/transfers-mobile.png', fullPage: true })
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
})

test('queue controls pause/resume, remove selected work, and collapse independently', async ({
    page,
}) => {
    let paused = false
    let entries = ['one.bin', 'two.bin', 'three.bin'].map((name, index) => ({
        id: `q-${index}`,
        seq: index + 1,
        srcFs: 'Source:',
        srcRemote: name,
        dstFs: 'Destination:',
        dstRemote: name,
        mode: 'copy',
        kind: 'file',
        size: 1024,
        status: 'pending',
        jobId: null,
        executeId: null,
        error: '',
    }))
    const actions: string[] = []
    await page.addInitScript(() =>
        localStorage.setItem(
            'lite-auth-store',
            JSON.stringify({
                state: { url: 'http://rc.test', user: 'fixture', pass: 'fixture' },
                version: 0,
            })
        )
    )
    await page.route('http://rc.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        expect(path).not.toMatch(/stop|delete|purge/)
        const responses: Record<string, unknown> = {
            '/job/list': { executeId: 'fixture-instance' },
            '/core/stats': {
                transferring: [{ ...file('active.bin', ''), speed: 128, percentage: 50 }],
            },
            '/core/transferred': { transferred: [file('done.bin', '2026-09-11T12:00:00Z')] },
            '/job/status': { id: 7, finished: false, startTime: '2026-09-11T09:00:00Z' },
            '/config/listremotes': { remotes: [] },
            '/config/dump': {},
            '/core/command': { result: '' },
            '/core/disks': { disks: [] },
        }
        await route.fulfill({ json: responses[path] ?? {} })
    })
    await page.route('**/api/queue**', async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (request.method() === 'POST') {
            expect(request.headers()['x-rclone-instance']).toBe('fixture-instance')
            actions.push(path)
            const body = request.postDataJSON()
            if (path.endsWith('/pause')) {
                paused = body.paused
                await route.fulfill({ json: { paused } })
                return
            }
            if (path.endsWith('/remove')) {
                const previous = entries.length
                entries = entries.filter((entry) => !body.ids.includes(entry.id))
                await route.fulfill({ json: { removed: previous - entries.length } })
                return
            }
        }
        await route.fulfill({
            json: {
                groups: entries.length
                    ? [
                          {
                              id: 'fixture-group',
                              seq: 1,
                              label: 'Fixture',
                              paused: false,
                              total: entries.length,
                              active: 1,
                              failed: 0,
                          },
                      ]
                    : [],
                paused,
                entries,
                total: entries.length,
                active: 1,
                failed: 0,
                offset: 0,
                limit: 100,
                executeId: 'fixture-instance',
                error: '',
            },
        })
    })
    await page.goto('/transfers')
    await page.getByRole('button', { name: 'Stop queue', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume queue', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Resume queue', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop queue', exact: true })).toBeEnabled()
    const queue = page.getByRole('region', { name: 'Queue', exact: true })
    await queue.getByRole('checkbox', { name: 'Select Source:one.bin', exact: true }).check()
    await queue.getByRole('checkbox', { name: 'Select Source:two.bin', exact: true }).check()
    await queue.getByRole('button', { name: 'Remove selected (2)', exact: true }).click()
    await expect(queue.locator('tbody tr')).toHaveCount(1)
    await page.screenshot({ path: 'test-results/queue-desktop.png', fullPage: true })
    const toggle = queue.getByRole('button', { name: /^Queue/ })
    await toggle.click()
    await expect(queue.getByRole('table')).toBeHidden()
    await expect(page.getByText('Source:active.bin', { exact: true })).toBeVisible()
    await toggle.click()
    await queue
        .getByRole('button', { name: 'Remove Source:three.bin from queue', exact: true })
        .click()
    await expect(queue.getByText('No waiting transfers.')).toBeVisible()
    expect(actions).toEqual([
        '/api/queue/pause',
        '/api/queue/pause',
        '/api/queue/remove',
        '/api/queue/remove',
    ])
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: 'Stop queue', exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/queue-mobile.png', fullPage: true })
})

test('separate group tables isolate stopping and checkbox removal', async ({ page }) => {
    let groupPaused = false
    let entries = ['a.bin', 'b.bin', 'c.bin'].map((name, index) => ({
        id: `q-${index}`,
        groupId: index < 2 ? 'first' : 'second',
        seq: index + 1,
        srcFs: 'Source:',
        srcRemote: name,
        dstFs: 'Destination:',
        dstRemote: name,
        mode: 'copy',
        kind: 'file',
        size: 1024,
        status: 'pending',
        jobId: null,
        executeId: null,
        error: '',
    }))
    await page.addInitScript(() =>
        localStorage.setItem(
            'lite-auth-store',
            JSON.stringify({
                state: { url: 'http://rc.test', user: 'fixture', pass: 'fixture' },
                version: 0,
            })
        )
    )
    await page.route('http://rc.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        expect(path).not.toMatch(/stop|delete|purge/)
        await route.fulfill({
            json:
                path === '/job/list'
                    ? { executeId: 'instance' }
                    : path === '/core/transferred'
                      ? { transferred: [] }
                      : path === '/config/listremotes'
                        ? { remotes: [] }
                        : {},
        })
    })
    await page.route('**/api/queue**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (request.method() === 'POST') {
            const body = request.postDataJSON()
            if (url.pathname.endsWith('/group-pause')) {
                expect(body.groupId).toBe('first')
                groupPaused = body.paused
                await route.fulfill({ json: { paused: groupPaused } })
                return
            }
            expect(url.pathname).toBe('/api/queue/remove')
            expect(body.ids).toEqual(['q-0', 'q-1'])
            entries = entries.filter((entry) => !body.ids.includes(entry.id))
            await route.fulfill({ json: { removed: 2 } })
            return
        }
        const groupId = url.searchParams.get('groupId')
        const visible = entries.filter((entry) => !groupId || entry.groupId === groupId)
        const groups = ['first', 'second']
            .map((id, index) => ({
                id,
                seq: index + 1,
                progress: {
                    transferredBytes: id === 'first' ? 550 : 0,
                    totalBytes: id === 'first' ? 1000 : 3000,
                    totalKnown: true,
                    percent: id === 'first' ? 55 : 0,
                },
                label: id,
                paused: id === 'first' && groupPaused,
                total: entries.filter((entry) => entry.groupId === id).length,
                active: 0,
                failed: 0,
            }))
            .filter((group) => group.total)
        await route.fulfill({
            json: {
                progress: {
                    transferredBytes: 550,
                    totalBytes: 4000,
                    totalKnown: true,
                    percent: 13.75,
                },
                groups,
                entries: visible,
                paused: false,
                total: visible.length,
                active: 0,
                failed: 0,
                offset: 0,
                limit: 100,
                executeId: 'instance',
                error: '',
            },
        })
    })
    await page.goto('/transfers')
    const first = page.getByRole('region', { name: 'Group #1 — first', exact: true })
    const second = page.getByRole('region', { name: 'Group #2 — second', exact: true })
    const overallProgress = page.getByRole('progressbar', {
        name: 'Overall queue progress',
        exact: true,
    })
    await expect(overallProgress).toHaveAttribute('aria-valuenow', '13.75')
    await expect(
        first.getByRole('progressbar', { name: 'Group progress', exact: true })
    ).toHaveAttribute('aria-valuenow', '55')
    expect((await overallProgress.boundingBox())!.y).toBeGreaterThan(
        (await page.getByRole('heading', { name: 'Transfers', exact: true }).boundingBox())!.y
    )
    const allQueueToggle = page
        .getByRole('region', { name: 'Queue', exact: true })
        .getByRole('button', { name: /^Queue/ })
    await allQueueToggle.click()
    await expect(overallProgress).toBeVisible()
    await expect(first).toBeHidden()
    await allQueueToggle.click()
    await expect(first.locator('tbody tr')).toHaveCount(2)
    await expect(second.locator('tbody tr')).toHaveCount(1)
    await first.getByRole('button', { name: 'Stop group', exact: true }).click()
    await expect(first.getByRole('button', { name: 'Resume group', exact: true })).toBeEnabled()
    await expect(second.getByRole('button', { name: 'Stop group', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Stop queue', exact: true })).toBeEnabled()
    await page.screenshot({ path: 'test-results/queue-groups-desktop.png', fullPage: true })
    await first.getByRole('button', { name: /^Group #1/ }).click()
    await expect(first.getByRole('table')).toBeHidden()
    await expect(
        first.getByRole('progressbar', { name: 'Group progress', exact: true })
    ).toBeVisible()
    await expect(second.getByRole('table')).toBeVisible()
    await first.getByRole('button', { name: /^Group #1/ }).click()
    await first.getByRole('checkbox', { name: 'Select all removable entries on this page' }).check()
    await expect(
        second.getByRole('checkbox', { name: 'Select Source:c.bin', exact: true })
    ).not.toBeChecked()
    await first.getByRole('button', { name: 'Resume group', exact: true }).click()
    await expect(first.getByRole('button', { name: 'Stop group', exact: true })).toBeEnabled()
    await first.getByRole('button', { name: 'Remove selected (2)', exact: true }).click()
    await expect(first).toHaveCount(0)
    await expect(second.locator('tbody tr')).toHaveCount(1)
    await page.setViewportSize({ width: 390, height: 844 })
    await second.getByRole('button', { name: 'Stop group', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/queue-groups-mobile.png', fullPage: true })
})
