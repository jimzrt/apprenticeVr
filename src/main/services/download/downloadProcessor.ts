import { join } from 'path'
import { promises as fs } from 'fs'
import { execa, ExecaError } from 'execa'
import crypto from 'crypto'
import { DownloadItem, DownloadStatus } from './types'
import { QueueManager } from './queueManager'
import dependencyService from '../dependencyService'

// Type for VRP config - adjust if needed elsewhere
interface VrpConfig {
  baseUri?: string
  password?: string
}

export class DownloadProcessor {
  private activeDownloads: Map<string, ReturnType<typeof execa>> = new Map()
  private queueManager: QueueManager
  private dependencyService: typeof dependencyService
  private vrpConfig: VrpConfig | null = null
  private downloadsDir: string // Needed to construct download path
  private debouncedEmitUpdate: () => void

  constructor(
    queueManager: QueueManager,
    depService: typeof dependencyService, // Pass dependency service
    downloadsDir: string, // Pass downloads directory
    debouncedEmitUpdate: () => void // Pass the emitter function
  ) {
    this.queueManager = queueManager
    this.dependencyService = depService
    this.downloadsDir = downloadsDir
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
    const process = this.activeDownloads.get(releaseName)
    if (process?.pid) {
      console.log(`[DownProc] Cancelling download for ${releaseName} (PID: ${process.pid})...`)
      process.all?.removeAllListeners() // Detach listeners first
      try {
        process.kill('SIGTERM')
        console.log(`[DownProc] Sent SIGTERM to process for ${releaseName}.`)
      } catch (killError) {
        console.error(`[DownProc] Error killing process for ${releaseName}:`, killError)
      }
      this.activeDownloads.delete(releaseName)
    } else {
      console.log(`[DownProc] No active download process found for ${releaseName} to cancel.`)
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

    const rclonePath = this.dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    const downloadPath = join(this.downloadsDir, item.releaseName)
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

    this.updateItemStatus(item.releaseName, 'Downloading', 0)

    const gameNameHash = crypto
      .createHash('md5')
      .update(item.releaseName + '\n')
      .digest('hex')
    const source = `:http:/${gameNameHash}`

    let rcloneProcess: ReturnType<typeof execa> | null = null

    try {
      rcloneProcess = execa(
        rclonePath,
        [
          'copy',
          source,
          downloadPath,
          '--http-url',
          this.vrpConfig.baseUri,
          '--no-check-certificate',
          '--progress',
          '--stats=1s',
          '--stats-one-line'
        ],
        { all: true, buffer: false, windowsHide: true }
      )

      if (!rcloneProcess || !rcloneProcess.pid || !rcloneProcess.all) {
        throw new Error('Failed to start rclone process.')
      }

      this.activeDownloads.set(item.releaseName, rcloneProcess)
      this.queueManager.updateItem(item.releaseName, { pid: rcloneProcess.pid })

      console.log(
        `[DownProc] rclone process started for ${item.releaseName} with PID: ${rcloneProcess.pid}`
      )

      const transferLineRegex = /, (\d+)%, /
      const speedRegex = /, (\d+\.\d+ \S+?B\/s),/
      const etaRegex = /, ETA (\S+)/

      let outputBuffer = ''
      rcloneProcess.all.on('data', (data: Buffer) => {
        const currentItemState = this.queueManager.findItem(item.releaseName)
        if (!currentItemState || currentItemState.status !== 'Downloading') {
          // Item removed or status changed (e.g., cancelled), stop processing data
          console.warn(
            `[DownProc] Item ${item.releaseName} state changed to ${currentItemState?.status} during download. Stopping data processing.`
          )
          const proc = this.activeDownloads.get(item.releaseName)
          if (proc) {
            proc.all?.removeAllListeners() // Remove listeners
            proc.kill('SIGTERM') // Attempt to kill
            this.activeDownloads.delete(item.releaseName) // Remove tracking
          }
          return
        }
        console.log(`[DownProc] Rclone output: ${data.toString()}`)
        outputBuffer += data.toString()
        const lines = outputBuffer.split(/\r\n|\n|\r/).filter((line) => line.length > 0)

        if (lines.length > 0) {
          const lastLineComplete =
            transferLineRegex.test(lines[lines.length - 1]) &&
            etaRegex.test(lines[lines.length - 1])
          const linesToProcess = lastLineComplete ? lines : lines.slice(0, -1)
          outputBuffer = lastLineComplete ? '' : lines[lines.length - 1]

          for (const line of linesToProcess) {
            // console.log(`[DownProc Raw Line] ${item.releaseName}: ${line}`);
            const progressMatch = line.match(transferLineRegex)
            if (progressMatch && progressMatch[1]) {
              const currentProgress = parseInt(progressMatch[1], 10)
              if (currentProgress >= (currentItemState.progress ?? 0)) {
                // Use >= to ensure 0% gets logged
                const speedMatch = line.match(speedRegex)
                const etaMatch = line.match(etaRegex)
                const speed = speedMatch?.[1] || currentItemState.speed
                const eta = etaMatch?.[1] || currentItemState.eta
                // console.log(`[DownProc Parsed] ${currentProgress}%, Speed: ${speed}, ETA: ${eta}`);
                this.updateItemStatus(
                  item.releaseName,
                  'Downloading',
                  currentProgress,
                  undefined,
                  speed,
                  eta
                )
              }
            }
            if (line.includes('Auth Error') || line.includes('authentication failed')) {
              console.error(`[DownProc] Rclone (${item.releaseName}): Auth Error/Failed`)
              this.cancelDownload(item.releaseName, 'Error', 'Auth failed (check VRP password?)')
              // Don't return, let the main error handler catch the process exit
            }
            if (line.includes("doesn't support hash type")) {
              console.warn(`[DownProc] Rclone (${item.releaseName}): Hash type not supported`)
            }
          }
        }
      })

      await rcloneProcess // Wait for the process to complete

      // Check final state *after* await completes
      const finalItemState = this.queueManager.findItem(item.releaseName)
      if (!finalItemState || finalItemState.status !== 'Downloading') {
        console.log(
          `[DownProc] Download process for ${item.releaseName} finished, but final status is ${finalItemState?.status}. Not proceeding to extraction.`
        )
        // Clean up just in case
        if (this.activeDownloads.has(item.releaseName)) {
          this.activeDownloads.delete(item.releaseName)
          this.queueManager.updateItem(item.releaseName, { pid: undefined })
        }
        return { success: false, startExtraction: false, finalState: finalItemState } // Indicate failure/cancellation
      }

      console.log(`[DownProc] rclone process finished successfully for ${item.releaseName}.`)
      this.activeDownloads.delete(item.releaseName)
      this.queueManager.updateItem(item.releaseName, { pid: undefined })

      // Signal success and intent to start extraction
      return { success: true, startExtraction: true, finalState: finalItemState }
    } catch (error: unknown) {
      const isExecaError = (err: unknown): err is ExecaError =>
        typeof err === 'object' && err !== null && 'shortMessage' in err
      const currentItemState = this.queueManager.findItem(item.releaseName)
      const statusBeforeCatch = currentItemState?.status ?? 'Unknown'

      // Handle intentional cancellation (SIGTERM)
      if (isExecaError(error) && error.exitCode === 143) {
        console.log(
          `[DownProc Catch] Ignoring expected SIGTERM (143) for ${item.releaseName}. Status: ${statusBeforeCatch}`
        )
        // Status should already be set by cancelDownload. Ensure cleanup.
        if (this.activeDownloads.has(item.releaseName)) {
          this.activeDownloads.delete(item.releaseName)
          this.queueManager.updateItem(item.releaseName, { pid: undefined })
        }
        return { success: false, startExtraction: false, finalState: currentItemState } // Return current state
      }

      // Handle unexpected errors
      console.error(
        `[DownProc Catch] Unexpected error for ${item.releaseName}. Status: ${statusBeforeCatch}. Error:`,
        error
      )
      if (this.activeDownloads.has(item.releaseName)) {
        this.activeDownloads.delete(item.releaseName)
        this.queueManager.updateItem(item.releaseName, { pid: undefined })
      }

      let errorMessage = 'Download failed.'
      if (isExecaError(error)) {
        if (error.isCanceled) {
          // Should be caught by SIGTERM check, but handle as fallback
          if (statusBeforeCatch !== 'Cancelled' && statusBeforeCatch !== 'Error') {
            console.log(
              `[DownProc Catch] Download cancelled (isCanceled flag). Status: ${statusBeforeCatch}`
            )
            this.updateItemStatus(item.releaseName, 'Cancelled', currentItemState?.progress ?? 0)
          } else {
            console.log(
              `[DownProc Catch] Download cancelled (isCanceled flag), status already ${statusBeforeCatch}.`
            )
          }
          return {
            success: false,
            startExtraction: false,
            finalState: this.queueManager.findItem(item.releaseName)
          }
        }
        errorMessage = error.shortMessage || error.message
        const output = error.all || error.stderr || error.stdout || ''
        const lastLines = (typeof output === 'string' ? output : output.toString())
          .split('\n')
          .slice(-5)
          .join('\n')
        if (lastLines) errorMessage += `\n...\n${lastLines}`
      } else if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = String(error)
      }
      errorMessage = errorMessage.substring(0, 500)

      // Update status to Error only if it wasn't already handled
      if (statusBeforeCatch !== 'Cancelled' && statusBeforeCatch !== 'Error') {
        this.updateItemStatus(
          item.releaseName,
          'Error',
          currentItemState?.progress ?? 0,
          errorMessage
        )
      } else {
        console.log(
          `[DownProc Catch] Download error occurred for ${item.releaseName}, but status was already ${statusBeforeCatch}. Error: ${errorMessage}`
        )
        if (statusBeforeCatch === 'Error') {
          // Update error message if already in error state
          this.queueManager.updateItem(item.releaseName, { error: errorMessage })
          this.debouncedEmitUpdate()
        }
      }

      return {
        success: false,
        startExtraction: false,
        finalState: this.queueManager.findItem(item.releaseName)
      } // Indicate failure
    }
  }

  // Method to check if a download is active
  public isDownloadActive(releaseName: string): boolean {
    return this.activeDownloads.has(releaseName)
  }
}
