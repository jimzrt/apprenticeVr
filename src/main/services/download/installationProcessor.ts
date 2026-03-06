import { basename, join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { DownloadItem, DownloadStatus } from '@shared/types'
import { QueueManager } from './queueManager'
import adbService from '../adbService'

export class InstallationProcessor {
  private queueManager: QueueManager
  private adbService: typeof adbService
  private debouncedEmitUpdate: () => void

  constructor(
    queueManager: QueueManager,
    adbSvc: typeof adbService,
    debouncedEmitUpdate: () => void
  ) {
    this.queueManager = queueManager
    this.adbService = adbSvc
    this.debouncedEmitUpdate = debouncedEmitUpdate
  }

  private updateItemStatus(
    releaseName: string,
    status: DownloadStatus,
    progress?: number,
    error?: string,
    extractProgress?: number
  ): void {
    const updates: Partial<DownloadItem> = { status }
    if (error) updates.error = error
    if (progress !== undefined) updates.progress = progress
    if (extractProgress !== undefined) updates.extractProgress = extractProgress
    updates.speed = undefined
    updates.eta = undefined
    if (status !== 'Installing') updates.pid = undefined
    const updated = this.queueManager.updateItem(releaseName, updates)
    if (updated) {
      this.debouncedEmitUpdate()
    }
  }

  public async startInstallation(item: DownloadItem, deviceId: string): Promise<boolean> {
    console.log(
      `[InstallProc] Starting installation process for ${item.releaseName} on device ${deviceId}`
    )
    if (!item.downloadPath || !existsSync(item.downloadPath)) {
      console.error(
        `[InstallProc] Download path invalid for ${item.releaseName}: ${item.downloadPath}`
      )
      this.updateItemStatus(
        item.releaseName,
        'InstallError',
        100,
        'Download path missing or invalid',
        100
      )
      return false
    }
    this.updateItemStatus(item.releaseName, 'Installing', 100, undefined, 100)
    const installScriptPathTxt = join(item.downloadPath, 'install.txt')
    const installScriptPathTxtUpper = join(item.downloadPath, 'Install.txt')
    let installScriptPath: string | null = null
    if (existsSync(installScriptPathTxt)) {
      installScriptPath = installScriptPathTxt
    } else if (existsSync(installScriptPathTxtUpper)) {
      installScriptPath = installScriptPathTxtUpper
    }
    let success = false
    try {
      if (installScriptPath) {
        console.log(`[InstallProc] Found install script: ${installScriptPath}`)
        success = await this.executeInstallScript(item, deviceId, installScriptPath)
      } else {
        console.log(
          `[InstallProc] No install script found for ${item.releaseName}. Proceeding with standard install.`
        )
        success = await this.executeStandardInstall(item, deviceId)
      }
      if (success) {
        console.log(`[InstallProc] Installation completed successfully for ${item.releaseName}.`)
        this.updateItemStatus(item.releaseName, 'Completed', 100, undefined, 100)
        // TODO: Trigger game list refresh?
      } else {
        console.error(`[InstallProc] Installation failed for ${item.releaseName}.`)
        // Status already set to InstallError by specific failure points if critical
        // If not critical, ensure it's marked as error here
        const currentItem = this.queueManager.findItem(item.releaseName)
        if (currentItem?.status !== 'InstallError') {
          this.updateItemStatus(
            item.releaseName,
            'InstallError',
            100,
            'Installation failed (see logs)',
            100
          )
        }
      }
      return success
    } catch (error: unknown) {
      console.error(
        `[InstallProc Catch] Unexpected error during installation for ${item.releaseName}:`,
        error
      )
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.updateItemStatus(
        item.releaseName,
        'InstallError',
        100,
        `Unexpected install error: ${errorMsg.substring(0, 300)}`,
        100
      )
      return false
    }
  }

  private async executeInstallScript(
    item: DownloadItem,
    deviceId: string,
    scriptPath: string
  ): Promise<boolean> {
    let overallSuccess = true
    try {
      const scriptContent = await fs.readFile(scriptPath, 'utf-8')
      const commands = scriptContent
        .split(/\r?\n/)
        .map((cmd) => cmd.trim())
        .filter((cmd) => cmd.length > 0 && !cmd.startsWith('#'))
      console.log(`[InstallProc] Executing ${commands.length} commands from script...`)
      for (const command of commands) {
        console.log(`[InstallProc] Running: ${command}`)
        const parts =
          command
            .match(/(?:[^\s"]+"([^"]*)")|[^\s"]+/g)
            ?.map((part) => part.replace(/^"|"$/g, '')) || []
        if (parts.length === 0 || parts[0].toLowerCase() !== 'adb') {
          console.warn(`[InstallProc] Skipping invalid/non-adb command: ${command}`)
          continue
        }
        const adbCommand = parts[1]?.toLowerCase()
        const args = parts.slice(2)
        let commandSuccess = false
        let errorMessage = ''
        try {
          switch (adbCommand) {
            case 'shell':
              if (args.length > 0) {
                const shellCmd = args.join(' ')
                console.log(`[InstallProc]   Executing shell: ${shellCmd}`)
                await this.adbService.runShellCommand(deviceId, shellCmd)
                commandSuccess = true
              } else {
                errorMessage = 'Missing shell command argument'
              }
              break
            case 'install': {
              const apkArg = args.find((arg) => arg.toLowerCase().endsWith('.apk'))
              if (apkArg) {
                const apkPath = join(item.downloadPath!, apkArg)
                if (existsSync(apkPath)) {
                  const installArgs = args.filter((arg) => arg !== apkArg)
                  console.log(
                    `[InstallProc]   Installing ${apkPath} with flags: ${installArgs.join(' ')}`
                  )
                  // Use the simplified installPackage which handles push+install
                  // We will now pass the installArgs to allow for flags like -r, -g
                  // Ensure -r and -g are included for compatibility and permissions.
                  const combinedFlags = Array.from(new Set(['-r', '-g', ...installArgs]))

                  const installSucceeded = await this.adbService.installPackage(deviceId, apkPath, {
                    flags: combinedFlags
                  })
                  if (installSucceeded) {
                    commandSuccess = true
                  } else {
                    const installError = this.adbService.getLastInstallError()
                    errorMessage = installError
                      ? `Install command failed for ${apkArg}: ${installError}`
                      : `Install command failed for ${apkArg}`
                  }
                  // if (output?.includes('Success')) {
                  //   commandSuccess = true
                  // } else {
                  //   errorMessage = `Install command failed. Output: ${output || 'No output'}`
                  // }
                } else {
                  errorMessage = `APK file not found: ${apkPath}`
                }
              } else {
                errorMessage = 'Missing APK file argument for install command'
              }
              // Install failure is critical
              if (!commandSuccess) overallSuccess = false
              break
            }
            case 'push': {
              if (args.length === 2) {
                const localPathRelative = args[0]
                const devicePath = args[1]
                const localPathAbsolute = join(item.downloadPath!, localPathRelative)
                if (existsSync(localPathAbsolute)) {
                  console.log(`[InstallProc]   Pushing ${localPathAbsolute} to ${devicePath}`)
                  await this.adbService.pushFileOrFolder(deviceId, localPathAbsolute, devicePath)
                  commandSuccess = true
                } else {
                  errorMessage = `Local file/folder not found for push: ${localPathAbsolute}`
                }
              } else {
                errorMessage = 'Invalid arguments for push command (expected 2)'
              }
              break
            }
            case 'pull': {
              if (args.length === 1) {
                const devicePath = args[0]
                const localTargetPath = join(item.downloadPath!, basename(devicePath))
                console.log(`[InstallProc]   Pulling ${devicePath} to ${localTargetPath}`)
                await this.adbService.pullFile(deviceId, devicePath, localTargetPath)
                commandSuccess = true
              } else {
                errorMessage = 'Invalid arguments for pull command (expected 1)'
              }
              break
            }
            default: {
              console.warn(`[InstallProc] Skipping unsupported adb command: ${adbCommand}`)
              commandSuccess = true
              break
            }
          }
        } catch (execError: unknown) {
          errorMessage = execError instanceof Error ? execError.message : String(execError)
          console.error(`[InstallProc] Error executing '${command}': ${errorMessage}`)
          if (adbCommand === 'install') overallSuccess = false
        }
        if (!commandSuccess) {
          console.error(`[InstallProc] Command failed: '${command}'. Reason: ${errorMessage}`)
          if (adbCommand === 'install') overallSuccess = false
        }
        if (!overallSuccess) {
          console.error(`[InstallProc] Critical command failed. Aborting script execution.`)
          this.updateItemStatus(
            item.releaseName,
            'InstallError',
            100,
            `Script execution failed on command: ${command}. Reason: ${errorMessage.substring(0, 200)}`,
            100
          )
          return false
        }
      }
      console.log(`[InstallProc] Finished executing script.`)
      return overallSuccess
    } catch (error: unknown) {
      console.error(
        `[InstallProc] Error reading or processing install script ${scriptPath}:`,
        error
      )
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.updateItemStatus(
        item.releaseName,
        'InstallError',
        100,
        `Failed to process install script: ${errorMsg.substring(0, 250)}`,
        100
      )
      return false
    }
  }

  private async executeStandardInstall(item: DownloadItem, deviceId: string): Promise<boolean> {
    if (!item.downloadPath || !item.packageName) {
      console.error(
        `[InstallProc Standard] Missing downloadPath or packageName for ${item.releaseName}`
      )
      this.updateItemStatus(
        item.releaseName,
        'InstallError',
        100,
        'Missing required info for standard install',
        100
      )
      return false
    }
    try {
      const files = await fs.readdir(item.downloadPath)
      const apks = files.filter((f) => f.toLowerCase().endsWith('.apk'))
      const obbDirName = item.packageName
      const potentialObbPath = join(item.downloadPath, obbDirName)
      let obbPath: string | null = null
      if (existsSync(potentialObbPath)) {
        const stats = await fs.stat(potentialObbPath)
        if (stats.isDirectory()) {
          obbPath = potentialObbPath
          console.log(`[InstallProc Standard] Found potential OBB directory: ${obbPath}`)
        } else {
          console.warn(
            `[InstallProc Standard] Found item matching package name, but it's not a directory: ${potentialObbPath}`
          )
        }
      }
      if (apks.length === 0) {
        console.error(`[InstallProc Standard] No APK files found in ${item.downloadPath}`)
        this.updateItemStatus(
          item.releaseName,
          'InstallError',
          100,
          'No APK files found for standard install',
          100
        )
        return false
      }
      console.log(`[InstallProc Standard] Found ${apks.length} APK(s): ${apks.join(', ')}`)
      this.updateItemStatus(item.releaseName, 'Installing', 0)
      for (const apk of apks) {
        const apkPath = join(item.downloadPath, apk)
        console.log(`[InstallProc Standard] Installing ${apkPath}...`)
        try {
          // Use the simplified installPackage, now with flags for reinstall and granting permissions
          const installSucceeded = await this.adbService.installPackage(deviceId, apkPath, {
            flags: ['-r', '-g']
          })
          if (!installSucceeded) {
            const installError = this.adbService.getLastInstallError()
            console.error(`[InstallProc Standard] Failed to install ${apk} (adb returned false)`)
            this.updateItemStatus(
              item.releaseName,
              'InstallError',
              100,
              installError
                ? `Failed to install ${apk}: ${installError}`
                : `Failed to install ${apk}: device rejected install`,
              100
            )
            return false
          }
          console.log(`[InstallProc Standard] Successfully installed ${apk}`)
        } catch (installError: unknown) {
          const errorMsg =
            installError instanceof Error ? installError.message : String(installError)
          console.error(`[InstallProc Standard] Failed to install ${apk}: ${errorMsg}`)
          this.updateItemStatus(
            item.releaseName,
            'InstallError',
            100,
            `Failed to install ${apk}: ${errorMsg.substring(0, 250)}`,
            100
          )
          return false
        }
      }
      this.updateItemStatus(item.releaseName, 'Installing', obbPath ? 50 : 100)
      if (obbPath) {
        const deviceObbBasePath = '/sdcard/Android/obb'
        const deviceObbTargetPath = `${deviceObbBasePath}/${obbDirName}`
        console.log(
          `[InstallProc Standard] Pushing OBB folder ${obbPath} to ${deviceObbTargetPath}...`
        )
        try {
          try {
            await this.adbService.runShellCommand(deviceId, `mkdir -p ${deviceObbBasePath}`)
          } catch (mkdirError) {
            console.warn(
              `[InstallProc Standard] Could not ensure base OBB directory exists (may already exist):`,
              mkdirError
            )
          }

          // Calculate total size of OBB files and track progress
          const filesInfo = await this.getDirectoryFilesInfo(obbPath)
          if (filesInfo.length === 0) {
            console.log(`[InstallProc Standard] No files found in OBB directory ${obbPath}`)
          } else {
            const totalSize = filesInfo.reduce((sum, entry) => sum + entry.size, 0)
            console.log(
              `[InstallProc Standard] Found ${filesInfo.length} files in OBB folder, total size: ${totalSize} bytes`
            )

            // Create remote OBB directory
            await this.adbService.runShellCommand(deviceId, `mkdir -p "${deviceObbTargetPath}"`)

            let transferredSize = 0
            // Push each file individually to track progress
            for (let i = 0; i < filesInfo.length; i++) {
              const { path: filePath, size } = filesInfo[i]
              const relativePath = filePath.substring(obbPath.length + 1) // +1 for the slash
              const remoteFilePath = `${deviceObbTargetPath}/${relativePath}`

              // Create parent directory if needed
              const remoteDir = remoteFilePath.substring(0, remoteFilePath.lastIndexOf('/'))
              await this.adbService.runShellCommand(deviceId, `mkdir -p "${remoteDir}"`)

              console.log(
                `[InstallProc Standard] Pushing file ${i + 1}/${filesInfo.length}: ${filePath} (${size} bytes)`
              )

              // Push the file
              await this.adbService.pushFileOrFolder(deviceId, filePath, remoteFilePath)

              // Update progress
              transferredSize += size
              const progressPercentage = Math.min(
                Math.floor((transferredSize / totalSize) * 100),
                100
              )
              this.updateItemStatus(item.releaseName, 'Installing', 50 + progressPercentage / 2)
            }
            console.log(`[InstallProc Standard] Successfully pushed all OBB files.`)
          }

          console.log(`[InstallProc Standard] Successfully pushed OBB folder.`)
        } catch (obbError: unknown) {
          const errorMsg = obbError instanceof Error ? obbError.message : String(obbError)
          console.error(`[InstallProc Standard] Failed to push OBB folder: ${errorMsg}`)
          this.updateItemStatus(
            item.releaseName,
            'InstallError',
            100,
            `Failed to push OBB: ${errorMsg.substring(0, 250)}`,
            100
          )
          return false
        }
      }
      console.log(
        `[InstallProc Standard] Standard installation steps completed for ${item.releaseName}.`
      )
      return true
    } catch (error: unknown) {
      console.error(
        `[InstallProc Standard Catch] Error during standard install for ${item.releaseName}:`,
        error
      )
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.updateItemStatus(
        item.releaseName,
        'InstallError',
        100,
        `Standard install error: ${errorMsg.substring(0, 250)}`,
        100
      )
      return false
    }
  }

  /**
   * Get all files in a directory recursively with their sizes
   * @param dirPath Directory path to scan
   * @returns Array of {path, size} objects for each file
   */
  private async getDirectoryFilesInfo(
    dirPath: string
  ): Promise<Array<{ path: string; size: number }>> {
    const result: Array<{ path: string; size: number }> = []

    async function scanDirectory(currentPath: string): Promise<void> {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await scanDirectory(entryPath)
        } else if (entry.isFile()) {
          const stats = await fs.stat(entryPath)
          result.push({
            path: entryPath,
            size: stats.size
          })
        }
      }
    }

    await scanDirectory(dirPath)
    return result
  }
}
