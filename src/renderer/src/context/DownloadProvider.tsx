import React, { ReactNode, useEffect, useState, useCallback } from 'react'
import { DownloadContext, DownloadContextType } from './DownloadContext'
import { DownloadAddOptions, DownloadItem, GameInfo } from '@shared/types'

interface DownloadProviderProps {
  children: ReactNode
}

export const DownloadProvider: React.FC<DownloadProviderProps> = ({ children }) => {
  const [queue, setQueue] = useState<DownloadItem[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true) // Start loading initially
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    setIsLoading(true)

    // Fetch initial queue
    window.api.downloads
      .getQueue()
      .then((initialQueue) => {
        if (isMounted) {
          setQueue(initialQueue)
        }
      })
      .catch((err) => {
        console.error('Error fetching initial download queue:', err)
        if (isMounted) {
          setError('Failed to load download queue')
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false)
        }
      })

    const removeUpdateListener = window.api.downloads.onQueueUpdated((updatedQueue) => {
      setQueue(updatedQueue)
      setError(null)
    })

    return () => {
      isMounted = false
      removeUpdateListener()
    }
  }, [])

  const addToQueue = useCallback(async (game: GameInfo, options?: DownloadAddOptions): Promise<boolean> => {
    console.log(`Context: Adding ${game.releaseName} to queue...`)
    try {
      const success = await window.api.downloads.addToQueue(game, options)
      if (!success) {
        console.warn(
          `Context: Failed to add ${game.releaseName} to queue (likely already present).`
        )
      }
      return success
    } catch (err) {
      console.error('Error adding game to download queue via IPC:', err)
      setError(`Failed to add ${game.name} to queue.`)
      return false
    }
  }, [])

  const removeFromQueue = useCallback(async (releaseName: string): Promise<void> => {
    console.log(`Context: Removing ${releaseName} from queue...`)
    // Optimistic update? Maybe not necessary as main process handles it
    // setQueue(prev => prev.filter(item => item.releaseName !== releaseName));
    try {
      await window.api.downloads.removeFromQueue(releaseName)
    } catch (err) {
      console.error('Error removing game from download queue via IPC:', err)
      setError(`Failed to remove item from queue.`)
      // May need to refetch queue here if optimistic update was used
    }
  }, [])

  const cancelDownload = useCallback((releaseName: string): void => {
    console.log(`Context: Cancelling ${releaseName}...`)
    try {
      window.api.downloads.cancelUserRequest(releaseName)
    } catch (err) {
      console.error('Error cancelling download via IPC:', err)
      setError(`Failed to cancel download.`)
    }
  }, [])

  const retryDownload = useCallback((releaseName: string): void => {
    console.log(`Context: Retrying ${releaseName}...`)
    try {
      window.api.downloads.retryDownload(releaseName)
    } catch (err) {
      console.error('Error retrying download via IPC:', err)
      setError(`Failed to retry download.`)
    }
  }, [])

  const pauseDownload = useCallback((releaseName: string): void => {
    console.log(`Context: Pausing ${releaseName}...`)
    try {
      window.api.downloads.pauseDownload(releaseName)
    } catch (err) {
      console.error('Error pausing download via IPC:', err)
      setError(`Failed to pause download.`)
    }
  }, [])

  const resumeDownload = useCallback((releaseName: string): void => {
    console.log(`Context: Resuming ${releaseName}...`)
    try {
      window.api.downloads.resumeDownload(releaseName)
    } catch (err) {
      console.error('Error resuming download via IPC:', err)
      setError(`Failed to resume download.`)
    }
  }, [])

  const deleteFiles = useCallback(async (releaseName: string): Promise<boolean> => {
    console.log(`Context: Deleting downloaded files for ${releaseName}...`)
    try {
      const success = await window.api.downloads.deleteDownloadedFiles(releaseName)
      if (!success) {
        console.warn(`Context: Failed to delete files for ${releaseName} (backend error).`)
        setError('Failed to delete downloaded files.')
      }
      return success
    } catch (err) {
      console.error('Error deleting downloaded files via IPC:', err)
      setError('Failed to delete downloaded files.')
      return false
    }
  }, [])

  const value: DownloadContextType = {
    queue,
    isLoading,
    error,
    addToQueue,
    removeFromQueue,
    cancelDownload,
    retryDownload,
    pauseDownload,
    resumeDownload,
    deleteFiles
  }

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>
}
