import { createContext } from 'react'
import { DownloadAddOptions, DownloadItem, GameInfo } from '@shared/types'

export interface DownloadContextType {
  queue: DownloadItem[]
  isLoading: boolean
  error: string | null
  addToQueue: (game: GameInfo, options?: DownloadAddOptions) => Promise<boolean>
  removeFromQueue: (releaseName: string) => Promise<void>
  cancelDownload: (releaseName: string) => void
  retryDownload: (releaseName: string) => void
  pauseDownload: (releaseName: string) => void
  resumeDownload: (releaseName: string) => void
  deleteFiles: (releaseName: string) => Promise<boolean>
}

export const DownloadContext = createContext<DownloadContextType | undefined>(undefined)
