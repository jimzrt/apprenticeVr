import { Adb, DeviceClient } from '@devicefarmer/adbkit'
import Tracker from '@devicefarmer/adbkit/dist/src/adb/tracker'
import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import dependencyService from './dependencyService'
import fs, { Dirent } from 'fs'
import path from 'path'
import ping from 'pingman'
import { AdbAPI, DeviceInfo, PackageInfo, ServiceStatus } from '@shared/types'
import { typedWebContentsSend } from '@shared/ipc-utils'

const QUEST_MODELS = ['monterey', 'hollywood', 'seacliff', 'eureka', 'panther', 'sekiu'] as const
type QuestModel = (typeof QUEST_MODELS)[number]

// Mapping from codename (ro.product.device) to friendly name
const QUEST_MODEL_NAMES: Record<QuestModel, string> = {
  monterey: 'Oculus Quest',
  hollywood: 'Meta Quest 2',
  seacliff: 'Meta Quest Pro',
  eureka: 'Meta Quest 3',
  panther: 'Meta Quest 3S / Lite',
  sekiu: 'Meta XR Simulator'
}

class AdbService extends EventEmitter implements AdbAPI {
  private client: ReturnType<typeof Adb.createClient> | null
  private deviceTracker: Tracker | null = null
  private isTracking = false
  private status: ServiceStatus = 'NOT_INITIALIZED'
  private aaptPushed = false
  private lastInstallError: string | null = null

  constructor() {
    super()
    this.client = null
  }

  public getLastInstallError(): string | null {
    return this.lastInstallError
  }

  public async initialize(): Promise<ServiceStatus> {
    if (this.status === 'INITIALIZING') {
      console.warn('AdbService is already initializing, skipping.')
      return 'INITIALIZING'
    }
    if (this.status === 'INITIALIZED') {
      console.warn('AdbService is already initialized, skipping.')
      return 'INITIALIZED'
    }

    this.status = 'INITIALIZING'
    try {
      this.client = Adb.createClient({
        bin: dependencyService.getAdbPath()
      })
    } catch (error) {
      console.error('Error initializing AdbService:', error)
      this.status = 'ERROR'
      return 'ERROR'
    }

    this.status = 'INITIALIZED'
    return 'INITIALIZED'
  }

  private async getDeviceDetails(serial: string): Promise<DeviceInfo | null> {
    if (!this.client) {
      console.warn('ADB client not initialized, cannot get device details.')
      return null
    }
    const device = this.client.getDevice(serial)

    try {
      // Get product model
      const manufacturerOutput = await device.shell('getprop ro.product.manufacturer')
      const manufacturerResult = (await Adb.util.readAll(manufacturerOutput))
        .toString()
        .trim()
        .toLowerCase()

      const modelOutput = await device.shell('getprop ro.product.device')
      const modelResult = (await Adb.util.readAll(modelOutput))
        .toString()
        .trim()
        .toLowerCase() as QuestModel

      const isQuestDevice = manufacturerResult === 'oculus' && QUEST_MODELS.includes(modelResult)

      // Determine friendly name
      const friendlyModelName = isQuestDevice
        ? QUEST_MODEL_NAMES[modelResult]
        : `Unknown Device (${manufacturerResult} ${modelResult})`

      // Get IP address
      let ipAddress: string | null = null
      try {
        const ipOutput = await device.shell('ip route')
        const ipResult = (await Adb.util.readAll(ipOutput)).toString().trim()
        // Parse IP from "192.168.178.0/24 dev wlan0 proto kernel scope link src 192.168.178.106"
        const ipMatch = ipResult.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)
        if (ipMatch && ipMatch[1]) {
          ipAddress = ipMatch[1]
        }
      } catch (ipError) {
        console.warn(`Could not fetch IP address for ${serial}:`, ipError)
      }

      // Get battery level
      let batteryLevel: number | null = null
      try {
        const batteryOutput = await device.shell('dumpsys battery | grep level')
        const batteryResult = (await Adb.util.readAll(batteryOutput)).toString().trim()
        const batteryMatch = batteryResult.match(/level: (\d+)/)
        if (batteryMatch && batteryMatch[1]) {
          batteryLevel = parseInt(batteryMatch[1], 10)
        }
      } catch (batteryError) {
        console.warn(`Could not fetch battery level for ${serial}:`, batteryError)
      }

      // Get storage (df -h /data)
      // Output format is like:
      // Filesystem      Size  Used Avail Use% Mounted on
      // /dev/block/dm-5 107G   53G   55G  50% /data
      let storageTotal: string | null = null
      let storageFree: string | null = null
      try {
        const storageOutput = await device.shell('df -h /data')
        const storageResult = (await Adb.util.readAll(storageOutput)).toString().trim()
        const lines = storageResult.split('\n')
        if (lines.length > 1) {
          const dataLine = lines[1].split(/\s+/)
          if (dataLine.length >= 4) {
            storageTotal = dataLine[1] // Size
            storageFree = dataLine[3] // Avail
          }
        }
      } catch (storageError) {
        console.warn(`Could not fetch storage info for ${serial}:`, storageError)
      }

      return {
        id: serial,
        type: 'device',
        model: modelResult,
        isQuestDevice,
        batteryLevel,
        storageTotal,
        storageFree,
        friendlyModelName,
        ipAddress
      }
    } catch (error) {
      console.error(`Error getting details for device ${serial}:`, error)
      return null // Or a default object indicating failure
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      const devices = await this.client.listDevices()
      const extendedDevices: DeviceInfo[] = []

      for (const device of devices) {
        // For 'device' and 'emulator' types, always try to get details.
        // For other types (offline, unauthorized, unknown), create a basic ExtendedDevice.
        if (device.type === 'device' || device.type === 'emulator') {
          const details = await this.getDeviceDetails(device.id)
          // Include the device even if details are null or it's not a Quest device.
          // The 'isQuestDevice' field in 'details' (or lack thereof) will guide the UI.
          extendedDevices.push({
            ...device,
            ...(details || {
              model: null,
              isQuestDevice: false,
              batteryLevel: null,
              storageTotal: null,
              storageFree: null,
              friendlyModelName: null,
              ipAddress: null
            })
          })
        } else {
          // For offline, unauthorized, unknown devices, we don't fetch extended details.
          // We still want to list them.
          extendedDevices.push({
            ...device,
            model: null,
            isQuestDevice: false, // Not a connectable Quest device in this state
            batteryLevel: null,
            storageTotal: null,
            storageFree: null,
            friendlyModelName: null,
            ipAddress: null
          })
        }
      }
      return extendedDevices
    } catch (error) {
      console.error('Error listing devices:', error)
      return []
    }
  }

  async startTrackingDevices(mainWindow?: BrowserWindow): Promise<void> {
    if (this.isTracking) {
      return
    }
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }

    this.isTracking = true

    this.deviceTracker = await this.client.trackDevices()

    this.deviceTracker.on('add', async (device: DeviceInfo) => {
      console.log('Device added:', device)
      if (device.type === 'device' || device.type === 'emulator') {
        const details = await this.getDeviceDetails(device.id)
        const extendedDevice: DeviceInfo = {
          ...device,
          ...(details || {
            model: null,
            isQuestDevice: false,
            batteryLevel: null,
            storageTotal: null,
            storageFree: null,
            friendlyModelName: null,
            ipAddress: null
          })
        }
        // Emit event for our internal listeners
        this.emit('adb:device-added', extendedDevice)
        // Send to UI if window exists
        if (mainWindow) {
          typedWebContentsSend.send(mainWindow, 'adb:device-added', extendedDevice)
        }
      } else {
        // For 'offline', 'unauthorized', 'unknown' devices
        const extendedDevice: DeviceInfo = {
          ...device,
          model: null,
          isQuestDevice: false,
          batteryLevel: null,
          storageTotal: null,
          storageFree: null,
          friendlyModelName: null,
          ipAddress: null
        }
        this.emit('adb:device-added', extendedDevice)
        if (mainWindow) {
          typedWebContentsSend.send(mainWindow, 'adb:device-added', extendedDevice)
        }
      }
    })

    this.deviceTracker.on('remove', (device) => {
      console.log('Device removed:', device)

      // Send a basic device object, details aren't relevant for removal
      const deviceInfo = {
        id: device.id,
        type: device.type,
        model: null,
        isQuestDevice: false,
        batteryLevel: null,
        storageTotal: null,
        storageFree: null,
        friendlyModelName: null,
        ipAddress: null
      } satisfies DeviceInfo

      this.emit('adb:device-removed', deviceInfo)
      if (mainWindow) {
        typedWebContentsSend.send(mainWindow, 'adb:device-removed', deviceInfo)
      }
    })

    this.deviceTracker.on('change', async (device: DeviceInfo) => {
      console.log('Device changed:', device)
      // This event typically signifies a device coming online (e.g., from 'offline' to 'device')
      // or a device's properties changing.
      if (device.type === 'device' || device.type === 'emulator') {
        const details = await this.getDeviceDetails(device.id)
        const extendedDevice: DeviceInfo = {
          ...device,
          ...(details || {
            model: null,
            isQuestDevice: false,
            batteryLevel: null,
            storageTotal: null,
            storageFree: null,
            friendlyModelName: null,
            ipAddress: null
          })
        }
        this.emit('adb:device-changed', extendedDevice)
        if (mainWindow) {
          typedWebContentsSend.send(mainWindow, 'adb:device-changed', extendedDevice)
        }
      } else {
        // Handle changes for devices becoming offline, unauthorized, etc.
        const extendedDevice: DeviceInfo = {
          ...device,
          model: null,
          isQuestDevice: false,
          batteryLevel: null,
          storageTotal: null,
          storageFree: null,
          friendlyModelName: null,
          ipAddress: null
        }
        this.emit('adb:device-changed', extendedDevice)
        if (mainWindow) {
          typedWebContentsSend.send(mainWindow, 'adb:device-changed', extendedDevice)
        }
      }
    })

    this.deviceTracker.on('error', (error) => {
      console.error('Device tracker error:', error)
      this.emit('tracker-error', error.message)
      if (mainWindow) {
        typedWebContentsSend.send(mainWindow, 'adb:device-tracker-error', error.message)
      }
      this.stopTrackingDevices()
    })
  }

  stopTrackingDevices(): void {
    if (this.deviceTracker) {
      this.deviceTracker.end()
      this.deviceTracker = null
    }
    this.isTracking = false
  }

  async connectDevice(serial: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      // Create a device instance
      const deviceClient = this.client.getDevice(serial)

      // Test connection by getting device properties
      await deviceClient.getProperties()
      return true
    } catch (error) {
      console.error(`Error connecting to device ${serial}:`, error)
      return false
    }
  }

  async connectTcpDevice(ipAddress: string, port: number = 5555): Promise<boolean> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      console.log(`[ADB Service] Attempting to connect to TCP device ${ipAddress}:${port}...`)

      // Use adb connect command
      await this.client.connect(ipAddress, port)

      // Verify connection by trying to get device properties
      const deviceClient = this.client.getDevice(`${ipAddress}:${port}`)
      await deviceClient.getProperties()

      console.log(`[ADB Service] Successfully connected to TCP device ${ipAddress}:${port}`)
      return true
    } catch (error) {
      console.error(`Error connecting to TCP device ${ipAddress}:${port}:`, error)
      return false
    }
  }

  async disconnectTcpDevice(ipAddress: string, port: number = 5555): Promise<boolean> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      console.log(`[ADB Service] Attempting to disconnect from TCP device ${ipAddress}:${port}...`)

      // Use adb disconnect command
      await this.client.disconnect(ipAddress, port)

      console.log(`[ADB Service] Successfully disconnected from TCP device ${ipAddress}:${port}`)
      return true
    } catch (error) {
      console.error(`Error disconnecting from TCP device ${ipAddress}:${port}:`, error)
      return false
    }
  }

  async getDeviceIp(serial: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      const deviceClient = this.client.getDevice(serial)
      const ipOutput = await deviceClient.shell('ip route')
      const ipResult = (await Adb.util.readAll(ipOutput)).toString().trim()

      // Parse IP from "192.168.178.0/24 dev wlan0 proto kernel scope link src 192.168.178.106"
      const ipMatch = ipResult.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)
      if (ipMatch && ipMatch[1]) {
        console.log(`[ADB Service] Found IP address for ${serial}: ${ipMatch[1]}`)
        return ipMatch[1]
      }

      console.log(`[ADB Service] No IP address found for ${serial}`)
      return null
    } catch (error) {
      console.error(`Error getting IP address for device ${serial}:`, error)
      return null
    }
  }

  async getInstalledPackages(serial: string): Promise<PackageInfo[]> {
    if (!this.client) {
      throw new Error('adb service not initialized!')
    }
    try {
      const deviceClient = this.client.getDevice(serial)

      // Execute the shell command to list third-party packages with version codes
      const output = await deviceClient.shell('pm list packages --show-versioncode -3')
      const result = await Adb.util.readAll(output)

      // Convert the buffer to string and parse the packages
      const packages = result.toString().trim().split('\n')

      // Extract package names and version codes (format is "package:com.example.package versionCode:123")
      const packageInfoList = packages
        .filter((line) => line.startsWith('package:'))
        .map((line) => {
          const packageMatch = line.match(/package:([^\s]+)/)
          const versionMatch = line.match(/versionCode:(\d+)/)

          const packageName = packageMatch ? packageMatch[1].trim() : ''
          const versionCode = versionMatch ? parseInt(versionMatch[1], 10) : 0

          return { packageName, versionCode }
        })

      return packageInfoList
    } catch (error) {
      console.error(`Error getting installed packages for device ${serial}:`, error)
      return []
    }
  }

  async getUserName(serial: string): Promise<string> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    const userName = (await this.runShellCommand(serial, 'settings get global username')) ?? ''
    console.log('[ADB Service] User name:', userName)
    const trimmedUserName = userName.trim()
    if (trimmedUserName === '' || trimmedUserName === 'null') {
      return '[Unset]'
    }
    return trimmedUserName
  }

  async setUserName(serial: string, name: string): Promise<void> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    const deviceClient = this.client.getDevice(serial)
    console.log('[ADB Service] Setting user name:', name)
    await deviceClient.shell(`settings put global username "${name.trim()}"`)
  }

  async installPackage(
    serial: string,
    apkPath: string,
    options?: { flags?: string[] }
  ): Promise<boolean> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    console.log(
      `[ADB Service] Attempting to install ${apkPath} on ${serial}${options?.flags ? ` with flags: ${options.flags.join(' ')}` : ''}...`
    )
    this.lastInstallError = null
    const deviceClient = this.client.getDevice(serial)

    if (options?.flags && options.flags.length > 0) {
      const apkFileName = path.basename(apkPath)
      const remoteTempApkPath = `/data/local/tmp/${apkFileName}`

      try {
        // 1. Push APK to temporary location
        console.log(`[ADB Service] Pushing ${apkPath} to ${remoteTempApkPath}...`)
        const pushTransfer = await deviceClient.push(apkPath, remoteTempApkPath)
        await new Promise<void>((resolve, reject) => {
          pushTransfer.on('end', resolve)
          pushTransfer.on('error', (err: Error) => {
            console.error(
              `[ADB Service] Error pushing APK ${apkPath} to ${remoteTempApkPath}:`,
              err
            )
            reject(err)
          })
        })
        console.log(`[ADB Service] Successfully pushed ${apkPath} to ${remoteTempApkPath}.`)

        // 2. Construct and execute pm install command
        const installCommand = `pm install ${options.flags.join(' ')} "${remoteTempApkPath}"`
        console.log(`[ADB Service] Running install command: ${installCommand}`)
        let output = await this.runShellCommand(serial, installCommand) // runShellCommand already logs

        // Check for INSTALL_FAILED_UPDATE_INCOMPATIBLE and attempt uninstall then retry
        if (output?.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
          console.warn(
            `[ADB Service] Install failed due to incompatible update. Attempting uninstall and retry. Original error: ${output}`
          )
          const packageNameMatch = output.match(/Package ([a-zA-Z0-9_.]+)/)
          if (packageNameMatch && packageNameMatch[1]) {
            const packageName = packageNameMatch[1]
            console.log(`[ADB Service] Extracted package name for uninstall: ${packageName}`)
            const uninstallSuccess = await this.uninstallPackage(serial, packageName)
            if (uninstallSuccess) {
              console.log(
                `[ADB Service] Successfully uninstalled ${packageName}. Retrying installation...`
              )
              output = await this.runShellCommand(serial, installCommand) // Retry install
            } else {
              console.error(
                `[ADB Service] Failed to uninstall ${packageName}. Installation will likely still fail.`
              )
            }
          } else {
            console.warn(
              '[ADB Service] Could not extract package name from incompatibility error. Cannot attempt uninstall.'
            )
          }
        }

        // 3. Clean up temporary APK
        console.log(`[ADB Service] Cleaning up temporary APK: ${remoteTempApkPath}`)
        const cleanupOutput = await this.runShellCommand(serial, `rm -f "${remoteTempApkPath}"`)
        if (cleanupOutput === null || !cleanupOutput.includes('No such file or directory')) {
          // Consider logging if rm -f didn't behave as expected (e.g. permission errors other than file not found)
          if (cleanupOutput !== null && cleanupOutput.trim() !== '') {
            console.warn(
              `[ADB Service] Output during cleanup of ${remoteTempApkPath}: ${cleanupOutput}`
            )
          } else if (cleanupOutput === null) {
            console.warn(
              `[ADB Service] Failed to execute cleanup command for ${remoteTempApkPath} or no output.`
            )
          }
        }

        if (output?.includes('Success')) {
          this.lastInstallError = null
          console.log(
            `[ADB Service] Successfully installed ${apkPath} with flags. Output: ${output}`
          )
          return true
        } else {
          this.lastInstallError = (output && output.trim()) || 'Installation failed'
          console.error(
            `[ADB Service] Installation of ${apkPath} with flags failed or success not confirmed. Output: ${output || 'No output'}`
          )
          // Attempt to extract common failure reasons
          if (output?.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
            console.error(
              '[ADB Service] Detailed error: INSTALL_FAILED_UPDATE_INCOMPATIBLE. Signatures might still mismatch or other issue.'
            )
          } else if (output?.includes('INSTALL_FAILED_VERSION_DOWNGRADE')) {
            console.error(
              '[ADB Service] Detailed error: INSTALL_FAILED_VERSION_DOWNGRADE. Cannot downgrade versions with these flags.'
            )
          } else if (output?.includes('INSTALL_FAILED_ALREADY_EXISTS')) {
            console.error(
              '[ADB Service] Detailed error: INSTALL_FAILED_ALREADY_EXISTS. Package already exists.'
            )
          }
          return false
        }
      } catch (error) {
        this.lastInstallError = error instanceof Error ? error.message : String(error)
        console.error(
          `[ADB Service] Error during flagged installation of ${apkPath} on device ${serial}:`,
          error
        )
        // Ensure cleanup is attempted even if earlier steps fail
        try {
          console.log(`[ADB Service] Attempting cleanup of ${remoteTempApkPath} after error...`)
          await this.runShellCommand(serial, `rm -f "${remoteTempApkPath}"`)
        } catch (cleanupError) {
          console.error(
            `[ADB Service] Error during cleanup of ${remoteTempApkPath} after initial error:`,
            cleanupError
          )
        }
        return false
      }
    } else {
      try {
        const success = await deviceClient.install(apkPath)
        if (success) {
          this.lastInstallError = null
          console.log(`[ADB Service] Successfully installed ${apkPath} using adbkit.install.`)
        } else {
          this.lastInstallError = 'Installation reported failure'
          console.error(
            `[ADB Service] Installation of ${apkPath} reported failure by adbkit.install.`
          )
        }
        return success
      } catch (error) {
        this.lastInstallError = error instanceof Error ? error.message : String(error)
        console.error(
          `[ADB Service] Error installing package ${apkPath} on device ${serial} (adbkit.install):`,
          error
        )
        if (error instanceof Error && error.message.includes('INSTALL_FAILED')) {
          console.error(`[ADB Service] Install failed with code: ${error.message}`)
        }
        return false
      }
    }
  }

  async runShellCommand(serial: string, command: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    console.log(`[ADB Service] Running command on ${serial}: ${command}`)
    try {
      const deviceClient = this.client.getDevice(serial)
      const stream = await deviceClient.shell(command)
      const outputBuffer = await Adb.util.readAll(stream)
      const output = outputBuffer.toString().trim()
      console.log(`[ADB Service] Command output: ${output}`)
      return output
    } catch (error) {
      console.error(
        `[ADB Service] Error running shell command "${command}" on device ${serial}:`,
        error
      )
      return null
    }
  }

  private async _pushDirectoryRecursive(
    serial: string,
    localDirPath: string,
    remoteDirPath: string,
    deviceClient: DeviceClient
  ): Promise<boolean> {
    // 1. Create the remote directory
    try {
      console.log(`[AdbService Recursive] Ensuring remote directory exists: ${remoteDirPath}`)
      const mkdirOutput = await this.runShellCommand(serial, `mkdir -p "${remoteDirPath}"`)
      if (mkdirOutput === null) {
        console.error(
          `[AdbService Recursive] Failed to create remote directory ${remoteDirPath} (runShellCommand indicated failure).`
        )
        return false
      }
    } catch (error) {
      console.error(
        `[AdbService Recursive] Exception while creating remote directory ${remoteDirPath}:`,
        error
      )
      return false
    }

    // 2. Read entries in localDirPath
    let entries: Dirent[]
    try {
      entries = await fs.promises.readdir(localDirPath, { withFileTypes: true })
    } catch (readDirError) {
      console.error(
        `[AdbService Recursive] Failed to read local directory ${localDirPath}:`,
        readDirError
      )
      return false
    }

    // 3. For each entry
    for (const entry of entries) {
      const localEntryPath = path.join(localDirPath, entry.name)
      const remoteEntryPath = path.posix.join(remoteDirPath, entry.name)

      if (entry.isFile()) {
        console.log(
          `[AdbService Recursive] Pushing file ${localEntryPath} to ${serial}:${remoteEntryPath}`
        )
        try {
          const transfer = await deviceClient.push(localEntryPath, remoteEntryPath)
          const filePushSuccess = await new Promise<boolean>((resolve) => {
            transfer.on('end', () => resolve(true))
            transfer.on('error', (err: Error) => {
              console.error(
                `[AdbService Recursive] Error pushing file ${localEntryPath} to ${remoteEntryPath}:`,
                err
              )
              resolve(false)
            })
          })

          if (!filePushSuccess) {
            console.error(
              `[AdbService Recursive] Failed to push file ${localEntryPath}. Aborting directory push.`
            )
            return false
          }
        } catch (filePushError) {
          console.error(
            `[AdbService Recursive] Exception during push of file ${localEntryPath}:`,
            filePushError
          )
          return false
        }
      } else if (entry.isDirectory()) {
        console.log(
          `[AdbService Recursive] Pushing directory ${localEntryPath} to ${serial}:${remoteEntryPath}`
        )
        const subdirPushSuccess = await this._pushDirectoryRecursive(
          serial,
          localEntryPath,
          remoteEntryPath,
          deviceClient
        )
        if (!subdirPushSuccess) {
          console.error(
            `[AdbService Recursive] Failed to push subdirectory ${localEntryPath}. Aborting directory push.`
          )
          return false
        }
      }
    }
    return true
  }

  async pushFileOrFolder(serial: string, localPath: string, remotePath: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }

    // let finalRemotePath = remotePath // Will be determined in the try block
    // Initialize with normalized remotePath to ensure it's always defined for logging in catch block
    let finalRemotePath: string = remotePath.replace(/\\/g, '/')

    try {
      const localStat = await fs.promises.stat(localPath)
      const normalizedOriginalRemotePath = remotePath.replace(/\\/g, '/') // Already done for finalRemotePath init, but keep for clarity if preferred

      // Determine the final remote path based on whether it's a file or directory
      // and if the remote path needs basename appending.
      if (localStat.isFile()) {
        if (normalizedOriginalRemotePath.endsWith('/')) {
          finalRemotePath = path.posix.join(normalizedOriginalRemotePath, path.basename(localPath))
        } else {
          // If remotePath does not end with '/',
          // remotePath is assumed to be the full target file path.
          finalRemotePath = normalizedOriginalRemotePath
        }
      } else if (localStat.isDirectory()) {
        if (normalizedOriginalRemotePath.endsWith('/')) {
          // e.g., localPath="dir", remotePath="/sdcard/" => finalRemotePath="/sdcard/dir"
          finalRemotePath = path.posix.join(normalizedOriginalRemotePath, path.basename(localPath))
        } else {
          // If remotePath does not end with a slash (e.g., "/sdcard/targetdir"),
          // it's assumed to be the explicit full path for the target directory.
          finalRemotePath = normalizedOriginalRemotePath
        }
      } else {
        // This case should ideally not be reached if localStat succeeds
        console.error(
          `[AdbService] Local path ${localPath} is neither a file nor a directory after stat.`
        )
        return false
      }

      const deviceClient = this.client.getDevice(serial)

      if (localStat.isDirectory()) {
        console.log(
          `[AdbService] Pushing directory ${localPath} to ${serial}:${finalRemotePath} using recursive method.`
        )
        return await this._pushDirectoryRecursive(serial, localPath, finalRemotePath, deviceClient)
      } else {
        // It's a file
        console.log(
          `[ADB Service] Pushing file ${localPath} to ${serial}:${finalRemotePath}... (original remote: ${remotePath.replace(/\\/g, '/') /* Log normalized path here too for clarity */})`
        )
        const transfer = await deviceClient.push(localPath, finalRemotePath)
        return new Promise<boolean>((resolve, reject) => {
          transfer.on('end', () => {
            console.log(
              `[ADB Service] Successfully pushed file ${localPath} to ${finalRemotePath}.`
            )
            resolve(true)
          })
          transfer.on('error', (err) => {
            console.error(
              `[ADB Service] Error pushing file ${localPath} to ${finalRemotePath}:`,
              err
            )
            reject(err) // This will be caught by the outer catch block
          })
        })
      }
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        console.error(
          `[AdbService] Local file/folder not found for push: ${localPath}. Code: ${(error as { code: string }).code}`
        )
      } else {
        console.error(
          `[AdbService] Error during push operation for ${localPath} to ${serial}:${finalRemotePath} (original remote: ${remotePath.replace(/\\/g, '/') /* Log normalized path here too for clarity */}):`,
          error
        )
      }
      return false
    }
  }

  async pullFile(serial: string, remotePath: string, localPath: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    console.log(`Pulling ${serial}:${remotePath} to ${localPath}...`)
    try {
      const deviceClient = this.client.getDevice(serial)
      const transfer = await deviceClient.pull(remotePath)
      const stream = fs.createWriteStream(localPath)
      await new Promise((resolve, reject) => {
        transfer.pipe(stream)
        transfer.on('end', resolve)
        transfer.on('error', reject)
      })
      console.log(`[ADB Service] Successfully pulled ${remotePath} to ${localPath}.`)
      return false // Return false until fully implemented
    } catch (error) {
      console.error(`[ADB Service] Error pulling ${remotePath} from ${serial}:`, error)
      return false
    }
  }

  async uninstallPackage(serial: string, packageName: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    console.log(`[ADB Service] Attempting to uninstall ${packageName} from ${serial}...`)
    try {
      const deviceClient = this.client.getDevice(serial)

      // 1. Uninstall the package
      console.log(`[ADB Service] Running: pm uninstall ${packageName}`)
      await deviceClient.uninstall(packageName)
      console.log(`[ADB Service] Successfully uninstalled ${packageName}.`)

      // 2. Remove OBB directory (ignore errors)
      const obbPath = `/sdcard/Android/obb/${packageName}`
      console.log(`[ADB Service] Running: rm -r ${obbPath} || true`)
      try {
        await deviceClient.shell(`rm -r ${obbPath}`)
        console.log(`[ADB Service] Successfully removed ${obbPath} (if it existed).`)
      } catch (obbError) {
        // Check if error is because the directory doesn't exist (common case)
        if (obbError instanceof Error && obbError.message.includes('No such file or directory')) {
          console.log(`[ADB Service] OBB directory ${obbPath} did not exist.`)
        } else {
          // Log other potential errors but continue
          console.warn(`[ADB Service] Could not remove OBB directory ${obbPath}:`, obbError)
        }
      }

      // 3. Remove Data directory (ignore errors)
      const dataPath = `/sdcard/Android/data/${packageName}`
      console.log(`[ADB Service] Running: rm -r ${dataPath} || true`)
      try {
        await deviceClient.shell(`rm -r ${dataPath}`)
        console.log(`[ADB Service] Successfully removed ${dataPath} (if it existed).`)
      } catch (dataError) {
        if (dataError instanceof Error && dataError.message.includes('No such file or directory')) {
          console.log(`[ADB Service] Data directory ${dataPath} did not exist.`)
        } else {
          console.warn(`[ADB Service] Could not remove Data directory ${dataPath}:`, dataError)
        }
      }

      console.log(`[ADB Service] Uninstall process completed for ${packageName}.`)

      return true
    } catch (error) {
      console.error(
        `[ADB Service] Error uninstalling package ${packageName} on device ${serial}:`,
        error
      )
      // Rethrow or return false based on how you want to handle errors upstream
      return false
    }
  }

  public async getApplicationLabel(serial: string, packageName: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('[ADB Service] adb service not initialized!')
    }
    const aaptRemotePath = '/data/local/tmp/aapt'

    try {
      if (!this.aaptPushed) {
        // 1. Push the aapt binary to the device (assuming it's bundled with the app)
        const aaptLocalPath = dependencyService.getAaptPath()

        console.log(`[AdbService] Pushing aapt binary to ${serial}:${aaptRemotePath}...`)
        const pushSuccess = await this.pushFileOrFolder(serial, aaptLocalPath, aaptRemotePath)

        if (!pushSuccess) {
          console.error('[AdbService] Failed to push aapt binary to device')
          return null
        }

        // 2. Make the binary executable
        console.log(`[AdbService] Making aapt executable...`)
        await this.runShellCommand(serial, `chmod 755 ${aaptRemotePath}`)
        this.aaptPushed = true
      } else {
        console.log('[AdbService] aapt binary already pushed to device')
      }

      // 3. Get the path to the APK file
      console.log(`[AdbService] Getting APK path for ${packageName}...`)
      const pathOutput = await this.runShellCommand(serial, `pm path ${packageName}`)

      if (!pathOutput || !pathOutput.startsWith('package:')) {
        console.error(`[AdbService] Could not find package path for ${packageName}`)
        return null
      }

      const apkPath = pathOutput.trim().substring(8) // Remove 'package:' prefix

      // 4. Use aapt to extract the application label
      console.log(`[AdbService] Extracting application label for ${apkPath}...`)
      const labelOutput = await this.runShellCommand(
        serial,
        `${aaptRemotePath} dump badging "${apkPath}" | grep "application-label:"`
      )

      if (!labelOutput) {
        console.error(`[AdbService] Could not extract application label for ${packageName}`)
        return null
      }

      // Parse the output: application-label:'AppName'
      const labelMatch = labelOutput.match(/application-label:'([^']*)'/)
      if (labelMatch && labelMatch[1]) {
        console.log(`[AdbService] Found application label for ${packageName}: ${labelMatch[1]}`)
        return labelMatch[1]
      }

      console.error(`[AdbService] Could not parse application label from: ${labelOutput}`)
      return null
    } catch (error) {
      console.error(`[AdbService] Error getting application label for ${packageName}:`, error)
      return null
    }
  }

  public async pingDevice(
    ipAddress: string
  ): Promise<{ reachable: boolean; responseTime?: number }> {
    console.log(`[ADB Service] Pinging ${ipAddress}...`)

    try {
      const response = await ping(ipAddress, {
        timeout: 3, // 3 second timeout
        numberOfEchos: 1 // Single ping
      })

      if (response.alive) {
        const responseTime = response.time // time in ms for first successful ping
        console.log(
          `[ADB Service] Ping to ${ipAddress} successful (${responseTime || 'unknown'}ms)`
        )
        return {
          reachable: true,
          responseTime: responseTime ? Math.round(responseTime) : undefined
        }
      } else {
        console.log(`[ADB Service] Ping to ${ipAddress} failed - host not alive`)
        return { reachable: false }
      }
    } catch (error) {
      console.error(`[ADB Service] Error pinging ${ipAddress}:`, error)
      return { reachable: false }
    }
  }
}

export default new AdbService()
