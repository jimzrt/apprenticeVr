import { BrowserWindow } from 'electron'
import { promises as fs, existsSync, readdirSync } from 'fs'
import adbService from './adbService'
import { EventEmitter } from 'events'
import { debounce } from './download/utils'
import { QueueManager } from './download/queueManager'
import { DownloadProcessor } from './download/downloadProcessor'
import { ExtractionProcessor } from './download/extractionProcessor'
import { InstallationProcessor } from './download/installationProcessor'
import { DownloadAPI, GameInfo, DownloadItem, DownloadStatus } from '@shared/types'
import settingsService from './settingsService'
import { typedWebContentsSend } from '@shared/ipc-utils'
import { join } from 'path'
import gameService from './gameService'

interface VrpConfig {
  baseUri?: string
  password?: string
}

class DownloadService extends EventEmitter implements DownloadAPI {
  private downloadsPath: string
  private isInitialized = false
  private isProcessing = false
  private debouncedEmitUpdate: () => void
  private queueManager: QueueManager
  private downloadProcessor: DownloadProcessor
  private extractionProcessor: ExtractionProcessor
  private installationProcessor: InstallationProcessor
  private adbService: typeof adbService
  private appSelectedDevice: string | null = null
  private appIsConnected: boolean = false

  constructor() {
    super()
    const downloadPath = settingsService.getDownloadPath()
    settingsService.on('download-path-changed', (path) => {
      this.setDownloadPath(path)
      // Trigger a re-scan when the downloads path changes
      this.scanExistingCompletedDownloads().catch((e) =>
        console.warn('[Service] scanExistingCompletedDownloads on path change failed:', e)
      )
    })
    this.downloadsPath = downloadPath

    this.queueManager = new QueueManager()
    this.adbService = adbService
    this.debouncedEmitUpdate = debounce(this.emitUpdate.bind(this), 100)
    this.downloadProcessor = new DownloadProcessor(this.queueManager, this.debouncedEmitUpdate)
    this.extractionProcessor = new ExtractionProcessor(this.queueManager, this.debouncedEmitUpdate)
    this.installationProcessor = new InstallationProcessor(
      this.queueManager,
      this.adbService,
      this.debouncedEmitUpdate
    )
  }

  setDownloadPath(path: string): void {
    this.downloadsPath = path
    // Update paths for existing items that might have moved to the new location
    this.updateExistingItemPaths(path)
  }

  private updateExistingItemPaths(newBasePath: string): void {
    try {
      const queue = this.queueManager.getQueue()
      let updatedCount = 0

      for (const item of queue) {
        if (item.releaseName && item.status === 'Completed') {
          const newPath = join(newBasePath, item.releaseName)
          if (existsSync(newPath)) {
            // Check if this path contains the expected content
            try {
              const contents = readdirSync(newPath)
              const hasApk = contents.some((f) => f.toLowerCase().endsWith('.apk'))
              const hasInstallScript = contents.some(
                (f) => f.toLowerCase() === 'install.txt' || f.toLowerCase() === 'install'
              )
              
              if (hasApk || hasInstallScript) {
                console.log(`[Service] Updating path for moved item ${item.releaseName}: ${item.downloadPath} -> ${newPath}`)
                this.queueManager.updateItem(item.releaseName, { downloadPath: newPath })
                updatedCount++
              }
            } catch (e) {
              console.warn(`[Service] Could not verify contents of ${newPath}:`, e)
            }
          }
        }
      }

      if (updatedCount > 0) {
        console.log(`[Service] Updated ${updatedCount} item paths after download path change.`)
        this.emitUpdate()
      }
    } catch (e) {
      console.warn('[Service] Error updating existing item paths:', e)
    }
  }

  setAppConnectionState(selectedDevice: string | null, isConnected: boolean): void {
    console.log(
      `[Service] App connection state updated - Device: ${selectedDevice}, Connected: ${isConnected}`
    )
    this.appSelectedDevice = selectedDevice
    this.appIsConnected = isConnected
  }

  private getTargetDeviceForInstallation(): string | null {
    console.log(
      `[Service] Checking app connection state - Device: ${this.appSelectedDevice}, Connected: ${this.appIsConnected}`
    )

    // If the app is not connected to any device, don't install
    if (!this.appIsConnected || !this.appSelectedDevice) {
      console.log('[Service] App is not connected to any device, skipping installation')
      return null
    }

    // Return the app's selected device for installation
    console.log(
      `[Service] Using app's connected device for installation: ${this.appSelectedDevice}`
    )
    return this.appSelectedDevice
  }

  async initialize(vrpConfig: VrpConfig): Promise<void> {
    if (this.isInitialized) return
    console.log('Initializing DownloadService...')

    this.downloadProcessor.setVrpConfig(vrpConfig)
    this.extractionProcessor.setVrpConfig(vrpConfig)

    await fs.mkdir(this.downloadsPath, { recursive: true })
    await this.queueManager.loadQueue()

    // Import any existing completed downloads present on disk into the queue
    await this.scanExistingCompletedDownloads()

    const changed = this.queueManager.updateAllItems(
      (item) =>
        item.status === 'Downloading' ||
        item.status === 'Extracting' ||
        item.status === 'Installing',
      {
        status: 'Queued',
        pid: undefined,
        progress: 0,
        extractProgress: undefined
      }
    )

    if (changed) {
      console.log(
        'Reset status for items from Downloading/Extracting/Installing to Queued after restart.'
      )
    }

    this.isInitialized = true
    console.log('DownloadService initialized.')
    this.emitUpdate()
    this.processQueue()
  }

  public getQueue(): Promise<DownloadItem[]> {
    return Promise.resolve(this.queueManager.getQueue())
  }

  public addToQueue(game: GameInfo): Promise<boolean> {
    if (!this.isInitialized) {
      console.error('DownloadService not initialized. Cannot add to queue.')
      return Promise.resolve(false)
    }
    if (!game.releaseName) {
      console.error(`Cannot add game ${game.name} to queue: Missing releaseName.`)
      return Promise.resolve(false)
    }

    const existing = this.queueManager.findItem(game.releaseName)

    if (existing) {
      if (existing.status === 'Completed') {
        console.log(`Game ${game.releaseName} already downloaded.`)
        return Promise.resolve(false)
      } else if (existing.status !== 'Error' && existing.status !== 'Cancelled') {
        console.log(
          `Game ${game.releaseName} is already in the queue with status: ${existing.status}.`
        )
        return Promise.resolve(false)
      }
      console.log(`Re-adding game ${game.releaseName} after previous ${existing.status}.`)
      this.queueManager.removeItem(game.releaseName)
    }

    const newItem: DownloadItem = {
      gameId: game.id,
      releaseName: game.releaseName,
      packageName: game.packageName,
      gameName: game.name,
      status: 'Queued',
      progress: 0,
      addedDate: Date.now(),
      thumbnailPath: game.thumbnailPath,
      downloadPath: this.downloadsPath,
      size: game.size
    }
    this.queueManager.addItem(newItem)
    console.log(`Added ${game.releaseName} to download queue.`)
    this.emitUpdate()
    this.processQueue()
    return Promise.resolve(true)
  }

  public async removeFromQueue(releaseName: string): Promise<void> {
    const item = this.queueManager.findItem(releaseName)
    if (!item) return

    if (item.status === 'Downloading') {
      console.log(`[Service] Requesting cancel download for ${releaseName}`)
      this.downloadProcessor.cancelDownload(releaseName, 'Cancelled')
    } else if (item.status === 'Extracting') {
      console.log(`[Service] Requesting cancel extraction for ${releaseName}`)
      this.extractionProcessor.cancelExtraction(releaseName)
      const updated = this.queueManager.updateItem(releaseName, {
        status: 'Cancelled',
        extractProgress: 0,
        pid: undefined,
        error: undefined
      })
      if (updated) this.debouncedEmitUpdate()
    }

    await this.deleteDownloadedFiles(releaseName)

    const removed = this.queueManager.removeItem(releaseName)
    if (removed) {
      console.log(`[Service] Removed ${releaseName} from queue (status: ${item.status}).`)
      this.emitUpdate()
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      // Safety check: if isProcessing is true but no active downloads/extractions exist,
      // it might be stuck due to a race condition or error. Reset it.
      const activeItems = this.queueManager
        .getQueue()
        .filter(
          (item) =>
            this.downloadProcessor.isDownloadActive(item.releaseName) ||
            this.extractionProcessor.isExtractionActive(item.releaseName)
        )

      console.log(
        `[Service ProcessQueue] isProcessing=true, checking active operations:`,
        activeItems.map((item) => `${item.releaseName}(${item.status})`)
      )

      if (activeItems.length === 0) {
        console.warn(
          '[Service ProcessQueue] isProcessing was stuck with no active operations, resetting it'
        )
        this.isProcessing = false
      } else {
        console.log(
          `[Service ProcessQueue] Found ${activeItems.length} active operations, staying in processing mode`
        )
        return
      }
    }

    const nextItem = this.queueManager.findNextQueuedItem()
    if (!nextItem) {
      this.isProcessing = false
      console.log('[Service ProcessQueue] No queued items found, setting isProcessing=false')
      return
    }

    this.isProcessing = true
    console.log(
      `[Service ProcessQueue] Processing next item: ${nextItem.releaseName}, setting isProcessing=true`
    )

    const targetDeviceId = this.getTargetDeviceForInstallation()

    try {
      const downloadResult = await this.downloadProcessor.startDownload(nextItem)
      if (!downloadResult.success) {
        console.log(
          `[Service ProcessQueue] Download failed/cancelled for ${nextItem.releaseName}. Status: ${downloadResult.finalState?.status}`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }
      const itemAfterDownload = downloadResult.finalState
      if (!itemAfterDownload) {
        console.log(
          `[Service ProcessQueue] Download successful but no final state for ${nextItem.releaseName}.`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }
      if (!downloadResult.startExtraction) {
        console.log(
          `[Service ProcessQueue] Download successful but extraction flag not set for ${nextItem.releaseName}.`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }

      console.log(
        `[Service ProcessQueue] Download successful for ${itemAfterDownload.releaseName}. Starting extraction...`
      )
      const extractionSuccess = await this.extractionProcessor.startExtraction(itemAfterDownload)
      if (!extractionSuccess) {
        console.log(
          `[Service ProcessQueue] Extraction failed or was cancelled for ${itemAfterDownload.releaseName}.`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }
      const itemAfterExtraction = this.queueManager.findItem(itemAfterDownload.releaseName)
      if (!itemAfterExtraction || itemAfterExtraction.status !== 'Completed') {
        console.warn(
          `[Service ProcessQueue] Extraction reported success for ${itemAfterDownload.releaseName}, but item status is now ${itemAfterExtraction?.status}. Skipping installation.`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }

      // Re-check connection state before installation (device might have disconnected during extraction)
      const finalTargetDeviceId = this.getTargetDeviceForInstallation()
      if (!finalTargetDeviceId) {
        console.warn(
          `[Service ProcessQueue] Extraction successful for ${itemAfterExtraction.releaseName}, but app is no longer connected to a device. Skipping installation.`
        )
        // Mark as Completed (download/extract), installation skipped.
        this.isProcessing = false
        this.processQueue()
        return
      }

      if (targetDeviceId && targetDeviceId !== finalTargetDeviceId) {
        console.warn(
          `[Service ProcessQueue] Target device changed during processing. Was: ${targetDeviceId}, Now: ${finalTargetDeviceId}. Skipping installation.`
        )
        this.isProcessing = false
        this.processQueue()
        return
      }

      console.log(
        `[Service ProcessQueue] Extraction successful for ${itemAfterExtraction.releaseName}. Starting installation on ${finalTargetDeviceId}...`
      )
      const installationSuccess = await this.installationProcessor.startInstallation(
        itemAfterExtraction,
        finalTargetDeviceId
      )
      if (installationSuccess) {
        // Emit event on successful installation
        this.emit('installation:success', finalTargetDeviceId)
      } else {
        // Error is already logged by the installation processor
        console.error(
          `[Service ProcessQueue] Installation failed for ${itemAfterExtraction.releaseName}.`
        )
      } // No need for specific success log here, handled by processor

      this.isProcessing = false
      this.processQueue()
    } catch (error) {
      console.error(
        `[Service ProcessQueue] UNEXPECTED error in main processing loop for ${nextItem.releaseName}:`,
        error
      )
      const currentItem = this.queueManager.findItem(nextItem.releaseName)
      this.updateItemStatus(
        nextItem.releaseName,
        'Error',
        currentItem?.progress ?? 0,
        'Unexpected processing error',
        undefined,
        undefined,
        currentItem?.extractProgress
      )
      this.isProcessing = false
      this.processQueue()
    }
  }

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
    } else if (
      status !== 'Extracting' &&
      status !== 'Completed' &&
      status !== 'Installing' &&
      status !== 'InstallError'
    ) {
      updates.extractProgress = undefined
    }
    if (status !== 'Downloading') {
      updates.speed = undefined
      updates.eta = undefined
    }
    if (status !== 'Downloading' && status !== 'Extracting' && status !== 'Installing') {
      updates.pid = undefined
    }
    if (status !== 'Error' && status !== 'InstallError') {
      updates.error = undefined
    }

    const updated = this.queueManager.updateItem(releaseName, updates)
    if (updated) {
      this.debouncedEmitUpdate()
    } else {
      console.warn(`[Service updateItemStatus] Failed update for non-existent item: ${releaseName}`)
    }
  }

  private emitUpdate(): void {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow && !mainWindow.isDestroyed()) {
      typedWebContentsSend.send(mainWindow, 'download:queue-updated', this.queueManager.getQueue())
    }
  }

  public cancelUserRequest(releaseName: string): Promise<void> {
    const item = this.queueManager.findItem(releaseName)
    if (!item) {
      console.warn(`[Service cancelUserRequest] Cannot cancel ${releaseName} - not found.`)
      return Promise.resolve()
    }

    console.log(
      `[Service cancelUserRequest] User requesting cancel for ${releaseName}, status: ${item.status}, isProcessing: ${this.isProcessing}`
    )

    if (item.status === 'Downloading' || item.status === 'Queued') {
      this.downloadProcessor.cancelDownload(releaseName, 'Cancelled')

      // Only reset isProcessing if this was the only active operation
      if (this.isProcessing) {
        const allItems = this.queueManager.getQueue()
        const otherActiveOperations = allItems.filter(
          (queueItem) =>
            queueItem.releaseName !== releaseName &&
            (this.downloadProcessor.isDownloadActive(queueItem.releaseName) ||
              this.extractionProcessor.isExtractionActive(queueItem.releaseName))
        )

        if (otherActiveOperations.length === 0) {
          console.log(
            `[Service cancelUserRequest] Resetting isProcessing flag - no other active operations after cancelling ${releaseName}`
          )
          this.isProcessing = false
          // Continue processing the queue for other items
          this.processQueue()
        } else {
          console.log(
            `[Service cancelUserRequest] Not resetting isProcessing flag - ${otherActiveOperations.length} other operations are still active`
          )
        }
      }
    } else if (item.status === 'Extracting') {
      this.extractionProcessor.cancelExtraction(releaseName)
      const updated = this.queueManager.updateItem(releaseName, {
        status: 'Cancelled',
        extractProgress: 0,
        pid: undefined,
        error: undefined
      })
      if (updated) this.debouncedEmitUpdate()

      // Only reset isProcessing if this was the only active operation
      if (this.isProcessing) {
        const allItems = this.queueManager.getQueue()
        const otherActiveOperations = allItems.filter(
          (queueItem) =>
            queueItem.releaseName !== releaseName &&
            (this.downloadProcessor.isDownloadActive(queueItem.releaseName) ||
              this.extractionProcessor.isExtractionActive(queueItem.releaseName))
        )

        if (otherActiveOperations.length === 0) {
          console.log(
            `[Service cancelUserRequest] Resetting isProcessing flag - no other active operations after cancelling extraction of ${releaseName}`
          )
          this.isProcessing = false
          // Continue processing the queue for other items
          this.processQueue()
        } else {
          console.log(
            `[Service cancelUserRequest] Not resetting isProcessing flag - ${otherActiveOperations.length} other operations are still active`
          )
        }
      }
    } else if (item.status === 'Installing') {
      console.warn(
        `[Service cancelUserRequest] Cancellation requested for ${releaseName} during 'Installing' state - Not supported.`
      )
    } else {
      console.warn(
        `[Service cancelUserRequest] Cannot cancel ${releaseName} - status: ${item.status}`
      )
    }

    return Promise.resolve()
  }

  public retryDownload(releaseName: string): void {
    const item = this.queueManager.findItem(releaseName)
    if (
      item &&
      (item.status === 'Cancelled' || item.status === 'Error' || item.status === 'InstallError')
    ) {
      console.log(`[Service] Retrying download: ${releaseName}`)

      if (this.downloadProcessor.isDownloadActive(releaseName)) {
        console.warn(
          `[Service Retry] Retrying item ${releaseName} with active download - cancelling first.`
        )
        this.downloadProcessor.cancelDownload(releaseName, 'Error', 'Cancelled before retry')
      }
      if (this.extractionProcessor.isExtractionActive(releaseName)) {
        console.warn(
          `[Service Retry] Retrying item ${releaseName} with active extraction - cancelling first.`
        )
        this.extractionProcessor.cancelExtraction(releaseName)
      }

      const updated = this.queueManager.updateItem(releaseName, {
        status: 'Queued',
        downloadPath: this.downloadsPath,
        progress: 0,
        extractProgress: undefined,
        error: undefined,
        pid: undefined,
        speed: undefined,
        eta: undefined
      })
      if (updated) {
        this.emitUpdate()
        this.processQueue()
      } else {
        console.warn(`[Service Retry] Failed to update ${releaseName} for retry.`)
      }
    } else {
      console.warn(`[Service Retry] Cannot retry ${releaseName} - status: ${item?.status}`)
    }
  }

  public pauseDownload(releaseName: string): void {
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      this.downloadProcessor.pauseDownload(releaseName)
    }
  }

  public resumeDownload(releaseName: string): void {
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      this.downloadProcessor.resumeDownload(item)
    }
  }

  public async deleteDownloadedFiles(releaseName: string): Promise<boolean> {
    const item = this.queueManager.findItem(releaseName)
    if (!item) {
      console.warn(`Cannot delete files for ${releaseName}: Not found.`)
      return Promise.resolve(false)
    }

    const downloadPath = item.downloadPath

    if (!downloadPath) {
      console.log(`No download path for ${releaseName}, removing item.`)
      const removed = this.queueManager.removeItem(releaseName)
      if (removed) this.emitUpdate()
      return Promise.resolve(true)
    }

    if (!existsSync(downloadPath)) {
      console.log(`Path not found for ${releaseName}: ${downloadPath}. Removing item.`)
      const removed = this.queueManager.removeItem(releaseName)
      if (removed) this.emitUpdate()
      return Promise.resolve(true)
    }

    console.log(`Deleting directory: ${downloadPath} for ${releaseName}...`)
    try {
      await fs.rm(downloadPath, { recursive: true, force: true })
      console.log(`Deleted directory ${downloadPath}.`)
      const removed = this.queueManager.removeItem(releaseName)
      if (removed) this.emitUpdate()
      return true
    } catch (error: unknown) {
      console.error(`Error deleting ${downloadPath} for ${releaseName}:`, error)
      let errorMsg = 'Failed to delete files.'
      if (error instanceof Error) {
        errorMsg = `Failed to delete files: ${error.message}`.substring(0, 200)
      } else {
        errorMsg = `Failed to delete files: ${String(error)}`.substring(0, 200)
      }
      const updated = this.queueManager.updateItem(releaseName, { error: errorMsg })
      if (updated) this.emitUpdate()
      return Promise.resolve(false)
    }
  }

  public async installFromCompleted(releaseName: string, deviceId: string): Promise<void> {
    console.log(`[Service] Request to install completed item: ${releaseName} on ${deviceId}`)
    const item = this.queueManager.findItem(releaseName)

    if (!item) {
      console.error(`[Service installFromCompleted] Item not found: ${releaseName}`)
      throw new Error(`Item not found: ${releaseName}`)
    }

    if (item.status !== 'Completed') {
      console.error(
        `[Service installFromCompleted] Item ${releaseName} has status ${item.status}, not 'Completed'. Cannot start installation.`
      )
      throw new Error(`Item ${releaseName} is not in 'Completed' state.`)
    }

    if (this.isProcessing) {
      console.warn(
        `[Service installFromCompleted] Queue is already processing. Installation for ${releaseName} will be handled if it becomes the next item.`
      )
      // Optionally, we could queue this specific action, but for now, let the main loop handle it
      // Or force a status change back to Queued? Seems counter-intuitive.
      // Let's just rely on the check within startInstallation to set status to Installing
      // and proceed if not already processing.
      // throw new Error('Queue is busy') // Maybe throw error?
      return // Don't throw, just log and return. Main loop might pick it up later?
    }

    // Check if the app is connected to the target device
    const targetDeviceForInstall = this.getTargetDeviceForInstallation()
    if (!targetDeviceForInstall) {
      console.error(
        `[Service installFromCompleted] App is not connected to any device. Cannot install ${releaseName}.`
      )
      throw new Error('App is not connected to any device.')
    }

    if (targetDeviceForInstall !== deviceId) {
      console.error(
        `[Service installFromCompleted] App is connected to ${targetDeviceForInstall} but installation requested for ${deviceId}.`
      )
      throw new Error(`App is connected to a different device (${targetDeviceForInstall}).`)
    }

    // Check if the target device is still connected and authorized at the ADB level
    try {
      const devices = await this.adbService.listDevices()
      const targetDevice = devices.find((d) => d.id === deviceId && d.type === 'device')
      if (!targetDevice) {
        console.error(
          `[Service installFromCompleted] Target device ${deviceId} not found or not authorized at ADB level.`
        )
        throw new Error(`Target device ${deviceId} not found or not authorized.`)
      }
    } catch (err) {
      console.error(
        `[Service installFromCompleted] Error verifying target device ${deviceId}:`,
        err
      )
      throw new Error(`Failed to verify target device ${deviceId}.`)
    }

    console.log(
      `[Service installFromCompleted] Triggering installation processor for ${releaseName} on ${deviceId}...`
    )

    // Directly trigger the installation processor
    // The installationProcessor will handle setting the status to 'Installing'
    try {
      const success = await this.installationProcessor.startInstallation(item, deviceId)
      // Log based on success
      if (success) {
        console.log(
          `[Service installFromCompleted] Installation process initiated and reported success for ${releaseName}.`
        )
        // Emit event on successful installation
        this.emit('installation:success', deviceId)
      } else {
        console.warn(
          `[Service installFromCompleted] Installation process initiated for ${releaseName} but reported failure.`
        )
      }
      // Note: We don't await the full completion here, just the initiation.
      // The status updates will come via the processor and emitUpdate.
    } catch (error) {
      console.error(
        `[Service installFromCompleted] Error initiating installation for ${releaseName}:`,
        error
      )
      // Attempt to set error status if possible
      this.updateItemStatus(
        releaseName,
        'InstallError',
        item.progress ?? 100, // Keep progress, default to 100 if undefined
        `Failed to start installation: ${error instanceof Error ? error.message : String(error)}`.substring(
          0,
          200
        ),
        undefined, // speed - not applicable
        undefined, // eta - not applicable
        item.extractProgress ?? 100 // Keep extract progress, default to 100 if undefined
      )
      // Re-throw or just log?
      throw error // Re-throw so the IPC handler logs it
    }
  }

  public async installManualFile(filePath: string, deviceId: string): Promise<boolean> {
    console.log(`[Service] Manual install requested for ${filePath} on device ${deviceId}`)

    // Check if the app is connected to the target device
    const targetDeviceForInstall = this.getTargetDeviceForInstallation()
    if (!targetDeviceForInstall) {
      console.error(
        `[Service installManualFile] App is not connected to any device. Cannot install ${filePath}.`
      )
      return false
    }

    if (targetDeviceForInstall !== deviceId) {
      console.error(
        `[Service installManualFile] App is connected to ${targetDeviceForInstall} but installation requested for ${deviceId}.`
      )
      return false
    }

    // Check if the target device is still connected and authorized at the ADB level
    try {
      const devices = await this.adbService.listDevices()
      const targetDevice = devices.find((d) => d.id === deviceId && d.type === 'device')
      if (!targetDevice) {
        console.error(
          `[Service installManualFile] Target device ${deviceId} not found or not authorized at ADB level.`
        )
        return false
      }
    } catch (err) {
      console.error(`[Service installManualFile] Error verifying target device ${deviceId}:`, err)
      return false
    }

    // Check if the file/folder exists
    if (!existsSync(filePath)) {
      console.error(`[Service installManualFile] File/folder not found: ${filePath}`)
      return false
    }

    try {
      const stats = await fs.stat(filePath)

      if (stats.isFile() && filePath.toLowerCase().endsWith('.apk')) {
        // Single APK file installation
        console.log(`[Service installManualFile] Installing single APK: ${filePath}`)
        const success = await this.adbService.installPackage(deviceId, filePath, {
          flags: ['-r', '-g']
        })
        if (success) {
          console.log(`[Service installManualFile] Successfully installed APK: ${filePath}`)
          this.emit('installation:success', deviceId)
        }
        return success
      } else if (stats.isDirectory()) {
        // Folder installation - create a temporary DownloadItem to use existing installation logic
        console.log(`[Service installManualFile] Installing folder: ${filePath}`)

        // Generate a unique identifier for this manual installation
        const manualId = `manual-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

        // Try to extract package name from folder structure if possible
        let packageName = ''
        try {
          const folderContents = await fs.readdir(filePath)
          const apkFiles = folderContents.filter((f) => f.toLowerCase().endsWith('.apk'))
          if (apkFiles.length > 0) {
            // Look for potential package directory (common pattern in extracted games)
            const potentialPackageDirs = folderContents.filter((item) => {
              // Common package name patterns
              return item.includes('.') && !item.includes(' ') && item.length > 5
            })
            if (potentialPackageDirs.length === 1) {
              packageName = potentialPackageDirs[0]
            }
          }
        } catch (error) {
          console.log(`[Service installManualFile] Could not analyze folder structure: ${error}`)
        }

        // Create a temporary DownloadItem
        const tempItem: DownloadItem = {
          gameId: manualId,
          releaseName: manualId,
          packageName: packageName,
          gameName: `Manual Install: ${filePath.split(/[/\\]/).pop()}`,
          status: 'Completed',
          progress: 100,
          extractProgress: 100,
          addedDate: Date.now(),
          downloadPath: filePath
        }

        // Use the installation processor to handle the folder
        const success = await this.installationProcessor.startInstallation(tempItem, deviceId)
        if (success) {
          console.log(`[Service installManualFile] Successfully installed folder: ${filePath}`)
          this.emit('installation:success', deviceId)
        }
        return success
      } else {
        console.error(`[Service installManualFile] Unsupported file type: ${filePath}`)
        return false
      }
    } catch (error) {
      console.error(
        `[Service installManualFile] Error during manual installation of ${filePath}:`,
        error
      )
      return false
    }
  }

  public async copyObbFolder(folderPath: string, deviceId: string): Promise<boolean> {
    console.log(`[Service] OBB folder copy requested for ${folderPath} on device ${deviceId}`)

    // Check if the app is connected to the target device
    const targetDeviceForInstall = this.getTargetDeviceForInstallation()
    if (!targetDeviceForInstall) {
      console.error(
        `[Service copyObbFolder] App is not connected to any device. Cannot copy OBB folder ${folderPath}.`
      )
      return false
    }

    if (targetDeviceForInstall !== deviceId) {
      console.error(
        `[Service copyObbFolder] App is connected to ${targetDeviceForInstall} but OBB copy requested for ${deviceId}.`
      )
      return false
    }

    // Check if the target device is still connected and authorized at the ADB level
    try {
      const devices = await this.adbService.listDevices()
      const targetDevice = devices.find((d) => d.id === deviceId && d.type === 'device')
      if (!targetDevice) {
        console.error(
          `[Service copyObbFolder] Target device ${deviceId} not found or not authorized at ADB level.`
        )
        return false
      }
    } catch (err) {
      console.error(`[Service copyObbFolder] Error verifying target device ${deviceId}:`, err)
      return false
    }

    // Check if the folder exists
    if (!existsSync(folderPath)) {
      console.error(`[Service copyObbFolder] Folder not found: ${folderPath}`)
      return false
    }

    try {
      const stats = await fs.stat(folderPath)
      if (!stats.isDirectory()) {
        console.error(`[Service copyObbFolder] Path is not a directory: ${folderPath}`)
        return false
      }

      // Get the folder name to use as the target directory name in OBB
      const folderName = folderPath.split(/[/\\]/).pop()
      if (!folderName) {
        console.error(
          `[Service copyObbFolder] Could not extract folder name from path: ${folderPath}`
        )
        return false
      }

      // Ensure the OBB base directory exists on the device
      const obbBasePath = '/sdcard/Android/obb'
      const targetObbPath = `${obbBasePath}/${folderName}`

      console.log(`[Service copyObbFolder] Creating OBB base directory: ${obbBasePath}`)
      try {
        await this.adbService.runShellCommand(deviceId, `mkdir -p "${obbBasePath}"`)
      } catch (mkdirError) {
        console.warn(
          `[Service copyObbFolder] Could not ensure OBB base directory exists (may already exist):`,
          mkdirError
        )
      }

      // Copy the entire folder to the OBB directory
      console.log(`[Service copyObbFolder] Copying folder ${folderPath} to ${targetObbPath}`)
      const success = await this.adbService.pushFileOrFolder(deviceId, folderPath, targetObbPath)

      if (success) {
        console.log(`[Service copyObbFolder] Successfully copied OBB folder to ${targetObbPath}`)
      } else {
        console.error(`[Service copyObbFolder] Failed to copy OBB folder to ${targetObbPath}`)
      }

      return success
    } catch (error) {
      console.error(`[Service copyObbFolder] Error during OBB folder copy of ${folderPath}:`, error)
      return false
    }
  }

  public async refreshLocalStorage(): Promise<{ added: number; updated: number; total: number }> {
    console.log('[Service] Refresh local storage requested')
    try {
      const beforeCount = this.queueManager.getQueue().length
      await this.scanExistingCompletedDownloads()
      const afterCount = this.queueManager.getQueue().length
      
      const added = afterCount - beforeCount
      const updated = 0 // This would need to be tracked in scanExistingCompletedDownloads
      
      console.log(`[Service] Local storage refresh completed successfully. Queue: ${beforeCount} -> ${afterCount}`)
      return { added, updated, total: afterCount }
    } catch (error) {
      console.error('[Service] Error during local storage refresh:', error)
      throw error
    }
  }

  private async scanExistingCompletedDownloads(): Promise<void> {
    try {
      const basePath = this.downloadsPath
      if (!basePath || !existsSync(basePath)) {
        console.warn('[Service] scanExistingCompletedDownloads: downloadsPath missing or invalid')
        return
      }

      const entries = await fs.readdir(basePath, { withFileTypes: true })
      const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      if (folders.length === 0) return

      // Build a quick index of existing queue items by releaseName
      const existing = new Map<string, DownloadItem>()
      this.queueManager.getQueue().forEach((item) => {
        if (item.releaseName) {
          existing.set(item.releaseName, item)
        }
      })

      // Load known games to match folder names to releaseName
      let games: GameInfo[] = []
      try {
        games = await gameService.getGames()
      } catch (e) {
        console.warn('[Service] scanExistingCompletedDownloads: failed to load games list:', e)
      }
      const gameByRelease = new Map<string, GameInfo>()
      games.forEach((g) => {
        if (g.releaseName) gameByRelease.set(g.releaseName, g)
      })

      let addedCount = 0
      let updatedCount = 0

      for (const folderName of folders) {
        const folderPath = join(basePath, folderName)
        
        // Heuristic: consider a folder a completed download if it contains any APK files or an install script
        let looksCompleted = false
        try {
          const sub = await fs.readdir(folderPath)
          const hasApk = sub.some((f) => f.toLowerCase().endsWith('.apk'))
          const hasInstallScript = sub.some(
            (f) => f.toLowerCase() === 'install.txt' || f.toLowerCase() === 'install'
          )
          looksCompleted = hasApk || hasInstallScript
        } catch (e) {
          console.warn('[Service] scanExistingCompletedDownloads: cannot read folder:', folderPath)
        }
        if (!looksCompleted) continue

        const matchedGame = gameByRelease.get(folderName)
        const existingItem = existing.get(folderName)

        if (existingItem) {
          // Update existing item if path has changed
          if (existingItem.downloadPath !== folderPath) {
            console.log(`[Service] Updating path for existing item ${folderName}: ${existingItem.downloadPath} -> ${folderPath}`)
            this.queueManager.updateItem(folderName, {
              downloadPath: folderPath,
              // Also update other fields if we have better game info
              gameName: matchedGame?.name || existingItem.gameName,
              packageName: matchedGame?.packageName || existingItem.packageName,
              thumbnailPath: matchedGame?.thumbnailPath || existingItem.thumbnailPath,
              size: matchedGame?.size || existingItem.size
            })
            updatedCount++
          }
        } else {
          // Add new item
          const newItem: DownloadItem = {
            gameId: matchedGame?.id || folderName,
            releaseName: folderName,
            packageName: matchedGame?.packageName || '',
            gameName: matchedGame?.name || folderName,
            status: 'Completed',
            progress: 100,
            extractProgress: 100,
            addedDate: Date.now(),
            thumbnailPath: matchedGame?.thumbnailPath,
            downloadPath: folderPath,
            size: matchedGame?.size
          }

          this.queueManager.addItem(newItem)
          addedCount++
        }
      }

      if (addedCount > 0 || updatedCount > 0) {
        console.log(`[Service] Imported ${addedCount} new and updated ${updatedCount} existing download item(s) from disk.`)
        this.emitUpdate()
      }
    } catch (e) {
      console.warn('[Service] scanExistingCompletedDownloads encountered an error:', e)
    }
  }
}

export default new DownloadService()
