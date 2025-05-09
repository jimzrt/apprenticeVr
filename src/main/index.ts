import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import adbService from './services/adbService'
import dependencyService from './services/dependencyService'
import gameService from './services/gameService'
import downloadService from './services/downloadService'
import { DependencyStatus } from '../renderer/src/types/adb'

let mainWindow: BrowserWindow | null = null

// Listener for download service events to forward to renderer
downloadService.on('installation:success', (deviceId) => {
  console.log(
    `[Main] Detected successful installation for device: ${deviceId}. Notifying renderer.`
  )
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installation-completed', deviceId)
  }
})

// Function to send dependency progress to renderer
function sendDependencyProgress(
  status: DependencyStatus,
  progress: { name: string; percentage: number }
): void {
  console.log('Sending dependency progress:', progress)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dependency-progress', status, progress)
  }
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false // Allow loading local resources (thumbnails)
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show()
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
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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
  ipcMain.on('initialize-dependencies', async () => {
    // Use .on, could be requested again?
    console.log('Received initialize-dependencies request.')
    try {
      const initialized = await dependencyService.initialize(sendDependencyProgress)
      if (initialized === 'INITIALIZING') {
        return
      }
      console.log('Dependency initialization complete. Sending status.')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dependency-setup-complete', dependencyService.getStatus())
        // --- Initialize other services that depend on dependencies ---
        try {
          console.log('Dependencies ready, initializing dependent services...')
          // Initialize ADB Service (needs adb path from dependencyService)
          await adbService.initialize()
          console.log('ADB Service initialized.')
          // Initialize Game Service (needs 7z and rclone from dependencyService)
          const gameServiceStatus = await gameService.initialize()
          console.log(`Game Service initialization status: ${gameServiceStatus}`)
          // Initialize Download Service (needs rclone and VRP config from gameService)
          if (gameServiceStatus === 'INITIALIZED') {
            await downloadService.initialize(gameService.getVrpConfig()) // Pass VRP config
            console.log('Download Service initialized.')
          } else {
            console.warn(
              'Game service did not initialize correctly, skipping download service initialization.'
            )
          }
        } catch (serviceInitError) {
          console.error('Error initializing dependent services:', serviceInitError)
          // Optionally notify the renderer about this failure
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('service-init-error', {
              message:
                serviceInitError instanceof Error
                  ? serviceInitError.message
                  : 'Unknown service initialization error'
            })
          }
        }
        // -----------------------------------------------------------
      }
    } catch (error) {
      console.error('Error during dependency initialization:', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dependency-setup-error', {
          message:
            error instanceof Error ? error.message : 'Unknown dependency initialization error',
          status: dependencyService.getStatus() // Send current status even on error
        })
      }
    }
  })

  ipcMain.handle('initialize-adb-service', async () => {
    console.log('Received initialize-adb-service request.')
    try {
      await adbService.initialize()
      console.log('ADB service initialized successfully.')
      // Optionally return something, or just resolve promise
      return true
    } catch (error) {
      console.error('Error initializing adb service:', error)
      // Rethrow or handle error appropriately
      throw error // Let renderer know it failed
    }
  })

  // --- Game Service Initializer ---
  ipcMain.handle('initialize-game-service', async () => {
    console.log('Received initialize-game-service request.')
    try {
      const initialized = await gameService.initialize()
      if (initialized === 'INITIALIZING') {
        return
      }
      console.log('Game service initialized successfully.')
      // Optionally return something, or just resolve promise
      return true
    } catch (error) {
      console.error('Error initializing game service:', error)
      // Rethrow or handle error appropriately
      throw error // Let renderer know it failed
    }
  })

  // --- ADB Handlers ---
  ipcMain.handle('list-devices', async () => await adbService.listDevices())
  ipcMain.handle('connect-device', async (_event, serial: string) => {
    return await adbService.connectToDevice(serial)
  })
  ipcMain.handle('disconnect-device', async () => {
    // Implementation needed
  })
  ipcMain.handle(
    'get-installed-packages',
    async (_event, serial: string) => await adbService.getInstalledPackages(serial)
  )
  ipcMain.handle(
    'adb:getPackageVersionCode',
    async (_event, serial: string, packageName: string) => {
      console.log(`IPC adb:getPackageVersionCode called for ${packageName} on ${serial}`)
      return await adbService.getPackageVersionCode(serial, packageName)
    }
  )
  ipcMain.on('start-tracking-devices', () => {
    if (mainWindow) adbService.startTrackingDevices(mainWindow)
    else console.error('Cannot start tracking devices, mainWindow is not available.')
  })
  ipcMain.on('stop-tracking-devices', () => adbService.stopTrackingDevices())
  ipcMain.handle('adb:uninstallPackage', async (_event, serial: string, packageName: string) => {
    console.log(`IPC adb:uninstallPackage called for ${packageName} on ${serial}`)
    return await adbService.uninstallPackage(serial, packageName)
  })

  // --- Game Handlers ---
  ipcMain.handle('get-games', async () => gameService.getGames())
  ipcMain.handle('get-last-sync-time', async () => gameService.getLastSyncTime())
  ipcMain.handle('force-sync-games', async () => {
    await gameService.forceSync()
    return gameService.getGames()
  })
  ipcMain.handle('get-note', async (_event, releaseName: string) => {
    return gameService.getNote(releaseName)
  })

  // --- Download Handlers ---
  ipcMain.handle('download:get-queue', () => downloadService.getQueue())
  ipcMain.handle('download:add', (_event, game) => downloadService.addToQueue(game))
  ipcMain.on('download:remove', (_event, releaseName) =>
    downloadService.removeFromQueue(releaseName)
  )
  ipcMain.on('download:cancel', (_event, releaseName) =>
    downloadService.cancelUserRequest(releaseName)
  )
  ipcMain.on('download:retry', (_event, releaseName) => downloadService.retryDownload(releaseName))
  ipcMain.handle('download:delete-files', (_event, releaseName) =>
    downloadService.deleteDownloadedFiles(releaseName)
  )
  ipcMain.handle('download:install-from-completed', (_event, releaseName, deviceId) => {
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

  // Create window FIRST
  createWindow()

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
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
