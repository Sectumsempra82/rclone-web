import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TransferRequest } from '../src/rclone/queue-types.js'
import { createGuiServer } from './http.js'
import { checkTransferRoots, Queue, type RC } from './queue.js'

const transfer = (name: string, isDir = false): TransferRequest => ({
    requestId: name,
    source: { fs: 'Source:', path: name, name, isDir },
    dstFs: 'Destination:',
    dstCurrentPath: '',
    mode: 'copy',
})
function backend() {
    const calls: { path: string; body: Record<string, unknown> }[] = []
    let executeId = 'instance-a'
    let finish = false
    let failNetwork = false
    let nextJob = 0
    const rc: RC = async (path, body = {}) => {
        calls.push({ path, body })
        if (failNetwork) throw new Error('Offline')
        if (path === '/job/list') return { executeId }
        if (path === '/job/status') return { executeId, finished: finish, success: true }
        if (path === '/operations/list')
            return {
                list: [
                    { Name: 'one.bin', IsDir: false, Size: 12 },
                    { Name: 'empty', IsDir: true, Size: -1 },
                ],
            }
        if (path === '/operations/fsinfo')
            return { Name: 'local', Root: `/${String(body.fs)}`, Features: {} }
        if (path === '/operations/stat') return { item: { Size: 1024 } }
        if (path === '/core/stats') return { transferring: [] }
        if (path === '/operations/mkdir') return {}
        return { jobid: ++nextJob, executeId }
    }
    return {
        rc,
        calls,
        finish: () => {
            finish = true
        },
        restart: () => {
            executeId = 'instance-b'
        },
        offline: () => {
            failNetwork = true
        },
    }
}

test('pause survives restart, drains owned jobs, protects starting files, and never stops unrelated work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-queue-'))
    const fake = backend()
    let queue = new Queue(join(dir, 'queue.sqlite'), fake.rc, 2)
    try {
        queue.enqueue(transfer('a'))
        queue.enqueue(transfer('b'))
        queue.enqueue(transfer('c'))
        queue.enqueue(transfer('a'))
        assert.equal(queue.snapshot('instance-a').total, 3)
        const ids = queue.snapshot('instance-a').entries.map((entry) => entry.id)
        await Promise.all([queue.tick(), queue.tick()])
        assert.equal(queue.snapshot('instance-a').active, 2)
        assert.equal(queue.remove([ids[0], ids[1]]), 0)
        queue.setPaused(true)
        await queue.close()
        queue = new Queue(join(dir, 'queue.sqlite'), fake.rc, 2)
        assert.equal(queue.paused, true)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 2)
        fake.finish()
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').active, 0)
        assert.equal(queue.snapshot('instance-a').total, 1)
        queue.setPaused(false)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 3)
        assert.ok(fake.calls.every((call) => !/stop|delete|purge|options/.test(call.path)))
    } finally {
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('bulk removal only removes queued work and directory expansion preserves nested paths', async () => {
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc)
    try {
        queue.enqueue(transfer('folder', true))
        await queue.tick()
        const entries = queue.snapshot('instance-a').entries
        assert.equal(entries.length, 2)
        assert.equal(entries[0].srcRemote, 'folder/one.bin')
        assert.equal(entries[0].dstRemote, 'folder/one.bin')
        assert.equal(entries[1].kind, 'directory')
        assert.equal(queue.remove(entries.map((entry) => entry.id)), 2)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 0)
        assert.ok(fake.calls.every((call) => !/delete|purge/.test(call.path)))
    } finally {
        await queue.close()
    }
})

test('folder discovery reaches a known total while all transfer slots stay occupied', async () => {
    const fake = backend()
    const listed: string[] = []
    const rc: RC = async (path, body = {}) => {
        if (path !== '/operations/list') return fake.rc(path, body)
        listed.push(String(body.remote))
        return {
            list:
                body.remote === 'folder'
                    ? [{ Name: 'nested', IsDir: true, Size: -1 }]
                    : [{ Name: 'file', IsDir: false, Size: 50 }],
        }
    }
    const queue = new Queue(':memory:', rc, 4)
    try {
        for (const name of ['a', 'b', 'c', 'd']) queue.enqueue(transfer(name))
        await queue.tick()
        queue.enqueue(transfer('folder', true))
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').progress.totalKnown, false)
        await queue.tick()
        assert.deepEqual(listed, ['folder', 'folder/nested'])
        assert.equal(queue.snapshot('instance-a').active, 4)
        assert.equal(queue.snapshot('instance-a').progress.totalKnown, true)
        assert.equal(queue.snapshot('instance-a').progress.totalBytes, 4 * 1024 + 50)
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 4)
    } finally {
        await queue.close()
    }
})

test('a slow listing permits file completion and replacement, stays single-flight, and drains on close', async () => {
    const fake = backend()
    let release!: () => void
    const listing = new Promise<void>((resolve) => {
        release = resolve
    })
    let listings = 0
    const rc: RC = async (path, body) => {
        if (path !== '/operations/list') return fake.rc(path, body)
        listings++
        await listing
        return { list: [] }
    }
    const queue = new Queue(':memory:', rc, 1)
    let pending: Promise<void> | undefined
    let closing: Promise<void> | undefined
    try {
        queue.enqueue(transfer('a'))
        await queue.tick()
        queue.enqueue(transfer('folder', true))
        pending = queue.tick()
        // Let the transfer poll finish while directory listing remains blocked.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const claimed = queue
            .snapshot('instance-a')
            .entries.find((entry) => entry.kind === 'directory')!
        assert.equal(queue.remove([claimed.id]), 0)
        queue.enqueue(transfer('b'))
        queue.enqueue(transfer('another-folder', true))
        fake.finish()
        await queue.tick()
        assert.equal(listings, 1)
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 2)
        let closed = false
        closing = queue.close().then(() => {
            closed = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(closed, false)
        release()
        await pending
        await closing
        assert.equal(listings, 1)
    } finally {
        release()
        await pending
        await (closing ?? queue.close())
    }
})

test('scanner respects global and group pauses and retains failed listings for review', async () => {
    const fake = backend()
    const listed: string[] = []
    const rc: RC = async (path, body = {}) => {
        if (path !== '/operations/list') return fake.rc(path, body)
        listed.push(String(body.remote))
        if (body.remote === 'broken') throw new Error('Listing unavailable')
        return { list: [] }
    }
    const queue = new Queue(':memory:', rc)
    try {
        queue.enqueue(transfer('paused', true))
        queue.enqueue(transfer('broken', true))
        queue.enqueue(transfer('healthy', true))
        queue.setGroupPaused('paused', true)
        queue.setPaused(true)
        await queue.tick()
        assert.deepEqual(listed, [])
        queue.setPaused(false)
        await queue.tick()
        await queue.tick()
        await queue.tick()
        assert.deepEqual(listed, ['broken', 'healthy'])
        assert.equal(queue.snapshot('instance-a').failed, 1)
        assert.match(
            queue.snapshot('instance-a', 0, 'broken').entries[0].error,
            /Listing unavailable/
        )
        queue.setGroupPaused('paused', false)
        await queue.tick()
        assert.deepEqual(listed, ['broken', 'healthy', 'paused'])
    } finally {
        await queue.close()
    }
})

test('retry resets failed files and directories without bypassing pauses or duplicating active jobs', async () => {
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc, 1)
    try {
        queue.enqueue(transfer('file'))
        const id = queue.snapshot('instance-a').entries[0].id
        assert.equal(await queue.retry(id, 'instance-a'), false)
        assert.equal(await queue.retry('missing', 'instance-a'), false)
        await queue.tick()
        assert.equal(await queue.retry(id, 'instance-a'), false)
        queue.db.prepare("UPDATE entries SET status='failed',error='Uncertain' WHERE id=?").run(id)
        await assert.rejects(queue.retry(id, 'instance-a'), /still running/)
        fake.finish()
        queue.setPaused(true)
        queue.setGroupPaused('file', true)
        assert.equal(await queue.retry(id, 'instance-a'), true)
        assert.equal(await queue.retry(id, 'instance-a'), false)
        const entry = queue.snapshot('instance-a').entries[0]
        assert.equal(entry.status, 'pending')
        assert.equal(entry.error, '')
        assert.equal(entry.jobId, null)
        assert.equal(entry.executeId, null)
        assert.equal(entry.groupId, 'file')
        assert.equal(queue.paused, true)
        assert.equal(queue.snapshot('instance-a').groups[0].paused, true)
        await queue.tick()
        queue.setPaused(false)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 1)
        queue.setGroupPaused('file', false)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 2)
        queue.enqueue(transfer('folder', true))
        const folder = queue.snapshot('instance-a', 0, 'folder').entries[0]
        queue.db
            .prepare("UPDATE entries SET status='failed',error='Listing failed' WHERE id=?")
            .run(folder.id)
        assert.equal(await queue.retry(folder.id, 'instance-a'), true)
        await queue.tick()
        assert.ok(fake.calls.some((call) => call.path === '/operations/list'))
    } finally {
        await queue.close()
    }
})

test('rclone restart quarantines old job IDs without replay or cancellation', async () => {
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc, 1)
    try {
        queue.enqueue({ ...transfer('a'), mode: 'move' })
        queue.enqueue(transfer('b'))
        await queue.tick()
        fake.restart()
        await queue.tick()
        assert.equal(queue.paused, true)
        assert.equal(queue.snapshot('instance-b').failed, 1)
        assert.equal(fake.calls.filter((call) => call.path === '/operations/movefile').length, 1)
        assert.equal(fake.calls.filter((call) => call.path === '/job/status').length, 0)
    } finally {
        await queue.close()
    }
})

test('uncertain submission pauses without automatically retrying a move', async () => {
    const fake = backend()
    const rc: RC = (path, body) =>
        path === '/operations/movefile'
            ? Promise.reject(new Error('Response lost'))
            : fake.rc(path, body)
    const queue = new Queue(':memory:', rc)
    try {
        queue.enqueue({ ...transfer('a'), mode: 'move' })
        await queue.tick()
        await queue.tick()
        assert.equal(queue.paused, true)
        assert.equal(queue.snapshot('instance-a').failed, 1)
        assert.match(queue.snapshot('instance-a').entries[0].error, /Check rclone jobs/)
    } finally {
        await queue.close()
    }
})

test('backend outages retain active state and report an error', async () => {
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc)
    try {
        queue.enqueue(transfer('a'))
        await queue.tick()
        fake.offline()
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').active, 1)
        assert.equal(queue.error, 'Offline')
    } finally {
        await queue.close()
    }
})

test('interrupted dispatch is quarantined after process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-queue-'))
    const fake = backend()
    let queue = new Queue(join(dir, 'queue.sqlite'), fake.rc)
    try {
        queue.enqueue(transfer('a'))
        queue.db.exec("UPDATE entries SET status='dispatching'")
        await queue.close()
        queue = new Queue(join(dir, 'queue.sqlite'), fake.rc)
        await queue.tick()
        assert.equal(queue.paused, true)
        assert.equal(queue.snapshot('instance-a').failed, 1)
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 0)
    } finally {
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('validates destinations and paginates large queues', async () => {
    const queue = new Queue(':memory:', backend().rc)
    try {
        assert.throws(() => queue.enqueue({ ...transfer('a'), dstCurrentPath: '../escape' }))
        assert.throws(() => queue.enqueue({ ...transfer('a'), dstFs: 'Source:' }))
        for (let i = 0; i < 205; i++) queue.enqueue(transfer(`file-${i}`))
        assert.equal(queue.snapshot('instance-a').entries.length, 100)
        assert.equal(queue.snapshot('instance-a', 200).entries.length, 5)
    } finally {
        await queue.close()
    }
})

test('HTTP API authenticates, rejects wrong backend/cross-origin calls and serves the GUI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-http-'))
    await writeFile(join(dir, 'index.html'), '<h1>Fixture GUI</h1>')
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc)
    const authorization = `Basic ${Buffer.from('fixture:fixture').toString('base64')}`
    const server = createGuiServer(queue, fake.rc, authorization, dir)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const headers = {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-Rclone-Instance': 'instance-a',
    }
    try {
        assert.match(await (await fetch(base)).text(), /Fixture GUI/)
        assert.equal((await fetch(`${base}/api/queue`)).status, 401)
        assert.equal(
            (
                await fetch(`${base}/api/queue/pause`, {
                    method: 'POST',
                    headers: { ...headers, Origin: 'https://other.test' },
                    body: '{"paused":true}',
                })
            ).status,
            403
        )
        assert.equal(
            (
                await fetch(`${base}/api/queue/pause`, {
                    method: 'POST',
                    headers: { ...headers, 'X-Rclone-Instance': 'wrong' },
                    body: '{"paused":true}',
                })
            ).status,
            409
        )
        assert.equal(
            (
                await fetch(`${base}/api/queue/enqueue`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(transfer('a')),
                })
            ).status,
            202
        )
        assert.equal(
            (
                await fetch(`${base}/api/queue/pause`, {
                    method: 'POST',
                    headers,
                    body: '{"paused":true}',
                })
            ).status,
            200
        )
        assert.equal(queue.paused, true)
        assert.equal(
            (
                await fetch(`${base}/api/queue/group-pause`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ groupId: 'a', paused: true }),
                })
            ).status,
            200
        )
        assert.equal(queue.snapshot('instance-a').groups[0].paused, true)
        assert.equal(
            (
                await fetch(`${base}/api/queue/group-pause`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ groupId: 'missing', paused: true }),
                })
            ).status,
            404
        )
        const id = queue.snapshot('instance-a').entries[0].id
        const retry = (body: object) =>
            fetch(`${base}/api/queue/retry`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            })
        assert.equal((await retry({ id: 123 })).status, 400)
        assert.equal((await retry({ id })).status, 409)
        queue.db.prepare("UPDATE entries SET status='failed',error='Failed' WHERE id=?").run(id)
        assert.equal((await retry({ id })).status, 200)
        assert.equal((await retry({ id })).status, 409)
        const response = await fetch(`${base}/api/queue/remove`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ids: [id] }),
        })
        assert.deepEqual(await response.json(), { removed: 1 })
        assert.equal(fake.calls.filter((call) => /delete|stop|purge/.test(call.path)).length, 0)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('resolved aliases cannot create a recursive copy into the source', async () => {
    const rc: RC = async () => ({ Name: 'local', Root: '/same/path', Features: {} })
    await assert.rejects(
        checkTransferRoots(rc, { ...transfer('folder', true), dstCurrentPath: 'folder' }),
        /inside the source/
    )
})

test('group pause persists and skips only its descendants while another group runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-group-'))
    const fake = backend()
    let queue = new Queue(join(dir, 'queue.sqlite'), fake.rc, 1)
    try {
        queue.enqueue(transfer('folder', true))
        await queue.tick()
        assert.ok(
            queue
                .snapshot('instance-a', 0, 'folder')
                .entries.every((entry) => entry.groupId === 'folder')
        )
        queue.setGroupPaused('folder', true)
        queue.enqueue(transfer('other'))
        await queue.close()
        queue = new Queue(join(dir, 'queue.sqlite'), fake.rc, 1)
        assert.equal(
            queue.snapshot('instance-a').groups.find((group) => group.id === 'folder')?.paused,
            true
        )
        await queue.tick()
        const copies = fake.calls.filter((call) => call.path === '/operations/copyfile')
        assert.deepEqual(
            copies.map((call) => call.body.srcRemote),
            ['other']
        )
        queue.setPaused(true)
        queue.setPaused(false)
        assert.equal(
            queue.snapshot('instance-a').groups.find((group) => group.id === 'folder')?.paused,
            true
        )
        fake.finish()
        queue.setGroupPaused('folder', false)
        await queue.tick()
        assert.equal(fake.calls.filter((call) => call.path === '/operations/copyfile').length, 2)
        assert.equal(queue.setGroupPaused('missing', true), false)
        assert.ok(fake.calls.every((call) => !call.path.includes('/job/stop')))
    } finally {
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('group paging includes only its own files and independent totals', async () => {
    const fake = backend()
    const rc: RC = async (path, body) =>
        path === '/operations/list'
            ? {
                  list: Array.from({ length: 105 }, (_, i) => ({
                      Name: `f${i}`,
                      IsDir: false,
                      Size: 1,
                  })),
              }
            : fake.rc(path, body)
    const queue = new Queue(':memory:', rc, 1)
    try {
        queue.enqueue(transfer('folder', true))
        await queue.tick()
        queue.setGroupPaused('folder', true)
        queue.enqueue(transfer('other'))
        const page = queue.snapshot('instance-a', 100, 'folder')
        assert.equal(page.total, 105)
        assert.equal(page.entries.length, 5)
        assert.ok(page.entries.every((entry) => entry.groupId === 'folder'))
        assert.equal(queue.snapshot('instance-a', 0, 'other').entries.length, 1)
    } finally {
        await queue.close()
    }
})

test('old queue database migrates without losing pending entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-migration-'))
    const path = join(dir, 'queue.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        srcFs TEXT NOT NULL, srcRemote TEXT NOT NULL, dstFs TEXT NOT NULL, dstRemote TEXT NOT NULL,
        mode TEXT NOT NULL, kind TEXT NOT NULL, size REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', jobId INTEGER, executeId TEXT, error TEXT NOT NULL DEFAULT ''
    ); INSERT INTO entries (id,srcFs,srcRemote,dstFs,dstRemote,mode,kind) VALUES ('old','Source:','file','Destination:','file','copy','file');`)
    old.close()
    const queue = new Queue(path, backend().rc)
    try {
        const state = queue.snapshot('instance-a')
        assert.equal(state.entries[0].id, 'old')
        assert.equal(state.entries[0].groupId, 'legacy')
        assert.equal(state.groups[0].label, 'Existing queue')
        queue.setGroupPaused('legacy', true)
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').total, 1)
    } finally {
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('byte progress weights file sizes, includes live bytes, and survives restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-bytes-'))
    let smallFinished = false
    const jobs = new Map<number, string>()
    let jobId = 0
    const rc: RC = async (path, body = {}) => {
        if (path === '/job/list') return { executeId: 'instance' }
        if (path === '/operations/list')
            return {
                list:
                    body.remote === 'first'
                        ? [
                              { Name: 'small', Size: 100, IsDir: false },
                              { Name: 'big', Size: 900, IsDir: false },
                          ]
                        : [{ Name: 'other', Size: 3000, IsDir: false }],
            }
        if (path === '/operations/stat')
            return {
                item: {
                    Size: String(body.remote).endsWith('small')
                        ? 100
                        : String(body.remote).endsWith('big')
                          ? 900
                          : 3000,
                },
            }
        if (path === '/operations/mkdir') return {}
        if (path === '/operations/copyfile') {
            jobs.set(++jobId, String(body.srcRemote))
            return { executeId: 'instance', jobid: jobId }
        }
        if (path === '/job/status')
            return {
                executeId: 'instance',
                finished: smallFinished && jobs.get(Number(body.jobid)) === 'first/small',
                success: true,
            }
        if (path === '/core/stats')
            return { transferring: [{ bytes: body.group === 'job/2' ? 450 : 0 }] }
        throw new Error(path)
    }
    let queue = new Queue(join(dir, 'queue.sqlite'), rc, 2)
    try {
        queue.enqueue(transfer('first', true))
        queue.enqueue(transfer('second', true))
        assert.equal(queue.snapshot('instance').progress.percent, null)
        await queue.tick()
        await queue.tick()
        smallFinished = true
        await queue.tick()
        const first = queue.snapshot('instance').groups.find((group) => group.id === 'first')!
        assert.equal(first.progress.transferredBytes, 550)
        assert.equal(first.progress.totalBytes, 1000)
        assert.ok(Math.abs(first.progress.percent! - 55) < 0.001)
        assert.equal(queue.snapshot('instance').progress.totalBytes, 4000)
        assert.ok(Math.abs(queue.snapshot('instance').progress.percent! - 13.75) < 0.001)
        await queue.close()
        queue = new Queue(join(dir, 'queue.sqlite'), rc, 2)
        await queue.tick()
        assert.equal(
            queue.snapshot('instance').groups.find((group) => group.id === 'first')!.progress
                .transferredBytes,
            550
        )
    } finally {
        await queue.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('removal adjusts bytes and completion remains visible until the next queue batch', async () => {
    const fake = backend()
    const queue = new Queue(':memory:', fake.rc, 1)
    try {
        queue.enqueue({ ...transfer('a'), source: { ...transfer('a').source, size: 1024 } })
        queue.enqueue({ ...transfer('b'), source: { ...transfer('b').source, size: 2048 } })
        assert.equal(queue.snapshot('instance-a').progress.totalBytes, 3072)
        await queue.tick()
        queue.setPaused(true)
        fake.finish()
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').progress.transferredBytes, 1024)
        queue.remove(queue.snapshot('instance-a', 0, 'b').entries.map((entry) => entry.id))
        const done = queue.snapshot('instance-a')
        assert.equal(done.progress.totalBytes, 1024)
        assert.equal(done.progress.percent, 100)
        assert.equal(done.groups[0].progress.percent, 100)
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').progress.transferredBytes, 1024)
        queue.enqueue(transfer('new-batch'))
        assert.equal(queue.snapshot('instance-a').progress.transferredBytes, 0)
        assert.equal(queue.snapshot('instance-a').progress.percent, null)
    } finally {
        await queue.close()
    }
})

test('zero-byte files finish without NaN or a file-count approximation', async () => {
    const fake = backend()
    const rc: RC = (path, body) =>
        path === '/operations/stat' ? Promise.resolve({ item: { Size: 0 } }) : fake.rc(path, body)
    const queue = new Queue(':memory:', rc)
    try {
        queue.enqueue(transfer('empty'))
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').progress.percent, 0)
        fake.finish()
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').progress.percent, 100)
        assert.equal(queue.snapshot('instance-a').progress.totalBytes, 0)
    } finally {
        await queue.close()
    }
})

test('unavailable size metadata does not block copying or fabricate a percentage', async () => {
    const fake = backend()
    const rc: RC = (path, body) =>
        path === '/operations/stat'
            ? Promise.reject(new Error('Metadata unavailable'))
            : fake.rc(path, body)
    const queue = new Queue(':memory:', rc)
    try {
        queue.enqueue(transfer('unknown'))
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').active, 1)
        fake.finish()
        await queue.tick()
        assert.equal(queue.snapshot('instance-a').failed, 0)
        assert.equal(queue.snapshot('instance-a').progress.percent, null)
    } finally {
        await queue.close()
    }
})
