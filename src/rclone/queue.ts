import { useStore } from '@/lib/store'
import rclone from '@/rclone/client'
import type { QueueSnapshot, TransferRequest } from './queue-types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const { user, pass } = useStore.getState()
    const response = await fetch(`/api/queue${path}`, {
        ...init,
        headers: {
            Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
            'Content-Type': 'application/json',
            ...init?.headers,
        },
    })
    if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Queue service unavailable. Run this GUI using its bundled server.')
    }
    const data = await response.json()
    if (!response.ok) {
        const error = data as { error?: string }
        throw new Error(error.error || 'Queue request failed')
    }
    return data as T
}

export async function fetchQueue(offset = 0, groupId?: string): Promise<QueueSnapshot> {
    const [snapshot, backend] = await Promise.all([
        request<QueueSnapshot>(
            `?offset=${offset}${groupId ? `&groupId=${encodeURIComponent(groupId)}` : ''}`
        ),
        rclone('/job/list'),
    ])
    if (!snapshot.executeId || snapshot.executeId !== backend.executeId) {
        throw new Error(
            'This queue belongs to a different rclone backend. Check the GUI connection.'
        )
    }
    return snapshot
}

export function queueAction<T>(
    action: 'pause' | 'group-pause' | 'remove' | 'enqueue',
    body: object,
    executeId: string
) {
    return request<T>(`/${action}`, {
        method: 'POST',
        headers: { 'X-Rclone-Instance': executeId },
        body: JSON.stringify(body),
    })
}

export async function enqueueTransfer(input: Omit<TransferRequest, 'requestId'>) {
    const snapshot = await fetchQueue()
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('')
    return queueAction('enqueue', { ...input, requestId }, snapshot.executeId)
}
