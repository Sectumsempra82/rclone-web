import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRC } from './http.js'
import { checkTransferRoots, Queue } from './queue.js'

const binary = process.env.RCLONE_TEST_BIN

test('real rclone: nested files, empty directories, removal, and move use only isolated temporary data', {
    skip: !binary,
    timeout: 30000,
}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gui-rclone-integration-'))
    const source = join(dir, 'source').replaceAll('\\', '/') + '/'
    const destination = join(dir, 'destination').replaceAll('\\', '/') + '/'
    await mkdir(join(source, 'folder', 'empty'), { recursive: true })
    await mkdir(destination)
    await writeFile(join(source, 'folder', 'keep.bin'), 'copy fixture contents')
    await writeFile(join(source, 'folder', 'remove.bin'), 'must not be copied')
    await writeFile(join(source, 'move.bin'), 'move fixture contents')
    await writeFile(join(dir, 'rclone.conf'), `[Alias]\ntype = alias\nremote = ${source}\n`)
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    const process = spawn(
        binary!,
        [
            'rcd',
            '--rc-addr',
            `127.0.0.1:${port}`,
            '--rc-user',
            'fixture',
            '--rc-pass',
            'fixture',
            '--config',
            join(dir, 'rclone.conf'),
        ],
        { windowsHide: true, stdio: 'ignore' }
    )
    const rc = createRC(
        `http://127.0.0.1:${port}`,
        `Basic ${Buffer.from('fixture:fixture').toString('base64')}`
    )
    let queue: Queue | undefined
    try {
        let ready = false
        for (let i = 0; i < 60; i++) {
            try {
                await rc('/job/list')
                ready = true
                break
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        }
        assert.ok(ready, 'local rclone should start')
        await assert.rejects(
            checkTransferRoots(rc, {
                requestId: 'overlap',
                source: { fs: source, path: 'folder', name: 'folder', isDir: true },
                dstFs: 'Alias:',
                dstCurrentPath: 'folder',
                mode: 'copy',
            }),
            /inside the source/
        )
        queue = new Queue(join(dir, 'queue.sqlite'), rc, 2)
        queue.enqueue({
            requestId: 'folder-copy',
            source: { fs: source, path: 'folder', name: 'folder', isDir: true },
            dstFs: destination,
            dstCurrentPath: '',
            mode: 'copy',
        })
        await queue.tick()
        const snapshot = queue.snapshot('test')
        const removed = snapshot.entries.find((entry) => entry.srcRemote === 'folder/remove.bin')
        assert.ok(removed)
        assert.equal(queue.remove([removed.id]), 1)
        queue.enqueue({
            requestId: 'file-move',
            source: { fs: source, path: 'move.bin', name: 'move.bin', isDir: false },
            dstFs: destination,
            dstCurrentPath: '',
            mode: 'move',
        })
        for (let i = 0; i < 60; i++) {
            await queue.tick()
            const state = queue.snapshot('test')
            assert.equal(state.error, '')
            assert.equal(state.failed, 0, JSON.stringify(state.entries))
            if (state.total === 0 && state.active === 0) break
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(queue.snapshot('test').active, 0)
        assert.equal(queue.snapshot('test').total, 0)
        assert.equal(
            await readFile(join(destination, 'folder', 'keep.bin'), 'utf8'),
            'copy fixture contents'
        )
        assert.equal((await stat(join(destination, 'folder', 'empty'))).isDirectory(), true)
        await assert.rejects(stat(join(destination, 'folder', 'remove.bin')))
        assert.equal(
            await readFile(join(source, 'folder', 'remove.bin'), 'utf8'),
            'must not be copied'
        )
        assert.equal(await readFile(join(destination, 'move.bin'), 'utf8'), 'move fixture contents')
        await assert.rejects(stat(join(source, 'move.bin')))
    } finally {
        await queue?.close()
        const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()))
        process.kill()
        await exited
        await rm(dir, { recursive: true, force: true })
    }
})
