import { join } from 'path'
import { promises as fs, createReadStream, createWriteStream, promises as fsPromises } from 'fs'
import { execa, ExecaError } from 'execa'
import crypto from 'crypto'
import { tmpdir } from 'os'
import { QueueManager } from './queueManager'
import dependencyService from '../dependencyService'
import mirrorService from '../mirrorService'
import settingsService from '../settingsService'
import { DownloadItem } from '@shared/types'
import { DownloadStatus } from '@shared/types'
import { getAvailableDiskSpace, parseSizeToBytes, formatBytes } from './utils'

// Type for VRP config - adjust if needed elsewhere
interface VrpConfig {
  baseUri?: string
  password?: string
}

// Unified download controller that handles both download cancellation and mount process
interface DownloadController {
  cancel: () => void // Cancel the download streams
  mountProcess?: ReturnType<typeof execa> // Optional mount process to kill
}

export class DownloadProcessor {
  private activeDownloads: Map<string, DownloadController> = new Map()
  private queueManager: QueueManager
  private vrpConfig: VrpConfig | null = null
  private debouncedEmitUpdate: () => void

  constructor(queueManager: QueueManager, debouncedEmitUpdate: () => void) {
    this.queueManager = queueManager
    this.debouncedEmitUpdate = debouncedEmitUpdate
  }

  public setVrpConfig(config: VrpConfig | null): void {
    this.vrpConfig = config
  }

  // Add getter for vrpConfig
  public getVrpConfig(): VrpConfig | null {
    return this.vrpConfig
  }

  // Centralized update method using QueueManager and emitting update
  private updateItemStatus(
    releaseName: string,
    status: DownloadStatus,
    progress: number,
    error?: string,
    speed?: string,
    eta?: string,
    extractProgress?: number
  ): void {
    const updates: Partial<DownloadItem> = { status, progress, error, speed, eta }
    if (extractProgress !== undefined) {
      updates.extractProgress = extractProgress
    } else if (status !== 'Extracting' && status !== 'Completed') {
      updates.extractProgress = undefined
    }
    const updated = this.queueManager.updateItem(releaseName, updates)
    if (updated) {
      this.debouncedEmitUpdate() // Use the passed-in emitter
    }
  }

  public cancelDownload(
    releaseName: string,
    finalStatus: 'Cancelled' | 'Error' = 'Cancelled',
    errorMsg?: string
  ): void {
    // Cancel download and clean up mount process
    const downloadController = this.activeDownloads.get(releaseName)
    if (downloadController) {
      console.log(`[DownProc] Cancelling download for ${releaseName}...`)
      try {
        downloadController.cancel()
        console.log(`[DownProc] Cancelled download for ${releaseName}.`)
      } catch (cancelError) {
        console.error(`[DownProc] Error cancelling download for ${releaseName}:`, cancelError)
      }

      // Clean up mount process if it exists
      if (downloadController.mountProcess) {
        console.log(`[DownProc] Cleaning up mount process for ${releaseName}...`)
        try {
          downloadController.mountProcess.kill('SIGTERM')
          console.log(`[DownProc] Terminated mount process for ${releaseName}.`)
        } catch (killError) {
          console.warn(`[DownProc] Failed to kill mount process for ${releaseName}:`, killError)
        }
      }

      this.activeDownloads.delete(releaseName)
    } else {
      console.log(`[DownProc] No active download found for ${releaseName} to cancel.`)
    }

    // QueueManager handles the status update logic now
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      const updates: Partial<DownloadItem> = { pid: undefined }
      if (!(item.status === 'Error' && finalStatus === 'Cancelled')) {
        updates.status = finalStatus
      }
      if (finalStatus === 'Cancelled') {
        updates.progress = 0
      }
      if (finalStatus === 'Error') {
        updates.error = errorMsg || item.error
      } else {
        updates.error = undefined
      }

      const updated = this.queueManager.updateItem(releaseName, updates)
      if (updated) {
        console.log(
          `[DownProc] Updated status for ${releaseName} to ${finalStatus} via QueueManager.`
        )
        this.debouncedEmitUpdate() // Ensure UI update on cancel
      } else {
        console.warn(`[DownProc] Failed to update item ${releaseName} during cancellation.`)
      }
    } else {
      console.warn(`[DownProc] Item ${releaseName} not found in queue during cancellation.`)
    }
    // The main service will handle resetting isProcessing and calling processQueue
  }

  public async startDownload(
    item: DownloadItem
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Starting download for ${item.releaseName}...`)

    if (!this.vrpConfig?.baseUri || !this.vrpConfig?.password) {
      console.error('[DownProc] Missing VRP baseUri or password.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Missing VRP configuration')
      return { success: false, startExtraction: false }
    }

    const rclonePath = dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    const downloadPath = join(item.downloadPath, item.releaseName)
    this.queueManager.updateItem(item.releaseName, { downloadPath: downloadPath })

    try {
      await fs.mkdir(downloadPath, { recursive: true })
    } catch (mkdirError: unknown) {
      let errorMsg = `Failed to create directory ${downloadPath}`
      if (mkdirError instanceof Error) {
        errorMsg = `Failed to create directory: ${mkdirError.message}`
      }
      console.error(`[DownProc] Failed to create download directory ${downloadPath}:`, mkdirError)
      this.updateItemStatus(item.releaseName, 'Error', 0, errorMsg.substring(0, 500))
      return { success: false, startExtraction: false }
    }

    // Check available disk space before starting download
    console.log(`[DownProc] Checking available disk space for ${item.releaseName}...`)
    const availableSpace = await getAvailableDiskSpace(item.downloadPath)
    const gameSizeBytes = item.size ? parseSizeToBytes(item.size) : 0
    const requiredSpace = gameSizeBytes * 2 // Double the game size for download + extraction

    if (availableSpace === null) {
      console.warn(`[DownProc] Could not determine available disk space for ${item.releaseName}`)
      // Continue anyway since we couldn't determine space
    } else if (requiredSpace > 0 && availableSpace < requiredSpace) {
      const errorMsg = `Insufficient disk space. Required: ${formatBytes(requiredSpace)}, Available: ${formatBytes(availableSpace)}`
      console.error(`[DownProc] ${errorMsg} for ${item.releaseName}`)
      this.updateItemStatus(item.releaseName, 'Error', 0, errorMsg)
      return { success: false, startExtraction: false }
    } else if (requiredSpace > 0) {
      console.log(
        `[DownProc] Disk space check passed for ${item.releaseName}. Game size: ${item.size}, Available: ${formatBytes(availableSpace)}, Required: ${formatBytes(requiredSpace)}`
      )
    } else {
      console.warn(
        `[DownProc] Could not determine game size for ${item.releaseName}, skipping disk space check`
      )
    }

    this.updateItemStatus(item.releaseName, 'Downloading', 0)

    // Check if there's an active mirror to use
    const activeMirror = await mirrorService.getActiveMirror()

    if (activeMirror) {
      console.log(`[DownProc] Using active mirror: ${activeMirror.name}`)

      // Get the config file path and remote name
      const configFilePath = mirrorService.getActiveMirrorConfigPath()
      const remoteName = mirrorService.getActiveMirrorRemoteName()

      if (!configFilePath || !remoteName) {
        console.warn(
          '[DownProc] Failed to get mirror config file path, falling back to public endpoint'
        )
        // Fall back to public endpoint logic below
      } else {
        try {
          // Use mount-based download with mirror configuration
          console.log(`[DownProc] Using mount-based download with mirror: ${activeMirror.name}`)
          return await this.startMountBasedDownload(item, {
            configFilePath,
            remoteName
          })
        } catch (mirrorError: unknown) {
          if (this.isFuseMissingError(mirrorError)) {
            console.warn(
              `[DownProc] FUSE not available. Falling back to public endpoint direct download for ${item.releaseName}.`
            )
            return await this.startPublicEndpointDownload(item)
          }
          console.error(
            `[DownProc] Mirror mount-based download failed for ${item.releaseName}, falling back to public endpoint:`,
            mirrorError
          )
          // Fall through to public endpoint logic
        }
      }
    }

    // Fall back to public endpoint using mount-based download (rclone mount + aria2c)
    console.log(`[DownProc] Using mount-based download for public endpoint: ${item.releaseName}`)
    try {
      return await this.startMountBasedDownload(item)
    } catch (error: unknown) {
      if (this.isFuseMissingError(error)) {
        console.warn(
          `[DownProc] FUSE not available. Falling back to public endpoint direct download for ${item.releaseName}.`
        )
        return await this.startPublicEndpointDownload(item)
      }
      throw error
    }
  }

  private async startPublicEndpointDownload(
    item: DownloadItem
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Using public endpoint for ${item.releaseName}`)

    if (!this.vrpConfig?.baseUri || !this.vrpConfig?.password) {
      console.error('[DownProc] Missing VRP baseUri or password.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Missing VRP configuration')
      return { success: false, startExtraction: false }
    }

    const rclonePath = dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    const downloadPath = join(item.downloadPath, item.releaseName)
    this.queueManager.updateItem(item.releaseName, { downloadPath: downloadPath })

    const gameNameHash = crypto
      .createHash('md5')
      .update(item.releaseName + '\n')
      .digest('hex')
    const source = `:http:/${gameNameHash}`

    const rcloneArgs = [
      'copy',
      source,
      downloadPath,
      '--http-url',
      this.vrpConfig.baseUri,
      '--no-check-certificate',
      '--progress',
      '--stats',
      '1s',
      '--stats-one-line'
    ]

    const rcloneLogTail: string[] = []
    const maxLogLines = 50
    const pushLogLine = (line: string): void => {
      const trimmed = line.replace(/\r?\n$/, '')
      if (!trimmed) return
      rcloneLogTail.push(trimmed)
      if (rcloneLogTail.length > maxLogLines) {
        rcloneLogTail.shift()
      }
    }

    let lastProgress = -1
    const handleRcloneOutput = (chunk: Buffer): void => {
      const text = chunk.toString().replace(/\r/g, '\n')
      const lines = text.split(/\n/)
      for (const line of lines) {
        if (line) {
          console.log(`[DownProc][rclone] ${line}`)
          pushLogLine(line)

          const progressMatch =
            line.match(/Transferred:.*?(\d+)%/) || line.match(/,\s*(\d+)%\s*,/)
          if (progressMatch && progressMatch[1]) {
            const progress = Number(progressMatch[1])
            if (!Number.isNaN(progress) && progress !== lastProgress) {
              lastProgress = progress

              const speedMatch = line.match(/,\s*([0-9.]+\s*\w+\/s)(?:,|$)/)
              const etaMatch = line.match(/ETA\s+([0-9hms:]+|[-]+)\b/i)

              this.updateItemStatus(
                item.releaseName,
                'Downloading',
                progress,
                undefined,
                speedMatch?.[1],
                etaMatch?.[1]
              )
            }
          }
        }
      }
    }

    try {
      this.updateItemStatus(item.releaseName, 'Downloading', 0)

      const rcloneProcess = execa(rclonePath, rcloneArgs, {
        all: true,
        buffer: false,
        windowsHide: true
      })

      if (rcloneProcess.all) {
        rcloneProcess.all.on('data', handleRcloneOutput)
      }

      this.activeDownloads.set(item.releaseName, {
        cancel: () => {
          rcloneProcess.kill('SIGTERM')
        },
        mountProcess: rcloneProcess
      })

      console.log(
        `[DownProc] rclone process started for ${item.releaseName} with PID: ${rcloneProcess.pid}`
      )

      await rcloneProcess

      this.activeDownloads.delete(item.releaseName)
      this.queueManager.updateItem(item.releaseName, { pid: undefined })

      this.updateItemStatus(item.releaseName, 'Downloading', 100)
      console.log(
        `[DownProc] rclone process finished successfully for ${item.releaseName}.`
      )

      return {
        success: true,
        startExtraction: true,
        finalState: this.queueManager.findItem(item.releaseName)
      }
    } catch (error: unknown) {
      const isExecaError = (err: unknown): err is ExecaError =>
        typeof err === 'object' && err !== null && 'shortMessage' in err
      const currentItemState = this.queueManager.findItem(item.releaseName)
      const statusBeforeCatch = currentItemState?.status ?? 'Unknown'

      console.error(`[DownProc] rclone download error for ${item.releaseName}:`, error)
      if (rcloneLogTail.length > 0) {
        console.error(`[DownProc] rclone log tail:\n${rcloneLogTail.join('\n')}`)
      }

      if (this.activeDownloads.has(item.releaseName)) {
        this.activeDownloads.delete(item.releaseName)
        this.queueManager.updateItem(item.releaseName, { pid: undefined })
      }

      if (isExecaError(error) && error.exitCode === 143) {
        console.log(`[DownProc] rclone download cancelled for ${item.releaseName}`)
        return { success: false, startExtraction: false, finalState: currentItemState }
      }

      let errorMessage = 'Public endpoint download failed.'
      if (isExecaError(error)) {
        errorMessage = error.shortMessage || error.message
      } else if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = String(error)
      }
      errorMessage = errorMessage.substring(0, 500)

      if (statusBeforeCatch !== 'Cancelled' && statusBeforeCatch !== 'Error') {
        this.updateItemStatus(
          item.releaseName,
          'Error',
          currentItemState?.progress ?? 0,
          errorMessage
        )
      }

      return {
        success: false,
        startExtraction: false,
        finalState: this.queueManager.findItem(item.releaseName)
      }
    }
  }

  // Mount-based download using rclone mount + rsync for better pause/resume
  public async startMountBasedDownload(
    item: DownloadItem,
    mirrorConfig?: { configFilePath: string; remoteName: string }
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Starting mount-based download for ${item.releaseName}...`)

    if (!this.vrpConfig?.baseUri || !this.vrpConfig?.password) {
      console.error('[DownProc] Missing VRP baseUri or password.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Missing VRP configuration')
      return { success: false, startExtraction: false }
    }

    const rclonePath = dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    const downloadPath = join(item.downloadPath, item.releaseName)
    this.queueManager.updateItem(item.releaseName, { downloadPath: downloadPath })

    // Create unique mount point for this download (sanitize name to avoid issues)
    const sanitizedName = item.releaseName.replace(/[^a-zA-Z0-9-]/g, '_')
    const mountPoint = join(tmpdir(), `apprenticevr-mount-${sanitizedName}-${Date.now()}`)

    try {
      // Create download directory
      await fs.mkdir(downloadPath, { recursive: true })

      // Create mount point directory
      await fs.mkdir(mountPoint, { recursive: true })
      console.log(`[DownProc] Created mount point: ${mountPoint}`)

      // Check available disk space
      const availableSpace = await getAvailableDiskSpace(item.downloadPath)
      const gameSizeBytes = item.size ? parseSizeToBytes(item.size) : 0
      const requiredSpace = gameSizeBytes * 2

      if (availableSpace !== null && requiredSpace > 0 && availableSpace < requiredSpace) {
        const errorMsg = `Insufficient disk space. Required: ${formatBytes(requiredSpace)}, Available: ${formatBytes(availableSpace)}`
        console.error(`[DownProc] ${errorMsg} for ${item.releaseName}`)
        this.updateItemStatus(item.releaseName, 'Error', 0, errorMsg)
        await this.cleanup(mountPoint, item.releaseName)
        return { success: false, startExtraction: false }
      }

      this.updateItemStatus(item.releaseName, 'Downloading', 0)

      // Set up source and mount arguments based on mirror config or public endpoint
      let source: string
      let mountArgs: string[]

      if (mirrorConfig) {
        // Use mirror configuration
        source = `${mirrorConfig.remoteName}:/Quest Games/${item.releaseName}`
        console.log(`[DownProc] Using mirror mount: ${source}`)

        mountArgs = [
          'mount',
          source,
          mountPoint,
          '--config',
          mirrorConfig.configFilePath,
          '--no-check-certificate',
          '--read-only',
          '--vfs-cache-mode',
          'minimal',
          '--vfs-read-ahead',
          '128M'
        ]
      } else {
        // Use public endpoint configuration
        const gameNameHash = crypto
          .createHash('md5')
          .update(item.releaseName + '\n')
          .digest('hex')
        source = `:http:/${gameNameHash}`

        // Get the appropriate null config path based on platform
        const nullConfigPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
        console.log(`[DownProc] Using public endpoint mount: ${source}`)

        mountArgs = [
          'mount',
          source,
          mountPoint,
          '--config',
          nullConfigPath,
          '--http-url',
          this.vrpConfig.baseUri,
          '--no-check-certificate',
          '--read-only',
          '--vfs-cache-mode',
          'minimal',
          '--vfs-read-ahead',
          '128M'
        ]
      }

      // Start rclone mount (non-daemon mode for better error handling)
      console.log(`[DownProc] Mounting ${source} to ${mountPoint}`)

      // Start the mount as background process
      const mountProcess = execa(rclonePath, mountArgs, {
        all: true,
        buffer: false,
        windowsHide: true
      })

      const mountLogTail: string[] = []
      const maxLogLines = 50
      const pushLogLine = (line: string): void => {
        const trimmed = line.replace(/\r?\n$/, '')
        if (!trimmed) return
        mountLogTail.push(trimmed)
        if (mountLogTail.length > maxLogLines) {
          mountLogTail.shift()
        }
      }

      const handleMountOutput = (chunk: Buffer): void => {
        const text = chunk.toString()
        const lines = text.split(/\r?\n/)
        for (const line of lines) {
          if (line) {
            console.log(`[DownProc][rclone] ${line}`)
            pushLogLine(line)
          }
        }
      }

      if (mountProcess.all) {
        mountProcess.all.on('data', handleMountOutput)
      }

      let mountFailure: Error | null = null
      mountProcess.catch((error) => {
        mountFailure = error instanceof Error ? error : new Error(String(error))
        console.error(
          `[DownProc] rclone mount process failed for ${item.releaseName}:`,
          error
        )
        if (mountLogTail.length > 0) {
          console.error(`[DownProc] rclone mount log tail:\n${mountLogTail.join('\n')}`)
        }
      })

      // Store mount process for cleanup (we'll add it to the main download controller later)
      // Note: We'll remove this separate mount storage once we integrate it into the main controller

      // Wait for mount to be ready with timeout and verification
      let mountReady = false
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (mountFailure) {
          const tail = mountLogTail.length > 0 ? `\n${mountLogTail.join('\n')}` : ''
          const mountFailureMessage = String(mountFailure)
          throw new Error(`rclone mount failed: ${mountFailureMessage}${tail}`)
        }
        if (mountProcess.exitCode !== null) {
          const tail = mountLogTail.length > 0 ? `\n${mountLogTail.join('\n')}` : ''
          throw new Error(`rclone mount exited early (code ${mountProcess.exitCode}).${tail}`)
        }
        try {
          const testRead = await fs.readdir(mountPoint)
          if (testRead.length >= 0) {
            let isMounted = true
            if (process.platform !== 'win32') {
              try {
                const mountStat = await fsPromises.stat(mountPoint)
                const parentStat = await fsPromises.stat(join(mountPoint, '..'))
                isMounted = mountStat.dev !== parentStat.dev
              } catch {
                isMounted = false
              }
            }

            if (isMounted) {
              // Even empty directory means mount is working (remote may be empty).
              mountReady = true
              console.log(`[DownProc] Mount ready after ${i + 1} seconds`)
              break
            }
          }
        } catch {
          console.log(`[DownProc] Mount not ready yet, attempt ${i + 1}/10`)
        }
      }

      if (!mountReady) {
        const tail = mountLogTail.length > 0 ? `\n${mountLogTail.join('\n')}` : ''
        throw new Error(`Mount failed to become ready within 10 seconds.${tail}`)
      }

      // Verify mount contents are accessible and download all files
      try {
        const mountContents = await fs.readdir(mountPoint)
        console.log(`[DownProc] Mount contents: ${mountContents.join(', ')}`)

        if (mountContents.length === 0) {
          throw new Error('No files found in mounted directory')
        }

        console.log(`[DownProc] Found ${mountContents.length} file(s) to download`)
      } catch (readError) {
        console.error(`[DownProc] Failed to read mount directory: ${readError}`)
        this.updateItemStatus(item.releaseName, 'Error', 0, 'Failed to access mounted directory')
        await this.cleanup(mountPoint, item.releaseName)
        return { success: false, startExtraction: false }
      }

      // Start cross-platform download using Node.js streams
      console.log(
        `[DownProc] Starting stream-based download from ${mountPoint}/ to ${downloadPath}/`
      )

      // Get all files recursively from mount point
      const filesToDownload = await this.getFilesRecursively(mountPoint)
      console.log(
        `[DownProc] Found ${filesToDownload.length} file(s) to download: ${filesToDownload.map((f) => f.relativePath).join(', ')}`
      )

      // Calculate total size for progress tracking
      let totalSize = 0
      for (const file of filesToDownload) {
        totalSize += file.size
      }
      console.log(`[DownProc] Total download size: ${this.formatBytes(totalSize)}`)

      // Calculate already downloaded size (for resume)
      let totalCopied = 0
      for (const file of filesToDownload) {
        const destPath = join(downloadPath, file.relativePath)
        try {
          const destStat = await fsPromises.stat(destPath)
          totalCopied += destStat.size
        } catch {
          // File doesn't exist, no bytes downloaded yet
        }
      }

      if (totalCopied > 0) {
        const initialProgress = Math.round((totalCopied / totalSize) * 100)
        console.log(
          `[DownProc] Resuming download from ${this.formatBytes(totalCopied)} (${initialProgress}%)`
        )

        // Update initial progress in UI
        this.updateItemStatus(
          item.releaseName,
          'Downloading',
          initialProgress,
          undefined,
          undefined,
          undefined
        )
      }
      let downloadCancelled = false
      const startTime = Date.now()

      // Store cancellation token
      const cancellationToken = { cancelled: false }
      this.activeDownloads.set(item.releaseName, {
        cancel: () => {
          cancellationToken.cancelled = true
          downloadCancelled = true
        },
        mountProcess: mountProcess
      })

      // Download each file with resume support
      for (let i = 0; i < filesToDownload.length; i++) {
        const file = filesToDownload[i]
        const currentItemState = this.queueManager.findItem(item.releaseName)

        if (
          !currentItemState ||
          currentItemState.status !== 'Downloading' ||
          cancellationToken.cancelled
        ) {
          console.log(`[DownProc] Download cancelled or status changed for ${item.releaseName}`)
          downloadCancelled = true
          break
        }

        console.log(
          `[DownProc] Downloading file ${i + 1}/${filesToDownload.length}: ${file.relativePath}`
        )

        const sourcePath = join(mountPoint, file.relativePath)
        const destPath = join(downloadPath, file.relativePath)

        // Ensure destination directory exists
        await fsPromises.mkdir(join(destPath, '..'), { recursive: true })

        // Check if file already exists and get its size for resume
        let startOffset = 0
        try {
          const destStat = await fsPromises.stat(destPath)
          startOffset = destStat.size
          console.log(
            `[DownProc] Resuming ${file.relativePath} from offset ${this.formatBytes(startOffset)}`
          )
        } catch {
          // File doesn't exist, start from beginning
        }

        // Copy file with progress tracking
        const bytesCopied = await this.copyFileWithProgress(
          sourcePath,
          destPath,
          startOffset,
          (progress) => {
            const fileProgress = totalCopied + progress
            const overallProgress = Math.round((fileProgress / totalSize) * 100)
            const elapsed = Date.now() - startTime
            const speed = (fileProgress - startOffset) / (elapsed / 1000)
            const remaining = totalSize - fileProgress
            const eta = remaining / speed

            this.updateItemStatus(
              item.releaseName,
              'Downloading',
              overallProgress,
              undefined,
              this.formatSpeed(speed),
              this.formatEta(eta)
            )
          },
          cancellationToken
        )

        totalCopied += bytesCopied

        if (cancellationToken.cancelled) {
          console.log(`[DownProc] Download cancelled during file ${file.relativePath}`)
          downloadCancelled = true
          break
        }
      }

      if (downloadCancelled) {
        this.activeDownloads.delete(item.releaseName)
        const finalItemState = this.queueManager.findItem(item.releaseName)
        return { success: false, startExtraction: false, finalState: finalItemState }
      }

      // Check final state
      const finalItemState = this.queueManager.findItem(item.releaseName)
      if (!finalItemState || finalItemState.status !== 'Downloading') {
        console.log(
          `[DownProc] rsync process for ${item.releaseName} finished, but final status is ${finalItemState?.status}.`
        )
        await this.cleanup(mountPoint, item.releaseName)
        if (this.activeDownloads.has(item.releaseName)) {
          this.activeDownloads.delete(item.releaseName)
          this.queueManager.updateItem(item.releaseName, { pid: undefined })
        }
        return { success: false, startExtraction: false, finalState: finalItemState }
      }

      console.log(`[DownProc] rsync download completed successfully for ${item.releaseName}`)
      this.activeDownloads.delete(item.releaseName)
      this.queueManager.updateItem(item.releaseName, { pid: undefined })

      // Cleanup mount
      await this.cleanup(mountPoint, item.releaseName)

      return { success: true, startExtraction: true, finalState: finalItemState }
    } catch (error: unknown) {
      const isExecaError = (err: unknown): err is ExecaError =>
        typeof err === 'object' && err !== null && 'shortMessage' in err
      const currentItemState = this.queueManager.findItem(item.releaseName)
      const statusBeforeCatch = currentItemState?.status ?? 'Unknown'

      console.error(`[DownProc] Mount-based download error for ${item.releaseName}:`, error)

      // Cleanup
      await this.cleanup(mountPoint, item.releaseName)
      if (this.activeDownloads.has(item.releaseName)) {
        this.activeDownloads.delete(item.releaseName)
        this.queueManager.updateItem(item.releaseName, { pid: undefined })
      }

      if (this.isFuseMissingError(error)) {
        throw error
      }

      // Handle cancellation
      if (isExecaError(error) && error.exitCode === 143) {
        console.log(`[DownProc] Mount-based download cancelled for ${item.releaseName}`)
        return { success: false, startExtraction: false, finalState: currentItemState }
      }

      // Handle other errors
      let errorMessage = 'Mount-based download failed.'
      if (isExecaError(error)) {
        errorMessage = error.shortMessage || error.message
      } else if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = String(error)
      }
      errorMessage = errorMessage.substring(0, 500)

      if (statusBeforeCatch !== 'Cancelled' && statusBeforeCatch !== 'Error') {
        this.updateItemStatus(
          item.releaseName,
          'Error',
          currentItemState?.progress ?? 0,
          errorMessage
        )
      }

      return {
        success: false,
        startExtraction: false,
        finalState: this.queueManager.findItem(item.releaseName)
      }
    }
  }

  // Cleanup helper for mount points
  private async cleanup(mountPoint: string, releaseName?: string): Promise<void> {
    try {
      console.log(`[DownProc] Cleaning up mount point: ${mountPoint}`)

      // Stop mount process if it exists
      if (releaseName) {
        const downloadController = this.activeDownloads.get(releaseName)
        if (downloadController?.mountProcess) {
          try {
            downloadController.mountProcess.kill('SIGTERM')
            console.log(`[DownProc] Terminated mount process for ${releaseName}`)
          } catch (killError) {
            console.warn(`[DownProc] Failed to kill mount process for ${releaseName}:`, killError)
          }
        }
      }

      // Try to unmount
      try {
        if (process.platform === 'linux') {
          await execa('fusermount', ['-u', mountPoint])
        } else if (process.platform === 'darwin') {
          await execa('umount', [mountPoint])
        } else if (process.platform === 'win32') {
          // Windows unmount is handled by rclone daemon
          await execa('taskkill', ['/F', '/IM', 'rclone.exe'])
        }
        console.log(`[DownProc] Successfully unmounted ${mountPoint}`)
      } catch (unmountError) {
        console.warn(`[DownProc] Failed to unmount ${mountPoint}:`, unmountError)
      }

      // Remove mount directory
      try {
        await fs.rmdir(mountPoint)
        console.log(`[DownProc] Removed mount directory ${mountPoint}`)
      } catch (removeError) {
        console.warn(`[DownProc] Failed to remove mount directory ${mountPoint}:`, removeError)
      }
    } catch (cleanupError) {
      console.error(`[DownProc] Cleanup error for ${mountPoint}:`, cleanupError)
    }
  }

  // Method to pause a download (for stream-based downloads)
  public pauseDownload(releaseName: string): void {
    console.log(`[DownProc] Pausing download for ${releaseName}...`)

    // Cancel download and clean up mount process
    const downloadController = this.activeDownloads.get(releaseName)
    if (downloadController) {
      try {
        downloadController.cancel()
        console.log(`[DownProc] Paused download for ${releaseName}.`)
      } catch (cancelError) {
        console.error(`[DownProc] Error pausing download for ${releaseName}:`, cancelError)
      }

      // Clean up mount process if it exists
      if (downloadController.mountProcess) {
        console.log(`[DownProc] Cleaning up mount process for ${releaseName}...`)
        try {
          downloadController.mountProcess.kill('SIGTERM')
          console.log(`[DownProc] Terminated mount process for ${releaseName}.`)
        } catch (killError) {
          console.warn(`[DownProc] Failed to kill mount process for ${releaseName}:`, killError)
        }
      }

      this.activeDownloads.delete(releaseName)
    } else {
      console.log(`[DownProc] No active download found for ${releaseName} to pause.`)
    }

    // Update status to Paused
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      const updated = this.queueManager.updateItem(releaseName, {
        status: 'Paused' as DownloadStatus,
        pid: undefined
      })
      if (updated) {
        console.log(`[DownProc] Updated status for ${releaseName} to Paused.`)
        this.debouncedEmitUpdate()
      }
    }
  }

  // Method to resume a paused download
  public async resumeDownload(
    item: DownloadItem
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Resuming download for ${item.releaseName}...`)

    // Update status back to Downloading and restart the download
    // The file streams will automatically resume from where they left off using file offsets
    this.updateItemStatus(item.releaseName, 'Downloading', item.progress ?? 0)

    // Restart the download using the stream-based approach
    try {
      return await this.startMountBasedDownload(item)
    } catch (error: unknown) {
      if (this.isFuseMissingError(error)) {
        console.warn(
          `[DownProc] FUSE not available. Falling back to public endpoint direct download for ${item.releaseName}.`
        )
        return await this.startPublicEndpointDownload(item)
      }
      throw error
    }
  }

  // Method to check if a download is active
  public isDownloadActive(releaseName: string): boolean {
    return this.activeDownloads.has(releaseName)
  }

  private isFuseMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /cannot find FUSE/i.test(message) || /cgofuse/i.test(message)
  }

  // Helper method to get all files recursively from a directory
  private async getFilesRecursively(
    dir: string,
    baseDir?: string
  ): Promise<Array<{ relativePath: string; size: number }>> {
    const files: Array<{ relativePath: string; size: number }> = []
    const currentBase = baseDir || dir

    const entries = await fsPromises.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const relativePath = join(dir, entry.name)
        .replace(currentBase + '/', '')
        .replace(currentBase + '\\', '')
        .replace(currentBase, '')

      if (entry.isDirectory()) {
        const subFiles = await this.getFilesRecursively(fullPath, currentBase)
        files.push(...subFiles)
      } else {
        const stat = await fsPromises.stat(fullPath)
        files.push({
          relativePath: relativePath || entry.name,
          size: stat.size
        })
      }
    }

    return files
  }

  // Helper method to copy a file with progress tracking and resume support
  private async copyFileWithProgress(
    sourcePath: string,
    destPath: string,
    startOffset: number,
    onProgress: (progress: number) => void,
    cancellationToken: { cancelled: boolean }
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let copiedBytes = startOffset

      const readStream = createReadStream(sourcePath, { start: startOffset })
      const writeStream = createWriteStream(destPath, { flags: startOffset > 0 ? 'a' : 'w' })

      // Handle bandwidth limiting
      const downloadSpeedLimit = settingsService.getDownloadSpeedLimit()
      let lastProgressTime = Date.now()
      let bytesInSecond = 0

      readStream.on('data', (chunk: string | Buffer) => {
        if (cancellationToken.cancelled) {
          readStream.destroy()
          writeStream.destroy()
          return
        }

        const chunkSize = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        copiedBytes += chunkSize
        bytesInSecond += chunkSize

        // Bandwidth limiting
        const now = Date.now()
        if (downloadSpeedLimit > 0 && now - lastProgressTime >= 1000) {
          const maxBytesPerSecond = downloadSpeedLimit * 1024 // Convert KB/s to B/s
          if (bytesInSecond > maxBytesPerSecond) {
            const delay = (bytesInSecond / maxBytesPerSecond - 1) * 1000
            setTimeout(() => {
              if (!cancellationToken.cancelled) {
                onProgress(copiedBytes - startOffset)
              }
            }, delay)
          } else {
            onProgress(copiedBytes - startOffset)
          }
          bytesInSecond = 0
          lastProgressTime = now
        } else {
          onProgress(copiedBytes - startOffset)
        }
      })

      readStream.on('end', () => {
        writeStream.end()
      })

      writeStream.on('finish', () => {
        resolve(copiedBytes - startOffset)
      })

      readStream.on('error', (error) => {
        writeStream.destroy()
        reject(error)
      })

      writeStream.on('error', (error) => {
        readStream.destroy()
        reject(error)
      })

      readStream.pipe(writeStream)
    })
  }

  // Helper method to format bytes to human readable format
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  // Helper method to format speed
  private formatSpeed(bytesPerSecond: number): string {
    return `${this.formatBytes(bytesPerSecond)}/s`
  }

  // Helper method to format ETA
  private formatEta(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '--:--:--'

    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`
    }
  }
}
