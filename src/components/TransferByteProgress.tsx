import { useQuery } from '@tanstack/react-query'
import { formatBytes } from '@/lib/format'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { fetchQueue } from '@/rclone/queue'
import type { ByteProgress } from '@/rclone/queue-types'

export function TransferByteProgress({
    progress,
    label,
}: {
    progress?: ByteProgress
    label: string
}) {
    const t = useT()
    const percent = progress?.percent
    const known = progress?.totalKnown && typeof percent === 'number'
    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{label}</span>
                <span className="tabular-nums text-muted-foreground">
                    {known ? `${percent.toFixed(1)}%` : t('queue.calculatingSize')}
                    {progress
                        ? ` · ${formatBytes(progress.transferredBytes)} / ${progress.totalKnown ? '' : '≥ '}${formatBytes(progress.totalBytes)}`
                        : ''}
                </span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={known ? percent : undefined}
                aria-valuetext={known ? `${percent.toFixed(1)}%` : t('queue.calculatingSize')}
                className="h-2 overflow-hidden rounded-full bg-muted"
            >
                <div
                    className={`h-full rounded-full bg-emerald-500 transition-[width] ${known ? '' : 'animate-pulse'}`}
                    style={{ width: known ? `${percent}%` : '100%' }}
                />
            </div>
        </div>
    )
}

export function OverallTransferProgress() {
    const t = useT()
    const url = useStore((state) => state.url)
    const user = useStore((state) => state.user)
    const query = useQuery({
        queryKey: ['guiQueue', url, user],
        queryFn: () => fetchQueue(),
        refetchInterval: 1500,
        retry: false,
    })
    return (
        <div className="border-b px-4 py-4 sm:px-6">
            {query.isError ? (
                <p role="status" className="text-sm text-muted-foreground">
                    {t('queue.progressUnavailable')}
                </p>
            ) : (
                <TransferByteProgress
                    label={t('queue.overallProgress')}
                    progress={query.data?.progress}
                />
            )}
        </div>
    )
}
