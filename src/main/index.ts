import { app, shell, BrowserWindow, protocol, dialog, ipcMain } from 'electron'
import { join, normalize, extname, sep } from 'path'
import { createServer, Server } from 'http'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import adbService from './services/adbService'
import dependencyService, { DependencyStatus } from './services/dependencyService'
import gameService from './services/gameService'
import downloadService from './services/downloadService'
import uploadService from './services/uploadService'
import updateService from './services/updateService'
import logsService from './services/logsService'
import mirrorService from './services/mirrorService'
import wifiBookmarksService from './services/wifiBookmarksService'
import { typedIpcMain } from '@shared/ipc-utils'
import settingsService from './services/settingsService'
import { typedWebContentsSend } from '@shared/ipc-utils'
import log from 'electron-log/main'
import fs from 'fs/promises'
import { createReadStream } from 'fs'

log.transports.file.resolvePathFn = () => {
  return logsService.getLogFilePath()
}
log.initialize()
log.errorHandler.startCatching({
  showDialog: false
})
Object.assign(console, log.functions)
// Fix for certain Linux distributions - force GTK version 3
// https://github.com/electron/electron/issues/46538
app.commandLine.appendSwitch('gtk-version', '3')

let mainWindow: BrowserWindow | null = null
let rendererServer: { url: string; close: () => Promise<void> } | null = null

const getMimeType = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html'
    case '.js':
      return 'text/javascript'
    case '.css':
      return 'text/css'
    case '.json':
      return 'application/json'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.wasm':
      return 'application/wasm'
    default:
      return 'application/octet-stream'
  }
}

const startRendererServer = async (rootDir: string): Promise<{ url: string; close: () => Promise<void> }> => {
  const normalizedRoot = normalize(rootDir)

  return await new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      try {
        if (!req.url) {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }

        const requestUrl = new URL(req.url, 'http://127.0.0.1')
        let pathname = decodeURIComponent(requestUrl.pathname)

        if (pathname === '/') {
          pathname = '/index.html'
        }

        const filePath = normalize(join(normalizedRoot, pathname))

        if (filePath !== normalizedRoot && !filePath.startsWith(normalizedRoot + sep)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        const stat = await fs.stat(filePath)
        if (stat.isDirectory()) {
          res.statusCode = 404
          res.end('Not Found')
          return
        }

        res.setHeader('Content-Type', getMimeType(filePath))
        res.setHeader('Cache-Control', 'no-cache')

        const stream = createReadStream(filePath)
        stream.on('error', (error) => {
          console.error('[RendererServer] Stream error:', error)
          if (!res.headersSent) {
            res.statusCode = 500
          }
          res.end('Server Error')
        })
        stream.pipe(res)
      } catch {
        res.statusCode = 404
        res.end('Not Found')
      }
    })

    server.on('error', (error) => {
      reject(error)
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind renderer server'))
        return
      }
      const url = `http://127.0.0.1:${address.port}`
      resolve({
        url,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve())
          })
      })
    })
  })
}

// Listener for download service events to forward to renderer
downloadService.on('installation:success', (deviceId) => {
  console.log(
    `[Main] Detected successful installation for device: ${deviceId}. Notifying renderer.`
  )
  if (mainWindow && !mainWindow.isDestroyed()) {
    typedWebContentsSend.send(mainWindow, 'adb:installation-completed', deviceId)
  }
})

// Function to send dependency progress to renderer
function sendDependencyProgress(
  status: DependencyStatus,
  progress: { name: string; percentage: number }
): void {
  console.log('Sending dependency progress:', progress)
  if (mainWindow && !mainWindow.isDestroyed()) {
    typedWebContentsSend.send(mainWindow, 'dependency-progress', status, progress)
  }
}

async function createWindow(): Promise<void> {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    minWidth: 1200,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: 'apprenticevr',
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false // Allow loading local resources (thumbnails)
    }
  })

  // Explicitly set minimum size to ensure constraint is enforced
  mainWindow.setMinimumSize(1200, 900)

  mainWindow.on('ready-to-show', async () => {
    if (mainWindow) {
      mainWindow.show()

      // Use .on, could be requested again?
      console.log('Received initialize-dependencies request.')
      try {
        const initialized = await dependencyService.initialize(sendDependencyProgress)
        if (initialized === 'INITIALIZING') {
          return
        }
        console.log('Dependency initialization complete. Sending status.')
        if (mainWindow && !mainWindow.isDestroyed()) {
          // --- Initialize other services that depend on dependencies ---
          try {
            console.log('Dependencies ready, initializing dependent services...')
            dependencyService.setDependencyServiceStatus('INITIALIZING')
            // Initialize ADB Service (needs adb path from dependencyService)
            await adbService.initialize()
            console.log('ADB Service initialized.')
            // Initialize Game Service (needs 7z and rclone from dependencyService)
            const gameServiceStatus = await gameService.initialize()
            console.log(`Game Service initialization status: ${gameServiceStatus}`)
            const vrpConfig = await gameService.getVrpConfig()
            // Initialize Download Service (needs VRP config from gameService)
            if (vrpConfig) {
              await downloadService.initialize(vrpConfig) // Pass VRP config
              console.log('Download Service initialized.')
            } else {
              console.warn(
                'vrpConfig did not initialize correctly, skipping download service initialization.'
              )
            }
            // Initialize Upload Service
            await uploadService.initialize()
            console.log('Upload Service initialized.')

            // Initialize Mirror Service
            await mirrorService.initialize()
            console.log('Mirror Service initialized.')

            // Initialize WiFi Bookmarks Service
            await wifiBookmarksService.initialize()
            console.log('WiFi Bookmarks Service initialized.')
            dependencyService.setDependencyServiceStatus('INITIALIZED')

            // Initialize Update Service
            if (mainWindow) {
              updateService.initialize()
              console.log('Update Service initialized.')

              // Check for updates on startup
              updateService.checkForUpdates().catch((err) => {
                console.error('Failed to check for updates on startup:', err)
              })
            }

            typedWebContentsSend.send(
              mainWindow,
              'dependency-setup-complete',
              dependencyService.getStatus()
            )
          } catch (serviceInitError) {
            console.error('Error initializing dependent services:', serviceInitError)
            dependencyService.setDependencyServiceStatus('ERROR')
            // Optionally notify the renderer about this failure
            // if (mainWindow && !mainWindow.isDestroyed()) {
            //   typedWebContentsSend.send(mainWindow, 'service-init-error', {
            //     message:
            //       serviceInitError instanceof Error
            //         ? serviceInitError.message
            //         : 'Unknown service initialization error'
            //   })
            // }
          }
          // -----------------------------------------------------------
        }
      } catch (error) {
        console.error('Error during dependency initialization:', error)
        if (mainWindow && !mainWindow.isDestroyed()) {
          typedWebContentsSend.send(mainWindow, 'dependency-setup-error', {
            message:
              error instanceof Error ? error.message : 'Unknown dependency initialization error',
            status: dependencyService.getStatus() // Send current status even on error
          })
        }
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    if (!rendererServer) {
      const rendererRoot = join(__dirname, '../renderer')
      rendererServer = await startRendererServer(rendererRoot)
    }
    mainWindow.loadURL(rendererServer.url)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.apprenticevr')

  // Setup file protocol handler for local resources
  protocol.registerFileProtocol('file', (request, callback) => {
    const pathname = decodeURI(request.url.replace('file:///', ''))
    callback(pathname)
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // --------- IPC Handlers --------- //

  // --- Dependency Handlers ---
  typedIpcMain.handle('dependency:get-status', async () => dependencyService.getStatus())

  // --- ADB Handlers ---
  typedIpcMain.handle('adb:list-devices', async () => await adbService.listDevices())
  typedIpcMain.handle('adb:connect-device', async (_event, serial) => {
    return await adbService.connectDevice(serial)
  })
  typedIpcMain.handle('adb:connect-tcp-device', async (_event, ipAddress, port) => {
    return await adbService.connectTcpDevice(ipAddress, port)
  })
  typedIpcMain.handle('adb:disconnect-tcp-device', async (_event, ipAddress, port) => {
    return await adbService.disconnectTcpDevice(ipAddress, port)
  })
  typedIpcMain.handle(
    'adb:get-installed-packages',
    async (_event, serial) => await adbService.getInstalledPackages(serial)
  )
  typedIpcMain.handle('adb:uninstallPackage', async (_event, serial, packageName) => {
    console.log(`IPC adb:uninstallPackage called for ${packageName} on ${serial}`)
    return await adbService.uninstallPackage(serial, packageName)
  })
  typedIpcMain.on('adb:start-tracking-devices', () => {
    if (mainWindow) adbService.startTrackingDevices(mainWindow)
    else console.error('Cannot start tracking devices, mainWindow is not available.')
  })
  typedIpcMain.on('adb:stop-tracking-devices', () => adbService.stopTrackingDevices())
  typedIpcMain.handle('adb:get-application-label', async (_event, serial, packageName) => {
    return await adbService.getApplicationLabel(serial, packageName)
  })
  typedIpcMain.handle('adb:get-user-name', async (_event, serial) => {
    return await adbService.getUserName(serial)
  })
  typedIpcMain.handle('adb:set-user-name', async (_event, serial, name) => {
    return await adbService.setUserName(serial, name)
  })
  typedIpcMain.handle('adb:get-device-ip', async (_event, serial) => {
    return await adbService.getDeviceIp(serial)
  })
  typedIpcMain.handle('adb:ping-device', async (_event, ipAddress) => {
    return adbService.pingDevice(ipAddress)
  })

  // --- Game Handlers ---
  typedIpcMain.handle('games:get-games', async () => gameService.getGames())
  typedIpcMain.handle('games:get-blacklist-games', async () => gameService.getBlacklistGames())
  typedIpcMain.handle('games:add-to-blacklist', async (_event, packageName, version) => {
    return gameService.addToBlacklist(packageName, version)
  })
  typedIpcMain.handle('games:remove-from-blacklist', async (_event, packageName) => {
    return gameService.removeFromBlacklist(packageName)
  })
  typedIpcMain.handle('games:is-game-blacklisted', async (_event, packageName, version) => {
    return gameService.isGameBlacklisted(packageName, version)
  })
  typedIpcMain.handle('games:get-last-sync-time', async () => gameService.getLastSyncTime())
  typedIpcMain.handle('games:force-sync-games', async () => {
    await gameService.forceSync()
    return gameService.getGames()
  })
  typedIpcMain.handle('games:get-note', async (_event, releaseName) => {
    return gameService.getNote(releaseName)
  })
  typedIpcMain.handle('games:get-trailer-video-id', async (_event, gameName) => {
    return gameService.getTrailerVideoId(gameName)
  })

  // --- Download Handlers ---
  typedIpcMain.handle('download:get-queue', () => downloadService.getQueue())
  typedIpcMain.handle('download:add', (_event, game) => downloadService.addToQueue(game))
  typedIpcMain.handle('download:delete-files', (_event, releaseName) =>
    downloadService.deleteDownloadedFiles(releaseName)
  )
  typedIpcMain.handle('download:install-from-completed', (_event, releaseName, deviceId) => {
    console.log(
      `[IPC] Received request to install from completed: ${releaseName} on device ${deviceId}`
    )
    // No return value needed, fire-and-forget, status updated via queue listener
    downloadService.installFromCompleted(releaseName, deviceId).catch((err) => {
      // Log error here as the renderer won't get a rejection for this invoke
      console.error(
        `[IPC Handler Error] installFromCompleted failed for ${releaseName} on ${deviceId}:`,
        err
      )
    })
  })

  // --- Upload Handlers ---
  typedIpcMain.handle(
    'upload:prepare',
    async (_event, packageName, gameName, versionCode, deviceId) => {
      console.log(
        `[IPC] Received request to prepare upload for: ${packageName} (${gameName}) version ${versionCode} from device ${deviceId}`
      )
      try {
        return await uploadService.prepareUpload(packageName, gameName, versionCode, deviceId)
      } catch (err) {
        console.error(`[IPC Handler Error] Upload preparation failed for ${packageName}:`, err)
        return null
      }
    }
  )

  typedIpcMain.handle('upload:get-queue', () => uploadService.getQueue())

  typedIpcMain.handle(
    'upload:add-to-queue',
    async (_event, packageName, gameName, versionCode, deviceId) => {
      console.log(
        `[IPC] Adding to upload queue: ${packageName} (${gameName}) version ${versionCode} from device ${deviceId}`
      )
      return uploadService.addToQueue(packageName, gameName, versionCode, deviceId)
    }
  )

  typedIpcMain.on('upload:remove', (_event, packageName) => {
    console.log(`[IPC] Removing from upload queue: ${packageName}`)
    uploadService.removeFromQueue(packageName)
  })

  typedIpcMain.on('upload:cancel', (_event, packageName) => {
    console.log(`[IPC] Cancelling upload: ${packageName}`)
    uploadService.cancelUpload(packageName)
  })

  typedIpcMain.handle('download:remove', async (_event, releaseName) => {
    console.log(`[IPC] Removing from download queue: ${releaseName}`)
    await downloadService.removeFromQueue(releaseName)
  })

  typedIpcMain.on('download:cancel', (_event, releaseName) =>
    downloadService.cancelUserRequest(releaseName)
  )

  typedIpcMain.on('download:retry', (_event, releaseName) =>
    downloadService.retryDownload(releaseName)
  )

  typedIpcMain.on('download:pause', (_event, releaseName) =>
    downloadService.pauseDownload(releaseName)
  )
  typedIpcMain.on('download:resume', (_event, releaseName) =>
    downloadService.resumeDownload(releaseName)
  )

  typedIpcMain.on('download:set-download-path', (_event, path) =>
    downloadService.setDownloadPath(path)
  )

  ipcMain.on('download:set-app-connection-state', (_event, selectedDevice, isConnected) => {
    console.log(
      `[IPC] Setting app connection state - Device: ${selectedDevice}, Connected: ${isConnected}`
    )
    downloadService.setAppConnectionState(selectedDevice, isConnected)
  })

  // --- Update Handlers ---
  typedIpcMain.handle('update:check-for-updates', async () => {
    console.log('[IPC] Check for updates requested')
    return updateService.checkForUpdates()
  })

  typedIpcMain.on('update:download', (_event, url) => {
    console.log('[IPC] Open download page requested for:', url)
    updateService.openDownloadPage(url)
  })

  typedIpcMain.on('update:open-releases', () => {
    console.log('[IPC] Open releases page requested')
    updateService.openReleasesPage()
  })

  typedIpcMain.on('update:open-repository', () => {
    console.log('[IPC] Open repository page requested')
    updateService.openRepositoryPage()
  })

  // Set up update service event forwarding to renderer
  updateService.on('checking-for-update', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      typedWebContentsSend.send(mainWindow, 'update:checking-for-update')
    }
  })

  updateService.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      typedWebContentsSend.send(mainWindow, 'update:update-available', info)
    }
  })

  updateService.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      typedWebContentsSend.send(mainWindow, 'update:error', err)
    }
  })

  // --- Settings Handlers ---
  typedIpcMain.handle('settings:get-download-path', () => settingsService.getDownloadPath())
  typedIpcMain.handle('settings:set-download-path', (_event, path) =>
    settingsService.setDownloadPath(path)
  )
  typedIpcMain.handle('settings:get-download-speed-limit', () =>
    settingsService.getDownloadSpeedLimit()
  )
  typedIpcMain.handle('settings:set-download-speed-limit', (_event, limit) =>
    settingsService.setDownloadSpeedLimit(limit)
  )
  typedIpcMain.handle('settings:get-upload-speed-limit', () =>
    settingsService.getUploadSpeedLimit()
  )
  typedIpcMain.handle('settings:set-upload-speed-limit', (_event, limit) =>
    settingsService.setUploadSpeedLimit(limit)
  )

  typedIpcMain.handle('settings:get-color-scheme', () => settingsService.getColorScheme())
  typedIpcMain.handle('settings:set-color-scheme', (_event, scheme) =>
    settingsService.setColorScheme(scheme)
  )

  // --- Logs Handlers ---
  typedIpcMain.handle('logs:upload-current', async () => {
    console.log('[IPC] Log upload requested')
    try {
      return await logsService.uploadCurrentLog()
    } catch (error) {
      console.error('[IPC Handler Error] Log upload failed:', error)
      return null
    }
  })

  // --- WiFi Bookmark Handlers ---
  typedIpcMain.handle('wifi-bookmarks:get-all', async () => {
    return await wifiBookmarksService.getAllBookmarks()
  })

  typedIpcMain.handle('wifi-bookmarks:add', async (_event, name, ipAddress, port) => {
    console.log(`[IPC] Adding WiFi bookmark: ${name} (${ipAddress}:${port})`)
    return await wifiBookmarksService.addBookmark(name, ipAddress, port)
  })

  typedIpcMain.handle('wifi-bookmarks:remove', async (_event, id) => {
    console.log(`[IPC] Removing WiFi bookmark: ${id}`)
    return await wifiBookmarksService.removeBookmark(id)
  })

  typedIpcMain.handle('wifi-bookmarks:update-last-connected', async (_event, id) => {
    await wifiBookmarksService.updateLastConnected(id)
  })

  // --- Mirror Handlers ---
  typedIpcMain.handle('mirrors:get-mirrors', async () => {
    return await mirrorService.getMirrors()
  })

  typedIpcMain.handle('mirrors:add-mirror', async (_event, configContent) => {
    console.log('[IPC] Adding mirror from config content')
    return await mirrorService.addMirror(configContent)
  })

  typedIpcMain.handle('mirrors:remove-mirror', async (_event, id) => {
    console.log(`[IPC] Removing mirror: ${id}`)
    return await mirrorService.removeMirror(id)
  })

  typedIpcMain.handle('mirrors:set-active-mirror', async (_event, id) => {
    console.log(`[IPC] Setting active mirror: ${id}`)
    return await mirrorService.setActiveMirror(id)
  })

  typedIpcMain.handle('mirrors:clear-active-mirror', async () => {
    console.log('[IPC] Clearing active mirror')
    return await mirrorService.clearActiveMirror()
  })

  typedIpcMain.handle('mirrors:test-mirror', async (_event, id) => {
    console.log(`[IPC] Testing mirror: ${id}`)
    return await mirrorService.testMirror(id)
  })

  typedIpcMain.handle('mirrors:test-all-mirrors', async () => {
    console.log('[IPC] Testing all mirrors')
    return await mirrorService.testAllMirrors()
  })

  typedIpcMain.handle('mirrors:get-active-mirror', async () => {
    return await mirrorService.getActiveMirror()
  })

  typedIpcMain.handle('mirrors:import-from-file', async () => {
    console.log('[IPC] Importing mirror config from file')
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select Mirror Config File',
      filters: [
        { name: 'Config Files', extensions: ['conf', 'ini', 'txt', 'config'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    try {
      const configContent = await fs.readFile(filePaths[0], 'utf-8')
      console.log(`[IPC] Successfully read config file: ${filePaths[0]}`)
      return configContent
    } catch (error) {
      console.error(`[IPC] Failed to read config file ${filePaths[0]}:`, error)
      return null
    }
  })

  // --- Dialog Handlers ---
  typedIpcMain.handle('dialog:show-directory-picker', async () => {
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Download Folder',
      defaultPath: settingsService.getDownloadPath()
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    return filePaths[0]
  })

  typedIpcMain.handle('dialog:show-file-picker', async (_event, options) => {
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select Mirror Config File',
      filters: options?.filters || [
        { name: 'Config Files', extensions: ['conf', 'ini', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    return filePaths[0]
  })

  // Manual installation handlers
  typedIpcMain.handle('dialog:show-manual-install-picker', async () => {
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'openDirectory'],
      title: 'Select APK file or folder to install',
      filters: [
        { name: 'APK Files', extensions: ['apk'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    return filePaths[0]
  })

  typedIpcMain.handle('dialog:show-apk-file-picker', async () => {
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select APK file to install',
      filters: [
        { name: 'APK Files', extensions: ['apk'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    return filePaths[0]
  })

  typedIpcMain.handle('dialog:show-folder-picker', async () => {
    if (!mainWindow) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select folder to install'
    })

    if (canceled || filePaths.length === 0) {
      return null
    }

    return filePaths[0]
  })

  typedIpcMain.handle('downloads:install-manual', async (_event, filePath, deviceId) => {
    console.log(`[IPC] Manual install requested for ${filePath} on device ${deviceId}`)
    return await downloadService.installManualFile(filePath, deviceId)
  })

  typedIpcMain.handle('downloads:copy-obb-folder', async (_event, folderPath, deviceId) => {
    console.log(`[IPC] OBB folder copy requested for ${folderPath} on device ${deviceId}`)
    return await downloadService.copyObbFolder(folderPath, deviceId)
  })

  // Validate that all IPC channels have handlers registered
  const allHandled = typedIpcMain.validateAllHandlersRegistered()
  if (!allHandled) {
    console.warn('WARNING: Not all IPC channels have registered handlers!')
  } else {
    console.log('All IPC channels have registered handlers.')
  }

  // Create window FIRST
  await createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  adbService.stopTrackingDevices() // Stop tracking when app quits
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up ADB tracking when app is quitting
app.on('will-quit', () => {
  adbService.stopTrackingDevices()
  if (rendererServer) {
    rendererServer.close().catch((error) => {
      console.warn('Failed to close renderer server:', error)
    })
    rendererServer = null
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
