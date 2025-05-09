import { app } from 'electron'
import { join } from 'path'
import { promises as fsPromises, existsSync, createWriteStream, chmodSync, copyFileSync } from 'fs'
import axios, { AxiosProgressEvent } from 'axios'
import { execa } from 'execa'
import * as yauzl from 'yauzl'
import { ServiceStatus } from './service'

type ProgressCallback = (
  status: DependencyStatus,
  progress: { name: string; percentage: number }
) => void

interface DependencyInfo {
  ready: boolean
  path: string | null
  error: string | null
}

interface RcloneDependencyInfo extends DependencyInfo {
  downloading: boolean
}

interface AdbDependencyInfo extends DependencyInfo {
  downloading: boolean
}

export interface DependencyStatus {
  sevenZip: DependencyInfo
  rclone: RcloneDependencyInfo
  adb: AdbDependencyInfo
}

interface GitHubAsset {
  name: string
  browser_download_url: string
}

class DependencyService {
  private binDir: string // Directory within userData for downloaded binaries (like rclone)
  private resourcesBinDir: string // Directory within app resources for bundled binaries (like 7zip)
  private status: DependencyStatus
  private isInitializing: boolean
  private isInitialized: boolean

  constructor() {
    this.binDir = join(app.getPath('userData'), 'bin')
    this.resourcesBinDir = app.isPackaged
      ? join(process.resourcesPath, 'bin')
      : join(app.getAppPath(), 'resources', 'bin')

    this.status = {
      sevenZip: { ready: false, path: null, error: null },
      rclone: { ready: false, path: null, error: null, downloading: false },
      adb: { ready: false, path: null, error: null, downloading: false }
    }
    this.isInitializing = false
    this.isInitialized = false
  }

  async initialize(progressCallback?: ProgressCallback, force?: boolean): Promise<ServiceStatus> {
    if (this.isInitializing) {
      console.log('DependencyService already initializing, skipping.')
      return 'INITIALIZING'
    }
    if (!force && this.isInitialized) {
      console.log('DependencyService already initialized, skipping.')
      return 'INITIALIZED'
    }
    this.isInitializing = true
    console.log('Initializing DependencyService...')
    // Ensure userData bin directory exists for downloads like rclone
    await fsPromises.mkdir(this.binDir, { recursive: true })

    this.checkBundled7zip()

    await this.checkOrDownloadRclone(progressCallback)

    await this.checkOrDownloadAdb(progressCallback)

    console.log('DependencyService initialization finished.')
    this.isInitializing = false
    this.isInitialized = true

    // Check if all dependencies are ready after initialization
    if (!this.status.sevenZip.ready || !this.status.rclone.ready || !this.status.adb.ready) {
      // Throw an error or handle the situation where dependencies aren't ready
      const missing: ('7zip' | 'rclone' | 'adb')[] = []
      if (!this.status.sevenZip.ready) missing.push('7zip')
      if (!this.status.rclone.ready) missing.push('rclone')
      if (!this.status.adb.ready) missing.push('adb')
      // Construct error message based on what failed
      let errorMessage = `Dependency setup failed. Missing or failed: ${missing.join(', ')}. `
      if (this.status.sevenZip.error) errorMessage += `7zip Error: ${this.status.sevenZip.error} `
      if (this.status.rclone.error) errorMessage += `Rclone Error: ${this.status.rclone.error}`
      if (this.status.adb.error) errorMessage += `ADB Error: ${this.status.adb.error}`

      console.error(errorMessage)
      throw new Error(errorMessage) // Propagate error to caller
    }
    return 'INITIALIZED'
  }

  // --- 7zip ---

  // Updated to point to bundled location
  public get7zPath(): string {
    const platform = process.platform
    let platformDir: string
    let binaryName: string

    switch (platform) {
      case 'win32':
        platformDir = 'win'
        binaryName = '7za.exe'
        break
      case 'linux':
        platformDir = 'linux'
        binaryName = '7zzs'
        break
      case 'darwin':
        platformDir = 'mac'
        binaryName = '7zz'
        break
      default:
        console.error(`Unsupported platform for bundled 7zip: ${platform}`)
        throw new Error(`Unsupported platform for bundled 7zip: ${platform}`)
    }

    const fullPath = join(this.resourcesBinDir, app.isPackaged ? '' : platformDir, binaryName)
    console.log(`Calculated 7zip path for ${platform}: ${fullPath}`)
    return fullPath
  }

  // New method to check for bundled 7zip
  private checkBundled7zip(): void {
    const source7zPath = this.get7zPath() // Path in resources
    this.status.sevenZip.error = null // Clear previous errors

    if (!source7zPath) {
      this.status.sevenZip.ready = false
      this.status.sevenZip.error = `Unsupported platform for bundled 7zip: ${process.platform}`
      console.error(this.status.sevenZip.error)
      return
    }

    if (!existsSync(source7zPath)) {
      this.status.sevenZip.ready = false
      this.status.sevenZip.error = `Bundled 7zip NOT found at source path: ${source7zPath}. Check app packaging.`
      console.error(this.status.sevenZip.error)
      return
    }

    console.log(`Found bundled 7zip at source: ${source7zPath}`)

    // Determine the name of the 7zip binary (e.g., '7zzs', '7za.exe')
    const binaryName = source7zPath.split(/[/\\]/).pop() // POSIX and Windows path separators
    if (!binaryName) {
      this.status.sevenZip.ready = false
      this.status.sevenZip.error = `Could not determine binary name from path: ${source7zPath}`
      console.error(this.status.sevenZip.error)
      return
    }

    // Target path in the writable binDir (userData/bin)
    const target7zPath = join(this.binDir, binaryName)
    this.status.sevenZip.path = target7zPath // Update status to point to the new path

    try {
      // Check if the binary needs to be copied
      if (!existsSync(target7zPath)) {
        console.log(`Copying 7zip from ${source7zPath} to ${target7zPath}`)
        copyFileSync(source7zPath, target7zPath)
        console.log(`Successfully copied 7zip to ${target7zPath}`)
      } else {
        console.log(`7zip already exists at target path ${target7zPath}. Skipping copy.`)
      }

      this.status.sevenZip.ready = true // Mark as ready (either copied or already existed)

      // Ensure executable permissions on non-windows for the file at target7zPath
      if (process.platform !== 'win32') {
        try {
          chmodSync(target7zPath, 0o755)
          console.log(`Ensured execute permissions for ${target7zPath}`)
        } catch (chmodError) {
          console.warn(`Failed to ensure execute permissions for ${target7zPath}:`, chmodError)
          this.status.sevenZip.ready = false // Mark as not ready if permissions fail
          this.status.sevenZip.error = `Permission error on copied file: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`
        }
      }
    } catch (error) {
      console.error(`Error during 7zip setup (copying or permissioning):`, error)
      this.status.sevenZip.ready = false
      this.status.sevenZip.error = `Failed to set up 7zip: ${error instanceof Error ? error.message : String(error)}`
      this.status.sevenZip.path = source7zPath // Revert path to source if copy/chmod fails for clarity
    }
  }

  // --- rclone ---

  public getRclonePath(): string {
    const platform = process.platform
    const exeSuffix = platform === 'win32' ? '.exe' : ''
    // rclone is downloaded to userData/bin
    return join(this.binDir, `rclone${exeSuffix}`)
  }

  private async checkOrDownloadRclone(progressCallback?: ProgressCallback): Promise<void> {
    const expectedPath = this.getRclonePath()
    this.status.rclone.path = expectedPath

    if (existsSync(expectedPath)) {
      console.log(`rclone found at ${expectedPath}`)
      this.status.rclone.ready = true
      this.status.rclone.downloading = false
      this.status.rclone.error = null
      return
    }

    console.log(`rclone not found at ${expectedPath}, attempting download.`)
    this.status.rclone.ready = false
    this.status.rclone.downloading = true
    this.status.rclone.error = null
    progressCallback?.(this.status, { name: 'rclone', percentage: 0 })

    let tempArchivePath: string | null = null
    let tempExtractDir: string | null = null

    try {
      const downloadUrl = await this.getRcloneDownloadUrl()
      if (!downloadUrl) {
        throw new Error('Could not find suitable rclone download URL.')
      }

      tempArchivePath = join(app.getPath('temp'), `rclone-download-${Date.now()}.zip`)
      console.log(`Downloading rclone from ${downloadUrl} to ${tempArchivePath}`)

      const response = await axios.get(downloadUrl, {
        responseType: 'stream',
        onDownloadProgress: (progressEvent: AxiosProgressEvent) => {
          if (progressEvent.total) {
            const percentage = Math.round((progressEvent.loaded * 100) / progressEvent.total)
            progressCallback?.(this.status, { name: 'rclone', percentage })
          }
        }
      })

      const writer = createWriteStream(tempArchivePath)
      response.data.pipe(writer)
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
        response.data.on('error', reject)
      })

      console.log(`rclone download complete: ${tempArchivePath}`)
      progressCallback?.(this.status, { name: 'rclone', percentage: 100 })

      // --- Extraction Step ---
      tempExtractDir = join(app.getPath('temp'), `rclone-extract-${Date.now()}`)
      console.log(`Extracting archive: ${tempArchivePath} to ${tempExtractDir}`)
      progressCallback?.(this.status, { name: 'rclone-extract', percentage: 0 })

      // Use the bundled 7zip for extraction if it's ready
      const sevenZipPath = this.status.sevenZip.ready ? this.status.sevenZip.path : null
      if (!sevenZipPath) {
        throw new Error('Bundled 7zip is not available or ready, cannot extract rclone archive.')
      }

      console.log(`Using bundled 7zip at ${sevenZipPath} for extraction.`)
      await execa(sevenZipPath, ['x', tempArchivePath, `-o${tempExtractDir}`, '-y'])
      // await extract(tempArchivePath, { dir: tempExtractDir }) // Old extract-zip method
      console.log(`Archive extracted to ${tempExtractDir}`)

      // Find the binary within the extracted files (usually in a subdirectory)
      const binaryName = process.platform === 'win32' ? 'rclone.exe' : 'rclone'
      let foundBinaryPath: string | null = null

      // Rclone zip extracts into a folder like rclone-vX.Y.Z-os-arch/
      const entries = await fsPromises.readdir(tempExtractDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const potentialPath = join(tempExtractDir, entry.name, binaryName)
          if (existsSync(potentialPath)) {
            foundBinaryPath = potentialPath
            break
          }
        }
        // Check root of extracted dir as well (less common for rclone zip)
        const rootPath = join(tempExtractDir, binaryName)
        if (!foundBinaryPath && existsSync(rootPath)) {
          foundBinaryPath = rootPath
        }
      }

      if (!foundBinaryPath) {
        console.error(`Could not find ${binaryName} within extracted files in ${tempExtractDir}`)
        throw new Error(`Could not locate ${binaryName} after extraction.`)
      }

      console.log(`Found rclone binary at ${foundBinaryPath}. Copying to ${expectedPath}...`)
      await fsPromises.copyFile(foundBinaryPath, expectedPath)
      console.log(`Successfully copied rclone binary to ${expectedPath}`)

      // Clean up temp dirs and archive
      console.log(`Cleaning up temporary files: ${tempExtractDir} and ${tempArchivePath}`)
      await fsPromises.rm(tempExtractDir, { recursive: true, force: true })
      await fsPromises.unlink(tempArchivePath)
      tempArchivePath = null

      this.status.rclone.ready = true
      this.status.rclone.error = null
      progressCallback?.(this.status, { name: 'rclone-extract', percentage: 100 })

      // Set executable permissions
      if (process.platform !== 'win32') {
        try {
          await fsPromises.chmod(expectedPath, 0o755)
          console.log(`Set executable permissions for ${expectedPath}`)
        } catch (chmodError) {
          console.warn(`Failed to set executable permissions for ${expectedPath}:`, chmodError)
          // Consider marking rclone as not ready if chmod fails
          this.status.rclone.ready = false
          this.status.rclone.error = `Permission error: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`
        }
      }
    } catch (error) {
      console.error(
        'Error during rclone download/extraction:',
        error instanceof Error ? error.message : String(error)
      )
      this.status.rclone.ready = false
      this.status.rclone.downloading = false
      this.status.rclone.error = error instanceof Error ? error.message : 'Unknown download error'
      try {
        if (tempArchivePath && existsSync(tempArchivePath)) {
          await fsPromises.unlink(tempArchivePath)
          console.log(`Cleaned up rclone temp archive: ${tempArchivePath}`)
        }
        if (tempExtractDir && existsSync(tempExtractDir)) {
          await fsPromises.rm(tempExtractDir, { recursive: true, force: true })
          console.log(`Cleaned up rclone temp extraction directory: ${tempExtractDir}`)
        }
      } catch (cleanupError) {
        console.error('Failed to cleanup rclone temp files on error:', cleanupError)
      }
    } finally {
      this.status.rclone.downloading = false
    }
  }

  private async getRcloneDownloadUrl(): Promise<string | null> {
    const repo = 'rclone/rclone'
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
    console.log(`Fetching latest rclone release info from ${apiUrl}`)

    try {
      const response = await axios.get(apiUrl, { timeout: 15000 })
      const release = response.data
      const assets: GitHubAsset[] = release?.assets

      if (!assets || !Array.isArray(assets)) {
        console.error('No rclone assets found in the latest release data.')
        return null
      }

      console.log(`Found ${assets.length} rclone assets for release ${release.tag_name}`)

      const platform = process.platform
      const arch = process.arch
      let platformSuffix = ''
      let archSuffix = ''

      // Determine platform suffix
      if (platform === 'win32') platformSuffix = 'windows'
      else if (platform === 'darwin') platformSuffix = 'osx'
      else if (platform === 'linux') platformSuffix = 'linux'
      else return null // Unsupported platform

      // Determine arch suffix
      if (arch === 'x64') archSuffix = 'amd64'
      else if (arch === 'arm64') archSuffix = 'arm64'
      else if (arch === 'ia32')
        archSuffix = '386' // rclone uses 386 for ia32
      // Add arm? rclone might use 'arm'
      else return null // Unsupported arch

      // Rclone uses .zip for all these combos
      const targetFileNamePattern = `-${platformSuffix}-${archSuffix}.zip`
      console.log(`Searching for rclone asset ending with: ${targetFileNamePattern}`)

      const targetAsset = assets.find((a) => a.name.endsWith(targetFileNamePattern))

      if (!targetAsset?.browser_download_url) {
        console.error(`Could not find a suitable rclone asset for pattern ${targetFileNamePattern}`)
        return null
      }

      console.log(`Selected rclone asset: ${targetAsset.name}`)
      return targetAsset.browser_download_url
    } catch (error) {
      console.error(
        `Error fetching rclone release info from GitHub:`,
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  // --- ADB ---

  public getAdbPath(): string {
    const platform = process.platform
    const exeSuffix = platform === 'win32' ? '.exe' : ''
    // adb is downloaded to userData/bin
    return join(this.binDir, `adb${exeSuffix}`)
  }

  private async checkOrDownloadAdb(progressCallback?: ProgressCallback): Promise<void> {
    const expectedPath = this.getAdbPath()
    this.status.adb.path = expectedPath

    if (existsSync(expectedPath)) {
      console.log(`adb found at ${expectedPath}`)
      this.status.adb.ready = true
      this.status.adb.downloading = false
      this.status.adb.error = null
      // Ensure executable permissions on non-windows (even if it exists)
      if (process.platform !== 'win32') {
        try {
          await fsPromises.chmod(expectedPath, 0o755)
        } catch (chmodError) {
          console.warn(
            `Failed to ensure execute permissions for existing adb ${expectedPath}:`,
            chmodError
          )
          this.status.adb.ready = false // Mark as not ready if permissions fail
          this.status.adb.error = `Permission error: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`
        }
      }
      return
    }

    console.log(`adb not found at ${expectedPath}, attempting download.`)
    this.status.adb.ready = false
    this.status.adb.downloading = true
    this.status.adb.error = null
    progressCallback?.(this.status, { name: 'adb', percentage: 0 })

    let tempArchivePath: string | null = null
    // let tempExtractDir: string | null = null // No longer needed with direct yauzl extraction logic

    try {
      const platform = process.platform
      let downloadUrl: string
      if (platform === 'win32') {
        downloadUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
      } else if (platform === 'darwin') {
        downloadUrl = 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip'
      } else if (platform === 'linux') {
        downloadUrl = 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip'
      } else {
        throw new Error(`Unsupported platform for adb download: ${platform}`)
      }

      tempArchivePath = join(app.getPath('temp'), `platform-tools-download-${Date.now()}.zip`)
      console.log(`Downloading adb platform-tools from ${downloadUrl} to ${tempArchivePath}`)

      const response = await axios.get(downloadUrl, {
        responseType: 'stream',
        timeout: 30000, // Increased timeout for potentially larger download
        onDownloadProgress: (progressEvent: AxiosProgressEvent) => {
          if (progressEvent.total) {
            const percentage = Math.round((progressEvent.loaded * 100) / progressEvent.total)
            progressCallback?.(this.status, { name: 'adb', percentage })
          }
        }
      })

      const writer = createWriteStream(tempArchivePath)
      response.data.pipe(writer)
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
        response.data.on('error', reject) // Propagate errors from the download stream
      })

      console.log(`adb platform-tools download complete: ${tempArchivePath}`)
      progressCallback?.(this.status, { name: 'adb', percentage: 100 })

      // --- Extraction Step using yauzl ---
      console.log(`Extracting adb from archive: ${tempArchivePath} directly to ${this.binDir}`)
      progressCallback?.(this.status, { name: 'adb-extract', percentage: 0 }) // Indicate start of extraction

      const isWindows = platform === 'win32'
      const adbBinaryName = isWindows ? 'adb.exe' : 'adb'
      const requiredFilesBaseNames = isWindows
        ? [adbBinaryName, 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'libwinpthread-1.dll']
        : [adbBinaryName]

      // Use a Set to track which required files have been successfully extracted
      const extractedFiles = new Set<string>()

      await new Promise<void>((resolve, reject) => {
        yauzl.open(tempArchivePath!, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) return reject(err || new Error('Failed to open zip file'))

          zipfile.readEntry() // Start reading entries

          zipfile.on('entry', (entry: yauzl.Entry) => {
            const baseFileName = entry.fileName.split('/').pop() ?? ''
            const isRequiredFile =
              !entry.fileName.endsWith('/') && // Not a directory
              entry.fileName.startsWith('platform-tools/') && // Inside the platform-tools folder
              requiredFilesBaseNames.includes(baseFileName) // Is one of the files we need

            if (!isRequiredFile) {
              // Skip this entry, read the next one
              zipfile.readEntry()
              return
            }

            // This is a file we need to extract
            const targetPath = join(this.binDir, baseFileName) // Extract directly to binDir
            console.log(
              `Found required file ${baseFileName} in zip. Extracting to ${targetPath}...`
            )

            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr || !readStream) {
                zipfile.close()
                return reject(
                  streamErr || new Error(`Failed to open read stream for ${baseFileName}`)
                )
              }

              const writeStream = createWriteStream(targetPath)
              readStream.pipe(writeStream)

              readStream.on('error', (readErr) => {
                console.error(`Error reading zip stream for ${baseFileName}:`, readErr)
                writeStream.close() // Ensure write stream is closed on read error
                zipfile.close()
                reject(readErr)
              })

              writeStream.on('finish', () => {
                console.log(`Successfully extracted ${baseFileName} to ${targetPath}`)
                extractedFiles.add(baseFileName) // Mark this file as extracted
                // Continue reading entries
                zipfile.readEntry()
              })
              writeStream.on('error', (writeErr) => {
                console.error(`Error writing extracted file ${baseFileName}:`, writeErr)
                readStream.destroy() // Stop reading if write fails
                zipfile.close()
                reject(writeErr)
              })
            })
          })

          zipfile.on('end', () => {
            console.log('Finished processing zip file entries.')
            // Check if all required files were extracted
            if (extractedFiles.size === requiredFilesBaseNames.length) {
              resolve()
            } else {
              const missingFiles = requiredFilesBaseNames.filter((f) => !extractedFiles.has(f))
              reject(
                new Error(
                  `Extraction incomplete. Missing files: ${missingFiles.join(', ')} from the archive.`
                )
              )
            }
          })

          zipfile.on('error', (zipErr) => {
            reject(zipErr)
          })
        })
      })

      // Clean up temp archive
      console.log(`Cleaning up temporary archive: ${tempArchivePath}`)
      await fsPromises.unlink(tempArchivePath)
      tempArchivePath = null

      this.status.adb.ready = true
      this.status.adb.error = null
      progressCallback?.(this.status, { name: 'adb-extract', percentage: 100 })

      // Set executable permissions ONLY for the main adb binary
      if (process.platform !== 'win32') {
        try {
          // expectedPath still points to the main adb binary path
          await fsPromises.chmod(expectedPath, 0o755)
          console.log(`Set executable permissions for ${expectedPath}`)
        } catch (chmodError) {
          console.warn(`Failed to set executable permissions for ${expectedPath}:`, chmodError)
          this.status.adb.ready = false // Mark as not ready if permissions fail
          this.status.adb.error = `Permission error: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`
        }
      }
    } catch (error) {
      console.error(
        'Error during adb download/extraction:',
        error instanceof Error ? error.message : String(error)
      )
      console.error(error)
      this.status.adb.ready = false
      this.status.adb.downloading = false
      this.status.adb.error =
        error instanceof Error ? error.message : 'Unknown download/extraction error'
      // Clean up temp archive on error if it exists
      try {
        if (tempArchivePath && existsSync(tempArchivePath)) {
          await fsPromises.unlink(tempArchivePath)
          console.log(`Cleaned up adb temp archive on error: ${tempArchivePath}`)
        }
      } catch (cleanupError) {
        console.error('Failed to cleanup adb temp files on error:', cleanupError)
      }
    } finally {
      this.status.adb.downloading = false
    }
  }

  // --- Public Methods ---

  getStatus(): DependencyStatus {
    return this.status
  }
}

export default new DependencyService()
